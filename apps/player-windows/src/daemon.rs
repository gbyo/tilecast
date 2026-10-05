//! The Windows player process: shared state, startup/shutdown, and the
//! supervised task set. Core owns the behavior; this module owns the
//! composition: open state (or enter recovery mode), build the coordinators
//! over the host's private stores, and run pairing, server link, commands,
//! activation, Activity, and telemetry until shutdown.
//!
//! There is no IPC yet: the operator pairs with
//! `tilecast-windows run --pair <url>` (or on the setup surface in the
//! window) and inspects with `tilecast-windows status`. `--headless` runs
//! without the window; pairing stays on stdout.

use anyhow::Context as _;
use player_cas::{ContentStore, LruByDomain, StorePolicy};
use player_client::AuthenticatedServer;
use player_core::{
    ActivityHandle, LiveFrame, PairingCoordinator, PlayerCore, ServerLinkState, ServerRelationship,
    SharedManifestPreparationStatus,
};
use player_state::repo::{binding, cas, daemon as daemon_repo};
use player_state::{OpenOptions, StateDb, StateError};
use player_types::time::SharedClock;
use player_types::{PlayerId, Timestamp};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
use tokio_util::sync::CancellationToken;

use crate::config::WindowsConfig;
use crate::paths::WindowsPaths;

/// This build's Tilecast release version (`release/VERSION`).
pub const VERSION: &str = crate::RELEASE_VERSION;

/// What pairing is doing, for status and tests.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PairingView {
    pub state: &'static str,
    pub code: Option<String>,
    pub reason: Option<String>,
    /// The Studio approval URL and organization for the waiting surface;
    /// empty unless a session is waiting for approval.
    pub approval_url: String,
    pub organization_name: Option<String>,
}

/// Durable state, or the reason it could not be opened. Recovery mode keeps
/// private-file cleanup working and everything else parked.
#[derive(Debug)]
pub enum StateMode {
    Normal(StateDb),
    Recovery { reason: &'static str },
}

pub struct DaemonContext {
    /// Shared native behavior, absent when durable state is in recovery.
    pub core: Option<PlayerCore>,
    pub config: WindowsConfig,
    pub paths: WindowsPaths,
    pub clock: SharedClock,
    /// Free space on the state volume, as the content store sees it.
    pub space: Arc<dyn player_cas::space::SpaceProbe>,
    pub state: StateMode,
    pub started_at: Timestamp,
    pub player_id: Option<PlayerId>,
    /// The content store; `None` in recovery mode.
    pub cas: Option<ContentStore>,
    pub server_relationship: Option<ServerRelationship>,
    pub pairing_coordinator: Option<PairingCoordinator>,
    pub activity: ActivityHandle,
    pub pairing: std::sync::Mutex<PairingView>,
    /// Wakes the server link early (pairing, commands, shutdown paths).
    pub server_wake: tokio::sync::Notify,
    /// Wakes activation when a manifest is prepared or an item boundary passes.
    pub manifest_wake: tokio::sync::Notify,
    pub manifest_item_boundary: AtomicBool,
    /// Wakes the pairing loop early (begin/reset).
    pub pairing_wake: tokio::sync::Notify,
    /// Wakes the command task (`commands.available`).
    pub command_wake: tokio::sync::Notify,
    /// Wakes the Activity reporter early.
    pub report_wake: tokio::sync::Notify,
    /// Wakes Watch Live when its lease changes.
    pub live_stream_wake: tokio::sync::Notify,
    pub live_frames: tokio::sync::watch::Sender<Option<LiveFrame>>,
    /// What manifest preparation is doing, for status and heartbeat.
    pub preparation: SharedManifestPreparationStatus,
    pub link_state: std::sync::Mutex<ServerLinkState>,
    /// Last successful authenticated contact with the server.
    pub last_server_contact: std::sync::Mutex<Option<Timestamp>>,
    /// The identity-verified server the command task polls, published by the
    /// server link while the relationship lasts.
    pub command_server: tokio::sync::watch::Sender<Option<AuthenticatedServer>>,
    /// `sync_now` requests: the requested generation, and the last
    /// generation a server-link pass completed with whether it succeeded.
    pub sync_request: AtomicU64,
    pub sync_done: tokio::sync::watch::Sender<(u64, bool)>,
    /// A status report is due outside the normal cadence.
    pub status_due: AtomicBool,
    /// The accepted player configuration in force (`config_sync`).
    pub player_config: std::sync::RwLock<Option<Arc<crate::player_config::WindowsPlayerConfig>>>,
    /// What the renderer shows: the offline driver, the presentation task,
    /// and command handlers share it. Every method is synchronous, so the
    /// lock is never held across an await.
    pub presentation: std::sync::Mutex<crate::presentation::PresentationEngine>,
    /// Runs without a window: the presentation task parks and pairing stays
    /// on stdout (`tilecast-windows run --headless`).
    pub headless: AtomicBool,
    /// The UI thread's remote web environment serves surfaces. Set when
    /// the UI thread starts; remote process events maintain it.
    pub remote_web_available: AtomicBool,
    /// The UI thread's main window address for final-output capture; 0
    /// while headless or before the window opens.
    pub main_window: Arc<AtomicUsize>,
    /// One capture in flight across Studio preview and Watch Live.
    pub capture: crate::capture::CaptureBroker,
    /// Preview health, shared with the capability report.
    pub preview_health: std::sync::Mutex<player_core::PreviewHealth>,
    /// A `restart_player_process` command asked for a fresh copy of the
    /// process after this one shuts down cleanly.
    pub restart_requested: AtomicBool,
    /// Wakes the update coordinator (an accepted `install_player_update`).
    pub update_wake: tokio::sync::Notify,
    pub shutdown: CancellationToken,
}

impl std::fmt::Debug for DaemonContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonContext")
            .field("config", &self.config)
            .field("paths", &self.paths)
            .field("started_at", &self.started_at)
            .field("player_id", &self.player_id)
            .finish_non_exhaustive()
    }
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

    pub fn report_status_soon(&self) {
        self.status_due.store(true, std::sync::atomic::Ordering::Release);
        self.server_wake.notify_one();
    }
}

