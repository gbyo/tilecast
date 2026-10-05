//! One-time legacy Room/cache importer.
//!
//! An upgrade from a Room-based release carries enrollment, the accepted
//! configuration, the committed manifest, and verified media the new
//! Core state must not lose. The importer copies them across once,
//! through the same validation every fresh value passes:
//!
//! * the player installation ID becomes the Core player identity with
//!   source `legacy_import`, unless Core already has a different one;
//! * the server binding (URL, installation, organization, screen) is
//!   stored, with the credential state read from the shared Keystore
//!   entry both generations already use;
//! * the active legacy configuration is validated and accepted under
//!   Core's strictly-increasing revision rule, then installed;
//! * the committed legacy manifest is validated and staged as pending
//!   with its target, so the normal trial promotes it on evidence;
//! * every required media object is re-verified (size and streaming
//!   SHA-256 against the manifest's claim, never the cache index) and
//!   ingested into CAS before anything is staged.
//!
//! The legacy database is opened read-only and never migrated or
//! written, so the previous release keeps working through the
//! rollback window. Legacy pairing secrets are never imported: an
//! in-progress legacy pairing is discarded and Core pairs fresh.
//! Every write is idempotent, and a `legacy-import.json` marker in
//! the Core root records the outcome: a crash restarts the import,
//! a completed or skipped import never runs again, and an import
//! never starts over Core state that fresh pairing already owns.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use player_cas::ContentStore;
use player_state::StateDb;
use player_state::repo::cas::SourceKind;
use rusqlite::OptionalExtension;
use serde_json::Value;

use crate::config_host::AndroidConfigHost;

/// The Room database file below the app-data directory, beside `files/`.
pub const ROOM_DB_NAME: &str = "tilecast-player.db";
/// The legacy media cache below the files directory.
pub const LEGACY_CACHE_DIR_NAME: &str = "media-cache";
/// The outcome marker below the Core root.
pub const IMPORT_MARKER_NAME: &str = "legacy-import.json";

/// Shipped Room schema versions, from the migration chain in
/// `PlayerDatabase`: 1 has the configuration row only, 2 adds
/// manifests and cached assets, 3 adds player configs, 4 adds the
/// pairing columns, 5 adds the binding columns.
const MIN_ROOM_VERSION: i64 = 1;
const MAX_ROOM_VERSION: i64 = 5;

const IMPORT_BUFFER_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportStatus {
    Complete,
    SkippedCoreOwned,
    NothingToImport,
    Failed,
}

impl ImportStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Complete => "complete",
            Self::SkippedCoreOwned => "skipped_core_owned",
            Self::NothingToImport => "nothing_to_import",
            Self::Failed => "failed",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "complete" => Some(Self::Complete),
            "skipped_core_owned" => Some(Self::SkippedCoreOwned),
            "nothing_to_import" => Some(Self::NothingToImport),
            "failed" => Some(Self::Failed),
            "in_progress" => None,
            _ => None,
        }
    }
}

/// What the import did, as the marker records it and status reports it.
#[derive(Debug, Clone, Default)]
pub struct ImportOutcome {
    pub status: Option<ImportStatus>,
    pub room_version: Option<i64>,
    pub identity_imported: bool,
    pub binding_imported: bool,
    pub config_revision: Option<i64>,
    pub manifest_version: Option<i64>,
    pub media_imported: usize,
    pub media_skipped: usize,
    pub notes: Vec<String>,
}

impl ImportOutcome {
    fn note(&mut self, note: impl Into<String>) {
        self.notes.push(note.into());
    }

    pub fn marker_json(&self) -> Value {
        serde_json::json!({
            "status": self.status.as_ref().map_or("in_progress", ImportStatus::as_str),
            "roomVersion": self.room_version,
            "identityImported": self.identity_imported,
            "bindingImported": self.binding_imported,
            "configRevision": self.config_revision,
            "manifestVersion": self.manifest_version,
            "mediaImported": self.media_imported,
            "mediaSkipped": self.media_skipped,
            "notes": self.notes,
        })
    }
}

pub struct ImportDeps {
    pub state: StateDb,
    pub core: player_core::PlayerCore,
    pub cas: ContentStore,
    pub config: Arc<AndroidConfigHost>,
    pub credentials: Arc<dyn player_client::CredentialStore>,
    pub clock: player_types::time::SharedClock,
    pub files_dir: PathBuf,
    pub core_root: PathBuf,
}

impl std::fmt::Debug for ImportDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportDeps").field("core_root", &self.core_root).finish_non_exhaustive()
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn marker_path(core_root: &Path) -> PathBuf {
    core_root.join(IMPORT_MARKER_NAME)
}

fn read_marker(core_root: &Path) -> Option<ImportOutcome> {
    let raw = std::fs::read(marker_path(core_root)).ok()?;
    let value: Value = serde_json::from_slice(&raw).ok()?;
    let status = ImportStatus::parse(value.get("status")?.as_str()?)?;
    Some(ImportOutcome {
        status: Some(status),
        room_version: value.get("roomVersion").and_then(Value::as_i64),
        identity_imported: value.get("identityImported").and_then(Value::as_bool).unwrap_or(false),
        binding_imported: value.get("bindingImported").and_then(Value::as_bool).unwrap_or(false),
        config_revision: value.get("configRevision").and_then(Value::as_i64),
        manifest_version: value.get("manifestVersion").and_then(Value::as_i64),
        media_imported: value.get("mediaImported").and_then(Value::as_u64).unwrap_or(0) as usize,
        media_skipped: value.get("mediaSkipped").and_then(Value::as_u64).unwrap_or(0) as usize,
        notes: value
            .get("notes")
            .and_then(Value::as_array)
            .map(|notes| notes.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default(),
    })
}

/// A legacy row read through whatever columns its schema version has.
/// Pairing columns are never selected: those secrets stay behind.
struct LegacyConfig {
    player_installation_id: String,
    server_url: Option<String>,
    server_installation_id: Option<String>,
    organization_name: Option<String>,
    screen_id: Option<String>,
    screen_name: Option<String>,
}

struct LegacyManifestRow {
    version: i64,
    raw_json: String,
    etag: Option<String>,
    installation_id: Option<String>,
    screen_id: Option<String>,
    server_url: Option<String>,
}

struct LegacyConfigRow {
    revision: i64,
    raw_json: String,
    etag: Option<String>,
    installation_id: Option<String>,
    screen_id: Option<String>,
    server_url: Option<String>,
}

struct LegacyAssetRow {
    asset_id: String,
    sha256: String,
    expected_size: i64,
    local_path: String,
    installation_id: Option<String>,
    screen_id: Option<String>,
    server_url: Option<String>,
}

struct Room {
    connection: rusqlite::Connection,
    version: i64,
}

fn sql_value(value: rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(number) => Value::from(number),
        rusqlite::types::Value::Real(number) => Value::from(number),
        rusqlite::types::Value::Text(text) => Value::from(text),
        rusqlite::types::Value::Blob(_) => Value::Null,
    }
}

