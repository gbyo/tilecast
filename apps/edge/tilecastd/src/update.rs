//! Player updates (M10; docs/tilecast-edge.md §15).
//!
//! The server's `install_player_update` command is answered at once: the
//! handler validates the bounded payload, checks that the deployment is for
//! Tilecast Edge and newer than this build, writes a durable job
//! (`edge_state::repo::updates`) and returns `update_accepted`. Everything
//! after that belongs to the [`Coordinator`], one step per pass, each step
//! saved before it acts:
//!
//! | Job state     | The pass                                                                 |
//! | ------------- | ------------------------------------------------------------------------ |
//! | `accepted`    | fetches the metadata and verifies the signed envelope against it and the command |
//! | `verified`    | pins the archive digest and downloads it into the content store (resumable) |
//! | `downloaded`  | asks `tilecast-edge-update` to stage it                                  |
//! | `staged`      | download-only ends here; otherwise waits for the maintenance window, the end of a takeover, and a live server link, then writes `activating` and asks for activation |
//! | `activating`, `provisional` | follows the helper's transaction; as the candidate, confirms after a stable period of real evidence |
//!
//! `tilecastd` never installs, never runs a program and never replaces its
//! own binaries: the root helper does that, from the verified content-store
//! object, and a guard that does not depend on this daemon rolls back a
//! candidate that never confirms. The server reports are durable too: a
//! restart resends what the server has not accepted.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use edge_cas::{BlobSource, ContentStore, FetchError, FetchRequest, Fetcher, IngestMeta};
use edge_protocol::Sha256Digest;
use edge_release::protocol::{HelperRequest, HelperResponse, HelperStatus, MAX_FRAME_BYTES, Phase};
use edge_server::client::ServerError;
use edge_server::player_api::ServerCommand;
use edge_server::updates::{UpdateMetadata, UpdateReport, UpdateReportOutcome};
use edge_state::StateDb;
use edge_state::repo::cas::{Domain, PinReason, SourceKind};
use edge_state::repo::commands::CommandResult;
use edge_state::repo::updates::{self, JobState, Mode, NewJob, UpdateJob};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _};

/// How long every confirmation condition must hold without a break: the
/// Player Updates settle threshold (`devices.SettledUptimeSeconds`).
pub const STABLE_PERIOD: Duration = Duration::from_secs(120);
pub const PASS_INTERVAL: Duration = Duration::from_secs(10);
/// A server contact older than this does not count as a live relationship.
const FRESH_CONTACT_MS: i64 = 120_000;
const STAGE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const HELPER_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ATTEMPTS: u32 = 12;

/// This build's version code, by the release build's formula.
pub fn own_version_code() -> u64 {
    edge_release::manifest::version_code(crate::daemon::VERSION).unwrap_or(0)
}

// ---- command ----------------------------------------------------------------

fn uuid_field(payload: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<uuid::Uuid> {
    payload.get(key).and_then(serde_json::Value::as_str).and_then(|value| uuid::Uuid::parse_str(value).ok())
}

/// Validates an `install_player_update` payload into a job. The server's
/// payload (`updateCommandPayload`): `deploymentId`, `releaseId`,
/// `playerFamily`, `expectedVersionCode`, `expectedArtifactSha256`,
/// `installationMode` and an optional `maintenanceWindowStart`.
pub fn parse_command(command: &ServerCommand) -> Result<NewJob, CommandResult> {
    let payload = &command.payload;
    let invalid = || CommandResult::failed("update_payload_invalid", "The update command payload is invalid.");
    if let Some(family) = payload.get("playerFamily")
        && family.as_str() != Some(edge_release::envelope::PLAYER_FAMILY)
    {
        return Err(CommandResult::failed(
            "update_wrong_family",
            "This release is not a Tilecast Edge release and cannot be installed here.",
        ));
    }
    let deployment_id = uuid_field(payload, "deploymentId").ok_or_else(invalid)?;
    let release_id = uuid_field(payload, "releaseId").ok_or_else(invalid)?;
    let expected_version_code = payload
        .get("expectedVersionCode")
        .and_then(serde_json::Value::as_u64)
        .filter(|code| *code > 0 && *code < 1_000_000_000_000)
        .ok_or_else(invalid)?;
    let expected_artifact = payload
        .get("expectedArtifactSha256")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| Sha256Digest::parse(value).ok())
        .ok_or_else(invalid)?;
    let mode = payload
        .get("installationMode")
        .and_then(serde_json::Value::as_str)
        .and_then(Mode::parse)
        .ok_or_else(invalid)?;
    let window_start_ms = match payload.get("maintenanceWindowStart") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(text)) if text.len() <= 64 => {
            Some(edge_protocol::Timestamp::parse(text).map_err(|_| invalid())?.unix_millis())
        }
        Some(_) => return Err(invalid()),
    };
    if mode == Mode::MaintenanceWindow && window_start_ms.is_none() {
        return Err(invalid());
    }
    Ok(NewJob {
        deployment_id,
        release_id,
        command_id: command.id,
        expected_version_code,
        expected_artifact,
        mode,
        window_start_ms,
    })
}

