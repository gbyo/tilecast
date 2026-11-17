//! Host-layer remote web on WKWebView (`remoteWeb: "host-view"`).
//!
//! Each Website or YouTube surface is its own `WKWebView` inside a backdrop
//! view stacked above the trusted Runtime web view, in the window's flipped
//! layer view. The shared coordinator (`webview_host::remote_layer`) owns
//! every decision: the data policy, the lifecycle events, navigation, the
//! failure vocabulary, what a destroy releases, and what a clear reaches.
//! This module is WebKit glue only. [`policy::remote_view_plan`] is the
//! complete configuration of a remote view: no scheme handler, no script
//! message handler, no user script, and never the Runtime's data store.
//!
//! Every object lives on the main thread. State is in a main-thread
//! thread-local that callbacks borrow briefly; no WebKit call happens while
//! it is borrowed, because a WebKit call may re-enter a delegate.
//!
//! `unsafe` in this file is objc2 WebKit/AppKit glue only, on the main
//! thread that owns the objects, with the justification at each call.
#![allow(unsafe_code)]

use std::cell::{Cell, RefCell};

use block2::{DynBlock, RcBlock};
use dispatch2::{DispatchQueue, DispatchTime};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, ProtocolObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send, sel};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSColor, NSView, NSWindow, NSWindowOrderingMode};
use objc2_foundation::{
    NSArray, NSDate, NSError, NSHTTPCookie, NSHTTPURLResponse, NSNumber, NSObjectProtocol, NSPoint, NSRect, NSSize,
    NSString, NSURL, NSURLAuthenticationChallenge, NSURLAuthenticationMethodServerTrust, NSURLCredential, NSURLRequest,
    NSURLSessionAuthChallengeDisposition, NSUUID,
};
use objc2_web_kit::{
    WKAudiovisualMediaTypes, WKContentWorld, WKFrameInfo, WKInactiveSchedulingPolicy, WKMediaCaptureType, WKNavigation,
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKNavigationResponse,
    WKNavigationResponsePolicy, WKOpenPanelParameters, WKPermissionDecision, WKSecurityOrigin, WKUIDelegate, WKWebView,
    WKWebViewConfiguration, WKWebsiteDataStore, WKWindowFeatures,
};
use tokio::sync::mpsc;

use super::policy::{self, RemoteStore};
use webview_host::remote_layer::{self, DataRelease, LayerEvent, LayerState, LoadError, Released, RemoteLayers};
use webview_host::remote_web::{self, SurfaceSpec, ViewportPx};
use webview_host::ui::{UiCommand, UiEvent};

/// WebKit's page mute state for audio (`_WKMediaAudioMuted`).
const PAGE_AUDIO_MUTED: usize = 1;

/// One surface's WebKit objects.
struct Surface {
    /// A per-process serial: callbacks from a destroyed view whose surface
    /// id was reused never reach the new one.
    serial: u64,
    backdrop: Retained<LayerView>,
    webview: Retained<WKWebView>,
    store: Retained<WKWebsiteDataStore>,
    /// WebKit holds both delegates weakly.
    _navigation: Retained<RemoteNavigation>,
    _ui: Retained<RemoteUi>,
}

struct Remote {
    mtm: MainThreadMarker,
    events: mpsc::Sender<UiEvent>,
    window: Retained<NSWindow>,
    root: Retained<LayerView>,
    layers: RemoteLayers<Surface>,
    serial: u64,
    polling: bool,
}

thread_local! {
    static REMOTE: RefCell<Option<Remote>> = const { RefCell::new(None) };
}

fn with_remote<R>(f: impl FnOnce(&mut Remote) -> R) -> Option<R> {
    REMOTE.with(|cell| match cell.try_borrow_mut() {
        Ok(mut remote) => remote.as_mut().map(f),
        Err(_) => {
            tracing::error!(component = "webkit", event = "remote_reentrant_callback");
            None
        }
    })
}

fn emit(event: webview_host::bridge::RemoteWebEvent) {
    with_remote(|remote| {
        if remote.events.try_send(UiEvent::Remote { event }).is_err() {
            tracing::warn!(component = "webkit", event = "event_queue_full");
        }
    });
}

fn emit_layer(surface_id: &str, event: Option<LayerEvent>) {
    if let Some(event) = event {
        emit(event.for_surface(surface_id));
    }
}

/// The identity a delegate carries: the surface and its view serial.
#[derive(Debug, Clone)]
struct SurfaceRef {
    surface_id: String,
    serial: u64,
}

