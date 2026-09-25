//! One-time import of the legacy Electron Linux Player's state (RFC
//! docs/tilecast-edge.md §14.2).
//!
//! # Guarantees
//!
//! * **Read-only on the legacy directory.** Files are read and media is
//!   *copied* into the CAS; nothing in the legacy directory is modified,
//!   moved or deleted, so re-enabling the legacy unit rolls back.
//! * **Bounded.** Every legacy JSON file is size-limited and strictly
//!   parsed; only regular files are read (no symlinks).
//! * **Untrusted until verified.** The saved server URL is normalized with
//!   the player URL policy, `/api/v1/system/identity` must report the saved
//!   installation ID, and only then is the credential stored or sent.
//!   Cached media enters the CAS only through the verified commit path
//!   (size and SHA-256 against the saved manifest).
//! * **Idempotent and crash-safe.** Every step is an upsert or
//!   content-addressed; a crash at any point is repaired by running the
//!   import again. A completed import is not repeated, except by
//!   [`ImportMode::Refresh`].
//! * **Refresh after a rollback.** When a migration rolls back, the legacy
//!   player runs again and can execute more commands and receive a newer
//!   manifest. The next migration imports again with
//!   [`ImportMode::Refresh`]. Executed command keys are added to the ones
//!   already recorded and never removed, so a command that either player
//!   ran never runs again.
//! * **Not imported:** pairing sessions (temporary), the AppImage updater
//!   stage, AirPlay session files, Presentation Network radio state, and
//!   website storage.

use std::io::{Read as _, Seek as _};
use std::path::{Path, PathBuf};

use edge_cas::{ContentStore, IngestMeta};
use edge_protocol::{InstallationId, PlayerId, ScreenId, Sha256Digest, Timestamp};
use edge_state::StateDb;
use edge_state::repo::binding::{CredentialState, ServerBinding};
use edge_state::repo::cas::{Domain, PinReason, SourceKind};
use edge_state::repo::daemon::PlayerIdentitySource;
use edge_state::repo::{binding, commands, daemon, legacy, playback};
use serde::Deserialize;

use crate::client::{ServerClient, ServerError};
use crate::credential::DeviceCredential;
use crate::url_policy::normalize_server_url;

