//! The macOS answers to the shared host seams ([`webview_host::host`]).
//!
//! This build composes Player Core with the shared WebView host and the
//! macOS adapters: the Keychain sealer, device facts, free space, and
//! secure opening. It pairs, reconciles, prepares verified content, runs
//! commands, Activity, and telemetry, and drives offline activation through
//! the shared presentation engine and its `RendererPort`.
//!
//! What it does not do yet is truthful, not faked: no WKWebView renderer
//! (gbyo/tilecast#1926), so it reports no presentation support and runs
//! renderer-less; no final-output capture (#1928); no Server-managed
//! updates (#1933).

use player_client::pairing::DeviceMetadata;
use player_client::player_api::ServerCommand;
use player_state::repo::commands::CommandResult;
use player_types::PlayerId;
use std::sync::Arc;
use std::time::Duration;
use webview_host::capture::CapturedBgra;
use webview_host::daemon::DaemonContext;
use webview_host::host::{
    DeviceFacts, HEADLESS_DISPLAY, HostIdentity, HostServices, RendererHost, UpdateHost, WindowCapture,
};
use webview_host::paths::HostPaths;
use webview_host::ui::{UiError, UiEvent, UiHandle, UiServices};

/// The operator configuration file, beside the state it configures.
pub const CONFIG_FILE_NAME: &str = "tilecast-macos.toml";

/// The macOS build identity.
pub const IDENTITY: HostIdentity = HostIdentity {
    family: crate::PLAYER_FAMILY,
    product: "tilecast-macos",
    engine: "wkwebview",
    release_version: crate::RELEASE_VERSION,
    config_file_name: CONFIG_FILE_NAME,
    unsupported_command: "This command type is not supported by the macOS player.",
    unsupported_reason,
};

/// Why a known command type is not available on macOS.
pub fn unsupported_reason(command_type: &str) -> Option<&'static str> {
    Some(match command_type {
        "power_assist_sleep" | "power_assist_wake" => {
            "Power Assist is an Android feature. The macOS player does not control display power."
        }
        "prepare_airplay_session" | "stop_airplay_session" | "test_airplay_support" => {
            "AirPlay is not available on the macOS player."
        }
        "install_autostart" | "remove_autostart" => "Login startup is not available on the macOS player yet.",
        "provision_presentation_network" | "test_presentation_network" => {
            "Presentation networking is not available on the macOS player."
        }
        _ => return None,
    })
}

#[derive(Debug, Default, Clone, Copy)]
pub struct MacosDevice;

impl DeviceFacts for MacosDevice {
    fn metadata(&self, identity: &HostIdentity, player: PlayerId, display: Option<(u32, u32)>) -> DeviceMetadata {
        DeviceMetadata::new(
            *player.as_uuid(),
            identity.family,
            &crate::device::manufacturer(),
            &crate::device::model(),
            &crate::device::os_release(),
            identity.release_version,
            display.unwrap_or_else(|| self.display_size()),
            &crate::device::locale(),
            &webview_host::host::timezone(),
        )
    }
    fn display_size(&self) -> (u32, u32) {
        crate::device::display_size().unwrap_or(HEADLESS_DISPLAY)
    }
    fn device_uptime_seconds(&self) -> Option<i64> {
        crate::device::device_uptime_seconds()
    }
}

/// The WKWebView renderer host. Until the Runtime bridge lands
/// (gbyo/tilecast#1926) it reports that no renderer is available, and the
/// shared engine runs renderer-less.
#[derive(Debug, Default, Clone, Copy)]
pub struct WebKitHost;

#[async_trait::async_trait]
impl RendererHost for WebKitHost {
    async fn spawn(&self, _services: UiServices) -> Result<(UiHandle, tokio::sync::mpsc::Receiver<UiEvent>), UiError> {
        Err(UiError::Unsupported)
    }
    fn engine_version(&self) -> String {
        "unavailable".to_owned()
    }
    fn presents(&self) -> bool {
        false
    }
}

/// Final-output capture is not available yet (gbyo/tilecast#1928).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoCapture;

impl WindowCapture for NoCapture {
    fn capture_bgra(&self, _window: usize, _wait: Duration) -> Result<CapturedBgra, &'static str> {
        Err("unavailable")
    }
}

/// Server-managed updates are not available yet (gbyo/tilecast#1933). The
/// heartbeat still reports this build's version code.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoUpdates;

#[async_trait::async_trait]
impl UpdateHost for NoUpdates {
    fn own_version_code(&self) -> u64 {
        webview_host::release_version::version_code(crate::RELEASE_VERSION).unwrap_or(0)
    }
    fn accept(&self, _paths: &HostPaths, _command: &ServerCommand) -> CommandResult {
        CommandResult::failed("unsupported_command", "Player updates are not available on the macOS player yet.")
    }
    async fn run(&self, context: Arc<DaemonContext>) {
        context.shutdown.cancelled().await;
    }
}

/// The production macOS services.
pub fn services() -> HostServices {
    services_with_sealer(crate::keychain::production_sealer())
}

/// The macOS services over an injected sealer, so tests never write to the
/// login Keychain.
pub fn services_with_sealer(sealer: Arc<dyn webview_host::seal::Sealer>) -> HostServices {
    HostServices {
        identity: IDENTITY,
        device: Arc::new(MacosDevice),
        renderer: Arc::new(WebKitHost),
        capture: Arc::new(NoCapture),
        updates: Arc::new(NoUpdates),
        sealer,
        space: Arc::new(crate::space::DiskSpaceProbe),
        opener: Arc::new(crate::secure_open::MacosSecureOpener),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_names_the_macos_build() {
        assert_eq!(IDENTITY.user_agent(), format!("tilecast-macos/{}", crate::RELEASE_VERSION));
        assert_eq!(IDENTITY.family, "macos");
        assert_eq!(IDENTITY.unsupported_text("test_airplay_support"), "AirPlay is not available on the macOS player.");
        assert_eq!(IDENTITY.unsupported_text("no_such_command"), IDENTITY.unsupported_command);
        assert_ne!(NoUpdates.own_version_code(), 0);
    }

    #[test]
    fn metadata_is_server_shaped() {
        let player = PlayerId::from_uuid(uuid::Uuid::new_v4());
        let facts = MacosDevice.metadata(&IDENTITY, player, Some(HEADLESS_DISPLAY));
        assert_eq!(facts.platform, "macos");
        assert_eq!((facts.screen_width, facts.screen_height), HEADLESS_DISPLAY);
        assert!(!facts.manufacturer.is_empty() && !facts.model.is_empty() && !facts.android_version.is_empty());
        assert_eq!(facts.player_version, crate::RELEASE_VERSION);
        let (width, height) = MacosDevice.display_size();
        assert!(width > 0 && height > 0);
    }

    #[test]
    fn nothing_unavailable_is_claimed() {
        assert!(!WebKitHost.presents());
        assert_eq!(NoCapture.capture_bgra(1, Duration::from_millis(1)).err(), Some("unavailable"));
    }
}
