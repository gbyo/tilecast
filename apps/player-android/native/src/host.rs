//! The process-level Android Player host.
//!
//! [`AndroidHost`] owns one Tokio runtime, one Player State database, one
//! content store, one [`player_core::PlayerCore`] instance, the Android
//! private stores, and the Core driver supervisor. Exactly one host is live
//! per process: a second `open` fails while the first is alive, so there is
//! never a second Core, socket, or reconciliation loop.
//!
//! Opening wires the lifetime only. [`AndroidHost::start_drivers`] spawns
//! the Core reconciliation loops; production leaves them stopped until the
//! PR3 cutover, while the Core-only test mode starts them directly.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use player_cas::open::{RegularOpen, SecureOpener};
use player_cas::space::SpaceProbe;
use player_cas::{ContentStore, LruByDomain, StorePolicy};
use player_core::{ConfigurationOutcome, Dependencies, ManifestPrepared, PairingError, PlayerCore};
use player_state::repo::binding;
use player_state::{OpenOptions, StateDb};
use player_types::Timestamp;
use player_types::time::{SharedClock, WallClock};

use crate::config_host::AndroidConfigHost;
use crate::drivers::Drivers;
use crate::jvm::Jvm;
use crate::manifest_host::{AndroidManifestHost, PrepareError};
use crate::pairing_host::{JvmMetadataSource, MetadataSource};
use crate::paths::{CorePaths, core_paths};
use crate::renderer::{AndroidRendererPort, JvmRendererPlatform, PresentationEngine, RendererSnapshot};
use crate::stores::{JvmCredentialStore, JvmPairingStore, JvmStoreCalls, StoreCalls};

/// Matches the Android media cache budget (`MEDIA_CACHE_BYTES`): 8 GiB of
/// verified content. PR2 projects the player configuration over this.
pub const CAS_LIMIT_BYTES: u64 = 8 * 1024 * 1024 * 1024;
/// Matches the Android free-space floor (`MINIMUM_FREE_BYTES`): 1 GiB.
pub const CAS_RESERVED_FREE_BYTES: u64 = 1024 * 1024 * 1024;
/// Core driver workers. Pairing polls and short reconciliations need no
/// more; blocking JNI crossings use the blocking pool instead.
pub const CORE_WORKER_THREADS: usize = 2;
/// The `User-Agent` Kotlin reports is bounded before it crosses the bridge.
pub const MAX_USER_AGENT_CHARS: usize = 256;

/// The Android host supplies wall time; shared values only define its port.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl WallClock for SystemClock {
    fn now(&self) -> Timestamp {
        Timestamp::from_offset_datetime(time::OffsetDateTime::now_utc())
    }
}

/// Free space via `statvfs`, the same fact Edge measures on Linux.
#[derive(Debug, Default, Clone, Copy)]
pub struct StatvfsProbe;

impl SpaceProbe for StatvfsProbe {
    fn available_bytes(&self, path: &Path) -> std::io::Result<u64> {
        let stat = rustix::fs::statvfs(path).map_err(std::io::Error::from)?;
        Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
    }
}

/// Regular-file opens with `O_NOFOLLOW`, so a symbolic link can never be
/// followed, however it is swapped in. Same semantics as the Edge opener;
/// Android and Linux share these open-file metadata semantics.
#[derive(Debug, Default, Clone, Copy)]
pub struct AndroidSecureOpener;

