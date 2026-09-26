//! Player updates end to end inside the machine (M10): the daemon's update
//! coordinator over real SQLite and a real content store, signed release
//! archives, and the real `tilecast-edge-update` state machine behind its
//! fixed request vocabulary. Only systemd, the clocks and the server are
//! simulated.
//!
//! A "restart" is a new coordinator over the same database, as a restarted
//! daemon does; the candidate daemon is a coordinator that reports the new
//! version. Every durable transition is crossed by a restart in
//! `a_restart_at_every_pass_boundary_finishes_the_same_update`.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use edge_cas::{BlobSource, ContentStore, LruByDomain, SourceError, SourceKind, SourceStream, StorePolicy};
use edge_platform::disk::FixedSpace;
use edge_protocol::Sha256Digest;
use edge_protocol::bounded::{ShortText, ShortToken};
use edge_protocol::ipc::status::{DaemonMode, DaemonStatus, PresentationStatus, RendererStatus, ServerLinkStatus};
use edge_protocol::time::system_clock;
use edge_release::install::{Layout, current_version, install_with_key};
use edge_release::protocol::{HelperRequest, HelperResponse, Phase};
use edge_release::testing::{Signer, layout, write_archive};
use edge_server::client::ServerError;
use edge_server::updates::{UpdateMetadata, UpdateReport, UpdateReportOutcome};
use edge_state::repo::updates::{self as jobs, JobState};
use edge_state::{OpenOptions, StateDb};
use futures_util::StreamExt as _;
use tilecast_edge_update::host::{EDGE_DAEMON, EDGE_RENDERER, HostError, UnitActivity, UpdateHost};
use tilecast_edge_update::transaction::TransactionStore;
use tilecast_edge_update::updater::{CrashPoint, HelperPaths, Timing, Updater};
use tilecastd::update::{
    Coordinator, Helper, HelperError, Observation, Pass, PresentationFacts, STABLE_PERIOD, UpdateApi,
};

const OLD: &str = "0.1.0";
const NEW: &str = "0.2.0";

// ---- the simulated machine (systemd, clocks, the running daemon) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Behavior {
    Healthy,
    NewerSchemaRefused,
}

#[derive(Debug)]
struct Machine {
    active: BTreeSet<String>,
    running: Option<String>,
    guard: Option<String>,
    boot: String,
    boottime: i64,
    behavior: HashMap<String, Behavior>,
}

#[derive(Debug)]
struct Host {
    machine: Mutex<Machine>,
    install_root: PathBuf,
}

impl Host {
    fn new(install_root: PathBuf) -> Self {
        Self {
            machine: Mutex::new(Machine {
                active: [EDGE_DAEMON, EDGE_RENDERER].iter().map(|u| (*u).to_owned()).collect(),
                running: Some(OLD.into()),
                guard: None,
                boot: "boot".into(),
                boottime: 1_000_000,
                behavior: HashMap::new(),
            }),
            install_root,
        }
    }

    fn with<T>(&self, f: impl FnOnce(&mut Machine) -> T) -> T {
        f(&mut self.machine.lock().unwrap())
    }

    fn current(&self) -> Option<String> {
        std::fs::read_link(self.install_root.join("current")).ok().and_then(|p| p.to_str().map(str::to_owned))
    }
}

fn daemon_status(version: &str, behavior: Behavior) -> DaemonStatus {
    let started = edge_protocol::Timestamp::from_unix_millis(10_000).unwrap();
    DaemonStatus {
        daemon_version: ShortText::lossy(version),
        mode: if behavior == Behavior::NewerSchemaRefused { DaemonMode::Recovery } else { DaemonMode::Normal },
        recovery_reason: (behavior == Behavior::NewerSchemaRefused)
            .then(|| ShortToken::new("state_db_newer_schema").unwrap()),
        started_at: started,
        player_id: None,
        server: None,
        link: ServerLinkStatus {
            state: ShortToken::new("connected").unwrap(),
            reason_code: None,
            last_contact_at: edge_protocol::Timestamp::from_unix_millis(11_000),
        },
        cas: None,
        renderer: RendererStatus {
            connected: true,
            state: ShortToken::new("healthy").unwrap(),
            kind: None,
            version: None,
            platform: None,
            current_activation_generation: Some(1),
            last_progress_at: None,
            last_error_code: None,
            incompatible_reason: None,
            current_item_id: None,
            current_item_started_at: None,
            engine_version: None,
            gstreamer_version: None,
        },
        capability_revision: 1,
        systemd_watchdog: true,
        last_legacy_import: None,
        pairing: None,
        presentation: Some(PresentationStatus {
            source: ShortToken::new("server_manifest").unwrap(),
            generation: 1,
            manifest_sha256: None,
            target_manifest_sha256: None,
            accepted: true,
            evidence: true,
        }),
        outbox: None,
        update: None,
    }
}

