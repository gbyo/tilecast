//! The WKWebView on the main thread. Every AppKit and WebKit object lives
//! on the main thread, driven by the normal AppKit run loop
//! ([`crate::app`]); nothing here waits synchronously for WebKit.
//!
//! Tokio→UI: [`UiCommand`]s on a bounded channel, drained by a main-queue
//! block that the [`UiHandle`] wake schedules (at most one outstanding).
//! UI→Tokio: [`UiEvent`]s on a bounded channel, fed by WebKit callbacks.
//!
//! Resources: `WKURLSchemeHandler`s for `tilecast` and `tcmedia` hand each
//! request to `webview_host::serve` on the Player's Tokio runtime and
//! stream the answer back in bounded chunks, one chunk in flight per task,
//! each delivered on the main queue only while WebKit still owns the task.
//!
//! Bridge: two `WKScriptMessageHandlerWithReply` channels in the page
//! world (`runtime_host_webkit.js`). Every message is checked against the
//! trusted top-level Runtime document of the current generation before it
//! is read.
//!
//! `unsafe` in this file is objc2 WebKit/AppKit glue only, on the main
//! thread that owns the objects, with the justification at each call.
#![allow(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use block2::{DynBlock, RcBlock};
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, ProtocolObject};
use objc2::{AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send};
use objc2_app_kit::{NSBackingStoreType, NSColor, NSScreen, NSWindow, NSWindowStyleMask};
use objc2_foundation::{
    NSBundle, NSDictionary, NSError, NSHTTPURLResponse, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
    NSURLRequest,
};
use objc2_web_kit::{
    WKAudiovisualMediaTypes, WKContentWorld, WKInactiveSchedulingPolicy, WKNavigation, WKNavigationAction,
    WKNavigationActionPolicy, WKNavigationDelegate, WKScriptMessage, WKScriptMessageHandlerWithReply,
    WKURLSchemeHandler, WKURLSchemeTask, WKUserContentController, WKUserScript, WKUserScriptInjectionTime, WKWebView,
    WKWebViewConfiguration, WKWebsiteDataStore,
};
use tokio::sync::mpsc;

use super::policy::{self, HostQueue, MessageSource, Pull, PullDocument};
use webview_host::media::RendererInstance;
use webview_host::schemes::{MEDIA_SCHEME, RUNTIME_ENTRY_URL, RUNTIME_SCHEME};
use webview_host::ui::{
    BridgeTransport, MAX_CONFORMANCE_MESSAGE_BYTES, UiCommand, UiError, UiEvent, UiHandle, UiServices,
    WEBKIT_HOST_MESSAGES_CHANNEL, WEBKIT_RUNTIME_CHANNEL,
};

/// The largest body chunk delivered to WebKit at once. One chunk per task
/// is in flight, so a cancelled video range stops reading promptly.
const CHUNK_BYTES: u64 = 512 * 1024;

/// The JavaScript reply type of `WKScriptMessageHandlerWithReply`.
type Reply = RcBlock<dyn Fn(*mut AnyObject, *mut NSString)>;

