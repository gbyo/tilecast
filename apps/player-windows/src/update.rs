//! Player self-updates: the version-code scheme the heartbeat reports
//! and the server compares, the MSIX package-version mapping, and the
//! download-verify-install coordinator behind `install_player_update`.

/// `MAJOR.MINOR.PATCH` with an optional `-prerelease` of plain
/// characters: the server's envelope version pattern, mirrored exactly
/// so the player refuses what the server refuses.
pub fn is_version_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let core = match value.split_once('-') {
        Some((core, pre)) => {
            if pre.is_empty() || !pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.') {
                return false;
            }
            core
        }
        None => value,
    };
    let mut parts = core.split('.');
    let triple = [parts.next(), parts.next(), parts.next()];
    parts.next().is_none()
        && triple.into_iter().all(|part| {
            part.is_some_and(|digits| {
                !digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit())
            })
        })
}

/// The version code of a `release/VERSION` name, or `None` when it is not
/// a `major.minor.patch` triple in range: `major * 1_000_000 + minor *
/// 1_000 + patch`, ignoring any pre-release suffix.
pub fn version_code(version_name: &str) -> Option<u64> {
    if !is_version_name(version_name) {
        return None;
    }
    let core = version_name.split_once('-').map_or(version_name, |(core, _)| core);
    let mut parts = core.split('.');
    let (major, minor, patch) =
        (parts.next()?.parse::<u64>().ok()?, parts.next()?.parse::<u64>().ok()?, parts.next()?.parse::<u64>().ok()?);
    if parts.next().is_some() || major >= 1_000_000 || minor >= 1_000 || patch >= 1_000 {
        return None;
    }
    Some(major * 1_000_000 + minor * 1_000 + patch)
}

/// This build's version code, or zero when `release/VERSION` is malformed.
pub fn own_version_code() -> u64 {
    version_code(crate::RELEASE_VERSION).unwrap_or(0)
}

/// One MSIX package version: four parts of 0 to 65535, never `0.0.0.0`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct MsixVersion {
    pub major: u16,
    pub minor: u16,
    pub build: u16,
    pub revision: u16,
}

impl std::fmt::Display for MsixVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}.{}", self.major, self.minor, self.build, self.revision)
    }
}

/// The deterministic mapping from a Tilecast release to its MSIX package
/// version: `major.minor.patch.<channel>`, with revision 1 for beta and
/// 2 for stable. The human triple stays readable in the first three
/// parts; the prerelease suffix is ignored exactly as in
/// [`version_code`], so the server, the player, and the package share
/// one ordering.
///
/// Monotonic within a channel, and a beta always sorts below the
/// stable release of the same core, so a beta-to-stable move is an
/// upgrade Windows accepts. `None` fails the release build closed: an
/// invalid version name, an unknown channel, or a major above 65535
/// (every MSIX part must fit 16 bits, and `0.0.0.0` is reserved, which
/// the nonzero revision rules out).
pub fn msix_version(version_name: &str, channel: &str) -> Option<MsixVersion> {
    let revision = match channel {
        "beta" => 1,
        "stable" => 2,
        _ => return None,
    };
    if !is_version_name(version_name) {
        return None;
    }
    let core = version_name.split_once('-').map_or(version_name, |(core, _)| core);
    let mut parts = core.split('.');
    let (major, minor, patch) =
        (parts.next()?.parse::<u64>().ok()?, parts.next()?.parse::<u64>().ok()?, parts.next()?.parse::<u64>().ok()?);
    if parts.next().is_some() || major > 65_535 || minor >= 1_000 || patch >= 1_000 {
        return None;
    }
    Some(MsixVersion { major: major as u16, minor: minor as u16, build: patch as u16, revision })
}

// ---- install_player_update ----

use std::sync::Arc;
use std::time::Duration;

use player_client::player_api::ServerCommand;
use player_state::repo::commands::CommandResult;

use crate::daemon::DaemonContext;
use crate::paths::WindowsPaths;