#[async_trait]
impl UpdateHost for Host {
    async fn stop(&self, unit: &str) -> Result<(), HostError> {
        self.with(|m| {
            m.active.remove(unit);
            if unit == EDGE_DAEMON {
                m.running = None;
            }
        });
        Ok(())
    }
    async fn start(&self, unit: &str) -> Result<(), HostError> {
        let current = self.current();
        self.with(|m| {
            if m.active.insert(unit.to_owned()) && unit == EDGE_DAEMON {
                m.running = current;
            }
        });
        Ok(())
    }
    async fn activity(&self, unit: &str) -> Result<UnitActivity, HostError> {
        Ok(if self.with(|m| m.active.contains(unit)) { UnitActivity::Running } else { UnitActivity::Inactive })
    }
    async fn reload(&self) -> Result<(), HostError> {
        Ok(())
    }
    async fn apply_system_configuration(&self) -> Result<(), HostError> {
        Ok(())
    }
    async fn arm_guard(&self, previous: &str) -> Result<(), HostError> {
        self.with(|m| m.guard = Some(previous.to_owned()));
        Ok(())
    }
    async fn disarm_guard(&self) -> Result<(), HostError> {
        self.with(|m| m.guard = None);
        Ok(())
    }
    async fn restarts(&self, _unit: &str) -> Result<u64, HostError> {
        Ok(0)
    }
    async fn daemon_status(&self) -> Option<DaemonStatus> {
        self.with(|m| {
            let version = m.running.clone().filter(|_| m.active.contains(EDGE_DAEMON))?;
            let behavior = m.behavior.get(&version).copied().unwrap_or(Behavior::Healthy);
            Some(daemon_status(&version, behavior))
        })
    }
    fn boot_id(&self) -> String {
        self.with(|m| m.boot.clone())
    }
    fn boottime_ms(&self) -> i64 {
        self.with(|m| m.boottime)
    }
    fn now_ms(&self) -> i64 {
        1_700_000_000_000 + self.boottime_ms()
    }
    async fn sleep(&self, duration: Duration) {
        self.with(|m| m.boottime += duration.as_millis() as i64);
    }
}

// ---- the server ------------------------------------------------------------

#[derive(Debug, Default)]
struct Faults {
    /// The next artifact stream ends with a transient error after this byte.
    cut_after: Mutex<Option<u64>>,
    /// Every artifact stream sends these bytes instead.
    wrong_bytes: Mutex<Option<Vec<u8>>>,
    /// Status reports answer 409.
    closed: AtomicBool,
}

/// A status report as the server received it: state, installer status, error.
type Report = (String, Option<String>, Option<String>);

#[derive(Debug)]
struct Server {
    metadata: Mutex<Option<UpdateMetadata>>,
    archive: Vec<u8>,
    faults: Arc<Faults>,
    offsets: Arc<Mutex<Vec<u64>>>,
    reports: Mutex<Vec<Report>>,
}

#[derive(Debug)]
struct Artifact {
    archive: Vec<u8>,
    faults: Arc<Faults>,
    offsets: Arc<Mutex<Vec<u64>>>,
}

#[async_trait]
impl BlobSource for Artifact {
    fn kind(&self) -> SourceKind {
        SourceKind::Origin
    }
    fn label(&self) -> String {
        "origin".into()
    }
    async fn open(&self, _digest: &Sha256Digest, size: u64, offset: u64) -> Result<SourceStream, SourceError> {
        self.offsets.lock().unwrap().push(offset);
        let bytes = self.faults.wrong_bytes.lock().unwrap().clone().unwrap_or_else(|| self.archive.clone());
        let cut = self.faults.cut_after.lock().unwrap().take();
        let end = cut.map_or(bytes.len() as u64, |cut| cut.min(bytes.len() as u64));
        let body: Vec<Result<Bytes, SourceError>> = bytes[offset as usize..end as usize]
            .chunks(4096)
            .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
            .chain(cut.map(|_| Err(SourceError::Retryable("connection reset".into()))))
            .collect();
        Ok(SourceStream { start: offset, total_length: Some(size), body: futures_util::stream::iter(body).boxed() })
    }
}