fn emit(events: &mpsc::Sender<UiEvent>, event: UiEvent) {
    if events.try_send(event).is_err() {
        tracing::warn!(component = "webkit", event = "event_queue_full");
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
}

/// The WebKit build and macOS release, for host diagnostics.
pub fn engine_version() -> String {
    let version = NSBundle::bundleWithIdentifier(&NSString::from_str("com.apple.WebKit"))
        .and_then(|bundle| bundle.objectForInfoDictionaryKey(&NSString::from_str("CFBundleVersion")))
        .and_then(|value| value.downcast::<NSString>().ok())
        .map(|value| value.to_string());
    let os = crate::device::os_release();
    match version {
        Some(version) => format!("WebKit {version} (macOS {os})"),
        None => format!("WebKit (macOS {os})"),
    }
}

/// What a resource worker needs, shared off the main thread.
struct ServeContext {
    runtime: webview_host::runtime_files::RuntimeFiles,
    media: Arc<std::sync::Mutex<webview_host::media::MediaRegistry>>,
    cas: player_cas::ContentStore,
}

/// One accepted scheme task, owned by WebKit until it finishes or stops.
struct Task {
    generation: u64,
    task: Retained<ProtocolObject<dyn WKURLSchemeTask>>,
}

/// The renderer state. It lives in a main-thread thread-local; callbacks
/// borrow it briefly and never call into WebKit while borrowed, because a
/// WebKit call may re-enter a delegate.
struct View {
    mtm: MainThreadMarker,
    services: UiServices,
    serve: Arc<ServeContext>,
    events: mpsc::Sender<UiEvent>,
    commands: mpsc::Receiver<UiCommand>,
    tokio: tokio::runtime::Handle,
    bootstrap: String,
    window: Retained<NSWindow>,
    webview: Option<Retained<WKWebView>>,
    /// The navigation delegate; WebKit holds it weakly.
    navigation: Option<Retained<NavigationDelegate>>,
    /// Increments with every web view. Callbacks from a replaced web view
    /// carry an older generation and are ignored.
    generation: u64,
    queue: HostQueue,
    document: PullDocument,
    pull: Option<Reply>,
    tasks: HashMap<u64, Task>,
    next_task: u64,
}

thread_local! {
    static VIEW: RefCell<Option<View>> = const { RefCell::new(None) };
}

/// Runs `f` on the renderer state, if it exists and is not already
/// borrowed further up this call stack.
fn with_view<R>(f: impl FnOnce(&mut View) -> R) -> Option<R> {
    VIEW.with(|cell| match cell.try_borrow_mut() {
        Ok(mut view) => view.as_mut().map(f),
        Err(_) => {
            tracing::error!(component = "webkit", event = "reentrant_callback");
            None
        }
    })
}

/// Starts the renderer on the main thread and waits, without blocking it
/// or a Tokio worker, for the first Runtime navigation to begin.
pub async fn spawn_ui(services: UiServices) -> Result<(UiHandle, mpsc::Receiver<UiEvent>), UiError> {
    let (commands_tx, commands_rx) = mpsc::channel(32);
    let (events_tx, events_rx) = mpsc::channel(64);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let scheduled = Arc::new(AtomicBool::new(false));
    let wake_scheduled = Arc::clone(&scheduled);
    let wake: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        // One outstanding drain is enough: it empties the whole queue.
        if !wake_scheduled.swap(true, Ordering::AcqRel) {
            let scheduled = Arc::clone(&wake_scheduled);
            DispatchQueue::main().exec_async(move || {
                scheduled.store(false, Ordering::Release);
                drain_commands();
            });
        }
    });
    let handle = UiHandle::new(commands_tx.clone(), Arc::clone(&wake));
    let tokio = tokio::runtime::Handle::current();
    DispatchQueue::main().exec_async(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = ready_tx.send(Err("the main queue is not on the main thread".to_owned()));
            return;
        };
        start(mtm, services, commands_rx, events_tx, tokio, ready_tx);
    });
    match tokio::time::timeout(Duration::from_secs(60), ready_rx).await {
        Ok(Ok(Ok(()))) => Ok((handle, events_rx)),
        Ok(Ok(Err(reason))) => Err(UiError::Startup(reason)),
        Ok(Err(_)) => Err(UiError::Startup("the renderer did not start".to_owned())),
        Err(_) => {
            // The main thread may not be running an AppKit loop at all.
            let _ = commands_tx.try_send(UiCommand::Shutdown);
            wake();
            Err(UiError::Startup("the renderer did not start in time".to_owned()))
        }
    }
}

fn start(
    mtm: MainThreadMarker,
    services: UiServices,
    commands: mpsc::Receiver<UiCommand>,
    events: mpsc::Sender<UiEvent>,
    tokio: tokio::runtime::Handle,
    ready: tokio::sync::oneshot::Sender<Result<(), String>>,
) {
    if VIEW.with(|cell| cell.borrow().is_some()) {
        let _ = ready.send(Err("a renderer is already running".to_owned()));
        return;
    }
    let bootstrap = match services.conformance.as_ref() {
        Some(conformance) => conformance.bootstrap.clone(),
        None => webview_host::ui::bootstrap_script(BridgeTransport::WebKit, &services.info, &services.capabilities),
    };
    let window = open_window(mtm, services.conformance.as_ref().map(|c| (c.width, c.height)));
    services.main_window.store(Retained::as_ptr(&window) as usize, Ordering::SeqCst);
    let serve = Arc::new(ServeContext {
        runtime: services.runtime.clone(),
        media: Arc::clone(&services.media),
        cas: services.cas.clone(),
    });
    let session = services.session;
    VIEW.with(|cell| {
        *cell.borrow_mut() = Some(View {
            mtm,
            services,
            serve,
            events,
            commands,
            tokio,
            bootstrap,
            window,
            webview: None,
            navigation: None,
            generation: 0,
            queue: HostQueue::default(),
            document: PullDocument::default(),
            pull: None,
            tasks: HashMap::new(),
            next_task: 0,
        })
    });
    match create_webview(session) {
        Ok(()) => {
            let _ = ready.send(Ok(()));
        }
        Err(reason) => {
            let _ = ready.send(Err(reason.clone()));
            teardown(Some(UiEvent::Fatal { reason }));
        }
    }
    // A Shutdown that arrived before the view existed still takes effect.
    drain_commands();
}