/// Transient attempts before a job fails as unavailable, ten seconds
/// apart: the download-verify-install flow without the privileged
/// rollback architecture, which Windows does not need.
pub const MAX_ATTEMPTS: u32 = 12;
const PASS_INTERVAL: Duration = Duration::from_secs(10);
const JOB_FILE: &str = "update-job.json";
const PROGRESS_BYTES: u64 = 8 * 1024 * 1024;

/// The `installationMode` values the server sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    InstallNow,
    MaintenanceWindow,
}

impl Mode {
    pub fn parse(value: &str) -> Option<Mode> {
        match value {
            "install_now" => Some(Mode::InstallNow),
            "maintenance_window" => Some(Mode::MaintenanceWindow),
            _ => None,
        }
    }
}

/// An accepted update, durable in the state directory so a crash or
/// reboot resumes it. The installer state itself needs no durability:
/// every stage re-verifies from the signed envelope.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingJob {
    pub deployment_id: uuid::Uuid,
    pub release_id: uuid::Uuid,
    pub command_id: uuid::Uuid,
    pub expected_version_code: u64,
    pub expected_artifact_sha256: String,
    pub mode: Mode,
    pub window_start_ms: Option<i64>,
}

fn uuid_field(payload: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<uuid::Uuid> {
    payload.get(key).and_then(serde_json::Value::as_str).and_then(|value| uuid::Uuid::parse_str(value).ok())
}

/// Validates an `install_player_update` payload into a job. The server's
/// payload (`updateCommandPayload`): `deploymentId`, `releaseId`,
/// `playerFamily`, `expectedVersionCode`, `expectedArtifactSha256`,
/// `installationMode` and an optional `maintenanceWindowStart`.
pub fn parse_command(command: &ServerCommand) -> Result<PendingJob, CommandResult> {
    let payload = &command.payload;
    let invalid = || CommandResult::failed("update_payload_invalid", "The update command payload is invalid.");
    if let Some(family) = payload.get("playerFamily")
        && family.as_str() != Some(crate::envelope::PLAYER_FAMILY)
    {
        return Err(CommandResult::failed(
            "update_wrong_family",
            "This release is not a Windows Player release and cannot be installed here.",
        ));
    }
    let deployment_id = uuid_field(payload, "deploymentId").ok_or_else(invalid)?;
    let release_id = uuid_field(payload, "releaseId").ok_or_else(invalid)?;
    let expected_version_code = payload
        .get("expectedVersionCode")
        .and_then(serde_json::Value::as_u64)
        .filter(|code| *code > 0 && *code < 1_000_000_000_000)
        .ok_or_else(invalid)?;
    let expected_artifact_sha256 = payload
        .get("expectedArtifactSha256")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| player_types::Sha256Digest::parse(value).ok().map(|_| value.to_owned()))
        .ok_or_else(invalid)?;
    let mode = payload
        .get("installationMode")
        .and_then(serde_json::Value::as_str)
        .and_then(Mode::parse)
        .ok_or_else(invalid)?;
    let window_start_ms = match payload.get("maintenanceWindowStart") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(text)) if text.len() <= 64 => {
            Some(player_types::Timestamp::parse(text).map_err(|_| invalid())?.unix_millis())
        }
        Some(_) => return Err(invalid()),
    };
    if mode == Mode::MaintenanceWindow && window_start_ms.is_none() {
        return Err(invalid());
    }
    Ok(PendingJob {
        deployment_id,
        release_id,
        command_id: command.id,
        expected_version_code,
        expected_artifact_sha256,
        mode,
        window_start_ms,
    })
}

fn job_path(paths: &WindowsPaths) -> std::path::PathBuf {
    paths.state_dir.join(JOB_FILE)
}

fn staging_dir(paths: &WindowsPaths) -> std::path::PathBuf {
    paths.runtime_dir.join("updates")
}