#[async_trait]
impl UpdateApi for Server {
    async fn metadata(&self, _release: uuid::Uuid) -> Result<UpdateMetadata, ServerError> {
        self.metadata.lock().unwrap().clone().ok_or(ServerError::Api {
            status: 404,
            code: "player_update_not_found".into(),
            message: String::new(),
        })
    }
    fn artifact(&self, _release: uuid::Uuid) -> Option<Arc<dyn BlobSource>> {
        Some(Arc::new(Artifact {
            archive: self.archive.clone(),
            faults: Arc::clone(&self.faults),
            offsets: Arc::clone(&self.offsets),
        }))
    }
    async fn report(&self, _deployment: uuid::Uuid, report: &UpdateReport) -> Result<UpdateReportOutcome, ServerError> {
        if self.faults.closed.load(Ordering::SeqCst) {
            return Ok(UpdateReportOutcome::Closed);
        }
        let mut reports = self.reports.lock().unwrap();
        let entry = (report.state.to_owned(), report.installer_status.clone(), report.error.clone());
        if report.state != "downloading" || reports.last() != Some(&entry) {
            reports.push(entry);
        }
        Ok(UpdateReportOutcome::Accepted)
    }
}

// ---- the helper, behind its request vocabulary -------------------------------

#[derive(Debug, Default)]
struct HelperFaults {
    crash_at: Mutex<Option<CrashPoint>>,
    /// The answer to the next request of this kind is lost after the helper
    /// acted on it.
    lose_answer_to: Mutex<Option<&'static str>>,
    /// The next activation request never reaches the helper.
    drop_activation: AtomicBool,
}

struct Bridge {
    host: Arc<Host>,
    layout: Layout,
    store: TransactionStore,
    key: [u8; 32],
    cas_root: PathBuf,
    faults: HelperFaults,
    calls: AtomicU64,
}

impl Bridge {
    fn updater(&self) -> Updater<'_, Host> {
        let paths = HelperPaths { cas_root: self.cas_root.clone(), tilecast_uid: None, reserve_bytes: 0 };
        Updater::new(self.host.as_ref(), self.layout.clone(), self.store.clone(), self.key, paths)
            .with_timing(Timing { after_rollback_wait: Duration::from_secs(5), ..Timing::default() })
            .crash_at(*self.faults.crash_at.lock().unwrap())
    }

    async fn guard(&self) {
        let paths = HelperPaths { cas_root: self.cas_root.clone(), tilecast_uid: None, reserve_bytes: 0 };
        Updater::new(self.host.as_ref(), self.layout.clone(), self.store.clone(), self.key, paths)
            .guard()
            .await
            .unwrap();
    }
}

#[async_trait]
impl Helper for Bridge {
    async fn call(&self, request: HelperRequest, _timeout: Duration) -> Result<HelperResponse, HelperError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let kind = match &request {
            HelperRequest::Stage { .. } => "stage",
            HelperRequest::Activate { .. } => "activate",
            HelperRequest::Confirm { .. } => "confirm",
            HelperRequest::Rollback { .. } => "rollback",
            HelperRequest::Status {} => "status",
        };
        if kind == "activate" && self.faults.drop_activation.swap(false, Ordering::SeqCst) {
            return Err(HelperError::Unavailable);
        }
        let updater = self.updater();
        let (response, continuation) = tilecast_edge_update::server::handle(&updater, request).await;
        if let Some(transaction) = continuation {
            let _ = updater.run_activation(transaction).await;
        }
        let mut lose = self.faults.lose_answer_to.lock().unwrap();
        if *lose == Some(kind) {
            *lose = None;
            return Err(HelperError::Protocol);
        }
        Ok(response)
    }
}

// ---- the world -------------------------------------------------------------

struct World {
    _dir: tempfile::TempDir,
    db_path: PathBuf,
    cas_dir: PathBuf,
    partial_dir: PathBuf,
    signer: Signer,
    server: Server,
    bridge: Bridge,
    deployment: uuid::Uuid,
    release: uuid::Uuid,
    digest: Sha256Digest,
    now: AtomicU64,
    mono: AtomicU64,
    progress: AtomicU64,
    cas_limit: u64,
}

struct Build {
    state_schema: u32,
    tamper_file: bool,
}

impl Default for Build {
    fn default() -> Self {
        Self { state_schema: edge_state::latest_schema_version(), tamper_file: false }
    }
}

impl World {
    fn new() -> Self {
        Self::build(Build::default())
    }

