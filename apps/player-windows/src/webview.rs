//! The STA WebView2 host. Every WebView2 object lives on the `tilecast-ui`
//! thread, which runs its normal Windows message loop; nothing here ever
//! waits synchronously for an asynchronous WebView2 operation.
//!
//! Creation is a state machine driven by completion callbacks:
//! environment (with the `tilecast` and `tcmedia` custom schemes) →
//! controller → settings/scripts/events → navigation. Commands from Tokio
//! arrive as window messages; Runtime reports and process failures go back
//! over the bounded event channel.
//!
//! `unsafe` in this file is WebView2/Win32 glue only, each call justified
//! where it happens. Everything above it is safe Tilecast semantic types.
//! (This module and `streams` share `win32`'s discipline: scoped
//! `allow(unsafe_code)` under the workspace `deny`, one justification per
//! call. Raw Win32 stays in `win32`; WebView2 COM cannot live anywhere but
//! its STA thread.)
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::*;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize};
use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_APP, WM_DISPLAYCHANGE, WM_TIMER};
use windows::core::{BOOL, HSTRING, Interface as _, PCWSTR, PWSTR};

use crate::media::RendererInstance;
use crate::ui::{BOOTSTRAP_JS, MAX_CONFORMANCE_MESSAGE_BYTES, UiCommand, UiError, UiEvent, UiHandle, UiServices};

/// Conformance-only browser switches: media autoplays without a gesture
/// (fixtures drive playback programmatically) and screenshots compare in
/// sRGB, as the Electron runner does. The GPU stays exactly as in
/// production: software rasterization would hide renderer bugs.
const CONFORMANCE_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required --force-color-profile=srgb";

/// Tokio→UI wakeups ride a private window message.
const WM_TILECAST_COMMAND: u32 = WM_APP + 1;

/// Offered to WebView2 first; the Evergreen runtime is used when no
/// pinned version is requested.
const BROWSER_FOLDER: PCWSTR = PCWSTR::null();

/// Remote web user-data, below the main user-data directory. The remote
/// environment is a separate WebView2 environment (own browser process,
/// own profiles) so remote content never shares storage, cookies, or
/// permissions with the trusted Runtime.
const REMOTE_DATA_DIR: &str = "remote-web";

/// The Tilecast-owned YouTube wrapper files, below the remote user-data
/// directory. `org.tilecast.player` maps here so the wrapper has the real
/// origin the YouTube iframe API requires.
const WRAPPER_DIR: &str = "youtube-wrappers";

/// Remote-only browser switches. Signage has no gestures, so autoplay
/// needs no gesture; surfaces still start muted per spec and unmute only
/// when the Runtime shows them with sound.
const REMOTE_BROWSER_ARGS: &str = "--autoplay-policy=no-user-gesture-required";

/// `WM_TIMER` id for the YouTube wrapper state poll.
const YOUTUBE_TIMER_ID: usize = 1;

/// Navigated hosts remembered per surface, bounding the `first_party`
/// cookie-strip enumeration.
const MAX_TRACKED_HOSTS: usize = 64;

/// Shared remote profiles. `disabled` and storage-less surfaces get
/// unique per-surface profiles instead (see `remote_profile`).
const PROFILE_FIRST_PARTY: &str = "tc-rw-first-party";
const PROFILE_PERSISTENT: &str = "tc-rw-persistent";
const PROFILE_YOUTUBE: &str = "tc-rw-youtube";

fn pwstr_to_string(value: PWSTR) -> String {
    if value.is_null() {
        return String::new();
    }
    // SAFETY: WebView2 out-strings are valid null-terminated UTF-16;
    // `take_pwstr` frees the CoTaskMem allocation exactly once.
    take_pwstr(value)
}

fn emit(events: &mpsc::Sender<UiEvent>, event: UiEvent) {
    if events.try_send(event).is_err() {
        tracing::warn!(component = "webview", event = "event_queue_full");
    }
}

struct Host {
    window: windows_window::Window,
    env: Option<ICoreWebView2Environment>,
    controller: Option<ICoreWebView2Controller>,
    webview: Option<ICoreWebView2>,
    services: UiServices,
    events: mpsc::Sender<UiEvent>,
    bootstrap: String,
    navigated: bool,
    pending: Vec<serde_json::Value>,
    runtime: tokio::runtime::Runtime,
    ready: Option<std::sync::mpsc::Sender<std::result::Result<(), String>>>,
    _tokens: Vec<i64>,
    /// The remote web environment. `None` until it is created, after a
    /// browser-process exit, and in conformance mode (fixtures never
    /// create remote surfaces).
    remote_env: Option<ICoreWebView2Environment>,
    /// The remote environment cannot serve: creation failed or its
    /// browser process exited. Only `RemoteRecovered` retries.
    remote_dead: bool,
    /// Live remote surfaces by id. An entry without a controller is a
    /// create still waiting for its completion.
    remote_views: HashMap<String, RemoteSurface>,
    /// Monotonic per-surface profile counter; unique profile names never
    /// repeat within the process.
    remote_profile_seq: u64,
    /// A hidden child window parenting transient clear controllers.
    janitor: Option<*mut std::ffi::c_void>,
    /// The YouTube poll timer runs while a YouTube view is wired.
    youtube_polling: bool,
}

/// One host-layer remote web surface: a child window of the main window
/// with its own WebView2 controller in the remote environment.
struct RemoteSurface {
    /// The validated spec. The viewport/visible/muted mirror follows
    /// later commands; content and policy never change.
    spec: crate::remote_web::SurfaceSpec,
    child: *mut std::ffi::c_void,
    controller: Option<ICoreWebView2Controller>,
    webview: Option<ICoreWebView2>,
    profile_name: String,
    loaded: bool,
    stream_ready: bool,
    failed: bool,
    youtube_ended: bool,
    /// Navigated hosts, bounded, for the `first_party` cookie strip.
    hosts: Vec<String>,
    _tokens: Vec<i64>,
}

type SharedHost = Rc<RefCell<Option<Host>>>;

fn take_host(host: &SharedHost) -> Option<Host> {
    host.borrow_mut().take()
}

fn put_host(cell: &SharedHost, host: Host) {
    *cell.borrow_mut() = Some(host);
}

impl Host {
    fn post_or_queue(&mut self, message: serde_json::Value) {
        match serde_json::to_string(&message) {
            Ok(encoded) if encoded.len() <= crate::bridge::MAX_HOST_MESSAGE_BYTES => {
                match &self.webview {
                    Some(webview) if self.navigated => {
                        let text = HSTRING::from(&encoded);
                        // SAFETY: STA thread owns the WebView2 object.
                        if let Err(error) = unsafe { webview.PostWebMessageAsJson(&text) } {
                            tracing::warn!(component = "webview", event = "post_failed", error = %error);
                        }
                    }
                    _ => {
                        if self.pending.len() < 16 {
                            self.pending.push(message);
                        }
                    }
                }
            }
            _ => tracing::warn!(component = "webview", event = "host_message_too_large"),
        }
    }

    fn flush_pending(&mut self) {
        let pending = std::mem::take(&mut self.pending);
        for message in pending {
            self.post_or_queue(message);
        }
    }

    fn reload(&self) {
        if let Some(webview) = &self.webview {
            // SAFETY: STA thread owns the WebView2 object.
            if let Err(error) = unsafe { webview.Reload() } {
                tracing::warn!(component = "webview", event = "reload_failed", error = %error);
            }
        }
    }

    fn current_source_is_runtime(&self) -> bool {
        let webview = match &self.webview {
            Some(webview) => webview,
            None => return false,
        };
        let mut source = PWSTR::null();
        // SAFETY: STA thread owns the WebView2 object; `source` receives a
        // CoTaskMem string freed by `take_pwstr`.
        if unsafe { webview.Source(&mut source) }.is_err() {
            return false;
        }
        crate::schemes::is_trusted_runtime_source(&pwstr_to_string(source))
    }

    /// Answers one resource request synchronously. CAS opens run on the
    /// thread-local runtime; reads are bounded file IO, never whole files.
    fn answer_resource(
        &mut self,
        uri: &str,
        method: &str,
        range: Option<String>,
    ) -> (i32, &'static str, String, windows::Win32::System::Com::IStream) {
        let text_response = |status: i32, reason: &'static str, mime: &str, body: Vec<u8>| {
            let headers =
                format!("Content-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n", body.len());
            (status, reason, headers, crate::streams::MemStream::new(body))
        };
        if method != "GET" && method != "HEAD" {
            return text_response(405, "Method Not Allowed", "text/plain", b"method not allowed".to_vec());
        }
        let head_only = method == "HEAD";
        match crate::schemes::parse_request_url(uri) {
            Some(crate::schemes::SchemeRequest::Runtime(request)) => {
                match self.services.runtime.read(&request.path) {
                    Some(body) => {
                        let mime = crate::runtime_files::mime_type(&request.path);
                        let body = if head_only { Vec::new() } else { body };
                        // Content-Length always names the full object, even
                        // for HEAD, per the HTTP semantics video elements
                        // and the Runtime rely on.
                        let full = self.services.runtime.entry(&request.path).map(|entry| entry.bytes).unwrap_or(0);
                        let headers = format!(
                            "Content-Type: {mime}\r\nContent-Length: {full}\r\nAccept-Ranges: none\r\nCache-Control: no-store\r\n"
                        );
                        (200, "OK", headers, crate::streams::MemStream::new(body))
                    }
                    None => text_response(404, "Not Found", "text/plain", b"not found".to_vec()),
                }
            }
            Some(crate::schemes::SchemeRequest::Media(request)) => {
                if !self.current_source_is_runtime() {
                    return text_response(404, "Not Found", "text/plain", b"not found".to_vec());
                }
                let grant = {
                    let media = self.services.media.lock().unwrap_or_else(|poison| poison.into_inner());
                    media.resolve(self.services.session, &request.capability, now_ms()).cloned()
                };
                // Unknown, expired, retired, and wrong-session capabilities
                // all answer identically.
                serve_grant(&self.services.cas, &self.runtime, grant, range, head_only)
            }
            Some(crate::schemes::SchemeRequest::MediaVariant(request)) => {
                if !self.current_source_is_runtime() {
                    return text_response(404, "Not Found", "text/plain", b"not found".to_vec());
                }
                let grant = {
                    let media = self.services.media.lock().unwrap_or_else(|poison| poison.into_inner());
                    media.resolve_variant(self.services.session, request.asset_id, request.variant_id, now_ms())
                };
                serve_grant(&self.services.cas, &self.runtime, grant, range, head_only)
            }
            Some(crate::schemes::SchemeRequest::Widget(request)) => {
                if !self.current_source_is_runtime() {
                    return text_response(404, "Not Found", "text/plain", b"not found".to_vec());
                }
                let grant = {
                    let media = self.services.media.lock().unwrap_or_else(|poison| poison.into_inner());
                    media.resolve_frame(self.services.session, &request.capability, now_ms()).cloned()
                };
                // Media capabilities presented here resolve to nothing:
                // grant usage is pinned at mint time.
                serve_frame(&self.services.cas, &self.runtime, grant, range, head_only)
            }
            None => text_response(404, "Not Found", "text/plain", b"not found".to_vec()),
        }
    }
}
/// Serves one resolved media grant: capability and variant loads share
/// everything past authorization. Every failure answers an identical 404.
fn serve_grant(
    cas: &player_cas::ContentStore,
    runtime: &tokio::runtime::Runtime,
    grant: Option<crate::media::MediaGrant>,
    range: Option<String>,
    head_only: bool,
) -> (i32, &'static str, String, windows::Win32::System::Com::IStream) {
    use crate::streams::MemStream;
    let empty = || MemStream::new(Vec::new());
    let missing = || {
        (
            404,
            "Not Found",
            "Content-Type: text/plain\r\nContent-Length: 9\r\nCache-Control: no-store\r\n".to_string(),
            MemStream::new(b"not found".to_vec()),
        )
    };
    let Some(grant) = grant else {
        return missing();
    };
    // The UI thread answers resource requests synchronously. Verified
    // objects only cost a metadata lookup plus an open; first-touch
    // re-hashes happen at most once per object per boot.
    let opened = cas.clone();
    let Ok(Some((file, record))) = runtime.block_on(opened.open_verified(&grant.sha256)) else {
        return missing();
    };
    if record.size_bytes != grant.size_bytes {
        return missing();
    }
    match crate::ranges::parse_range(range.as_deref(), grant.size_bytes) {
        crate::ranges::RangeOutcome::Entire => {
            let stream = crate::streams::FileRangeStream::new(file, 0, grant.size_bytes);
            let headers = format!(
                "Content-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\n",
                grant.mime_type, grant.size_bytes
            );
            if head_only { (200, "OK", headers, empty()) } else { (200, "OK", headers, stream) }
        }
        crate::ranges::RangeOutcome::Partial(interval) => {
            let stream = crate::streams::FileRangeStream::new(file, interval.start, interval.len());
            let headers = format!(
                "Content-Type: {}\r\nContent-Length: {}\r\nContent-Range: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\n",
                grant.mime_type,
                interval.len(),
                interval.content_range(grant.size_bytes)
            );
            if head_only {
                (206, "Partial Content", headers, empty())
            } else {
                (206, "Partial Content", headers, stream)
            }
        }
        crate::ranges::RangeOutcome::Unsatisfiable => {
            let headers = format!("Content-Range: bytes */{}\r\nCache-Control: no-store\r\n", grant.size_bytes);
            (416, "Range Not Satisfiable", headers, empty())
        }
    }
}

