//! The WKWebView renderer's decisions, kept apart from the WebKit glue so
//! they are testable without a WebKit process: which documents may use the
//! Runtime bridge, which navigations may happen, how host messages queue
//! for the WebKit pull channel, and how a remote Website or YouTube view is
//! configured and isolated.

use std::collections::VecDeque;

use webview_host::bridge::MAX_HOST_MESSAGE_BYTES;
use webview_host::remote_layer::{LayerState, LoadError, RemoteDataPolicy};
use webview_host::remote_web::ViewportPx;
use webview_host::schemes::{RUNTIME_ENTRY_URL, RUNTIME_HOST, RUNTIME_SCHEME};

/// What WebKit reports about the frame that sent a script message.
#[derive(Debug, Clone, Copy)]
pub struct MessageSource<'a> {
    /// `WKFrameInfo.isMainFrame`.
    pub main_frame: bool,
    /// `WKSecurityOrigin` protocol, host, and port of the sending frame.
    pub origin_protocol: &'a str,
    pub origin_host: &'a str,
    pub origin_port: isize,
    /// The URL of the top-level document in the receiving web view.
    pub document_url: Option<&'a str>,
    /// Whether the message came from the renderer's current web view (and
    /// so its current generation), not a replaced one.
    pub current_view: bool,
}

/// Whether a script message may reach the Runtime bridge: only the top
/// frame of the current web view, from the trusted Runtime origin, while
/// that view shows the Runtime document. A Widget frame, an iframe, a
/// navigated page, or a replaced generation never qualifies.
pub fn is_trusted_bridge_source(source: &MessageSource<'_>) -> bool {
    source.current_view
        && source.main_frame
        && source.origin_protocol == RUNTIME_SCHEME
        && source.origin_host == RUNTIME_HOST
        && source.origin_port == 0
        && source.document_url == Some(RUNTIME_ENTRY_URL)
}

/// Whether the trusted web view may navigate. The top frame loads exactly
/// the Runtime document. The trusted view has no subframes: Websites and
/// YouTube are separate remote views (`remote.rs`), and external Widget or
/// plugin frames are not offered, so every subframe navigation is refused.
pub fn allows_navigation(main_frame: bool, url: &str) -> bool {
    main_frame && url == RUNTIME_ENTRY_URL
}

/// A pull's document id: 32 lowercase hex characters from the bootstrap.
pub fn valid_document_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The most host messages that may wait for the Runtime to pull them.
pub const MAX_QUEUED_MESSAGES: usize = 256;
/// The most encoded bytes that may wait for the Runtime to pull them.
pub const MAX_QUEUED_BYTES: usize = 4 * MAX_HOST_MESSAGE_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueError {
    /// One message is larger than the host message limit.
    TooLarge,
    /// The Runtime is not pulling; the queue is at its bound.
    Full,
}

/// Host→Runtime messages waiting for the Runtime's pull, in order.
#[derive(Debug, Default)]
pub struct HostQueue {
    messages: VecDeque<String>,
    bytes: usize,
}

impl HostQueue {
    /// Queues one message. A message over the host limit, or one that does
    /// not fit the bound, is refused rather than truncated or reordered.
    pub fn push(&mut self, message: &serde_json::Value) -> Result<(), QueueError> {
        let encoded = serde_json::to_string(message).map_err(|_| QueueError::TooLarge)?;
        if encoded.len() > MAX_HOST_MESSAGE_BYTES {
            return Err(QueueError::TooLarge);
        }
        if self.messages.len() >= MAX_QUEUED_MESSAGES || self.bytes + encoded.len() > MAX_QUEUED_BYTES {
            return Err(QueueError::Full);
        }
        self.bytes += encoded.len();
        self.messages.push_back(encoded);
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.messages.is_empty()
    }

    pub fn len(&self) -> usize {
        self.messages.len()
    }

    pub fn clear(&mut self) {
        self.messages.clear();
        self.bytes = 0;
    }

    /// Takes the oldest messages, in order, as one JSON array: at least one
    /// message, and more while the batch stays within the host message
    /// limit. `None` when nothing waits.
    pub fn take_batch(&mut self) -> Option<String> {
        let first = self.messages.pop_front()?;
        self.bytes -= first.len();
        let mut batch = String::with_capacity(first.len() + 2);
        batch.push('[');
        batch.push_str(&first);
        while let Some(next) = self.messages.front() {
            if batch.len() + next.len() + 2 > MAX_HOST_MESSAGE_BYTES {
                break;
            }
            let next = self.messages.pop_front().expect("front exists");
            self.bytes -= next.len();
            batch.push(',');
            batch.push_str(&next);
        }
        batch.push(']');
        Some(batch)
    }
}