    fn build(build: Build) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let signer = Signer::new();
        let layout = layout(dir.path());
        let old = dir.path().join("tree-old");
        signer.write_release(&old, OLD);
        install_with_key(&old, &layout, &signer.public()).unwrap();
        let tree = dir.path().join("tree-new");
        signer.write_release(&tree, NEW);
        if build.tamper_file {
            // A file that no longer matches the signed release manifest: the
            // same size, one byte different.
            let mut bytes = std::fs::read(tree.join("bin/tilecastd")).unwrap();
            bytes[0] ^= 0x20;
            std::fs::write(tree.join("bin/tilecastd"), bytes).unwrap();
        }
        let archive_path = dir.path().join("release.tar.zst");
        write_archive(&tree, &archive_path);
        let archive = std::fs::read(&archive_path).unwrap();
        let envelope = signer.envelope_bytes(&tree, &archive_path, build.state_schema);
        let signature = signer.signature(&envelope);
        let digest = Sha256Digest::of(&archive);
        let release = uuid::Uuid::new_v4();
        let metadata = UpdateMetadata {
            release_id: release,
            player_family: "edge".into(),
            architecture: std::env::consts::ARCH.into(),
            version_code: 2000,
            version_name: NEW.into(),
            artifact_size_bytes: archive.len() as u64,
            artifact_sha256: digest.to_hex(),
            artifact_path: format!("/api/v1/player/updates/{release}/artifact"),
            signed_manifest: envelope,
            manifest_signature: signature,
        };
        let host = Arc::new(Host::new(layout.install_root.clone()));
        let cas_dir = dir.path().join("cas");
        let bridge = Bridge {
            host,
            layout,
            store: TransactionStore::new(dir.path().join("helper-state")),
            key: signer.public(),
            cas_root: cas_dir.clone(),
            faults: HelperFaults::default(),
            calls: AtomicU64::new(0),
        };
        Self {
            db_path: dir.path().join("state.db"),
            partial_dir: dir.path().join("partial"),
            cas_dir,
            _dir: dir,
            signer,
            server: Server {
                metadata: Mutex::new(Some(metadata)),
                archive,
                faults: Arc::default(),
                offsets: Arc::default(),
                reports: Mutex::new(vec![]),
            },
            bridge,
            deployment: uuid::Uuid::new_v4(),
            release,
            digest,
            now: AtomicU64::new(1_760_000_000_000),
            mono: AtomicU64::new(0),
            progress: AtomicU64::new(1),
            cas_limit: 1 << 30,
        }
    }

    async fn db(&self) -> StateDb {
        StateDb::open(self.db_path.clone(), OpenOptions::default()).unwrap()
    }

    /// A daemon of `version` starting: a new coordinator on the same files.
    async fn daemon(&self, version: &str) -> Coordinator {
        let db = self.db().await;
        let cas = ContentStore::open(
            self.cas_dir.clone(),
            self.partial_dir.clone(),
            db.clone(),
            system_clock(),
            Arc::new(FixedSpace(1 << 40)),
            StorePolicy { limit_bytes: self.cas_limit, reserved_free_bytes: 0 },
            Arc::new(LruByDomain),
        )
        .await
        .unwrap();
        Coordinator::new(db, cas, self.signer.public(), version)
    }

    fn command(&self, mode: &str) -> edge_server::player_api::ServerCommand {
        let mut payload = serde_json::json!({
            "deploymentId": self.deployment.to_string(), "releaseId": self.release.to_string(),
            "playerFamily": "edge", "expectedVersionCode": 2000, "expectedArtifactSha256": self.digest.to_hex(),
            "installationMode": mode,
        });
        if mode == "maintenance_window" {
            payload["maintenanceWindowStart"] = serde_json::json!(
                edge_protocol::Timestamp::from_unix_millis(self.now_ms() + 3_600_000).unwrap().to_string()
            );
        }
        edge_server::player_api::ServerCommand {
            id: uuid::Uuid::new_v4(),
            command_type: "install_player_update".into(),
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            payload: payload.as_object().cloned().unwrap(),
        }
    }

    async fn accept(&self, mode: &str) {
        let db = self.db().await;
        let result = tilecastd::update::accept(&db, &self.command(mode), 1000, self.now_ms()).await;
        assert_eq!(result.code, "update_accepted", "{}", result.message);
    }

    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst) as i64
    }

    fn advance(&self, duration: Duration) {
        self.now.fetch_add(duration.as_millis() as u64, Ordering::SeqCst);
        self.mono.fetch_add(duration.as_millis() as u64, Ordering::SeqCst);
        self.bridge.host.with(|m| m.boottime += duration.as_millis() as i64);
    }

    fn observe(&self, healthy: bool, playing: bool) -> Observation {
        Observation {
            now_ms: self.now_ms(),
            mono_ms: self.mono.load(Ordering::SeqCst),
            server_connected: healthy,
            takeover_active: false,
            renderer_ready: true,
            safe_mode: false,
            presentation: Some(PresentationFacts {
                source: if playing { "server_manifest" } else { "status_surface" },
                accepted: true,
                evidence: healthy,
                playing,
            }),
            // Content that plays shows fresh progress on every pass.
            last_progress_ms: Some(self.progress.fetch_add(1, Ordering::SeqCst) as i64),
            state_schema: edge_state::latest_schema_version(),
        }
    }

    async fn pass(&self, daemon: &Coordinator, observation: &Observation) -> Pass {
        daemon.pass(Some(&self.server), &self.bridge, observation).await
    }

    /// Passes until `stop` holds or `limit` passes ran, 10 s apart.
    async fn passes(
        &self,
        daemon: &Coordinator,
        limit: usize,
        observe: impl Fn(&Self) -> Observation,
        stop: impl Fn(Pass) -> bool,
    ) -> Pass {
        let mut last = Pass::Idle;
        for _ in 0..limit {
            last = self.pass(daemon, &observe(self)).await;
            if stop(last) {
                break;
            }
            self.advance(Duration::from_secs(10));
        }
        last
    }

    async fn job(&self) -> jobs::UpdateJob {
        let db = self.db().await;
        let deployment = self.deployment;
        db.run(move |c| jobs::get(c, deployment)).await.unwrap().unwrap()
    }

    fn reports(&self) -> Vec<String> {
        self.server.reports.lock().unwrap().iter().map(|(state, _, _)| state.clone()).collect()
    }

    fn last_report(&self) -> Report {
        self.server.reports.lock().unwrap().last().cloned().unwrap()
    }

    fn helper_phase(&self) -> Option<Phase> {
        self.bridge.store.latest().unwrap().map(|t| t.phase)
    }

    fn current(&self) -> String {
        current_version(&self.bridge.layout).unwrap()
    }

    fn pinned(&self) -> bool {
        let connection = rusqlite::Connection::open(&self.db_path).unwrap();
        connection
            .query_row("SELECT count(*) FROM cas_pins WHERE reason = 'update'", [], |r| r.get::<_, i64>(0))
            .unwrap()
            > 0
    }

    /// The old daemon up to the activation it asks for.
    async fn to_activation(&self) {
        let old = self.daemon(OLD).await;
        let pass = self.passes(&old, 20, |w| w.observe(true, true), |p| p == Pass::Waiting("activating")).await;
        assert_eq!(pass, Pass::Waiting("activating"), "{:?}", self.job().await);
        assert_eq!(self.current(), NEW, "the helper switched current");
        assert_eq!(self.bridge.host.with(|m| m.running.clone()).as_deref(), Some(NEW));
    }
}

