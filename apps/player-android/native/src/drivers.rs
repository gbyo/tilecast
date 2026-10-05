//! Core-owned background drivers for the Android host.
//!
//! Each driver is a Core reconciliation loop from `player-core`; this module
//! only supervises their lifetime. Drivers start exactly once per host and
//! stop before the host drops, so there is never a second socket or
//! reconciliation loop. Pairing, the server link with commands, Activity
//! with telemetry, and renderer supervision with preview run behind the
//! same supervisor.

use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use player_cas::ContentStore;
use player_core::{PairingCoordinator, PlayerCore, ServerRelationship};
use player_state::StateDb;
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;

use crate::commands::{AndroidCommandHandlers, CommandStatus, PlatformCommands};
use crate::config_host::AndroidConfigHost;
use crate::live_stream::AndroidLiveStreamHost;
use crate::pairing_host::{AndroidPairingHost, MetadataSource};
use crate::renderer::{AndroidPreviewHost, PresentationEngine};
use crate::selection::{SelectionHost, run_selection};
use crate::server_link::{AndroidServerLinkHost, LinkSignals, activity_channel};
use crate::telemetry::{AndroidClocks, AndroidTelemetryHost, player_timezone};

/// Renderer supervision cadence, matching Edge's daemon loop. Recovery
/// thresholds are minute-scale; fifteen seconds notices promptly
/// without churning the engine lock.
const SUPERVISION_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug)]
pub struct Drivers {
    pairing: PairingDriver,
    link: ServerLinkDriver,
    reporting: ReportingDriver,
    renderer: RendererDriver,
}

