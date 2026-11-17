//! The WKWebView Runtime renderer ([`crate::host::WebKitHost`]).
//!
//! The renderer presents the shared Player Runtime at
//! `tilecast://runtime/index.html` in one WKWebView on the main thread.
//! The shared WebView host owns everything above it: the presentation
//! engine, the Runtime projection, media grants, the scheme policy
//! (`webview_host::serve`), the bridge parser, and the recovery ladder.
//! This module supplies the WebKit transport for those contracts and
//! nothing else.

pub mod policy;

#[cfg(target_os = "macos")]
mod remote;
#[cfg(target_os = "macos")]
mod view;

#[cfg(target_os = "macos")]
pub use view::{engine_version, spawn_ui};

/// Off macOS there is no WebKit; the engine runs renderer-less.
#[cfg(not(target_os = "macos"))]
pub async fn spawn_ui(
    _services: webview_host::ui::UiServices,
) -> Result<
    (webview_host::ui::UiHandle, tokio::sync::mpsc::Receiver<webview_host::ui::UiEvent>),
    webview_host::ui::UiError,
> {
    Err(webview_host::ui::UiError::Unsupported)
}

/// The WebKit version for host diagnostics, unavailable off macOS.
#[cfg(not(target_os = "macos"))]
pub fn engine_version() -> String {
    "unavailable".to_owned()
}
