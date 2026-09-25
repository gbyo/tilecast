//! `tilecastd` lifecycle.
//!
//! Startup order (each step's failure behavior is fixed):
//!
//! 1. **Configuration** is loaded and validated before anything else. An
//!    invalid file is fatal (exit code 2): systemd shows the error and a
//!    typo cannot silently change behavior.
//! 2. **Directories** under the state and runtime roots are created with
//!    owner-only modes. Failure is fatal.
//! 3. **State** is opened and migrated. The start is recorded; if the
//!    previous run ended uncleanly the database gets an integrity check and
//!    every CAS object is marked for re-verification before use. Any state
//!    failure enters **recovery mode** instead of exiting: IPC, status and
//!    the watchdog still work, nothing is recreated, and the renderer shows a
//!    recovery surface. A restart loop cannot fix a corrupt database, and a
//!    silently recreated one would lose the player's server binding.
//! 4. **IPC** binds `edge.sock`. Failure is fatal (another daemon is running
//!    or the runtime directory is wrong).
//! 5. **READY=1** is sent. Readiness never waits for the Tilecast Server.
//! 6. **Tasks** start: watchdog, capabilities, supervision, CAS maintenance
//!    and the server link. None of them needs the server to be reachable.
//!
//! Shutdown (SIGTERM/SIGINT): `STOPPING=1`, cancel every task, say goodbye to
//! IPC sessions, wait at most [`SHUTDOWN_TIMEOUT`], record a clean shutdown
//! and checkpoint the WAL. The renderer is a separate service and keeps its
//! last frame until the daemon returns.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context as _;
use edge_cas::{ContentStore, LruByDomain, StorePolicy};
use edge_ipc::{IpcServer, PeerPolicy};
use edge_platform::capabilities::CapabilityRegistry;
use edge_platform::disk::{SpaceProbe, StatvfsProbe};
use edge_platform::paths::EdgePaths;
use edge_platform::providers::{HostTimeSyncProvider, SystemdProvider, WpePlatformProvider};
use edge_platform::systemd::Notifier;
use edge_protocol::bounded::SafeText;
use edge_protocol::ipc::event::KioskPolicy;
use edge_protocol::ipc::presentation::{PresentationDocument, StatusSurface};
use edge_protocol::time::{SharedClock, system_clock};
use edge_protocol::{PlayerId, Timestamp};
use edge_state::repo::{binding, cas, daemon as daemon_repo};
use edge_state::{OpenOptions, StateDb, StateError};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use crate::config::EdgeConfig;
use crate::ipc_handler::DaemonIpc;
use crate::media::MediaRegistry;
use crate::media_channel::{self, MediaChannel, ProcLineage};
use crate::presentation::{ActivationSource, PresentationEngine};
use crate::server_link::{self, LinkState};
use crate::supervisor::SupervisorConfig;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const SUPERVISION_INTERVAL: Duration = Duration::from_secs(15);
const CAPABILITY_INTERVAL: Duration = Duration::from_secs(300);
const CAS_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60);