/// Serves one resolved frame grant: whole documents only, confined by the
/// shared frame sandbox policy. Mirrors `serve_grant`'s verified open and
/// size check; every failure answers an identical 404, and any Range
/// answers 416 because a partial frame can never execute.
fn serve_frame(
    cas: &player_cas::ContentStore,
    runtime: &tokio::runtime::Runtime,
    grant: Option<crate::media::MediaGrant>,
    range: Option<String>,
    head_only: bool,
) -> (i32, &'static str, String, windows::Win32::System::Com::IStream) {
    use crate::streams::MemStream;
    let empty = || MemStream::new(Vec::new());
    let missing = || {
        (
            404,
            "Not Found",
            "Content-Type: text/plain\r\nContent-Length: 9\r\nCache-Control: no-store\r\n".to_string(),
            MemStream::new(b"not found".to_vec()),
        )
    };
    let Some(grant) = grant else {
        return missing();
    };
    debug_assert_eq!(grant.kind, crate::media::MediaGrantKind::Frame);
    if range.is_some() {
        let headers = format!("Content-Range: bytes */{}\r\nCache-Control: no-store\r\n", grant.size_bytes);
        return (416, "Range Not Satisfiable", headers, empty());
    }
    let opened = cas.clone();
    let Ok(Some((file, record))) = runtime.block_on(opened.open_verified(&grant.sha256)) else {
        return missing();
    };
    if record.size_bytes != grant.size_bytes {
        return missing();
    }
    let headers = crate::schemes::frame_response_headers(grant.size_bytes);
    if head_only {
        (200, "OK", headers, empty())
    } else {
        let stream = crate::streams::FileRangeStream::new(file, 0, grant.size_bytes);
        (200, "OK", headers, stream)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// The installed WebView2 engine version, for host diagnostics. Asked
/// before any environment exists; "unknown" when the loader cannot answer.
pub fn engine_version() -> String {
    let mut version = PWSTR::null();
    // SAFETY: a loader query with no COM state; `version` receives a
    // CoTaskMem string freed by `take_pwstr`.
    if unsafe { GetAvailableCoreWebView2BrowserVersionString(BROWSER_FOLDER, &mut version) }.is_err() {
        return "unknown".to_string();
    }
    let version = pwstr_to_string(version);
    if version.is_empty() { "unknown".to_string() } else { version }
}

impl std::fmt::Debug for Host {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Host")
            .field("navigated", &self.navigated)
            .field("pending", &self.pending.len())
            .field("session", &self.services.session)
            .finish_non_exhaustive()
    }
}

/// Starts the `tilecast-ui` STA thread and waits (without blocking it) for
/// the first navigation to begin. The window, the WebView2 environment,
/// and every COM object stay on that thread for its whole life.
pub async fn spawn_ui(services: UiServices) -> std::result::Result<(UiHandle, mpsc::Receiver<UiEvent>), UiError> {
    let (commands_tx, commands_rx) = mpsc::channel(32);
    let (events_tx, events_rx) = mpsc::channel(64);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let hwnd = Arc::new(AtomicUsize::new(0));
    let wake_hwnd = Arc::clone(&hwnd);
    let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        let raw = wake_hwnd.load(Ordering::SeqCst) as *mut std::ffi::c_void;
        if !raw.is_null() {
            // SAFETY: `raw` is the UI thread's window, which outlives every
            // handle; PostMessageW only queues and never blocks the caller.
            unsafe {
                let _ = PostMessageW(Some(HWND(raw)), WM_TILECAST_COMMAND, WPARAM(0), LPARAM(0));
            }
        }
    });
    let handle = UiHandle::new(commands_tx.clone(), Arc::clone(&wake));
    std::thread::Builder::new()
        .name("tilecast-ui".to_string())
        .spawn(move || run_ui_thread(services, commands_rx, events_tx, ready_tx, hwnd))
        .map_err(|error| UiError::Startup(error.to_string()))?;
    let started = tokio::task::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(60)))
        .await
        .map_err(|error| UiError::Startup(error.to_string()))?;
    match started {
        Ok(Ok(())) => Ok((handle, events_rx)),
        Ok(Err(reason)) => Err(UiError::Startup(reason)),
        Err(_) => {
            // The loop may still be running behind a hung creation call;
            // ask it to quit rather than leak the thread.
            let _ = commands_tx.try_send(UiCommand::Shutdown);
            wake();
            Err(UiError::Startup("the renderer did not start in time".to_string()))
        }
    }
}

fn run_ui_thread(
    services: UiServices,
    commands_rx: mpsc::Receiver<UiCommand>,
    events_tx: mpsc::Sender<UiEvent>,
    ready_tx: std::sync::mpsc::Sender<std::result::Result<(), String>>,
    hwnd_slot: Arc<AtomicUsize>,
) {
    // SAFETY: the first COM call on this thread; STA matches WebView2, and
    // OLE1DDE is a legacy drag-drop path a signage player never needs.
    if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_err() {
        let _ = ready_tx.send(Err("COM did not initialize".to_string()));
        return;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = ready_tx.send(Err(error.to_string()));
            // SAFETY: matches the CoInitializeEx above.
            unsafe { CoUninitialize() };
            return;
        }
    };
    let bootstrap = match services.conformance.as_ref() {
        Some(conformance) => conformance.bootstrap.clone(),
        None => BOOTSTRAP_JS
            .replace(
                "__TILECAST_HOST_INFO__",
                &serde_json::to_string(&services.info).unwrap_or_else(|_| "{}".to_string()),
            )
            .replace(
                "__TILECAST_HOST_CAPABILITIES__",
                &serde_json::to_string(&services.capabilities).unwrap_or_else(|_| "{}".to_string()),
            ),
    };

    let cell: SharedHost = Rc::new(RefCell::new(None));
    let queue = Rc::new(RefCell::new(commands_rx));
    let commands_cell = Rc::clone(&cell);
    let commands_queue = Rc::clone(&queue);
    let resize_cell = Rc::clone(&cell);
    // A conformance window is a borderless popup at exactly the
    // fixture viewport: client size equals window size, so screenshots
    // need no crop or scale.
    let builder = windows_window::Window::new("Tilecast");
    let builder = match services.conformance.as_ref() {
        Some(conformance) => {
            use windows::Win32::UI::WindowsAndMessaging::WS_POPUP;
            builder.size(conformance.width, conformance.height).style(WS_POPUP.0)
        }
        None => builder,
    };
    // A display change (resolution, scale, monitor move) re-covers the
    // monitor in production; conformance keeps its exact fixture size.
    let production_window = services.conformance.is_none();
    let display_hwnd = Arc::clone(&hwnd_slot);
    let window = match builder
        .on_message(move |_, message, _, _| {
            if message == WM_TILECAST_COMMAND {
                drain_commands(&commands_cell, &commands_queue);
                Some(0)
            } else if message == WM_TIMER {
                poll_youtube_surfaces(&commands_cell);
                Some(0)
            } else if production_window && message == WM_DISPLAYCHANGE {
                let raw = display_hwnd.load(Ordering::SeqCst);
                if raw != 0 {
                    crate::win32::enter_fullscreen(raw as *mut std::ffi::c_void);
                }
                None
            } else {
                None
            }
        })
        .on_resize(move |width, height| {
            if let Some(host) = resize_cell.borrow().as_ref()
                && let Some(controller) = host.controller.as_ref()
            {
                let bounds = RECT { left: 0, top: 0, right: width, bottom: height };
                // SAFETY: the STA thread owns the controller.
                unsafe {
                    let _ = controller.SetBounds(bounds);
                }
            }
        })
        .create()
    {
        Ok(window) => window,
        Err(error) => {
            let _ = ready_tx.send(Err(format!("the window did not open: {error}")));
            // SAFETY: matches the CoInitializeEx above.
            unsafe { CoUninitialize() };
            return;
        }
    };
    hwnd_slot.store(window.hwnd() as usize, Ordering::SeqCst);
    services.main_window.store(window.hwnd() as usize, Ordering::SeqCst);
    // A production window becomes the signage surface: borderless
    // fullscreen with the cursor hidden and display sleep held off for
    // the session. Conformance keeps its exact fixture size.
    let production = services.conformance.is_none();
    if production {
        // The signage surface: cursor hidden, borderless fullscreen over
        // its monitor, display sleep held off for the session. The cursor
        // helpers normalize the process-global ShowCursor counter, so a
        // previous crash cannot stack hidden states.
        crate::win32::hide_cursor();
        crate::win32::enter_fullscreen(hwnd_slot.load(Ordering::SeqCst) as *mut std::ffi::c_void);
        crate::win32::inhibit_sleep();
    }
    put_host(
        &cell,
        Host {
            window,
            env: None,
            controller: None,
            webview: None,
            services,
            events: events_tx,
            bootstrap,
            navigated: false,
            pending: Vec::new(),
            runtime,
            ready: Some(ready_tx),
            _tokens: Vec::new(),
            remote_env: None,
            remote_dead: false,
            remote_views: HashMap::new(),
            remote_profile_seq: 0,
            janitor: None,
            youtube_polling: false,
        },
    );
    // A Shutdown that arrived before the loop started (the spawn_ui
    // timeout path) still takes effect.
    drain_commands(&cell, &queue);
    create_environment(&cell);
    windows_window::run();

    // The loop only ends on quit or window close. Close the controller
    // before the window dies, release the session's grants, and tell the
    // engine the session is over; a shutting-down engine has already
    // dropped the receiver, which makes the emit a silent no-op.
    if let Some(mut host) = take_host(&cell) {
        if let Some(controller) = host.controller.take() {
            // SAFETY: the STA thread owns the controller.
            unsafe {
                let _ = controller.Close();
            }
        }
        host.webview = None;
        // Remote views close with the process; their data was released
        // per surface, and the next boot sweeps stale unique profiles.
        for (_, surface) in host.remote_views.drain() {
            if let Some(controller) = surface.controller {
                // SAFETY: the STA thread owns the controller.
                unsafe {
                    let _ = controller.Close();
                }
            }
            crate::win32::destroy_remote_child(surface.child);
        }
        if let Some(janitor) = host.janitor.take() {
            crate::win32::destroy_remote_child(janitor);
        }
        let mut media = host.services.media.lock().unwrap_or_else(|poison| poison.into_inner());
        media.unbind_renderer(host.services.session);
        drop(media);
        let production = host.services.conformance.is_none();
        host.services.main_window.store(0, Ordering::SeqCst);
        emit(&host.events, UiEvent::Fatal { reason: crate::ui::WINDOW_CLOSED.to_string() });
        drop(host);
        if production {
            crate::win32::restore_sleep();
            crate::win32::show_cursor();
        }
    }
    // SAFETY: matches the CoInitializeEx above.
    unsafe { CoUninitialize() };
}

/// Reports a startup failure exactly once (the first navigation also
/// consumes the rendezvous) and ends the message loop.
fn fail_startup(cell: &SharedHost, reason: String) {
    if let Some(mut host) = take_host(cell) {
        if let Some(ready) = host.ready.take() {
            let _ = ready.send(Err(reason.clone()));
        }
        emit(&host.events, UiEvent::Fatal { reason });
        put_host(cell, host);
    }
    windows_window::quit();
}

fn scheme_registration(scheme: &str) -> ICoreWebView2CustomSchemeRegistration {
    let registration = CoreWebView2CustomSchemeRegistration::new(scheme.to_string());
    // SAFETY: the STA thread owns this options object; it is configured
    // once, before the environment reads it.
    unsafe {
        registration.set_treat_as_secure(true);
        registration.set_has_authority_component(true);
        registration.set_allowed_origins(vec!["tilecast://runtime".to_string()]);
    }
    registration.into()
}

