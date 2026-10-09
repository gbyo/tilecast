//! Durable playlist resume: an ordinary playlist restarts at its last
//! reliably presented item after a daemon restart, reboot, or power cut.
//!
//! The Linux player's `playback-checkpoint.json`, ported to the Edge state
//! database: the checkpoint carries the server binding, manifest version
//! and digest, playlist, item, and presentation time. The daemon writes it
//! on accepted item evidence and consumes it at the first ordinary playlist
//! projection after a cold start.
//!
//! Two rules keep this safe. Rotation never rewrites the server manifest:
//! it reorders the projected items in memory. And the applied rotation
//! sticks for the session: every projection of the same manifest and
//! playlist starts at the same item, so the offline activation key stays
//! stable instead of flapping between a resumed and an unresumed document.

use edge_protocol::Timestamp;
use edge_protocol::ipc::presentation::PresentationDocument;

use crate::manifest::ResolvedPresentation;

pub use edge_state::repo::playback_checkpoint::PlaybackCheckpoint;

/// A checkpoint older than this never resumes: the playlist has moved on.
pub const CHECKPOINT_FRESHNESS_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Default)]
pub struct ResumeBinding {
    pub installation_id: String,
    pub screen_id: String,
    pub server_url: String,
}

#[derive(Debug, Clone)]
struct AppliedRotation {
    manifest_digest: String,
    manifest_version: i64,
    playlist_id: String,
    item_id: String,
}

/// Resume state, held behind a synchronous mutex: the offline projection
/// path that consumes it cannot await.
#[derive(Debug, Default)]
pub struct ResumeState {
    binding: Option<ResumeBinding>,
    pending: Option<PlaybackCheckpoint>,
    applied: Option<AppliedRotation>,
    last_written: Option<(String, String, String)>,
}

impl ResumeState {
    pub fn loaded(binding: Option<ResumeBinding>, pending: Option<PlaybackCheckpoint>) -> Self {
        Self { binding, pending, applied: None, last_written: None }
    }

    /// Whether a checkpoint write would say anything new. Duplicate item
    /// evidence must not cost a SQLite transaction per progress report.
    pub fn needs_write(&self, manifest_digest: &str, playlist_id: &str, item_id: &str) -> bool {
        self.last_written.as_ref().is_none_or(|(digest, playlist, item)| {
            digest != manifest_digest || playlist != playlist_id || item != item_id
        })
    }

    pub fn mark_written(&mut self, manifest_digest: &str, playlist_id: &str, item_id: &str) {
        self.last_written = Some((manifest_digest.to_owned(), playlist_id.to_owned(), item_id.to_owned()));
    }
}

/// Loads the resume state at startup: the current binding plus the stored
/// checkpoint, if any. A missing database, binding, or row means no resume;
/// nothing here fails startup.
pub async fn load_resume_state(db: &edge_state::StateDb) -> ResumeState {
    let binding = db.run(|conn| edge_state::repo::binding::get(conn)).await.ok().flatten().and_then(|bound| {
        bound.screen_id.map(|screen| ResumeBinding {
            installation_id: bound.installation_id.to_string(),
            screen_id: screen.to_string(),
            server_url: bound.server_url,
        })
    });
    let pending = db.run(|conn| edge_state::repo::playback_checkpoint::get(conn)).await.ok().flatten();
    ResumeState::loaded(binding, pending)
}