/// Whether state is usable.
#[derive(Debug, Clone)]
pub enum StateMode {
    Normal(StateDb),
    Recovery { reason: &'static str },
}

/// Shared daemon state. Subsystems hold an `Arc<DaemonContext>`.
#[derive(Debug)]
pub struct DaemonContext {
    pub config: EdgeConfig,
    pub paths: EdgePaths,
    pub clock: SharedClock,
    /// Free space on the state filesystem, as the content store sees it.
    pub space: Arc<dyn SpaceProbe>,
    pub state: StateMode,
    pub started_at: Timestamp,
    pub notifier: Notifier,
    pub presentation: Mutex<PresentationEngine>,
    pub capabilities: Mutex<CapabilityRegistry>,
    pub capability_revision: std::sync::atomic::AtomicU64,
    pub player_id: Option<PlayerId>,
    /// The content store; `None` in recovery mode.
    pub cas: Option<ContentStore>,
    /// Renderer media capabilities (docs/tilecast-edge.md §10.3).
    pub media_registry: Arc<std::sync::Mutex<MediaRegistry>>,
    /// Wakes the server link early (server push, IPC requests).
    pub server_wake: tokio::sync::Notify,
    /// Wakes activation when a manifest is prepared or an item boundary passes.
    pub manifest_wake: tokio::sync::Notify,
    pub manifest_item_boundary: std::sync::atomic::AtomicBool,
    /// What manifest preparation is doing, for status and heartbeat.
    pub preparation: crate::manifest_sync::SharedPreparationStatus,
    pub link_state: std::sync::Mutex<LinkState>,
    /// Last successful authenticated contact with the server.
    pub last_server_contact: std::sync::Mutex<Option<Timestamp>>,
    /// The accepted player configuration in force (`config_sync`).
    pub player_config: std::sync::RwLock<Option<Arc<crate::player_config::PlayerConfig>>>,
    /// Wakes the command task (`commands.available`).
    pub command_wake: tokio::sync::Notify,
    /// The identity-verified server the command task polls, published by the
    /// server link while the relationship lasts.
    pub command_server: tokio::sync::watch::Sender<Option<edge_server::AuthenticatedServer>>,
    /// `sync_now` requests: the requested generation, and the last
    /// generation a server-link pass completed with whether it succeeded.
    pub sync_request: std::sync::atomic::AtomicU64,
    pub sync_done: tokio::sync::watch::Sender<(u64, bool)>,
    /// Pairing of a fresh installation (`pairing`).
    pub pairing: std::sync::Mutex<crate::pairing::PairingView>,
    pub pairing_wake: tokio::sync::Notify,
    pub pairing_suppressed: std::sync::atomic::AtomicBool,
    pub pairing_renewal: std::sync::Mutex<Option<String>>,
    /// Set by `restart_player_process` before it cancels the daemon.
    pub restart_requested: std::sync::atomic::AtomicBool,
    pub shutdown: CancellationToken,
    /// Activity signals for the activity task (M8).
    pub activity: crate::activity::Handle,
    /// Asks the activity task to flush the outbox now.
    pub report_wake: tokio::sync::Notify,
    /// Live-preview requests waiting for the renderer.
    pub preview_waiters: crate::preview::Waiters,
}

impl DaemonContext {
    pub fn db(&self) -> Option<&StateDb> {
        match &self.state {
            StateMode::Normal(db) => Some(db),
            StateMode::Recovery { .. } => None,
        }
    }

    pub fn now(&self) -> Timestamp {
        self.clock.now()
    }
}

/// Opens state for this run, choosing recovery mode on any failure.
fn open_state(paths: &EdgePaths, now: Timestamp) -> (StateMode, Option<PlayerId>) {
    let db = match StateDb::open(paths.state_db(), OpenOptions::default()) {
        Ok(db) => db,
        Err(error) => return (recovery(&error), None),
    };
    let start = match db.run_blocking(|c| daemon_repo::record_start(c, now, VERSION)) {
        Ok(start) => start,
        Err(error) => return (recovery(&error), None),
    };
    if start.previous_run_unclean {
        tracing::warn!(component = "daemon", event = "unclean_previous_shutdown", boot = start.boot_count);
        let checked = edge_state::open_connection(&paths.state_db(), OpenOptions { integrity_check: true });
        if let Err(error) = checked {
            return (recovery(&error), None);
        }
        if let Err(error) = db.run_blocking(|c| cas::mark_all_suspect(c)) {
            return (recovery(&error), None);
        }
    }
    let player_id = db.run_blocking(|c| daemon_repo::player_identity(c)).ok().flatten().map(|p| p.player_id);
    (StateMode::Normal(db), player_id)
}

fn recovery(error: &StateError) -> StateMode {
    tracing::error!(component = "daemon", event = "state_unavailable", reason = error.reason_code(), error = %error);
    StateMode::Recovery { reason: error.reason_code() }
}

/// The surface to show while a bound screen waits for its first committed
/// presentation.
pub fn status_surface_for(context: &DaemonContext, bound: bool) -> PresentationDocument {
    status_surface(context, bound)
}

/// The surface to show when nothing better is available.
pub fn status_surface(context: &DaemonContext, bound: bool) -> PresentationDocument {
    let surface = |title: &str, message: &str, status: Option<&str>| StatusSurface {
        title: SafeText::lossy(title),
        message: SafeText::lossy(message),
        background_color: None,
        text_color: None,
        logo_src: None,
        footer_text: None,
        status: status.map(SafeText::lossy),
    };
    match &context.state {
        StateMode::Recovery { reason } => PresentationDocument::Unavailable(surface(
            "Tilecast needs attention",
            "This screen's local state could not be opened. Run tilecastctl status on the device.",
            Some(reason),
        )),
        StateMode::Normal(_) if !bound => PresentationDocument::Setup {},
        StateMode::Normal(_) => PresentationDocument::Idle(surface("Tilecast", "No content assigned.", None)),
    }
}

pub struct Daemon {
    context: Arc<DaemonContext>,
    ipc: IpcServer,
    media: Option<MediaChannel>,
    activity_signals: tokio::sync::mpsc::Receiver<crate::activity::Signal>,
}

impl std::fmt::Debug for Daemon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Daemon").finish_non_exhaustive()
    }
}

