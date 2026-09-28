//! Capability providers that need only environment and filesystem probes.
//!
//! Subsystem-owned capabilities (the live renderer, the state store) are
//! reported by providers in the crates that own that state; see
//! `tilecastd::capabilities`.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortToken};
use edge_protocol::capability::{Capability, CapabilityId, CapabilityState, ids};

use crate::capabilities::{CapabilityProvider, ProbeError};

fn capability(
    id: &str,
    state: CapabilityState,
    provider: &str,
    reason: Option<&str>,
    detail: Option<&str>,
    now: Timestamp,
) -> Result<Capability, ProbeError> {
    let mut capability =
        Capability::new(CapabilityId::new(id).map_err(|_| ProbeError { reason: "invalid_capability_id" })?, state, now);
    capability.provider = ShortToken::new(provider).ok();
    capability.reason_code = reason.and_then(|r| ShortToken::new(r).ok());
    capability.detail = detail.map(DetailText::lossy);
    Ok(capability)
}

/// `system.systemd_watchdog`.
#[derive(Debug, Clone)]
pub struct SystemdProvider {
    pub notify_enabled: bool,
    pub watchdog_enabled: bool,
}

#[async_trait]
impl CapabilityProvider for SystemdProvider {
    fn name(&self) -> &'static str {
        "systemd"
    }

    async fn probe(&self, now: Timestamp) -> Result<Vec<Capability>, ProbeError> {
        let (state, reason, detail) = match (self.notify_enabled, self.watchdog_enabled) {
            (true, true) => (CapabilityState::Available, None, None),
            (true, false) => (
                CapabilityState::Supported,
                Some("watchdog_not_configured"),
                Some("tilecastd runs under systemd without a watchdog interval."),
            ),
            (false, _) => (
                CapabilityState::Unsupported,
                Some("not_supervised"),
                Some("tilecastd is not running under systemd supervision."),
            ),
        };
        Ok(vec![capability(ids::SYSTEM_SYSTEMD_WATCHDOG, state, "systemd", reason, detail, now)?])
    }
}

/// `time.host_sync`: whether the host reports a synchronized clock.
/// Today this reads systemd-timesyncd's flag file, as the Linux player did;
/// chrony/ntpd inspection is later work (docs/tilecast-edge.md §13).
#[derive(Debug, Clone)]
pub struct HostTimeSyncProvider {
    pub synchronized_flag: PathBuf,
}

impl Default for HostTimeSyncProvider {
    fn default() -> Self {
        Self { synchronized_flag: PathBuf::from("/run/systemd/timesync/synchronized") }
    }
}

#[async_trait]
impl CapabilityProvider for HostTimeSyncProvider {
    fn name(&self) -> &'static str {
        "host-time-sync"
    }

    async fn probe(&self, now: Timestamp) -> Result<Vec<Capability>, ProbeError> {
        let synchronized = tokio::fs::metadata(&self.synchronized_flag).await.is_ok();
        let capability = if synchronized {
            capability(ids::TIME_HOST_SYNC, CapabilityState::Available, "systemd-timesyncd", None, None, now)?
        } else {
            capability(
                ids::TIME_HOST_SYNC,
                CapabilityState::Unsupported,
                "systemd-timesyncd",
                Some("sync_state_unknown"),
                Some("Host clock synchronization could not be confirmed; the server clock offset is used."),
                now,
            )?
        };
        Ok(vec![capability])
    }
}

/// WPE platform backends available on this machine:
/// `renderer.wpe.drm`, `renderer.wpe.wayland`, `renderer.wpe.headless`.
///
/// `renderer.wpe` itself (is a renderer connected and ready) is live state
/// reported by the daemon's renderer supervisor, not here.
#[derive(Debug, Clone)]
pub struct WpePlatformProvider {
    /// The installed `tilecast-renderer-wpe` binary.
    pub renderer_binary: PathBuf,
    /// Directory holding DRM device nodes.
    pub dri_dir: PathBuf,
    /// `$XDG_RUNTIME_DIR` of the renderer session, when known.
    pub wayland_runtime_dir: Option<PathBuf>,
    /// `$WAYLAND_DISPLAY` of the renderer session, when known.
    pub wayland_display: Option<String>,
}