/// What to do with a pull from `document`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pull {
    /// The same document pulled again: release its older pull.
    Repeat,
    /// A new document: the old document is gone, release its pull.
    NewDocument,
}

/// The document currently pulling host messages.
#[derive(Debug, Default)]
pub struct PullDocument(Option<String>);

impl PullDocument {
    pub fn accept(&mut self, document: &str) -> Pull {
        if self.0.as_deref() == Some(document) {
            Pull::Repeat
        } else {
            self.0 = Some(document.to_owned());
            Pull::NewDocument
        }
    }

    pub fn forget(&mut self) {
        self.0 = None;
    }
}

// ---- remote web ----

/// The `WKWebsiteDataStore` of a remote surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteStore {
    /// A new non-persistent store for this surface alone. It holds no
    /// state on disk and goes away with the surface's web view.
    PrivatePerSurface,
    /// A persistent store, from `dataStoreForIdentifier:` (macOS 14), that
    /// Tilecast owns for one shared policy. Never the default store and
    /// never the trusted Runtime's store.
    Identified(&'static str),
}

/// The fixed identifiers of the three shared remote stores. A bounded,
/// known set: the Player never creates a persistent store per surface.
pub const FIRST_PARTY_STORE: &str = "6F0A3C1E-6B1D-4C8A-9E35-2B7D51C0A101";
pub const ALL_COOKIES_STORE: &str = "6F0A3C1E-6B1D-4C8A-9E35-2B7D51C0A102";
pub const YOUTUBE_STORE: &str = "6F0A3C1E-6B1D-4C8A-9E35-2B7D51C0A103";

/// The store of a data policy. Per-surface policies get a private
/// non-persistent store, which discards everything (DOM storage included)
/// with the surface.
pub fn remote_store(policy: RemoteDataPolicy) -> RemoteStore {
    match policy {
        RemoteDataPolicy::EphemeralSurface | RemoteDataPolicy::IsolatedNoDomStorage => RemoteStore::PrivatePerSurface,
        RemoteDataPolicy::PersistentFirstParty => RemoteStore::Identified(FIRST_PARTY_STORE),
        RemoteDataPolicy::PersistentAll => RemoteStore::Identified(ALL_COOKIES_STORE),
        RemoteDataPolicy::YouTube => RemoteStore::Identified(YOUTUBE_STORE),
    }
}

/// Everything a remote surface's `WKWebViewConfiguration` and web view
/// receive. The WebKit glue applies this plan and nothing else, so the
/// isolation guarantees are the plan's fields.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteViewPlan {
    pub store: RemoteStore,
    /// Custom URL schemes with a handler. Always empty: remote content can
    /// never resolve `tilecast:` or `tcmedia:`.
    pub scheme_handlers: Vec<&'static str>,
    /// Script message handlers. Always empty: no native bridge.
    pub message_handlers: Vec<&'static str>,
    /// Document-start user scripts. Always empty: no Runtime bootstrap.
    pub user_scripts: Vec<String>,
    pub javascript: bool,
    pub user_agent: Option<String>,
    pub page_zoom: f64,
    pub background: (u8, u8, u8),
    pub muted: bool,
    pub inspectable: bool,
    pub javascript_opens_windows: bool,
    pub fraud_warnings: bool,
}

pub fn remote_view_plan(state: &LayerState) -> RemoteViewPlan {
    let settings = state.view_settings();
    RemoteViewPlan {
        store: remote_store(state.policy()),
        scheme_handlers: Vec::new(),
        message_handlers: Vec::new(),
        user_scripts: Vec::new(),
        javascript: settings.javascript,
        user_agent: (!settings.user_agent.is_empty()).then(|| settings.user_agent.to_owned()),
        page_zoom: f64::from(settings.zoom_percent) / 100.0,
        background: settings.background,
        muted: state.muted(),
        inspectable: false,
        javascript_opens_windows: false,
        fraud_warnings: true,
    }
}