fn healthy(world: &World) -> Observation {
    world.observe(true, true)
}

// ---- the tests -------------------------------------------------------------

#[tokio::test]
async fn an_update_downloads_stages_activates_and_confirms_after_the_stable_period() {
    let world = World::new();
    world.accept("install_now").await;
    world.to_activation().await;
    assert!(world.pinned(), "the archive stays pinned for the whole transaction");
    assert_eq!(world.helper_phase(), Some(Phase::Provisional));

    // The candidate: not before the stable period, then confirmed.
    let candidate = world.daemon(NEW).await;
    let first = world.pass(&candidate, &healthy(&world)).await;
    assert_eq!(first, Pass::Waiting("stable_period"));
    world.advance(STABLE_PERIOD - Duration::from_secs(10));
    assert_eq!(world.pass(&candidate, &healthy(&world)).await, Pass::Waiting("stable_period"));
    world.advance(Duration::from_secs(10));
    assert_eq!(world.pass(&candidate, &healthy(&world)).await, Pass::Progressed);
    assert_eq!(world.job().await.state, JobState::Confirmed);
    assert_eq!(world.helper_phase(), Some(Phase::Confirmed));
    assert!(!world.pinned(), "the pin ends with the transaction");
    world.pass(&candidate, &healthy(&world)).await;
    assert_eq!(
        world.reports(),
        ["downloading", "downloaded", "ready", "installing", "reconnecting", "succeeded"],
        "the server sees each step once and the explicit confirmation last"
    );
}

#[tokio::test]
async fn a_restart_at_every_pass_boundary_finishes_the_same_update() {
    let world = World::new();
    world.accept("install_now").await;
    // A new daemon process for every pass: every durable state is crossed
    // by a restart, from `accepted` before the download begins to
    // `provisional`.
    for _ in 0..12 {
        let old = world.daemon(OLD).await;
        if world.pass(&old, &healthy(&world)).await == Pass::Waiting("activating") {
            break;
        }
        world.advance(Duration::from_secs(10));
    }
    assert_eq!(world.current(), NEW);
    for _ in 0..20 {
        let candidate = world.daemon(NEW).await;
        world.pass(&candidate, &healthy(&world)).await;
        if world.job().await.state == JobState::Confirmed {
            break;
        }
        world.advance(Duration::from_secs(10));
    }
    // A restarted candidate starts its stable period again: its evidence
    // must come from this process.
    assert_ne!(world.job().await.state, JobState::Confirmed, "every restart resets the stable period");
    let candidate = world.daemon(NEW).await;
    world.passes(&candidate, 20, healthy, |_| false).await;
    assert_eq!(world.job().await.state, JobState::Confirmed);
    assert_eq!(world.helper_phase(), Some(Phase::Confirmed));
}