impl Room {
    fn open(path: &Path) -> Result<Self, String> {
        let connection = rusqlite::Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| format!("room open failed: {error}"))?;
        connection.busy_timeout(std::time::Duration::from_secs(5)).map_err(|error| format!("room busy: {error}"))?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| format!("room version: {error}"))?;
        if !(MIN_ROOM_VERSION..=MAX_ROOM_VERSION).contains(&version) {
            return Err(format!("unsupported room schema {version}"));
        }
        Ok(Self { connection, version })
    }

    fn columns(&self, table: &str) -> BTreeSet<String> {
        let mut columns = BTreeSet::new();
        let sql = format!("PRAGMA table_info({table})");
        if let Ok(mut statement) = self.connection.prepare(&sql)
            && let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(1))
        {
            columns.extend(rows.flatten());
        }
        columns
    }

    fn has_table(&self, table: &str) -> bool {
        self.connection
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
                rusqlite::params![table],
                |_| Ok(()),
            )
            .is_ok()
    }

    fn configuration(&self) -> Result<Option<LegacyConfig>, String> {
        if !self.has_table("player_configuration") {
            return Ok(None);
        }
        let columns = self.columns("player_configuration");
        let present = |name: &str| columns.contains(name);
        let mut selected = vec!["playerInstallationId"];
        for column in ["serverUrl", "serverInstallationId", "organizationName", "screenId", "screenName"] {
            if present(column) {
                selected.push(column);
            }
        }
        let sql = format!("SELECT {} FROM player_configuration WHERE id = 1", selected.join(", "));
        let row: Option<Vec<Value>> = self
            .connection
            .query_row(&sql, [], |row| {
                (0..selected.len())
                    .map(|index| row.get::<_, rusqlite::types::Value>(index).map(sql_value))
                    .collect::<Result<Vec<_>, _>>()
            })
            .optional()
            .map_err(|error| format!("room configuration: {error}"))?;
        let Some(values) = row else { return Ok(None) };
        let text = |name: &str| {
            selected
                .iter()
                .position(|column| *column == name)
                .and_then(|index| values[index].as_str())
                .map(str::to_owned)
        };
        let Some(player_installation_id) = text("playerInstallationId") else { return Ok(None) };
        Ok(Some(LegacyConfig {
            player_installation_id,
            server_url: text("serverUrl"),
            server_installation_id: text("serverInstallationId"),
            organization_name: text("organizationName"),
            screen_id: text("screenId"),
            screen_name: text("screenName"),
        }))
    }

    fn manifest_row(&self, state: &str) -> Result<Option<LegacyManifestRow>, String> {
        if !self.has_table("stored_manifests") {
            return Ok(None);
        }
        let columns = self.columns("stored_manifests");
        let binding = ["installationId", "screenId", "normalizedServerUrl"]
            .into_iter()
            .filter(|column| columns.contains(*column))
            .collect::<Vec<_>>();
        let mut selected = vec!["manifestVersion", "rawJson", "etag"];
        selected.extend(binding);
        let order = if state == "active" { "activatedAt DESC" } else { "manifestVersion DESC" };
        let sql =
            format!("SELECT {} FROM stored_manifests WHERE state = ?1 ORDER BY {order} LIMIT 1", selected.join(", "));
        let row: Option<Vec<Value>> = self
            .connection
            .query_row(&sql, rusqlite::params![state], |row| {
                (0..selected.len())
                    .map(|index| row.get::<_, rusqlite::types::Value>(index).map(sql_value))
                    .collect::<Result<Vec<_>, _>>()
            })
            .optional()
            .map_err(|error| format!("room manifests: {error}"))?;
        let Some(values) = row else { return Ok(None) };
        let at = |name: &str| {
            selected
                .iter()
                .position(|column| *column == name)
                .and_then(|index| values[index].as_str())
                .map(str::to_owned)
        };
        let version = selected
            .iter()
            .position(|column| *column == "manifestVersion")
            .and_then(|index| values[index].as_i64())
            .ok_or_else(|| "room manifest version".to_owned())?;
        let Some(raw_json) = at("rawJson") else { return Err("room manifest document".to_owned()) };
        Ok(Some(LegacyManifestRow {
            version,
            raw_json,
            etag: at("etag"),
            installation_id: at("installationId"),
            screen_id: at("screenId"),
            server_url: at("normalizedServerUrl"),
        }))
    }

    fn active_config_row(&self) -> Result<Option<LegacyConfigRow>, String> {
        if !self.has_table("player_configs") {
            return Ok(None);
        }
        let columns = self.columns("player_configs");
        let binding = ["installationId", "screenId", "normalizedServerUrl"]
            .into_iter()
            .filter(|column| columns.contains(*column))
            .collect::<Vec<_>>();
        let mut selected = vec!["configRevision", "rawJson", "etag"];
        selected.extend(binding);
        let sql = format!(
            "SELECT {} FROM player_configs WHERE state = 'active' ORDER BY configRevision DESC LIMIT 1",
            selected.join(", ")
        );
        let row: Option<Vec<Value>> = self
            .connection
            .query_row(&sql, [], |row| {
                (0..selected.len())
                    .map(|index| row.get::<_, rusqlite::types::Value>(index).map(sql_value))
                    .collect::<Result<Vec<_>, _>>()
            })
            .optional()
            .map_err(|error| format!("room configs: {error}"))?;
        let Some(values) = row else { return Ok(None) };
        let at = |name: &str| {
            selected
                .iter()
                .position(|column| *column == name)
                .and_then(|index| values[index].as_str())
                .map(str::to_owned)
        };
        let revision = selected
            .iter()
            .position(|column| *column == "configRevision")
            .and_then(|index| values[index].as_i64())
            .ok_or_else(|| "room config revision".to_owned())?;
        let Some(raw_json) = at("rawJson") else { return Err("room config document".to_owned()) };
        Ok(Some(LegacyConfigRow {
            revision,
            raw_json,
            etag: at("etag"),
            installation_id: at("installationId"),
            screen_id: at("screenId"),
            server_url: at("normalizedServerUrl"),
        }))
    }

    fn ready_asset(&self, variant_id: &str) -> Result<Option<LegacyAssetRow>, String> {
        if !self.has_table("cached_assets") {
            return Ok(None);
        }
        let columns = self.columns("cached_assets");
        let binding = ["installationId", "screenId", "normalizedServerUrl"]
            .into_iter()
            .filter(|column| columns.contains(*column))
            .collect::<Vec<_>>();
        let mut selected = vec!["variantId", "assetId", "sha256", "expectedFileSize", "localPath"];
        selected.extend(binding);
        let sql = format!(
            "SELECT {} FROM cached_assets WHERE variantId = ?1 AND downloadStatus = 'ready' LIMIT 1",
            selected.join(", ")
        );
        let row: Option<Vec<Value>> = self
            .connection
            .query_row(&sql, rusqlite::params![variant_id], |row| {
                (0..selected.len())
                    .map(|index| row.get::<_, rusqlite::types::Value>(index).map(sql_value))
                    .collect::<Result<Vec<_>, _>>()
            })
            .optional()
            .map_err(|error| format!("room assets: {error}"))?;
        let Some(values) = row else { return Ok(None) };
        let at = |name: &str| {
            selected
                .iter()
                .position(|column| *column == name)
                .and_then(|index| values[index].as_str())
                .map(str::to_owned)
        };
        let (Some(_variant), Some(asset), Some(sha256), Some(path)) =
            (at("variantId"), at("assetId"), at("sha256"), at("localPath"))
        else {
            return Err("room asset identity".to_owned());
        };
        let expected_size = selected
            .iter()
            .position(|column| *column == "expectedFileSize")
            .and_then(|index| values[index].as_i64())
            .ok_or_else(|| "room asset size".to_owned())?;
        Ok(Some(LegacyAssetRow {
            asset_id: asset,
            sha256,
            expected_size,
            local_path: path,
            installation_id: at("installationId"),
            screen_id: at("screenId"),
            server_url: at("normalizedServerUrl"),
        }))
    }
}