/// The command handler: validates, records the job, and returns. It
/// never downloads, installs, or waits; the coordinator does that.
pub fn accept(paths: &WindowsPaths, command: &ServerCommand, own_code: u64) -> CommandResult {
    let job = match parse_command(command) {
        Ok(job) => job,
        Err(result) => return result,
    };
    if job.expected_version_code <= own_code {
        return CommandResult::ok("update_not_needed", "This screen already runs this release or a newer one.");
    }
    if crate::win32::current_package_full_name().is_none() {
        return CommandResult::failed(
            "update_not_supported",
            "This player is not installed from an MSIX package and cannot update itself.",
        );
    }
    let document = match serde_json::to_vec_pretty(&job) {
        Ok(document) => document,
        Err(_) => return CommandResult::failed("state_unavailable", "The update job cannot be recorded."),
    };
    let path = job_path(paths);
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &document).is_err() || std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return CommandResult::failed("state_unavailable", "The update job cannot be recorded.");
    }
    tracing::info!(
        component = "update",
        event = "accepted",
        deployment = %job.deployment_id,
        expected_version_code = job.expected_version_code
    );
    CommandResult::ok("update_accepted", "The update is accepted and runs in the background.")
}

fn load_job(paths: &WindowsPaths) -> Option<PendingJob> {
    let bytes = std::fs::read(job_path(paths)).ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

fn clear_job(paths: &WindowsPaths) {
    let _ = std::fs::remove_file(job_path(paths));
}

/// The update coordinator: resumes a recorded job at startup, runs one
/// job at a time, and waits for the next command.
pub async fn run(context: Arc<DaemonContext>) {
    loop {
        if let Some(job) = load_job(&context.paths) {
            if matches!(execute(&context, &job).await, Pass::Aborted) {
                return;
            }
            continue;
        }
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = context.update_wake.notified() => {}
        }
    }
}

/// A pass outcome: `Done` ends the job, `Aborted` keeps the job file
/// for the resume after shutdown, and `Retry` asks for another attempt.
enum Pass {
    Done,
    Aborted,
    Retry(String),
}

async fn execute(context: &DaemonContext, job: &PendingJob) -> Pass {
    if job.expected_version_code <= own_version_code() {
        clear_job(&context.paths);
        return Pass::Done;
    }
    if job.mode == Mode::MaintenanceWindow
        && let Some(start) = job.window_start_ms
    {
        // No reportable waiting state exists; the deployment target
        // stays pending until the window opens.
        while context.now().unix_millis() < start {
            tokio::select! {
                () = context.shutdown.cancelled() => return Pass::Aborted,
                () = tokio::time::sleep(Duration::from_secs(60)) => {}
            }
            if load_job(&context.paths).is_none_or(|current| current.command_id != job.command_id) {
                return Pass::Done;
            }
        }
    }
    let mut attempt = 0;
    loop {
        if context.shutdown.is_cancelled() {
            return Pass::Aborted;
        }
        attempt += 1;
        match pass(context, job).await {
            Pass::Done => return Pass::Done,
            Pass::Aborted => return Pass::Aborted,
            Pass::Retry(detail) => {
                if attempt >= MAX_ATTEMPTS {
                    let server = context.command_server.borrow().clone();
                    if let Some(server) = server {
                        fail(context, &server, job, "update_unavailable", &detail).await;
                    } else {
                        clear_job(&context.paths);
                    }
                    return Pass::Done;
                }
                tracing::info!(component = "update", event = "retrying", attempt, detail = %detail);
                tokio::select! {
                    () = context.shutdown.cancelled() => return Pass::Aborted,
                    () = tokio::time::sleep(PASS_INTERVAL) => {}
                }
            }
        }
    }
}