pub const IMPORTER_VERSION: u32 = 1;
const MAX_STATE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_MEDIA_FILES: usize = 10_000;
pub const PIN_HOLDER: &str = "legacy-import";

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("legacy state is missing: {0}")]
    Missing(&'static str),
    #[error("legacy state file {0} is invalid")]
    Invalid(&'static str),
    #[error("the saved server address is not allowed: {0}")]
    ServerUrl(String),
    #[error(transparent)]
    Server(#[from] ServerError),
    #[error("state error: {0}")]
    State(#[from] edge_state::StateError),
    #[error("content store error: {0}")]
    Cas(#[from] edge_cas::CasError),
    #[error("identity directory error: {0}")]
    Identity(String),
}

impl ImportError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Missing(_) => "legacy_state_missing",
            Self::Invalid(_) => "legacy_state_invalid",
            Self::ServerUrl(_) => "legacy_server_url_rejected",
            Self::Server(error) => error.reason_code(),
            Self::State(_) => "state_error",
            Self::Cas(_) => "content_store_error",
            Self::Identity(_) => "identity_store_error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// The import replaced the state of an earlier completed import.
    pub refreshed: bool,
    pub player_id: PlayerId,
    pub server_url: String,
    pub installation_id: InstallationId,
    pub screen_id: ScreenId,
    pub executed_command_keys: usize,
    pub playback_disabled: bool,
    pub clock_offset_imported: bool,
    pub manifest_sha256: Option<Sha256Digest>,
    pub media_imported: usize,
    pub media_missing: usize,
    pub media_rejected: usize,
}

#[derive(Debug)]
pub enum ImportOutcome {
    Imported(ImportSummary),
    AlreadyComplete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportMode {
    /// Import unless an import already completed.
    Once,
    /// Import even if an import already completed (a migration after a
    /// rollback).
    Refresh,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallationRecord {
    player_installation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialRecord {
    server_url: String,
    installation_id: String,
    screen_id: String,
    screen_name: String,
    device_credential: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutedRecord {
    keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlagsRecord {
    playback_disabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredManifest {
    manifest: ManifestAssets,
    #[serde(default)]
    clock_offset_ms: Option<f64>,
    #[serde(default)]
    installation_id: Option<String>,
    #[serde(default)]
    screen_id: Option<String>,
    #[serde(default)]
    normalized_server_url: Option<String>,
}

#[derive(Deserialize)]
struct ManifestAssets {
    #[serde(default)]
    assets: Vec<ManifestAsset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestAsset {
    asset_id: String,
    variant_id: String,
    mime_type: String,
    sha256: String,
    file_size: u64,
}

/// The legacy default data directory for the daemon's account.
pub fn default_legacy_dir() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(xdg).join("tilecast-player"));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/tilecast-player"))
}

/// Reads a legacy state file: a regular file, never through a symbolic
/// link, and at most [`MAX_STATE_FILE_BYTES`].
fn read_regular(path: &Path) -> Result<Option<Vec<u8>>, ImportError> {
    edge_platform::fs::read_regular(path, MAX_STATE_FILE_BYTES).map_err(|e| ImportError::Identity(e.to_string()))
}

fn read_json<T: serde::de::DeserializeOwned>(dir: &Path, name: &'static str) -> Result<Option<T>, ImportError> {
    match read_regular(&dir.join(name))? {
        None => Ok(None),
        Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| ImportError::Invalid(name)),
    }
}

/// Legacy media file names are `<assetId>-<variantId>`; both must be plain
/// identifiers before they are joined to the cache directory.
fn is_plain_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Runs the import. `server_url_override` replaces the saved URL (after the
/// same policy) when the installer knows the server moved.
pub async fn import_legacy(
    legacy_dir: &Path,
    identity_dir: &Path,
    db: &StateDb,
    cas: &ContentStore,
    now: Timestamp,
    mode: ImportMode,
) -> Result<ImportOutcome, ImportError> {
    let completed =
        db.run(|c| legacy::get(c)).await?.is_some_and(|record| record.state == legacy::ImportState::Completed);
    if completed && mode == ImportMode::Once {
        return Ok(ImportOutcome::AlreadyComplete);
    }
    let source = legacy_dir.to_string_lossy().into_owned();
    db.run(move |c| legacy::begin(c, IMPORTER_VERSION, &source, now)).await?;
    match run(legacy_dir, identity_dir, db, cas, now, completed).await {
        Ok(summary) => {
            let value = serde_json::to_value(&summary).unwrap_or_default();
            db.run(move |c| legacy::complete(c, &value, now)).await?;
            Ok(ImportOutcome::Imported(summary))
        }
        Err(error) => {
            let code = error.reason_code();
            db.run(move |c| legacy::fail(c, code, now)).await?;
            Err(error)
        }
    }
}

async fn run(
    legacy_dir: &Path,
    identity_dir: &Path,
    db: &StateDb,
    cas: &ContentStore,
    now: Timestamp,
    refreshed: bool,
) -> Result<ImportSummary, ImportError> {
    let installation: InstallationRecord =
        read_json(legacy_dir, "installation.json")?.ok_or(ImportError::Missing("installation.json"))?;
    let player_id: PlayerId =
        installation.player_installation_id.parse().map_err(|_| ImportError::Invalid("installation.json"))?;
    let saved: CredentialRecord =
        read_json(legacy_dir, "credential.json")?.ok_or(ImportError::Missing("credential.json"))?;
    let server_url = normalize_server_url(&saved.server_url).map_err(|e| ImportError::ServerUrl(e.to_string()))?;
    let installation_id: InstallationId =
        saved.installation_id.parse().map_err(|_| ImportError::Invalid("credential.json"))?;
    let screen_id: ScreenId = saved.screen_id.parse().map_err(|_| ImportError::Invalid("credential.json"))?;
    let credential =
        DeviceCredential::parse(&saved.device_credential).map_err(|_| ImportError::Invalid("credential.json"))?;

    // Identity gate: nothing is stored, and the credential is not sent,
    // until the server proves it is the saved installation.
    let client = ServerClient::new(&server_url)?;
    let verified = client.verify_installation(installation_id, credential.clone()).await?;

    db.run(move |c| daemon::set_player_identity(c, player_id, PlayerIdentitySource::LegacyImport, now).map(|_| ()))
        .await?;
    credential.save(identity_dir).map_err(|e| ImportError::Identity(e.to_string()))?;
    let binding_record = ServerBinding {
        server_url: server_url.clone(),
        installation_id,
        organization_name: Some(verified.identity().organization_name.chars().take(120).collect()),
        screen_id: Some(screen_id),
        screen_name: Some(saved.screen_name.chars().take(120).collect()),
        credential_state: CredentialState::Stored,
        identity_verified_at: Some(now),
        bound_at: now,
    };
    db.run(move |c| binding::put(c, &binding_record, now)).await?;

    // Commands the legacy player already ran must never run again.
    let executed: ExecutedRecord =
        read_json(legacy_dir, "executed-commands.json")?.unwrap_or(ExecutedRecord { keys: vec![] });
    let keys: Vec<String> = executed.keys.into_iter().filter(|k| !k.is_empty() && k.len() <= 128).take(5_000).collect();
    let executed_count = keys.len();
    db.run(move |c| {
        for key in &keys {
            commands::import_completed(c, key, now)?;
        }
        Ok(())
    })
    .await?;

    let flags: Option<FlagsRecord> = read_json(legacy_dir, "playback-flags.json")?;
    let playback_disabled = flags.is_some_and(|f| f.playback_disabled);

    // The cached manifest: keep it (as an immutable legacy_state object) so
    // the manifest port can start offline, restore the clock offset, and
    // import the media it lists.
    let mut manifest_sha256 = None;
    let mut clock_offset = None;
    let (mut imported, mut missing, mut rejected) = (0, 0, 0);
    let manifest_path = legacy_dir.join("manifest-active.json");
    let manifest = edge_platform::fs::open_regular(&manifest_path, MAX_STATE_FILE_BYTES)
        .map_err(|e| ImportError::Identity(e.to_string()))?;
    if let Some((mut manifest_file, _)) = manifest {
        // One open file for the parse and the import, so the bytes that
        // were checked are the bytes that are stored.
        let mut bytes = Vec::new();
        (&mut manifest_file)
            .take(MAX_STATE_FILE_BYTES)
            .read_to_end(&mut bytes)
            .and_then(|_| manifest_file.rewind())
            .map_err(|e| ImportError::Identity(e.to_string()))?;
        let stored: StoredManifest =
            serde_json::from_slice(&bytes).map_err(|_| ImportError::Invalid("manifest-active.json"))?;
        // The legacy player's own cache-identity rule (`cacheIdentityMatches`).
        let same_identity = stored.installation_id.as_deref() == Some(installation_id.to_string().as_str())
            && stored.screen_id.as_deref() == Some(screen_id.to_string().as_str())
            && stored.normalized_server_url.as_deref() == Some(server_url.as_str());
        if same_identity {
            let digest = Sha256Digest::of(&bytes);
            let meta = IngestMeta {
                domain: Domain::LegacyState,
                content_type: Some("application/json".into()),
                source: SourceKind::LegacyImport,
            };
            cas.import_open_file(manifest_file, digest, bytes.len() as u64, meta).await?;
            manifest_sha256 = Some(digest);
            clock_offset = stored.clock_offset_ms.filter(|v| v.is_finite()).map(|v| v.round() as i64);
            let media_dir = legacy_dir.join("cache").join("media");
            let mut pinned = vec![digest];
            for asset in stored.manifest.assets.iter().take(MAX_MEDIA_FILES) {
                let Ok(expected) = Sha256Digest::parse_legacy_case_insensitive(&asset.sha256) else {
                    rejected += 1;
                    continue;
                };
                if !is_plain_id(&asset.asset_id) || !is_plain_id(&asset.variant_id) {
                    rejected += 1;
                    continue;
                }
                let file = media_dir.join(format!("{}-{}", asset.asset_id, asset.variant_id));
                let opened = match edge_platform::fs::open_regular(&file, asset.file_size) {
                    Ok(Some((opened, len))) if len == asset.file_size => opened,
                    Ok(_) | Err(_) if std::fs::symlink_metadata(&file).is_err() => {
                        missing += 1;
                        continue;
                    }
                    _ => {
                        // A link, a special file, the wrong size or unreadable.
                        rejected += 1;
                        continue;
                    }
                };
                let meta = IngestMeta {
                    domain: Domain::Media,
                    content_type: Some(asset.mime_type.chars().take(127).collect()),
                    // Manifest media is already eligible for this player.
                    source: SourceKind::LegacyImport,
                };
                match cas.import_open_file(opened, expected, asset.file_size, meta).await {
                    Ok(_) => {
                        imported += 1;
                        pinned.push(expected);
                    }
                    Err(edge_cas::CasError::DigestMismatch { .. } | edge_cas::CasError::SizeMismatch { .. }) => {
                        rejected += 1;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            // Keep imported content until the first server-driven activation
            // replaces these pins.
            cas.replace_pins(PinReason::Migration, PIN_HOLDER, pinned).await?;
        }
    }
    let offset = clock_offset;
    db.run(move |c| {
        let mut state = playback::get(c)?;
        state.playback_disabled = playback_disabled;
        if let Some(offset) = offset {
            state.server_clock_offset_ms = Some(offset);
        }
        playback::put(c, &state, now)
    })
    .await?;

    Ok(ImportSummary {
        refreshed,
        player_id,
        server_url,
        installation_id,
        screen_id,
        executed_command_keys: executed_count,
        playback_disabled,
        clock_offset_imported: clock_offset.is_some(),
        manifest_sha256,
        media_imported: imported,
        media_missing: missing,
        media_rejected: rejected,
    })
}