#[tokio::test]
async fn an_interrupted_download_resumes_where_it_stopped() {
    let world = World::new();
    world.accept("download_only").await;
    let cut = world.server.archive.len() as u64 / 2;
    *world.server.faults.cut_after.lock().unwrap() = Some(cut);
    let old = world.daemon(OLD).await;
    world.pass(&old, &healthy(&world)).await; // verified
    assert_eq!(world.pass(&old, &healthy(&world)).await, Pass::Waiting("download_failed"));
    assert_eq!(old.progress(&world.job().await).await, cut, "the partial is kept");
    // A restart in the middle of the download, then the retry.
    let old = world.daemon(OLD).await;
    world.advance(Duration::from_secs(120));
    world.passes(&old, 10, healthy, |_| false).await;
    assert_eq!(world.job().await.state, JobState::StagedOnly);
    let offsets = world.server.offsets.lock().unwrap().clone();
    assert_eq!(offsets, vec![0, cut], "the second request resumed at the cut");
    assert_eq!(world.current(), OLD, "download-only never activates");
    assert_eq!(world.last_report().0, "ready");
    assert!(!world.pinned());
}

#[tokio::test]
async fn a_bad_outer_signature_is_refused_before_any_byte_is_downloaded() {
    let world = World::new();
    let mut metadata = world.server.metadata.lock().unwrap().clone().unwrap();
    metadata.manifest_signature = Signer::new().signature(&metadata.signed_manifest);
    *world.server.metadata.lock().unwrap() = Some(metadata);
    world.accept("install_now").await;
    let old = world.daemon(OLD).await;
    world.passes(&old, 3, healthy, |_| false).await;
    let job = world.job().await;
    assert_eq!((job.state, job.reason_code.as_deref()), (JobState::Failed, Some("release_signature_invalid")));
    assert!(world.server.offsets.lock().unwrap().is_empty(), "nothing was downloaded");
    assert_eq!(world.last_report(), ("failed".into(), None, Some("release_signature_invalid".into())));
}

#[tokio::test]
async fn a_bad_artifact_digest_never_enters_the_content_store() {
    let world = World::new();
    let mut wrong = world.server.archive.clone();
    wrong[100] ^= 0xff;
    *world.server.faults.wrong_bytes.lock().unwrap() = Some(wrong);
    world.accept("install_now").await;
    let old = world.daemon(OLD).await;
    world.pass(&old, &healthy(&world)).await;
    assert_eq!(world.pass(&old, &healthy(&world)).await, Pass::Waiting("download_failed"));
    assert!(!world.cas_dir.join("sha256").join(world.digest.fanout()).join(world.digest.to_hex()).exists());
    assert_eq!(world.job().await.state, JobState::Verified, "retried later, never staged");
    // The server repairs its copy: the retry succeeds.
    *world.server.faults.wrong_bytes.lock().unwrap() = None;
    world.advance(Duration::from_secs(120));
    world.passes(&old, 5, healthy, |p| p == Pass::Waiting("activating")).await;
    assert_eq!(world.current(), NEW);
}

#[tokio::test]
async fn a_bad_inner_release_file_is_refused_by_the_helper() {
    let world = World::build(Build { tamper_file: true, ..Build::default() });
    world.accept("install_now").await;
    let old = world.daemon(OLD).await;
    world.passes(&old, 6, healthy, |_| false).await;
    let job = world.job().await;
    assert_eq!((job.state, job.reason_code.as_deref()), (JobState::Failed, Some("release_digest_mismatch")));
    assert_eq!(world.current(), OLD);
    assert!(!world.bridge.layout.version_dir(NEW).exists(), "no partial version is installed");
    assert!(!world.pinned());
}

#[tokio::test]
async fn insufficient_disk_fails_the_update_and_nothing_changes() {
    let mut world = World::new();
    world.cas_limit = world.server.archive.len() as u64 / 2;
    world.accept("install_now").await;
    let old = world.daemon(OLD).await;
    world.passes(&old, 3, healthy, |_| false).await;
    let job = world.job().await;
    assert_eq!((job.state, job.reason_code.as_deref()), (JobState::Failed, Some("insufficient_disk")));
    assert_eq!(world.current(), OLD);
}

#[tokio::test]
async fn a_release_that_cannot_read_this_database_is_refused_before_activation() {
    let world = World::build(Build { state_schema: edge_state::latest_schema_version() - 1, ..Build::default() });
    world.accept("install_now").await;
    let old = world.daemon(OLD).await;
    world.passes(&old, 3, healthy, |_| false).await;
    let job = world.job().await;
    assert_eq!((job.state, job.reason_code.as_deref()), (JobState::Failed, Some("update_schema_incompatible")));
    assert!(world.server.offsets.lock().unwrap().is_empty());
}

