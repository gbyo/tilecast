//! Settlement: when a started Edge counts as working.
//!
//! systemd reporting both units as running proves nothing about the screen.
//! Settlement reads the daemon's own status and requires, continuously for a
//! stable window:
//!
//! * a migration: an authenticated server relationship with contact after
//!   Edge started (the import's identity check just proved the network), and
//!   the server's current presentation active;
//! * a renderer connected on the intended output, not incompatible and not in
//!   safe mode;
//! * the current activation accepted by the renderer, with meaningful
//!   playback evidence, and fresh progress during the window.
//!
//! Some conditions end settlement at once: they cannot improve by waiting.

use edge_protocol::ipc::status::{DaemonMode, DaemonStatus};

use crate::state::Kind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ready,
    /// Not yet; the reason names the first unmet condition.
    NotYet(&'static str),
    /// Waiting cannot help: roll back.
    Fail(&'static str),
}

#[derive(Debug, Clone, Copy)]
pub struct Expectation {
    pub kind: Kind,
    pub platform: &'static str,
    /// Local Unix milliseconds when Edge was started.
    pub edge_started_at_ms: i64,
}

pub fn evaluate(status: Option<&DaemonStatus>, expected: &Expectation) -> Verdict {
    let Some(status) = status else { return Verdict::NotYet("daemon_unreachable") };
    if status.mode == DaemonMode::Recovery {
        return Verdict::Fail("daemon_recovery_mode");
    }
    if expected.kind == Kind::Migration {
        let Some(server) = status.server.as_ref() else { return Verdict::Fail("server_binding_missing") };
        if !server.has_device_credential {
            return Verdict::Fail("device_credential_rejected");
        }
        let contacted = status.link.last_contact_at.is_some_and(|at| at.unix_millis() >= expected.edge_started_at_ms);
        if status.link.state.as_str() != "connected" || !contacted {
            return Verdict::NotYet("server_not_connected");
        }
    }
    let renderer = &status.renderer;
    if !renderer.connected {
        return Verdict::NotYet("renderer_not_connected");
    }
    match renderer.platform.as_ref().map(|p| p.as_str()) {
        Some(platform) if platform != expected.platform => return Verdict::Fail("renderer_wrong_platform"),
        None => return Verdict::NotYet("renderer_not_ready"),
        Some(_) => {}
    }
    if renderer.state.as_str() == "safe_mode" {
        return Verdict::Fail("renderer_safe_mode");
    }
    if renderer.incompatible_reason.is_some() {
        return Verdict::Fail("presentation_incompatible");
    }
    let Some(presentation) = status.presentation.as_ref() else { return Verdict::NotYet("no_activation") };
    match (expected.kind, presentation.source.as_str()) {
        (_, "safe_mode" | "fixture") => return Verdict::Fail("unexpected_presentation_source"),
        (Kind::Migration, "server_manifest" | "policy") => {}
        // No assignment: the idle surface is the correct presentation.
        (Kind::Migration, "status_surface") if presentation.target_manifest_sha256.is_none() => {}
        (Kind::Migration, _) => return Verdict::NotYet("presentation_not_current"),
        (Kind::CleanInstall, "status_surface") => {}
        (Kind::CleanInstall, _) => return Verdict::NotYet("presentation_not_current"),
    }
    if expected.kind == Kind::Migration
        && presentation.source.as_str() == "server_manifest"
        && presentation.target_manifest_sha256.is_some()
        && presentation.manifest_sha256 != presentation.target_manifest_sha256
    {
        return Verdict::NotYet("target_not_active");
    }
    if !presentation.accepted {
        return Verdict::NotYet("activation_not_accepted");
    }
    if !presentation.evidence {
        return Verdict::NotYet("no_playback_evidence");
    }
    Verdict::Ready
}

/// A compact, secret-free record of the sample that decided settlement.
pub fn summary(status: Option<&DaemonStatus>) -> serde_json::Value {
    let Some(status) = status else { return serde_json::json!({"reachable": false}) };
    serde_json::json!({
        "reachable": true,
        "daemonStartedAt": status.started_at,
        "link": status.link.state.as_str(),
        "lastContactAt": status.link.last_contact_at,
        "renderer": {
            "state": status.renderer.state.as_str(),
            "platform": status.renderer.platform.as_ref().map(|p| p.as_str()),
            "version": status.renderer.version.as_ref().map(|v| v.as_str()),
            "engineVersion": status.renderer.engine_version.as_ref().map(|v| v.as_str()),
            "gstreamerVersion": status.renderer.gstreamer_version.as_ref().map(|v| v.as_str()),
            "lastProgressAt": status.renderer.last_progress_at,
        },
        "presentation": status.presentation.as_ref().map(|p| serde_json::json!({
            "source": p.source.as_str(),
            "generation": p.generation,
            "manifestSha256": p.manifest_sha256.map(|d| d.to_hex()),
            "targetManifestSha256": p.target_manifest_sha256.map(|d| d.to_hex()),
            "accepted": p.accepted,
            "evidence": p.evidence,
        })),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use edge_protocol::bounded::{ShortText, ShortToken};
    use edge_protocol::ipc::status::{PresentationStatus, RendererStatus, ServerBindingStatus, ServerLinkStatus};
    use edge_protocol::{InstallationId, Sha256Digest, Timestamp};

    use super::*;

    pub(crate) fn status(at_ms: i64) -> DaemonStatus {
        let manifest = Sha256Digest::of(b"manifest");
        DaemonStatus {
            daemon_version: ShortText::lossy("0.1.0"),
            mode: DaemonMode::Normal,
            recovery_reason: None,
            started_at: Timestamp::from_unix_millis(1_000).unwrap(),
            player_id: None,
            server: Some(ServerBindingStatus {
                server_url: ShortText::lossy("https://signs.example.org"),
                installation_id: InstallationId::new_random(),
                screen_id: None,
                screen_name: None,
                identity_verified_at: None,
                has_device_credential: true,
            }),
            link: ServerLinkStatus {
                state: ShortToken::new("connected").unwrap(),
                reason_code: None,
                last_contact_at: Timestamp::from_unix_millis(at_ms),
            },
            cas: None,
            renderer: RendererStatus {
                connected: true,
                state: ShortToken::new("healthy").unwrap(),
                kind: ShortToken::new("wpe").ok(),
                version: Some(ShortText::lossy("0.1.0")),
                platform: ShortToken::new("drm").ok(),
                current_activation_generation: Some(3),
                last_progress_at: Timestamp::from_unix_millis(at_ms),
                last_error_code: None,
                incompatible_reason: None,
                current_item_id: None,
                current_item_started_at: None,
                engine_version: None,
                gstreamer_version: None,
            },
            capability_revision: 1,
            systemd_watchdog: true,
            last_legacy_import: ShortToken::new("completed").ok(),
            pairing: None,
            outbox: None,
            presentation: Some(PresentationStatus {
                source: ShortToken::new("server_manifest").unwrap(),
                generation: 3,
                manifest_sha256: Some(manifest),
                target_manifest_sha256: Some(manifest),
                accepted: true,
                evidence: true,
            }),
        }
    }

    const EXPECTED: Expectation = Expectation { kind: Kind::Migration, platform: "drm", edge_started_at_ms: 5_000 };

    #[test]
    fn a_proven_current_presentation_is_ready() {
        assert_eq!(evaluate(Some(&status(6_000)), &EXPECTED), Verdict::Ready);
    }

    #[test]
    fn running_units_or_a_connected_renderer_are_not_enough() {
        assert_eq!(evaluate(None, &EXPECTED), Verdict::NotYet("daemon_unreachable"));
        let mut stale = status(4_000);
        assert_eq!(evaluate(Some(&stale), &EXPECTED), Verdict::NotYet("server_not_connected"), "contact before start");
        stale.link.last_contact_at = Timestamp::from_unix_millis(6_000);
        stale.link.state = ShortToken::new("retrying").unwrap();
        assert_eq!(evaluate(Some(&stale), &EXPECTED), Verdict::NotYet("server_not_connected"));

        let mut unproven = status(6_000);
        unproven.presentation.as_mut().unwrap().evidence = false;
        assert_eq!(evaluate(Some(&unproven), &EXPECTED), Verdict::NotYet("no_playback_evidence"));
        unproven.presentation.as_mut().unwrap().accepted = false;
        assert_eq!(evaluate(Some(&unproven), &EXPECTED), Verdict::NotYet("activation_not_accepted"));

        let mut old = status(6_000);
        old.presentation.as_mut().unwrap().target_manifest_sha256 = Some(Sha256Digest::of(b"newer"));
        assert_eq!(evaluate(Some(&old), &EXPECTED), Verdict::NotYet("target_not_active"));

        let mut surface = status(6_000);
        surface.presentation.as_mut().unwrap().source = ShortToken::new("status_surface").unwrap();
        assert_eq!(evaluate(Some(&surface), &EXPECTED), Verdict::NotYet("presentation_not_current"));
        surface.presentation.as_mut().unwrap().target_manifest_sha256 = None;
        assert_eq!(evaluate(Some(&surface), &EXPECTED), Verdict::Ready, "no assignment: the idle surface is right");
    }

    #[test]
    fn conditions_that_cannot_improve_fail_at_once() {
        let mut revoked = status(6_000);
        revoked.server.as_mut().unwrap().has_device_credential = false;
        assert_eq!(evaluate(Some(&revoked), &EXPECTED), Verdict::Fail("device_credential_rejected"));
        let mut wrong = status(6_000);
        wrong.renderer.platform = ShortToken::new("headless").ok();
        assert_eq!(evaluate(Some(&wrong), &EXPECTED), Verdict::Fail("renderer_wrong_platform"));
        let mut incompatible = status(6_000);
        incompatible.renderer.incompatible_reason = Some(edge_protocol::bounded::SafeText::lossy("website"));
        assert_eq!(evaluate(Some(&incompatible), &EXPECTED), Verdict::Fail("presentation_incompatible"));
        let mut safe = status(6_000);
        safe.renderer.state = ShortToken::new("safe_mode").unwrap();
        assert_eq!(evaluate(Some(&safe), &EXPECTED), Verdict::Fail("renderer_safe_mode"));
        let mut recovery = status(6_000);
        recovery.mode = DaemonMode::Recovery;
        assert_eq!(evaluate(Some(&recovery), &EXPECTED), Verdict::Fail("daemon_recovery_mode"));
    }

    #[test]
    fn a_clean_install_settles_on_its_setup_surface_without_a_server() {
        let mut fresh = status(0);
        fresh.server = None;
        fresh.link.state = ShortToken::new("unbound").unwrap();
        let presentation = fresh.presentation.as_mut().unwrap();
        presentation.source = ShortToken::new("status_surface").unwrap();
        presentation.manifest_sha256 = None;
        presentation.target_manifest_sha256 = None;
        let clean = Expectation { kind: Kind::CleanInstall, ..EXPECTED };
        assert_eq!(evaluate(Some(&fresh), &clean), Verdict::Ready);
    }
}