impl SecureOpener for AndroidSecureOpener {
    fn open_regular(&self, path: &Path, max_bytes: u64) -> std::io::Result<RegularOpen> {
        use rustix::fs::OFlags;
        use std::os::unix::fs::OpenOptionsExt as _;
        let flags = OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY;
        let file: std::fs::File =
            match std::fs::OpenOptions::new().read(true).custom_flags(flags.bits() as i32).open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(RegularOpen::Missing);
                }
                // ELOOP: the final component is a symbolic link.
                Err(error) if error.raw_os_error() == Some(rustix::io::Errno::LOOP.raw_os_error()) => {
                    return Ok(RegularOpen::Refused);
                }
                Err(error) => return Err(error),
            };
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file() || metadata.len() > max_bytes {
            return Ok(RegularOpen::Refused);
        }
        Ok(RegularOpen::Opened(file, metadata.len()))
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("the files directory is not usable")]
    FilesDir,
    #[error("the user agent is not usable")]
    UserAgent,
    #[error("a Player Core host is already live in this process")]
    AlreadyLive,
    #[error("no Player Core host is live")]
    NotLive,
    #[error("unknown host handle")]
    BadHandle,
    #[error("the Core state database could not be opened")]
    State,
    #[error("the Core content store could not be opened")]
    Cas,
    #[error("the Core runtime could not start")]
    Runtime,
    #[error("the host was shut down")]
    ShutDown,
    #[error("the Player is already paired")]
    AlreadyPaired,
    #[error("pairing is disabled")]
    PairingDisabled,
    #[error("pairing failed")]
    PairingFailed,
    #[error("the Player is not paired")]
    NotPaired,
    #[error("the server rejected the device credential")]
    CredentialRejected,
    #[error("configuration sync failed")]
    SyncFailed,
}

impl HostError {
    /// Stable machine code for the JNI boundary. Messages stay out of the
    /// bridge so storage paths never leak into logs or payloads.
    pub fn code(&self) -> &'static str {
        match self {
            Self::FilesDir => "files_dir_unusable",
            Self::UserAgent => "user_agent_unusable",
            Self::AlreadyLive => "host_already_live",
            Self::NotLive => "host_not_live",
            Self::BadHandle => "bad_handle",
            Self::State => "state_open_failed",
            Self::Cas => "cas_open_failed",
            Self::Runtime => "runtime_start_failed",
            Self::ShutDown => "host_shut_down",
            Self::AlreadyPaired => "already_paired",
            Self::PairingDisabled => "pairing_disabled",
            Self::PairingFailed => "pairing_failed",
            Self::NotPaired => "not_paired",
            Self::CredentialRejected => "credential_rejected",
            Self::SyncFailed => "sync_failed",
        }
    }
}

impl From<PairingError> for HostError {
    fn from(error: PairingError) -> Self {
        match error {
            PairingError::AlreadyPaired => Self::AlreadyPaired,
            PairingError::PairingDisabled => Self::PairingDisabled,
            _ => Self::PairingFailed,
        }
    }
}

/// One process-level Core instance and everything it is built from.
pub struct AndroidHost {
    paths: CorePaths,
    runtime: tokio::runtime::Runtime,
    state: StateDb,
    core: PlayerCore,
    _jvm: Option<Arc<Jvm>>,
    credentials: Arc<dyn player_client::CredentialStore>,
    config: Arc<AndroidConfigHost>,
    cas: ContentStore,
    drivers: Drivers,
    renderer: Arc<tokio::sync::Mutex<PresentationEngine>>,
    renderer_broker: Arc<player_core::CaptureBroker>,
    renderer_snapshot: Arc<Mutex<RendererSnapshot>>,
}

impl std::fmt::Debug for AndroidHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AndroidHost").field("paths", &self.paths).finish_non_exhaustive()
    }
}