/// Runs `f` on the surface's shared state when `surface` is still the live
/// view of its id.
fn with_state<R>(surface: &SurfaceRef, f: impl FnOnce(&mut LayerState) -> R) -> Option<R> {
    with_remote(|remote| {
        let layer = remote.layers.get_mut(&surface.surface_id)?;
        (layer.view.serial == surface.serial).then(|| f(&mut layer.state))
    })
    .flatten()
}

/// Starts remote web for the trusted window: `root` is the flipped layer
/// view that holds the Runtime web view. Announces that remote web serves.
pub fn install(
    mtm: MainThreadMarker,
    events: mpsc::Sender<UiEvent>,
    window: Retained<NSWindow>,
    root: Retained<LayerView>,
) {
    REMOTE.with(|cell| {
        *cell.borrow_mut() =
            Some(Remote { mtm, events, window, root, layers: RemoteLayers::new(), serial: 0, polling: false });
    });
    emit(remote_layer::recovered());
}

/// Ends remote web with the window: every surface is released by policy.
pub fn uninstall() {
    reset();
    REMOTE.with(|cell| cell.borrow_mut().take());
}

/// Drops every surface, releasing each by its policy. The trusted renderer
/// restarted or the window closed; the Runtime re-creates what it shows.
pub fn reset() {
    let released = with_remote(|remote| remote.layers.drain()).unwrap_or_default();
    for released in released {
        release(released);
    }
}

/// Handles one remote command on the main thread.
pub fn handle(command: UiCommand) {
    match command {
        UiCommand::RemoteCreate { spec } => create(spec),
        UiCommand::RemoteViewport { surface_id, viewport } => set_viewport(&surface_id, viewport),
        UiCommand::RemoteVisible { surface_id, visible } => set_visible(&surface_id, visible),
        UiCommand::RemoteMuted { surface_id, muted } => set_muted(&surface_id, muted),
        UiCommand::RemoteReload { surface_id } => reload(&surface_id),
        UiCommand::RemoteDestroy { surface_id } => destroy(&surface_id),
        UiCommand::RemoteRecovered => {
            // Each surface owns its web content process, so a crash fails
            // only that surface; remote web as a whole keeps serving.
            emit(remote_layer::recovered());
        }
        UiCommand::RemoteClearData { reply } => clear_data(reply),
        _ => {}
    }
}

/// Whether remote web is installed (not in conformance mode).
pub fn installed() -> bool {
    REMOTE.with(|cell| cell.try_borrow().map(|remote| remote.is_some()).unwrap_or(true))
}

// ---- create ----

fn identified_store(mtm: MainThreadMarker, id: &str) -> Option<Retained<WKWebsiteDataStore>> {
    let uuid = uuid::Uuid::parse_str(id).ok()?;
    let uuid = NSUUID::from_bytes(*uuid.as_bytes());
    // SAFETY: main thread; macOS 14 is the minimum (docs/tilecast-macos.md).
    Some(unsafe { WKWebsiteDataStore::dataStoreForIdentifier(&uuid, mtm) })
}

fn store_for(mtm: MainThreadMarker, store: RemoteStore) -> Option<Retained<WKWebsiteDataStore>> {
    match store {
        // SAFETY: main thread; each call returns a new private store.
        RemoteStore::PrivatePerSurface => Some(unsafe { WKWebsiteDataStore::nonPersistentDataStore(mtm) }),
        RemoteStore::Identified(id) => identified_store(mtm, id),
    }
}

fn srgb((red, green, blue): (u8, u8, u8)) -> Retained<NSColor> {
    NSColor::colorWithSRGBRed_green_blue_alpha(
        f64::from(red) / 255.0,
        f64::from(green) / 255.0,
        f64::from(blue) / 255.0,
        1.0,
    )
}

/// Mutes or unmutes every audio source of a web view. WebKit has no public
/// page mute on macOS; this is the page-mute SPI that Safari uses. `false`
/// when this WebKit lacks it: a surface whose sound cannot follow the
/// Runtime must not exist.
fn set_page_muted(webview: &WKWebView, muted: bool) -> bool {
    // SAFETY: main thread; `respondsToSelector:` is NSObject API.
    let available: bool = unsafe { msg_send![webview, respondsToSelector: sel!(_setPageMuted:)] };
    if !available {
        return false;
    }
    let state: usize = if muted { PAGE_AUDIO_MUTED } else { 0 };
    // SAFETY: main thread; the selector exists and takes `_WKMediaMutedState`
    // (an NSUInteger bit set).
    let _: () = unsafe { msg_send![webview, _setPageMuted: state] };
    true
}

fn frame(window: &NSWindow, viewport: ViewportPx) -> NSRect {
    let (x, y, width, height) = policy::viewport_points(viewport, window.backingScaleFactor());
    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))
}