/// A navigation error from WebKit, reduced to the shared categories.
/// Domains are `NSURLErrorDomain` and `WebKitErrorDomain`; anything else
/// is a generic load failure.
pub fn load_error(domain: &str, code: isize) -> LoadError {
    match (domain, code) {
        // NSURLErrorCancelled; WebKit's "frame load interrupted" (a policy
        // cancel, ours or a replaced load).
        ("NSURLErrorDomain", -999) | ("WebKitErrorDomain", 102) => LoadError::Cancelled,
        // Secure connection failed, bad date, untrusted, unknown root, not
        // yet valid, client certificate rejected or required.
        ("NSURLErrorDomain", -1206..=-1200) => LoadError::Tls,
        // Not connected, connection lost, roaming off, call active, data
        // not allowed.
        ("NSURLErrorDomain", -1009 | -1005 | -1018 | -1019 | -1020) => LoadError::Offline,
        ("NSURLErrorDomain", -1011) => LoadError::BadResponse,
        // Cannot show the MIME type or the URL: never a download.
        ("WebKitErrorDomain", 100 | 101) => LoadError::Unsupported,
        _ => LoadError::Other,
    }
}

/// A validated device-pixel viewport as an AppKit frame in points, in the
/// flipped (top-left origin) layer view that holds the Runtime. The
/// Runtime's device scale is the window's backing scale, so dividing by it
/// gives back the Runtime's CSS pixels, which are points at page zoom 1.
pub fn viewport_points(viewport: ViewportPx, backing_scale: f64) -> (f64, f64, f64, f64) {
    let scale = if backing_scale.is_finite() && backing_scale >= 1.0 { backing_scale } else { 1.0 };
    (
        viewport.x as f64 / scale,
        viewport.y as f64 / scale,
        viewport.width as f64 / scale,
        viewport.height as f64 / scale,
    )
}

/// The host of the Tilecast YouTube wrapper origin.
pub const YOUTUBE_WRAPPER_HOST: &str = "org.tilecast.player";