impl AndroidHost {
    #[allow(clippy::too_many_arguments)]
    fn open(
        paths: CorePaths,
        calls: Arc<dyn StoreCalls>,
        meta: Arc<dyn MetadataSource>,
        platform: Arc<dyn crate::commands::PlatformCommands>,
        renderer_platform: Arc<dyn crate::renderer::RendererPlatform>,
        user_agent: String,
        jvm: Option<Arc<Jvm>>,
    ) -> Result<Self, HostError> {
        std::fs::create_dir_all(&paths.root).map_err(|_| HostError::FilesDir)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(CORE_WORKER_THREADS)
            .thread_name("tilecast-core")
            .enable_all()
            .build()
            .map_err(|_| HostError::Runtime)?;
        let state = StateDb::open(paths.state_db.clone(), OpenOptions::default()).map_err(|_| HostError::State)?;
        let clock: SharedClock = Arc::new(SystemClock);
        let core = PlayerCore::new(Dependencies { state: state.clone(), clock: clock.clone() });
        let policy = StorePolicy { limit_bytes: CAS_LIMIT_BYTES, reserved_free_bytes: CAS_RESERVED_FREE_BYTES };
        let cas = runtime
            .block_on(ContentStore::open(
                paths.cas_dir.clone(),
                paths.partial_dir.clone(),
                state.clone(),
                clock.clone(),
                Arc::new(StatvfsProbe),
                Arc::new(AndroidSecureOpener),
                policy,
                Arc::new(LruByDomain),
            ))
            .map_err(|_| HostError::Cas)?;
        let credentials: Arc<dyn player_client::CredentialStore> =
            Arc::new(JvmCredentialStore::new(Arc::clone(&calls)));
        let pairing = core.pairing(Arc::clone(&credentials), Arc::new(JvmPairingStore::new(calls)));
        let config = Arc::new(AndroidConfigHost::new(paths.installed_config.clone(), cas.clone()));
        let signals = Arc::new(crate::server_link::LinkSignals::default());
        let renderer_snapshot = Arc::new(Mutex::new(RendererSnapshot::default()));
        let renderer = Arc::new(tokio::sync::Mutex::new(PresentationEngine::new(
            AndroidRendererPort::new(renderer_platform, cas.clone()),
            clock.clone(),
            renderer_snapshot.clone(),
            signals.manifest_wake.clone(),
            signals.manifest_item_boundary.clone(),
            clock.now(),
        )));
        let renderer_broker = Arc::new(player_core::CaptureBroker::default());
        let drivers = Drivers::new(
            pairing,
            Arc::clone(&meta),
            user_agent,
            crate::drivers::ServerLinkDeps {
                core: core.clone(),
                state: state.clone(),
                config: Arc::clone(&config),
                cas: cas.clone(),
                credentials: Arc::clone(&credentials),
                meta,
                platform,
                commands: Arc::new(std::sync::Mutex::new(None)),
                state_dir: paths.root.clone(),
                renderer_engine: renderer.clone(),
                renderer_broker: renderer_broker.clone(),
                renderer_snapshot: renderer_snapshot.clone(),
                signals: signals.clone(),
            },
        );
        // The engine reports through the same Activity channel the
        // reporting driver drains.
        let activity = drivers.activity();
        runtime.block_on(async {
            renderer.lock().await.set_activity(activity);
        });
        Ok(Self {
            paths,
            runtime,
            state,
            cas: cas.clone(),
            core,
            _jvm: jvm,
            credentials,
            config,
            drivers,
            renderer,
            renderer_broker,
            renderer_snapshot,
        })
    }

    /// The coarse status snapshot shared with Kotlin (bridge contract v1).
    /// Paths identify storage; they carry no credentials or content.
    pub fn status(&self) -> serde_json::Value {
        let paired = self
            .runtime
            .block_on(self.state.run(|connection| player_state::repo::binding::get(connection)))
            .ok()
            .flatten()
            .is_some_and(|bound| bound.credential_state == player_state::repo::binding::CredentialState::Stored);
        let signals = self.drivers.link_signals();
        let link = signals.link_state.lock().unwrap_or_else(|error| error.into_inner()).clone();
        let last_contact = *signals.last_server_contact.lock().unwrap_or_else(|error| error.into_inner());
        let renderer = self.renderer_snapshot.lock().unwrap_or_else(|error| error.into_inner()).clone();
        serde_json::json!({
            "bridge": 3,
            "ok": true,
            "stateDb": self.paths.state_db.to_string_lossy(),
            "casDir": self.paths.cas_dir.to_string_lossy(),
            "paired": paired,
            "configRevision": self.config.accepted_revision(),
            "linkState": link.state_token(),
            "linkReason": link.reason_code(),
            "lastServerContactAt": last_contact.map(|at| at.to_string()),
            "renderer": {
                "state": renderer.state,
                "connected": renderer.connected,
                "ready": renderer.ready,
                "generation": renderer.generation,
                "accepted": renderer.accepted,
                "evidence": renderer.evidence,
                "playing": renderer.playing,
                "safeMode": renderer.safe_mode,
                "incompatibleReason": renderer.incompatible_reason,
                "lastError": renderer.last_error,
                "currentItemId": renderer.current_item_id,
            },
        })
    }

    pub fn paths(&self) -> &CorePaths {
        &self.paths
    }