/// The host facts a daemon reads through a seam, so qualification tests can
/// step the wall clock or bring the disk to its reserve floor.
#[derive(Debug, Clone)]
pub struct Environment {
    pub clock: SharedClock,
    pub space: Arc<dyn SpaceProbe>,
}

impl Default for Environment {
    fn default() -> Self {
        Self { clock: system_clock(), space: Arc::new(StatvfsProbe) }
    }
}

impl Daemon {
    /// Performs startup steps 2–4. Configuration is already validated.
    pub async fn start(config: EdgeConfig, notifier: Notifier) -> anyhow::Result<Self> {
        Self::start_with(config, notifier, Environment::default()).await
    }

    pub async fn start_with(config: EdgeConfig, notifier: Notifier, environment: Environment) -> anyhow::Result<Self> {
        let Environment { clock, space } = environment;
        let paths = EdgePaths::from_environment(config.paths.state_dir.as_deref(), config.paths.runtime_dir.as_deref());
        paths.ensure_private_dirs().with_context(|| format!("creating {}", paths.state_dir.display()))?;
        let now = clock.now();
        let (state, player_id) = open_state(&paths, now);

        let kiosk = KioskPolicy { prevent_display_sleep: config.renderer.prevent_display_sleep, hide_cursor: true };
        let supervisor = SupervisorConfig {
            stall_threshold_ms: config.renderer.stall_threshold_seconds as i64 * 1_000,
            ..SupervisorConfig::default()
        };
        let media_registry = Arc::new(std::sync::Mutex::new(MediaRegistry::new()));
        let (activity, activity_signals) = crate::activity::Handle::channel();
        let mut presentation = PresentationEngine::new(
            &media_channel::socket_path(&paths.runtime_dir),
            media_registry.clone(),
            kiosk,
            supervisor,
            now.unix_millis(),
        );
        presentation.set_activity(activity.clone());

        let mut registry = CapabilityRegistry::new();
        registry.register(Arc::new(SystemdProvider {
            notify_enabled: notifier.is_enabled(),
            watchdog_enabled: notifier.watchdog_timeout().is_some(),
        }));
        registry.register(Arc::new(HostTimeSyncProvider::default()));
        registry.register(Arc::new(WpePlatformProvider {
            renderer_binary: config.renderer.binary.clone(),
            dri_dir: config.renderer.dri_dir.clone(),
            wayland_runtime_dir: config.renderer.wayland_runtime_dir.clone(),
            wayland_display: config.renderer.wayland_display.clone(),
        }));

        let cas = match &state {
            StateMode::Normal(db) => {
                let policy = StorePolicy {
                    limit_bytes: config.cas.limit_bytes,
                    reserved_free_bytes: config.cas.reserved_free_bytes,
                };
                match ContentStore::open(
                    paths.cas_root(),
                    paths.partial_dir(),
                    db.clone(),
                    clock.clone(),
                    space.clone(),
                    policy,
                    Arc::new(LruByDomain),
                )
                .await
                {
                    Ok(store) => Some(store),
                    Err(error) => {
                        tracing::error!(component = "cas", event = "open_failed", error = %error);
                        None
                    }
                }
            }
            StateMode::Recovery { .. } => None,
        };

        let uid = rustix::process::geteuid().as_raw();
        let mut policy = PeerPolicy::for_daemon_uid(uid);
        policy.renderer_uids = config.ipc.renderer_uids.clone();
        policy.observer_uids = config.ipc.observer_uids.clone();

        let context = Arc::new(DaemonContext {
            config,
            paths,
            clock,
            space,
            state,
            started_at: now,
            notifier,
            presentation: Mutex::new(presentation),
            capabilities: Mutex::new(registry),
            capability_revision: std::sync::atomic::AtomicU64::new(0),
            player_id,
            cas,
            media_registry,
            server_wake: tokio::sync::Notify::new(),
            manifest_wake: tokio::sync::Notify::new(),
            manifest_item_boundary: std::sync::atomic::AtomicBool::new(false),
            preparation: Default::default(),
            link_state: std::sync::Mutex::new(LinkState::Unbound),
            last_server_contact: std::sync::Mutex::new(None),
            player_config: std::sync::RwLock::new(None),
            command_wake: tokio::sync::Notify::new(),
            command_server: tokio::sync::watch::Sender::new(None),
            sync_request: std::sync::atomic::AtomicU64::new(0),
            sync_done: tokio::sync::watch::Sender::new((0, false)),
            pairing: std::sync::Mutex::new(Default::default()),
            pairing_wake: tokio::sync::Notify::new(),
            pairing_suppressed: std::sync::atomic::AtomicBool::new(false),
            pairing_renewal: std::sync::Mutex::new(None),
            restart_requested: std::sync::atomic::AtomicBool::new(false),
            shutdown: CancellationToken::new(),
            activity,
            report_wake: tokio::sync::Notify::new(),
            preview_waiters: crate::preview::Waiters::default(),
        });

        let bound_record = match context.db() {
            Some(db) => db.run_blocking(|c| binding::get(c)).ok().flatten(),
            None => None,
        };
        let bound = bound_record.is_some();
        // The accepted configuration applies before any network access.
        if let Some(record) = bound_record
            && let Some(screen_id) = record.screen_id
        {
            let binding = edge_state::repo::manifests::Binding {
                installation_id: record.installation_id,
                screen_id,
                server_url: record.server_url,
            };
            crate::config_sync::load_cached(&context, &binding).await;
        } else {
            crate::config_sync::install(&context, None).await;
        }
        let initial = status_surface(&context, bound);
        context
            .presentation
            .lock()
            .await
            .activate(initial, Vec::new(), None, ActivationSource::StatusSurface, now.unix_millis())
            .context("initial status surface")?;

        let handler = Arc::new(DaemonIpc::new(Arc::clone(&context)));
        let socket = context.paths.socket();
        let ipc = IpcServer::bind(&socket, policy, handler, VERSION)
            .await
            .with_context(|| format!("binding {}", socket.display()))?;
        let media = context
            .cas
            .clone()
            .map(|cas| {
                let path = media_channel::socket_path(&context.paths.runtime_dir);
                MediaChannel::bind(
                    &path,
                    context.media_registry.clone(),
                    cas,
                    context.clock.clone(),
                    Arc::new(ProcLineage),
                )
                .with_context(|| format!("binding {}", path.display()))
            })
            .transpose()?;
        Ok(Self { context, ipc, media, activity_signals })
    }