/// Records accepted item evidence as the resume checkpoint. Best effort and
/// coalesced: only a new (manifest, playlist, item) triple writes, and a
/// failed write is logged, never fatal.
pub async fn note_item_evidence(
    context: &crate::daemon::DaemonContext,
    item_id: &str,
    identity: &crate::presentation::PlaybackIdentity,
    now: Timestamp,
) {
    let Some(playlist_id) = identity.playlist_id else { return };
    if identity.layout_id.is_some() || identity.takeover_id.is_some() {
        return;
    }
    if !matches!(identity.selection_source, "direct" | "schedule") {
        return;
    }
    let manifest_digest = identity.manifest.to_hex();
    let playlist_id = playlist_id.to_string();
    let binding = {
        let mut resume = context.resume.lock().unwrap_or_else(|poison| poison.into_inner());
        if !resume.needs_write(&manifest_digest, &playlist_id, item_id) {
            return;
        }
        let Some(binding) = resume.binding.clone() else { return };
        resume.mark_written(&manifest_digest, &playlist_id, item_id);
        binding
    };
    let Some(db) = context.db() else { return };
    let checkpoint = PlaybackCheckpoint {
        installation_id: binding.installation_id,
        screen_id: binding.screen_id,
        server_url: binding.server_url,
        manifest_version: identity.manifest_version,
        manifest_digest,
        playlist_id,
        item_id: item_id.to_owned(),
        presented_at: now,
        updated_at: now,
    };
    if let Err(error) = db.run(move |conn| edge_state::repo::playback_checkpoint::put(conn, &checkpoint)).await {
        tracing::warn!(component = "resume", event = "checkpoint_store_failed", error = %error);
    }
}

/// Rotates a projected playlist once at cold start, when the stored
/// checkpoint is valid for the authoritative selection. The rotation sticks
/// for the session so repeated projections keep one stable document; a new
/// manifest or playlist starts from the head. Anything invalid falls back
/// to the ordinary order with one bounded log line.
pub fn maybe_rotate(
    state: &mut ResumeState,
    resolved: &mut ResolvedPresentation,
    manifest_digest: &str,
    manifest_version: i64,
    resume_allowed: bool,
    now_ms: i64,
) {
    let PresentationDocument::Playing { items, .. } = &mut resolved.document else { return };
    if items.len() < 2 {
        return;
    }
    // A synchronized group plays its anchor, never a checkpoint.
    if resolved.timing.is_some() {
        return;
    }
    let selection = &resolved.selection;
    let is_ordinary_playlist = selection.playlist_id.is_some()
        && selection.layout_id.is_none()
        && selection.takeover_id.is_none()
        && matches!(selection.source, player_core::Source::Direct | player_core::Source::Schedule);
    if !is_ordinary_playlist {
        return;
    }
    let playlist_id = selection.playlist_id.map(|id| id.to_string()).unwrap_or_default();
    if let Some(applied) = state.applied.as_ref() {
        if applied.manifest_digest == manifest_digest
            && applied.manifest_version == manifest_version
            && applied.playlist_id == playlist_id
        {
            rotate_to(items, &applied.item_id);
        } else {
            // A new manifest or playlist starts from the head.
            state.applied = None;
        }
        return;
    }
    if !resume_allowed {
        state.pending = None;
        return;
    }
    let Some(checkpoint) = state.pending.take() else { return };
    let reason = validate(&checkpoint, state.binding.as_ref(), manifest_digest, manifest_version, &playlist_id, now_ms);
    if let Err(reason) = reason {
        tracing::info!(component = "resume", event = "checkpoint_skipped", reason);
        return;
    }
    if rotate_to(items, &checkpoint.item_id) {
        tracing::info!(component = "resume", event = "playlist_resumed", item = checkpoint.item_id.as_str());
        state.applied = Some(AppliedRotation {
            manifest_digest: manifest_digest.to_owned(),
            manifest_version,
            playlist_id,
            item_id: checkpoint.item_id,
        });
    } else {
        tracing::info!(component = "resume", event = "checkpoint_skipped", reason = "item_absent");
    }
}

/// Rotates `items` so `item_id` comes first. False when the item is absent
/// or already first: no reorder, no activation churn.
fn rotate_to(items: &mut [edge_protocol::ipc::presentation::PresentationItem], item_id: &str) -> bool {
    let Some(index) = items.iter().position(|item| item.id.as_str() == item_id) else { return false };
    if index == 0 {
        return false;
    }
    items.rotate_left(index);
    true
}