    /// The configuration binding in force, if the player is enrolled.
    fn config_binding(&self) -> Option<player_state::repo::manifests::Binding> {
        let bound = self.runtime.block_on(self.state.run(|connection| binding::get(connection))).ok().flatten()?;
        match (bound.credential_state, bound.screen_id) {
            (binding::CredentialState::Stored, Some(screen_id)) => Some(player_state::repo::manifests::Binding {
                installation_id: bound.installation_id,
                screen_id,
                server_url: bound.server_url,
            }),
            _ => None,
        }
    }

    /// Spawns the Core reconciliation loops. Idempotent. Applies the
    /// accepted configuration from local state first, before any network
    /// access, so a restart never waits for the server to know its policy.
    pub fn start_drivers(&self) {
        if let Some(binding) = self.config_binding() {
            let coordinator = self.core.configuration();
            let config = self.config.as_ref();
            self.runtime.block_on(async move { coordinator.load_cached(&binding, config).await });
        }
        self.drivers.start(&self.runtime);
    }

    /// One configuration reconciliation against the bound server. Test
    /// tooling and (later) background liveness call this directly; the
    /// server-link driver calls the same coordinator on its own cadence.
    /// Kotlin calls this off the main thread.
    pub fn sync_config(&self) -> Result<serde_json::Value, HostError> {
        let binding = self.config_binding().ok_or(HostError::NotPaired)?;
        let credential = self.credentials.load().ok().flatten().ok_or(HostError::NotPaired)?;
        let user_agent = self.user_agent().to_owned();
        let coordinator = self.core.configuration();
        let config = self.config.as_ref();
        let outcome = self.runtime.block_on(async move {
            let client = player_client::ServerClient::new(&binding.server_url, &user_agent)
                .map_err(|_| HostError::SyncFailed)?;
            let server =
                client.verify_installation(binding.installation_id, credential).await.map_err(|error| match error {
                    player_client::ServerError::CredentialRejected => HostError::CredentialRejected,
                    _ => HostError::SyncFailed,
                })?;
            coordinator.reconcile(&server, &binding, config).await.map_err(|error| match error {
                player_client::ServerError::CredentialRejected => HostError::CredentialRejected,
                _ => HostError::SyncFailed,
            })
        })?;
        Ok(match outcome {
            ConfigurationOutcome::Unchanged => serde_json::json!({
                "ok": true,
                "outcome": "unchanged",
                "revision": self.config.accepted_revision(),
            }),
            ConfigurationOutcome::Accepted { revision } => serde_json::json!({
                "ok": true,
                "outcome": "accepted",
                "revision": revision,
            }),
            ConfigurationOutcome::Refused { reason } => serde_json::json!({
                "ok": true,
                "outcome": "refused",
                "reason": reason,
                "revision": self.config.accepted_revision(),
            }),
        })
    }

    /// One legacy Room/cache import into Core state. Idempotent: the
    /// marker short-circuits repeats, and a crash mid-run retries to
    /// completion. Kotlin calls this once at startup, off the main
    /// thread, before starting Core drivers.
    pub fn import_legacy(&self) -> serde_json::Value {
        let files_dir = self.paths.root.parent().unwrap_or(&self.paths.root).to_path_buf();
        let deps = crate::legacy_import::ImportDeps {
            state: self.state.clone(),
            core: self.core.clone(),
            cas: self.cas.clone(),
            config: Arc::clone(&self.config),
            credentials: Arc::clone(&self.credentials),
            clock: Arc::new(SystemClock),
            files_dir,
            core_root: self.paths.root.clone(),
        };
        let outcome = self.runtime.block_on(crate::legacy_import::import_legacy(&deps));
        outcome.marker_json()
    }

