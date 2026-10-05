//! The UI thread boundary. All WebView2 objects live on one COM STA
//! thread with its normal Windows message loop; Tokio tasks talk to it
//! through bounded channels, never through synchronous waits.
//!
//! Tokio→UI: a bounded command channel, woken by a window message. UI→Tokio:
//! a bounded event channel, fed by WebView2 callbacks. The renderer session
//! is the host's opaque connection id for Core's renderer tracking.

use serde_json::Value;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Commands the presentation engine posts to the UI thread.
#[derive(Debug)]
pub enum UiCommand {
    /// Posts a `HostMessageV1` JSON message to the Runtime.
    Post { message: Value },
    /// Captures the current page as PNG bytes. The conformance runner
    /// takes deterministic screenshots through this; Watch Live previews
    /// use the same path.
    CapturePreview { reply: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>> },
    /// Restarts the WebView2 controller (recovery ladder): the session
    /// ends and a fresh one begins.
    Restart { reason: String, deadline_ms: u32 },
    /// Reloads the Runtime document in place.
    Reload,
    /// Ends the message loop and joins the thread.
    Shutdown,
    /// Creates a host-layer remote web surface: the spec is already
    /// validated and tracked; the UI thread builds the child view.
    RemoteCreate { spec: crate::remote_web::SurfaceSpec },
    /// Moves or resizes a remote surface's child view.
    RemoteViewport { surface_id: String, viewport: crate::remote_web::ViewportPx },
    /// Shows or hides a remote surface's child view.
    RemoteVisible { surface_id: String, visible: bool },
    /// Mutes or unmutes a remote surface's child view.
    RemoteMuted { surface_id: String, muted: bool },
    /// Reloads a remote surface's child view.
    RemoteReload { surface_id: String },
    /// Destroys a remote surface's child view and releases its data.
    RemoteDestroy { surface_id: String },
    /// The Runtime proved content after the remote process ended.
    RemoteRecovered,
    /// Clears remote browsing data across remote profiles and answers
    /// whether the clear completed. `None` never answers (unobserved
    /// clears from the renderer command path).
    RemoteClearData { reply: Option<tokio::sync::oneshot::Sender<bool>> },
}

/// Events the UI thread reports to the presentation engine.
#[derive(Debug)]
pub enum UiEvent {
    /// A validated Runtime→host bridge message.
    Runtime(crate::bridge::RuntimeMessage),
    /// A renderer session began (startup or restart): grants bind to it.
    Session { session: uuid::Uuid },
    /// A WebView2 process exited; Core's recovery ladder decides.
    ProcessFailed { kind: String },
    /// The controller or environment failed; the session is dead.
    Fatal { reason: String },
    /// A conformance-harness message from the trusted Runtime origin.
    /// Only emitted in conformance mode; the product bridge never
    /// produces it.
    ConformanceMessage { body: String },
    /// A remote web event from a host-layer child view.
    Remote { event: crate::bridge::RemoteWebEvent },
}

/// The largest conformance-harness message the UI thread accepts.
/// Finish results carry whole checkpoint states; snapshots stay small.
pub const MAX_CONFORMANCE_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

/// Conformance mode: the UI thread shows a fixed-size window, injects the
/// harness bootstrap instead of the product bridge, and reports page
/// messages as [`UiEvent::ConformanceMessage`]. Test-only; the resource
/// path (trusted origin, scheme handlers, verified CAS serving) is the
/// exact production one.
#[derive(Debug, Clone)]
pub struct ConformanceUi {
    /// Injected before Runtime scripts execute: defines
    /// `__tilecastConformanceRunner`, then the shared fixture host.
    pub bootstrap: String,
    /// The fixture viewport: the window's exact client size.
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum UiError {
    #[error("the renderer host is not available on this platform")]
    Unsupported,
    #[error("the UI thread is gone")]
    Gone,
    #[error("the UI command queue is full")]
    Full,
    #[error("UI startup failed: {0}")]
    Startup(String),
}

/// What the UI thread needs: the verified runtime artifact, the media
/// registry shared with the port, the content store, and the renderer
/// session to bind grants to.
pub struct UiServices {
    pub runtime: crate::runtime_files::RuntimeFiles,
    pub media: Arc<std::sync::Mutex<crate::media::MediaRegistry>>,
    pub cas: player_cas::ContentStore,
    pub session: uuid::Uuid,
    pub user_data_dir: std::path::PathBuf,
    pub capabilities: Value,
    pub info: Value,
    /// `Some` runs the conformance harness instead of the product bridge.
    pub conformance: Option<ConformanceUi>,
    /// The UI thread publishes the main window address here when the
    /// window opens and clears it when the loop ends, for final-output
    /// capture. 0 means no window.
    pub main_window: Arc<std::sync::atomic::AtomicUsize>,
}

impl std::fmt::Debug for UiServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UiServices")
            .field("runtime", &self.runtime.directory)
            .field("session", &self.session)
            .finish_non_exhaustive()
    }
}