/// Opens state for this run, choosing recovery mode on any failure.
fn open_state(paths: &WindowsPaths, now: Timestamp) -> (StateMode, Option<PlayerId>) {
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
        let checked = player_state::open_connection(&paths.state_db(), OpenOptions { integrity_check: true });
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

/// Builds the daemon context: state, Core, coordinators, and signals. The
/// Activity signal channel is returned for the Activity task.
pub async fn build(
    config: WindowsConfig,
    paths: WindowsPaths,
) -> anyhow::Result<(Arc<DaemonContext>, tokio::sync::mpsc::Receiver<crate::activity::Signal>)> {
    build_with_sealer(config, paths, crate::seal::production_sealer()).await
}

/// Builds the daemon context over an injected sealer, so integration tests
/// can persist private state where DPAPI does not exist.
pub async fn build_with_sealer(
    config: WindowsConfig,
    paths: WindowsPaths,
    sealer: Arc<dyn crate::seal::Sealer>,
) -> anyhow::Result<(Arc<DaemonContext>, tokio::sync::mpsc::Receiver<crate::activity::Signal>)> {
    paths.ensure_dirs().context("creating state directories")?;
    let clock = crate::clock::system_clock();
    let now = clock.now();
    let (state, player_id) = open_state(&paths, now);
    let credentials: Arc<dyn player_client::CredentialStore> =
        Arc::new(crate::credential::SealedCredentialStore::new(paths.identity_dir(), sealer.clone()));
    let sessions: Arc<dyn player_client::PairingStore> =
        Arc::new(crate::pairing_store::SealedPairingStore::new(paths.identity_dir(), sealer));

    let (core, cas, server_relationship, pairing_coordinator) = match &state {
        StateMode::Normal(db) => {
            let dependencies = player_core::Dependencies { state: db.clone(), clock: clock.clone() };
            let core = PlayerCore::new(dependencies);
            let policy = StorePolicy {
                limit_bytes: config.cas.limit_bytes,
                reserved_free_bytes: config.cas.reserved_free_bytes,
            };
            let space: Arc<dyn player_cas::space::SpaceProbe> = Arc::new(crate::space::DiskSpaceProbe);
            let opener: Arc<dyn player_cas::SecureOpener> = Arc::new(crate::secure_open::WindowsSecureOpener);
            let store = ContentStore::open(
                paths.cas_root(),
                paths.partial_dir(),
                db.clone(),
                clock.clone(),
                space,
                opener,
                policy,
                Arc::new(LruByDomain),
            )
            .await
            .context("opening the content store")?;
            let relationship = core.server_relationship(credentials.clone());
            let pairing = core.pairing(credentials, sessions);
            (Some(core), Some(store), Some(relationship), Some(pairing))
        }
        StateMode::Recovery { .. } => (None, None, None, None),
    };

    let (activity, activity_signals) = ActivityHandle::channel();
    let (command_server, _) = tokio::sync::watch::channel(None);
    let (sync_done, _) = tokio::sync::watch::channel((0, false));
    let (live_frames, _) = tokio::sync::watch::channel(None);
    let mut presentation = crate::presentation::PresentationEngine::new(
        std::sync::Arc::new(std::sync::Mutex::new(crate::media::MediaRegistry::new())),
        player_core::SupervisorConfig::default(),
        now.unix_millis(),
    );
    presentation.set_activity(activity.clone());
    let context = DaemonContext {
        core,
        config,
        paths,
        clock,
        space: Arc::new(crate::space::DiskSpaceProbe),
        state,
        started_at: now,
        player_id,
        cas,
        server_relationship,
        pairing_coordinator,
        activity,
        pairing: std::sync::Mutex::new(PairingView::default()),
        server_wake: tokio::sync::Notify::new(),
        manifest_wake: tokio::sync::Notify::new(),
        manifest_item_boundary: AtomicBool::new(false),
        pairing_wake: tokio::sync::Notify::new(),
        command_wake: tokio::sync::Notify::new(),
        report_wake: tokio::sync::Notify::new(),
        live_stream_wake: tokio::sync::Notify::new(),
        live_frames,
        preparation: SharedManifestPreparationStatus::default(),
        link_state: std::sync::Mutex::new(ServerLinkState::Unbound),
        last_server_contact: std::sync::Mutex::new(None),
        command_server,
        sync_request: AtomicU64::new(0),
        sync_done,
        status_due: AtomicBool::new(false),
        player_config: std::sync::RwLock::new(None),
        presentation: std::sync::Mutex::new(presentation),
        headless: AtomicBool::new(false),
        remote_web_available: AtomicBool::new(false),
        main_window: Arc::new(AtomicUsize::new(0)),
        capture: crate::capture::CaptureBroker::new(),
        preview_health: std::sync::Mutex::new(player_core::PreviewHealth::default()),
        restart_requested: AtomicBool::new(false),
        update_wake: tokio::sync::Notify::new(),
        shutdown: CancellationToken::new(),
    };
    Ok((Arc::new(context), activity_signals))
}

/// Loads the accepted configuration for the bound screen before the server
/// is contacted.
pub async fn load_cached_config(context: &DaemonContext) {
    let bound = match context.db() {
        Some(db) => db.run(|c| binding::get(c)).await.ok().flatten(),
        None => None,
    };
    if let Some(bound) = bound
        && let Some(screen_id) = bound.screen_id
    {
        let binding = player_state::repo::manifests::Binding {
            installation_id: bound.installation_id,
            screen_id,
            server_url: bound.server_url,
        };
        crate::config_sync::load_cached(context, &binding).await;
    }
}

/// Runs the supervised task set until shutdown.
pub async fn run(context: Arc<DaemonContext>, activity_signals: tokio::sync::mpsc::Receiver<crate::activity::Signal>) {
    load_cached_config(&context).await;
    let shutdown = context.shutdown.clone();
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(crate::pairing::run(context.clone()));
    tasks.spawn(crate::link::run(context.clone()));
    tasks.spawn(crate::commands::run(context.clone()));
    tasks.spawn(crate::offline::run(context.clone()));
    tasks.spawn(crate::presentation::run(context.clone()));
    tasks.spawn(crate::preview::run(context.clone()));
    tasks.spawn(crate::live_stream::run(context.clone()));
    tasks.spawn(crate::update::run(context.clone()));
    tasks.spawn(crate::activity::run(context.clone(), activity_signals));
    tasks.spawn(crate::telemetry::run(context.clone()));
    shutdown.cancelled().await;
    // A task that ignores shutdown must not hang the process.
    let _ =
        tokio::time::timeout(std::time::Duration::from_secs(10), async { while tasks.join_next().await.is_some() {} })
            .await;
    if let Some(db) = context.db() {
        let now = context.now();
        if let Err(error) = db.run(move |c| daemon_repo::record_clean_shutdown(c, now)).await {
            tracing::warn!(component = "daemon", event = "clean_shutdown_unrecorded", error = %error);
        }
    }
}

/// Read-only local inspection for `tilecast-windows status`. Reads the
/// state database and the sealed private files directly; nothing here needs
/// a running process.
pub async fn status(paths: &WindowsPaths) -> anyhow::Result<Status> {
    let db = StateDb::open(paths.state_db(), OpenOptions::default()).context("opening state")?;
    let bound = db.run(|c| binding::get(c)).await.context("reading the binding")?;
    let playback = db.run(|c| player_state::repo::playback::get(c)).await.context("reading playback state")?;
    let sealer = crate::seal::production_sealer();
    let credentials: Arc<dyn player_client::CredentialStore> =
        Arc::new(crate::credential::SealedCredentialStore::new(paths.identity_dir(), sealer.clone()));
    let sessions: Arc<dyn player_client::PairingStore> =
        Arc::new(crate::pairing_store::SealedPairingStore::new(paths.identity_dir(), sealer));
    let has_credential = credentials.load().map(|c| c.is_some()).unwrap_or(false);
    let now_ms =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let now = player_types::Timestamp::from_unix_millis(now_ms)
        .unwrap_or_else(|| player_types::Timestamp::from_offset_datetime(time::OffsetDateTime::now_utc()));
    let pairing = sessions.load().ok().flatten().map(|session| PairingStatus {
        code: session.code.clone(),
        server_url: session.server_url.clone(),
        expired: session.is_expired(now),
    });
    Ok(Status {
        bound: bound.map(|bound| BindingStatus {
            server_url: bound.server_url,
            screen_name: bound.screen_name,
            screen_id: bound.screen_id.map(|id| id.to_string()),
        }),
        playback_disabled: playback.playback_disabled,
        has_credential,
        pairing,
    })
}

#[derive(Debug)]
pub struct BindingStatus {
    pub server_url: String,
    pub screen_name: Option<String>,
    pub screen_id: Option<String>,
}

#[derive(Debug)]
pub struct PairingStatus {
    pub code: String,
    pub server_url: String,
    pub expired: bool,
}

#[derive(Debug)]
pub struct Status {
    pub bound: Option<BindingStatus>,
    pub playback_disabled: bool,
    pub has_credential: bool,
    pub pairing: Option<PairingStatus>,
}