    /// One manifest reconciliation against the bound server: fetch the
    /// validated target, then prepare its verified content through the
    /// renderer profile. Test tooling and (later) the manifest worker
    /// call this directly; Kotlin calls it off the main thread.
    pub fn sync_manifest(&self) -> Result<serde_json::Value, HostError> {
        fn rejected(error: &player_client::ServerError) -> bool {
            matches!(error, player_client::ServerError::CredentialRejected)
        }
        let binding = self.config_binding().ok_or(HostError::NotPaired)?;
        let credential = self.credentials.load().ok().flatten().ok_or(HostError::NotPaired)?;
        let user_agent = self.user_agent().to_owned();
        let core = self.core.clone();
        let cas = self.config.cas();
        let manifest_wake = self.drivers.link_signals().manifest_wake.clone();
        self.runtime.block_on(async move {
            let client = player_client::ServerClient::new(&binding.server_url, &user_agent)
                .map_err(|_| HostError::SyncFailed)?;
            let server =
                client.verify_installation(binding.installation_id, credential).await.map_err(|error| {
                    if rejected(&error) { HostError::CredentialRejected } else { HostError::SyncFailed }
                })?;
            let host = AndroidManifestHost::new(core.clone(), cas, server);
            let target = host.reconcile(&binding).await.map_err(|error| match &error {
                player_core::ManifestSyncError::Server(server) if rejected(server) => {
                    HostError::CredentialRejected
                }
                _ => HostError::SyncFailed,
            })?;
            let Some(target) = target else {
                let version = core.manifests().persisted_target(&binding).await.map(|target| target.version);
                return Ok(serde_json::json!({"ok": true, "outcome": "unchanged", "version": version}));
            };
            let version = target.version;
            let prepared = host.prepare_target(&target).await;
            // A new target may need selection now; notify after the
            // store is updated so the driver's tick sees it.
            manifest_wake.notify_one();
            match prepared {
                Ok(ManifestPrepared::Current) => {
                    Ok(serde_json::json!({"ok": true, "outcome": "current", "version": version}))
                }
                Ok(ManifestPrepared::Repaired) => {
                    Ok(serde_json::json!({"ok": true, "outcome": "repaired", "version": version}))
                }
                Ok(ManifestPrepared::Pending) => {
                    Ok(serde_json::json!({"ok": true, "outcome": "prepared", "version": version}))
                }
                Ok(ManifestPrepared::Superseded) => {
                    Ok(serde_json::json!({"ok": true, "outcome": "superseded", "version": version}))
                }
                Err(PrepareError::State) => Err(HostError::SyncFailed),
                Err(error) => {
                    Ok(serde_json::json!({"ok": true, "outcome": "failed", "reason": error.reason_code(), "version": version}))
                }
            }
        })
    }

    /// Begins a pairing session against `url`, blocking the caller while
    /// the session is created. Kotlin calls this off the main thread.
    pub fn begin_pairing(&self, url: &str) -> Result<(), HostError> {
        let coordinator = self.drivers.pairing().clone();
        let host = self.drivers.pairing_host().clone();
        let user_agent = self.user_agent().to_owned();
        let url = url.to_owned();
        self.runtime.block_on(async move { coordinator.begin(&url, &user_agent, &host).await })?;
        self.drivers.wake_pairing();
        Ok(())
    }

    /// Resets pairing: suppresses auto-begin, drops the saved session, and
    /// reports reset to the Kotlin surface.
    pub fn reset_pairing(&self) {
        let coordinator = self.drivers.pairing().clone();
        let host = self.drivers.pairing_host().clone();
        self.runtime.block_on(coordinator.reset(&host));
        self.drivers.wake_pairing();
    }

    /// Issues a presentation activation from a projected host message.
    /// Refusals (unknown media, unverified content, oversized
    /// projections) are ordinary outcomes with a machine reason, never
    /// host errors. Kotlin calls this off the main thread.
    pub fn activate_presentation(&self, json: &str) -> serde_json::Value {
        let outcome = self.runtime.block_on(async {
            let mut engine = self.renderer.lock().await;
            let now = engine.clock().now();
            engine.activate(json, now).await
        });
        match outcome {
            Ok(outcome) => serde_json::json!({
                "ok": true,
                "activationId": outcome.activation_id,
                "generation": outcome.generation,
                "queued": outcome.queued,
                "incompatibleReason": outcome.incompatible_reason,
            }),
            Err(error) => serde_json::json!({"ok": true, "outcome": "refused", "reason": error.code()}),
        }
    }