fn create(spec: SurfaceSpec) {
    let surface_id = spec.surface_id.clone();
    let Some((mtm, window, root, serial)) = with_remote(|remote| {
        remote.serial += 1;
        (remote.mtm, remote.window.clone(), remote.root.clone(), remote.serial)
    }) else {
        return;
    };
    let state = LayerState::new(spec);
    let plan = policy::remote_view_plan(&state);
    let Some(store) = store_for(mtm, plan.store) else {
        emit_layer(&surface_id, Some(LayerEvent::failed(remote_web::UNAVAILABLE)));
        return;
    };
    let surface = SurfaceRef { surface_id: surface_id.clone(), serial };

    // SAFETY: main thread; the configuration is built and applied here,
    // before the web view loads anything. It follows the plan exactly: no
    // scheme handler, no script message handler, no user script.
    let configuration = unsafe { WKWebViewConfiguration::new(mtm) };
    unsafe {
        configuration.setWebsiteDataStore(&store);
        // Unattended signage: no gesture exists. Sound follows the
        // Runtime's mute, applied below before the first load.
        configuration.setMediaTypesRequiringUserActionForPlayback(WKAudiovisualMediaTypes(0));
        configuration.defaultWebpagePreferences().setAllowsContentJavaScript(plan.javascript);
        let preferences = configuration.preferences();
        preferences.setJavaScriptCanOpenWindowsAutomatically(plan.javascript_opens_windows);
        preferences.setElementFullscreenEnabled(false);
        preferences.setFraudulentWebsiteWarningEnabled(plan.fraud_warnings);
        preferences.setInactiveSchedulingPolicy(WKInactiveSchedulingPolicy::None);
    }
    debug_assert!(plan.scheme_handlers.is_empty() && plan.message_handlers.is_empty() && plan.user_scripts.is_empty());

    let bounds = frame(&window, state.viewport());
    let backdrop = LayerView::new(mtm, Some(srgb(plan.background)));
    backdrop.setFrame(bounds);
    backdrop.setHidden(!state.visible());
    // SAFETY: main thread; the configuration is fully built.
    let webview = unsafe {
        WKWebView::initWithFrame_configuration(
            WKWebView::alloc(mtm),
            NSRect::new(NSPoint::new(0.0, 0.0), bounds.size),
            &configuration,
        )
    };
    let navigation = RemoteNavigation::new(mtm, surface.clone());
    let ui = RemoteUi::new(mtm);
    // SAFETY: main thread; both delegates are retained by the surface.
    unsafe {
        webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*navigation)));
        webview.setUIDelegate(Some(ProtocolObject::from_ref(&*ui)));
        webview.setInspectable(plan.inspectable);
        webview.setAllowsBackForwardNavigationGestures(false);
        webview.setAllowsMagnification(false);
        webview.setAllowsLinkPreview(false);
        webview.setPageZoom(plan.page_zoom);
        if let Some(agent) = plan.user_agent.as_deref() {
            webview.setCustomUserAgent(Some(&NSString::from_str(agent)));
        }
        // The backdrop shows the configured color until the page paints,
        // and under a transparent page (KVC key that WKWebView exposes on
        // macOS for this).
        let _: () = msg_send![&*webview, setValue: &*NSNumber::new_bool(false), forKey: &*NSString::from_str("drawsBackground")];
        webview.setUnderPageBackgroundColor(Some(&srgb(plan.background)));
    }
    // A file dropped on the window must not become a navigation.
    webview.unregisterDraggedTypes();
    webview.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    if !set_page_muted(&webview, plan.muted) {
        tracing::warn!(component = "webkit", event = "remote_mute_unavailable", surface = surface_id.as_str());
        emit_layer(&surface_id, Some(LayerEvent::failed("unsupported_content")));
        return;
    }
    backdrop.addSubview(&webview);

    let youtube = state.is_youtube();
    let navigate = (state.initial_url(), state.youtube_wrapper());
    let admitted = with_remote(|remote| {
        let entry = Surface {
            serial,
            backdrop: backdrop.clone(),
            webview: webview.clone(),
            store,
            _navigation: navigation,
            _ui: ui,
        };
        remote.layers.insert(state.spec().clone(), entry).map(|_| ())
    })
    .unwrap_or(Err(remote_web::UNAVAILABLE));
    if let Err(code) = admitted {
        // SAFETY: main thread; nothing has loaded yet.
        unsafe {
            webview.setNavigationDelegate(None);
            webview.setUIDelegate(None);
        }
        emit_layer(&surface_id, Some(LayerEvent::failed(code)));
        return;
    }
    // Later surfaces stack above earlier ones, all above the Runtime.
    root.addSubview(&backdrop);
    if youtube {
        start_polling();
    }
    match navigate {
        (url, None) => {
            let Some(url) = NSURL::URLWithString(&NSString::from_str(&url)) else {
                fail_now(&surface_id, "load_failed");
                return;
            };
            // SAFETY: main thread.
            unsafe { webview.loadRequest(&NSURLRequest::requestWithURL(&url)) };
        }
        (url, Some(wrapper)) => load_wrapper(&webview, &surface_id, &url, &wrapper),
    }
    tracing::info!(component = "webkit", event = "remote_created", surface = surface_id.as_str(), youtube);
}

