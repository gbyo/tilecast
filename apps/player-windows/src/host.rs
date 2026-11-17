//! The Windows answers to the shared host seams ([`webview_host::host`]):
//! identity, device facts, the WebView2 renderer, Graphics Capture, MSIX
//! updates, DPAPI sealing, free space, and secure opening.

use player_client::pairing::DeviceMetadata;
use player_client::player_api::ServerCommand;
use player_state::repo::commands::CommandResult;
use player_types::PlayerId;
use std::sync::Arc;
use std::time::Duration;
use webview_host::capture::CapturedBgra;
use webview_host::daemon::DaemonContext;
use webview_host::host::{DeviceFacts, HostIdentity, HostServices, RendererHost, UpdateHost, WindowCapture};
use webview_host::paths::HostPaths;
use webview_host::ui::{UiError, UiEvent, UiHandle, UiServices};

/// The Windows build identity.
pub const IDENTITY: HostIdentity = HostIdentity {
    family: crate::PLAYER_FAMILY,
    product: "tilecast-windows",
    engine: "webview2",
    release_version: crate::RELEASE_VERSION,
    config_file_name: crate::CONFIG_FILE_NAME,
    unsupported_command: "This command type is not supported by the Windows player.",
    unsupported_reason,
};

/// Why a known command type is not available on Windows.
pub fn unsupported_reason(command_type: &str) -> Option<&'static str> {
    Some(match command_type {
        // Power Assist is the Android player's device sleep; the reference
        // Linux player answers it the same way. The Windows player holds
        // display sleep off while it presents but does not control
        // display power.
        "power_assist_sleep" | "power_assist_wake" => {
            "Power Assist is an Android feature. The Windows player does not control display power."
        }
        "prepare_airplay_session" | "stop_airplay_session" | "test_airplay_support" => {
            "AirPlay is not available on the Windows player."
        }
        "install_autostart" | "remove_autostart" => {
            "The Windows player starts from its installed shortcut and service, which the installer manages."
        }
        "provision_presentation_network" | "test_presentation_network" => {
            "Presentation networking is not available on the Windows player."
        }
        _ => return None,
    })
}

#[derive(Debug, Default, Clone, Copy)]
pub struct WindowsDevice;

impl DeviceFacts for WindowsDevice {
    fn metadata(&self, identity: &HostIdentity, player: PlayerId, display: Option<(u32, u32)>) -> DeviceMetadata {
        crate::device::metadata_for(identity, player, display)
    }
    fn display_size(&self) -> (u32, u32) {
        crate::device::display_size(None)
    }
    fn device_uptime_seconds(&self) -> Option<i64> {
        crate::win32::tick_count_ms().map(|ms| (ms / 1000) as i64)
    }
}

/// The WebView2 renderer on its STA UI thread.
#[derive(Debug, Default, Clone, Copy)]
pub struct WebView2Host;

#[async_trait::async_trait]
impl RendererHost for WebView2Host {
    async fn spawn(&self, services: UiServices) -> Result<(UiHandle, tokio::sync::mpsc::Receiver<UiEvent>), UiError> {
        crate::renderer::spawn_ui(services).await
    }
    fn engine_version(&self) -> String {
        crate::renderer::engine_version()
    }
    fn presents(&self) -> bool {
        true
    }
}

/// Windows Graphics Capture of the player's own window.
#[derive(Debug, Default, Clone, Copy)]
pub struct GraphicsCapture;

impl WindowCapture for GraphicsCapture {
    fn capture_bgra(&self, window: usize, wait: Duration) -> Result<CapturedBgra, &'static str> {
        crate::win32::capture_window_bgra(window as *mut std::ffi::c_void, wait)
    }
}

/// Signed MSIX updates (`crate::update`).
#[derive(Debug, Default, Clone, Copy)]
pub struct MsixUpdates;

#[async_trait::async_trait]
impl UpdateHost for MsixUpdates {
    fn own_version_code(&self) -> u64 {
        crate::update::own_version_code()
    }
    fn accept(&self, paths: &HostPaths, command: &ServerCommand) -> CommandResult {
        crate::update::accept(paths, command, crate::update::own_version_code())
    }
    async fn run(&self, context: Arc<DaemonContext>) {
        crate::update::run(context).await
    }
}

/// The production Windows services.
pub fn services() -> HostServices {
    services_with_sealer(crate::seal::production_sealer())
}

/// The Windows services over an injected sealer, so integration tests can
/// persist private state where DPAPI does not exist.
pub fn services_with_sealer(sealer: Arc<dyn webview_host::seal::Sealer>) -> HostServices {
    HostServices {
        identity: IDENTITY,
        device: Arc::new(WindowsDevice),
        renderer: Arc::new(WebView2Host),
        capture: Arc::new(GraphicsCapture),
        updates: Arc::new(MsixUpdates),
        sealer,
        space: Arc::new(crate::space::DiskSpaceProbe),
        opener: Arc::new(crate::secure_open::WindowsSecureOpener),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_names_the_windows_build() {
        assert_eq!(IDENTITY.user_agent(), format!("tilecast-windows/{}", crate::RELEASE_VERSION));
        assert_eq!(
            IDENTITY.unsupported_text("test_airplay_support"),
            "AirPlay is not available on the Windows player."
        );
        assert_eq!(IDENTITY.unsupported_text("no_such_command"), IDENTITY.unsupported_command);
    }
}