    /// One renderer report: connection, readiness, acceptance,
    /// evidence, errors, and capture answers. Stale generations and
    /// unknown activations are ignored, never errors. Kotlin calls
    /// this off the main thread.
    pub fn renderer_report(&self, json: &str) -> i32 {
        use renderer_report::{APPLIED, IGNORED, MALFORMED};
        if json.is_empty() || json.len() > 8 * 1024 * 1024 {
            return MALFORMED;
        }
        let report: serde_json::Value = match serde_json::from_str(json) {
            Ok(report) => report,
            Err(_) => return MALFORMED,
        };
        let kind = report.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
        if kind == "capture" {
            return if crate::renderer::complete_capture(&self.renderer_broker, json) { APPLIED } else { IGNORED };
        }
        let Some(generation) = report.get("generation").and_then(serde_json::Value::as_i64) else {
            return MALFORMED;
        };
        let activation = report.get("activationId").and_then(serde_json::Value::as_str).unwrap_or("");
        let activation_generation = report.get("activationGeneration").and_then(serde_json::Value::as_u64).unwrap_or(0);
        self.runtime.block_on(async {
            let mut engine = self.renderer.lock().await;
            let now = engine.clock().now();
            let applied = match kind {
                "connected" => {
                    engine.renderer_connected(generation, now);
                    true
                }
                "disconnected" => {
                    engine.renderer_disconnected(generation);
                    true
                }
                "ready" => match report.get("report") {
                    Some(profile) => engine.renderer_ready(generation, profile).await,
                    None => return MALFORMED,
                },
                "accepted" => engine.accepted(generation, activation, activation_generation),
                "rejected" => engine.rejected(
                    generation,
                    activation,
                    activation_generation,
                    report.get("code").and_then(serde_json::Value::as_str),
                ),
                "progress" => {
                    let Some(kind) = report.get("kind").and_then(serde_json::Value::as_str) else {
                        return MALFORMED;
                    };
                    engine
                        .progress(
                            generation,
                            activation,
                            activation_generation,
                            kind,
                            report.get("itemId").and_then(serde_json::Value::as_str),
                            report.get("zoneId").and_then(serde_json::Value::as_str),
                            now,
                        )
                        .0
                }
                "error" => {
                    let (Some(code), Some(message)) = (
                        report.get("code").and_then(serde_json::Value::as_str),
                        report.get("message").and_then(serde_json::Value::as_str),
                    ) else {
                        return MALFORMED;
                    };
                    engine.item_error(
                        generation,
                        activation,
                        activation_generation,
                        code,
                        report.get("itemId").and_then(serde_json::Value::as_str),
                        message,
                    )
                }
                _ => return MALFORMED,
            };
            if applied { APPLIED } else { IGNORED }
        })
    }

    /// Renderer recovery controls for commands and tests: `retry` runs
    /// the next ladder rung at once, `clear_safe_mode` leaves safe
    /// mode, and `clear` withdraws the current activation. Kotlin
    /// calls this off the main thread.
    pub fn renderer_recovery(&self, json: &str) -> serde_json::Value {
        let action = serde_json::from_str::<serde_json::Value>(json)
            .ok()
            .and_then(|report| report.get("action").and_then(serde_json::Value::as_str).map(str::to_owned));
        match action.as_deref() {
            Some("retry") => {
                let action = self.runtime.block_on(async {
                    let mut engine = self.renderer.lock().await;
                    let now = engine.clock().now();
                    engine.retry_recovery(now).await
                });
                serde_json::json!({"ok": true, "action": heal_token(action)})
            }
            Some("clear_safe_mode") => {
                let was = self.runtime.block_on(async {
                    let mut engine = self.renderer.lock().await;
                    let now = engine.clock().now();
                    engine.clear_safe_mode(now)
                });
                serde_json::json!({"ok": true, "wasActive": was})
            }
            Some("clear") => {
                let reason = serde_json::from_str::<serde_json::Value>(json)
                    .ok()
                    .and_then(|report| report.get("reason").and_then(serde_json::Value::as_str).map(str::to_owned))
                    .unwrap_or_else(|| "cleared".to_owned());
                self.runtime.block_on(async {
                    self.renderer.lock().await.clear(&reason);
                });
                serde_json::json!({"ok": true})
            }
            _ => serde_json::json!({"ok": true, "outcome": "refused", "reason": "unknown_action"}),
        }
    }