/// Loads the Tilecast YouTube wrapper as a document of the fixed
/// `https://org.tilecast.player` origin, which the iframe API requires.
/// WebKit takes the document from memory; the origin serves nothing.
fn load_wrapper(webview: &WKWebView, surface_id: &str, url: &str, wrapper: &str) {
    let Some(base) = NSURL::URLWithString(&NSString::from_str(url)) else {
        fail_now(surface_id, "unsupported_content");
        return;
    };
    // SAFETY: main thread.
    unsafe { webview.loadHTMLString_baseURL(&NSString::from_str(wrapper), Some(&base)) };
}

/// Fails a surface whose navigation cannot start, and releases it.
fn fail_now(surface_id: &str, code: &'static str) {
    let event =
        with_remote(|remote| remote.layers.get_mut(surface_id).and_then(|layer| layer.state.fail(code))).flatten();
    emit_layer(surface_id, event);
    destroy(surface_id);
}

// ---- commands ----

fn set_viewport(surface_id: &str, viewport: ViewportPx) {
    let Some((backdrop, window)) = with_remote(|remote| {
        let layer = remote.layers.get_mut(surface_id)?;
        layer.state.set_viewport(viewport);
        Some((layer.view.backdrop.clone(), remote.window.clone()))
    })
    .flatten() else {
        return;
    };
    backdrop.setFrame(frame(&window, viewport));
}

fn set_visible(surface_id: &str, visible: bool) {
    let Some((backdrop, webview, command)) = with_remote(|remote| {
        let layer = remote.layers.get_mut(surface_id)?;
        let command = layer.state.set_visible(visible);
        Some((layer.view.backdrop.clone(), layer.view.webview.clone(), command))
    })
    .flatten() else {
        return;
    };
    backdrop.setHidden(!visible);
    if let Some(command) = command {
        run_script(&webview, command, None);
    }
}

fn set_muted(surface_id: &str, muted: bool) {
    let webview = with_remote(|remote| {
        let layer = remote.layers.get_mut(surface_id)?;
        layer.state.set_muted(muted);
        Some(layer.view.webview.clone())
    })
    .flatten();
    if let Some(webview) = webview
        && !set_page_muted(&webview, muted)
    {
        tracing::warn!(component = "webkit", event = "remote_mute_failed", surface = surface_id);
    }
}

fn reload(surface_id: &str) {
    let Some((webview, url, wrapper)) = with_remote(|remote| {
        let layer = remote.layers.get_mut(surface_id)?;
        layer.state.reload();
        Some((layer.view.webview.clone(), layer.state.initial_url(), layer.state.youtube_wrapper()))
    })
    .flatten() else {
        return;
    };
    match wrapper {
        // The wrapper is an in-memory document: load it again.
        Some(wrapper) => load_wrapper(&webview, surface_id, &url, &wrapper),
        // SAFETY: main thread.
        None => unsafe {
            webview.reload();
        },
    }
}

fn destroy(surface_id: &str) {
    let released = with_remote(|remote| remote.layers.remove(surface_id)).flatten();
    if let Some(released) = released {
        release(released);
    }
}

/// Takes a released surface off screen and performs its data release.
fn release(released: Released<Surface>) {
    let Released { surface_id, view: surface, release, keep_hosts, .. } = released;
    // SAFETY: main thread; the surface map no longer refers to the view.
    unsafe {
        surface.webview.setNavigationDelegate(None);
        surface.webview.setUIDelegate(None);
        surface.webview.stopLoading();
    }
    set_page_muted(&surface.webview, true);
    surface.webview.removeFromSuperview();
    surface.backdrop.removeFromSuperview();
    match release {
        DataRelease::DiscardSurfaceStore => {
            // The private store dies with its last reference; clearing it
            // first makes that independent of WebKit's retain timing.
            remove_all_data(&surface.store, Box::new(|| {}));
        }
        DataRelease::StripForeignCookies => strip_foreign_cookies(&surface.store, keep_hosts),
        DataRelease::Keep => {}
    }
    tracing::info!(component = "webkit", event = "remote_released", surface = surface_id.as_str(), release = ?release);
}