#[derive(Debug)]
struct PairingDriver {
    coordinator: PairingCoordinator,
    host: AndroidPairingHost,
    user_agent: String,
    wake: Arc<Notify>,
    shutdown: CancellationToken,
    started: AtomicBool,
    handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// Everything the server link owns: the Core relationship, the host,
/// the borrowed signals, and the activity receiver the Activity
/// driver drains in PR2b-5.
#[derive(Debug)]
pub struct ServerLinkDeps {
    pub core: PlayerCore,
    pub state: StateDb,
    pub config: Arc<AndroidConfigHost>,
    pub cas: ContentStore,
    pub credentials: Arc<dyn player_client::CredentialStore>,
    pub meta: Arc<dyn MetadataSource>,
    pub platform: Arc<dyn PlatformCommands>,
    pub commands: CommandStatus,
    pub state_dir: PathBuf,
    pub renderer_engine: Arc<tokio::sync::Mutex<PresentationEngine>>,
    pub renderer_broker: Arc<player_core::CaptureBroker>,
    pub renderer_snapshot: Arc<Mutex<crate::renderer::RendererSnapshot>>,
    pub signals: Arc<LinkSignals>,
}

#[derive(Debug)]
struct ServerLinkDriver {
    core: PlayerCore,
    relationship: ServerRelationship,
    host: AndroidServerLinkHost,
    handlers: AndroidCommandHandlers,
    signals: Arc<LinkSignals>,
    user_agent: String,
    player_version: String,
    shutdown: CancellationToken,
    started: AtomicBool,
    handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// Renderer supervision and periodic preview. The supervision task
/// ticks the presentation engine's recovery ladder; the preview task
/// runs Core's preview policy against the authenticated server.
#[derive(Debug)]
struct RendererDriver {
    core: PlayerCore,
    cas: ContentStore,
    config: Arc<AndroidConfigHost>,
    engine: Arc<tokio::sync::Mutex<PresentationEngine>>,
    preview: Arc<AndroidPreviewHost>,
    live_stream: Arc<AndroidLiveStreamHost>,
    clock: player_types::time::SharedClock,
    signals: Arc<LinkSignals>,
    shutdown: CancellationToken,
    started: AtomicBool,
    handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// Activity upload and telemetry sampling. The Activity driver drains
/// the bounded signal channel the server link records into and
/// uploads both Activity events and telemetry samples.
#[derive(Debug)]
struct ReportingDriver {
    core: PlayerCore,
    clocks: AndroidClocks,
    timezone: String,
    activity: player_core::ActivityHandle,
    activity_rx: Mutex<Option<mpsc::Receiver<player_core::ActivitySignal>>>,
    telemetry: AndroidTelemetryHost,
    signals: Arc<LinkSignals>,
    report_wake: Arc<Notify>,
    shutdown: CancellationToken,
    started: AtomicBool,
    handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

/// The socket's player version from the user agent Kotlin passes at
/// open (`Tilecast-Player-Android/<version>`). A malformed agent
/// cannot break the link; it only mislabels it.
fn player_version(user_agent: &str) -> String {
    user_agent.rsplit('/').next().filter(|version| !version.is_empty()).unwrap_or("0.0.0").to_owned()
}

impl Drivers {
    pub fn new(
        coordinator: PairingCoordinator,
        meta: Arc<dyn MetadataSource>,
        user_agent: String,
        link: ServerLinkDeps,
    ) -> Self {
        let wake = Arc::new(Notify::new());
        let version = player_version(&user_agent);
        let link_user_agent = user_agent.clone();
        let signals = link.signals.clone();
        let host =
            AndroidPairingHost::new(meta, wake.clone(), signals.server_wake.clone(), signals.manifest_wake.clone());
        let (activity, activity_rx) = activity_channel();
        let clock: player_types::time::SharedClock = Arc::new(crate::host::SystemClock);
        let started_at = clock.now();
        let timezone = player_timezone(&link.meta);
        let telemetry = AndroidTelemetryHost::new(
            link.state.clone(),
            link.cas.clone(),
            signals.clone(),
            link.meta.clone(),
            link.renderer_snapshot.clone(),
            link.state_dir.clone(),
            started_at,
        );
        let link_host = AndroidServerLinkHost::new(
            link.core.clone(),
            link.state.clone(),
            link.config.clone(),
            link.cas.clone(),
            link.meta,
            activity.clone(),
            signals.preparation.clone(),
            link.commands.clone(),
            link.renderer_snapshot.clone(),
            link.renderer_engine.clone(),
            signals.last_server_contact.clone(),
            signals.gate.clone(),
            signals.observations.clone(),
            signals.manifest_facts.clone(),
            clock.clone(),
            link.state_dir,
        );
        let handlers = AndroidCommandHandlers::new(
            link.state,
            clock.clone(),
            link.cas.clone(),
            link.config.clone(),
            signals.clone(),
            link.platform,
            link.commands,
            link.renderer_engine.clone(),
            link.renderer_snapshot.clone(),
        );
        let relationship = link.core.server_relationship(link.credentials);
        Self {
            pairing: PairingDriver {
                coordinator,
                host,
                user_agent,
                wake,
                shutdown: CancellationToken::new(),
                started: AtomicBool::new(false),
                handles: Mutex::new(Vec::new()),
            },
            link: ServerLinkDriver {
                core: link.core.clone(),
                relationship,
                host: link_host,
                handlers,
                signals: signals.clone(),
                user_agent: link_user_agent,
                player_version: version.clone(),
                shutdown: CancellationToken::new(),
                started: AtomicBool::new(false),
                handles: Mutex::new(Vec::new()),
            },
            reporting: ReportingDriver {
                core: link.core.clone(),
                clocks: AndroidClocks::new(clock.clone()),
                timezone,
                activity,
                activity_rx: Mutex::new(Some(activity_rx)),
                telemetry,
                signals: signals.clone(),
                report_wake: Arc::new(Notify::new()),
                shutdown: CancellationToken::new(),
                started: AtomicBool::new(false),
                handles: Mutex::new(Vec::new()),
            },
            renderer: RendererDriver {
                core: link.core.clone(),
                cas: link.cas.clone(),
                config: link.config.clone(),
                preview: Arc::new(AndroidPreviewHost::new(
                    link.renderer_engine.clone(),
                    link.renderer_broker.clone(),
                    clock.clone(),
                    version,
                )),
                live_stream: Arc::new(AndroidLiveStreamHost::new(
                    link.renderer_engine.clone(),
                    link.renderer_broker,
                    clock.clone(),
                    signals.live_frames.clone(),
                )),
                engine: link.renderer_engine,
                clock,
                signals,
                shutdown: CancellationToken::new(),
                started: AtomicBool::new(false),
                handles: Mutex::new(Vec::new()),
            },
        }
    }

