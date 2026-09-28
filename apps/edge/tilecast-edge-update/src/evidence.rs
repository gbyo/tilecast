//! What the helper requires before it ends a provisional window.
//!
//! The candidate `tilecastd` decides when to ask for confirmation: it holds
//! the whole rule set (a fresh server relationship, a ready renderer, fresh
//! evidence for what the screen should show, and a stable period). The helper
//! does not trust that request alone. It reads the daemon's own status over
//! its socket, as the M7 settlement does, and refuses unless the facts it can
//! see hold as well:
//!
//! * the running daemon is the candidate version, in normal mode;
//! * its server link is connected, with contact after the daemon started;
//! * the renderer is connected, not in safe mode and not showing an
//!   incompatible presentation;
//! * the current activation was accepted by the renderer with meaningful
//!   evidence, and is not the safe-mode or fixture surface.
//!
//! Waiting helps with every refusal here, so none of them rolls back; the
//! deadline does.

use edge_protocol::ipc::status::{DaemonMode, DaemonStatus};

pub fn check(status: Option<&DaemonStatus>, candidate_version: &str) -> Result<(), &'static str> {
    let Some(status) = status else { return Err("daemon_unreachable") };
    if status.daemon_version.as_str() != candidate_version {
        return Err("candidate_not_running");
    }
    if status.mode == DaemonMode::Recovery {
        return Err("daemon_recovery_mode");
    }
    let contacted = status.link.last_contact_at.is_some_and(|at| at >= status.started_at);
    if status.link.state.as_str() != "connected" || !contacted {
        return Err("server_not_connected");
    }
    let renderer = &status.renderer;
    if !renderer.connected {
        return Err("renderer_not_connected");
    }
    if renderer.state.as_str() == "safe_mode" {
        return Err("renderer_safe_mode");
    }
    if renderer.incompatible_reason.is_some() {
        return Err("presentation_incompatible");
    }
    let Some(presentation) = status.presentation.as_ref() else { return Err("no_activation") };
    if matches!(presentation.source.as_str(), "safe_mode" | "fixture") {
        return Err("unexpected_presentation_source");
    }
    if !presentation.accepted {
        return Err("activation_not_accepted");
    }
    if !presentation.evidence {
        return Err("no_playback_evidence");
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
    use edge_protocol::ipc::status::{PresentationStatus, RendererStatus, ServerLinkStatus};
    use edge_protocol::{Sha256Digest, Timestamp};

    use super::*;

    pub(crate) fn status(version: &str) -> DaemonStatus {
        let manifest = Sha256Digest::of(b"manifest");
        DaemonStatus {
            daemon_version: ShortText::lossy(version),
            mode: DaemonMode::Normal,
            recovery_reason: None,
            started_at: Timestamp::from_unix_millis(10_000).unwrap(),
            player_id: None,
            server: None,
            link: ServerLinkStatus {
                state: ShortToken::new("connected").unwrap(),
                reason_code: None,
                last_contact_at: Timestamp::from_unix_millis(11_000),
            },
            cas: None,
            renderer: RendererStatus {
                connected: true,
                state: ShortToken::new("healthy").unwrap(),
                kind: ShortToken::new("wpe").ok(),
                version: Some(ShortText::lossy(version)),
                platform: ShortToken::new("drm").ok(),
                current_activation_generation: Some(2),
                last_progress_at: Timestamp::from_unix_millis(12_000),
                last_error_code: None,
                incompatible_reason: None,
                current_item_id: None,
                current_item_started_at: None,
                engine_version: None,
                gstreamer_version: None,
            },
            capability_revision: 1,
            systemd_watchdog: true,
            last_legacy_import: None,
            pairing: None,
            outbox: None,
            presentation: Some(PresentationStatus {
                source: ShortToken::new("server_manifest").unwrap(),
                generation: 2,
                manifest_sha256: Some(manifest),
                target_manifest_sha256: Some(manifest),
                accepted: true,
                evidence: true,
            }),
            update: None,
        }
    }

    #[test]
    fn a_healthy_candidate_passes() {
        assert_eq!(check(Some(&status("0.2.0")), "0.2.0"), Ok(()));
    }

    #[test]
    fn the_previous_daemon_or_an_unproven_screen_cannot_confirm() {
        assert_eq!(check(None, "0.2.0"), Err("daemon_unreachable"));
        assert_eq!(check(Some(&status("0.1.0")), "0.2.0"), Err("candidate_not_running"));
        let mut stale = status("0.2.0");
        stale.link.last_contact_at = Timestamp::from_unix_millis(9_000);
        assert_eq!(check(Some(&stale), "0.2.0"), Err("server_not_connected"), "contact before this daemon started");
        let mut safe = status("0.2.0");
        safe.renderer.state = ShortToken::new("safe_mode").unwrap();
        assert_eq!(check(Some(&safe), "0.2.0"), Err("renderer_safe_mode"));
        let mut incompatible = status("0.2.0");
        incompatible.renderer.incompatible_reason = Some(SafeText::lossy("website"));
        assert_eq!(check(Some(&incompatible), "0.2.0"), Err("presentation_incompatible"));
        let mut unproven = status("0.2.0");
        unproven.presentation.as_mut().unwrap().evidence = false;
        assert_eq!(check(Some(&unproven), "0.2.0"), Err("no_playback_evidence"));
        let mut recovery = status("0.2.0");
        recovery.mode = DaemonMode::Recovery;
        assert_eq!(check(Some(&recovery), "0.2.0"), Err("daemon_recovery_mode"));
    }

    #[test]
    fn a_status_surface_with_evidence_is_enough_for_a_screen_with_nothing_to_play() {
        let mut resting = status("0.2.0");
        let presentation = resting.presentation.as_mut().unwrap();
        presentation.source = ShortToken::new("status_surface").unwrap();
        presentation.manifest_sha256 = None;
        presentation.target_manifest_sha256 = None;
        assert_eq!(check(Some(&resting), "0.2.0"), Ok(()));
        resting.presentation.as_mut().unwrap().source = ShortToken::new("safe_mode").unwrap();
        assert_eq!(check(Some(&resting), "0.2.0"), Err("unexpected_presentation_source"));
    }
}
