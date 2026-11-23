//! Durable Android playlist resume using the shared Player State checkpoint.
//!
//! The checkpoint is consumed only for the first ordinary, unsynchronized
//! playlist after a cold start. Accepted meaningful item evidence writes the
//! current item back to the same shared row used by the other native Players.

use std::sync::{Arc, Mutex};

use player_state::StateDb;
use player_state::repo::{binding, playback_checkpoint};
use player_types::Timestamp;

use crate::renderer::PlaybackIdentity;
use crate::selection::ResolvedPresentation;

pub const CHECKPOINT_FRESHNESS_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
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

#[derive(Debug, Default)]
pub struct ResumeState {
    binding: Option<ResumeBinding>,
    pending: Option<playback_checkpoint::PlaybackCheckpoint>,
    applied: Option<AppliedRotation>,
    last_written: Option<(String, String, String)>,
    projected_manifest: Option<(String, serde_json::Value)>,
}

impl ResumeState {
    fn loaded(
        binding: Option<ResumeBinding>,
        pending: Option<playback_checkpoint::PlaybackCheckpoint>,
    ) -> Self {
        Self {
            binding,
            pending,
            applied: None,
            last_written: None,
            projected_manifest: None,
        }
    }

    fn set_binding(&mut self, binding: Option<ResumeBinding>) {
        if self.binding != binding {
            self.pending = None;
            self.applied = None;
            self.last_written = None;
        }
        self.binding = binding;
    }

    fn observe_manifest(&mut self, document: &serde_json::Value, digest: &str, version: i64) {
        if self
            .projected_manifest
            .as_ref()
            .is_some_and(|(previous, _)| previous == digest)
        {
            return;
        }
        if let Some((previous, active)) = self.projected_manifest.as_ref()
            && player_core::is_plugin_only_revision(active, document)
            && let Some(applied) = self
                .applied
                .as_mut()
                .filter(|rotation| rotation.manifest_digest == *previous)
        {
            applied.manifest_digest = digest.to_owned();
            applied.manifest_version = version;
        }
        self.projected_manifest = Some((digest.to_owned(), document.clone()));
    }

    fn needs_write(&self, manifest_digest: &str, playlist_id: &str, item_id: &str) -> bool {
        self.last_written
            .as_ref()
            .is_none_or(|(digest, playlist, item)| {
                digest != manifest_digest || playlist != playlist_id || item != item_id
            })
    }

    fn mark_written(&mut self, manifest_digest: &str, playlist_id: &str, item_id: &str) {
        self.last_written = Some((
            manifest_digest.to_owned(),
            playlist_id.to_owned(),
            item_id.to_owned(),
        ));
    }
}

fn binding_value(bound: binding::ServerBinding) -> Option<ResumeBinding> {
    bound.screen_id.map(|screen| ResumeBinding {
        installation_id: bound.installation_id.to_string(),
        screen_id: screen.to_string(),
        server_url: bound.server_url,
    })
}

/// Startup-only load. Android opens Player State before its async drivers.
pub fn load_resume_state(state: &StateDb) -> ResumeState {
    let binding = state
        .run_blocking(|connection| binding::get(connection))
        .ok()
        .flatten()
        .and_then(binding_value);
    let pending = state
        .run_blocking(|connection| playback_checkpoint::get(connection))
        .ok()
        .flatten();
    ResumeState::loaded(binding, pending)
}

/// Pairing can establish a binding after process start. Refresh it before the
/// manifest loop projects the newly enrolled screen.
pub async fn refresh_binding(state: &StateDb, resume: &Arc<Mutex<ResumeState>>) {
    let binding = state
        .run(|connection| binding::get(connection))
        .await
        .ok()
        .flatten()
        .and_then(binding_value);
    resume
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .set_binding(binding);
}

/// An explicit server reset must not let the old relationship keep writing
/// checkpoints while setup owns the screen.
pub fn clear_binding(resume: &Arc<Mutex<ResumeState>>) {
    resume
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .set_binding(None);
}