/// Deletes every cookie of `store` that does not belong to `keep_hosts`.
/// The cookie store lists the whole store, so third-party cookies set by
/// subresources are found without any navigation to their host.
fn strip_foreign_cookies(store: &WKWebsiteDataStore, keep_hosts: Vec<String>) {
    // SAFETY: main thread.
    let cookies = unsafe { store.httpCookieStore() };
    let deleter = cookies.clone();
    let block = RcBlock::new(move |list: std::ptr::NonNull<NSArray<NSHTTPCookie>>| {
        // SAFETY: WebKit passes a valid array for the duration of the call.
        let list = unsafe { list.as_ref() };
        let mut removed = 0usize;
        for cookie in list.iter() {
            if !remote_web::cookie_belongs_to_hosts(&cookie.domain().to_string(), &keep_hosts) {
                // SAFETY: main thread; completion is optional.
                unsafe { deleter.deleteCookie_completionHandler(&cookie, None) };
                removed += 1;
            }
        }
        tracing::info!(component = "webkit", event = "first_party_cookie_strip", removed);
    });
    // SAFETY: main thread; the block is copied by WebKit.
    unsafe { cookies.getAllCookies(&block) };
}

/// Removes every kind of Website data from `store`, then runs `done`.
fn remove_all_data(store: &WKWebsiteDataStore, done: Box<dyn FnOnce()>) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    // SAFETY: main thread.
    let types = unsafe { WKWebsiteDataStore::allWebsiteDataTypes(mtm) };
    let done = Cell::new(Some(done));
    // The store stays alive until its own completion runs.
    let keep = store.retain();
    let block = RcBlock::new(move || {
        let _ = &keep;
        if let Some(done) = done.take() {
            done();
        }
    });
    // SAFETY: main thread; the block is copied by WebKit.
    unsafe { store.removeDataOfTypes_modifiedSince_completionHandler(&types, &NSDate::distantPast(), &block) };
}

/// Clears Tilecast's remote Website data: every live per-surface store,
/// and every shared store whether or not a surface uses it. The trusted
/// Runtime's store, the CAS, and Player state are never touched. Live
/// pages keep running; their next load starts from the cleared store.
fn clear_data(reply: Option<tokio::sync::oneshot::Sender<bool>>) {
    let stores = with_remote(|remote| {
        let plan = remote.layers.clear_plan(|_| true);
        let mut complete = true;
        let mut stores: Vec<Retained<WKWebsiteDataStore>> =
            plan.live.iter().filter_map(|id| remote.layers.get(id).map(|layer| layer.view.store.clone())).collect();
        for shared in plan.idle {
            match policy::remote_store(shared) {
                RemoteStore::Identified(id) => match identified_store(remote.mtm, id) {
                    Some(store) => stores.push(store),
                    None => complete = false,
                },
                RemoteStore::PrivatePerSurface => {}
            }
        }
        (stores, complete)
    });
    let answer = std::rc::Rc::new(RefCell::new(reply));
    let finish = {
        let answer = std::rc::Rc::clone(&answer);
        move |cleared: bool| {
            if let Some(reply) = answer.borrow_mut().take() {
                let _ = reply.send(cleared);
            }
        }
    };
    let Some((stores, complete)) = stores else {
        finish(false);
        return;
    };
    if stores.is_empty() {
        finish(complete);
        return;
    }
    let total = stores.len();
    let remaining = std::rc::Rc::new(Cell::new(total));
    let finish = std::rc::Rc::new(finish);
    for store in stores {
        let remaining = std::rc::Rc::clone(&remaining);
        let finish = std::rc::Rc::clone(&finish);
        remove_all_data(
            &store,
            Box::new(move || {
                remaining.set(remaining.get().saturating_sub(1));
                if remaining.get() == 0 {
                    tracing::info!(component = "webkit", event = "website_data_cleared", stores = total, complete);
                    finish(complete);
                }
            }),
        );
    }
}

// ---- scripts and the YouTube poll ----

