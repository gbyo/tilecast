//! What the Server sees of the manifest lifecycle. Every native host sends
//! this one projection, so a held-back manifest reads the same everywhere.
use player_state::StateDb;
use player_state::repo::{
    binding,
    manifests::{self, Binding, Stage, TrialState},
};

use crate::ManifestPreparationStatus;

const MAX_SYNCHRONIZATION_ERROR: usize = 240;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestReport {
    pub active_version: Option<i64>,
    /// The pending manifest's version while it is prepared or on trial.
    /// A manifest held back after a failed trial is not reported as pending:
    /// the Server must not show it as still preparing.
    pub pending_version: Option<i64>,
    pub synchronization_error: Option<String>,
}

impl ManifestReport {
    pub async fn read(state: &StateDb, preparation: &ManifestPreparationStatus) -> Self {
        let mut report = Self {
            synchronization_error: preparation
                .reason
                .as_ref()
                .filter(|_| matches!(preparation.state, "failed" | "incompatible" | "invalid"))
                .cloned(),
            ..Self::default()
        };
        let Ok(Some(bound)) = state.run(|connection| binding::get(connection)).await else { return report };
        let Some(screen_id) = bound.screen_id else { return report };
        let binding = Binding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url };
        let Ok((active, pending, trial)) = state
            .run(move |connection| {
                Ok((
                    manifests::get_for(connection, Stage::Active, &binding)?,
                    manifests::get_for(connection, Stage::Pending, &binding)?,
                    manifests::trial(connection, &binding)?,
                ))
            })
            .await
        else {
            return report;
        };
        report.active_version = active.map(|active| active.version);
        let held = pending.as_ref().and_then(|pending| {
            trial.filter(|trial| trial.digest == pending.digest && trial.state == TrialState::Failed)
        });
        match held {
            Some(trial) => {
                if report.synchronization_error.is_none() {
                    let reason = trial.reason.as_deref().unwrap_or("unknown");
                    report.synchronization_error = Some(format!("activation_trial_failed:{reason}"));
                }
            }
            None => report.pending_version = pending.map(|pending| pending.version),
        }
        report
    }

    /// Writes the heartbeat fields. Absent facts stay absent.
    pub fn apply(&self, heartbeat: &mut serde_json::Value) {
        if let Some(version) = self.active_version {
            heartbeat["activeManifestVersion"] = serde_json::json!(version);
        }
        if let Some(version) = self.pending_version {
            heartbeat["pendingManifestVersion"] = serde_json::json!(version);
        }
        if let Some(error) = &self.synchronization_error {
            heartbeat["lastSynchronizationError"] =
                serde_json::json!(error.chars().take(MAX_SYNCHRONIZATION_ERROR).collect::<String>());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_state::OpenOptions;
    use player_state::repo::binding::{CredentialState, ServerBinding};
    use player_state::repo::manifests::{StoredManifest, Target};
    use player_types::{InstallationId, ScreenId, Sha256Digest, Timestamp};
    use serde_json::json;

    #[tokio::test]
    async fn a_held_back_manifest_is_reported_as_failed_not_as_still_preparing() {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let now = Timestamp::parse("2026-10-04T12:00:00Z").unwrap();
        let binding = Binding {
            installation_id: InstallationId::from_uuid(uuid::Uuid::from_u128(1)),
            screen_id: ScreenId::from_uuid(uuid::Uuid::from_u128(2)),
            server_url: "https://signs.example.org".into(),
        };
        let idle = ManifestPreparationStatus::default();
        assert_eq!(ManifestReport::read(&state, &idle).await, ManifestReport::default(), "unbound reports nothing");
        let write = binding.clone();
        state
            .run(move |connection| {
                binding::put(
                    connection,
                    &ServerBinding {
                        server_url: write.server_url.clone(),
                        installation_id: write.installation_id,
                        screen_id: Some(write.screen_id),
                        organization_name: None,
                        screen_name: None,
                        credential_state: CredentialState::Stored,
                        identity_verified_at: Some(now),
                        bound_at: now,
                    },
                    now,
                )?;
                for (version, label) in [(3, "active"), (4, "pending")] {
                    let document = json!({"manifestVersion": version, "label": label});
                    let digest = Sha256Digest::of(label.as_bytes());
                    let target = Target {
                        binding: write.clone(),
                        digest,
                        version,
                        etag: label.into(),
                        document: document.clone(),
                        fetched_at: now,
                    };
                    manifests::put_target(connection, &target)?;
                    let stored = StoredManifest { binding: write.clone(), digest, version, document, stored_at: now };
                    manifests::put_pending_for_target(connection, &stored)?;
                    if label == "active" {
                        manifests::promote_pending(connection, &write, &digest)?;
                    }
                }
                Ok(())
            })
            .await
            .unwrap();
        let mut heartbeat = json!({});
        let report = ManifestReport::read(&state, &idle).await;
        report.apply(&mut heartbeat);
        assert_eq!(heartbeat, json!({"activeManifestVersion": 3, "pendingManifestVersion": 4}));
        let fail = binding.clone();
        state
            .run(move |connection| {
                let digest = Sha256Digest::of(b"pending");
                manifests::begin_trial(connection, &fail, &digest, now)?;
                manifests::fail_trial(connection, &fail, &digest, "renderer_refused", now)?;
                Ok(())
            })
            .await
            .unwrap();
        let mut heartbeat = json!({});
        ManifestReport::read(&state, &idle).await.apply(&mut heartbeat);
        assert_eq!(
            heartbeat,
            json!({"activeManifestVersion": 3, "lastSynchronizationError": "activation_trial_failed:renderer_refused"})
        );
        // A preparation failure for a newer target names the newer problem.
        let failed =
            ManifestPreparationStatus { target: None, state: "failed", reason: Some("origin_unreachable".into()) };
        let mut heartbeat = json!({});
        ManifestReport::read(&state, &failed).await.apply(&mut heartbeat);
        assert_eq!(heartbeat["lastSynchronizationError"], "origin_unreachable");
    }
}