#[tokio::test]
async fn activation_waits_for_the_window_a_takeover_and_the_server_but_staging_does_not() {
    let world = World::new();
    world.accept("maintenance_window").await;
    let old = world.daemon(OLD).await;
    let pass = world.passes(&old, 6, healthy, |p| p == Pass::Waiting("maintenance_window")).await;
    assert_eq!(pass, Pass::Waiting("maintenance_window"));
    assert_eq!(world.job().await.state, JobState::Staged, "staged in advance");
    world.advance(Duration::from_secs(3_600));
    let mut takeover = healthy(&world);
    takeover.takeover_active = true;
    assert_eq!(world.pass(&old, &takeover).await, Pass::Waiting("takeover_active"));
    assert_eq!(world.pass(&old, &world.observe(false, true)).await, Pass::Waiting("server_not_connected"));
    assert_eq!(world.current(), OLD);
    assert_eq!(world.pass(&old, &healthy(&world)).await, Pass::Waiting("activating"));
    assert_eq!(world.current(), NEW);
}

#[tokio::test]
async fn a_crash_immediately_before_activation_asks_again_and_never_twice() {
    let world = World::new();
    world.accept("install_now").await;
    world.bridge.faults.drop_activation.store(true, Ordering::SeqCst);
    let old = world.daemon(OLD).await;
    world.passes(&old, 6, healthy, |p| p == Pass::Waiting("activating")).await;
    assert_eq!(world.job().await.state, JobState::Activating);
    assert_eq!(world.current(), OLD, "the request never reached the helper");
    // After a restart the job finds no transaction for its release, goes back
    // to staged, and asks once more.
    let old = world.daemon(OLD).await;
    world.pass(&old, &healthy(&world)).await;
    assert_eq!(world.job().await.state, JobState::Staged);
    world.pass(&old, &healthy(&world)).await;
    assert_eq!(world.current(), NEW);
    // The activation that did happen is never asked for again.
    let before = world.bridge.store.latest().unwrap().unwrap().transaction_id;
    world.pass(&old, &healthy(&world)).await;
    assert_eq!(world.bridge.store.latest().unwrap().unwrap().transaction_id, before);
}

#[tokio::test]
async fn a_candidate_that_never_reconnects_or_proves_nothing_is_rolled_back_by_the_guard() {
    for (observation, waiting) in [((false, true), "server_not_connected"), ((true, true), "no_playback_evidence")] {
        let world = World::new();
        world.accept("install_now").await;
        world.to_activation().await;
        let candidate = world.daemon(NEW).await;
        let observe = |w: &World| {
            let mut o = w.observe(observation.0, observation.1);
            if waiting == "no_playback_evidence" {
                o.presentation.as_mut().unwrap().evidence = false;
            }
            o
        };
        for _ in 0..59 {
            assert_eq!(world.pass(&candidate, &observe(&world)).await, Pass::Waiting(waiting));
            world.advance(Duration::from_secs(10));
            world.bridge.guard().await;
        }
        world.advance(Duration::from_secs(20));
        world.bridge.guard().await;
        assert_eq!(world.helper_phase(), Some(Phase::RolledBack), "the deadline, not the candidate, decides");
        assert_eq!(world.current(), OLD);
        // The previous daemon runs again and reports the rollback.
        let old = world.daemon(OLD).await;
        world.pass(&old, &healthy(&world)).await;
        let job = world.job().await;
        assert_eq!((job.state, job.reason_code.as_deref()), (JobState::RolledBack, Some("confirmation_timeout")));
        assert_eq!(
            world.last_report(),
            ("failed".into(), Some("rolled_back".into()), Some("confirmation_timeout".into()))
        );
        assert!(!world.pinned());
    }
}

#[tokio::test]
async fn a_candidate_in_safe_mode_asks_for_its_own_rollback() {
    let world = World::new();
    world.accept("install_now").await;
    world.to_activation().await;
    let candidate = world.daemon(NEW).await;
    let mut unsafe_screen = healthy(&world);
    unsafe_screen.safe_mode = true;
    assert_eq!(world.pass(&candidate, &unsafe_screen).await, Pass::Waiting("rolling_back"));
    assert_eq!(world.helper_phase(), Some(Phase::RolledBack));
    let old = world.daemon(OLD).await;
    world.pass(&old, &healthy(&world)).await;
    assert_eq!(world.job().await.reason_code.as_deref(), Some("candidate_safe_mode"));
}