/// The window that hosts the web view. Production covers the main
/// screen's visible frame; conformance is a borderless window at exactly
/// the fixture viewport. Kiosk presentation (full screen, Dock and menu
/// bar, sleep) belongs to the kiosk host (gbyo/tilecast#1930).
fn open_window(mtm: MainThreadMarker, fixed: Option<(i32, i32)>) -> Retained<NSWindow> {
    let (frame, style) = match fixed {
        Some((width, height)) => (
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(f64::from(width), f64::from(height))),
            NSWindowStyleMask::Borderless,
        ),
        None => (
            NSScreen::mainScreen(mtm).map_or_else(
                || NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1920.0, 1080.0)),
                |screen| screen.visibleFrame(),
            ),
            NSWindowStyleMask::Titled | NSWindowStyleMask::Miniaturizable | NSWindowStyleMask::Resizable,
        ),
    };
    // SAFETY: main thread; the window is retained by the view state and
    // never released on close (it has no close button).
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            frame,
            style,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    // SAFETY: as above.
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitle(&NSString::from_str("Tilecast Player"));
    window.setBackgroundColor(Some(&NSColor::blackColor()));
    window.makeKeyAndOrderFront(None);
    window
}

/// Builds a web view for a new generation bound to `session`, installs
/// the bootstrap and handlers, and starts the Runtime navigation.
fn create_webview(session: uuid::Uuid) -> Result<(), String> {
    let Some((mtm, generation, bootstrap, window)) = with_view(|view| {
        view.generation += 1;
        view.services.session = session;
        view.queue.clear();
        view.document.forget();
        view.pull = None;
        (view.mtm, view.generation, view.bootstrap.clone(), view.window.clone())
    }) else {
        return Err("the renderer state is unavailable".to_owned());
    };

    // SAFETY: main thread; every object below is created, configured, and
    // attached here, before the web view loads anything.
    let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
    unsafe {
        // The trusted Runtime keeps nothing between sessions.
        configuration.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(mtm));
        // Unattended signage: media starts without a gesture, with the
        // sound the content was authored with.
        configuration.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes(0));
        let preferences = configuration.preferences();
        // An occluded or minimized window keeps presenting on schedule.
        preferences.setInactiveSchedulingPolicy(WKInactiveSchedulingPolicy::None);
        preferences.setElementFullscreenEnabled(false);
        preferences.setJavaScriptCanOpenWindowsAutomatically(false);

        for scheme in [RUNTIME_SCHEME, MEDIA_SCHEME] {
            let handler = SchemeHandler::new(mtm, generation);
            configuration.setURLSchemeHandler_forURLScheme(
                Some(ProtocolObject::from_ref(&*handler)),
                &NSString::from_str(scheme),
            );
        }

        let content: Retained<WKUserContentController> = configuration.userContentController();
        let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
            WKUserScript::alloc(mtm),
            &NSString::from_str(&bootstrap),
            WKUserScriptInjectionTime::AtDocumentStart,
            true,
        );
        content.addUserScript(&script);
        let page = WKContentWorld::pageWorld(mtm);
        for (name, channel) in
            [(WEBKIT_RUNTIME_CHANNEL, Channel::Runtime), (WEBKIT_HOST_MESSAGES_CHANNEL, Channel::HostMessages)]
        {
            let handler = MessageHandler::new(mtm, generation, channel);
            content.addScriptMessageHandlerWithReply_contentWorld_name(
                ProtocolObject::from_ref(&*handler),
                &page,
                &NSString::from_str(name),
            );
        }
    }

    let frame = window.contentLayoutRect();
    // SAFETY: main thread; the configuration is fully built.
    let webview = unsafe { WKWebView::initWithFrame_configuration(WKWebView::alloc(mtm), frame, &configuration) };
    let navigation = NavigationDelegate::new(mtm, generation);
    // SAFETY: main thread; the delegate is retained by the view state
    // because WebKit holds it weakly.
    unsafe {
        webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*navigation)));
        webview.setInspectable(false);
        webview.setAllowsBackForwardNavigationGestures(false);
        webview.setAllowsMagnification(false);
        webview.setUnderPageBackgroundColor(Some(&NSColor::blackColor()));
    }
    window.setContentView(Some(&webview));

    {
        let services_media = with_view(|view| Arc::clone(&view.services.media)).ok_or("the renderer state is gone")?;
        let mut media = services_media.lock().unwrap_or_else(|poison| poison.into_inner());
        media.bind_renderer(RendererInstance { session });
    }
    let url = NSURL::URLWithString(&NSString::from_str(RUNTIME_ENTRY_URL)).ok_or("the Runtime URL is invalid")?;
    // SAFETY: main thread.
    unsafe { webview.loadRequest(&NSURLRequest::requestWithURL(&url)) };
    with_view(|view| {
        view.webview = Some(webview);
        view.navigation = Some(navigation);
        emit(&view.events, UiEvent::Session { session });
    });
    tracing::info!(component = "webkit", event = "runtime_loading", generation);
    Ok(())
}