/// A legacy row belongs to the import only when its binding columns, if
/// the schema has them, agree with the configuration row. Schemas before
/// 5 carry no binding columns and are accepted as the single screen.
fn binding_matches(
    config: &LegacyConfig,
    installation_id: &Option<String>,
    screen_id: &Option<String>,
    server_url: &Option<String>,
) -> bool {
    installation_id.as_ref().is_none_or(|value| Some(value) == config.server_installation_id.as_ref())
        && screen_id.as_ref().is_none_or(|value| Some(value) == config.screen_id.as_ref())
        && server_url.as_ref().is_none_or(|value| Some(value) == config.server_url.as_ref())
}

/// Verifies a legacy cache file against the manifest's own claim, the
/// way the legacy player verified before use: a regular file of
/// exactly the claimed size whose streaming SHA-256 matches.
fn verify_media(path: &Path, size_bytes: u64, digest: &player_types::Sha256Digest) -> Result<(), String> {
    use ring::digest::{Context, SHA256};
    let file = std::fs::File::open(path).map_err(|_| "media file missing".to_owned())?;
    let metadata = file.metadata().map_err(|_| "media file unreadable".to_owned())?;
    if !metadata.is_file() || metadata.len() != size_bytes {
        return Err("media size mismatch".to_owned());
    }
    let mut reader = std::io::BufReader::with_capacity(IMPORT_BUFFER_BYTES, file);
    let mut context = Context::new(&SHA256);
    let mut buffer = vec![0u8; IMPORT_BUFFER_BYTES];
    loop {
        use std::io::Read as _;
        let count = reader.read(&mut buffer).map_err(|_| "media file unreadable".to_owned())?;
        if count == 0 {
            break;
        }
        context.update(&buffer[..count]);
    }
    let actual = context.finish();
    if actual.as_ref() != digest.as_bytes() {
        return Err("media digest mismatch".to_owned());
    }
    Ok(())
}

async fn ingest_verified(
    cas: &ContentStore,
    path: &Path,
    digest: player_types::Sha256Digest,
    size_bytes: u64,
    mime_type: &str,
) -> Result<bool, String> {
    use player_cas::IngestMeta;
    use player_state::repo::cas::Domain;
    let meta = IngestMeta {
        domain: Domain::Media,
        content_type: Some(mime_type.to_owned()),
        source: SourceKind::LegacyImport,
    };
    let Some(mut session) =
        cas.begin_write(digest, size_bytes, meta).await.map_err(|error| format!("cas ingest: {error}"))?
    else {
        // Already stored and verified: an idempotent re-run reuses it.
        return Ok(false);
    };
    let mut file = std::fs::File::open(path).map_err(|_| "media file missing".to_owned())?;
    let mut buffer = vec![0u8; IMPORT_BUFFER_BYTES];
    loop {
        use std::io::Read as _;
        let count = file.read(&mut buffer).map_err(|_| "media file unreadable".to_owned())?;
        if count == 0 {
            break;
        }
        session.write(&buffer[..count]).map_err(|error| format!("cas ingest: {error}"))?;
    }
    session.commit().await.map_err(|error| format!("cas ingest: {error}"))?;
    Ok(true)
}

fn room_path(files_dir: &Path) -> PathBuf {
    files_dir.parent().unwrap_or(files_dir).join("databases").join(ROOM_DB_NAME)
}

/// Runs the one-time legacy import. Safe to call on every boot: the
/// marker short-circuits completed work, every write is idempotent,
/// and the legacy files are only ever read.
pub async fn import_legacy(deps: &ImportDeps) -> ImportOutcome {
    let mut outcome = ImportOutcome::default();
    if let Some(mut done) = read_marker(&deps.core_root) {
        done.note("already imported; replaying the recorded outcome");
        return done;
    }
    let room_file = room_path(&deps.files_dir);
    if !room_file.is_file() {
        outcome.status = Some(ImportStatus::NothingToImport);
        return outcome;
    }
    // Core state that fresh pairing already owns is never overwritten.
    // The in-progress marker below is written before any Core write, so
    // a binding with no marker at all came from pairing, while a
    // binding beside an in-progress marker is our own partial import
    // and must be retried to completion.
    let marker_present = marker_path(&deps.core_root).is_file();
    let core_bound =
        deps.state.run(|connection| player_state::repo::binding::get(connection)).await.ok().flatten().is_some();
    if core_bound && !marker_present {
        outcome.status = Some(ImportStatus::SkippedCoreOwned);
        outcome.note("core binding already owned; legacy data left for rollback only");
        let _ = atomic_write(&marker_path(&deps.core_root), outcome.marker_json().to_string().as_bytes());
        return outcome;
    }
    let room = match Room::open(&room_file) {
        Ok(room) => room,
        Err(note) => {
            outcome.status = Some(ImportStatus::Failed);
            outcome.note(note);
            return outcome;
        }
    };
    outcome.room_version = Some(room.version);
    // Crash recovery starts here: this marker precedes every Core write.
    let _ = atomic_write(&marker_path(&deps.core_root), outcome.marker_json().to_string().as_bytes());

    let config = match room.configuration() {
        Ok(config) => config,
        Err(note) => {
            outcome.status = Some(ImportStatus::Failed);
            outcome.note(note);
            return outcome;
        }
    };
    let Some(config) = config else {
        outcome.status = Some(ImportStatus::Complete);
        outcome.note("no legacy configuration row; nothing to carry across");
        let _ = atomic_write(&marker_path(&deps.core_root), outcome.marker_json().to_string().as_bytes());
        return outcome;
    };

    import_identity(deps, &config, &mut outcome).await;
    let binding = import_binding(deps, &config, &mut outcome).await;
    if let Some(binding) = binding {
        import_config(deps, &room, &config, &binding, &mut outcome).await;
        import_manifest(deps, &room, &config, &binding, &mut outcome).await;
    }
    outcome.status = Some(ImportStatus::Complete);
    let _ = atomic_write(&marker_path(&deps.core_root), outcome.marker_json().to_string().as_bytes());
    outcome
}

