//! Installation mismatch response and device unpair.
//!
//! When the server's installation ID stops matching the binding, Player Core
//! stops the link and reports the pair through
//! [`player_core::ServerLinkHost::identity_mismatch`]. Edge owns the
//! response: record the server evidence, quarantine the protected caches,
//! and stop showing server content. Only a mismatch quarantines: generic
//! link errors, unreachable servers, and rejected credentials never reach
//! this module.
//!
//! The quarantine is crash-safe. The record names the planned cache moves
//! and is written before anything moves, with `quarantine_complete` false.
//! The moves run, the directories are recreated, and the CAS metadata is
//! invalidated in the same transaction that sets the flag. A restart or the
//! next mismatched pass resumes an incomplete record; a move that already
//! happened is never repeated.
//!
//! Unpair is the operator's way out: forget the binding, credential,
//! pairing files, queued results, and staged configuration, then show the
//! setup surface so the screen can pair again. It is idempotent, so a
//! failed run converges on retry.

use std::path::Path;

use edge_protocol::ipc::presentation::{PresentationDocument, StatusSurface};

pub use edge_state::repo::installation_mismatch::InstallationMismatch as MismatchRecord;

/// Loads the recorded mismatch at startup. A row without a binding is an
/// orphan from an interrupted unpair: dropped, never honored.
pub async fn load_mismatch(db: &edge_state::StateDb) -> Option<MismatchRecord> {
    let mismatch = db.run(|conn| edge_state::repo::installation_mismatch::get(conn)).await.ok()??;
    let bound = db.run(|conn| edge_state::repo::binding::get(conn)).await.ok()?.is_some();
    if bound { Some(mismatch) } else { None }
}

/// Records a mismatch reported by the link driver. Idempotent per pair: the
/// driver calls this every mismatched pass, but the evidence is written and
/// the caches quarantined once. A repeated pass finishes an interrupted
/// quarantine instead.
pub async fn note_mismatch(context: &crate::daemon::DaemonContext, expected: &str, actual: &str) {
    if let Some(record) = content_blocked(context) {
        if record.expected_installation_id == expected && record.actual_installation_id == actual {
            if !record.quarantine_complete {
                log_failure("quarantine_resume_failed", finish_quarantine(context, record).await);
            }
            return;
        }
        // A different pair supersedes the record. Finish an unfinished
        // quarantine first, so its moves are never orphaned by the new plan.
        if !record.quarantine_complete && finish_quarantine(context, record).await.is_err() {
            return;
        }
    }
    let Some(db) = context.db() else {
        tracing::warn!(component = "mismatch", event = "state_unavailable");
        return;
    };
    let binding = db.run(|conn| edge_state::repo::binding::get(conn)).await.ok().flatten();
    let Some(bound) = binding else { return };
    let stamp = context.now().unix_millis();
    let record = MismatchRecord {
        server_url: bound.server_url,
        expected_installation_id: expected.to_owned(),
        actual_installation_id: actual.to_owned(),
        detected_at: context.now(),
        last_contact_at: *context.last_server_contact.lock().unwrap_or_else(|poison| poison.into_inner()),
        quarantined_cas_dir: planned_name(&context.paths.cas_root(), stamp, "cas"),
        quarantined_partial_dir: planned_name(&context.paths.partial_dir(), stamp, "partial"),
        quarantine_complete: false,
    };
    // The plan is durable before anything moves: a crash after this point
    // resumes the same moves instead of losing track of them.
    if let Err(error) = store(db, &record).await {
        tracing::warn!(component = "mismatch", event = "record_store_failed", error = %error);
        return;
    }
    set_record(context, Some(record.clone()));
    // A recovered server clears this record on the first verified pass, and
    // only a heartbeat clears it. Ask for one now instead of waiting for the
    // status interval.
    context.report_status_soon();
    tracing::error!(component = "server", event = "installation_mismatch_recorded");
    // Stop showing server content now. The gate keeps the surface up while
    // the quarantine finishes.
    show_status(context, mismatch_surface(&record)).await;
    log_failure("quarantine_failed", finish_quarantine(context, record).await);
}