    /// Spawns the pairing, server-link, command, Activity,
    /// telemetry, renderer-supervision, and preview loops. Idempotent:
    /// a second call is a no-op, so Kotlin can call start
    /// unconditionally.
    pub fn start(&self, runtime: &tokio::runtime::Runtime) {
        if !self.pairing.started.swap(true, Ordering::AcqRel) {
            let coordinator = self.pairing.coordinator.clone();
            let host = self.pairing.host.clone();
            let user_agent = self.pairing.user_agent.clone();
            let wake = self.pairing.wake.clone();
            let shutdown = self.pairing.shutdown.clone();
            let handle = runtime.spawn(async move {
                coordinator.run(&user_agent, &host, &wake, &shutdown).await;
            });
            self.pairing.handles.lock().unwrap_or_else(|error| error.into_inner()).push(handle);
        }
        if !self.link.started.swap(true, Ordering::AcqRel) {
            let core = self.link.core.clone();
            let host = self.link.host.clone();
            let user_agent = self.link.user_agent.clone();
            let player_version = self.link.player_version.clone();
            let shutdown = self.link.shutdown.clone();
            let signals = self.link.signals.clone();
            let relationship = self.link.relationship.clone();
            let handle = runtime.spawn(async move {
                core.run_server_link(player_core::ServerLinkServices {
                    relationship: &relationship,
                    host: &host,
                    user_agent: &user_agent,
                    player_version: &player_version,
                    shutdown: &shutdown,
                    signals: player_core::ServerLinkSignals {
                        server_wake: &signals.server_wake,
                        manifest_wake: &signals.manifest_wake,
                        preparation: &signals.preparation,
                        link_state: &signals.link_state,
                        last_server_contact: &signals.last_server_contact,
                        command_wake: &signals.command_wake,
                        command_server: &signals.command_server,
                        sync_request: &signals.sync_request,
                        sync_done: &signals.sync_done,
                        live_stream_wake: &signals.live_stream_wake,
                        live_frames: &signals.live_frames,
                        status_due: &signals.status_due,
                    },
                })
                .await;
            });
            self.link.handles.lock().unwrap_or_else(|error| error.into_inner()).push(handle);
            let core = self.link.core.clone();
            let coordinator = core.commands(self.link.handlers.clone());
            let server = self.link.signals.command_server.subscribe();
            let signals = self.link.signals.clone();
            let shutdown = self.link.shutdown.clone();
            let commands = runtime.spawn(async move {
                // Crash recovery first: an interrupted command re-runs or
                // settles before any new delivery is fetched.
                if coordinator.recover().await.is_err() {
                    return;
                }
                let wake = signals.command_wake.clone();
                core.run_commands(&coordinator, server, &wake, &shutdown, |outcome| {
                    if outcome == player_core::PassOutcome::CredentialRejected {
                        // The server link owns the credential and deletes it
                        // only on its own explicit rejection; wake it to confirm.
                        signals.command_server.send_replace(None);
                        signals.server_wake.notify_one();
                    }
                })
                .await;
            });
            self.link.handles.lock().unwrap_or_else(|error| error.into_inner()).push(commands);
        }
        if !self.reporting.started.swap(true, Ordering::AcqRel) {
            if let Some(signals) = self.reporting.activity_rx.lock().unwrap_or_else(|error| error.into_inner()).take() {
                let core = self.reporting.core.clone();
                let clocks = self.reporting.clocks.clone();
                let timezone = self.reporting.timezone.clone();
                let handle = self.reporting.activity.clone();
                let server = self.reporting.signals.command_server.subscribe();
                let report_wake = self.reporting.report_wake.clone();
                let server_wake = self.reporting.signals.server_wake.clone();
                let shutdown = self.reporting.shutdown.clone();
                let activity = runtime.spawn(async move {
                    core.run_activity(player_core::ActivityServices {
                        clocks: &clocks,
                        timezone: &timezone,
                        handle: &handle,
                        signals,
                        server,
                        report_wake: &report_wake,
                        server_wake: &server_wake,
                        shutdown: &shutdown,
                    })
                    .await;
                });
                self.reporting.handles.lock().unwrap_or_else(|error| error.into_inner()).push(activity);
            }
            let core = self.reporting.core.clone();
            let telemetry = self.reporting.telemetry.clone();
            let shutdown = self.reporting.shutdown.clone();
            let samples = runtime.spawn(async move {
                core.run_telemetry(&telemetry, &shutdown).await;
            });
            self.reporting.handles.lock().unwrap_or_else(|error| error.into_inner()).push(samples);
        }
        if !self.renderer.started.swap(true, Ordering::AcqRel) {
            let engine = self.renderer.engine.clone();
            let clock = self.renderer.clock.clone();
            let shutdown = self.renderer.shutdown.clone();
            let supervision = runtime.spawn(async move {
                let mut ticker = tokio::time::interval(SUPERVISION_INTERVAL);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        () = shutdown.cancelled() => return,
                        _ = ticker.tick() => {}
                    }
                    engine.lock().await.tick(clock.now()).await;
                }
            });
            self.renderer.handles.lock().unwrap_or_else(|error| error.into_inner()).push(supervision);
            let preview = self.renderer.preview.clone();
            let server = self.renderer.signals.command_server.subscribe();
            let shutdown = self.renderer.shutdown.clone();
            let previews = runtime.spawn(async move {
                player_core::drive_preview(preview, server, &shutdown).await;
            });
            self.renderer.handles.lock().unwrap_or_else(|error| error.into_inner()).push(previews);
            let selection = runtime.spawn(run_selection(
                self.renderer.core.clone(),
                self.renderer.cas.clone(),
                SelectionHost::new(
                    self.renderer.engine.clone(),
                    self.renderer.config.clone(),
                    self.renderer.signals.manifest_wake.clone(),
                    self.renderer.signals.gate.clone(),
                ),
                self.renderer.signals.manifest_wake.clone(),
                self.renderer.signals.manifest_item_boundary.clone(),
                self.renderer.shutdown.clone(),
            ));
            self.renderer.handles.lock().unwrap_or_else(|error| error.into_inner()).push(selection);
            let live_host = self.renderer.live_stream.clone();
            let live_server = self.renderer.signals.command_server.subscribe();
            let live_wake = self.renderer.signals.live_stream_wake.clone();
            let live_shutdown = self.renderer.shutdown.clone();
            let live = runtime.spawn(async move {
                player_core::drive_live_stream(live_host, live_server, &live_wake, &live_shutdown).await;
            });
            self.renderer.handles.lock().unwrap_or_else(|error| error.into_inner()).push(live);
        }
    }

