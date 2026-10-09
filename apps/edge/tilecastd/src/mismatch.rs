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
//! Unpair is the operator's way out: forget the binding, credential,
//! pairing files, queued results, and staged configuration, then show the
//! setup surface so the screen can pair again. It is idempotent, so a
//! failed run converges on retry.

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
/// the caches quarantined once.
pub async fn note_mismatch(context: &crate::daemon::DaemonContext, expected: &str, actual: &str) {
    {
        let recorded = context.installation_mismatch.lock().unwrap_or_else(|poison| poison.into_inner());
        if recorded.as_ref().is_some_and(|record| {
            record.expected_installation_id == expected && record.actual_installation_id == actual
        }) {
            return;
        }
    }
    let Some(db) = context.db() else {
        tracing::warn!(component = "mismatch", event = "state_unavailable");
        return;
    };
    let binding = db.run(|conn| edge_state::repo::binding::get(conn)).await.ok().flatten();
    let Some(bound) = binding else { return };
    let now = context.now();
    let last_contact = *context.last_server_contact.lock().unwrap_or_else(|poison| poison.into_inner());
    let (cas_dir, partial_dir) = quarantine_caches(context);
    let record = MismatchRecord {
        server_url: bound.server_url,
        expected_installation_id: expected.to_owned(),
        actual_installation_id: actual.to_owned(),
        detected_at: now,
        last_contact_at: last_contact,
        quarantined_cas_dir: cas_dir,
        quarantined_partial_dir: partial_dir,
    };
    let stored = record.clone();
    if let Err(error) = db.run(move |conn| edge_state::repo::installation_mismatch::put(conn, &stored)).await {
        tracing::warn!(component = "mismatch", event = "record_store_failed", error = %error);
        return;
    }
    *context.installation_mismatch.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(record.clone());
    tracing::error!(component = "server", event = "installation_mismatch_recorded");
    // Stop showing server content now, even with no manifest projecting: the
    // projection gate keeps the surface up afterwards.
    let surface = mismatch_surface(&record);
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

/// Clears a recorded mismatch: a re-pair supersedes it, an unpair forgets
/// it, and a recovered server (a heartbeat built after a verified pass)
/// proves it stale.
pub async fn clear_mismatch(context: &crate::daemon::DaemonContext) {
    if let Some(db) = context.db()
        && let Err(error) = db.run(|conn| edge_state::repo::installation_mismatch::clear(conn)).await
    {
        tracing::warn!(component = "mismatch", event = "record_clear_failed", error = %error);
        return;
    }
    *context.installation_mismatch.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
}

/// Moves the protected caches aside so pre-mismatch server content can never
/// serve again, and recreates fresh owner-only directories. Returns the
/// quarantine directory names for the evidence row; a failed move is logged
/// and left out rather than failing the record.
fn quarantine_caches(context: &crate::daemon::DaemonContext) -> (Option<String>, Option<String>) {
    let stamp = context.now().unix_millis();
    let cas = quarantine_dir(&context.paths.cas_root(), stamp, "cas");
    let partial = quarantine_dir(&context.paths.partial_dir(), stamp, "partial");
    (cas, partial)
}

fn quarantine_dir(dir: &std::path::Path, stamp: i64, label: &str) -> Option<String> {
    use std::os::unix::fs::DirBuilderExt;
    if !dir.exists() {
        return None;
    }
    let name = format!("{label}-quarantined-{stamp}");
    let target = dir.with_file_name(&name);
    if let Err(error) = std::fs::rename(dir, &target) {
        tracing::warn!(component = "mismatch", event = "quarantine_failed", dir = %dir.display(), error = %error);
        return None;
    }
    if let Err(error) = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir) {
        tracing::warn!(component = "mismatch", event = "quarantine_recreate_failed", dir = %dir.display(), error = %error);
    }
    Some(name)
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

/// Whether server content must stay off screen: a recorded mismatch whose
/// binding still matches it.
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
/// device succeeds, and a failed run can simply be retried.
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
    if !bound && !credential {
        return Ok(UnpairSummary { already_unpaired: true });
    }
    // Stop the link first: the next pass finds no binding and idles.
    *context.link_state.lock().unwrap_or_else(|poison| poison.into_inner()) = player_core::ServerLinkState::Unbound;
    context.command_server.send_replace(None);
    db.run(|conn| {
        edge_state::repo::binding::clear(conn)?;
        edge_state::repo::outbox::clear_all(conn)?;
        edge_state::repo::config::clear_all(conn)?;
        edge_state::repo::installation_mismatch::clear(conn)?;
        Ok::<_, edge_state::StateError>(())
    })
    .await
    .map_err(|error| UnpairError::Failed(error.to_string()))?;
    edge_server::FileCredentialStore::remove_at(&context.paths.identity_dir())
        .map_err(|error| UnpairError::Failed(format!("credential removal failed: {error}")))?;
    edge_server::FilePairingStore::remove_at(&context.paths.identity_dir())
        .map_err(|error| UnpairError::Failed(format!("pairing removal failed: {error}")))?;
    *context.installation_mismatch.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
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
    tracing::info!(component = "device", event = "unpaired");
    Ok(UnpairSummary { already_unpaired: false })
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
        let name = quarantine_dir(&cas, 1_000, "cas").expect("quarantined");
        assert_eq!(name, "cas-quarantined-1000");
        assert!(dir.path().join(&name).join("sha256").join("object").exists(), "evidence preserved");
        assert!(cas.is_dir(), "fresh cache recreated");
        assert!(quarantine_dir(&dir.path().join("missing"), 1_000, "cas").is_none());
    }
}