fn create_environment(cell: &SharedHost) {
    let options_impl = CoreWebView2EnvironmentOptions::default();
    let conformance = cell.borrow().as_ref().is_some_and(|host| host.services.conformance.is_some());
    // SAFETY: as in `scheme_registration`.
    unsafe {
        options_impl.set_scheme_registrations(vec![
            Some(scheme_registration(crate::schemes::RUNTIME_SCHEME)),
            Some(scheme_registration(crate::schemes::MEDIA_SCHEME)),
        ]);
        if conformance {
            options_impl.set_additional_browser_arguments(CONFORMANCE_BROWSER_ARGS.to_string());
            options_impl.set_language("en-US".to_string());
        }
    }
    let options: ICoreWebView2EnvironmentOptions = options_impl.into();
    let user_data_dir = match cell.borrow().as_ref() {
        Some(host) => host.services.user_data_dir.clone(),
        None => return,
    };
    use std::os::windows::ffi::OsStrExt as _;
    let wide: Vec<u16> = user_data_dir.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let created_cell = Rc::clone(cell);
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, env: Option<ICoreWebView2Environment>| {
            match (result, env) {
                (Ok(()), Some(env)) => {
                    if let Some(mut host) = take_host(&created_cell) {
                        host.env = Some(env);
                        put_host(&created_cell, host);
                    }
                    create_controller(&created_cell);
                }
                _ => fail_startup(&created_cell, "the WebView2 runtime is missing or unusable".to_string()),
            }
            Ok(())
        },
    ));
    // SAFETY: the STA thread owns the options and handler (both AddRef'd
    // by the call); the loader copies the path before returning.
    let status =
        unsafe { CreateCoreWebView2EnvironmentWithOptions(BROWSER_FOLDER, PCWSTR(wide.as_ptr()), &options, &handler) };
    if status.is_err() {
        fail_startup(cell, "the WebView2 runtime is missing or unusable".to_string());
    }
}

fn create_controller(cell: &SharedHost) {
    let (parent, env) = match cell.borrow().as_ref() {
        Some(host) => match host.env.clone() {
            Some(env) => (host.window.hwnd(), env),
            None => return,
        },
        None => return,
    };
    let created_cell = Rc::clone(cell);
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, controller: Option<ICoreWebView2Controller>| {
            match (result, controller) {
                (Ok(()), Some(controller)) => wire_controller(&created_cell, controller),
                _ => fail_startup(&created_cell, "the WebView2 controller could not start".to_string()),
            }
            Ok(())
        },
    ));
    // SAFETY: `parent` is this thread's live window; the handler is
    // AddRef'd by the call.
    if unsafe { env.CreateCoreWebView2Controller(HWND(parent), &handler) }.is_err() {
        fail_startup(cell, "the WebView2 controller could not start".to_string());
    }
}

fn wire_controller(cell: &SharedHost, controller: ICoreWebView2Controller) {
    let Some(mut host) = take_host(cell) else { return };
    match wire_host(&mut host, cell, &controller) {
        Ok(()) => {
            host.controller = Some(controller);
            if let Some(ready) = host.ready.take() {
                let _ = ready.send(Ok(()));
            }
            put_host(cell, host);
            // The remote environment builds alongside the wired main
            // controller; its readiness arrives as a host-wide event and
            // never gates the trusted Runtime.
            create_remote_environment(cell);
        }
        Err(reason) => {
            drop(host);
            fail_startup(cell, reason);
        }
    }
}

/// Locks the settings down, registers every event, injects the bootstrap,
/// and starts the first navigation. Every fallible step fails the whole
/// controller: a half-wired renderer must never present content.
fn wire_host(
    host: &mut Host,
    cell: &SharedHost,
    controller: &ICoreWebView2Controller,
) -> std::result::Result<(), String> {
    // SAFETY: for the rest of this function the STA thread owns the
    // controller, the webview, and every args object; out-params are
    // valid for their call.
    let webview = unsafe { controller.CoreWebView2() }
        .map_err(|error| format!("the WebView2 controller could not start: {error}"))?;
    let (width, height) = host.window.client_size();
    unsafe {
        let _ = controller.SetBounds(RECT { left: 0, top: 0, right: width, bottom: height });
    }
    if let Ok(settings) = unsafe { webview.Settings() } {
        unsafe {
            let _ = settings.SetIsScriptEnabled(true);
            let _ = settings.SetAreDefaultScriptDialogsEnabled(false);
            let _ = settings.SetAreDevToolsEnabled(false);
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            let _ = settings.SetAreHostObjectsAllowed(false);
        }
    }

    let Some(env) = host.env.clone() else {
        return Err("the WebView2 controller could not start".to_string());
    };
    let mut token = 0i64;
    for pattern in ["tilecast://*/*", "tcmedia://*/*"] {
        unsafe {
            webview
                .AddWebResourceRequestedFilter(&HSTRING::from(pattern), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL)
                .map_err(|error| format!("resource interception failed: {error}"))?;
        }
    }

    let resource_cell = Rc::clone(cell);
    let resource_env = env.clone();
    let resource_handler = WebResourceRequestedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2WebResourceRequestedEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let (status, reason, headers, stream) = answer_request(&resource_cell, &args);
            let response = unsafe {
                resource_env.CreateWebResourceResponse(&stream, status, &HSTRING::from(reason), &HSTRING::from(headers))
            }?;
            unsafe { args.SetResponse(&response)? };
            Ok(())
        },
    ));
    unsafe {
        webview
            .add_WebResourceRequested(&resource_handler, &mut token)
            .map_err(|error| format!("resource interception failed: {error}"))?;
    }
    host._tokens.push(token);

    let message_cell = Rc::clone(cell);
    let message_handler = WebMessageReceivedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2WebMessageReceivedEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let mut source = PWSTR::null();
            if unsafe { args.Source(&mut source) }.is_err() {
                return Ok(());
            }
            if !crate::schemes::is_trusted_runtime_source(&pwstr_to_string(source)) {
                tracing::warn!(component = "webview", event = "foreign_web_message_ignored");
                return Ok(());
            }
            let mut text = PWSTR::null();
            if unsafe { args.TryGetWebMessageAsString(&mut text) }.is_err() {
                return Ok(());
            }
            let text = pwstr_to_string(text);
            let conformance = message_cell.borrow().as_ref().is_some_and(|host| host.services.conformance.is_some());
            if conformance {
                if text.len() > MAX_CONFORMANCE_MESSAGE_BYTES
                    || serde_json::from_str::<serde_json::Value>(&text).is_err()
                {
                    tracing::warn!(component = "webview", event = "conformance_message_rejected");
                    return Ok(());
                }
                if let Some(host) = message_cell.borrow().as_ref() {
                    emit(&host.events, UiEvent::ConformanceMessage { body: text });
                }
                return Ok(());
            }
            match crate::bridge::parse_runtime_message(&text) {
                Some(message) => {
                    if let Some(host) = message_cell.borrow().as_ref() {
                        emit(&host.events, UiEvent::Runtime(message));
                    }
                }
                None => tracing::warn!(component = "webview", event = "bridge_message_rejected"),
            }
            Ok(())
        },
    ));
    unsafe {
        webview
            .add_WebMessageReceived(&message_handler, &mut token)
            .map_err(|error| format!("message bridge failed: {error}"))?;
    }
    host._tokens.push(token);

    let failed_cell = Rc::clone(cell);
    let failed_handler = ProcessFailedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2ProcessFailedEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
            // SAFETY: the STA thread owns the args.
            unsafe {
                let _ = args.ProcessFailedKind(&mut kind);
            }
            // The reason needs the Args2 interface; an old runtime that
            // lacks it still reports the kind.
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON(0);
            if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                // SAFETY: as above.
                unsafe {
                    let _ = args2.Reason(&mut reason);
                }
            }
            let kind = format!("{}:{}", process_failed_kind(kind), process_failed_reason(reason));
            if let Some(host) = failed_cell.borrow().as_ref() {
                emit(&host.events, UiEvent::ProcessFailed { kind });
            }
            Ok(())
        },
    ));
    unsafe {
        webview
            .add_ProcessFailed(&failed_handler, &mut token)
            .map_err(|error| format!("process monitoring failed: {error}"))?;
    }
    host._tokens.push(token);

    let navigation_cell = Rc::clone(cell);
    let navigation_handler = NavigationCompletedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let mut succeeded = BOOL(0);
            if unsafe { args.IsSuccess(&mut succeeded) }.is_err() || !succeeded.as_bool() {
                if let Some(host) = navigation_cell.borrow().as_ref() {
                    emit(&host.events, UiEvent::Fatal { reason: "the runtime document failed to load".to_string() });
                }
                return Ok(());
            }
            if let Some(mut host) = take_host(&navigation_cell) {
                host.navigated = true;
                host.flush_pending();
                put_host(&navigation_cell, host);
            }
            Ok(())
        },
    ));
    unsafe {
        webview
            .add_NavigationCompleted(&navigation_handler, &mut token)
            .map_err(|error| format!("navigation monitoring failed: {error}"))?;
    }
    host._tokens.push(token);

    // A signage player never opens popups: window.open and target=_blank
    // die here, on every zone kind.
    let popup_handler = NewWindowRequestedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2NewWindowRequestedEventArgs>| {
            if let Some(args) = args {
                unsafe {
                    let _ = args.SetHandled(true);
                }
            }
            Ok(())
        },
    ));
    unsafe {
        webview
            .add_NewWindowRequested(&popup_handler, &mut token)
            .map_err(|error| format!("popup blocking failed: {error}"))?;
    }
    host._tokens.push(token);

    let script_handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(
        move |_: windows::core::Result<()>, _: String| Ok(()),
    ));
    unsafe {
        webview
            .AddScriptToExecuteOnDocumentCreated(&HSTRING::from(host.bootstrap.as_str()), &script_handler)
            .map_err(|error| format!("bootstrap injection failed: {error}"))?;
    }

    unsafe {
        webview
            .Navigate(&HSTRING::from(crate::schemes::RUNTIME_ENTRY_URL))
            .map_err(|error| format!("the runtime document failed to load: {error}"))?;
    }
    host.navigated = false;
    {
        let mut media = host.services.media.lock().unwrap_or_else(|poison| poison.into_inner());
        media.bind_renderer(RendererInstance { session: host.services.session });
    }
    emit(&host.events, UiEvent::Session { session: host.services.session });
    host.webview = Some(webview);
    Ok(())
}

/// Answers one intercepted request. Every failure path returns a plain
/// 404: the renderer learns nothing about what exists.
fn answer_request(
    cell: &SharedHost,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
) -> (i32, &'static str, String, windows::Win32::System::Com::IStream) {
    use crate::streams::MemStream;
    let fallback = || {
        (
            404,
            "Not Found",
            "Content-Type: text/plain\r\nContent-Length: 9\r\nCache-Control: no-store\r\n".to_string(),
            MemStream::new(b"not found".to_vec()),
        )
    };
    // SAFETY: the STA thread owns the args; out-params are valid for
    // their call.
    let request = match unsafe { args.Request() } {
        Ok(request) => request,
        Err(_) => return fallback(),
    };
    let mut uri = PWSTR::null();
    let mut method = PWSTR::null();
    if unsafe { request.Uri(&mut uri) }.is_err() || unsafe { request.Method(&mut method) }.is_err() {
        return fallback();
    }
    let range = request_range_header(&request);
    let Some(mut host) = take_host(cell) else { return fallback() };
    let answered = host.answer_resource(&pwstr_to_string(uri), &pwstr_to_string(method), range);
    put_host(cell, host);
    answered
}

fn request_range_header(request: &ICoreWebView2WebResourceRequest) -> Option<String> {
    // SAFETY: the STA thread owns the request.
    let headers = unsafe { request.Headers().ok()? };
    let mut value = PWSTR::null();
    // SAFETY: `value` is valid for the call; a missing header fails.
    unsafe { headers.GetHeader(&HSTRING::from("Range"), &mut value).ok()? };
    Some(pwstr_to_string(value))
}

fn drain_commands(cell: &SharedHost, queue: &Rc<RefCell<mpsc::Receiver<UiCommand>>>) {
    loop {
        let command = queue.borrow_mut().try_recv().ok();
        let Some(command) = command else { break };
        match command {
            UiCommand::Post { message } => {
                if let Some(mut host) = take_host(cell) {
                    host.post_or_queue(message);
                    put_host(cell, host);
                }
            }
            UiCommand::CapturePreview { reply } => capture_preview(cell, reply),
            UiCommand::Restart { reason, .. } => restart_controller(cell, &reason),
            UiCommand::Reload => {
                if let Some(host) = cell.borrow().as_ref() {
                    host.reload();
                }
            }
            UiCommand::Shutdown => {
                if let Some(host) = cell.borrow().as_ref() {
                    let mut media = host.services.media.lock().unwrap_or_else(|poison| poison.into_inner());
                    media.unbind_renderer(host.services.session);
                }
                windows_window::quit();
            }
            UiCommand::RemoteCreate { spec } => remote_create(cell, spec),
            UiCommand::RemoteViewport { surface_id, viewport } => remote_viewport(cell, &surface_id, viewport),
            UiCommand::RemoteVisible { surface_id, visible } => remote_visible(cell, &surface_id, visible),
            UiCommand::RemoteMuted { surface_id, muted } => remote_muted(cell, &surface_id, muted),
            UiCommand::RemoteReload { surface_id } => remote_reload(cell, &surface_id),
            UiCommand::RemoteDestroy { surface_id } => remote_destroy(cell, &surface_id),
            UiCommand::RemoteRecovered => remote_recovered(cell),
            UiCommand::RemoteClearData { reply } => remote_clear_data(cell, reply),
        }
    }
}