/// The command handler: records the job and returns. It never downloads,
/// installs or waits.
pub async fn accept(db: &StateDb, command: &ServerCommand, own_code: u64, now_ms: i64) -> CommandResult {
    let job = match parse_command(command) {
        Ok(job) => job,
        Err(result) => return result,
    };
    if job.expected_version_code <= own_code {
        return CommandResult::ok("update_not_needed", "This screen already runs this release or a newer one.");
    }
    match db.run(move |c| updates::accept(c, &job, now_ms)).await {
        Ok(outcome) => {
            tracing::info!(component = "update", event = "accepted", outcome = ?outcome);
            CommandResult::ok("update_accepted", "The update is accepted and runs in the background.")
        }
        Err(error) => CommandResult::failed("state_unavailable", error.reason_code()),
    }
}

// ---- the coordinator's world ----------------------------------------------

/// The server side of an update: the ordinary Player update endpoints.
#[async_trait]
pub trait UpdateApi: Send + Sync {
    async fn metadata(&self, release: uuid::Uuid) -> Result<UpdateMetadata, ServerError>;
    fn artifact(&self, release: uuid::Uuid) -> Option<Arc<dyn BlobSource>>;
    async fn report(&self, deployment: uuid::Uuid, report: &UpdateReport) -> Result<UpdateReportOutcome, ServerError>;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HelperError {
    #[error("the update helper is not available")]
    Unavailable,
    #[error("the update helper did not answer in time")]
    Timeout,
    #[error("the update helper answered something else")]
    Protocol,
}

/// `tilecast-edge-update`.
#[async_trait]
pub trait Helper: Send + Sync {
    async fn call(&self, request: HelperRequest, timeout: Duration) -> Result<HelperResponse, HelperError>;
}

/// What the screen shows, for the confirmation rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentationFacts {
    /// `ActivationSource::as_token`.
    pub source: &'static str,
    pub accepted: bool,
    pub evidence: bool,
    /// A server presentation with content, which must show fresh progress.
    pub playing: bool,
}

/// One pass's view of the daemon. Production builds it from the daemon
/// context; tests script it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    /// The corrected wall clock, for the maintenance window.
    pub now_ms: i64,
    /// Monotonic milliseconds since this daemon started, for the stable period.
    pub mono_ms: u64,
    /// The authenticated server relationship is up now, with contact since
    /// this daemon started.
    pub server_connected: bool,
    pub takeover_active: bool,
    pub renderer_ready: bool,
    pub safe_mode: bool,
    pub presentation: Option<PresentationFacts>,
    pub last_progress_ms: Option<i64>,
    /// The state database schema this build opened.
    pub state_schema: u32,
}

/// Why a pass stopped where it did. The latest one is shown in status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pass {
    Idle,
    Progressed,
    Waiting(&'static str),
}

#[derive(Debug, Default)]
struct StableWindow {
    since_mono: Option<u64>,
    progress_at_start: Option<i64>,
}

pub struct Coordinator {
    db: StateDb,
    fetcher: Fetcher,
    key: [u8; 32],
    own_version: String,
    own_code: u64,
    window: std::sync::Mutex<StableWindow>,
    last: std::sync::Mutex<Pass>,
}

impl std::fmt::Debug for Coordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Coordinator").field("own_version", &self.own_version).finish_non_exhaustive()
    }
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

impl Coordinator {
    pub fn new(db: StateDb, cas: ContentStore, key: [u8; 32], own_version: &str) -> Self {
        Self {
            db,
            fetcher: Fetcher::new(cas, 1).with_idle_timeout(Duration::from_secs(60)),
            key,
            own_code: edge_release::manifest::version_code(own_version).unwrap_or(0),
            own_version: own_version.to_owned(),
            window: Default::default(),
            last: std::sync::Mutex::new(Pass::Idle),
        }
    }