/// Clears a recorded mismatch: a re-pair supersedes it, an unpair forgets
/// it, and a recovered server (a heartbeat built after a verified pass)
/// proves it stale. An unfinished quarantine is finished first, so the
/// caches are never trusted again.
pub async fn clear_mismatch(context: &crate::daemon::DaemonContext) {
    if let Some(record) = content_blocked(context)
        && !record.quarantine_complete
        && let Err(error) = finish_quarantine(context, record).await
    {
        tracing::warn!(component = "mismatch", event = "quarantine_resume_failed", error = %error);
        return;
    }
    if let Some(db) = context.db()
        && let Err(error) = db.run(|conn| edge_state::repo::installation_mismatch::clear(conn)).await
    {
        tracing::warn!(component = "mismatch", event = "record_clear_failed", error = %error);
        return;
    }
    set_record(context, None);
    // The mismatch surface stays until a new activation replaces it. Show
    // the status surface now; a manifest activation takes over if one exists.
    let mut engine = context.presentation.lock().await;
    if engine
        .current()
        .is_some_and(|activation| activation.source == crate::presentation::ActivationSource::StatusSurface)
    {
        let _ = engine.activate(
            crate::daemon::status_surface_for(context, true),
            Vec::new(),
            None,
            crate::presentation::ActivationSource::StatusSurface,
            context.now().unix_millis(),
        );
    }
    drop(engine);
    context.manifest_wake.notify_one();
}

/// Finishes a recorded quarantine and returns the completed record. Startup
/// runs it before the CAS opens; the link driver, clear, and unpair reach it
/// through [`finish_quarantine`]. A failure leaves the record incomplete, and
/// the next attempt redoes only what has not happened.
pub async fn reconcile_quarantine(
    paths: &edge_platform::paths::EdgePaths,
    db: &edge_state::StateDb,
    record: &MismatchRecord,
) -> Result<MismatchRecord, String> {
    let cas_root = paths.cas_root();
    let partial_root = paths.partial_dir();
    let cas = move_aside(&cas_root, record.quarantined_cas_dir.as_deref()).map_err(|e| format!("cas move: {e}"))?;
    let partial = move_aside(&partial_root, record.quarantined_partial_dir.as_deref())
        .map_err(|e| format!("partial move: {e}"))?;
    ensure_fresh_dir(&cas_root).map_err(|e| format!("cas recreate: {e}"))?;
    ensure_fresh_dir(&partial_root).map_err(|e| format!("partial recreate: {e}"))?;
    // Every object, partial, and pin row describes a file that moved away.
    // Forgetting them is safe: the next activation re-prepares what it needs.
    db.run(edge_state::repo::cas::forget_all).await.map_err(|error| format!("cas metadata: {error}"))?;
    let complete = MismatchRecord {
        quarantined_cas_dir: cas,
        quarantined_partial_dir: partial,
        quarantine_complete: true,
        ..record.clone()
    };
    let stored = complete.clone();
    db.run(move |conn| edge_state::repo::installation_mismatch::put(conn, &stored))
        .await
        .map_err(|error| format!("record completion: {error}"))?;
    Ok(complete)
}

/// Finishes the quarantine for the running daemon and updates the gate.
async fn finish_quarantine(
    context: &crate::daemon::DaemonContext,
    record: MismatchRecord,
) -> Result<MismatchRecord, String> {
    let db = context.db().ok_or_else(|| "state unavailable".to_owned())?;
    let complete = reconcile_quarantine(&context.paths, db, &record).await?;
    set_record(context, Some(complete.clone()));
    Ok(complete)
}

async fn store(db: &edge_state::StateDb, record: &MismatchRecord) -> Result<(), edge_state::StateError> {
    let stored = record.clone();
    db.run(move |conn| edge_state::repo::installation_mismatch::put(conn, &stored)).await
}

fn set_record(context: &crate::daemon::DaemonContext, record: Option<MismatchRecord>) {
    *context.installation_mismatch.lock().unwrap_or_else(|poison| poison.into_inner()) = record;
}

async fn show_status(context: &crate::daemon::DaemonContext, surface: PresentationDocument) {
    let mut engine = context.presentation.lock().await;
    let _ = engine.activate(
        surface,
        Vec::new(),
        None,
        crate::presentation::ActivationSource::StatusSurface,
        context.now().unix_millis(),
    );
    drop(engine);
    context.manifest_wake.notify_one();
}

fn log_failure(event: &'static str, result: Result<MismatchRecord, String>) {
    if let Err(error) = result {
        tracing::warn!(component = "mismatch", event, error = %error);
    }
}