/// Renders one PNG frame into a bounded buffer. The completion runs on
/// this thread, so the reply sender moves into the callback.
fn capture_preview(cell: &SharedHost, reply: tokio::sync::oneshot::Sender<std::result::Result<Vec<u8>, String>>) {
    let webview = match cell.borrow().as_ref().and_then(|host| host.webview.clone()) {
        Some(webview) => webview,
        None => {
            let _ = reply.send(Err("the renderer is not running".to_string()));
            return;
        }
    };
    let (stream, data) = crate::streams::VecStream::new();
    // The completion owns one path to the reply, the call site the other;
    // exactly one answers.
    let reply = Arc::new(Mutex::new(Some(reply)));
    let reply_cell = Arc::clone(&reply);
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result: windows::core::Result<()>| {
        let outcome = match result {
            Ok(()) => {
                let bytes = data.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
                if bytes.is_empty() { Err("the capture came back empty".to_string()) } else { Ok(bytes) }
            }
            Err(error) => Err(format!("the capture failed: {error}")),
        };
        if let Some(reply) = reply_cell.lock().unwrap_or_else(|poison| poison.into_inner()).take() {
            let _ = reply.send(outcome);
        }
        Ok(())
    }));
    // SAFETY: the STA thread owns the webview; the stream and handler are
    // AddRef'd by the call and released on completion.
    if unsafe { webview.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler) }.is_err()
        && let Some(reply) = reply.lock().unwrap_or_else(|poison| poison.into_inner()).take()
    {
        let _ = reply.send(Err("the capture did not start".to_string()));
    }
}

/// Closes the controller and builds a fresh one. The old session's grants
/// stop resolving the moment the new session binds; the engine learns the
/// new session from the `Session` event. Remote views go with the
/// restart: the reloaded Runtime re-creates what it still shows.
fn restart_controller(cell: &SharedHost, reason: &str) {
    tracing::info!(component = "webview", event = "renderer_restart", reason);
    remote_reset_for_restart(cell);
    let Some(mut host) = take_host(cell) else { return };
    {
        let mut media = host.services.media.lock().unwrap_or_else(|poison| poison.into_inner());
        media.unbind_renderer(host.services.session);
    }
    if let Some(controller) = host.controller.take() {
        // SAFETY: the STA thread owns the controller.
        unsafe {
            let _ = controller.Close();
        }
    }
    host.webview = None;
    host.navigated = false;
    host.pending.clear();
    host.services.session = uuid::Uuid::new_v4();
    {
        let mut media = host.services.media.lock().unwrap_or_else(|poison| poison.into_inner());
        media.bind_renderer(RendererInstance { session: host.services.session });
    }
    emit(&host.events, UiEvent::Session { session: host.services.session });
    put_host(cell, host);
    create_controller(cell);
}

fn process_failed_kind(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> String {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "render-process-unresponsive",
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "frame-render-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "gpu-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED => "ppapi-plugin-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED => "ppapi-broker-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => "sandbox-helper-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "utility-process-exited",
        COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED => "unknown-process-exited",
        _ => return format!("unknown-process-{}", kind.0),
    }
    .to_string()
}

fn process_failed_reason(reason: COREWEBVIEW2_PROCESS_FAILED_REASON) -> String {
    match reason {
        COREWEBVIEW2_PROCESS_FAILED_REASON_CRASHED => "crashed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_LAUNCH_FAILED => "launch-failed",
        COREWEBVIEW2_PROCESS_FAILED_REASON_OUT_OF_MEMORY => "out-of-memory",
        COREWEBVIEW2_PROCESS_FAILED_REASON_PROFILE_DELETED => "profile-deleted",
        COREWEBVIEW2_PROCESS_FAILED_REASON_TERMINATED => "terminated",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNEXPECTED => "unexpected",
        COREWEBVIEW2_PROCESS_FAILED_REASON_UNRESPONSIVE => "unresponsive",
        _ => return format!("unknown-reason-{}", reason.0),
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// Remote web: host-layer child views in a separate WebView2 environment.
// ---------------------------------------------------------------------------
//
// The trusted Runtime renders into the main view; remote pages and YouTube
// players render into child windows above it, one WebView2 controller per
// surface. The remote environment never registers the `tilecast` or
// `tcmedia` schemes, so remote content cannot reach Runtime files or
// media grants; the trusted-Runtime origin checks would refuse it anyway.
//
// Every surface arrives validated (the presentation task owns the
// `SurfaceTracker`); this side owns the child windows, controllers, and
// profiles. Async completions re-check the surface map: a destroy that
// lands mid-flight wins, and orphaned controllers close immediately.

/// Emits one remote web event toward the Runtime's remote web port.
fn emit_remote(cell: &SharedHost, surface_id: Option<&str>, kind: &str, code: Option<&str>) {
    let event = crate::bridge::RemoteWebEvent {
        surface_id: surface_id.map(str::to_owned),
        kind: kind.to_owned(),
        code: code.map(str::to_owned),
    };
    if let Some(host) = cell.borrow().as_ref() {
        emit(&host.events, UiEvent::Remote { event });
    }
}

fn px(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// The remote user-data and wrapper directories. `None` while the host
/// is momentarily taken during a callback.
fn remote_dirs(cell: &SharedHost) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let root = cell.borrow().as_ref()?.services.user_data_dir.join(REMOTE_DATA_DIR);
    let wrappers = root.join(WRAPPER_DIR);
    Some((root, wrappers))
}

/// The profile for a validated surface: unique per-surface profiles
/// isolate `disabled` (InPrivate) and storage-less surfaces, so their
/// release clears touch only their own data; the rest share one profile
/// per policy.
fn remote_profile(spec: &crate::remote_web::SurfaceSpec, seq: u64) -> (String, bool) {
    match &spec.content {
        crate::remote_web::SurfaceContent::Page(page) => {
            if page.cookie_policy == crate::remote_web::CookiePolicy::Disabled {
                (format!("tc-rw-ephemeral-{seq}"), true)
            } else if !page.dom_storage_enabled {
                (format!("tc-rw-nodom-{seq}"), false)
            } else if page.cookie_policy == crate::remote_web::CookiePolicy::FirstParty {
                (PROFILE_FIRST_PARTY.to_string(), false)
            } else {
                (PROFILE_PERSISTENT.to_string(), false)
            }
        }
        crate::remote_web::SurfaceContent::YouTube(_) => (PROFILE_YOUTUBE.to_string(), false),
    }
}

/// A validated `#RRGGBB` color as an opaque WebView2 color. Black on
/// anything unexpected; the spec validator already refused those.
fn colorref(color: &str) -> COREWEBVIEW2_COLOR {
    let bytes = color.as_bytes();
    let hex = |index: usize| {
        u8::from_str_radix(std::str::from_utf8(&bytes[index..index + 2]).unwrap_or("00"), 16).unwrap_or(0)
    };
    if bytes.len() == 7 && bytes[0] == b'#' {
        COREWEBVIEW2_COLOR { A: 255, R: hex(1), G: hex(3), B: hex(5) }
    } else {
        COREWEBVIEW2_COLOR { A: 255, R: 0, G: 0, B: 0 }
    }
}

/// Remembers a navigated host for the `first_party` cookie strip.
/// Bounded and de-duplicated; overflow drops the oldest.
fn track_host(cell: &SharedHost, surface_id: &str, uri: &str) {
    let Some(host) = crate::remote_web::url_host(uri) else { return };
    let Some(mut taken) = take_host(cell) else { return };
    if let Some(surface) = taken.remote_views.get_mut(surface_id)
        && !surface.hosts.contains(&host)
    {
        if surface.hosts.len() >= MAX_TRACKED_HOSTS {
            surface.hosts.remove(0);
        }
        surface.hosts.push(host);
    }
    put_host(cell, taken);
}

/// Builds the remote environment after the main controller is wired. Its
/// readiness arrives as a host-wide `recovered` event; failure arrives as
/// `process-terminated` and only `RemoteRecovered` retries. Conformance
/// mode skips the remote environment entirely.
fn create_remote_environment(cell: &SharedHost) {
    let conformance = cell.borrow().as_ref().is_some_and(|host| host.services.conformance.is_some());
    if conformance {
        return;
    }
    let Some((root, wrappers)) = remote_dirs(cell) else { return };
    if std::fs::create_dir_all(&wrappers).is_err() {
        mark_remote_dead(cell);
        return;
    }
    sweep_remote_leftovers(&root, &wrappers);
    let options_impl = CoreWebView2EnvironmentOptions::default();
    // SAFETY: the STA thread owns this options object; it is configured
    // once, before the environment reads it. No custom schemes: remote
    // content must never resolve `tilecast:` or `tcmedia:` URIs.
    unsafe {
        options_impl.set_additional_browser_arguments(REMOTE_BROWSER_ARGS.to_string());
    }
    let options: ICoreWebView2EnvironmentOptions = options_impl.into();
    use std::os::windows::ffi::OsStrExt as _;
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let created_cell = Rc::clone(cell);
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, env: Option<ICoreWebView2Environment>| {
            match (result, env) {
                (Ok(()), Some(env)) => wire_remote_environment(&created_cell, env),
                _ => {
                    tracing::warn!(component = "webview", event = "remote_environment_failed");
                    mark_remote_dead(&created_cell);
                }
            }
            Ok(())
        },
    ));
    // SAFETY: the STA thread owns the options and handler (both AddRef'd
    // by the call); the loader copies the path before returning.
    let status =
        unsafe { CreateCoreWebView2EnvironmentWithOptions(BROWSER_FOLDER, PCWSTR(wide.as_ptr()), &options, &handler) };
    if status.is_err() {
        mark_remote_dead(cell);
    }
}

/// Deletes what a previous process left behind: stale wrapper files
/// (the directory holds nothing else) and unique-profile directories,
/// best effort. Shared profiles persist by policy.
fn sweep_remote_leftovers(root: &std::path::Path, wrappers: &std::path::Path) {
    if std::fs::remove_dir_all(wrappers).is_err() || std::fs::create_dir_all(wrappers).is_err() {
        tracing::warn!(component = "webview", event = "wrapper_sweep_failed");
    }
    let entries = std::fs::read_dir(root).into_iter().flatten().flatten();
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        if (name.starts_with("tc-rw-ephemeral-") || name.starts_with("tc-rw-nodom-"))
            && std::fs::remove_dir_all(entry.path()).is_err()
        {
            tracing::warn!(component = "webview", event = "profile_sweep_failed", profile = name.as_str());
        }
    }
}

/// The remote environment cannot serve. Drops every view, stops the
/// YouTube poll, and tells the Runtime its surfaces all failed.
fn mark_remote_dead(cell: &SharedHost) {
    if let Some(mut host) = take_host(cell) {
        host.remote_dead = true;
        host.remote_env = None;
        for (_, surface) in host.remote_views.drain() {
            if let Some(controller) = surface.controller {
                // SAFETY: the STA thread owns the controller.
                unsafe {
                    let _ = controller.Close();
                }
            }
            crate::win32::destroy_remote_child(surface.child);
        }
        if host.youtube_polling {
            crate::win32::stop_poll_timer(host.window.hwnd(), YOUTUBE_TIMER_ID);
            host.youtube_polling = false;
        }
        put_host(cell, host);
    }
    emit_remote(cell, None, "process-terminated", None);
}