    pub fn last_pass(&self) -> Pass {
        *self.last.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cas(&self) -> &ContentStore {
        self.fetcher.store()
    }

    async fn save(&self, job: &UpdateJob, now_ms: i64) -> Result<(), edge_state::StateError> {
        let job = job.clone();
        self.db.run(move |c| updates::save(c, &job, now_ms)).await
    }

    async fn transition(&self, job: &mut UpdateJob, state: JobState, reason: Option<&str>, now_ms: i64) -> Pass {
        job.state = state;
        job.reason_code = reason.map(str::to_owned);
        job.attempts = 0;
        job.next_attempt_at_ms = None;
        tracing::info!(component = "update", event = "state", state = state.as_str(), reason = reason.unwrap_or(""));
        if state.is_terminal() || state == JobState::StagedOnly {
            self.unpin(job).await;
        }
        match self.save(job, now_ms).await {
            Ok(()) => Pass::Progressed,
            Err(_) => Pass::Waiting("state_unavailable"),
        }
    }

    async fn fail(&self, job: &mut UpdateJob, reason: &str, now_ms: i64) -> Pass {
        tracing::warn!(component = "update", event = "failed", reason);
        self.transition(job, JobState::Failed, Some(reason), now_ms).await;
        Pass::Waiting("failed")
    }

    /// A transient problem: try again later, doubling from 30 s to 30 min,
    /// and give up after [`MAX_ATTEMPTS`].
    async fn retry(&self, job: &mut UpdateJob, reason: &'static str, now_ms: i64) -> Pass {
        job.attempts = job.attempts.saturating_add(1);
        if job.attempts > MAX_ATTEMPTS {
            return self.fail(job, reason, now_ms).await;
        }
        let delay = (30_000i64 << job.attempts.min(6)).min(30 * 60_000);
        job.next_attempt_at_ms = Some(now_ms + delay);
        job.reason_code = Some(reason.to_owned());
        let _ = self.save(job, now_ms).await;
        Pass::Waiting(reason)
    }

    async fn unpin(&self, job: &UpdateJob) {
        let _ = self.cas().replace_pins(PinReason::Update, &job.pin_holder(), vec![]).await;
    }

    /// One pass over the active job, then the reports the server still needs.
    pub async fn pass(&self, api: Option<&dyn UpdateApi>, helper: &dyn Helper, observation: &Observation) -> Pass {
        let outcome = self.work(api, helper, observation).await;
        if let Some(api) = api {
            self.report_all(api, observation).await;
        }
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = outcome;
        outcome
    }

    async fn work(&self, api: Option<&dyn UpdateApi>, helper: &dyn Helper, observation: &Observation) -> Pass {
        let Ok(Some(mut job)) = self.db.run(|c| updates::active(c)).await else { return Pass::Idle };
        let now = observation.now_ms;
        if job.state.is_activated() {
            return self.follow(&mut job, helper, observation).await;
        }
        if job.next_attempt_at_ms.is_some_and(|at| at > now) {
            return Pass::Waiting("retry_later");
        }
        match job.state {
            JobState::Accepted => match api {
                Some(api) => self.verify(&mut job, api, observation).await,
                None => Pass::Waiting("server_not_connected"),
            },
            JobState::Verified => match api {
                Some(api) => self.download(&mut job, api, now).await,
                None => Pass::Waiting("server_not_connected"),
            },
            JobState::Downloaded => self.stage(&mut job, helper, now).await,
            JobState::Staged => {
                if job.mode == Mode::DownloadOnly {
                    return self.transition(&mut job, JobState::StagedOnly, None, now).await;
                }
                self.activate(&mut job, api, helper, observation).await
            }
            _ => Pass::Idle,
        }
    }

    // ---- verify ---------------------------------------------------------

    async fn verify(&self, job: &mut UpdateJob, api: &dyn UpdateApi, observation: &Observation) -> Pass {
        let now = observation.now_ms;
        let metadata = match api.metadata(job.release_id).await {
            Ok(metadata) => metadata,
            Err(ServerError::Api { status: 404 | 410, .. }) => return self.fail(job, "update_unavailable", now).await,
            Err(ServerError::Decode) => return self.fail(job, "update_metadata_invalid", now).await,
            Err(error) if error.is_transient() => return self.retry(job, "server_unreachable", now).await,
            Err(_) => return self.fail(job, "update_metadata_unavailable", now).await,
        };
        if metadata.release_id != job.release_id || metadata.player_family != edge_release::envelope::PLAYER_FAMILY {
            return self.fail(job, "update_wrong_family", now).await;
        }
        if metadata.architecture != std::env::consts::ARCH {
            return self.fail(job, "release_wrong_architecture", now).await;
        }
        let verified =
            match edge_release::verify_envelope(&metadata.signed_manifest, &metadata.manifest_signature, &self.key)
                .and_then(|verified| verified.check_host().map(|()| verified))
            {
                Ok(verified) => verified,
                Err(error) => return self.fail(job, error.reason_code(), now).await,
            };
        let envelope = &verified.envelope;
        let consistent = envelope.version_code == job.expected_version_code
            && envelope.version_code == metadata.version_code
            && envelope.version_name == metadata.version_name
            && verified.artifact == job.expected_artifact
            && envelope.artifact_sha256 == metadata.artifact_sha256
            && envelope.artifact_size_bytes == metadata.artifact_size_bytes;
        if !consistent {
            return self.fail(job, "update_metadata_mismatch", now).await;
        }
        if envelope.version_code <= self.own_code {
            return self.fail(job, "update_not_newer", now).await;
        }
        // A release whose daemon knows an older schema than this database
        // would refuse it after activation (docs/tilecast-edge.md §6.1):
        // refuse the release now, before anything changes.
        if envelope.state_schema_version < observation.state_schema {
            return self.fail(job, "update_schema_incompatible", now).await;
        }
        job.version_name = Some(envelope.version_name.clone());
        job.artifact_size_bytes = Some(envelope.artifact_size_bytes);
        job.envelope = Some(verified.envelope_bytes.clone());
        job.envelope_signature = Some(verified.signature_bytes.clone());
        self.transition(job, JobState::Verified, None, now).await
    }

    // ---- download -------------------------------------------------------

    async fn download(&self, job: &mut UpdateJob, api: &dyn UpdateApi, now: i64) -> Pass {
        let Some(size) = job.artifact_size_bytes else { return self.fail(job, "update_state_invalid", now).await };
        let digest = job.expected_artifact;
        // Pinned before the first byte, so the verified object can never be
        // evicted between its commit and the helper's copy.
        if self.cas().replace_pins(PinReason::Update, &job.pin_holder(), vec![digest]).await.is_err() {
            return Pass::Waiting("state_unavailable");
        }
        let Some(source) = api.artifact(job.release_id) else {
            return self.fail(job, "update_artifact_path_invalid", now).await;
        };
        let request = FetchRequest {
            digest,
            size_bytes: size,
            meta: IngestMeta { domain: Domain::Update, content_type: None, source: SourceKind::Origin },
        };
        let fetched = self.fetcher.fetch(&request, &[source], None).await;
        match fetched {
            Ok(_) => {
                job.downloaded_bytes = size;
                self.transition(job, JobState::Downloaded, None, now).await
            }
            Err(FetchError::Store(edge_cas::CasError::InsufficientSpace { .. } | edge_cas::CasError::OverLimit)) => {
                self.fail(job, "insufficient_disk", now).await
            }
            Err(FetchError::Store(_)) => self.retry(job, "state_unavailable", now).await,
            Err(FetchError::Exhausted) => self.retry(job, "download_failed", now).await,
        }
    }

    /// Bytes downloaded so far, from the resumable partial.
    pub async fn progress(&self, job: &UpdateJob) -> u64 {
        if job.state != JobState::Verified {
            return job.downloaded_bytes;
        }
        let digest = job.expected_artifact;
        self.db
            .run(move |c| edge_state::repo::cas::get_partial(c, &digest))
            .await
            .ok()
            .flatten()
            .map_or(0, |partial| partial.bytes_present)
    }

    // ---- stage ----------------------------------------------------------

    async fn stage(&self, job: &mut UpdateJob, helper: &dyn Helper, now: i64) -> Pass {
        let (Some(envelope), Some(signature)) = (job.envelope.clone(), job.envelope_signature.clone()) else {
            return self.fail(job, "update_state_invalid", now).await;
        };
        // The object must still be here and intact: the helper copies it.
        match self.cas().verify(&job.expected_artifact).await {
            Ok(edge_cas::store::VerifyOutcome::Verified) => {}
            Ok(_) => {
                job.downloaded_bytes = 0;
                return self.transition(job, JobState::Verified, Some("artifact_redownload"), now).await;
            }
            Err(_) => return self.retry(job, "state_unavailable", now).await,
        }
        let request = HelperRequest::Stage {
            artifact_sha256: job.expected_artifact.to_hex(),
            envelope: b64(&envelope),
            signature: b64(&signature),
        };
        match helper.call(request, STAGE_TIMEOUT).await {
            Ok(response) if response.ok => self.transition(job, JobState::Staged, None, now).await,
            Ok(response) => match response.code.as_str() {
                "update_busy" => self.retry(job, "update_helper_busy", now).await,
                "artifact_not_downloaded" | "artifact_digest_mismatch" => {
                    let _ = self.cas().verify(&job.expected_artifact).await;
                    self.retry(job, "artifact_redownload", now).await
                }
                code => {
                    let code = safe_code(code);
                    self.fail(job, code, now).await
                }
            },
            Err(_) => self.retry(job, "update_helper_unavailable", now).await,
        }
    }

    // ---- activate -------------------------------------------------------

    async fn activate(
        &self,
        job: &mut UpdateJob,
        api: Option<&dyn UpdateApi>,
        helper: &dyn Helper,
        observation: &Observation,
    ) -> Pass {
        let now = observation.now_ms;
        if job.window_start_ms.is_some_and(|start| now < start) {
            return Pass::Waiting("maintenance_window");
        }
        if observation.takeover_active {
            return Pass::Waiting("takeover_active");
        }
        // A screen that cannot reach the server now would start a candidate
        // that cannot confirm.
        if !observation.server_connected {
            return Pass::Waiting("server_not_connected");
        }
        match helper.call(HelperRequest::Status {}, HELPER_TIMEOUT).await {
            Ok(response) => {
                if response.status.as_ref().and_then(|s| s.transaction.as_ref()).is_some_and(|t| !t.phase.is_terminal())
                {
                    return Pass::Waiting("update_helper_busy");
                }
            }
            Err(_) => return self.retry(job, "update_helper_unavailable", now).await,
        }
        let Some(version) = job.version_name.clone() else {
            return self.fail(job, "update_state_invalid", now).await;
        };
        // Durable before the request: after a restart the job follows the
        // helper's transaction instead of asking again.
        job.activation_requested_at_ms = Some(now);
        self.transition(job, JobState::Activating, None, now).await;
        if let Some(api) = api {
            // The daemon stops during activation: tell the server first.
            let report = UpdateReport {
                state: "installing",
                downloaded_bytes: job.downloaded_bytes,
                installer_status: None,
                error: None,
            };
            if let Ok(Ok(UpdateReportOutcome::Accepted)) =
                tokio::time::timeout(Duration::from_secs(10), api.report(job.deployment_id, &report)).await
            {
                job.reported_state = Some(JobState::Activating.as_str().to_owned());
                let _ = self.save(job, now).await;
            }
        }
        match helper.call(HelperRequest::Activate { version_name: version }, HELPER_TIMEOUT).await {
            Ok(response) if response.ok => Pass::Waiting("activating"),
            Ok(response) => match response.code.as_str() {
                "transaction_open" | "update_busy" => {
                    self.transition(job, JobState::Staged, Some("update_helper_busy"), now).await;
                    Pass::Waiting("update_helper_busy")
                }
                "release_not_staged" | "installed_release_corrupt" => {
                    self.transition(job, JobState::Downloaded, Some("restage"), now).await
                }
                code => {
                    let code = safe_code(code);
                    self.fail(job, code, now).await
                }
            },
            // The answer may have been lost after the helper started: the
            // next pass follows its transaction.
            Err(_) => Pass::Waiting("activating"),
        }
    }

    // ---- follow and confirm ---------------------------------------------

    async fn follow(&self, job: &mut UpdateJob, helper: &dyn Helper, observation: &Observation) -> Pass {
        let now = observation.now_ms;
        let Some(version) = job.version_name.clone() else {
            return self.fail(job, "update_state_invalid", now).await;
        };
        let status: HelperStatus = match helper.call(HelperRequest::Status {}, HELPER_TIMEOUT).await {
            Ok(HelperResponse { status: Some(status), .. }) => status,
            _ => return Pass::Waiting("update_helper_unavailable"),
        };
        let candidate = self.own_version == version;
        let transaction = status.transaction.filter(|t| t.candidate.version_name == version);
        let Some(transaction) = transaction else {
            if candidate && status.current.as_ref().is_some_and(|c| c.version_name == version) {
                // Confirmed long ago and archived by a later transaction.
                return self.transition(job, JobState::Confirmed, None, now).await;
            }
            // The activation never reached the helper.
            return self.transition(job, JobState::Staged, Some("activation_not_started"), now).await;
        };
        match transaction.phase {
            Phase::Confirmed => {
                let reason = if candidate { None } else { Some("confirmed_elsewhere") };
                self.transition(job, JobState::Confirmed, reason, now).await
            }
            Phase::RolledBack => {
                let reason = if transaction.schema_incompatible {
                    "rollback_schema_incompatible".to_owned()
                } else {
                    transaction.reason.clone().unwrap_or_else(|| "rolled_back".to_owned())
                };
                let reason = safe_code(&reason);
                tracing::warn!(component = "update", event = "rolled_back", reason);
                self.transition(job, JobState::RolledBack, Some(reason), now).await
            }
            Phase::ActivateIntent | Phase::RollbackIntent => Pass::Waiting("activating"),
            Phase::Provisional | Phase::ConfirmIntent if !candidate => Pass::Waiting("activating"),
            Phase::Provisional | Phase::ConfirmIntent => {
                if job.state != JobState::Provisional {
                    self.transition(job, JobState::Provisional, None, now).await;
                }
                self.confirm_when_proven(job, helper, observation, &version).await
            }
        }
    }

    /// The confirmation rules (docs/tilecast-edge.md §15): this candidate
    /// runs; its server relationship is up again; the renderer is ready and
    /// not in safe mode; the current presentation was accepted with
    /// meaningful evidence from this process (fresh progress for content
    /// that plays; the right status surface for a screen that sleeps, is
    /// disabled or has nothing assigned); all of that for
    /// [`STABLE_PERIOD`] without a break. The helper's own deadline, not
    /// this daemon, rolls back a candidate that never gets there.
    async fn confirm_when_proven(
        &self,
        job: &mut UpdateJob,
        helper: &dyn Helper,
        observation: &Observation,
        version: &str,
    ) -> Pass {
        if observation.safe_mode {
            let _ = helper.call(HelperRequest::Rollback { reason: "candidate_safe_mode".into() }, HELPER_TIMEOUT).await;
            return Pass::Waiting("rolling_back");
        }
        // The window is decided under its lock, which is never held across
        // an await.
        let wait = {
            let mut window = self.window.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(reason) = unmet_condition(observation) {
                *window = StableWindow::default();
                Some(reason)
            } else {
                let since = *window.since_mono.get_or_insert(observation.mono_ms);
                if since == observation.mono_ms {
                    window.progress_at_start = observation.last_progress_ms;
                }
                let elapsed = observation.mono_ms.saturating_sub(since) >= STABLE_PERIOD.as_millis() as u64;
                let playing = observation.presentation.as_ref().is_some_and(|p| p.playing);
                if playing && observation.last_progress_ms == window.progress_at_start {
                    Some(if elapsed { "no_fresh_progress" } else { "stable_period" })
                } else if !elapsed {
                    Some("stable_period")
                } else {
                    None
                }
            }
        };
        if let Some(reason) = wait {
            return Pass::Waiting(reason);
        }
        match helper.call(HelperRequest::Confirm { version_name: version.to_owned() }, HELPER_TIMEOUT).await {
            Ok(response) if response.ok => {
                tracing::info!(component = "update", event = "confirmed", version);
                self.transition(job, JobState::Confirmed, None, observation.now_ms).await
            }
            Ok(response) => {
                *self.window.lock().unwrap_or_else(|e| e.into_inner()) = StableWindow::default();
                Pass::Waiting(safe_code(&response.code))
            }
            Err(_) => Pass::Waiting("update_helper_unavailable"),
        }
    }

    // ---- reports --------------------------------------------------------

    async fn report_all(&self, api: &dyn UpdateApi, observation: &Observation) {
        let Ok(jobs) = self.db.run(|c| updates::all(c)).await else { return };
        for mut job in jobs {
            if job.report_closed || job.reported_state.as_deref() == Some(job.state.as_str()) {
                if job.state == JobState::Verified {
                    // Download progress is not durable: it is sent every pass.
                    let bytes = self.progress(&job).await;
                    let report = UpdateReport {
                        state: "downloading",
                        downloaded_bytes: bytes,
                        installer_status: None,
                        error: None,
                    };
                    let _ = api.report(job.deployment_id, &report).await;
                }
                continue;
            }
            let Some(report) = report_for(&job, observation.server_connected) else { continue };
            match api.report(job.deployment_id, &report).await {
                Ok(UpdateReportOutcome::Accepted) => {
                    job.reported_state = Some(job.state.as_str().to_owned());
                    let _ = self.save(&job, observation.now_ms).await;
                }
                Ok(UpdateReportOutcome::Closed) => {
                    job.report_closed = true;
                    if !job.state.is_terminal() && !job.state.is_activated() {
                        // Cancelled on the server before anything ran.
                        self.transition(&mut job, JobState::Cancelled, Some("deployment_closed"), observation.now_ms)
                            .await;
                    } else {
                        let _ = self.save(&job, observation.now_ms).await;
                    }
                }
                Err(_) => {}
            }
        }
    }
}

/// The report a job's state owes the server, in the server's vocabulary.
fn report_for(job: &UpdateJob, server_connected: bool) -> Option<UpdateReport> {
    let (state, installer, error) = match job.state {
        JobState::Accepted | JobState::Cancelled => return None,
        JobState::Verified => ("downloading", None, None),
        JobState::Downloaded => ("downloaded", None, None),
        JobState::Staged | JobState::StagedOnly => ("ready", None, None),
        JobState::Activating => ("installing", None, None),
        JobState::Provisional if !server_connected => return None,
        JobState::Provisional => ("reconnecting", Some("provisional"), None),
        JobState::Confirmed => ("succeeded", Some("confirmed"), None),
        JobState::RolledBack => ("failed", Some("rolled_back"), job.reason_code.clone()),
        JobState::Failed => ("failed", None, job.reason_code.clone()),
    };
    Some(UpdateReport {
        state,
        downloaded_bytes: job.downloaded_bytes,
        installer_status: installer.map(str::to_owned),
        error,
    })
}

fn unmet_condition(observation: &Observation) -> Option<&'static str> {
    if !observation.server_connected {
        return Some("server_not_connected");
    }
    if !observation.renderer_ready {
        return Some("renderer_not_ready");
    }
    let Some(presentation) = observation.presentation.as_ref() else { return Some("no_activation") };
    if matches!(presentation.source, "safe_mode" | "fixture") {
        return Some("unexpected_presentation_source");
    }
    if !presentation.accepted {
        return Some("activation_not_accepted");
    }
    if !presentation.evidence {
        return Some("no_playback_evidence");
    }
    None
}

