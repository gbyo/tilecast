//! What a platform supplies to the shared WebView host.
//!
//! Each seam is narrow and owned here, at its consumer. A platform crate
//! (`apps/player-windows`, `apps/player-macos`) implements them over its OS
//! APIs and passes them to [`crate::daemon::build`]. Nothing in this crate
//! calls an OS API or branches on a platform name: the platform's answers
//! arrive through these values.

use player_client::pairing::DeviceMetadata;
use player_client::player_api::ServerCommand;
use player_state::repo::commands::CommandResult;
use player_types::PlayerId;
use std::sync::Arc;
use std::time::Duration;

use crate::capture::CapturedBgra;
use crate::daemon::DaemonContext;
use crate::paths::HostPaths;
use crate::ui::{UiError, UiEvent, UiHandle, UiServices};

/// Stable build identity: what this build is, never a measurement.
#[derive(Debug, Clone, Copy)]
pub struct HostIdentity {
    /// The Player release family the server reaches with updates
    /// (`docs/player-updates.md`): `windows`, `macos`.
    pub family: &'static str,
    /// The product name in the user agent and host diagnostics.
    pub product: &'static str,
    /// The renderer engine name in host diagnostics.
    pub engine: &'static str,
    /// This build's Tilecast release version.
    pub release_version: &'static str,
    /// The operator configuration file name, beside the state it configures.
    pub config_file_name: &'static str,
    /// The text for a command type this platform does not support.
    pub unsupported_command: &'static str,
    /// Why a known command type is not available on this platform, if it is
    /// one the platform answers with a specific reason.
    pub unsupported_reason: fn(&str) -> Option<&'static str>,
}

impl HostIdentity {
    /// The HTTP user agent for Tilecast Server requests.
    pub fn user_agent(&self) -> String {
        format!("{}/{}", self.product, self.release_version)
    }

    /// The failure text for an unsupported command type.
    pub fn unsupported_text(&self, command_type: &str) -> &'static str {
        (self.unsupported_reason)(command_type).unwrap_or(self.unsupported_command)
    }
}

/// Dynamic device facts. Every fact degrades to a documented fallback:
/// pairing must work on a machine with incomplete platform answers.
pub trait DeviceFacts: Send + Sync + std::fmt::Debug {
    /// Pairing metadata for `player`, with an explicit display size when the
    /// caller knows better than the platform.
    fn metadata(&self, identity: &HostIdentity, player: PlayerId, display: Option<(u32, u32)>) -> DeviceMetadata;
    /// The display size the production window covers, or the fallback.
    fn display_size(&self) -> (u32, u32);
    /// Seconds since the device booted, when the platform can measure it.
    fn device_uptime_seconds(&self) -> Option<i64>;
}

/// The display size reported when the platform reports none (a session
/// without a display). Pairing metadata requires a size.
pub const HEADLESS_DISPLAY: (u32, u32) = (1920, 1080);

/// The system IANA time zone, as the reference players report it.
pub fn timezone() -> String {
    jiff::tz::TimeZone::system()
        .iana_name()
        .map(|name| name.chars().filter(|c| !c.is_control()).take(80).collect())
        .unwrap_or_else(|| "UTC".into())
}

/// The renderer host: the platform's WebView on its UI thread.
#[async_trait::async_trait]
pub trait RendererHost: Send + Sync + std::fmt::Debug {
    /// Starts the UI thread and its WebView. A platform without a renderer
    /// answers [`UiError::Unsupported`]; the engine then runs renderer-less.
    async fn spawn(&self, services: UiServices) -> Result<(UiHandle, tokio::sync::mpsc::Receiver<UiEvent>), UiError>;
    /// The engine version for host diagnostics, or `unavailable`.
    fn engine_version(&self) -> String;
    /// Whether this build ships a renderer that presents the Runtime. A
    /// build without one reports no presentation support to the server,
    /// because it cannot show the content that support would select.
    fn presents(&self) -> bool;
}

/// Final-output capture of the Player's own window.
pub trait WindowCapture: Send + Sync + std::fmt::Debug {
    /// Captures one frame of `window` (the address the UI thread published)
    /// as BGRA pixels, waiting at most `wait` for the compositor. Blocking:
    /// the caller runs it off the async runtime. The error is a bounded
    /// reason code: `no_frame`, `readback`, or another unavailable cause.
    fn capture_bgra(&self, window: usize, wait: Duration) -> Result<CapturedBgra, &'static str>;
}

/// Platform update delivery. Core dispatches `install_player_update`; the
/// platform owns the state machine that verifies and installs it.
#[async_trait::async_trait]
pub trait UpdateHost: Send + Sync + std::fmt::Debug {
    /// This build's update version code (`docs/release-process.md`).
    fn own_version_code(&self) -> u64;
    /// Validates and records an `install_player_update` command. The
    /// coordinator ([`UpdateHost::run`]) does the work.
    fn accept(&self, paths: &HostPaths, command: &ServerCommand) -> CommandResult;
    /// Runs the update coordinator until shutdown.
    async fn run(&self, context: Arc<DaemonContext>);
}

/// Everything a platform supplies, constructed once by its composition root.
#[derive(Clone)]
pub struct HostServices {
    pub identity: HostIdentity,
    pub device: Arc<dyn DeviceFacts>,
    pub renderer: Arc<dyn RendererHost>,
    pub capture: Arc<dyn WindowCapture>,
    pub updates: Arc<dyn UpdateHost>,
    /// At-rest protection for the private credential and pairing stores.
    pub sealer: Arc<dyn crate::seal::Sealer>,
    /// Free space on the state volume.
    pub space: Arc<dyn player_cas::space::SpaceProbe>,
    /// Secure no-follow opening of verified content.
    pub opener: Arc<dyn player_cas::SecureOpener>,
}

impl std::fmt::Debug for HostServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostServices").field("identity", &self.identity).finish_non_exhaustive()
    }
}