/// Wires browser-process monitoring for a fresh remote environment and
/// announces it. The `org.tilecast.player` folder mapping happens per
/// YouTube view instead: pages never need it.
fn wire_remote_environment(cell: &SharedHost, env: ICoreWebView2Environment) {
    let exited_cell = Rc::clone(cell);
    let exited_handler = BrowserProcessExitedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2Environment>, _: Option<ICoreWebView2BrowserProcessExitedEventArgs>| {
            tracing::warn!(component = "webview", event = "remote_browser_exited");
            mark_remote_dead(&exited_cell);
            Ok(())
        },
    ));
    let mut token = 0i64;
    // SAFETY: the STA thread owns the environment and args.
    let monitored = env
        .cast::<ICoreWebView2Environment5>()
        .and_then(|env5| unsafe { env5.add_BrowserProcessExited(&exited_handler, &mut token) })
        .is_ok();
    if !monitored {
        tracing::warn!(component = "webview", event = "remote_monitoring_failed");
        mark_remote_dead(cell);
        return;
    }
    if let Some(mut host) = take_host(cell) {
        host._tokens.push(token);
        host.remote_env = Some(env);
        host.remote_dead = false;
        put_host(cell, host);
    }
    emit_remote(cell, None, "recovered", None);
}

/// Creates one remote surface's child window and controller. The spec is
/// already validated and tracked; failures here emit `failed` with a
/// host-side code (`unavailable`: the host could not provide the view).
fn remote_create(cell: &SharedHost, spec: crate::remote_web::SurfaceSpec) {
    let surface_id = spec.surface_id.clone();
    let env = match cell.borrow().as_ref().and_then(|host| host.remote_env.clone()) {
        Some(env) if !cell.borrow().as_ref().is_some_and(|host| host.remote_dead) => env,
        _ => {
            emit_remote(cell, Some(&surface_id), "failed", Some(crate::remote_web::UNAVAILABLE));
            return;
        }
    };
    if !crate::win32::register_remote_class() {
        emit_remote(cell, Some(&surface_id), "failed", Some(crate::remote_web::UNAVAILABLE));
        return;
    }
    let parent = match cell.borrow().as_ref() {
        Some(host) => host.window.hwnd(),
        None => {
            emit_remote(cell, Some(&surface_id), "failed", Some(crate::remote_web::UNAVAILABLE));
            return;
        }
    };
    let viewport = spec.viewport;
    let child = crate::win32::create_remote_child(
        parent,
        px(viewport.x),
        px(viewport.y),
        px(viewport.width),
        px(viewport.height),
        spec.visible,
    );
    let Some(child) = child else {
        emit_remote(cell, Some(&surface_id), "failed", Some(crate::remote_web::UNAVAILABLE));
        return;
    };
    let controller_options = (|| {
        // SAFETY: the STA thread owns the environment; the options object
        // is configured once, before the controller reads it.
        let env10 = env.cast::<ICoreWebView2Environment10>().ok()?;
        let options = unsafe { env10.CreateCoreWebView2ControllerOptions().ok()? };
        let (profile_name, in_private) = remote_profile(&spec, next_profile_seq(cell));
        unsafe {
            options.SetProfileName(&HSTRING::from(profile_name.as_str())).ok()?;
            options.SetIsInPrivateModeEnabled(in_private).ok()?;
        }
        Some((env10, options, profile_name))
    })();
    let Some((env10, options, profile_name)) = controller_options else {
        crate::win32::destroy_remote_child(child);
        emit_remote(cell, Some(&surface_id), "failed", Some(crate::remote_web::UNAVAILABLE));
        return;
    };
    if let Some(mut host) = take_host(cell) {
        host.remote_views.insert(
            surface_id.clone(),
            RemoteSurface {
                spec,
                child,
                controller: None,
                webview: None,
                profile_name,
                loaded: false,
                stream_ready: false,
                failed: false,
                youtube_ended: false,
                hosts: Vec::new(),
                _tokens: Vec::new(),
            },
        );
        put_host(cell, host);
    }
    let created_cell = Rc::clone(cell);
    let created_id = surface_id.clone();
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
        move |result: windows::core::Result<()>, controller: Option<ICoreWebView2Controller>| {
            match (result, controller) {
                (Ok(()), Some(controller)) => wire_remote_controller(&created_cell, &created_id, controller),
                _ => {
                    tracing::warn!(component = "webview", event = "remote_controller_failed");
                    drop_pending_surface(&created_cell, &created_id);
                    emit_remote(&created_cell, Some(&created_id), "failed", Some(crate::remote_web::UNAVAILABLE));
                }
            }
            Ok(())
        },
    ));
    // SAFETY: `child` is this thread's live child window; the handler is
    // AddRef'd by the call.
    if unsafe { env10.CreateCoreWebView2ControllerWithOptions(HWND(child), &options, &handler) }.is_err() {
        drop_pending_surface(cell, &surface_id);
        emit_remote(cell, Some(&surface_id), "failed", Some(crate::remote_web::UNAVAILABLE));
    }
}

/// Drops a surface still waiting for its controller: a destroy that
/// landed mid-flight, or a controller that never materialized.
fn drop_pending_surface(cell: &SharedHost, surface_id: &str) {
    let removed = match take_host(cell) {
        Some(mut host) => {
            let removed = host.remote_views.remove(surface_id);
            put_host(cell, host);
            removed
        }
        None => None,
    };
    if let Some(surface) = removed {
        if let Some(controller) = surface.controller {
            // SAFETY: the STA thread owns the controller.
            unsafe {
                let _ = controller.Close();
            }
        }
        crate::win32::destroy_remote_child(surface.child);
    }
}

fn next_profile_seq(cell: &SharedHost) -> u64 {
    match take_host(cell) {
        Some(mut host) => {
            host.remote_profile_seq += 1;
            let seq = host.remote_profile_seq;
            put_host(cell, host);
            seq
        }
        None => 0,
    }
}

/// Wires a fresh remote controller: lockdown settings, policy events,
/// and the first navigation. A destroy that landed mid-flight closes
/// the orphan; any wiring failure fails the surface instead of showing
/// a half-guarded view.
fn wire_remote_controller(cell: &SharedHost, surface_id: &str, controller: ICoreWebView2Controller) {
    let pending = match cell.borrow().as_ref().and_then(|host| host.remote_views.get(surface_id)) {
        Some(surface) if surface.controller.is_none() => surface.spec.clone(),
        Some(_) => {
            // SAFETY: the STA thread owns the orphan controller.
            unsafe {
                let _ = controller.Close();
            }
            return;
        }
        None => {
            // SAFETY: the STA thread owns the orphan controller.
            unsafe {
                let _ = controller.Close();
            }
            return;
        }
    };
    // SAFETY: for the rest of this function the STA thread owns the
    // controller, the webview, and every args object.
    let webview = match unsafe { controller.CoreWebView2() } {
        Ok(webview) => webview,
        Err(_) => {
            drop_pending_surface(cell, surface_id);
            emit_remote(cell, Some(surface_id), "failed", Some(crate::remote_web::UNAVAILABLE));
            return;
        }
    };
    if !lock_remote_view(surface_id, &controller, &webview, &pending) {
        drop_pending_surface(cell, surface_id);
        emit_remote(cell, Some(surface_id), "failed", Some("unsupported_content"));
        return;
    }
    if wire_remote_events(cell, surface_id, &webview, &pending).is_err() {
        drop_pending_surface(cell, surface_id);
        emit_remote(cell, Some(surface_id), "failed", Some(crate::remote_web::UNAVAILABLE));
        return;
    }
    if let Some(mut host) = take_host(cell) {
        if let Some(surface) = host.remote_views.get_mut(surface_id) {
            surface.controller = Some(controller);
            surface.webview = Some(webview.clone());
        }
        let youtube = matches!(pending.content, crate::remote_web::SurfaceContent::YouTube(_));
        if youtube && !host.youtube_polling {
            let interval = u32::try_from(crate::remote_web::YOUTUBE_POLL_INTERVAL.as_millis()).unwrap_or(500);
            host.youtube_polling = crate::win32::start_poll_timer(host.window.hwnd(), YOUTUBE_TIMER_ID, interval);
        }
        put_host(cell, host);
    }
    navigate_remote_surface(cell, surface_id, &webview, &pending);
}

/// Locks a remote view down: no dialogs, devtools, menus, host objects,
/// zoom control, autofill, or password capture; script and user agent
/// per spec; geometry, zoom, background, and mute per spec. Mute is
/// policy-critical: without it the surface must not exist.
fn lock_remote_view(
    surface_id: &str,
    controller: &ICoreWebView2Controller,
    webview: &ICoreWebView2,
    spec: &crate::remote_web::SurfaceSpec,
) -> bool {
    let (script, user_agent, zoom_percent, background) = match &spec.content {
        crate::remote_web::SurfaceContent::Page(page) => {
            (page.javascript_enabled, page.user_agent.as_str(), page.zoom_percent, page.background_color.as_str())
        }
        crate::remote_web::SurfaceContent::YouTube(_) => (true, "", 100, "#000000"),
    };
    // SAFETY: the STA thread owns the controller, webview, and settings.
    unsafe {
        let _ = controller.SetBounds(RECT {
            left: 0,
            top: 0,
            right: px(spec.viewport.width),
            bottom: px(spec.viewport.height),
        });
        let _ = controller.SetIsVisible(spec.visible);
        let zoom = f64::from(zoom_percent.clamp(25, 400)) / 100.0;
        let _ = controller.SetZoomFactor(zoom);
        if let Ok(controller2) = controller.cast::<ICoreWebView2Controller2>() {
            let _ = controller2.SetDefaultBackgroundColor(colorref(background));
        }
    }
    let settings = match unsafe { webview.Settings() } {
        Ok(settings) => settings,
        Err(_) => return false,
    };
    // SAFETY: the STA thread owns the settings.
    unsafe {
        let _ = settings.SetIsScriptEnabled(script);
        let _ = settings.SetAreDefaultScriptDialogsEnabled(false);
        let _ = settings.SetAreDevToolsEnabled(false);
        let _ = settings.SetAreDefaultContextMenusEnabled(false);
        let _ = settings.SetAreHostObjectsAllowed(false);
        let _ = settings.SetIsZoomControlEnabled(false);
    }
    if !user_agent.is_empty() {
        let named = settings
            .cast::<ICoreWebView2Settings2>()
            .and_then(|settings2| unsafe { settings2.SetUserAgent(&HSTRING::from(user_agent)) })
            .is_ok();
        if !named {
            return false;
        }
    }
    // Autofill is hardening, not policy: profile data is still released
    // per policy, so an old runtime only loses the hardening.
    if let Ok(profile) = webview.cast::<ICoreWebView2_13>().and_then(|view| unsafe { view.Profile() })
        && let Ok(profile6) = profile.cast::<ICoreWebView2Profile6>()
    {
        // SAFETY: the STA thread owns the profile.
        unsafe {
            let _ = profile6.SetIsGeneralAutofillEnabled(false);
            let _ = profile6.SetIsPasswordAutosaveEnabled(false);
        }
    }
    let muted = webview.cast::<ICoreWebView2_8>().and_then(|view8| unsafe { view8.SetIsMuted(spec.muted) }).is_ok();
    if !muted {
        tracing::warn!(component = "webview", event = "remote_mute_unavailable", surface = surface_id);
    }
    muted
}