/// A helper or server code as a bounded reason token.
fn safe_code(code: &str) -> &'static str {
    const KNOWN: &[&str] = &[
        "release_signature_invalid",
        "release_manifest_invalid",
        "release_wrong_architecture",
        "release_digest_mismatch",
        "release_file_unavailable",
        "release_archive_mismatch",
        "release_archive_invalid",
        "release_manifest_missing",
        "release_signature_missing",
        "installed_release_corrupt",
        "insufficient_disk",
        "update_not_newer",
        "artifact_mismatch",
        "artifact_owner_invalid",
        "invalid_request",
        "peer_not_allowed",
        "no_current_release",
        "current_release_corrupt",
        "already_current",
        "not_provisional",
        "confirmation_timeout",
        "rebooted_while_provisional",
        "candidate_daemon_restarting",
        "candidate_renderer_restarting",
        "candidate_safe_mode",
        "activation_interrupted",
        "operator_requested",
        "daemon_unreachable",
        "candidate_not_running",
        "server_not_connected",
        "renderer_not_connected",
        "renderer_safe_mode",
        "presentation_incompatible",
        "no_activation",
        "unexpected_presentation_source",
        "activation_not_accepted",
        "no_playback_evidence",
        "rollback_schema_incompatible",
        "previous_release_corrupt",
        "rolled_back",
    ];
    KNOWN.iter().copied().find(|known| *known == code).unwrap_or_else(|| {
        if code.starts_with("activation_failed_") { "activation_failed" } else { "update_helper_refused" }
    })
}