impl WpePlatformProvider {
    fn drm_state(&self) -> (CapabilityState, Option<&'static str>, Option<&'static str>) {
        let Ok(entries) = std::fs::read_dir(&self.dri_dir) else {
            return (CapabilityState::Unsupported, Some("no_drm_device"), Some("No DRM display device was found."));
        };
        let cards: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("card")))
            .collect();
        if cards.is_empty() {
            return (CapabilityState::Unsupported, Some("no_drm_device"), Some("No DRM display device was found."));
        }
        let accessible = cards
            .iter()
            .any(|card| rustix::fs::access(card, rustix::fs::Access::READ_OK | rustix::fs::Access::WRITE_OK).is_ok());
        if accessible {
            (CapabilityState::Available, None, None)
        } else {
            (
                CapabilityState::Blocked,
                Some("drm_permission_denied"),
                Some("A DRM device exists but the tilecast account cannot open it (video group or seat ACL missing)."),
            )
        }
    }

    fn wayland_state(&self) -> (CapabilityState, Option<&'static str>, Option<&'static str>) {
        match (&self.wayland_runtime_dir, &self.wayland_display) {
            (Some(dir), Some(display)) if socket_exists(&dir.join(display)) => (CapabilityState::Available, None, None),
            (Some(_), Some(_)) => (
                CapabilityState::Supported,
                Some("wayland_socket_missing"),
                Some("The configured Wayland compositor socket is not present."),
            ),
            _ => (CapabilityState::Unsupported, Some("no_wayland_session"), None),
        }
    }
}

fn socket_exists(path: &Path) -> bool {
    use std::os::unix::fs::FileTypeExt;
    std::fs::metadata(path).is_ok_and(|m| m.file_type().is_socket())
}

#[async_trait]
impl CapabilityProvider for WpePlatformProvider {
    fn name(&self) -> &'static str {
        "wpe-platform"
    }

    async fn probe(&self, now: Timestamp) -> Result<Vec<Capability>, ProbeError> {
        let installed = tokio::fs::metadata(&self.renderer_binary).await.is_ok_and(|m| m.is_file());
        if !installed {
            let detail = Some("tilecast-renderer-wpe is not installed.");
            return Ok(vec![
                capability(
                    ids::RENDERER_WPE_DRM,
                    CapabilityState::Unsupported,
                    "wpe",
                    Some("renderer_not_installed"),
                    detail,
                    now,
                )?,
                capability(
                    ids::RENDERER_WPE_WAYLAND,
                    CapabilityState::Unsupported,
                    "wpe",
                    Some("renderer_not_installed"),
                    detail,
                    now,
                )?,
                capability(
                    ids::RENDERER_WPE_HEADLESS,
                    CapabilityState::Unsupported,
                    "wpe",
                    Some("renderer_not_installed"),
                    detail,
                    now,
                )?,
            ]);
        }
        let this = self.clone();
        let (drm, wayland) = tokio::task::spawn_blocking(move || (this.drm_state(), this.wayland_state()))
            .await
            .map_err(|_| ProbeError { reason: "probe_task_failed" })?;
        Ok(vec![
            capability(ids::RENDERER_WPE_DRM, drm.0, "wpe", drm.1, drm.2, now)?,
            capability(ids::RENDERER_WPE_WAYLAND, wayland.0, "wpe", wayland.1, wayland.2, now)?,
            capability(ids::RENDERER_WPE_HEADLESS, CapabilityState::Available, "wpe", None, None, now)?,
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> Timestamp {
        Timestamp::from_unix_seconds(1_000).expect("time")
    }

    #[tokio::test]
    async fn wpe_provider_reports_missing_renderer_and_drm() {
        let dir = tempfile::tempdir().expect("tempdir");
        let provider = WpePlatformProvider {
            renderer_binary: dir.path().join("missing"),
            dri_dir: dir.path().join("dri"),
            wayland_runtime_dir: None,
            wayland_display: None,
        };
        let missing = provider.probe(now()).await.expect("probe");
        assert!(missing.iter().all(|c| c.state == CapabilityState::Unsupported));

        let binary = dir.path().join("tilecast-renderer-wpe");
        std::fs::write(&binary, b"").expect("write");
        let installed = WpePlatformProvider { renderer_binary: binary, ..provider };
        let found = installed.probe(now()).await.expect("probe");
        let drm = found.iter().find(|c| c.id.as_str() == ids::RENDERER_WPE_DRM).expect("drm");
        assert_eq!(drm.state, CapabilityState::Unsupported);
        assert_eq!(drm.reason_code.as_ref().map(|r| r.as_str()), Some("no_drm_device"));
        let headless = found.iter().find(|c| c.id.as_str() == ids::RENDERER_WPE_HEADLESS).expect("headless");
        assert_eq!(headless.state, CapabilityState::Available);
    }

    #[tokio::test]
    async fn systemd_provider_states() {
        let supervised = SystemdProvider { notify_enabled: true, watchdog_enabled: true };
        assert_eq!(supervised.probe(now()).await.expect("probe")[0].state, CapabilityState::Available);
        let bare = SystemdProvider { notify_enabled: false, watchdog_enabled: false };
        assert_eq!(bare.probe(now()).await.expect("probe")[0].state, CapabilityState::Unsupported);
    }
}