/// Registers every policy event on a remote view. Any failure fails the
/// whole surface: a half-guarded view must never present content.
fn wire_remote_events(
    cell: &SharedHost,
    surface_id: &str,
    webview: &ICoreWebView2,
    spec: &crate::remote_web::SurfaceSpec,
) -> std::result::Result<(), ()> {
    let mut token = 0i64;
    // SAFETY: the STA thread owns the webview and every args object for
    // the rest of this function.
    let starting_cell = Rc::clone(cell);
    let starting_id = surface_id.to_owned();
    let starting_spec = spec.clone();
    let starting_handler = NavigationStartingEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2NavigationStartingEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            if unsafe { args.Uri(&mut uri) }.is_err() {
                return Ok(());
            }
            let uri = pwstr_to_string(uri);
            let allowed = match &starting_spec.content {
                crate::remote_web::SurfaceContent::Page(page) => {
                    crate::remote_web::main_frame_allowed(&uri, &page.url, &page.allowed_hosts)
                }
                crate::remote_web::SurfaceContent::YouTube(_) => {
                    uri == "about:blank" || uri == youtube_wrapper_url(&starting_id)
                }
            };
            if allowed {
                track_host(&starting_cell, &starting_id, &uri);
            } else {
                unsafe {
                    let _ = args.SetCancel(true);
                }
                tracing::warn!(
                    component = "webview",
                    event = "remote_navigation_blocked",
                    host = crate::remote_web::log_host(&uri).as_str(),
                );
                emit_remote(&starting_cell, Some(&starting_id), "navigation-blocked", None);
            }
            Ok(())
        },
    ));
    unsafe {
        webview.add_NavigationStarting(&starting_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    // The first content load makes the first frame available: the view
    // is the pixels (host-layer), so there is no separate stream gate.
    // YouTube surfaces wait for the player instead (the poll reports).
    let loading_cell = Rc::clone(cell);
    let loading_id = surface_id.to_owned();
    let loading_page = matches!(spec.content, crate::remote_web::SurfaceContent::Page(_));
    let loading_handler = ContentLoadingEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, _: Option<ICoreWebView2ContentLoadingEventArgs>| {
            if !loading_page {
                return Ok(());
            }
            let first = match take_host(&loading_cell) {
                Some(mut host) => {
                    let first = match host.remote_views.get_mut(&loading_id) {
                        Some(surface) if !surface.failed && !surface.stream_ready => {
                            surface.stream_ready = true;
                            true
                        }
                        _ => false,
                    };
                    put_host(&loading_cell, host);
                    first
                }
                None => false,
            };
            if first {
                emit_remote(&loading_cell, Some(&loading_id), "stream-ready", None);
            }
            Ok(())
        },
    ));
    unsafe {
        webview.add_ContentLoading(&loading_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    let completed_cell = Rc::clone(cell);
    let completed_id = surface_id.to_owned();
    let completed_spec = spec.clone();
    let completed_handler = NavigationCompletedEventHandler::create(Box::new(
        move |webview: Option<ICoreWebView2>, args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let mut succeeded = BOOL(0);
            if unsafe { args.IsSuccess(&mut succeeded) }.is_err() {
                return Ok(());
            }
            let mut error = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
            unsafe {
                let _ = args.WebErrorStatus(&mut error);
            }
            // Our own cancellations land here; the block was already
            // reported as `navigation-blocked`.
            if error == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                return Ok(());
            }
            let mut http_status = 0i32;
            if let Ok(args2) = args.cast::<ICoreWebView2NavigationCompletedEventArgs2>() {
                unsafe {
                    let _ = args2.HttpStatusCode(&mut http_status);
                }
            }
            if !succeeded.as_bool() || http_status >= 400 {
                let failed = match take_host(&completed_cell) {
                    Some(mut host) => {
                        let failed = match host.remote_views.get_mut(&completed_id) {
                            Some(surface) if !surface.failed => {
                                surface.failed = true;
                                true
                            }
                            _ => false,
                        };
                        put_host(&completed_cell, host);
                        failed
                    }
                    None => false,
                };
                if failed {
                    emit_remote(
                        &completed_cell,
                        Some(&completed_id),
                        "failed",
                        Some(load_failure_code(error, http_status)),
                    );
                }
                return Ok(());
            }
            let live = match take_host(&completed_cell) {
                Some(mut host) => {
                    let live = match host.remote_views.get_mut(&completed_id) {
                        Some(surface) if !surface.failed && !surface.loaded => {
                            // Pages finish here; the YouTube poll owns the
                            // player's `loaded` (the wrapper is not the video).
                            if matches!(completed_spec.content, crate::remote_web::SurfaceContent::Page(_)) {
                                surface.loaded = true;
                            }
                            true
                        }
                        _ => false,
                    };
                    put_host(&completed_cell, host);
                    live
                }
                None => false,
            };
            if !live {
                return Ok(());
            }
            match &completed_spec.content {
                crate::remote_web::SurfaceContent::Page(page) => {
                    if page.javascript_enabled
                        && (page.scroll_x != 0 || page.scroll_y != 0)
                        && let Some(view) = webview
                    {
                        run_script_ignored(&view, &format!("window.scrollTo({},{})", page.scroll_x, page.scroll_y));
                    }
                    emit_remote(&completed_cell, Some(&completed_id), "loaded", None);
                }
                crate::remote_web::SurfaceContent::YouTube(_) => {
                    // The wrapper starts paused; visibility decides play.
                    if let Some(view) = webview {
                        let visible = completed_cell
                            .borrow()
                            .as_ref()
                            .and_then(|host| host.remote_views.get(&completed_id))
                            .is_some_and(|surface| surface.spec.visible);
                        run_script_ignored(&view, if visible { YOUTUBE_PLAY_SCRIPT } else { YOUTUBE_PAUSE_SCRIPT });
                    }
                }
            }
            Ok(())
        },
    ));
    unsafe {
        webview.add_NavigationCompleted(&completed_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    // A signage player grants no permissions, downloads nothing,
    // authenticates nowhere, shows no menus, and opens no popups.
    let permission_handler = PermissionRequestedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2PermissionRequestedEventArgs>| {
            if let Some(args) = args {
                unsafe {
                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                }
            }
            Ok(())
        },
    ));
    unsafe {
        webview.add_PermissionRequested(&permission_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    let download_handler = DownloadStartingEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2DownloadStartingEventArgs>| {
            if let Some(args) = args {
                unsafe {
                    let _ = args.SetCancel(true);
                    let _ = args.SetHandled(true);
                }
            }
            Ok(())
        },
    ));
    let download_webview = webview.cast::<ICoreWebView2_4>().map_err(|_| ())?;
    unsafe {
        download_webview.add_DownloadStarting(&download_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    let popup_handler = NewWindowRequestedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2NewWindowRequestedEventArgs>| {
            if let Some(args) = args {
                unsafe {
                    let _ = args.SetHandled(true);
                }
            }
            Ok(())
        },
    ));
    unsafe {
        webview.add_NewWindowRequested(&popup_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    let auth_handler = BasicAuthenticationRequestedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2BasicAuthenticationRequestedEventArgs>| {
            // Website credentials are out of scope: no prompt, no retry.
            if let Some(args) = args {
                unsafe {
                    let _ = args.SetCancel(true);
                }
            }
            Ok(())
        },
    ));
    let auth_webview = webview.cast::<ICoreWebView2_10>().map_err(|_| ())?;
    unsafe {
        auth_webview.add_BasicAuthenticationRequested(&auth_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    let cert_handler = ClientCertificateRequestedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2ClientCertificateRequestedEventArgs>| {
            if let Some(args) = args {
                unsafe {
                    let _ = args.SetCancel(true);
                    let _ = args.SetHandled(true);
                }
            }
            Ok(())
        },
    ));
    let cert_webview = webview.cast::<ICoreWebView2_5>().map_err(|_| ())?;
    unsafe {
        cert_webview.add_ClientCertificateRequested(&cert_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    let menu_handler = ContextMenuRequestedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2ContextMenuRequestedEventArgs>| {
            if let Some(args) = args {
                unsafe {
                    let _ = args.SetHandled(true);
                }
            }
            Ok(())
        },
    ));
    let menu_webview = webview.cast::<ICoreWebView2_11>().map_err(|_| ())?;
    unsafe {
        menu_webview.add_ContextMenuRequested(&menu_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    // File pickers have no WebView2 event: a remote page's file input
    // would open the system dialog with no host veto. Remote pages are
    // signage content, not forms; pages that need uploads are out of
    // scope, and this gap is documented, not claimed away.
    let failed_cell = Rc::clone(cell);
    let failed_handler = ProcessFailedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, _: Option<ICoreWebView2ProcessFailedEventArgs>| {
            tracing::warn!(component = "webview", event = "remote_process_failed");
            remote_process_failed(&failed_cell);
            Ok(())
        },
    ));
    unsafe {
        webview.add_ProcessFailed(&failed_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);

    let frame_cell = Rc::clone(cell);
    let frame_id = surface_id.to_owned();
    let frame_youtube = matches!(spec.content, crate::remote_web::SurfaceContent::YouTube(_));
    let frame_handler = FrameCreatedEventHandler::create(Box::new(
        move |_: Option<ICoreWebView2>, args: Option<ICoreWebView2FrameCreatedEventArgs>| {
            let Some(args) = args else { return Ok(()) };
            let Ok(frame) = (unsafe { args.Frame() }) else { return Ok(()) };
            let Ok(frame2) = frame.cast::<ICoreWebView2Frame2>() else {
                // Unguardable subframes must not show: fail the surface.
                tracing::warn!(component = "webview", event = "remote_frame_guard_missing");
                emit_remote(&frame_cell, Some(&frame_id), "failed", Some("unsupported_content"));
                remote_destroy(&frame_cell, &frame_id);
                return Ok(());
            };
            let nav_cell = Rc::clone(&frame_cell);
            let nav_id = frame_id.clone();
            let nav_handler = FrameNavigationStartingEventHandler::create(Box::new(
                move |_: Option<ICoreWebView2Frame>, args: Option<ICoreWebView2NavigationStartingEventArgs>| {
                    let Some(args) = args else { return Ok(()) };
                    let mut uri = PWSTR::null();
                    if unsafe { args.Uri(&mut uri) }.is_err() {
                        return Ok(());
                    }
                    let uri = pwstr_to_string(uri);
                    let allowed = if frame_youtube {
                        crate::remote_web::youtube_subframe_allowed(&uri)
                    } else {
                        crate::remote_web::any_frame_allowed(&uri)
                    };
                    if allowed {
                        track_host(&nav_cell, &nav_id, &uri);
                    } else {
                        unsafe {
                            let _ = args.SetCancel(true);
                        }
                        tracing::warn!(
                            component = "webview",
                            event = "remote_subframe_blocked",
                            host = crate::remote_web::log_host(&uri).as_str(),
                        );
                    }
                    Ok(())
                },
            ));
            // SAFETY: the STA thread owns the frame and args.
            let mut frame_token = 0i64;
            if unsafe { frame2.add_NavigationStarting(&nav_handler, &mut frame_token) }.is_err() {
                emit_remote(&frame_cell, Some(&frame_id), "failed", Some("unsupported_content"));
                remote_destroy(&frame_cell, &frame_id);
            }
            Ok(())
        },
    ));
    let frame_webview = webview.cast::<ICoreWebView2_4>().map_err(|_| ())?;
    unsafe {
        frame_webview.add_FrameCreated(&frame_handler, &mut token).map_err(|_| ())?;
    }
    stash_remote_token(cell, surface_id, token);
    Ok(())
}

fn stash_remote_token(cell: &SharedHost, surface_id: &str, token: i64) {
    if let Some(mut host) = take_host(cell) {
        if let Some(surface) = host.remote_views.get_mut(surface_id) {
            surface._tokens.push(token);
        }
        put_host(cell, host);
    }
}

/// Maps a navigation failure to the stable failure vocabulary. HTTP
/// statuses win over engine codes: a served error page is an HTTP error
/// even when the engine also reports one.
fn load_failure_code(error: COREWEBVIEW2_WEB_ERROR_STATUS, http_status: i32) -> &'static str {
    if http_status >= 400 {
        return "http_error";
    }
    match error {
        COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID
        | COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED
        | COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS => "tls_failure",
        COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "offline",
        COREWEBVIEW2_WEB_ERROR_STATUS_ERROR_HTTP_INVALID_SERVER_RESPONSE => "http_error",
        _ => "load_failed",
    }
}

/// Runs a script whose result does not matter (scroll, play, pause).
/// Failures log; the surface keeps serving.
fn run_script_ignored(webview: &ICoreWebView2, script: &str) {
    let handler =
        ExecuteScriptCompletedHandler::create(Box::new(move |_: windows::core::Result<()>, _: String| Ok(())));
    // SAFETY: the STA thread owns the webview; the handler is AddRef'd
    // by the call.
    if unsafe { webview.ExecuteScript(&HSTRING::from(script), &handler) }.is_err() {
        tracing::warn!(component = "webview", event = "remote_script_failed");
    }
}

const YOUTUBE_PLAY_SCRIPT: &str = "document.documentElement.setAttribute('data-tc-command','play')";
const YOUTUBE_PAUSE_SCRIPT: &str = "document.documentElement.setAttribute('data-tc-command','pause')";
const YOUTUBE_POLL_SCRIPT: &str = "document.documentElement.getAttribute('data-tc-state')||'loading'";

/// The wrapper URL of a YouTube surface, under the mapped Tilecast host.
fn youtube_wrapper_url(surface_id: &str) -> String {
    format!("https://org.tilecast.player/{surface_id}.html")
}