/// Removes the current web view. Its scheme tasks are abandoned without
/// further callbacks; WebKit stops them as the view goes away.
fn retire_webview() {
    let retired = with_view(|view| {
        let webview = view.webview.take();
        let navigation = view.navigation.take();
        let pull = view.pull.take();
        view.document.forget();
        view.tasks.clear();
        let media = Arc::clone(&view.services.media);
        let session = view.services.session;
        (webview, navigation, pull, media, session)
    });
    let Some((webview, navigation, pull, media, session)) = retired else { return };
    media.lock().unwrap_or_else(|poison| poison.into_inner()).unbind_renderer(session);
    drop(pull);
    if let Some(webview) = webview {
        // SAFETY: main thread; the view state no longer refers to it.
        unsafe {
            webview.setNavigationDelegate(None);
            webview.stopLoading();
            let content = webview.configuration().userContentController();
            content.removeAllScriptMessageHandlers();
            content.removeAllUserScripts();
        }
        webview.removeFromSuperview();
    }
    drop(navigation);
}

/// Ends the renderer: the web view, its grants, and the window.
fn teardown(event: Option<UiEvent>) {
    retire_webview();
    let state = VIEW.with(|cell| cell.borrow_mut().take());
    let Some(view) = state else { return };
    view.services.main_window.store(0, Ordering::SeqCst);
    if let Some(event) = event {
        emit(&view.events, event);
    }
    view.window.orderOut(None);
    drop(view);
}

fn drain_commands() {
    loop {
        let Some(command) = with_view(|view| view.commands.try_recv().ok()).flatten() else { return };
        match command {
            UiCommand::Post { message } => post(message),
            UiCommand::Reload => {
                if let Some(webview) = with_view(|view| view.webview.clone()).flatten() {
                    tracing::info!(component = "webkit", event = "renderer_reload");
                    // SAFETY: main thread.
                    unsafe { webview.reload() };
                }
            }
            UiCommand::Restart { reason, .. } => restart(&reason),
            UiCommand::Shutdown => {
                teardown(None);
                return;
            }
            UiCommand::CapturePreview { reply } => {
                // A WKWebView snapshot is not the composed final output;
                // Studio previews use final-output capture (#1928).
                let _ = reply.send(Err("preview capture is not available on the macOS renderer".to_owned()));
            }
            UiCommand::RemoteClearData { reply } => {
                if let Some(reply) = reply {
                    let _ = reply.send(false);
                }
            }
            UiCommand::RemoteCreate { .. }
            | UiCommand::RemoteViewport { .. }
            | UiCommand::RemoteVisible { .. }
            | UiCommand::RemoteMuted { .. }
            | UiCommand::RemoteReload { .. }
            | UiCommand::RemoteDestroy { .. }
            | UiCommand::RemoteRecovered => {
                // Remote web is not offered on macOS (gbyo/tilecast#1927).
                tracing::warn!(component = "webkit", event = "remote_web_unavailable");
            }
        }
    }
}