/// Whether a subframe navigation in a YouTube surface was started by the
/// Tilecast wrapper document (the surface's main frame) rather than by a
/// frame inside the embed.
pub fn started_by_wrapper(source_is_main_frame: bool, source_protocol: &str, source_host: &str) -> bool {
    source_is_main_frame && source_protocol == "https" && source_host == YOUTUBE_WRAPPER_HOST
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime_source() -> MessageSource<'static> {
        MessageSource {
            main_frame: true,
            origin_protocol: "tilecast",
            origin_host: "runtime",
            origin_port: 0,
            document_url: Some("tilecast://runtime/index.html"),
            current_view: true,
        }
    }

    #[test]
    fn only_the_top_level_runtime_document_reaches_the_bridge() {
        assert!(is_trusted_bridge_source(&runtime_source()));
        let refused = [
            // A subframe, even one claiming the Runtime origin.
            MessageSource { main_frame: false, ..runtime_source() },
            // A Widget or CAS-backed frame origin.
            MessageSource { origin_protocol: "tcwidget", origin_host: "cap", ..runtime_source() },
            MessageSource { origin_protocol: "tcmedia", origin_host: "cap", ..runtime_source() },
            // Another origin in the top frame, or a lookalike host or port.
            MessageSource { origin_protocol: "https", origin_host: "signs.example.org", ..runtime_source() },
            MessageSource { origin_host: "runtime2", ..runtime_source() },
            MessageSource { origin_port: 8080, ..runtime_source() },
            // The top frame navigated away from the Runtime document.
            MessageSource { document_url: Some("tilecast://runtime/other.html"), ..runtime_source() },
            MessageSource { document_url: Some("about:blank"), ..runtime_source() },
            MessageSource { document_url: None, ..runtime_source() },
            // A replaced web view generation.
            MessageSource { current_view: false, ..runtime_source() },
        ];
        for source in refused {
            assert!(!is_trusted_bridge_source(&source), "{source:?}");
        }
    }

    #[test]
    fn the_trusted_view_navigates_only_to_the_runtime() {
        assert!(allows_navigation(true, "tilecast://runtime/index.html"));
        for (main, url) in [
            (true, "tilecast://runtime/runtime.js"),
            (true, "https://signs.example.org/"),
            (true, "file:///etc/passwd"),
            (true, "http://localhost:8080/index.html"),
            (true, "about:blank"),
            (false, "tilecast://runtime/index.html"),
            (false, "tcwidget://cap/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
            (false, "https://www.youtube.com/embed/x"),
            (false, "about:blank"),
        ] {
            assert!(!allows_navigation(main, url), "{main} {url}");
        }
    }

    #[test]
    fn document_ids_are_fixed_shape() {
        assert!(valid_document_id(&"0a".repeat(16)));
        assert!(!valid_document_id(&"0A".repeat(16)));
        assert!(!valid_document_id("short"));
        assert!(!valid_document_id(&"g".repeat(32)));
    }

    #[test]
    fn host_messages_batch_in_order_within_the_limit() {
        let mut queue = HostQueue::default();
        assert_eq!(queue.take_batch(), None);
        for n in 0..3 {
            queue.push(&serde_json::json!({"type": "presentation", "n": n})).expect("queued");
        }
        let batch: Vec<serde_json::Value> =
            serde_json::from_str(&queue.take_batch().expect("batch")).expect("JSON array");
        assert_eq!(batch.iter().map(|m| m["n"].as_u64().expect("n")).collect::<Vec<_>>(), vec![0, 1, 2]);
        assert!(queue.is_empty());

        // Large messages travel one per batch, still in order.
        let big = "x".repeat(MAX_HOST_MESSAGE_BYTES - 64);
        queue.push(&serde_json::json!({"n": 0, "body": big})).expect("queued");
        queue.push(&serde_json::json!({"n": 1, "body": big})).expect("queued");
        queue.push(&serde_json::json!({"n": 2})).expect("queued");
        for expected in [vec![0], vec![1, 2]] {
            let batch: Vec<serde_json::Value> =
                serde_json::from_str(&queue.take_batch().expect("batch")).expect("JSON array");
            assert!(
                batch.len() == 1 || serde_json::to_string(&batch).expect("encodes").len() <= MAX_HOST_MESSAGE_BYTES
            );
            assert_eq!(batch.iter().map(|m| m["n"].as_u64().expect("n")).collect::<Vec<_>>(), expected);
        }
    }

    #[test]
    fn oversized_and_unpulled_messages_are_refused() {
        let mut queue = HostQueue::default();
        let too_big = serde_json::json!({"body": "x".repeat(MAX_HOST_MESSAGE_BYTES)});
        assert_eq!(queue.push(&too_big), Err(QueueError::TooLarge));
        for _ in 0..MAX_QUEUED_MESSAGES {
            queue.push(&serde_json::json!({})).expect("queued");
        }
        assert_eq!(queue.push(&serde_json::json!({})), Err(QueueError::Full));
        queue.clear();
        assert!(queue.is_empty());
        queue.push(&serde_json::json!({})).expect("room again");
    }

    #[test]
    fn a_new_document_replaces_the_old_pull() {
        let mut document = PullDocument::default();
        assert_eq!(document.accept("a"), Pull::NewDocument);
        assert_eq!(document.accept("a"), Pull::Repeat);
        assert_eq!(document.accept("b"), Pull::NewDocument);
        document.forget();
        assert_eq!(document.accept("b"), Pull::NewDocument);
    }

    fn remote_state(content: serde_json::Value) -> LayerState {
        let spec = webview_host::remote_web::parse_create(&serde_json::json!({
            "surfaceId": "rw-1",
            "content": content,
            "viewport": { "x": 0, "y": 0, "width": 640, "height": 360, "deviceScale": 2 },
            "muted": true,
            "visible": true,
        }))
        .expect("valid spec");
        LayerState::new(spec)
    }

    fn page_content(cookies: &str, dom: bool) -> serde_json::Value {
        serde_json::json!({
            "kind": "page",
            "url": "https://signs.example.org/",
            "allowedHosts": ["signs.example.org"],
            "javascriptEnabled": false,
            "domStorageEnabled": dom,
            "cookiePolicy": cookies,
            "userAgent": "SignageBot/1",
            "zoomPercent": 150,
            "backgroundColor": "#336699",
        })
    }

    #[test]
    fn every_policy_maps_to_a_bounded_store_set() {
        use RemoteDataPolicy::*;
        assert_eq!(remote_store(EphemeralSurface), RemoteStore::PrivatePerSurface);
        assert_eq!(remote_store(IsolatedNoDomStorage), RemoteStore::PrivatePerSurface);
        let shared: Vec<RemoteStore> = RemoteDataPolicy::SHARED.into_iter().map(remote_store).collect();
        assert_eq!(
            shared,
            [
                RemoteStore::Identified(FIRST_PARTY_STORE),
                RemoteStore::Identified(ALL_COOKIES_STORE),
                RemoteStore::Identified(YOUTUBE_STORE)
            ]
        );
        for id in [FIRST_PARTY_STORE, ALL_COOKIES_STORE, YOUTUBE_STORE] {
            assert!(uuid::Uuid::parse_str(id).is_ok(), "{id} is a UUID for dataStoreForIdentifier:");
        }
        let unique: std::collections::HashSet<_> = [FIRST_PARTY_STORE, ALL_COOKIES_STORE, YOUTUBE_STORE].into();
        assert_eq!(unique.len(), 3);
    }

    #[test]
    fn cookie_and_dom_policies_choose_private_or_shared_stores() {
        for (cookies, dom, store) in [
            ("disabled", true, RemoteStore::PrivatePerSurface),
            ("disabled", false, RemoteStore::PrivatePerSurface),
            ("first_party", false, RemoteStore::PrivatePerSurface),
            ("first_and_third_party", false, RemoteStore::PrivatePerSurface),
            ("first_party", true, RemoteStore::Identified(FIRST_PARTY_STORE)),
            ("first_and_third_party", true, RemoteStore::Identified(ALL_COOKIES_STORE)),
        ] {
            let plan = remote_view_plan(&remote_state(page_content(cookies, dom)));
            assert_eq!(plan.store, store, "{cookies} dom={dom}");
        }
        let youtube = remote_view_plan(&remote_state(serde_json::json!({"kind": "youtube", "videoId": "dQw4w9WgXcQ"})));
        assert_eq!(youtube.store, RemoteStore::Identified(YOUTUBE_STORE));
        assert!(youtube.javascript, "the wrapper needs script");
    }

    #[test]
    fn remote_views_get_no_runtime_bridge_schemes_or_bootstrap() {
        for content in [
            page_content("first_and_third_party", true),
            page_content("disabled", false),
            serde_json::json!({"kind": "youtube", "playlistId": "PL0123456789abcdef"}),
        ] {
            let plan = remote_view_plan(&remote_state(content));
            assert!(plan.scheme_handlers.is_empty(), "no tilecast/tcmedia handler");
            assert!(plan.message_handlers.is_empty(), "no native bridge");
            assert!(plan.user_scripts.is_empty(), "no Runtime bootstrap");
            assert!(!plan.inspectable && !plan.javascript_opens_windows && plan.fraud_warnings);
            assert!(plan.muted, "surfaces start muted");
        }
    }

    #[test]
    fn page_settings_reach_the_plan() {
        let plan = remote_view_plan(&remote_state(page_content("first_party", true)));
        assert!(!plan.javascript);
        assert_eq!(plan.user_agent.as_deref(), Some("SignageBot/1"));
        assert!((plan.page_zoom - 1.5).abs() < f64::EPSILON);
        assert_eq!(plan.background, (0x33, 0x66, 0x99));
    }

    #[test]
    fn webkit_errors_map_to_shared_categories() {
        for (domain, code, expected) in [
            ("NSURLErrorDomain", -999, LoadError::Cancelled),
            ("WebKitErrorDomain", 102, LoadError::Cancelled),
            ("NSURLErrorDomain", -1200, LoadError::Tls),
            ("NSURLErrorDomain", -1201, LoadError::Tls),
            ("NSURLErrorDomain", -1202, LoadError::Tls),
            ("NSURLErrorDomain", -1203, LoadError::Tls),
            ("NSURLErrorDomain", -1204, LoadError::Tls),
            ("NSURLErrorDomain", -1206, LoadError::Tls),
            ("NSURLErrorDomain", -1009, LoadError::Offline),
            ("NSURLErrorDomain", -1005, LoadError::Offline),
            ("NSURLErrorDomain", -1011, LoadError::BadResponse),
            ("NSURLErrorDomain", -1003, LoadError::Other),
            ("NSURLErrorDomain", -1001, LoadError::Other),
            ("WebKitErrorDomain", 100, LoadError::Unsupported),
            ("WebKitErrorDomain", 101, LoadError::Unsupported),
            ("NSPOSIXErrorDomain", 1, LoadError::Other),
        ] {
            assert_eq!(load_error(domain, code), expected, "{domain} {code}");
        }
        assert_eq!(
            webview_host::remote_layer::load_failure_code(None, load_error("NSURLErrorDomain", -1202)),
            Some("tls_failure")
        );
    }

    #[test]
    fn viewports_return_to_points() {
        let viewport = ViewportPx { x: -20, y: 40, width: 1280, height: 720 };
        assert_eq!(viewport_points(viewport, 2.0), (-10.0, 20.0, 640.0, 360.0));
        assert_eq!(viewport_points(viewport, 1.0), (-20.0, 40.0, 1280.0, 720.0));
        assert_eq!(viewport_points(viewport, f64::NAN), (-20.0, 40.0, 1280.0, 720.0));
        assert_eq!(viewport_points(viewport, 0.5), (-20.0, 40.0, 1280.0, 720.0));
    }

    #[test]
    fn only_the_wrapper_document_starts_confined_frames() {
        assert!(started_by_wrapper(true, "https", "org.tilecast.player"));
        assert!(!started_by_wrapper(false, "https", "org.tilecast.player"));
        assert!(!started_by_wrapper(true, "https", "www.youtube-nocookie.com"));
        assert!(!started_by_wrapper(true, "http", "org.tilecast.player"));
    }
}