/// Runs a Tilecast script in WebKit's client content world: it shares the
/// DOM with the page, but the page's scripts cannot see or replace it.
fn run_script(webview: &WKWebView, script: &str, done: Option<Box<dyn Fn(Option<String>)>>) {
    let Some(mtm) = MainThreadMarker::new() else { return };
    // SAFETY: main thread.
    let world = unsafe { WKContentWorld::defaultClientWorld(mtm) };
    let block = done.map(|done| {
        RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
            if !error.is_null() || result.is_null() {
                done(None);
                return;
            }
            // SAFETY: WebKit passes a valid object for the call.
            let value = unsafe { &*result };
            done(value.downcast_ref::<NSString>().map(|text| text.to_string()));
        })
    });
    // SAFETY: main thread; the block, if any, is copied by WebKit.
    unsafe {
        webview.evaluateJavaScript_inFrame_inContentWorld_completionHandler(
            &NSString::from_str(script),
            None,
            &world,
            block.as_deref(),
        );
    }
}

fn start_polling() {
    let start = with_remote(|remote| !std::mem::replace(&mut remote.polling, true)).unwrap_or(false);
    if start {
        schedule_poll();
    }
}

fn schedule_poll() {
    let Ok(when) = DispatchTime::try_from(remote_web::YOUTUBE_POLL_INTERVAL) else { return };
    let _ = DispatchQueue::main().after(when, poll_youtube);
}

/// Reads each live YouTube wrapper's state and reports transitions, at the
/// shared cadence. The poll stops when no YouTube surface is left.
fn poll_youtube() {
    let views = with_remote(|remote| {
        let views: Vec<(SurfaceRef, Retained<WKWebView>)> = remote
            .layers
            .iter()
            .filter(|(_, layer)| layer.state.is_youtube() && !layer.state.failed())
            .map(|(id, layer)| {
                (SurfaceRef { surface_id: id.to_owned(), serial: layer.view.serial }, layer.view.webview.clone())
            })
            .collect();
        if !remote.layers.has_youtube(|_| true) {
            remote.polling = false;
        }
        (views, remote.polling)
    });
    let Some((views, polling)) = views else { return };
    for (surface, webview) in views {
        run_script(
            &webview,
            remote_layer::YOUTUBE_POLL_SCRIPT,
            Some(Box::new(move |token| {
                let Some(token) = token else { return };
                let event = with_state(&surface, |state| state.youtube_state(&token)).flatten();
                emit_layer(&surface.surface_id, event);
            })),
        );
    }
    if polling {
        schedule_poll();
    }
}

// ---- navigation ----

fn absolute_string(url: Option<Retained<NSURL>>) -> String {
    url.and_then(|url| url.absoluteString()).map(|text| text.to_string()).unwrap_or_default()
}

fn origin_parts(origin: &WKSecurityOrigin) -> (String, String) {
    // SAFETY: main thread; WebKit owns the origin for the call.
    unsafe { (origin.protocol().to_string(), origin.host().to_string()) }
}

fn on_action(surface: &SurfaceRef, action: &WKNavigationAction) -> WKNavigationActionPolicy {
    // SAFETY: main thread; WebKit owns the action for this call.
    let (target, source, request, download) =
        unsafe { (action.targetFrame(), action.sourceFrame(), action.request(), action.shouldPerformDownload()) };
    let url = absolute_string(request.URL());
    // A navigation without a target frame would open a window.
    let Some(target) = target else {
        tracing::info!(component = "webkit", event = "remote_popup_refused", surface = surface.surface_id.as_str());
        return WKNavigationActionPolicy::Cancel;
    };
    if download {
        tracing::info!(component = "webkit", event = "remote_download_refused", surface = surface.surface_id.as_str());
        return WKNavigationActionPolicy::Cancel;
    }
    // SAFETY: as above.
    let main = unsafe { target.isMainFrame() };
    let decision = if main {
        with_state(surface, |state| state.top_level_navigation(&url).map_err(Some))
    } else {
        let from_wrapper = source.as_deref().is_some_and(|source| {
            // SAFETY: as above.
            let (protocol, host) = origin_parts(&*unsafe { source.securityOrigin() });
            // SAFETY: as above.
            policy::started_by_wrapper(unsafe { source.isMainFrame() }, &protocol, &host)
        });
        with_state(surface, |state| if state.subframe_navigation(&url, from_wrapper) { Ok(()) } else { Err(None) })
    };
    match decision.unwrap_or(Err(None)) {
        Ok(()) => WKNavigationActionPolicy::Allow,
        Err(event) => {
            // The host only: a URL can carry credentials-like tokens.
            tracing::warn!(
                component = "webkit",
                event = if main { "remote_navigation_blocked" } else { "remote_subframe_blocked" },
                surface = surface.surface_id.as_str(),
                host = remote_web::log_host(&url).as_str(),
            );
            emit_layer(&surface.surface_id, event);
            WKNavigationActionPolicy::Cancel
        }
    }
}