/// Closes the web view and builds a fresh one with a new session. The old
/// session's grants stop resolving when the new session binds; its queued
/// messages and pull never reach the new document.
fn restart(reason: &str) {
    tracing::info!(component = "webkit", event = "renderer_restart", reason);
    retire_webview();
    let session = uuid::Uuid::new_v4();
    if let Err(reason) = create_webview(session) {
        teardown(Some(UiEvent::Fatal { reason }));
    }
}

/// Queues one host message and answers a waiting pull.
fn post(message: serde_json::Value) {
    let delivery = with_view(|view| {
        if let Err(error) = view.queue.push(&message) {
            tracing::warn!(component = "webkit", event = "host_message_dropped", error = ?error);
        }
        take_delivery(view)
    })
    .flatten();
    if let Some((reply, batch)) = delivery {
        answer_pull(&reply, &batch);
    }
}

/// A waiting pull and the batch to answer it with, if both exist.
fn take_delivery(view: &mut View) -> Option<(Reply, String)> {
    if view.pull.is_none() || view.queue.is_empty() {
        return None;
    }
    let batch = view.queue.take_batch()?;
    Some((view.pull.take()?, batch))
}

fn answer_pull(reply: &Reply, batch: &str) {
    let batch = NSString::from_str(batch);
    reply.call((Retained::as_ptr(&batch) as *mut AnyObject, std::ptr::null_mut()));
}