    pub fn context(&self) -> &Arc<DaemonContext> {
        &self.context
    }

    pub fn socket_path(&self) -> PathBuf {
        self.ipc.path().to_path_buf()
    }

    /// Steps 5–6 and the shutdown sequence. Returns when `shutdown` fires
    /// (signal, or a test cancelling the context token).
    pub async fn run(self) -> anyhow::Result<()> {
        let context = self.context;
        let shutdown = context.shutdown.clone();
        let mut tasks = tokio::task::JoinSet::new();
        tasks.spawn(self.ipc.run(shutdown.clone()));
        if let Some(media) = self.media {
            let media_shutdown = shutdown.clone();
            tasks.spawn(async move {
                if let Err(error) = media.run(media_shutdown.clone()).await {
                    tracing::error!(component = "media", event = "channel_failed", error = %error);
                    media_shutdown.cancel();
                }
            });
        }
        tasks.spawn(watchdog_loop(Arc::clone(&context)));
        tasks.spawn(supervision_loop(Arc::clone(&context)));
        tasks.spawn(capability_loop(Arc::clone(&context)));
        tasks.spawn(crate::fixture::run(Arc::clone(&context)));
        tasks.spawn(crate::activation::run(Arc::clone(&context)));
        tasks.spawn(cas_maintenance_loop(Arc::clone(&context)));
        tasks.spawn(server_link::run(Arc::clone(&context)));
        tasks.spawn(crate::commands::run(Arc::clone(&context)));
        tasks.spawn(crate::pairing::run(Arc::clone(&context)));
        tasks.spawn(crate::activity::run(Arc::clone(&context), self.activity_signals));
        tasks.spawn(crate::telemetry::run(Arc::clone(&context)));
        tasks.spawn(crate::preview::run(Arc::clone(&context)));

        let status = ready_status(&context);
        context.notifier.ready(&status);
        tracing::info!(component = "daemon", event = "ready", version = VERSION, status = %status);

        shutdown.cancelled().await;
        context.notifier.stopping();
        tracing::info!(component = "daemon", event = "stopping");
        let drained =
            tokio::time::timeout(SHUTDOWN_TIMEOUT, async { while tasks.join_next().await.is_some() {} }).await;
        if drained.is_err() {
            tracing::warn!(component = "daemon", event = "shutdown_timeout");
            tasks.abort_all();
        }
        if let Some(cas) = &context.cas
            && let Err(error) = cas.flush_touches().await
        {
            tracing::warn!(component = "cas", event = "touch_flush_failed", error = %error);
        }
        if let Some(db) = context.db() {
            db.run_blocking(|c| daemon_repo::record_clean_shutdown(c, context.now()))
                .context("recording clean shutdown")?;
            db.checkpoint().context("checkpointing state")?;
        }
        tracing::info!(component = "daemon", event = "stopped");
        Ok(())
    }
}