    /// Wakes the pairing loop for an immediate pass (for example after the
    /// server URL changes or a pairing reset).
    pub fn wake_pairing(&self) {
        self.pairing.wake.notify_one();
    }

    pub fn pairing(&self) -> &PairingCoordinator {
        &self.pairing.coordinator
    }

    pub fn pairing_host(&self) -> &AndroidPairingHost {
        &self.pairing.host
    }

    pub fn user_agent(&self) -> &str {
        &self.pairing.user_agent
    }

    pub fn link_signals(&self) -> &Arc<LinkSignals> {
        &self.link.signals
    }

    /// The Activity signal handle the presentation engine reports
    /// through. The reporting driver drains the same channel.
    pub fn activity(&self) -> player_core::ActivityHandle {
        self.reporting.activity.clone()
    }

    /// Cancels every driver and waits for their tasks to finish. Runs
    /// before the host drops its runtime, state, and stores.
    pub async fn shutdown(&self) {
        self.pairing.shutdown.cancel();
        self.link.shutdown.cancel();
        self.reporting.shutdown.cancel();
        self.renderer.shutdown.cancel();
        let mut handles: Vec<_> =
            self.pairing.handles.lock().unwrap_or_else(|error| error.into_inner()).drain(..).collect();
        handles.extend(self.link.handles.lock().unwrap_or_else(|error| error.into_inner()).drain(..));
        handles.extend(self.reporting.handles.lock().unwrap_or_else(|error| error.into_inner()).drain(..));
        handles.extend(self.renderer.handles.lock().unwrap_or_else(|error| error.into_inner()).drain(..));
        for handle in handles {
            let _ = handle.await;
        }
    }
}