/// Persist one accepted, meaningful item report. Layouts, takeovers,
/// Quick Present and synchronized projections are intentionally excluded.
pub async fn note_item_evidence(
    state: &StateDb,
    resume: &Arc<Mutex<ResumeState>>,
    item_id: &str,
    identity: &PlaybackIdentity,
    now: Timestamp,
) {
    let Some(playlist_id) = identity.playlist_id else {
        return;
    };
    if identity.layout_id.is_some()
        || identity.takeover_id.is_some()
        || !matches!(identity.selection_source.as_str(), "direct" | "schedule")
    {
        return;
    }
    let manifest_digest = identity.manifest.to_hex();
    let playlist_id = playlist_id.to_string();
    let binding = {
        let resume = resume.lock().unwrap_or_else(|error| error.into_inner());
        if !resume.needs_write(&manifest_digest, &playlist_id, item_id) {
            return;
        }
        resume.binding.clone()
    };
    let Some(binding) = binding else {
        return;
    };
    let checkpoint = playback_checkpoint::PlaybackCheckpoint {
        installation_id: binding.installation_id,
        screen_id: binding.screen_id,
        server_url: binding.server_url,
        manifest_version: identity.manifest_version,
        manifest_digest: manifest_digest.clone(),
        playlist_id: playlist_id.clone(),
        item_id: item_id.to_owned(),
        presented_at: now,
        updated_at: now,
    };
    if state
        .run(move |connection| playback_checkpoint::put(connection, &checkpoint))
        .await
        .is_ok()
    {
        resume
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .mark_written(&manifest_digest, &playlist_id, item_id);
    }
}

/// Apply the cold-start checkpoint to the projected item order. The applied
/// rotation remains stable for repeated projections of the same selection.
pub fn maybe_rotate(
    state: &mut ResumeState,
    resolved: &mut ResolvedPresentation,
    manifest: &player_core::NativeManifest,
    resume_allowed: bool,
    now_ms: i64,
) {
    let manifest_digest = manifest.digest.to_hex();
    state.observe_manifest(&manifest.document, &manifest_digest, manifest.version);

    let Some(items) = resolved
        .document
        .get_mut("items")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    if items.len() < 2 || resolved.timing.is_some() {
        return;
    }
    let selection = &resolved.selection;
    let ordinary = selection.playlist_id.is_some()
        && selection.layout_id.is_none()
        && selection.takeover_id.is_none()
        && matches!(
            selection.source,
            player_core::Source::Direct | player_core::Source::Schedule
        );
    if !ordinary {
        return;
    }
    let playlist_id = selection
        .playlist_id
        .map(|id| id.to_string())
        .unwrap_or_default();

    if let Some(applied) = state.applied.as_ref() {
        if applied.manifest_digest == manifest_digest
            && applied.manifest_version == manifest.version
            && applied.playlist_id == playlist_id
        {
            rotate_to(items, &applied.item_id);
        } else {
            state.applied = None;
        }
        return;
    }
    if !resume_allowed {
        state.pending = None;
        return;
    }
    let Some(checkpoint) = state.pending.take() else {
        return;
    };
    if validate(
        &checkpoint,
        state.binding.as_ref(),
        &manifest_digest,
        manifest.version,
        &playlist_id,
        now_ms,
    )
    .is_err()
    {
        return;
    }
    if rotate_to(items, &checkpoint.item_id) {
        state.applied = Some(AppliedRotation {
            manifest_digest,
            manifest_version: manifest.version,
            playlist_id,
            item_id: checkpoint.item_id,
        });
    }
}

fn rotate_to(items: &mut [serde_json::Value], item_id: &str) -> bool {
    let Some(index) = items.iter().position(|item| {
        item.get("id").and_then(serde_json::Value::as_str) == Some(item_id)
    }) else {
        return false;
    };
    if index == 0 {
        return false;
    }
    items.rotate_left(index);
    true
}