fn on_response(surface: &SurfaceRef, response: &WKNavigationResponse) -> WKNavigationResponsePolicy {
    // SAFETY: main thread; WebKit owns the response for this call.
    let (main, can_show, response) =
        unsafe { (response.isForMainFrame(), response.canShowMIMEType(), response.response()) };
    if !can_show {
        // Never a download.
        if main {
            let event = with_state(surface, |state| state.fail("unsupported_content")).flatten();
            emit_layer(&surface.surface_id, event);
        }
        return WKNavigationResponsePolicy::Cancel;
    }
    let status = response.downcast::<NSHTTPURLResponse>().ok().map(|http| http.statusCode());
    let status = status.and_then(|status| u16::try_from(status).ok());
    if main && status.is_some_and(|status| status >= 400) {
        let finished = with_state(surface, |state| state.load_finished(status, LoadError::None)).unwrap_or_default();
        emit_layer(&surface.surface_id, finished.event);
        return WKNavigationResponsePolicy::Cancel;
    }
    WKNavigationResponsePolicy::Allow
}

fn on_finished(surface: &SurfaceRef, error: LoadError) {
    let finished = with_state(surface, |state| state.load_finished(None, error)).unwrap_or_default();
    if let Some(script) = finished.script.as_deref() {
        let webview =
            with_remote(|remote| remote.layers.get(&surface.surface_id).map(|layer| layer.view.webview.clone()))
                .flatten();
        if let Some(webview) = webview {
            run_script(&webview, script, None);
        }
    }
    emit_layer(&surface.surface_id, finished.event);
}

fn on_failed(surface: &SurfaceRef, error: &NSError) {
    let (domain, code) = (error.domain().to_string(), error.code());
    let error = policy::load_error(&domain, code);
    if error != LoadError::Cancelled {
        tracing::warn!(
            component = "webkit",
            event = "remote_load_failed",
            surface = surface.surface_id.as_str(),
            domain,
            code
        );
    }
    on_finished(surface, error);
}

// ---- Objective-C classes ----

/// A flipped view: its origin is the top-left, like the Runtime's CSS
/// pixels. The window's layer view holds the Runtime and the backdrops;
/// a backdrop fills itself with the surface's background color.
pub struct LayerViewIvars {
    background: Option<Retained<NSColor>>,
}

define_class!(
    #[unsafe(super(NSView))]
    #[thread_kind = MainThreadOnly]
    #[name = "TilecastLayerView"]
    #[ivars = LayerViewIvars]
    pub struct LayerView;

    unsafe impl NSObjectProtocol for LayerView {}

    impl LayerView {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool {
            true
        }

        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, dirty: NSRect) {
            if let Some(color) = self.ivars().background.as_ref() {
                color.setFill();
                objc2_app_kit::NSRectFill(dirty);
            }
        }
    }
);

impl LayerView {
    pub fn new(mtm: MainThreadMarker, background: Option<Retained<NSColor>>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(LayerViewIvars { background });
        // SAFETY: NSView's designated initializer.
        unsafe { msg_send![super(this), initWithFrame: NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0))] }
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TilecastRemoteNavigationDelegate"]
    #[ivars = SurfaceRef]
    struct RemoteNavigation;

    unsafe impl NSObjectProtocol for RemoteNavigation {}

    unsafe impl WKNavigationDelegate for RemoteNavigation {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn decide_action(
            &self,
            _web_view: &WKWebView,
            action: &WKNavigationAction,
            decision: &DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let policy = on_action(self.ivars(), action);
            decision.call((policy,));
        }

        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        fn decide_response(
            &self,
            _web_view: &WKWebView,
            response: &WKNavigationResponse,
            decision: &DynBlock<dyn Fn(WKNavigationResponsePolicy)>,
        ) {
            let policy = on_response(self.ivars(), response);
            decision.call((policy,));
        }

        #[unsafe(method(webView:didCommitNavigation:))]
        fn did_commit(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            let surface = self.ivars();
            let event = with_state(surface, LayerState::content_loading).flatten();
            emit_layer(&surface.surface_id, event);
        }

        #[unsafe(method(webView:didFinishNavigation:))]
        fn did_finish(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>) {
            on_finished(self.ivars(), LoadError::None);
        }

        #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
        fn did_fail_provisional(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            on_failed(self.ivars(), error);
        }

        #[unsafe(method(webView:didFailNavigation:withError:))]
        fn did_fail(&self, _web_view: &WKWebView, _navigation: Option<&WKNavigation>, error: &NSError) {
            on_failed(self.ivars(), error);
        }

        #[unsafe(method(webView:didReceiveAuthenticationChallenge:completionHandler:))]
        fn challenge(
            &self,
            _web_view: &WKWebView,
            challenge: &NSURLAuthenticationChallenge,
            completion: &DynBlock<dyn Fn(NSURLSessionAuthChallengeDisposition, *mut NSURLCredential)>,
        ) {
            // Server trust gets the system's evaluation, which refuses
            // self-signed, expired, wrong-host, and untrusted chains; there
            // is no bypass. Website credentials and client certificates
            // are out of scope: cancelled, never prompted.
            // WebKit owns the challenge for the call.
            let method = challenge.protectionSpace().authenticationMethod();
            // SAFETY: a constant Foundation string.
            let server_trust = &*method == unsafe { NSURLAuthenticationMethodServerTrust };
            let disposition = if server_trust {
                NSURLSessionAuthChallengeDisposition::PerformDefaultHandling
            } else {
                NSURLSessionAuthChallengeDisposition::CancelAuthenticationChallenge
            };
            completion.call((disposition, std::ptr::null_mut()));
        }

        #[unsafe(method(webView:authenticationChallenge:shouldAllowDeprecatedTLS:))]
        fn deprecated_tls(
            &self,
            _web_view: &WKWebView,
            _challenge: &NSURLAuthenticationChallenge,
            decision: &DynBlock<dyn Fn(Bool)>,
        ) {
            decision.call((Bool::NO,));
        }

        #[unsafe(method(webViewWebContentProcessDidTerminate:))]
        fn content_process_terminated(&self, _web_view: &WKWebView) {
            // Only this surface's process ended; the trusted Runtime and
            // the other surfaces keep running. The Runtime's failure policy
            // decides what replaces it.
            let surface = self.ivars();
            tracing::warn!(
                component = "webkit",
                event = "remote_content_process_terminated",
                surface = surface.surface_id.as_str()
            );
            let event = with_state(surface, LayerState::content_process_ended).flatten();
            emit_layer(&surface.surface_id, event);
        }
    }
);

