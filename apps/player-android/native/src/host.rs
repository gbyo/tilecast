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
use player_core::{ConfigurationOutcome, Dependencies, PairingError, PlayerCore};
use player_state::repo::binding;
use player_state::{OpenOptions, StateDb};
use player_types::Timestamp;
use player_types::time::{SharedClock, WallClock};

use crate::config_host::AndroidConfigHost;
use crate::drivers::Drivers;
use crate::jvm::Jvm;
use crate::pairing_host::{JvmMetadataSource, MetadataSource};
use crate::paths::{CorePaths, core_paths};
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
    config: AndroidConfigHost,
    drivers: Drivers,
}

impl std::fmt::Debug for AndroidHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AndroidHost").field("paths", &self.paths).finish_non_exhaustive()
    }
}

impl AndroidHost {
    fn open(
        paths: CorePaths,
        calls: Arc<dyn StoreCalls>,
        meta: Arc<dyn MetadataSource>,
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
                clock,
                Arc::new(StatvfsProbe),
                Arc::new(AndroidSecureOpener),
                policy,
                Arc::new(LruByDomain),
            ))
            .map_err(|_| HostError::Cas)?;
        let credentials: Arc<dyn player_client::CredentialStore> =
            Arc::new(JvmCredentialStore::new(Arc::clone(&calls)));
        let pairing = core.pairing(Arc::clone(&credentials), Arc::new(JvmPairingStore::new(calls)));
        let config = AndroidConfigHost::new(paths.installed_config.clone(), cas);
        let drivers = Drivers::new(pairing, meta, user_agent);
        Ok(Self { paths, runtime, state, core, _jvm: jvm, credentials, config, drivers })
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
        serde_json::json!({
            "bridge": 2,
            "ok": true,
            "stateDb": self.paths.state_db.to_string_lossy(),
            "casDir": self.paths.cas_dir.to_string_lossy(),
            "paired": paired,
            "configRevision": self.config.accepted_revision(),
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
            let config = &self.config;
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
        let config = &self.config;
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

    fn user_agent(&self) -> &str {
        self.drivers.user_agent()
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
    open_host_with(files_dir, calls, meta, user_agent, Some(jvm))
}

/// Opens the process host against abstract stores. Production uses
/// [`open_host`]; host tests substitute in-memory fakes.
pub fn open_host_with(
    files_dir: &Path,
    calls: Arc<dyn StoreCalls>,
    meta: Arc<dyn MetadataSource>,
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
    let host = AndroidHost::open(core_paths(files_dir), calls, meta, user_agent, jvm)?;
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
        assert!(matches!(open_host_with(Path::new("relative"), calls, meta, "ua", None), Err(HostError::FilesDir)));
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