/// The Tokio-side handle to the UI thread.
#[derive(Clone)]
pub struct UiHandle {
    commands: mpsc::Sender<UiCommand>,
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl std::fmt::Debug for UiHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UiHandle").finish_non_exhaustive()
    }
}

impl UiHandle {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub(crate) fn new(commands: mpsc::Sender<UiCommand>, wake: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { commands, wake }
    }

    /// Posts a host message to the Runtime. Fails when the UI thread is
    /// gone or its queue is full; the caller maps that to the port error.
    pub fn post(&self, message: Value) -> Result<(), UiError> {
        self.send(UiCommand::Post { message })
    }

    pub fn restart(&self, reason: &str, deadline_ms: u32) -> Result<(), UiError> {
        self.send(UiCommand::Restart { reason: reason.to_owned(), deadline_ms })
    }

    pub fn reload(&self) -> Result<(), UiError> {
        self.send(UiCommand::Reload)
    }

    /// Sends a remote web command to the UI thread. Fails when the UI
    /// thread is gone or its queue is full.
    pub fn remote(&self, command: UiCommand) -> Result<(), UiError> {
        self.send(command)
    }

    /// Captures the current page as PNG bytes on the UI thread.
    pub fn capture_preview(&self) -> Result<tokio::sync::oneshot::Receiver<Result<Vec<u8>, String>>, UiError> {
        let (reply, pending) = tokio::sync::oneshot::channel();
        self.send(UiCommand::CapturePreview { reply })?;
        Ok(pending)
    }

    fn send(&self, command: UiCommand) -> Result<(), UiError> {
        match self.commands.try_send(command) {
            Ok(()) => {
                (self.wake)();
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(_)) => Err(UiError::Full),
            Err(mpsc::error::TrySendError::Closed(_)) => Err(UiError::Gone),
        }
    }

    pub fn shutdown(&self) {
        let _ = self.commands.try_send(UiCommand::Shutdown);
        (self.wake)();
    }

    pub fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0)
    }
}

#[cfg(windows)]
#[path = "webview.rs"]
mod imp;

#[cfg(windows)]
pub use imp::spawn_ui;

#[cfg(not(windows))]
/// Outside Windows there is no WebView2; the engine runs renderer-less.
pub async fn spawn_ui(_services: UiServices) -> Result<(UiHandle, mpsc::Receiver<UiEvent>), UiError> {
    Err(UiError::Unsupported)
}

/// The bootstrap script injected before Runtime scripts execute. It owns
/// the single `globalThis.tilecastRuntimeHost` object.
pub const BOOTSTRAP_JS: &str = include_str!("runtime_host.js");

/// The [`UiEvent::Fatal`] reason the UI thread reports when its message
/// loop ends because the window closed (as opposed to a failed renderer,
/// which is worth restarting).
pub const WINDOW_CLOSED: &str = "the window closed";

/// The WebView2 engine version for host diagnostics. Unknown until the
/// loader answers, and unavailable off Windows.
pub fn engine_version() -> String {
    #[cfg(windows)]
    {
        imp::engine_version()
    }
    #[cfg(not(windows))]
    {
        "unavailable".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_exposes_exactly_the_contract_global() {
        assert!(BOOTSTRAP_JS.contains("tilecastRuntimeHost"));
        assert!(!BOOTSTRAP_JS.contains("AddHostObjectToScript"));
    }

    #[test]
    fn a_full_queue_fails_instead_of_blocking() {
        let (tx, _rx) = mpsc::channel(1);
        let handle = UiHandle::new(tx, Arc::new(|| {}));
        handle.post(Value::Null).expect("first");
        assert_eq!(handle.post(Value::Null), Err(UiError::Full));
    }
}