async fn import_identity(deps: &ImportDeps, config: &LegacyConfig, outcome: &mut ImportOutcome) {
    let id: Result<player_types::PlayerId, _> = config.player_installation_id.parse();
    let Ok(player_id) = id else {
        outcome.note("legacy installation id unparseable; core identity kept");
        return;
    };
    let now = deps.clock.now();
    let kept = deps
        .state
        .run(move |connection| {
            player_state::repo::daemon::set_player_identity(
                connection,
                player_id,
                player_state::repo::daemon::PlayerIdentitySource::LegacyImport,
                now,
            )
        })
        .await;
    match kept {
        Ok(_) => outcome.identity_imported = true,
        Err(_) => outcome.note("core identity already set to a different value; kept"),
    }
}

async fn import_binding(
    deps: &ImportDeps,
    config: &LegacyConfig,
    outcome: &mut ImportOutcome,
) -> Option<player_state::repo::manifests::Binding> {
    let server_url = config.server_url.clone().filter(|url| !url.trim().is_empty())?;
    let installation_id: player_types::InstallationId = config.server_installation_id.as_deref()?.parse().ok()?;
    let screen_id: Option<player_types::ScreenId> =
        config.screen_id.as_deref().map(str::parse).transpose().ok().flatten();
    let credential_stored = deps.credentials.load().ok().flatten().is_some();
    let now = deps.clock.now();
    let stored = player_state::repo::binding::ServerBinding {
        server_url: server_url.clone(),
        installation_id,
        organization_name: config.organization_name.clone(),
        screen_id,
        screen_name: config.screen_name.clone(),
        credential_state: if credential_stored {
            player_state::repo::binding::CredentialState::Stored
        } else {
            player_state::repo::binding::CredentialState::None
        },
        // A paired legacy screen already proved this server's identity.
        identity_verified_at: screen_id.map(|_| now),
        bound_at: now,
    };
    let saved = deps.state.run(move |connection| player_state::repo::binding::put(connection, &stored, now)).await;
    if saved.is_err() {
        outcome.note("legacy binding rejected; pairing starts fresh");
        return None;
    }
    outcome.binding_imported = true;
    screen_id.map(|screen| player_state::repo::manifests::Binding { installation_id, screen_id: screen, server_url })
}

async fn import_config(
    deps: &ImportDeps,
    room: &Room,
    config: &LegacyConfig,
    binding: &player_state::repo::manifests::Binding,
    outcome: &mut ImportOutcome,
) {
    let row = match room.active_config_row() {
        Ok(row) => row,
        Err(note) => {
            outcome.note(note);
            return;
        }
    };
    let Some(row) = row else { return };
    if !binding_matches(config, &row.installation_id, &row.screen_id, &row.server_url) {
        outcome.note(format!("legacy config revision {} bound elsewhere; skipped", row.revision));
        return;
    }
    let document: Value = match serde_json::from_str(&row.raw_json) {
        Ok(document) => document,
        Err(_) => {
            outcome.note(format!("legacy config revision {} malformed; skipped", row.revision));
            return;
        }
    };
    if let Err(error) = player_core::NativeConfiguration::parse(&document) {
        outcome.note(format!("legacy config revision {} invalid: {}", row.revision, error.reason_code()));
        return;
    }
    let revision = row.revision;
    let schema = document.get("schemaVersion").and_then(Value::as_i64).unwrap_or(1);
    let etag = row.etag.clone();
    let now = deps.clock.now();
    let owned = (*binding).clone();
    let accepted = deps
        .state
        .run(move |connection| {
            player_state::repo::config::accept(connection, &owned, schema, revision, etag.as_deref(), &document, now)
        })
        .await;
    match accepted {
        Ok(player_state::repo::config::AcceptOutcome::Accepted) => {
            deps.core.configuration().load_cached(binding, deps.config.as_ref()).await;
            if deps.config.accepted_revision() == Some(revision) {
                outcome.config_revision = Some(revision);
            } else {
                outcome.note(format!("legacy config revision {revision} unprojectable; stored but not installed"));
            }
        }
        Ok(player_state::repo::config::AcceptOutcome::NotNewer { .. }) => {
            outcome.note(format!("legacy config revision {revision} not newer; kept current"));
        }
        Err(_) => outcome.note(format!("legacy config revision {revision} rejected by core state")),
    }
}