// ---- production ---------------------------------------------------------------

/// The helper's socket client: one request per connection.
#[derive(Debug, Clone)]
pub struct SocketHelper {
    path: PathBuf,
}

impl SocketHelper {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

#[async_trait]
impl Helper for SocketHelper {
    async fn call(&self, request: HelperRequest, timeout: Duration) -> Result<HelperResponse, HelperError> {
        let exchange = async {
            let mut stream = tokio::net::UnixStream::connect(&self.path).await.map_err(|_| HelperError::Unavailable)?;
            let mut line = serde_json::to_vec(&request).map_err(|_| HelperError::Protocol)?;
            line.push(b'\n');
            stream.write_all(&line).await.map_err(|_| HelperError::Unavailable)?;
            let mut reader = tokio::io::BufReader::new(stream.take(MAX_FRAME_BYTES as u64 + 1));
            let mut answer = Vec::new();
            reader.read_until(b'\n', &mut answer).await.map_err(|_| HelperError::Unavailable)?;
            if answer.len() > MAX_FRAME_BYTES || !answer.ends_with(b"\n") {
                return Err(HelperError::Protocol);
            }
            serde_json::from_slice(&answer).map_err(|_| HelperError::Protocol)
        };
        tokio::time::timeout(timeout, exchange).await.map_err(|_| HelperError::Timeout)?
    }
}

/// The ordinary player API through the verified server relationship.
#[derive(Debug, Clone)]
pub struct ServerApi {
    server: edge_server::AuthenticatedServer,
}

#[async_trait]
impl UpdateApi for ServerApi {
    async fn metadata(&self, release: uuid::Uuid) -> Result<UpdateMetadata, ServerError> {
        self.server.player_update_metadata(release).await
    }