impl RemoteNavigation {
    fn new(mtm: MainThreadMarker, surface: SurfaceRef) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(surface);
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

define_class!(
    /// Refuses everything a remote page could ask of the user or the Mac:
    /// windows, JavaScript dialogs (they would block unattended signage),
    /// file selection, camera, microphone, and motion sensors.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TilecastRemoteUIDelegate"]
    struct RemoteUi;

    unsafe impl NSObjectProtocol for RemoteUi {}

    unsafe impl WKUIDelegate for RemoteUi {
        #[unsafe(method(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        fn create_web_view(
            &self,
            _web_view: &WKWebView,
            _configuration: &WKWebViewConfiguration,
            _action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> *mut WKWebView {
            std::ptr::null_mut()
        }

        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn alert(&self, _web_view: &WKWebView, _message: &NSString, _frame: &WKFrameInfo, done: &DynBlock<dyn Fn()>) {
            done.call(());
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        fn confirm(
            &self,
            _web_view: &WKWebView,
            _message: &NSString,
            _frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn(Bool)>,
        ) {
            done.call((Bool::NO,));
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        fn prompt(
            &self,
            _web_view: &WKWebView,
            _prompt: &NSString,
            _default: Option<&NSString>,
            _frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn(*mut NSString)>,
        ) {
            done.call((std::ptr::null_mut(),));
        }

        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn media_capture(
            &self,
            _web_view: &WKWebView,
            _origin: &WKSecurityOrigin,
            _frame: &WKFrameInfo,
            _kind: WKMediaCaptureType,
            decision: &DynBlock<dyn Fn(WKPermissionDecision)>,
        ) {
            decision.call((WKPermissionDecision::Deny,));
        }

        #[unsafe(method(webView:requestDeviceOrientationAndMotionPermissionForOrigin:initiatedByFrame:decisionHandler:))]
        fn motion(
            &self,
            _web_view: &WKWebView,
            _origin: &WKSecurityOrigin,
            _frame: &WKFrameInfo,
            decision: &DynBlock<dyn Fn(WKPermissionDecision)>,
        ) {
            decision.call((WKPermissionDecision::Deny,));
        }

        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        fn open_panel(
            &self,
            _web_view: &WKWebView,
            _parameters: &WKOpenPanelParameters,
            _frame: &WKFrameInfo,
            done: &DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
        ) {
            done.call((std::ptr::null_mut(),));
        }
    }
);

impl RemoteUi {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// Positions the Runtime web view at the bottom of the layer view, filling
/// it as the window resizes.
pub fn attach_runtime(root: &LayerView, webview: &WKWebView) {
    webview.setFrame(root.bounds());
    webview.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    root.addSubview_positioned_relativeTo(webview, NSWindowOrderingMode::Below, None);
}