fn ready_status(context: &DaemonContext) -> String {
    match &context.state {
        StateMode::Normal(_) => "State open · waiting for renderer".to_owned(),
        StateMode::Recovery { reason } => format!("Recovery mode: {reason}"),
    }
}

/// Sends `WATCHDOG=1` at half the configured interval while the daemon can
/// still answer a trivial state query in time. A wedged state thread or a
/// deadlocked runtime therefore stops the pings and systemd restarts us.
async fn watchdog_loop(context: Arc<DaemonContext>) {
    let Some(interval) = context.notifier.watchdog_interval() else {
        return;
    };
    let mut ticker = tokio::time::interval(interval);
    loop {
        tokio::select! {
            _ = context.shutdown.cancelled() => return,
            _ = ticker.tick() => {}
        }
        let healthy = match context.db() {
            Some(db) => tokio::time::timeout(interval, db.run(|c| Ok(c.execute_batch("SELECT 1")?)))
                .await
                .is_ok_and(|result| result.is_ok()),
            // Recovery mode is a healthy daemon reporting a problem.
            None => true,
        };
        if healthy {
            context.notifier.watchdog();
        } else {
            tracing::error!(component = "daemon", event = "watchdog_withheld");
        }
    }
}

async fn supervision_loop(context: Arc<DaemonContext>) {
    let mut ticker = tokio::time::interval(SUPERVISION_INTERVAL);
    loop {
        tokio::select! {
            _ = context.shutdown.cancelled() => return,
            _ = ticker.tick() => {}
        }
        let now = context.now().unix_millis();
        context.presentation.lock().await.tick(now);
    }
}

async fn capability_loop(context: Arc<DaemonContext>) {
    let mut ticker = tokio::time::interval(CAPABILITY_INTERVAL);
    loop {
        tokio::select! {
            _ = context.shutdown.cancelled() => return,
            _ = ticker.tick() => {}
        }
        crate::capabilities::refresh(&context).await;
    }
}

/// Flushes batched CAS access times and expires timed pins (docs/tilecast-edge.md §6.2: one
/// write per minute, never one per read).
async fn cas_maintenance_loop(context: Arc<DaemonContext>) {
    let Some(cas) = context.cas.clone() else {
        return;
    };
    let mut ticker = tokio::time::interval(CAS_MAINTENANCE_INTERVAL);
    loop {
        tokio::select! {
            _ = context.shutdown.cancelled() => return,
            _ = ticker.tick() => {}
        }
        if let Err(error) = cas.flush_touches().await {
            tracing::warn!(component = "cas", event = "touch_flush_failed", error = %error);
        }
        if let Some(db) = context.db() {
            let now = context.now();
            let _ = db.run(move |c| cas::expire_pins(c, now)).await;
        }
        if let Ok(mut registry) = context.media_registry.lock() {
            registry.expire(context.now().unix_millis());
        }
    }
}

/// Waits for SIGTERM or SIGINT and cancels the daemon.
pub async fn cancel_on_signal(shutdown: CancellationToken) {
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = terminate => {}
        _ = tokio::signal::ctrl_c() => {}
        _ = shutdown.cancelled() => return,
    }
    shutdown.cancel();
}