    fn artifact(&self, release: uuid::Uuid) -> Option<Arc<dyn BlobSource>> {
        // The path is built here from the release ID, never taken from the
        // server's answer.
        let path = format!("/api/v1/player/updates/{release}/artifact");
        edge_server::origin::OriginBlobSource::new(self.server.clone(), &path)
            .ok()
            .map(|source| Arc::new(source) as Arc<dyn BlobSource>)
    }

    async fn report(&self, deployment: uuid::Uuid, report: &UpdateReport) -> Result<UpdateReportOutcome, ServerError> {
        self.server.report_update_status(deployment, report).await
    }
}

/// What the daemon sees now, for the coordinator.
pub async fn observe(context: &crate::daemon::DaemonContext, started: std::time::Instant) -> Observation {
    let now = context.now();
    let (renderer_ready, safe_mode, presentation, takeover_active, last_progress_ms) = {
        let engine = context.presentation.lock().await;
        let status = engine.status();
        let current = engine.current();
        let facts = engine.presentation_status().map(|p| PresentationFacts {
            source: current.map_or("status_surface", |active| active.source.as_token()),
            accepted: p.accepted,
            evidence: p.evidence,
            playing: current.is_some_and(|active| {
                active.source == crate::presentation::ActivationSource::ServerManifest
                    && matches!(active.document, edge_protocol::ipc::presentation::PresentationDocument::Playing { .. })
            }),
        });
        let takeover = current.and_then(|active| active.identity.as_ref()).is_some_and(|identity| {
            identity.takeover_id.is_some() || matches!(identity.selection_source, "takeover" | "quick_present")
        });
        (
            engine.renderer_is_ready(),
            status.state.as_str() == "safe_mode",
            facts,
            takeover,
            status.last_progress_at.map(|at| at.unix_millis()),
        )
    };
    let connected = context.link_state.lock().unwrap_or_else(|e| e.into_inner()).state_token() == "connected";
    let contact = *context.last_server_contact.lock().unwrap_or_else(|e| e.into_inner());
    let fresh = contact.is_some_and(|at| {
        at >= context.started_at && now.unix_millis().saturating_sub(at.unix_millis()) <= FRESH_CONTACT_MS
    });
    Observation {
        now_ms: now.unix_millis(),
        mono_ms: started.elapsed().as_millis() as u64,
        server_connected: connected && fresh,
        takeover_active,
        renderer_ready,
        safe_mode,
        presentation,
        last_progress_ms,
        state_schema: edge_state::latest_schema_version(),
    }
}

/// The coordinator task.
pub async fn run(context: Arc<crate::daemon::DaemonContext>) {
    let (Some(db), Some(cas)) = (context.db().cloned(), context.cas.clone()) else { return };
    let key = match edge_release::manifest::trusted_key(std::path::Path::new(edge_release::manifest::KEY_OVERRIDE_FILE))
    {
        Ok(key) => key,
        Err(error) => {
            tracing::error!(component = "update", event = "release_key_invalid", error = %error);
            return;
        }
    };
    let coordinator = Arc::new(Coordinator::new(db, cas, key, crate::daemon::VERSION));
    *context.update.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&coordinator));
    let helper = SocketHelper::new(
        context
            .config
            .dev
            .update_helper_socket
            .clone()
            .unwrap_or_else(|| PathBuf::from(edge_release::protocol::DEFAULT_SOCKET)),
    );
    let started = std::time::Instant::now();
    let mut interval = tokio::time::interval(PASS_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = context.shutdown.cancelled() => return,
            _ = interval.tick() => {}
            _ = context.update_wake.notified() => {}
        }
        let server = context.command_server.borrow().clone();
        let api = server.map(|server| ServerApi { server });
        let observation = observe(&context, started).await;
        let _ = coordinator.pass(api.as_ref().map(|a| a as &dyn UpdateApi), &helper, &observation).await;
    }
}