/// Starts the first navigation: the page URL, or the Tilecast-owned
/// wrapper for YouTube (written to the mapped folder first, so the
/// document has the real origin the iframe API requires).
fn navigate_remote_surface(
    cell: &SharedHost,
    surface_id: &str,
    webview: &ICoreWebView2,
    spec: &crate::remote_web::SurfaceSpec,
) {
    // SAFETY: the STA thread owns the webview for this function.
    match &spec.content {
        crate::remote_web::SurfaceContent::Page(page) => {
            if unsafe { webview.Navigate(&HSTRING::from(page.url.as_str())) }.is_err() {
                fail_surface_now(cell, surface_id, "load_failed");
            }
        }
        crate::remote_web::SurfaceContent::YouTube(content) => {
            let written = remote_dirs(cell)
                .and_then(|(_, wrappers)| {
                    let html = crate::remote_web::youtube_wrapper(surface_id, content)?;
                    std::fs::write(wrappers.join(format!("{surface_id}.html")), html).ok()
                })
                .is_some();
            if !written {
                fail_surface_now(cell, surface_id, "unsupported_content");
                return;
            }
            let mapped = remote_dirs(cell)
                .and_then(|(_, wrappers)| {
                    let folder = HSTRING::from(wrappers.to_string_lossy().as_ref());
                    let view3 = webview.cast::<ICoreWebView2_3>().ok()?;
                    // SAFETY: the STA thread owns the webview; the loader
                    // copies the folder path before returning.
                    unsafe {
                        view3
                            .SetVirtualHostNameToFolderMapping(
                                &HSTRING::from("org.tilecast.player"),
                                &folder,
                                COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY,
                            )
                            .ok()
                    }
                })
                .is_some();
            if !mapped {
                fail_surface_now(cell, surface_id, "unsupported_content");
                return;
            }
            if unsafe { webview.Navigate(&HSTRING::from(youtube_wrapper_url(surface_id).as_str())) }.is_err() {
                fail_surface_now(cell, surface_id, "load_failed");
            }
        }
    }
}

/// Fails a surface whose wiring completed but whose navigation cannot
/// start: marks, emits, and releases the view.
fn fail_surface_now(cell: &SharedHost, surface_id: &str, code: &str) {
    if let Some(mut host) = take_host(cell) {
        if let Some(surface) = host.remote_views.get_mut(surface_id) {
            surface.failed = true;
        }
        put_host(cell, host);
    }
    emit_remote(cell, Some(surface_id), "failed", Some(code));
    remote_destroy(cell, surface_id);
}

/// Moves a remote view. Unknown surfaces are already gone; a view still
/// waiting for its controller keeps the new viewport as its mirror.
fn remote_viewport(cell: &SharedHost, surface_id: &str, viewport: crate::remote_web::ViewportPx) {
    let Some(mut host) = take_host(cell) else { return };
    let Some(surface) = host.remote_views.get_mut(surface_id) else {
        put_host(cell, host);
        return;
    };
    surface.spec.viewport = viewport;
    crate::win32::move_remote_child(
        surface.child,
        px(viewport.x),
        px(viewport.y),
        px(viewport.width),
        px(viewport.height),
    );
    if let Some(controller) = surface.controller.as_ref() {
        let bounds = RECT { left: 0, top: 0, right: px(viewport.width), bottom: px(viewport.height) };
        // SAFETY: the STA thread owns the controller.
        unsafe {
            let _ = controller.SetBounds(bounds);
        }
    }
    put_host(cell, host);
}

/// Shows or hides a remote view. Hiding a YouTube view pauses its
/// player; showing resumes it.
fn remote_visible(cell: &SharedHost, surface_id: &str, visible: bool) {
    let surface = match take_host(cell) {
        Some(mut host) => {
            let found = host.remote_views.get_mut(surface_id).map(|surface| {
                surface.spec.visible = visible;
                crate::win32::show_remote_child(surface.child, visible);
                if let Some(controller) = surface.controller.as_ref() {
                    // SAFETY: the STA thread owns the controller.
                    unsafe {
                        let _ = controller.SetIsVisible(visible);
                    }
                }
                (surface.webview.clone(), surface.spec.content.clone())
            });
            put_host(cell, host);
            found
        }
        None => None,
    };
    if let Some((Some(webview), crate::remote_web::SurfaceContent::YouTube(_))) = surface {
        run_script_ignored(&webview, if visible { YOUTUBE_PLAY_SCRIPT } else { YOUTUBE_PAUSE_SCRIPT });
    }
}

/// Mutes or unmutes a remote view at the engine level: every audio
/// source in the view, not just the main media element.
fn remote_muted(cell: &SharedHost, surface_id: &str, muted: bool) {
    let webview = match cell.borrow().as_ref().and_then(|host| host.remote_views.get(surface_id)) {
        Some(surface) => surface.webview.clone(),
        None => return,
    };
    if let Some(mut host) = take_host(cell) {
        if let Some(surface) = host.remote_views.get_mut(surface_id) {
            surface.spec.muted = muted;
        }
        put_host(cell, host);
    }
    if let Some(webview) = webview {
        // SAFETY: the STA thread owns the webview.
        if webview.cast::<ICoreWebView2_8>().and_then(|view8| unsafe { view8.SetIsMuted(muted) }).is_err() {
            tracing::warn!(component = "webview", event = "remote_mute_failed", surface = surface_id);
        }
    }
}

/// Reloads a remote view for a new load attempt: the load flags reset
/// so the next completion reports like the first one.
fn remote_reload(cell: &SharedHost, surface_id: &str) {
    let webview = match take_host(cell) {
        Some(mut host) => {
            let webview = host.remote_views.get_mut(surface_id).map(|surface| {
                surface.loaded = false;
                surface.stream_ready = false;
                surface.failed = false;
                surface.youtube_ended = false;
                surface.webview.clone()
            });
            put_host(cell, host);
            webview
        }
        None => None,
    };
    if let Some(Some(webview)) = webview {
        // SAFETY: the STA thread owns the webview.
        unsafe {
            let _ = webview.Reload();
        }
    }
}

/// The cookie hosts a `first_party` surface keeps: its allowlist.
fn first_party_keep_hosts(surface: &RemoteSurface) -> Vec<String> {
    match &surface.spec.content {
        crate::remote_web::SurfaceContent::Page(page) if surface.profile_name == PROFILE_FIRST_PARTY => {
            page.allowed_hosts.clone()
        }
        _ => Vec::new(),
    }
}

/// Destroys a remote view and releases its data per policy: unique
/// profiles clear wholesale, `first_party` strips non-allowlist cookies,
/// shared persistent profiles keep the engine's normal rules.
fn remote_destroy(cell: &SharedHost, surface_id: &str) {
    let (removed, keep_hosts) = match take_host(cell) {
        Some(mut host) => {
            let removed = host.remote_views.remove(surface_id);
            if !host.remote_views.values().any(|surface| {
                surface.webview.is_some()
                    && matches!(surface.spec.content, crate::remote_web::SurfaceContent::YouTube(_))
            }) && host.youtube_polling
            {
                crate::win32::stop_poll_timer(host.window.hwnd(), YOUTUBE_TIMER_ID);
                host.youtube_polling = false;
            }
            // The first-party profile is shared: the strip keeps the hosts
            // of every surface still open on it, not only this surface's.
            let mut keep_hosts: Vec<String> = host.remote_views.values().flat_map(first_party_keep_hosts).collect();
            if let Some(surface) = &removed {
                keep_hosts.extend(first_party_keep_hosts(surface));
            }
            put_host(cell, host);
            (removed, keep_hosts)
        }
        None => (None, Vec::new()),
    };
    let Some(surface) = removed else { return };
    release_remote_surface(cell, surface_id, surface, keep_hosts);
}

/// Closes a removed surface's view and releases its browsing data. Shared
/// by a normal destroy and by the renderer-failure path, so no way of
/// ending a surface leaves its data behind.
fn release_remote_surface(cell: &SharedHost, surface_id: &str, surface: RemoteSurface, keep_hosts: Vec<String>) {
    if matches!(surface.spec.content, crate::remote_web::SurfaceContent::YouTube(_))
        && let Some((_, wrappers)) = remote_dirs(cell)
    {
        let _ = std::fs::remove_file(wrappers.join(format!("{surface_id}.html")));
    }
    let unique =
        surface.profile_name.starts_with("tc-rw-ephemeral-") || surface.profile_name.starts_with("tc-rw-nodom-");
    let first_party = surface.profile_name == PROFILE_FIRST_PARTY;
    // The profile and cookie manager come from the webview before its
    // controller closes; both stay usable after (profile-scoped).
    let webview = surface.webview;
    let child = surface.child;
    if let Some(controller) = surface.controller {
        // SAFETY: the STA thread owns the controller.
        unsafe {
            let _ = controller.Close();
        }
    }
    let Some(view) = webview else {
        crate::win32::destroy_remote_child(child);
        return;
    };
    if unique {
        clear_profile_then(&view, COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE, move |_| {
            crate::win32::destroy_remote_child(child);
        });
        return;
    }
    if first_party {
        strip_surface_cookies(&view, keep_hosts, surface.hosts, move || {
            crate::win32::destroy_remote_child(child);
        });
        return;
    }
    crate::win32::destroy_remote_child(child);
}

/// Clears one profile's browsing data, then runs `done` on this thread.
/// Failures still run `done`: the view is already closed.
fn clear_profile_then(
    done_view: &ICoreWebView2,
    kinds: COREWEBVIEW2_BROWSING_DATA_KINDS,
    done: impl FnOnce(bool) + 'static,
) {
    let profile = done_view
        .cast::<ICoreWebView2_13>()
        .and_then(|view| unsafe { view.Profile() })
        .and_then(|profile| profile.cast::<ICoreWebView2Profile2>());
    let Ok(profile) = profile else {
        tracing::warn!(component = "webview", event = "remote_profile_missing");
        done(false);
        return;
    };
    // The completion owns one path to `done`, the call site the other;
    // exactly one answers.
    let done = Rc::new(RefCell::new(Some(done)));
    let done_cell = Rc::clone(&done);
    let handler = ClearBrowsingDataCompletedHandler::create(Box::new(move |result: windows::core::Result<()>| {
        if let Some(done) = done_cell.borrow_mut().take() {
            done(result.is_ok());
        }
        Ok(())
    }));
    // SAFETY: the STA thread owns the profile; the handler is AddRef'd
    // by the call.
    if unsafe { profile.ClearBrowsingData(kinds, &handler) }.is_err()
        && let Some(done) = done.borrow_mut().take()
    {
        done(false);
    }
}

/// Deletes every cookie of the `first_party` profile that does not belong
/// to `keep_hosts`. Cookies are enumerated profile-wide, because a
/// third-party subresource can set one without any frame navigating to its
/// host. The navigated hosts are only the fallback when the profile-wide
/// query is unavailable. Then runs `done`: the view is already closed
/// either way.
fn strip_surface_cookies(
    view: &ICoreWebView2,
    keep_hosts: Vec<String>,
    hosts: Vec<String>,
    done: impl FnOnce() + 'static,
) {
    struct Strip {
        manager: ICoreWebView2CookieManager,
        keep_hosts: Vec<String>,
        /// Queries still to run: `None` is the whole profile, `Some` one
        /// host. A successful whole-profile query makes the rest moot.
        queries: VecDeque<Option<String>>,
        done: Option<Box<dyn FnOnce()>>,
    }
    fn strip_next(strip: Rc<RefCell<Strip>>) {
        let next = strip.borrow_mut().queries.pop_front();
        let Some(query) = next else {
            if let Some(done) = strip.borrow_mut().done.take() {
                done();
            }
            return;
        };
        let manager = strip.borrow().manager.clone();
        let for_call = manager.clone();
        let again = Rc::clone(&strip);
        let whole_profile = query.is_none();
        let handler = GetCookiesCompletedHandler::create(Box::new(
            move |result: windows::core::Result<()>, list: Option<ICoreWebView2CookieList>| {
                // SAFETY: the STA thread owns the manager, list, and
                // cookies for this completion.
                if let (Ok(()), Some(list)) = (result, list) {
                    if whole_profile {
                        again.borrow_mut().queries.clear();
                    }
                    let mut count = 0u32;
                    if unsafe { list.Count(&mut count) }.is_ok() {
                        for index in 0..count {
                            let Ok(cookie) = (unsafe { list.GetValueAtIndex(index) }) else { continue };
                            let mut domain = PWSTR::null();
                            if unsafe { cookie.Domain(&mut domain) }.is_err() {
                                continue;
                            }
                            let keep_hosts = again.borrow().keep_hosts.clone();
                            if !crate::remote_web::cookie_belongs_to_hosts(&pwstr_to_string(domain), &keep_hosts) {
                                unsafe {
                                    let _ = manager.DeleteCookie(&cookie);
                                }
                            }
                        }
                    }
                }
                strip_next(again);
                Ok(())
            },
        ));
        // An empty URI asks for every cookie of the profile.
        let uri = match &query {
            Some(host) => HSTRING::from(format!("https://{host}")),
            None => HSTRING::new(),
        };
        // SAFETY: the STA thread owns the manager; the handler is
        // AddRef'd by the call.
        if unsafe { for_call.GetCookies(&uri, &handler) }.is_err() {
            strip_next(strip);
        }
    }
    // SAFETY: the STA thread owns the webview.
    let manager = view.cast::<ICoreWebView2_2>().and_then(|view2| unsafe { view2.CookieManager() });
    let Ok(manager) = manager else {
        tracing::warn!(component = "webview", event = "remote_cookie_manager_missing");
        done();
        return;
    };
    let queries = std::iter::once(None).chain(hosts.into_iter().map(Some)).collect();
    strip_next(Rc::new(RefCell::new(Strip { manager, keep_hosts, queries, done: Some(Box::new(done)) })));
}