fn validate(
    checkpoint: &PlaybackCheckpoint,
    binding: Option<&ResumeBinding>,
    manifest_digest: &str,
    manifest_version: i64,
    playlist_id: &str,
    now_ms: i64,
) -> Result<(), &'static str> {
    let Some(binding) = binding else { return Err("unbound") };
    if checkpoint.installation_id != binding.installation_id
        || checkpoint.screen_id != binding.screen_id
        || checkpoint.server_url != binding.server_url
    {
        return Err("binding_changed");
    }
    if checkpoint.manifest_digest != manifest_digest || checkpoint.manifest_version != manifest_version {
        return Err("manifest_changed");
    }
    if checkpoint.playlist_id != playlist_id {
        return Err("selection_changed");
    }
    if now_ms - checkpoint.updated_at.unix_millis() > CHECKPOINT_FRESHNESS_MS {
        return Err("checkpoint_stale");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use edge_protocol::bounded::{SafeText, ShortToken};
    use edge_protocol::ipc::presentation::{ItemKind, PresentationItem};
    use player_core::{Selection, Source};

    fn item(id: &str) -> PresentationItem {
        PresentationItem {
            id: SafeText::new(id).unwrap(),
            kind: ItemKind::Image,
            src: SafeText::new("tcmedia://cap/x").unwrap(),
            duration_ms: Some(10_000),
            fit_mode: ShortToken::new("contain").unwrap(),
            transition: None,
            audio_enabled: false,
            volume: 0.0,
            video_start_offset_ms: None,
            video_end_offset_ms: None,
            viewport: None,
            website: None,
            widget: None,
            layout: None,
        }
    }

    fn playing(ids: &[&str]) -> PresentationDocument {
        PresentationDocument::Playing {
            items: ids.iter().map(|id| item(id)).collect(),
            takeover: false,
            generation: 1,
            synchronized: false,
            requires: Vec::new(),
        }
    }

    fn selection() -> Selection {
        Selection {
            playlist_id: Some(uuid::Uuid::from_u128(7)),
            layout_id: None,
            schedule_id: None,
            takeover_id: None,
            source: Source::Direct,
            next_transition_ms: None,
            playback_anchor_ms: None,
        }
    }

    fn resolved(ids: &[&str]) -> ResolvedPresentation {
        ResolvedPresentation {
            document: playing(ids),
            timing: None,
            content: Vec::new(),
            projection: None,
            plugins: Vec::new(),
            plugin_aliases: Vec::new(),
            selection: selection(),
            next_transition_ms: None,
        }
    }

    fn checkpoint(item: &str) -> PlaybackCheckpoint {
        PlaybackCheckpoint {
            installation_id: "installation".into(),
            screen_id: "screen".into(),
            server_url: "https://tilecast.example".into(),
            manifest_version: 3,
            manifest_digest: "digest".into(),
            playlist_id: uuid::Uuid::from_u128(7).to_string(),
            item_id: item.into(),
            presented_at: Timestamp::from_unix_millis(1_000).unwrap(),
            updated_at: Timestamp::from_unix_millis(1_000).unwrap(),
        }
    }

    fn state(item: &str) -> ResumeState {
        ResumeState::loaded(
            Some(ResumeBinding {
                installation_id: "installation".into(),
                screen_id: "screen".into(),
                server_url: "https://tilecast.example".into(),
            }),
            Some(checkpoint(item)),
        )
    }

    fn order(resolved: &ResolvedPresentation) -> Vec<String> {
        let PresentationDocument::Playing { items, .. } = &resolved.document else { panic!("playing") };
        items.iter().map(|item| item.id.as_str().to_owned()).collect()
    }

    #[test]
    fn resume_rotates_once_and_sticks_across_projections() {
        let mut resume = state("item-2");
        let mut first = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut first, "digest", 3, true, 2_000);
        assert_eq!(order(&first), ["item-2", "item-0", "item-1"]);
        // The next projection of the same manifest rotates identically, so
        // the activation key never flaps back to the unresumed order.
        let mut second = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut second, "digest", 3, true, 3_000);
        assert_eq!(order(&second), ["item-2", "item-0", "item-1"]);
    }

    #[test]
    fn invalid_checkpoints_fall_back_to_the_ordinary_order() {
        for (name, mutate, digest, version, playlist) in [
            ("binding", "installation-2", "digest", 3, uuid::Uuid::from_u128(7).to_string()),
            ("manifest version", "installation", "digest", 4, uuid::Uuid::from_u128(7).to_string()),
            ("manifest digest", "installation", "digest-2", 3, uuid::Uuid::from_u128(7).to_string()),
            ("playlist", "installation", "digest", 3, uuid::Uuid::from_u128(9).to_string()),
        ] {
            let mut stored = checkpoint("item-2");
            stored.installation_id = mutate.into();
            let mut resume = ResumeState::loaded(
                Some(ResumeBinding {
                    installation_id: "installation".into(),
                    screen_id: "screen".into(),
                    server_url: "https://tilecast.example".into(),
                }),
                Some(stored),
            );
            let mut projection = resolved(&["item-0", "item-1", "item-2"]);
            if playlist != uuid::Uuid::from_u128(7).to_string() {
                projection.selection.playlist_id = Some(uuid::Uuid::from_u128(9));
            }
            maybe_rotate(&mut resume, &mut projection, digest, version, true, 2_000);
            assert_eq!(order(&projection), ["item-0", "item-1", "item-2"], "{name}");
        }
        // Stale, disabled, removed item, and already-first all keep the head.
        let mut resume = state("item-2");
        let mut stale = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut stale, "digest", 3, true, 1_000 + CHECKPOINT_FRESHNESS_MS + 1);
        assert_eq!(order(&stale), ["item-0", "item-1", "item-2"]);
        let mut resume = state("item-2");
        let mut disabled = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut disabled, "digest", 3, false, 2_000);
        assert_eq!(order(&disabled), ["item-0", "item-1", "item-2"]);
        let mut resume = state("item-9");
        let mut removed = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut removed, "digest", 3, true, 2_000);
        assert_eq!(order(&removed), ["item-0", "item-1", "item-2"]);
        let mut resume = state("item-0");
        let mut first = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut first, "digest", 3, true, 2_000);
        assert_eq!(order(&first), ["item-0", "item-1", "item-2"]);
    }

    #[test]
    fn excluded_presentations_never_rotate() {
        // Takeover, layout, and synchronized projections keep the pending
        // checkpoint for the next ordinary playlist instead of consuming it.
        let mut resume = state("item-2");
        let mut takeover = resolved(&["item-0", "item-1", "item-2"]);
        takeover.selection.source = Source::Takeover;
        takeover.selection.takeover_id = Some(uuid::Uuid::from_u128(11));
        maybe_rotate(&mut resume, &mut takeover, "digest", 3, true, 2_000);
        assert_eq!(order(&takeover), ["item-0", "item-1", "item-2"]);
        assert!(resume.pending.is_some(), "takeover keeps the checkpoint");
        // The ordinary playlist that follows still resumes.
        let mut next = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut next, "digest", 3, true, 2_000);
        assert_eq!(order(&next), ["item-2", "item-0", "item-1"]);
    }

    #[test]
    fn a_new_manifest_or_playlist_starts_from_the_head() {
        let mut resume = state("item-2");
        let mut first = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut first, "digest", 3, true, 2_000);
        assert_eq!(order(&first), ["item-2", "item-0", "item-1"]);
        let mut newer = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut resume, &mut newer, "digest", 4, true, 3_000);
        assert_eq!(order(&newer), ["item-0", "item-1", "item-2"]);
    }

    #[test]
    fn duplicate_item_evidence_needs_no_write() {
        let mut resume = ResumeState::default();
        assert!(resume.needs_write("digest", "playlist", "item-1"));
        resume.mark_written("digest", "playlist", "item-1");
        assert!(!resume.needs_write("digest", "playlist", "item-1"));
        assert!(resume.needs_write("digest", "playlist", "item-2"));
    }
}