async fn import_manifest(
    deps: &ImportDeps,
    room: &Room,
    config: &LegacyConfig,
    binding: &player_state::repo::manifests::Binding,
    outcome: &mut ImportOutcome,
) {
    let row = match room.manifest_row("active") {
        Ok(Some(row)) => Some(row),
        Ok(None) => match room.manifest_row("ready") {
            Ok(row) => row,
            Err(note) => {
                outcome.note(note);
                return;
            }
        },
        Err(note) => {
            outcome.note(note);
            return;
        }
    };
    let Some(row) = row else { return };
    if !binding_matches(config, &row.installation_id, &row.screen_id, &row.server_url) {
        outcome.note(format!("legacy manifest version {} bound elsewhere; skipped", row.version));
        return;
    }
    let document: Value = match serde_json::from_str(&row.raw_json) {
        Ok(document) => document,
        Err(_) => {
            outcome.note(format!("legacy manifest version {} malformed; skipped", row.version));
            return;
        }
    };
    let digest = player_core::manifest_digest(&document);
    let candidate = match player_core::NativeManifest::parse(document.clone(), binding.screen_id, digest) {
        Ok(candidate) => candidate,
        Err(error) => {
            outcome.note(format!("legacy manifest version {} invalid: {}", row.version, error.reason_code()));
            return;
        }
    };
    let etag = row.etag.clone().filter(|etag| etag.len() <= 200).unwrap_or_default();
    let now = deps.clock.now();
    let target = player_state::repo::manifests::Target {
        binding: binding.clone(),
        digest,
        version: candidate.version,
        etag,
        document: document.clone(),
        fetched_at: now,
    };
    let recorded =
        deps.state.run(move |connection| player_state::repo::manifests::put_target(connection, &target)).await;
    if !matches!(recorded, Ok(true)) {
        outcome.note(format!("legacy manifest version {} superseded; skipped", row.version));
        return;
    }
    // Every required object is re-verified against the manifest's own
    // claim and ingested before anything is staged. Verified objects
    // stay in CAS even when the set is incomplete: the next sync
    // reuses them instead of downloading again.
    let mut digests = Vec::with_capacity(candidate.required_downloads.len());
    let mut complete = true;
    for asset in &candidate.required_downloads {
        let variant = asset.variant_id.to_string();
        let row = match room.ready_asset(&variant) {
            Ok(row) => row,
            Err(note) => {
                outcome.note(note);
                complete = false;
                continue;
            }
        };
        let Some(row) = row else {
            outcome.media_skipped += 1;
            complete = false;
            continue;
        };
        if row.asset_id != asset.asset_id.to_string()
            || row.expected_size != asset.size_bytes as i64
            || row.sha256 != asset.digest.to_hex()
        {
            outcome.note(format!("legacy cache index stale for variant {variant}; skipped"));
            outcome.media_skipped += 1;
            complete = false;
            continue;
        }
        if !binding_matches(config, &row.installation_id, &row.screen_id, &row.server_url) {
            outcome.media_skipped += 1;
            complete = false;
            continue;
        }
        if let Err(reason) = verify_media(Path::new(&row.local_path), asset.size_bytes, &asset.digest) {
            outcome.note(format!("legacy media {variant} unverifiable: {reason}"));
            outcome.media_skipped += 1;
            complete = false;
            continue;
        }
        match ingest_verified(&deps.cas, Path::new(&row.local_path), asset.digest, asset.size_bytes, &asset.mime_type)
            .await
        {
            Ok(fresh) => {
                if fresh {
                    outcome.media_imported += 1;
                }
                digests.push(asset.digest);
            }
            Err(reason) => {
                outcome.note(format!("legacy media {variant} ingest failed: {reason}"));
                outcome.media_skipped += 1;
                complete = false;
            }
        }
    }
    if !complete {
        outcome.note(format!("legacy manifest version {} incomplete in cache; sync will prepare it", row.version));
        return;
    }
    let holder = player_core::manifest_pin_holder(&candidate.digest);
    if deps.cas.replace_pins(player_state::repo::cas::PinReason::PendingPresentation, &holder, digests).await.is_err() {
        outcome.note(format!("legacy manifest version {} pins refused; skipped", row.version));
        return;
    }
    let stored = player_state::repo::manifests::StoredManifest {
        binding: binding.clone(),
        digest: candidate.digest,
        version: candidate.version,
        document,
        stored_at: now,
    };
    let staged = deps
        .state
        .run(move |connection| player_state::repo::manifests::put_pending_for_target(connection, &stored))
        .await;
    if !matches!(staged, Ok(true)) {
        let _ =
            deps.cas.replace_pins(player_state::repo::cas::PinReason::PendingPresentation, &holder, Vec::new()).await;
        outcome.note(format!("legacy manifest version {} superseded during import", row.version));
        return;
    }
    outcome.manifest_version = Some(candidate.version);
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::{LruByDomain, StorePolicy};
    use player_state::{OpenOptions, StateDb};
    use serde_json::json;

    const INSTALLATION: &str = "3b9d4c2a-7e1f-4a6b-9c0d-5f8a2b6e1d44";
    const SCREEN: &str = "c791e841-b6ab-4e3f-a9f5-3b763cb47bd9";
    const SERVER: &str = "https://tilecast.example";
    const ASSET: &str = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
    const VARIANT: &str = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";
    const ITEM: &str = "ca48c671-8e48-4bad-ab75-6125064d0f5c";

    const PLAYER_CONFIGURATION_V1: &str = "CREATE TABLE player_configuration (id INTEGER NOT NULL, playerInstallationId TEXT NOT NULL, serverUrl TEXT, serverInstallationId TEXT, organizationName TEXT, screenId TEXT, screenName TEXT, PRIMARY KEY(id))";
    const STORED_MANIFESTS_V2: &str = "CREATE TABLE IF NOT EXISTS stored_manifests (manifestVersion INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, rawJson TEXT NOT NULL, etag TEXT, state TEXT NOT NULL, receivedAt INTEGER NOT NULL, readyAt INTEGER, activatedAt INTEGER, failureReason TEXT, PRIMARY KEY(manifestVersion))";
    const CACHED_ASSETS_V2: &str = "CREATE TABLE IF NOT EXISTS cached_assets (variantId TEXT NOT NULL, assetId TEXT NOT NULL, sha256 TEXT NOT NULL, expectedFileSize INTEGER NOT NULL, localPath TEXT NOT NULL, downloadStatus TEXT NOT NULL, downloadedBytes INTEGER NOT NULL, lastVerifiedAt INTEGER, lastUsedAt INTEGER, requiredByActiveManifest INTEGER NOT NULL, requiredByPendingManifest INTEGER NOT NULL, failureReason TEXT, PRIMARY KEY(variantId))";
    const PLAYER_CONFIGS_V3: &str = "CREATE TABLE IF NOT EXISTS player_configs (configRevision INTEGER NOT NULL, schemaVersion INTEGER NOT NULL, rawJson TEXT NOT NULL, etag TEXT, state TEXT NOT NULL, receivedAt INTEGER NOT NULL, activatedAt INTEGER, error TEXT, PRIMARY KEY(configRevision))";
    const PAIRING_V4: [&str; 5] = [
        "ALTER TABLE player_configuration ADD COLUMN pairingSessionId TEXT",
        "ALTER TABLE player_configuration ADD COLUMN pairingPollSecret TEXT",
        "ALTER TABLE player_configuration ADD COLUMN pairingCode TEXT",
        "ALTER TABLE player_configuration ADD COLUMN pairingExpiresAt TEXT",
        "ALTER TABLE player_configuration ADD COLUMN pairingPollingIntervalSeconds INTEGER",
    ];
    const BINDING_V5: [&str; 9] = [
        "ALTER TABLE stored_manifests ADD COLUMN installationId TEXT",
        "ALTER TABLE stored_manifests ADD COLUMN screenId TEXT",
        "ALTER TABLE stored_manifests ADD COLUMN normalizedServerUrl TEXT",
        "ALTER TABLE cached_assets ADD COLUMN installationId TEXT",
        "ALTER TABLE cached_assets ADD COLUMN screenId TEXT",
        "ALTER TABLE cached_assets ADD COLUMN normalizedServerUrl TEXT",
        "ALTER TABLE player_configs ADD COLUMN installationId TEXT",
        "ALTER TABLE player_configs ADD COLUMN screenId TEXT",
        "ALTER TABLE player_configs ADD COLUMN normalizedServerUrl TEXT",
    ];

    struct Fixture {
        _dir: tempfile::TempDir,
        app_data: PathBuf,
        core_root: PathBuf,
        deps: ImportDeps,
    }

    #[derive(Debug, Default)]
    struct MemoryCredentialStore(std::sync::Mutex<Option<player_client::DeviceCredential>>);

    impl player_client::CredentialStore for MemoryCredentialStore {
        fn load(&self) -> Result<Option<player_client::DeviceCredential>, player_client::CredentialError> {
            Ok(self.0.lock().expect("creds").clone())
        }

        fn save(&self, credential: &player_client::DeviceCredential) -> Result<(), player_client::CredentialError> {
            *self.0.lock().expect("creds") = Some(credential.clone());
            Ok(())
        }

        fn remove(&self) -> Result<(), player_client::CredentialError> {
            *self.0.lock().expect("creds") = None;
            Ok(())
        }
    }

    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data = dir.path().join("app-data");
        let core_root = dir.path().join("player-core");
        std::fs::create_dir_all(app_data.join("files")).expect("files dir");
        std::fs::create_dir_all(&core_root).expect("core dir");
        let state = StateDb::open(core_root.join("state.db"), OpenOptions::default()).expect("state");
        let clock = Arc::new(crate::host::SystemClock);
        let core =
            player_core::PlayerCore::new(player_core::Dependencies { state: state.clone(), clock: clock.clone() });
        let cas = ContentStore::open(
            core_root.join("cas"),
            core_root.join("partial"),
            state.clone(),
            clock.clone(),
            Arc::new(crate::host::StatvfsProbe),
            Arc::new(crate::host::AndroidSecureOpener),
            StorePolicy { limit_bytes: 64 * 1024 * 1024, reserved_free_bytes: 0 },
            Arc::new(LruByDomain),
        )
        .await
        .expect("cas");
        let config =
            Arc::new(AndroidConfigHost::new(core_root.join(crate::config_host::INSTALLED_CONFIG_NAME), cas.clone()));
        let deps = ImportDeps {
            state,
            core,
            cas,
            config,
            credentials: Arc::new(MemoryCredentialStore::default()),
            clock,
            files_dir: app_data.join("files"),
            core_root: core_root.clone(),
        };
        Fixture { _dir: dir, app_data, core_root, deps }
    }

    fn media_bytes() -> Vec<u8> {
        let mut bytes = b"tilecast-legacy-import:".to_vec();
        bytes.resize(100, 0x5A);
        bytes
    }

    fn manifest(document_digest: &player_types::Sha256Digest) -> Value {
        json!({
            "schemaVersion": 11, "manifestVersion": 12, "screenId": SCREEN, "mode": "presentation",
            "assets": [{"assetId": ASSET, "variantId": VARIANT, "sha256": document_digest.to_hex(),
                "fileSize": 100, "mimeType": "image/png",
                "downloadPath": format!("/api/v1/player/assets/{ASSET}/variants/{VARIANT}")}],
            "playlist": {"id": "e719e602-3b8f-4a2f-bec5-24b16e14725f", "items": [{
                "id": ITEM, "assetId": ASSET, "variantId": VARIANT,
                "assetType": "image", "deliveryPolicy": "automatic", "durationMs": 10000,
                "fitMode": "cover", "transition": "fade", "audioEnabled": true, "volume": 0.8
            }]},
            "playlists": [], "schedules": [], "websites": [], "widgets": [], "dataSources": [],
            "plugins": [], "layouts": []
        })
    }

    fn config_document(revision: i64) -> Value {
        json!({"schemaVersion": 1, "configRevision": revision, "generatedAt": "2026-09-24T00:00:00Z"})
    }

    /// Build a Room database at exactly the shipped schema for `version`,
    /// running the same statements the released migrations run.
    fn room_db(path: &Path, version: u32) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("db parent");
        }
        let connection = rusqlite::Connection::open(path).expect("room create");
        connection.execute_batch(PLAYER_CONFIGURATION_V1).expect("v1");
        if version >= 2 {
            connection.execute_batch(STORED_MANIFESTS_V2).expect("manifests");
            connection.execute_batch(CACHED_ASSETS_V2).expect("assets");
        }
        if version >= 3 {
            connection.execute_batch(PLAYER_CONFIGS_V3).expect("configs");
        }
        if version >= 4 {
            for statement in PAIRING_V4 {
                connection.execute_batch(statement).expect("pairing column");
            }
        }
        if version >= 5 {
            for statement in BINDING_V5 {
                connection.execute_batch(statement).expect("binding column");
            }
        }
        connection.execute_batch(&format!("PRAGMA user_version = {version}")).expect("user_version");
    }

    fn seed_enrolled_config(path: &Path, pairing_junk: bool) {
        let connection = rusqlite::Connection::open(path).expect("room open");
        if pairing_junk {
            connection
                .execute(
                    "INSERT INTO player_configuration (id, playerInstallationId, serverUrl, serverInstallationId, organizationName, screenId, screenName, pairingSessionId, pairingPollSecret, pairingCode) VALUES (1, '1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a', ?1, ?2, 'Example Org', ?3, 'Lobby', 'sess', 'poll-secret-value', 'ABC123')",
                    rusqlite::params![SERVER, INSTALLATION, SCREEN],
                )
                .expect("config row");
        } else {
            connection
                .execute(
                    "INSERT INTO player_configuration (id, playerInstallationId, serverUrl, serverInstallationId, organizationName, screenId, screenName) VALUES (1, '1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a', ?1, ?2, 'Example Org', ?3, 'Lobby')",
                    rusqlite::params![SERVER, INSTALLATION, SCREEN],
                )
                .expect("config row");
        }
    }

    fn seed_config_row(path: &Path, revision: i64, bound: bool) {
        let connection = rusqlite::Connection::open(path).expect("room open");
        let raw = config_document(revision).to_string();
        if bound {
            connection
                .execute(
                    "INSERT INTO player_configs (configRevision, schemaVersion, rawJson, etag, state, receivedAt, activatedAt, installationId, screenId, normalizedServerUrl) VALUES (?1, 1, ?2, 'etag-7', 'active', 1, 2, ?3, ?4, ?5)",
                    rusqlite::params![revision, raw, INSTALLATION, SCREEN, SERVER],
                )
                .expect("config state row");
        } else {
            connection
                .execute(
                    "INSERT INTO player_configs (configRevision, schemaVersion, rawJson, etag, state, receivedAt, activatedAt) VALUES (?1, 1, ?2, 'etag-7', 'active', 1, 2)",
                    rusqlite::params![revision, raw],
                )
                .expect("config state row");
        }
    }

    fn seed_manifest_row(path: &Path, document: &Value, bound: bool) {
        let connection = rusqlite::Connection::open(path).expect("room open");
        let raw = document.to_string();
        if bound {
            connection
                .execute(
                    "INSERT INTO stored_manifests (manifestVersion, schemaVersion, rawJson, etag, state, receivedAt, readyAt, activatedAt, installationId, screenId, normalizedServerUrl) VALUES (12, 11, ?1, 'etag-12', 'active', 1, 2, 3, ?2, ?3, ?4)",
                    rusqlite::params![raw, INSTALLATION, SCREEN, SERVER],
                )
                .expect("manifest row");
        } else {
            connection
                .execute(
                    "INSERT INTO stored_manifests (manifestVersion, schemaVersion, rawJson, etag, state, receivedAt, readyAt, activatedAt) VALUES (12, 11, ?1, 'etag-12', 'active', 1, 2, 3)",
                    rusqlite::params![raw],
                )
                .expect("manifest row");
        }
    }

    fn seed_asset_row(path: &Path, local_path: &Path, digest_hex: &str, bound: bool, installation: &str) {
        let connection = rusqlite::Connection::open(path).expect("room open");
        let local = local_path.to_string_lossy().to_string();
        if bound {
            connection
                .execute(
                    "INSERT INTO cached_assets (variantId, assetId, sha256, expectedFileSize, localPath, downloadStatus, downloadedBytes, lastVerifiedAt, lastUsedAt, requiredByActiveManifest, requiredByPendingManifest, installationId, screenId, normalizedServerUrl) VALUES (?1, ?2, ?3, 100, ?4, 'ready', 100, NULL, NULL, 1, 0, ?5, ?6, ?7)",
                    rusqlite::params![VARIANT, ASSET, digest_hex, local, installation, SCREEN, SERVER],
                )
                .expect("asset row");
        } else {
            connection
                .execute(
                    "INSERT INTO cached_assets (variantId, assetId, sha256, expectedFileSize, localPath, downloadStatus, downloadedBytes, lastVerifiedAt, lastUsedAt, requiredByActiveManifest, requiredByPendingManifest) VALUES (?1, ?2, ?3, 100, ?4, 'ready', 100, NULL, NULL, 1, 0)",
                    rusqlite::params![VARIANT, ASSET, digest_hex, local],
                )
                .expect("asset row");
        }
    }

    fn seed_media(app_data: &Path) -> (PathBuf, player_types::Sha256Digest) {
        let bytes = media_bytes();
        let digest = player_types::Sha256Digest::of(&bytes);
        let dir = app_data.join("files").join(LEGACY_CACHE_DIR_NAME);
        std::fs::create_dir_all(&dir).expect("cache dir");
        let path = dir.join(format!("{VARIANT}.bin"));
        std::fs::write(&path, bytes).expect("media bytes");
        (path, digest)
    }

    async fn object_present(cas: &ContentStore, digest: &player_types::Sha256Digest) -> bool {
        cas.stat(digest).await.expect("stat").is_some()
    }

    #[tokio::test]
    async fn v5_enrolled_full_import() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 5);
        seed_enrolled_config(&db, false);
        let (media_path, digest) = seed_media(&fixture.app_data);
        seed_config_row(&db, 7, true);
        seed_manifest_row(&db, &manifest(&digest), true);
        seed_asset_row(&db, &media_path, &digest.to_hex(), true, INSTALLATION);

        let outcome = import_legacy(&fixture.deps).await;
        assert!(outcome.identity_imported, "notes: {:?}", outcome.notes);
        assert!(outcome.binding_imported, "notes: {:?}", outcome.notes);
        assert_eq!(outcome.config_revision, Some(7));
        assert_eq!(outcome.manifest_version, Some(12));
        assert_eq!(outcome.media_imported, 1);
        assert_eq!(outcome.media_skipped, 0);
        assert!(outcome.notes.is_empty(), "notes: {:?}", outcome.notes);
        assert!(object_present(&fixture.deps.cas, &digest).await);
        assert_eq!(fixture.deps.config.accepted_revision(), Some(7));
        assert!(fixture.core_root.join(IMPORT_MARKER_NAME).exists());

        // A completed import never runs twice: the marker replays.
        let rerun = import_legacy(&fixture.deps).await;
        assert!(rerun.identity_imported);
        assert_eq!(rerun.config_revision, Some(7));
        assert!(rerun.notes.iter().any(|note| note.contains("already imported")));
    }

    #[tokio::test]
    async fn v1_config_only_imports_identity_and_binding() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 1);
        seed_enrolled_config(&db, false);

        let outcome = import_legacy(&fixture.deps).await;
        assert!(outcome.identity_imported, "notes: {:?}", outcome.notes);
        assert!(outcome.binding_imported, "notes: {:?}", outcome.notes);
        assert_eq!(outcome.config_revision, None);
        assert_eq!(outcome.manifest_version, None);
        assert!(fixture.core_root.join(IMPORT_MARKER_NAME).exists());
    }

    #[tokio::test]
    async fn v2_manifest_and_cache_import_without_binding_columns() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 2);
        seed_enrolled_config(&db, false);
        let (media_path, digest) = seed_media(&fixture.app_data);
        seed_manifest_row(&db, &manifest(&digest), false);
        seed_asset_row(&db, &media_path, &digest.to_hex(), false, INSTALLATION);

        let outcome = import_legacy(&fixture.deps).await;
        assert!(outcome.binding_imported, "notes: {:?}", outcome.notes);
        assert_eq!(outcome.manifest_version, Some(12));
        assert_eq!(outcome.media_imported, 1);
        assert!(object_present(&fixture.deps.cas, &digest).await);
    }

    #[tokio::test]
    async fn v3_config_imports_without_binding_columns() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 3);
        seed_enrolled_config(&db, false);
        seed_config_row(&db, 7, false);

        let outcome = import_legacy(&fixture.deps).await;
        assert_eq!(outcome.config_revision, Some(7));
        assert_eq!(fixture.deps.config.accepted_revision(), Some(7));
    }

    #[tokio::test]
    async fn v4_pairing_columns_are_never_imported() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 4);
        seed_enrolled_config(&db, true);
        seed_config_row(&db, 7, false);

        let outcome = import_legacy(&fixture.deps).await;
        assert!(outcome.binding_imported, "notes: {:?}", outcome.notes);
        assert_eq!(outcome.config_revision, Some(7));
        // Nothing about the pairing session crosses: the marker carries no secret.
        let marker = std::fs::read(fixture.core_root.join(IMPORT_MARKER_NAME)).expect("marker");
        let marker_text = String::from_utf8(marker).expect("marker utf8");
        assert!(!marker_text.contains("poll-secret-value"));
        assert!(!marker_text.contains("ABC123"));
    }

    #[tokio::test]
    async fn binding_mismatch_skips_media_and_staging() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 5);
        seed_enrolled_config(&db, false);
        let (media_path, digest) = seed_media(&fixture.app_data);
        seed_manifest_row(&db, &manifest(&digest), true);
        seed_asset_row(&db, &media_path, &digest.to_hex(), true, "9f8e7d6c-5b4a-4032-9182-736455161718");

        let outcome = import_legacy(&fixture.deps).await;
        assert_eq!(outcome.manifest_version, None);
        assert_eq!(outcome.media_skipped, 1);
        assert!(!object_present(&fixture.deps.cas, &digest).await);
        assert!(outcome.notes.iter().any(|note| note.contains("incomplete in cache")));
    }

    #[tokio::test]
    async fn corrupt_media_is_skipped_not_trusted() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 5);
        seed_enrolled_config(&db, false);
        let (media_path, digest) = seed_media(&fixture.app_data);
        std::fs::write(&media_path, b"tampered bytes, wrong size").expect("tamper");
        seed_manifest_row(&db, &manifest(&digest), true);
        seed_asset_row(&db, &media_path, &digest.to_hex(), true, INSTALLATION);

        let outcome = import_legacy(&fixture.deps).await;
        assert_eq!(outcome.manifest_version, None);
        assert_eq!(outcome.media_skipped, 1);
        assert!(!object_present(&fixture.deps.cas, &digest).await);
        assert!(outcome.notes.iter().any(|note| note.contains("unverifiable")));
    }

    #[tokio::test]
    async fn incomplete_manifest_keeps_verified_objects_for_next_sync() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 5);
        seed_enrolled_config(&db, false);
        let (media_path, digest) = seed_media(&fixture.app_data);
        let mut document = manifest(&digest);
        let missing = player_types::Sha256Digest::of(b"never cached");
        document["assets"].as_array_mut().expect("assets").push(json!({
            "assetId": ASSET, "variantId": "11111111-2222-4333-8444-555555555555",
            "sha256": missing.to_hex(), "fileSize": 12, "mimeType": "image/png",
            "downloadPath": "/api/v1/player/assets/x/variants/y"
        }));
        seed_manifest_row(&db, &document, true);
        seed_asset_row(&db, &media_path, &digest.to_hex(), true, INSTALLATION);

        let outcome = import_legacy(&fixture.deps).await;
        assert_eq!(outcome.manifest_version, None);
        assert_eq!(outcome.media_imported, 1);
        assert_eq!(outcome.media_skipped, 1);
        assert!(object_present(&fixture.deps.cas, &digest).await);
    }

    #[tokio::test]
    async fn crash_mid_run_reimports_idempotently() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 5);
        seed_enrolled_config(&db, false);
        let (media_path, digest) = seed_media(&fixture.app_data);
        seed_config_row(&db, 7, true);
        seed_manifest_row(&db, &manifest(&digest), true);
        seed_asset_row(&db, &media_path, &digest.to_hex(), true, INSTALLATION);

        let first = import_legacy(&fixture.deps).await;
        assert_eq!(first.manifest_version, Some(12));
        // The process died after the in-progress marker landed but before
        // completion: the next launch retries instead of trusting it.
        std::fs::write(
            fixture.core_root.join(IMPORT_MARKER_NAME),
            r#"{"status":"in_progress","roomVersion":5,"notes":[]}"#,
        )
        .expect("in-progress marker");
        let second = import_legacy(&fixture.deps).await;
        assert!(second.binding_imported);
        assert!(second.notes.iter().any(|note| note.contains("not newer")));
        assert_eq!(second.media_imported, 0);
        assert!(object_present(&fixture.deps.cas, &digest).await);
        let marker = std::fs::read(fixture.core_root.join(IMPORT_MARKER_NAME)).expect("marker");
        assert!(String::from_utf8(marker).expect("utf8").contains("\"complete\""));
    }

    #[tokio::test]
    async fn fresh_install_skips_quietly() {
        let fixture = fixture().await;
        let outcome = import_legacy(&fixture.deps).await;
        assert!(!outcome.identity_imported);
        assert!(!outcome.binding_imported);
        // No marker: a Room database that appears later still imports.
        assert!(!fixture.core_root.join(IMPORT_MARKER_NAME).exists());
    }

    #[tokio::test]
    async fn unenrolled_room_is_skipped() {
        let fixture = fixture().await;
        let db = fixture.app_data.join("databases").join(ROOM_DB_NAME);
        room_db(&db, 5);
        let connection = rusqlite::Connection::open(&db).expect("room open");
        connection
            .execute("INSERT INTO player_configuration (id, playerInstallationId) VALUES (1, 'player-uuid')", [])
            .expect("bare row");

        let outcome = import_legacy(&fixture.deps).await;
        assert!(!outcome.identity_imported);
        assert!(!outcome.binding_imported);
        assert!(fixture.core_root.join(IMPORT_MARKER_NAME).exists());
    }

    #[tokio::test]
    async fn unreadable_room_leaves_no_marker_for_retry() {
        let fixture = fixture().await;
        std::fs::create_dir_all(fixture.app_data.join("databases")).expect("databases dir");
        std::fs::write(fixture.app_data.join("databases").join(ROOM_DB_NAME), b"not a database").expect("garbage");
        let outcome = import_legacy(&fixture.deps).await;
        assert!(!outcome.identity_imported);
        assert!(!outcome.notes.is_empty());
        assert!(!fixture.core_root.join(IMPORT_MARKER_NAME).exists());
    }
}