async fn pass(context: &DaemonContext, job: &PendingJob) -> Pass {
    let server = context.command_server.borrow().clone();
    let Some(server) = server else {
        return Pass::Retry("the server relationship is down".to_string());
    };
    let metadata = match server.player_update_metadata(job.release_id).await {
        Ok(metadata) => metadata,
        Err(_) => return Pass::Retry("the release metadata is unavailable".to_string()),
    };
    if metadata.release_id != job.release_id
        || metadata.player_family != crate::envelope::PLAYER_FAMILY
        || metadata.version_code != job.expected_version_code
        || metadata.artifact_sha256 != job.expected_artifact_sha256
    {
        fail(context, &server, job, "update_metadata_mismatch", "The release metadata does not match the command.")
            .await;
        return Pass::Done;
    }
    let key = match crate::envelope::trusted_key() {
        Ok(key) => key,
        Err(_) => {
            fail(context, &server, job, "update_unavailable", "The trusted update key is invalid.").await;
            return Pass::Done;
        }
    };
    let verified = match crate::envelope::verify_envelope(&metadata.signed_manifest, &metadata.manifest_signature, &key)
    {
        Ok(verified) => verified,
        Err(error) => {
            let (code, message) = match error {
                crate::envelope::EnvelopeError::BadSignature => {
                    ("update_bad_signature", "The release signature does not verify.")
                }
                _ => ("update_envelope_invalid", "The release envelope is invalid."),
            };
            fail(context, &server, job, code, message).await;
            return Pass::Done;
        }
    };
    if verified.check_host().is_err() {
        fail(context, &server, job, "update_wrong_architecture", "The release is for another architecture.").await;
        return Pass::Done;
    }
    let envelope = &verified.envelope;
    if envelope.version_code != metadata.version_code
        || envelope.version_name != metadata.version_name
        || envelope.artifact_size_bytes != metadata.artifact_size_bytes
        || envelope.artifact_sha256 != metadata.artifact_sha256
    {
        fail(context, &server, job, "update_metadata_mismatch", "The release metadata does not match its envelope.")
            .await;
        return Pass::Done;
    }
    let Some(package_version) = msix_version(&envelope.version_name, &envelope.channel) else {
        fail(context, &server, job, "update_version_unmappable", "The release version has no package version.").await;
        return Pass::Done;
    };
    if report(&server, job.deployment_id, "downloading", 0, None, None).await.is_closed() {
        clear_job(&context.paths);
        return Pass::Done;
    }
    let staged = match download(context, &server, &metadata, job).await {
        Ok(staged) => staged,
        Err(pass) => return pass,
    };
    if report(&server, job.deployment_id, "verifying", metadata.artifact_size_bytes, None, None).await.is_closed() {
        clear_job(&context.paths);
        return Pass::Done;
    }
    let identity = match crate::msix::read_identity(&staged) {
        Ok(identity) => identity,
        Err(error) => {
            fail(context, &server, job, "update_package_invalid", &format!("The package cannot be read: {error}"))
                .await;
            return Pass::Done;
        }
    };
    if let Err(error) = crate::msix::check_identity(&identity, package_version, &envelope.arch) {
        let (code, message) = match &error {
            crate::msix::MsixError::WrongArchitecture(_) => {
                ("update_wrong_architecture", "The package is for another architecture.")
            }
            crate::msix::MsixError::WrongVersion(_) => {
                ("update_version_mismatch", "The package version does not match the release.")
            }
            _ => ("update_package_invalid", "The package is not this application."),
        };
        fail(context, &server, job, code, &format!("{message} {error}")).await;
        return Pass::Done;
    }
    if crate::win32::current_package_full_name().is_none() {
        fail(context, &server, job, "update_not_supported", "This player is not installed from an MSIX package.").await;
        return Pass::Done;
    }
    if load_job(&context.paths).is_none_or(|current| current.command_id != job.command_id) {
        let _ = std::fs::remove_file(&staged);
        return Pass::Done;
    }
    if report(&server, job.deployment_id, "ready", metadata.artifact_size_bytes, None, None).await.is_closed()
        || report(&server, job.deployment_id, "installing", metadata.artifact_size_bytes, None, None).await.is_closed()
    {
        clear_job(&context.paths);
        return Pass::Done;
    }
    let path = staged.clone();
    let deployed = tokio::task::spawn_blocking(move || crate::win32::deploy_msix(&path)).await;
    match deployed {
        Ok(Ok(())) => {}
        Ok(Err(detail)) => {
            fail(context, &server, job, "update_install_failed", &format!("Deployment failed: {detail}")).await;
            return Pass::Done;
        }
        Err(_) => return Pass::Retry("deployment was interrupted".to_string()),
    }
    clear_job(&context.paths);
    let _ = std::fs::remove_file(&staged);
    report(&server, job.deployment_id, "reconnecting", metadata.artifact_size_bytes, None, None).await;
    tracing::info!(
        component = "update",
        event = "installed",
        deployment = %job.deployment_id,
        version = %envelope.version_name
    );
    context.restart_requested.store(true, std::sync::atomic::Ordering::Release);
    context.shutdown.cancel();
    Pass::Done
}