    fn user_agent(&self) -> &str {
        self.drivers.user_agent()
    }
}

/// The `rendererReport` answer codes, shared with Kotlin.
pub mod renderer_report {
    /// The report applied to the live connection and activation.
    pub const APPLIED: i32 = 0;
    /// A stale generation, unknown activation, or unanswerable
    /// capture: received and dropped.
    pub const IGNORED: i32 = 1;
    /// The envelope itself was unreadable.
    pub const MALFORMED: i32 = 2;
}

fn heal_token(action: player_core::HealAction) -> &'static str {
    match action {
        player_core::HealAction::None => "none",
        player_core::HealAction::Reactivate => "reactivate",
        player_core::HealAction::ReloadRenderer => "reload",
        player_core::HealAction::RestartRenderer => "restart",
        player_core::HealAction::EnterSafeMode => "safe_mode",
    }
}

static LIVE_HOST: Mutex<Option<Arc<AndroidHost>>> = Mutex::new(None);

/// The only valid handle while a host is live. Handles stay stable
/// identifiers; they are never pointers, indexes, or array offsets.
pub const LIVE_HANDLE: i64 = 1;

fn validated(user_agent: &str) -> Result<String, HostError> {
    if user_agent.is_empty() || user_agent.len() > MAX_USER_AGENT_CHARS {
        return Err(HostError::UserAgent);
    }
    Ok(user_agent.to_owned())
}

/// Opens the process host against the Kotlin handler. Fails when the files
/// dir is unusable or a host is already live. `files_dir` must be the
/// app-private files directory.
pub fn open_host(files_dir: &Path, jvm: Arc<Jvm>, user_agent: &str) -> Result<i64, HostError> {
    let calls: Arc<dyn StoreCalls> = Arc::new(JvmStoreCalls::new(jvm.clone()));
    let meta: Arc<dyn MetadataSource> = Arc::new(JvmMetadataSource::new(jvm.clone()));
    let platform: Arc<dyn crate::commands::PlatformCommands> =
        Arc::new(crate::commands::JvmPlatformCommands::new(jvm.clone()));
    let renderer: Arc<dyn crate::renderer::RendererPlatform> = Arc::new(JvmRendererPlatform::new(jvm.clone()));
    open_host_with(files_dir, calls, meta, platform, renderer, user_agent, Some(jvm))
}

/// Opens the process host against abstract stores. Production uses
/// [`open_host`]; host tests substitute in-memory fakes.
pub fn open_host_with(
    files_dir: &Path,
    calls: Arc<dyn StoreCalls>,
    meta: Arc<dyn MetadataSource>,
    platform: Arc<dyn crate::commands::PlatformCommands>,
    renderer: Arc<dyn crate::renderer::RendererPlatform>,
    user_agent: &str,
    jvm: Option<Arc<Jvm>>,
) -> Result<i64, HostError> {
    if files_dir.as_os_str().is_empty() || !files_dir.is_absolute() {
        return Err(HostError::FilesDir);
    }
    let user_agent = validated(user_agent)?;
    let mut live = LIVE_HOST.lock().map_err(|_| HostError::ShutDown)?;
    if live.is_some() {
        return Err(HostError::AlreadyLive);
    }
    let host = AndroidHost::open(core_paths(files_dir), calls, meta, platform, renderer, user_agent, jvm)?;
    *live = Some(Arc::new(host));
    Ok(LIVE_HANDLE)
}

/// Reads the live host without transferring ownership.
pub fn with_host<T>(handle: i64, read: impl FnOnce(&AndroidHost) -> T) -> Result<T, HostError> {
    if handle != LIVE_HANDLE {
        return Err(HostError::BadHandle);
    }
    let host = {
        let live = LIVE_HOST.lock().map_err(|_| HostError::ShutDown)?;
        match live.as_ref() {
            Some(host) => host.clone(),
            None => return Err(HostError::NotLive),
        }
    };
    Ok(read(&host))
}

