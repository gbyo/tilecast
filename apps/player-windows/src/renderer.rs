//! The WebView2 renderer entry points for [`crate::host::WebView2Host`].

#[cfg(windows)]
pub use crate::webview::{engine_version, spawn_ui};

#[cfg(not(windows))]
/// Outside Windows there is no WebView2; the engine runs renderer-less.
pub async fn spawn_ui(
    _services: webview_host::ui::UiServices,
) -> Result<
    (webview_host::ui::UiHandle, tokio::sync::mpsc::Receiver<webview_host::ui::UiEvent>),
    webview_host::ui::UiError,
> {
    Err(webview_host::ui::UiError::Unsupported)
}

/// The WebView2 engine version for host diagnostics, unavailable off Windows.
#[cfg(not(windows))]
pub fn engine_version() -> String {
    "unavailable".to_string()
}