/// Streams the artifact from the paired server into staging, reporting
/// progress. The digest and size are verified after the last byte:
/// nothing runs before the whole file checks out.
async fn download(
    context: &DaemonContext,
    server: &player_client::AuthenticatedServer,
    metadata: &player_client::updates::UpdateMetadata,
    job: &PendingJob,
) -> Result<std::path::PathBuf, Pass> {
    use futures_util::StreamExt as _;
    use player_cas::BlobSource as _;

    let digest = match player_types::Sha256Digest::parse(&metadata.artifact_sha256) {
        Ok(digest) => digest,
        Err(_) => {
            fail(context, server, job, "update_metadata_mismatch", "The release digest is invalid.").await;
            return Err(Pass::Done);
        }
    };
    let source = match player_core::OriginBlobSource::new(server.clone(), &metadata.artifact_path) {
        Ok(source) => source,
        Err(_) => {
            fail(context, server, job, "update_metadata_mismatch", "The release artifact path is invalid.").await;
            return Err(Pass::Done);
        }
    };
    if std::fs::create_dir_all(staging_dir(&context.paths)).is_err() {
        return Err(Pass::Retry("the staging directory is unavailable".to_string()));
    }
    let staged = staging_dir(&context.paths).join(format!("{}.msix", job.release_id.simple()));
    let part = staged.with_extension("msix.part");
    let mut stream = match source.open(&digest, metadata.artifact_size_bytes, 0).await {
        Ok(stream) => stream,
        Err(error) => {
            use player_cas::SourceError;
            match error {
                SourceError::NotFound | SourceError::Unauthorized => {
                    fail(context, server, job, "update_unavailable", "The release artifact is unavailable.").await;
                    return Err(Pass::Done);
                }
                _ => return Err(Pass::Retry(format!("the artifact stream did not open: {error}"))),
            }
        }
    };
    if stream.start != 0 || stream.total_length.is_some_and(|total| total != metadata.artifact_size_bytes) {
        fail(context, server, job, "update_metadata_mismatch", "The artifact stream does not match its metadata.")
            .await;
        return Err(Pass::Done);
    }
    let file = match std::fs::File::create(&part) {
        Ok(file) => file,
        Err(_) => return Err(Pass::Retry("the staging file cannot be written".to_string())),
    };
    let mut file = std::io::BufWriter::new(file);
    let mut received = 0u64;
    let mut reported = 0u64;
    loop {
        let chunk = tokio::select! {
            () = context.shutdown.cancelled() => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err(Pass::Aborted);
            }
            chunk = tokio::time::timeout(Duration::from_secs(30), stream.body.next()) => chunk,
        };
        match chunk {
            Err(_) => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err(Pass::Retry("the artifact stream stalled".to_string()));
            }
            Ok(None) => break,
            Ok(Some(Err(error))) => {
                drop(file);
                let _ = std::fs::remove_file(&part);
                return Err(Pass::Retry(format!("the artifact stream failed: {error}")));
            }
            Ok(Some(Ok(bytes))) => {
                use std::io::Write as _;
                received += bytes.len() as u64;
                if received > metadata.artifact_size_bytes {
                    drop(file);
                    let _ = std::fs::remove_file(&part);
                    fail(
                        context,
                        server,
                        job,
                        "update_download_incomplete",
                        "The artifact is longer than its metadata.",
                    )
                    .await;
                    return Err(Pass::Done);
                }
                if file.write_all(&bytes).is_err() {
                    drop(file);
                    let _ = std::fs::remove_file(&part);
                    return Err(Pass::Retry("the staging file cannot be written".to_string()));
                }
                if received - reported >= PROGRESS_BYTES {
                    reported = received;
                    if report(server, job.deployment_id, "downloading", received, None, None).await.is_closed() {
                        drop(file);
                        let _ = std::fs::remove_file(&part);
                        clear_job(&context.paths);
                        return Err(Pass::Done);
                    }
                }
            }
        }
    }
    drop(file);
    if received != metadata.artifact_size_bytes {
        let _ = std::fs::remove_file(&part);
        fail(context, server, job, "update_download_incomplete", "The artifact is shorter than its metadata.").await;
        return Err(Pass::Done);
    }
    if sha256_file(&part) != Some(metadata.artifact_sha256.clone()) {
        let _ = std::fs::remove_file(&part);
        fail(context, server, job, "update_digest_mismatch", "The artifact digest does not match its envelope.").await;
        return Err(Pass::Done);
    }
    if std::fs::rename(&part, &staged).is_err() {
        let _ = std::fs::remove_file(&part);
        return Err(Pass::Retry("the staged artifact cannot be finalized".to_string()));
    }
    if report(server, job.deployment_id, "downloaded", received, None, None).await.is_closed() {
        let _ = std::fs::remove_file(&staged);
        clear_job(&context.paths);
        return Err(Pass::Done);
    }
    Ok(staged)
}