/// Stops the drivers, then drops the live host, closing State, CAS, and the
/// Core runtime.
pub fn close_host(handle: i64) -> Result<(), HostError> {
    if handle != LIVE_HANDLE {
        return Err(HostError::BadHandle);
    }
    let host = {
        let mut live = LIVE_HOST.lock().map_err(|_| HostError::ShutDown)?;
        match live.take() {
            Some(host) => host,
            None => return Err(HostError::NotLive),
        }
    };
    host.runtime.block_on(host.drivers.shutdown());
    Ok(())
}

/// Filesystem roots below the app-private files dir, for tests.
pub fn probe_paths(files_dir: PathBuf) -> CorePaths {
    core_paths(&files_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_files_dir() {
        let calls: Arc<dyn StoreCalls> = Arc::new(crate::stores::MemStoreCalls::default());
        let meta: Arc<dyn MetadataSource> = Arc::new(crate::pairing_host::MemMetadataSource::with_facts("{}"));
        let platform: Arc<dyn crate::commands::PlatformCommands> =
            Arc::new(crate::commands::MemPlatformCommands::with_result("{}"));
        let renderer: Arc<dyn crate::renderer::RendererPlatform> =
            Arc::new(crate::renderer::MemRendererPlatform::default());
        assert!(matches!(
            open_host_with(Path::new("relative"), calls, meta, platform, renderer, "ua", None),
            Err(HostError::FilesDir)
        ));
    }

    #[test]
    fn rejects_unknown_handles_without_touching_global_state() {
        assert!(matches!(with_host(7, |_| ()), Err(HostError::BadHandle)));
        assert!(matches!(close_host(0), Err(HostError::BadHandle)));
    }

    #[test]
    fn rejects_bad_user_agents() {
        assert!(matches!(validated(""), Err(HostError::UserAgent)));
        assert!(matches!(validated(&"x".repeat(MAX_USER_AGENT_CHARS + 1)), Err(HostError::UserAgent)));
        assert_eq!(validated("Tilecast/1.0").expect("valid"), "Tilecast/1.0");
    }

    #[test]
    fn clock_reports_current_time() {
        let before = time::OffsetDateTime::now_utc().unix_timestamp();
        let now = SystemClock.now().unix_millis() / 1000;
        assert!(now >= before - 5 && now <= before + 5);
    }

    #[test]
    fn space_probe_reports_temp_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bytes = StatvfsProbe.available_bytes(dir.path()).expect("statvfs");
        assert!(bytes > 0);
    }

    #[test]
    fn bounded_regular_open_rejects_links_directories_and_oversize() {
        let opener = AndroidSecureOpener;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("object");
        std::fs::write(&path, b"content").expect("write");
        let opened = opener.open_regular(&path, 7).expect("open");
        assert!(matches!(opened, RegularOpen::Opened(_, 7)), "{opened:?}");
        assert!(matches!(opener.open_regular(&path, 6).expect("over limit"), RegularOpen::Refused));
        assert!(matches!(opener.open_regular(dir.path(), 7).expect("directory"), RegularOpen::Refused));
        assert!(matches!(opener.open_regular(&dir.path().join("missing"), 7).expect("missing"), RegularOpen::Missing));
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).expect("symlink");
        assert!(matches!(opener.open_regular(&link, 7).expect("link"), RegularOpen::Refused));
    }

    #[test]
    fn fifo_is_refused_without_blocking() {
        let opener = AndroidSecureOpener;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("fifo");
        assert!(std::process::Command::new("mkfifo").arg(&path).status().expect("mkfifo").success());
        assert!(matches!(opener.open_regular(&path, 7).expect("fifo"), RegularOpen::Refused));
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(HostError::AlreadyLive.code(), "host_already_live");
        assert_eq!(HostError::BadHandle.code(), "bad_handle");
        assert_eq!(HostError::State.code(), "state_open_failed");
        assert_eq!(HostError::AlreadyPaired.code(), "already_paired");
        assert_eq!(HostError::PairingDisabled.code(), "pairing_disabled");
    }

    #[test]
    fn pairing_errors_map_to_codes() {
        assert!(matches!(HostError::from(PairingError::AlreadyPaired), HostError::AlreadyPaired));
        assert!(matches!(HostError::from(PairingError::PairingDisabled), HostError::PairingDisabled));
        assert!(matches!(HostError::from(PairingError::SessionNotStored), HostError::PairingFailed));
    }
}