/// The Runtime proved content after the remote process ended: rebuild
/// the environment when it is gone, otherwise just announce service.
/// Never runs in conformance mode (no remote environment there).
fn remote_recovered(cell: &SharedHost) {
    let conformance = cell.borrow().as_ref().is_some_and(|host| host.services.conformance.is_some());
    if conformance {
        return;
    }
    let alive = cell.borrow().as_ref().is_some_and(|host| host.remote_env.is_some() && !host.remote_dead);
    if alive {
        emit_remote(cell, None, "recovered", None);
    } else {
        create_remote_environment(cell);
    }
}

/// Clears remote browsing data across every remote profile: live ones
/// through their views, idle shared ones through transient controllers
/// on the hidden janitor child. Answers whether everything cleared.
fn remote_clear_data(cell: &SharedHost, reply: Option<tokio::sync::oneshot::Sender<bool>>) {
    struct Clear {
        pending: usize,
        uncovered: VecDeque<String>,
        reply: Option<tokio::sync::oneshot::Sender<bool>>,
        ok: bool,
    }
    fn answer(clear: Rc<RefCell<Clear>>) {
        if let Some(reply) = clear.borrow_mut().reply.take() {
            let ok = clear.borrow().ok;
            let _ = reply.send(ok);
        }
    }
    fn clear_next_uncovered(cell: SharedHost, clear: Rc<RefCell<Clear>>) {
        let next = clear.borrow_mut().uncovered.pop_front();
        let Some(profile_name) = next else {
            answer(clear);
            return;
        };
        let env = cell.borrow().as_ref().and_then(|host| host.remote_env.clone());
        let janitor = cell.borrow().as_ref().and_then(|host| host.janitor);
        let (Some(env), Some(janitor)) = (env, janitor) else {
            clear.borrow_mut().ok = false;
            clear_next_uncovered(cell, clear);
            return;
        };
        // SAFETY: the STA thread owns the environment; the options
        // object is configured once, before the controller reads it.
        let made = env
            .cast::<ICoreWebView2Environment10>()
            .ok()
            .and_then(|env10| unsafe { env10.CreateCoreWebView2ControllerOptions().ok() })
            .and_then(|options| {
                unsafe {
                    options.SetProfileName(&HSTRING::from(profile_name.as_str())).ok()?;
                    options.SetIsInPrivateModeEnabled(false).ok()?;
                }
                let cell2 = cell.clone();
                let clear2 = Rc::clone(&clear);
                let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
                    move |result: windows::core::Result<()>, controller: Option<ICoreWebView2Controller>| {
                        match (result, controller) {
                            (Ok(()), Some(controller)) => {
                                // SAFETY: the STA thread owns the controller,
                                // view, and profile.
                                let closer = controller.clone();
                                let cleared = unsafe { controller.CoreWebView2() }
                                    .ok()
                                    .and_then(|view| {
                                        let profile = view
                                            .cast::<ICoreWebView2_13>()
                                            .ok()
                                            .and_then(|view13| unsafe { view13.Profile() }.ok())
                                            .and_then(|profile| profile.cast::<ICoreWebView2Profile2>().ok())?;
                                        let clear3 = Rc::clone(&clear2);
                                        let cell3 = cell2.clone();
                                        let done = ClearBrowsingDataCompletedHandler::create(Box::new(
                                            move |result: windows::core::Result<()>| {
                                                if result.is_err() {
                                                    clear3.borrow_mut().ok = false;
                                                }
                                                // SAFETY: the STA thread owns the controller.
                                                unsafe {
                                                    let _ = closer.Close();
                                                }
                                                clear_next_uncovered(cell3, clear3);
                                                Ok(())
                                            },
                                        ));
                                        // SAFETY: the STA thread owns the profile; the
                                        // handler is AddRef'd by the call.
                                        Some(
                                            unsafe {
                                                profile.ClearBrowsingData(
                                                    COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE,
                                                    &done,
                                                )
                                            }
                                            .is_ok(),
                                        )
                                    })
                                    .unwrap_or(false);
                                if !cleared {
                                    clear2.borrow_mut().ok = false;
                                    // SAFETY: the STA thread owns the controller.
                                    unsafe {
                                        let _ = controller.Close();
                                    }
                                    clear_next_uncovered(cell2, clear2);
                                }
                            }
                            _ => {
                                clear2.borrow_mut().ok = false;
                                clear_next_uncovered(cell2, clear2);
                            }
                        }
                        Ok(())
                    },
                ));
                // SAFETY: `janitor` is this thread's live hidden child;
                // the handler is AddRef'd by the call.
                unsafe {
                    env.cast::<ICoreWebView2Environment10>().ok().and_then(|env10| {
                        env10.CreateCoreWebView2ControllerWithOptions(HWND(janitor), &options, &handler).ok()
                    })
                }
            });
        if made.is_none() {
            clear.borrow_mut().ok = false;
            clear_next_uncovered(cell, clear);
        }
    }

    let alive = cell.borrow().as_ref().is_some_and(|host| host.remote_env.is_some() && !host.remote_dead);
    if !alive {
        if let Some(reply) = reply {
            let _ = reply.send(false);
        }
        return;
    }
    // Live profiles clear through their views; idle shared profiles
    // (whose disk data outlives their views by policy) clear through
    // transient controllers below.
    let mut live: Vec<(String, ICoreWebView2)> = Vec::new();
    if let Some(host) = cell.borrow().as_ref() {
        for surface in host.remote_views.values() {
            if let Some(view) = surface.webview.clone()
                && !live.iter().any(|(name, _)| *name == surface.profile_name)
            {
                live.push((surface.profile_name.clone(), view));
            }
        }
    }
    let mut uncovered: VecDeque<String> =
        [PROFILE_FIRST_PARTY, PROFILE_PERSISTENT, PROFILE_YOUTUBE].into_iter().map(str::to_owned).collect();
    uncovered.retain(|name| !live.iter().any(|(live_name, _)| live_name == name));
    // The janitor child exists only while a clear needs it.
    if !uncovered.is_empty() {
        let parent = cell.borrow().as_ref().map(|host| host.window.hwnd());
        if let Some(mut host) = take_host(cell) {
            if host.janitor.is_none() {
                host.janitor = parent.and_then(|parent| crate::win32::create_remote_child(parent, 0, 0, 1, 1, false));
            }
            if host.janitor.is_none() {
                uncovered.clear();
            }
            put_host(cell, host);
        }
        if uncovered.is_empty() {
            // The transient path is unavailable; live profiles still
            // clear, but the answer stays honest.
            if live.is_empty() {
                if let Some(reply) = reply {
                    let _ = reply.send(false);
                }
                return;
            }
        }
    }
    let clear = Rc::new(RefCell::new(Clear { pending: live.len(), uncovered, reply, ok: true }));
    if live.is_empty() {
        let cell_owned: SharedHost = Rc::clone(cell);
        clear_next_uncovered(cell_owned, Rc::clone(&clear));
        return;
    }
    for (_, view) in live {
        let clear2 = Rc::clone(&clear);
        let cell2: SharedHost = Rc::clone(cell);
        clear_profile_then(&view, COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE, move |cleared| {
            if !cleared {
                clear2.borrow_mut().ok = false;
            }
            let done = {
                let mut guard = clear2.borrow_mut();
                guard.pending = guard.pending.saturating_sub(1);
                guard.pending == 0
            };
            if done {
                clear_next_uncovered(cell2, clear2);
            }
        });
    }
}

/// A remote renderer process ended: every live surface failed with it.
/// The views close (their controllers are dead); the environment stays
/// for the re-creates the Runtime sends after recovery.
fn remote_process_failed(cell: &SharedHost) {
    let mut released: Vec<(String, RemoteSurface)> = Vec::new();
    if let Some(mut host) = take_host(cell) {
        released.extend(host.remote_views.drain());
        if host.youtube_polling {
            crate::win32::stop_poll_timer(host.window.hwnd(), YOUTUBE_TIMER_ID);
            host.youtube_polling = false;
        }
        put_host(cell, host);
    }
    // Every drained surface goes through the normal release, so unique
    // profiles clear and the first-party profile is stripped. The recovery
    // keeps this environment and does not run the startup sweep.
    let keep_hosts: Vec<String> = released.iter().flat_map(|(_, surface)| first_party_keep_hosts(surface)).collect();
    for (surface_id, surface) in released {
        release_remote_surface(cell, &surface_id, surface, keep_hosts.clone());
    }
    emit_remote(cell, None, "process-terminated", None);
}

/// The main controller restarts: remote views go with it, and their
/// profiles clear wholesale (a restart takes the remote layers; the
/// reloaded Runtime re-creates what it still shows).
fn remote_reset_for_restart(cell: &SharedHost) {
    let profiles: Vec<ICoreWebView2> = match take_host(cell) {
        Some(mut host) => {
            let profiles: Vec<ICoreWebView2> =
                host.remote_views.values().filter_map(|surface| surface.webview.clone()).collect();
            for (_, surface) in host.remote_views.drain() {
                if let Some(controller) = surface.controller {
                    // SAFETY: the STA thread owns the controller.
                    unsafe {
                        let _ = controller.Close();
                    }
                }
                crate::win32::destroy_remote_child(surface.child);
            }
            if host.youtube_polling {
                crate::win32::stop_poll_timer(host.window.hwnd(), YOUTUBE_TIMER_ID);
                host.youtube_polling = false;
            }
            put_host(cell, host);
            profiles
        }
        None => Vec::new(),
    };
    for view in profiles {
        clear_profile_then(&view, COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_PROFILE, |_| {});
    }
}

/// Polls every wired YouTube view's wrapper state and reports player
/// transitions: `loaded` (the player is ready), `stream-ready` (first
/// playback), `media-ended` (once), and `failed` (`youtube_error`).
fn poll_youtube_surfaces(cell: &SharedHost) {
    let views: Vec<(String, ICoreWebView2)> = match cell.borrow().as_ref() {
        Some(host) => host
            .remote_views
            .iter()
            .filter(|(_, surface)| {
                surface.webview.is_some()
                    && !surface.failed
                    && matches!(surface.spec.content, crate::remote_web::SurfaceContent::YouTube(_))
            })
            .filter_map(|(id, surface)| surface.webview.clone().map(|view| (id.clone(), view)))
            .collect(),
        None => return,
    };
    for (surface_id, view) in views {
        let poll_cell = Rc::clone(cell);
        let handler =
            ExecuteScriptCompletedHandler::create(Box::new(move |result: windows::core::Result<()>, json: String| {
                if result.is_err() {
                    return Ok(());
                }
                let token = serde_json::from_str::<String>(&json).unwrap_or_default();
                let Some(state) = crate::remote_web::parse_youtube_state(&token) else { return Ok(()) };
                let event = match take_host(&poll_cell) {
                    Some(mut host) => {
                        let event = host.remote_views.get_mut(&surface_id).and_then(|surface| {
                            if surface.failed {
                                return None;
                            }
                            match state {
                                crate::remote_web::YouTubeState::Loading => None,
                                crate::remote_web::YouTubeState::Ready
                                | crate::remote_web::YouTubeState::Playing
                                | crate::remote_web::YouTubeState::Buffering
                                | crate::remote_web::YouTubeState::Paused => {
                                    let mut event = None;
                                    if !surface.loaded {
                                        surface.loaded = true;
                                        event = Some(("loaded", None));
                                    } else if state == crate::remote_web::YouTubeState::Playing && !surface.stream_ready
                                    {
                                        surface.stream_ready = true;
                                        event = Some(("stream-ready", None));
                                    }
                                    event
                                }
                                crate::remote_web::YouTubeState::Ended => {
                                    if surface.youtube_ended {
                                        None
                                    } else {
                                        surface.youtube_ended = true;
                                        Some(("media-ended", None))
                                    }
                                }
                                crate::remote_web::YouTubeState::Error(_) => {
                                    surface.failed = true;
                                    Some(("failed", Some("youtube_error")))
                                }
                            }
                        });
                        put_host(&poll_cell, host);
                        event
                    }
                    None => None,
                };
                if let Some((kind, code)) = event {
                    emit_remote(&poll_cell, Some(&surface_id), kind, code);
                }
                Ok(())
            }));
        // SAFETY: the STA thread owns the webview; the handler is
        // AddRef'd by the call.
        if unsafe { view.ExecuteScript(&HSTRING::from(YOUTUBE_POLL_SCRIPT), &handler) }.is_err() {
            tracing::debug!(component = "webview", event = "youtube_poll_failed");
        }
    }
}