fn sha256_file(path: &std::path::Path) -> Option<String> {
    use sha2::Digest as _;
    let mut file = std::fs::File::open(path).ok()?;
    let mut digest = sha2::Sha256::new();
    let mut chunk = [0u8; 65536];
    loop {
        use std::io::Read as _;
        let read = file.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        digest.update(&chunk[..read]);
    }
    Some(format!("{:x}", digest.finalize()))
}

enum Reported {
    Sent,
    Closed,
}

impl Reported {
    fn is_closed(&self) -> bool {
        matches!(self, Reported::Closed)
    }
}

/// One best-effort status report. `Closed` means the deployment is
/// cancelled or complete for this screen: the job stops.
async fn report(
    server: &player_client::AuthenticatedServer,
    deployment: uuid::Uuid,
    state: &'static str,
    downloaded_bytes: u64,
    installer_status: Option<String>,
    error: Option<String>,
) -> Reported {
    let outcome = server
        .report_update_status(
            deployment,
            &player_client::updates::UpdateReport { state, downloaded_bytes, installer_status, error },
        )
        .await;
    match outcome {
        Ok(player_client::updates::UpdateReportOutcome::Closed) => Reported::Closed,
        _ => Reported::Sent,
    }
}

/// A terminal failure: the report goes out up to three times, then the
/// job and its staging are cleared. Settlement still happens through
/// the heartbeat of whatever build is running.
async fn fail(
    context: &DaemonContext,
    server: &player_client::AuthenticatedServer,
    job: &PendingJob,
    code: &str,
    message: &str,
) {
    tracing::warn!(component = "update", event = "failed", deployment = %job.deployment_id, code, message = %message);
    for _ in 0..3 {
        if report(
            server,
            job.deployment_id,
            "failed",
            0,
            Some(code.chars().take(64).collect()),
            Some(message.to_owned()),
        )
        .await
        .is_closed()
        {
            break;
        }
        if context.shutdown.is_cancelled() {
            break;
        }
        tokio::time::sleep(PASS_INTERVAL).await;
    }
    clear_job(&context.paths);
    let staged = staging_dir(&context.paths).join(format!("{}.msix", job.release_id.simple()));
    let _ = std::fs::remove_file(&staged);
    let _ = std::fs::remove_file(staged.with_extension("msix.part"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_codes_match_the_server_scheme() {
        assert_eq!(version_code("0.1.0"), Some(1_000));
        assert_eq!(version_code("1.2.3"), Some(1_002_003));
        assert_eq!(version_code("1.2.3-rc.1"), Some(1_002_003));
        assert_eq!(version_code("1.2"), None);
        assert_eq!(version_code("1.2.3.4"), None);
        assert_eq!(version_code("1.1000.0"), None);
        assert_eq!(version_code("1.2.3-"), None);
        assert_eq!(version_code("1.2.3-rc!"), None);
        assert_eq!(version_code("abc"), None);
        assert_ne!(own_version_code(), 0);
    }

    #[test]
    fn version_names_match_the_server_pattern() {
        assert!(is_version_name("0.1.0"));
        assert!(is_version_name("1.2.3-rc.1"));
        assert!(is_version_name("999999.999.999-x"));
        assert!(!is_version_name(""));
        assert!(!is_version_name("1.2"));
        assert!(!is_version_name("1.2.3.4"));
        assert!(!is_version_name("1.2.3-"));
        assert!(!is_version_name("1.2.3-rc-1"));
        assert!(!is_version_name("1.2.3-rc_1"));
        assert!(!is_version_name("v1.2.3"));
        assert!(!is_version_name("1.2.3 "));
        assert!(!is_version_name(&format!("1.2.{}-{}", "3".repeat(60), "x".repeat(10))));
    }

    #[test]
    fn msix_versions_keep_the_triple_readable() {
        assert_eq!(msix_version("0.1.0", "stable").expect("maps").to_string(), "0.1.0.2");
        assert_eq!(msix_version("1.2.3", "stable").expect("maps").to_string(), "1.2.3.2");
        assert_eq!(msix_version("1.2.3", "beta").expect("maps").to_string(), "1.2.3.1");
        assert_eq!(msix_version("1.2.3-rc.1", "beta").expect("maps").to_string(), "1.2.3.1");
        assert_eq!(msix_version("0.0.0", "beta").expect("maps").to_string(), "0.0.0.1");
    }

    #[test]
    fn msix_versions_order_with_the_release_line() {
        let (beta, stable) =
            (msix_version("1.2.3", "beta").expect("maps"), msix_version("1.2.3", "stable").expect("maps"));
        assert!(beta < stable, "a beta sorts below its stable release");
        assert!(stable < msix_version("1.2.4", "beta").expect("maps"));
        assert!(msix_version("1.2.3", "stable").expect("maps") < msix_version("1.3.0", "beta").expect("maps"));
        assert!(msix_version("1.999.999", "stable").expect("maps") < msix_version("2.0.0", "beta").expect("maps"));
        // Same ordering as the version code within a channel.
        let codes = ["0.1.0", "0.2.0", "1.0.0", "1.0.1", "1.2.3", "10.0.0"];
        let quads: Vec<MsixVersion> = codes.iter().map(|name| msix_version(name, "stable").expect("maps")).collect();
        let mut sorted = quads.clone();
        sorted.sort();
        assert_eq!(quads, sorted);
        let mut codes_sorted: Vec<u64> = codes.iter().map(|name| version_code(name).expect("code")).collect();
        codes_sorted.sort();
        assert_eq!(codes_sorted, codes.iter().map(|name| version_code(name).expect("code")).collect::<Vec<_>>());
    }

    fn command(payload: serde_json::Value) -> ServerCommand {
        ServerCommand {
            id: uuid::Uuid::new_v4(),
            command_type: "install_player_update".to_string(),
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            payload: payload.as_object().expect("object").clone(),
        }
    }

    fn job_payload() -> serde_json::Value {
        serde_json::json!({
            "deploymentId": uuid::Uuid::new_v4().to_string(),
            "releaseId": uuid::Uuid::new_v4().to_string(),
            "playerFamily": "windows",
            "expectedVersionCode": 2000,
            "expectedArtifactSha256": "a".repeat(64),
            "installationMode": "install_now",
        })
    }

    #[test]
    fn update_commands_parse_into_jobs() {
        let job = parse_command(&command(job_payload())).expect("parses");
        assert_eq!(job.expected_version_code, 2000);
        assert_eq!(job.mode, Mode::InstallNow);
        assert_eq!(job.window_start_ms, None);
        let mut windowed = job_payload();
        windowed["installationMode"] = serde_json::json!("maintenance_window");
        windowed["maintenanceWindowStart"] = serde_json::json!("2030-01-01T00:00:00Z");
        let job = parse_command(&command(windowed)).expect("parses");
        assert_eq!(job.mode, Mode::MaintenanceWindow);
        assert!(job.window_start_ms.expect("window") > 0);
    }

    #[test]
    fn wrong_commands_are_refused_with_codes() {
        let wrong_family = parse_command(&command(serde_json::json!({
            "deploymentId": uuid::Uuid::new_v4().to_string(),
            "releaseId": uuid::Uuid::new_v4().to_string(),
            "playerFamily": "edge",
            "expectedVersionCode": 2000,
            "expectedArtifactSha256": "a".repeat(64),
            "installationMode": "install_now",
        })));
        assert_eq!(wrong_family.expect_err("refused").code.as_str(), "update_wrong_family");
        for (field, value) in [
            ("deploymentId", serde_json::json!("not-a-uuid")),
            ("expectedVersionCode", serde_json::json!(0)),
            ("expectedVersionCode", serde_json::json!("2000")),
            ("expectedArtifactSha256", serde_json::json!("xyz")),
            ("installationMode", serde_json::json!("reboot_now")),
        ] {
            let mut payload = job_payload();
            payload[field] = value;
            assert_eq!(
                parse_command(&command(payload)).expect_err("refused").code.as_str(),
                "update_payload_invalid",
                "{field}"
            );
        }
        let mut missing = job_payload();
        missing.as_object_mut().expect("object").remove("releaseId");
        assert_eq!(parse_command(&command(missing)).expect_err("refused").code.as_str(), "update_payload_invalid");
        let mut windowless = job_payload();
        windowless["installationMode"] = serde_json::json!("maintenance_window");
        assert_eq!(parse_command(&command(windowless)).expect_err("refused").code.as_str(), "update_payload_invalid");
    }

    #[test]
    fn stale_updates_are_not_needed() {
        // The stale check runs before the packaged check on every
        // platform, so unpackaged developer builds see it too.
        let dir = tempfile::tempdir().expect("tempdir");
        let windows = crate::paths::WindowsPaths::new(dir.path().join("state"), dir.path().join("run"));
        std::fs::create_dir_all(&windows.state_dir).expect("state dir");
        let mut payload = job_payload();
        payload["expectedVersionCode"] = serde_json::json!(own_version_code());
        let result = accept(&windows, &command(payload), own_version_code());
        assert_eq!(result.code.as_str(), "update_not_needed");
        assert!(std::fs::read(job_path(&windows)).is_err(), "no job is recorded");
    }

    #[test]
    fn staged_files_hash_like_their_envelope() {
        use sha2::Digest as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("a.msix");
        std::fs::write(&path, b"package-bytes").expect("fixture");
        let expected = format!("{:x}", sha2::Sha256::digest(b"package-bytes"));
        assert_eq!(sha256_file(&path).as_deref(), Some(expected.as_str()));
        assert_eq!(sha256_file(&dir.path().join("absent")), None);
    }

    #[test]
    fn msix_versions_fail_closed_outside_their_domain() {
        assert!(msix_version("1.2.3", "nightly").is_none());
        assert!(msix_version("1.2.3", "").is_none());
        assert!(msix_version("1.2", "stable").is_none());
        assert!(msix_version("1.1000.0", "stable").is_none());
        assert!(msix_version("65535.999.999", "stable").is_some(), "the largest mappable major");
        assert!(msix_version("65536.0.0", "stable").is_none(), "major must fit 16 bits");
        assert!(msix_version("100000.0.0", "stable").is_none());
    }
}