#[tokio::test]
async fn content_that_plays_must_show_fresh_progress_and_a_resting_screen_confirms_on_its_surface() {
    let world = World::new();
    world.accept("install_now").await;
    world.to_activation().await;
    let candidate = world.daemon(NEW).await;
    // Playing, but the renderer's progress never moves: a frozen screen.
    let frozen = |w: &World| {
        let mut o = w.observe(true, true);
        o.last_progress_ms = Some(42);
        o
    };
    let pass = world.passes(&candidate, 14, frozen, |_| false).await;
    assert_eq!(pass, Pass::Waiting("no_fresh_progress"));
    assert_eq!(world.job().await.state, JobState::Provisional);

    // A screen with nothing to play (asleep, disabled, unassigned) shows its
    // status surface with evidence: that is enough, without progress.
    let world = World::new();
    world.accept("install_now").await;
    world.to_activation().await;
    let candidate = world.daemon(NEW).await;
    let resting = |w: &World| {
        let mut o = w.observe(true, false);
        o.last_progress_ms = None;
        o
    };
    world.passes(&candidate, 14, resting, |_| false).await;
    assert_eq!(world.job().await.state, JobState::Confirmed);
}

#[tokio::test]
async fn a_lost_confirmation_answer_and_a_crash_during_confirmation_still_confirm_once() {
    let world = World::new();
    world.accept("install_now").await;
    world.to_activation().await;
    *world.bridge.faults.lose_answer_to.lock().unwrap() = Some("confirm");
    let candidate = world.daemon(NEW).await;
    let pass = world.passes(&candidate, 14, healthy, |p| p == Pass::Waiting("update_helper_unavailable")).await;
    assert_eq!(pass, Pass::Waiting("update_helper_unavailable"));
    assert_eq!(world.helper_phase(), Some(Phase::Confirmed), "the helper confirmed; the answer was lost");
    world.pass(&candidate, &healthy(&world)).await;
    assert_eq!(world.job().await.state, JobState::Confirmed);

    let world = World::new();
    world.accept("install_now").await;
    world.to_activation().await;
    *world.bridge.faults.crash_at.lock().unwrap() = Some(CrashPoint::AfterConfirmIntent);
    let candidate = world.daemon(NEW).await;
    world.passes(&candidate, 14, healthy, |p| p == Pass::Waiting("update_helper_refused")).await;
    *world.bridge.faults.crash_at.lock().unwrap() = None;
    assert_eq!(world.bridge.store.load().unwrap().unwrap().phase, Phase::ConfirmIntent);
    world.bridge.guard().await;
    world.pass(&candidate, &healthy(&world)).await;
    assert_eq!(world.job().await.state, JobState::Confirmed);
    assert_eq!(world.current(), NEW);
}

#[tokio::test]
async fn a_previous_release_that_refuses_the_newer_schema_is_reported_as_such() {
    let world = World::new();
    world.accept("install_now").await;
    world.to_activation().await;
    world.bridge.host.with(|m| m.behavior.insert(OLD.into(), Behavior::NewerSchemaRefused));
    let candidate = world.daemon(NEW).await;
    let mut unsafe_screen = healthy(&world);
    unsafe_screen.safe_mode = true;
    world.pass(&candidate, &unsafe_screen).await;
    let transaction = world.bridge.store.latest().unwrap().unwrap();
    assert!(transaction.schema_incompatible, "the helper recorded the refusal");
    // The previous daemon is in recovery mode and runs no coordinator; its
    // database was never changed. The helper status says why.
    let status = world.bridge.updater().status();
    assert!(status.transaction.unwrap().schema_incompatible);
}

#[tokio::test]
async fn a_deployment_cancelled_before_activation_is_abandoned() {
    let world = World::new();
    world.accept("install_now").await;
    let old = world.daemon(OLD).await;
    world.pass(&old, &healthy(&world)).await;
    world.server.faults.closed.store(true, Ordering::SeqCst);
    world.pass(&old, &healthy(&world)).await;
    let job = world.job().await;
    assert_eq!((job.state, job.reason_code.as_deref()), (JobState::Cancelled, Some("deployment_closed")));
    assert!(!world.pinned());
    assert_eq!(world.current(), OLD);
}

#[tokio::test]
async fn the_command_handler_only_records_a_job() {
    let world = World::new();
    let db = world.db().await;
    let command = world.command("install_now");
    let result = tilecastd::update::accept(&db, &command, 1000, world.now_ms()).await;
    assert_eq!((result.success, result.code.as_str()), (true, "update_accepted"));
    assert_eq!(world.job().await.state, JobState::Accepted);
    assert!(world.server.offsets.lock().unwrap().is_empty());
    assert_eq!(world.bridge.calls.load(Ordering::SeqCst), 0, "no helper call from the handler");
    // The same deployment again: the same job.
    let again = tilecastd::update::accept(&db, &world.command("install_now"), 1000, world.now_ms()).await;
    assert_eq!(again.code, "update_accepted");
    let count: i64 = rusqlite::Connection::open(&world.db_path)
        .unwrap()
        .query_row("SELECT count(*) FROM update_jobs", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    // Already running this version or newer.
    let current = tilecastd::update::accept(&db, &command, 2000, world.now_ms()).await;
    assert_eq!(current.code, "update_not_needed");
}