fn refuse(reply: &DynBlock<dyn Fn(*mut AnyObject, *mut NSString)>) {
    let error = NSString::from_str("refused");
    reply.call((std::ptr::null_mut(), Retained::as_ptr(&error) as *mut NSString));
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel {
    Runtime,
    HostMessages,
}

fn absolute_string(url: Option<Retained<NSURL>>) -> Option<String> {
    url.and_then(|url| url.absoluteString()).map(|text| text.to_string())
}

fn on_script_message(
    generation: u64,
    channel: Channel,
    message: &WKScriptMessage,
    reply: &DynBlock<dyn Fn(*mut AnyObject, *mut NSString)>,
) {
    // SAFETY: main thread; WebKit owns the message for this call.
    let (frame, webview, body) = unsafe { (message.frameInfo(), message.webView(), message.body()) };
    // SAFETY: as above.
    let (main_frame, origin) = unsafe { (frame.isMainFrame(), frame.securityOrigin()) };
    // SAFETY: as above.
    let (protocol, host, port) = unsafe { (origin.protocol().to_string(), origin.host().to_string(), origin.port()) };
    // SAFETY: as above.
    let document_url = absolute_string(webview.as_ref().and_then(|webview| unsafe { webview.URL() }));
    let current_view = with_view(|view| {
        view.generation == generation
            && matches!((&view.webview, &webview), (Some(ours), Some(theirs)) if Retained::as_ptr(ours) == Retained::as_ptr(theirs))
    })
    .unwrap_or(false);
    let source = MessageSource {
        main_frame,
        origin_protocol: &protocol,
        origin_host: &host,
        origin_port: port,
        document_url: document_url.as_deref(),
        current_view,
    };
    if !policy::is_trusted_bridge_source(&source) {
        tracing::warn!(component = "webkit", event = "foreign_script_message_ignored", main_frame, protocol, host);
        refuse(reply);
        return;
    }
    let Ok(body) = body.downcast::<NSString>() else {
        refuse(reply);
        return;
    };
    let conformance = with_view(|view| view.services.conformance.is_some()).unwrap_or(false);
    let limit = if conformance { MAX_CONFORMANCE_MESSAGE_BYTES } else { webview_host::bridge::MAX_MESSAGE_BYTES };
    // A UTF-16 length over the byte limit is over it in UTF-8 too.
    if body.length() > limit {
        tracing::warn!(component = "webkit", event = "bridge_message_too_large");
        refuse(reply);
        return;
    }
    let text = body.to_string();
    match channel {
        Channel::Runtime => {
            let event = if conformance {
                (text.len() <= limit && serde_json::from_str::<serde_json::Value>(&text).is_ok())
                    .then_some(UiEvent::ConformanceMessage { body: text })
            } else {
                webview_host::bridge::parse_runtime_message(&text).map(UiEvent::Runtime)
            };
            match event {
                Some(event) => {
                    with_view(|view| emit(&view.events, event));
                    reply.call((std::ptr::null_mut(), std::ptr::null_mut()));
                }
                None => {
                    tracing::warn!(component = "webkit", event = "bridge_message_rejected");
                    refuse(reply);
                }
            }
        }
        Channel::HostMessages => {
            if !policy::valid_document_id(&text) {
                refuse(reply);
                return;
            }
            let reply = reply.copy();
            let outcome = with_view(|view| {
                let released = match view.document.accept(&text) {
                    Pull::Repeat | Pull::NewDocument => view.pull.take(),
                };
                view.pull = Some(reply);
                (released, take_delivery(view))
            });
            let Some((released, delivery)) = outcome else { return };
            if let Some(released) = released {
                answer_pull(&released, "[]");
            }
            if let Some((reply, batch)) = delivery {
                answer_pull(&reply, &batch);
            }
        }
    }
}

// ---- resources ----

/// One step of a scheme task's answer, delivered on the main queue.
enum Delivery {
    Head { status: u16, headers: Vec<(&'static str, String)> },
    Data(Vec<u8>),
    Finish,
    Fail,
}

fn on_start_task(generation: u64, web_view: &WKWebView, task: &ProtocolObject<dyn WKURLSchemeTask>) {
    // SAFETY: main thread; WebKit owns the task until it finishes or stops.
    let request = unsafe { task.request() };
    let url = absolute_string(request.URL()).unwrap_or_default();
    let method = request.HTTPMethod().map(|method| method.to_string()).unwrap_or_else(|| "GET".to_owned());
    let range = request.valueForHTTPHeaderField(&NSString::from_str("Range")).map(|range| range.to_string());
    // Granted media and frames are served only while the top-level
    // document of this web view is the Runtime.
    // SAFETY: main thread.
    let from_runtime = absolute_string(unsafe { web_view.URL() }).as_deref() == Some(RUNTIME_ENTRY_URL);
    let task = task.retain();
    let accepted = with_view(|view| {
        if view.generation != generation {
            return None;
        }
        view.next_task += 1;
        let key = view.next_task;
        view.tasks.insert(key, Task { generation, task: task.clone() });
        Some((key, Arc::clone(&view.serve), view.services.session, view.tokio.clone()))
    })
    .flatten();
    let Some((key, serve, session, tokio)) = accepted else {
        fail_task(&task);
        return;
    };
    tokio.spawn(serve_task(serve, session, key, url, method, range, from_runtime));
}

fn on_stop_task(task: &ProtocolObject<dyn WKURLSchemeTask>) {
    with_view(|view| {
        view.tasks.retain(|_, entry| !std::ptr::eq(&*entry.task, task));
    });
}

fn fail_task(task: &ProtocolObject<dyn WKURLSchemeTask>) {
    let error = NSError::new(-1, &NSString::from_str("org.tilecast.player.scheme"));
    // SAFETY: main thread; WebKit still owns the task.
    unsafe { task.didFailWithError(&error) };
}

/// Answers one scheme task through the shared policy, then streams its
/// body one bounded chunk at a time. Each step waits for the main thread
/// to confirm WebKit still wants the task.
async fn serve_task(
    serve: Arc<ServeContext>,
    session: uuid::Uuid,
    key: u64,
    url: String,
    method: String,
    range: Option<String>,
    from_runtime: bool,
) {
    let resources =
        webview_host::serve::Resources { runtime: &serve.runtime, media: &serve.media, cas: &serve.cas, session };
    let request = webview_host::serve::Request { url: &url, method: &method, range: range.as_deref(), from_runtime };
    let response = webview_host::serve::answer(resources, request, now_ms()).await;
    // Never the URL: a media capability is a bearer token.
    tracing::debug!(
        component = "webkit",
        event = "resource",
        scheme = url.split_once(':').map_or("", |(scheme, _)| scheme),
        method = method.as_str(),
        status = response.status,
        ranged = range.is_some(),
        bytes = response.body.len(),
    );
    if !deliver(key, Delivery::Head { status: response.status, headers: response.headers }).await {
        return;
    }
    match response.body {
        webview_host::serve::Body::Empty => {}
        webview_host::serve::Body::Bytes(bytes) => {
            if !deliver(key, Delivery::Data(bytes)).await {
                return;
            }
        }
        webview_host::serve::Body::File { file, offset, len } => {
            let file = Arc::new(file);
            let end = offset.saturating_add(len);
            let mut position = offset;
            while position < end {
                let size = CHUNK_BYTES.min(end - position);
                let reader = Arc::clone(&file);
                let chunk = tokio::task::spawn_blocking(move || {
                    use std::os::unix::fs::FileExt as _;
                    let mut buffer = vec![0; size as usize];
                    reader.read_exact_at(&mut buffer, position).map(|()| buffer)
                })
                .await;
                let Ok(Ok(chunk)) = chunk else {
                    tracing::warn!(component = "webkit", event = "resource_read_failed");
                    deliver(key, Delivery::Fail).await;
                    return;
                };
                if !deliver(key, Delivery::Data(chunk)).await {
                    return;
                }
                position += size;
            }
        }
    }
    deliver(key, Delivery::Finish).await;
}

/// Runs one delivery on the main thread. Answers whether the task is
/// still live afterwards.
async fn deliver(key: u64, delivery: Delivery) -> bool {
    let (done, alive) = tokio::sync::oneshot::channel();
    DispatchQueue::main().exec_async(move || {
        let _ = done.send(deliver_on_main(key, delivery));
    });
    alive.await.unwrap_or(false)
}

fn deliver_on_main(key: u64, delivery: Delivery) -> bool {
    let Some(entry) = with_view(|view| {
        let entry = view.tasks.get(&key)?;
        (entry.generation == view.generation).then(|| entry.task.clone())
    })
    .flatten() else {
        return false;
    };
    let task = &*entry;
    // SAFETY (each arm): main thread; the task is still owned by WebKit,
    // because a stopped task leaves the map before WebKit returns.
    match delivery {
        Delivery::Head { status, headers } => {
            let request = unsafe { task.request() };
            let Some(url) = request.URL() else {
                unsafe { task.didFailWithError(&NSError::new(-1, &NSString::from_str("org.tilecast.player.scheme"))) };
                with_view(|view| view.tasks.remove(&key));
                return false;
            };
            let keys: Vec<Retained<NSString>> = headers.iter().map(|(name, _)| NSString::from_str(name)).collect();
            let values: Vec<Retained<NSString>> = headers.iter().map(|(_, value)| NSString::from_str(value)).collect();
            let key_refs: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
            let value_refs: Vec<&NSString> = values.iter().map(|value| &**value).collect();
            let fields = NSDictionary::from_slices(&key_refs, &value_refs);
            let response = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(
                NSHTTPURLResponse::alloc(),
                &url,
                isize::try_from(status).unwrap_or(500),
                Some(&NSString::from_str("HTTP/1.1")),
                Some(&fields),
            );
            match response {
                Some(response) => unsafe { task.didReceiveResponse(&response) },
                None => {
                    unsafe {
                        task.didFailWithError(&NSError::new(-1, &NSString::from_str("org.tilecast.player.scheme")))
                    };
                    with_view(|view| view.tasks.remove(&key));
                    return false;
                }
            }
        }
        Delivery::Data(bytes) => {
            let data = objc2_foundation::NSData::from_vec(bytes);
            unsafe { task.didReceiveData(&data) };
        }
        Delivery::Finish => {
            unsafe { task.didFinish() };
            with_view(|view| view.tasks.remove(&key));
            return false;
        }
        Delivery::Fail => {
            fail_task(task);
            with_view(|view| view.tasks.remove(&key));
            return false;
        }
    }
    // The task may have stopped during the call above.
    with_view(|view| view.tasks.contains_key(&key)).unwrap_or(false)
}

// ---- navigation ----

fn on_navigation_action(
    generation: u64,
    action: &WKNavigationAction,
    decision: &DynBlock<dyn Fn(WKNavigationActionPolicy)>,
) {
    // SAFETY: main thread; WebKit owns the action for this call.
    let (frame, request) = unsafe { (action.targetFrame(), action.request()) };
    // A navigation without a target frame would open a new window.
    // SAFETY: as above.
    let main_frame = frame.is_some_and(|frame| unsafe { frame.isMainFrame() });
    let url = absolute_string(request.URL()).unwrap_or_default();
    let current = with_view(|view| view.generation == generation).unwrap_or(false);
    if current && policy::allows_navigation(main_frame, &url) {
        decision.call((WKNavigationActionPolicy::Allow,));
    } else {
        tracing::warn!(component = "webkit", event = "navigation_refused", main_frame);
        decision.call((WKNavigationActionPolicy::Cancel,));
    }
}

fn on_navigation_failed(generation: u64, error: &NSError) {
    let code = error.code();
    let domain = error.domain().to_string();
    // Cancellations (a reload over a load, a refused navigation) are not
    // failures of the Runtime document.
    if (domain == "NSURLErrorDomain" && code == -999) || (domain == "WebKitErrorDomain" && code == 102) {
        return;
    }
    tracing::warn!(component = "webkit", event = "runtime_load_failed", domain, code);
    with_view(|view| {
        if view.generation == generation {
            emit(&view.events, UiEvent::Fatal { reason: "the runtime document failed to load".to_owned() });
        }
    });
}

fn on_content_process_terminated(generation: u64) {
    tracing::warn!(component = "webkit", event = "web_content_process_terminated", generation);
    let released = with_view(|view| {
        if view.generation != generation {
            return None;
        }
        // The document is gone; a reload starts a new one that pulls again.
        view.document.forget();
        emit(&view.events, UiEvent::ProcessFailed { kind: "render-process-exited:terminated".to_owned() });
        view.pull.take()
    })
    .flatten();
    drop(released);
}

// ---- Objective-C classes ----

/// Ivars of the per-generation delegates.
#[derive(Debug)]
struct Generation(u64);

#[derive(Debug)]
struct HandlerIvars {
    generation: u64,
    channel: Channel,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TilecastSchemeHandler"]
    #[ivars = Generation]
    struct SchemeHandler;

    unsafe impl NSObjectProtocol for SchemeHandler {}

    unsafe impl WKURLSchemeHandler for SchemeHandler {
        #[unsafe(method(webView:startURLSchemeTask:))]
        fn start_task(&self, web_view: &WKWebView, task: &ProtocolObject<dyn WKURLSchemeTask>) {
            on_start_task(self.ivars().0, web_view, task);
        }

        #[unsafe(method(webView:stopURLSchemeTask:))]
        fn stop_task(&self, _web_view: &WKWebView, task: &ProtocolObject<dyn WKURLSchemeTask>) {
            on_stop_task(task);
        }
    }
);

impl SchemeHandler {
    fn new(mtm: MainThreadMarker, generation: u64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Generation(generation));
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TilecastScriptMessageHandler"]
    #[ivars = HandlerIvars]
    struct MessageHandler;

    unsafe impl NSObjectProtocol for MessageHandler {}

    unsafe impl WKScriptMessageHandlerWithReply for MessageHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:replyHandler:))]
        fn did_receive(
            &self,
            _controller: &WKUserContentController,
            message: &WKScriptMessage,
            reply: &DynBlock<dyn Fn(*mut AnyObject, *mut NSString)>,
        ) {
            on_script_message(self.ivars().generation, self.ivars().channel, message, reply);
        }
    }
);

impl MessageHandler {
    fn new(mtm: MainThreadMarker, generation: u64, channel: Channel) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(HandlerIvars { generation, channel });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TilecastNavigationDelegate"]
    #[ivars = Generation]
    struct NavigationDelegate;

    unsafe impl NSObjectProtocol for NavigationDelegate {}

    unsafe impl WKNavigationDelegate for NavigationDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_policy(
            &self,
            _web_view: &WKWebView,
            action: &WKNavigationAction,
            decision: &DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            on_navigation_action(self.ivars().0, action, decision);
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            tracing::info!(component = "webkit", event = "runtime_loaded", generation = self.ivars().0);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            on_navigation_failed(self.ivars().0, error);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            on_navigation_failed(self.ivars().0, error);
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn content_process_terminated(&self, _web_view: &WKWebView) {
            on_content_process_terminated(self.ivars().0);
        }
    }
);

impl NavigationDelegate {
    fn new(mtm: MainThreadMarker, generation: u64) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Generation(generation));
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}