/// The directory name a quarantine of `dir` would take, when there is a
/// directory to move. Recorded before the move so a crash cannot lose it.
fn planned_name(dir: &Path, stamp: i64, label: &str) -> Option<String> {
    dir.exists().then(|| format!("{label}-quarantined-{stamp}"))
}

/// Moves `dir` to its planned sibling name. Idempotent: when the target
/// already exists, an earlier attempt made the move, and it is never repeated
/// (the recreated directory beside it holds no pre-mismatch content). Returns
/// the name when the evidence exists, or `None` when nothing was there.
fn move_aside(dir: &Path, name: Option<&str>) -> std::io::Result<Option<String>> {
    let Some(name) = name else { return Ok(None) };
    let target = dir.with_file_name(name);
    if target.exists() {
        return Ok(Some(name.to_owned()));
    }
    if !dir.exists() {
        return Ok(None);
    }
    std::fs::rename(dir, &target)?;
    Ok(Some(name.to_owned()))
}

/// Ensures an owner-only cache directory exists.
fn ensure_fresh_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if dir.is_dir() {
        return Ok(());
    }
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

/// The surface a mismatched screen shows instead of server content.
pub fn mismatch_surface(record: &MismatchRecord) -> PresentationDocument {
    PresentationDocument::Unavailable(StatusSurface {
        title: edge_protocol::bounded::SafeText::new("Server changed").expect("literal title"),
        message: edge_protocol::bounded::SafeText::new(format!(
            "This screen is paired to a different Tilecast Server installation (expected {}, reported {}). Re-pair the screen to continue.",
            short_id(&record.expected_installation_id),
            short_id(&record.actual_installation_id),
        ))
        .unwrap_or_else(|_| edge_protocol::bounded::SafeText::lossy("Re-pair the screen to continue.")),
        background_color: None,
        text_color: None,
        logo_src: None,
        footer_text: None,
        status: Some(edge_protocol::bounded::SafeText::new("installation-mismatch").expect("literal status")),
    })
}

fn short_id(value: &str) -> &str {
    value.split('-').next().unwrap_or(value)
}