fn validate(
    checkpoint: &playback_checkpoint::PlaybackCheckpoint,
    binding: Option<&ResumeBinding>,
    manifest_digest: &str,
    manifest_version: i64,
    playlist_id: &str,
    now_ms: i64,
) -> Result<(), ()> {
    let Some(binding) = binding else {
        return Err(());
    };
    if checkpoint.installation_id != binding.installation_id
        || checkpoint.screen_id != binding.screen_id
        || checkpoint.server_url != binding.server_url
        || checkpoint.manifest_digest != manifest_digest
        || checkpoint.manifest_version != manifest_version
        || checkpoint.playlist_id != playlist_id
        || now_ms.saturating_sub(checkpoint.updated_at.unix_millis()) > CHECKPOINT_FRESHNESS_MS
    {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_core::{Selection, Source};

    fn item(id: &str) -> serde_json::Value {
        serde_json::json!({"id": id, "kind": "image"})
    }

    fn resolved(ids: &[&str]) -> ResolvedPresentation {
        ResolvedPresentation {
            document: serde_json::json!({
                "state": "playing",
                "items": ids.iter().map(|id| item(id)).collect::<Vec<_>>(),
            }),
            timing: None,
            content: Vec::new(),
            frames: Vec::new(),
            projection: None,
            plugins: Vec::new(),
            plugin_aliases: Vec::new(),
            selection: Selection {
                playlist_id: Some(uuid::Uuid::from_u128(7)),
                layout_id: None,
                schedule_id: None,
                takeover_id: None,
                source: Source::Direct,
                next_transition_ms: None,
                playback_anchor_ms: None,
            },
            next_transition_ms: None,
        }
    }

    fn checkpoint(item_id: &str) -> playback_checkpoint::PlaybackCheckpoint {
        let at = Timestamp::from_unix_millis(1_000).expect("time");
        playback_checkpoint::PlaybackCheckpoint {
            installation_id: "installation".to_owned(),
            screen_id: "screen".to_owned(),
            server_url: "https://tilecast.example".to_owned(),
            manifest_version: 3,
            manifest_digest: player_types::Sha256Digest::of(b"manifest").to_hex(),
            playlist_id: uuid::Uuid::from_u128(7).to_string(),
            item_id: item_id.to_owned(),
            presented_at: at,
            updated_at: at,
        }
    }

    fn resume(item_id: &str) -> ResumeState {
        ResumeState::loaded(
            Some(ResumeBinding {
                installation_id: "installation".to_owned(),
                screen_id: "screen".to_owned(),
                server_url: "https://tilecast.example".to_owned(),
            }),
            Some(checkpoint(item_id)),
        )
    }

    fn manifest() -> player_core::NativeManifest {
        player_core::NativeManifest {
            version: 3,
            digest: player_types::Sha256Digest::of(b"manifest"),
            document: serde_json::json!({"playlist": {"items": [1,2,3]}}),
            assets: Vec::new(),
            frames: Vec::new(),
        }
    }

    fn order(resolved: &ResolvedPresentation) -> Vec<String> {
        resolved.document["items"]
            .as_array()
            .expect("items")
            .iter()
            .filter_map(|item| item.get("id")?.as_str().map(str::to_owned))
            .collect()
    }

    #[test]
    fn valid_checkpoint_rotates_and_sticks() {
        let mut state = resume("item-2");
        let mut first = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut state, &mut first, &manifest(), true, 2_000);
        assert_eq!(order(&first), ["item-2", "item-0", "item-1"]);

        let mut second = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut state, &mut second, &manifest(), true, 3_000);
        assert_eq!(order(&second), ["item-2", "item-0", "item-1"]);
    }

    #[test]
    fn disabled_or_nonordinary_playback_keeps_server_order() {
        let mut state = resume("item-2");
        let mut disabled = resolved(&["item-0", "item-1", "item-2"]);
        maybe_rotate(&mut state, &mut disabled, &manifest(), false, 2_000);
        assert_eq!(order(&disabled), ["item-0", "item-1", "item-2"]);

        let mut state = resume("item-2");
        let mut layout = resolved(&["item-0", "item-1", "item-2"]);
        layout.selection.layout_id = Some(uuid::Uuid::from_u128(8));
        maybe_rotate(&mut state, &mut layout, &manifest(), true, 2_000);
        assert_eq!(order(&layout), ["item-0", "item-1", "item-2"]);
    }
}