/// The update shown in `tilecastctl status`.
pub async fn status(context: &crate::daemon::DaemonContext) -> Option<edge_protocol::ipc::status::UpdateStatus> {
    use edge_protocol::bounded::{ShortText, ShortToken};
    let db = context.db()?;
    let job = db.run(|c| updates::latest(c)).await.ok().flatten()?;
    let coordinator = context.update.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let (downloaded, waiting) = match &coordinator {
        Some(coordinator) => (
            coordinator.progress(&job).await,
            match coordinator.last_pass() {
                Pass::Waiting(reason) if !job.state.is_terminal() => Some(reason),
                _ => None,
            },
        ),
        None => (job.downloaded_bytes, None),
    };
    Some(edge_protocol::ipc::status::UpdateStatus {
        state: ShortToken::new(job.state.as_str()).ok()?,
        deployment_id: ShortText::lossy(&job.deployment_id.to_string()),
        version_name: job.version_name.as_deref().map(ShortText::lossy),
        installation_mode: ShortToken::new(job.mode.as_str()).ok()?,
        downloaded_bytes: downloaded,
        total_bytes: job.artifact_size_bytes,
        reason_code: job.reason_code.as_deref().and_then(|reason| ShortToken::new(reason).ok()),
        waiting_for: waiting.and_then(|reason| ShortToken::new(reason).ok()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(payload: serde_json::Value) -> ServerCommand {
        ServerCommand {
            id: uuid::Uuid::new_v4(),
            command_type: "install_player_update".into(),
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            payload: payload.as_object().cloned().unwrap_or_default(),
        }
    }

    fn payload() -> serde_json::Value {
        serde_json::json!({
            "deploymentId": "0f6b2f0e-0001-4c55-9a53-27f2f0b2f0aa", "releaseId": "0f6b2f0e-0002-4c55-9a53-27f2f0b2f0aa",
            "playerFamily": "edge", "expectedVersionCode": 2000, "expectedApkSha256": "a".repeat(64),
            "expectedArtifactSha256": "a".repeat(64), "installationMode": "maintenance_window",
            "maintenanceWindowStart": "2026-09-26T02:00:00Z",
        })
    }

    #[test]
    fn a_valid_payload_becomes_a_job() {
        let job = parse_command(&command(payload())).unwrap();
        assert_eq!(job.mode, Mode::MaintenanceWindow);
        assert_eq!(job.expected_version_code, 2000);
        assert!(job.window_start_ms.is_some());
    }

    #[test]
    fn another_family_or_a_malformed_payload_is_refused_before_anything_is_stored() {
        let mut electron = payload();
        electron["playerFamily"] = serde_json::json!("electron-linux");
        assert_eq!(parse_command(&command(electron)).unwrap_err().code, "update_wrong_family");
        for (key, value) in [
            ("deploymentId", serde_json::json!("../../etc")),
            ("expectedArtifactSha256", serde_json::json!("A".repeat(64))),
            ("installationMode", serde_json::json!("reboot_now")),
            ("expectedVersionCode", serde_json::json!(-1)),
            ("maintenanceWindowStart", serde_json::json!(null)),
        ] {
            let mut bad = payload();
            bad[key] = value;
            assert_eq!(parse_command(&command(bad)).unwrap_err().code, "update_payload_invalid", "{key}");
        }
    }

    #[test]
    fn reports_use_the_server_vocabulary() {
        let mut job = UpdateJob {
            deployment_id: uuid::Uuid::nil(),
            release_id: uuid::Uuid::nil(),
            command_id: uuid::Uuid::nil(),
            expected_version_code: 2000,
            expected_artifact: Sha256Digest::of(b"a"),
            mode: Mode::InstallNow,
            window_start_ms: None,
            state: JobState::RolledBack,
            version_name: None,
            artifact_size_bytes: None,
            envelope: None,
            envelope_signature: None,
            downloaded_bytes: 0,
            reason_code: Some("confirmation_timeout".into()),
            reported_state: None,
            report_closed: false,
            attempts: 0,
            next_attempt_at_ms: None,
            activation_requested_at_ms: None,
            created_at_ms: 0,
            updated_at_ms: 0,
        };
        let report = report_for(&job, true).unwrap();
        assert_eq!(
            (report.state, report.installer_status.as_deref(), report.error.as_deref()),
            ("failed", Some("rolled_back"), Some("confirmation_timeout"))
        );
        job.state = JobState::Provisional;
        assert!(report_for(&job, false).is_none(), "reconnecting is reported once the link is back");
        job.state = JobState::Confirmed;
        assert_eq!(report_for(&job, true).unwrap().state, "succeeded");
        assert_eq!(safe_code("anything; else"), "update_helper_refused");
    }
}