/// The recorded mismatch, if any. Content stays off screen while it exists,
/// whether or not its quarantine has finished.
pub fn content_blocked(context: &crate::daemon::DaemonContext) -> Option<MismatchRecord> {
    context.installation_mismatch.lock().unwrap_or_else(|poison| poison.into_inner()).clone()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UnpairSummary {
    pub already_unpaired: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnpairError {
    /// No state database (recovery mode): nothing was touched.
    Unavailable,
    /// A store or file failed partway. The device may be half unpaired;
    /// re-running converges because every step is idempotent.
    Failed(String),
}

/// Forgets the server relationship. Every step is idempotent: an unpaired
/// device runs the same cleanup and reports `already_unpaired`, and a failed
/// run can simply be retried.
pub async fn unpair_device(context: &crate::daemon::DaemonContext) -> Result<UnpairSummary, UnpairError> {
    let Some(db) = context.db() else { return Err(UnpairError::Unavailable) };
    let bound = db
        .run(|conn| edge_state::repo::binding::get(conn))
        .await
        .map_err(|error| UnpairError::Failed(error.to_string()))?
        .is_some();
    let credential = edge_server::FileCredentialStore::read_at(&context.paths.identity_dir())
        .map_err(|error| UnpairError::Failed(format!("credential unreadable: {error}")))?
        .is_some();
    let already_unpaired = !bound && !credential;
    // The record is the only map of the moved caches. Finish an interrupted
    // quarantine before forgetting it.
    if let Some(record) = content_blocked(context)
        && !record.quarantine_complete
    {
        finish_quarantine(context, record).await.map_err(UnpairError::Failed)?;
    }
    // Stop the link first: the next pass finds no binding and idles.
    *context.link_state.lock().unwrap_or_else(|poison| poison.into_inner()) = player_core::ServerLinkState::Unbound;
    context.command_server.send_replace(None);
    db.run(|conn| {
        let transaction = conn.transaction()?;
        edge_state::repo::binding::clear(&transaction)?;
        edge_state::repo::outbox::clear_all(&transaction)?;
        edge_state::repo::config::clear_all(&transaction)?;
        edge_state::repo::installation_mismatch::clear(&transaction)?;
        transaction.commit()?;
        Ok::<_, edge_state::StateError>(())
    })
    .await
    .map_err(|error| UnpairError::Failed(error.to_string()))?;
    // Both removals succeed when the file is already gone, so a retry after a
    // partial failure reaches this point and finishes the cleanup.
    edge_server::FileCredentialStore::remove_at(&context.paths.identity_dir())
        .map_err(|error| UnpairError::Failed(format!("credential removal failed: {error}")))?;
    edge_server::FilePairingStore::remove_at(&context.paths.identity_dir())
        .map_err(|error| UnpairError::Failed(format!("pairing removal failed: {error}")))?;
    set_record(context, None);
    *context.last_server_contact.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
    // Show the setup surface so the screen can pair again.
    let now = context.now().unix_millis();
    let mut engine = context.presentation.lock().await;
    let _ = engine.activate(
        PresentationDocument::Setup {},
        Vec::new(),
        None,
        crate::presentation::ActivationSource::StatusSurface,
        now,
    );
    drop(engine);
    context.server_wake.notify_one();
    context.manifest_wake.notify_one();
    if !already_unpaired {
        tracing::info!(component = "device", event = "unpaired");
    }
    Ok(UnpairSummary { already_unpaired })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> MismatchRecord {
        MismatchRecord {
            server_url: "https://tilecast.example".into(),
            expected_installation_id: "11111111-1111-1111-1111-111111111111".into(),
            actual_installation_id: "22222222-2222-2222-2222-222222222222".into(),
            detected_at: edge_protocol::Timestamp::from_unix_millis(1_000).unwrap(),
            last_contact_at: None,
            quarantined_cas_dir: Some("cas-quarantined-1000".into()),
            quarantined_partial_dir: None,
            quarantine_complete: true,
        }
    }

    #[test]
    fn mismatch_surface_names_both_installations() {
        let PresentationDocument::Unavailable(surface) = mismatch_surface(&record()) else {
            panic!("unavailable surface")
        };
        assert_eq!(surface.title.as_str(), "Server changed");
        assert!(surface.message.as_str().contains("11111111"), "{}", surface.message.as_str());
        assert!(surface.message.as_str().contains("22222222"), "{}", surface.message.as_str());
        assert_eq!(surface.status.as_ref().map(|status| status.as_str()), Some("installation-mismatch"));
    }

    #[test]
    fn quarantine_moves_the_cache_aside_and_recreates_it() {
        let dir = tempfile::tempdir().unwrap();
        let cas = dir.path().join("cas");
        std::fs::create_dir_all(cas.join("sha256")).unwrap();
        std::fs::write(cas.join("sha256").join("object"), b"bytes").unwrap();
        let name = planned_name(&cas, 1_000, "cas").expect("cache exists");
        assert_eq!(name, "cas-quarantined-1000");
        assert_eq!(move_aside(&cas, Some(&name)).unwrap(), Some(name.clone()));
        ensure_fresh_dir(&cas).unwrap();
        assert!(dir.path().join(&name).join("sha256").join("object").exists(), "evidence preserved");
        assert!(cas.is_dir(), "fresh cache recreated");
        assert_eq!(planned_name(&dir.path().join("missing"), 1_000, "cas"), None);
    }

    #[test]
    fn a_move_that_already_happened_is_never_repeated() {
        let dir = tempfile::tempdir().unwrap();
        let cas = dir.path().join("cas");
        std::fs::create_dir_all(&cas).unwrap();
        std::fs::write(cas.join("old"), b"pre-mismatch").unwrap();
        move_aside(&cas, Some("cas-quarantined-7")).unwrap();
        // The restart recreates the cache and the recreated copy gets content.
        ensure_fresh_dir(&cas).unwrap();
        std::fs::write(cas.join("new"), b"post-restart").unwrap();
        // Resuming the same plan must keep the evidence and leave the new cache alone.
        assert_eq!(move_aside(&cas, Some("cas-quarantined-7")).unwrap(), Some("cas-quarantined-7".into()));
        assert!(dir.path().join("cas-quarantined-7").join("old").exists(), "evidence kept");
        assert!(cas.join("new").exists(), "the recreated cache is not moved a second time");
    }

    #[test]
    fn a_plan_without_a_directory_records_no_move() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(move_aside(&dir.path().join("cas"), None).unwrap(), None);
        assert_eq!(move_aside(&dir.path().join("cas"), Some("cas-quarantined-1")).unwrap(), None);
    }
}
