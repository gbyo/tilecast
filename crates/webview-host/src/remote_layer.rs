//! The engine-neutral half of a host-layer remote web renderer.
//!
//! [`crate::remote_web`] validates what the Runtime asks for and tracks it
//! on the presentation task. This module is the UI-thread side that every
//! WebView engine shares: which browser-data policy a surface gets, what a
//! surface has reported, which navigations it may make, how engine load
//! results become the closed failure vocabulary, what a destroy must
//! release, and what a clear-data request must reach.
//!
//! A platform keeps only engine glue. It holds its views in a
//! [`RemoteLayers`] map, feeds each engine callback to the surface's
//! [`LayerState`], emits the [`LayerEvent`] it gets back, and performs the
//! [`DataRelease`] or [`ClearPlan`] the coordinator decides. No decision
//! here depends on the engine or the platform.

use std::collections::HashMap;

use crate::remote_web::{self, CookiePolicy, SurfaceContent, SurfaceSpec, ViewportPx, YouTubeState};

/// Navigated hosts remembered per surface, bounding the `first_party`
/// cookie-strip fallback enumeration.
pub const MAX_TRACKED_HOSTS: usize = 64;

/// Sets the YouTube wrapper's play command (`data-tc-command`).
pub const YOUTUBE_PLAY_SCRIPT: &str = "document.documentElement.setAttribute('data-tc-command','play')";
/// Sets the YouTube wrapper's pause command.
pub const YOUTUBE_PAUSE_SCRIPT: &str = "document.documentElement.setAttribute('data-tc-command','pause')";
/// Reads the YouTube wrapper's state token (`data-tc-state`).
pub const YOUTUBE_POLL_SCRIPT: &str = "document.documentElement.getAttribute('data-tc-state')||'loading'";

/// The wrapper document URL of a YouTube surface, below the fixed
/// Tilecast-owned origin ([`remote_web::YOUTUBE_BASE_URI`]).
pub fn youtube_wrapper_url(surface_id: &str) -> String {
    format!("{}{surface_id}.html", remote_web::YOUTUBE_BASE_URI)
}

/// The browser-data policy of one surface: where its Website data lives
/// and what must happen to it when the surface ends.
///
/// The wire values are persistence guarantees (`docs/website-content.md`);
/// an engine may be stricter, never looser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RemoteDataPolicy {
    /// `cookiePolicy: disabled`: a private store for this surface only.
    /// Nothing survives the surface.
    EphemeralSurface,
    /// `domStorageEnabled: false` with cookies allowed: a store for this
    /// surface only, discarded with it, so DOM storage cannot survive.
    IsolatedNoDomStorage,
    /// `first_party` with DOM storage: one shared persistent store. Cookies
    /// that do not belong to an allowed host of a still-open first-party
    /// surface are deleted when a surface on it closes.
    PersistentFirstParty,
    /// `first_and_third_party` with DOM storage: one shared persistent
    /// store under the engine's normal rules.
    PersistentAll,
    /// The Tilecast YouTube wrapper: one shared persistent store.
    YouTube,
}

impl RemoteDataPolicy {
    /// The stores that outlive a surface. A clear-data request must reach
    /// each of them whether or not a surface uses it now.
    pub const SHARED: [Self; 3] = [Self::PersistentFirstParty, Self::PersistentAll, Self::YouTube];

    /// Classifies a validated surface. `disabled` cookies win over the DOM
    /// storage flag: both are private, and the private store is stricter.
    pub fn for_content(content: &SurfaceContent) -> Self {
        match content {
            SurfaceContent::Page(page) => match (page.cookie_policy, page.dom_storage_enabled) {
                (CookiePolicy::Disabled, _) => Self::EphemeralSurface,
                (_, false) => Self::IsolatedNoDomStorage,
                (CookiePolicy::FirstParty, true) => Self::PersistentFirstParty,
                (CookiePolicy::All, true) => Self::PersistentAll,
            },
            SurfaceContent::YouTube(_) => Self::YouTube,
        }
    }

    /// Whether the surface needs a store of its own.
    pub fn per_surface(self) -> bool {
        matches!(self, Self::EphemeralSurface | Self::IsolatedNoDomStorage)
    }

    /// Whether the engine may keep the store's data on disk. Only shared
    /// stores persist; a per-surface store never needs to.
    pub fn persistent(self) -> bool {
        !self.per_surface()
    }

    /// What a surface's end must do to its data.
    pub fn on_release(self) -> DataRelease {
        match self {
            Self::EphemeralSurface | Self::IsolatedNoDomStorage => DataRelease::DiscardSurfaceStore,
            Self::PersistentFirstParty => DataRelease::StripForeignCookies,
            Self::PersistentAll | Self::YouTube => DataRelease::Keep,
        }
    }
}

/// The data work a surface's end requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataRelease {
    /// Delete everything in the surface's own store.
    DiscardSurfaceStore,
    /// Delete every cookie of the shared first-party store that does not
    /// belong to [`Released::keep_hosts`].
    StripForeignCookies,
    /// Keep the shared store as it is.
    Keep,
}

/// A remote web event toward the Runtime, before it names its surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayerEvent {
    pub kind: &'static str,
    pub code: Option<&'static str>,
}

impl LayerEvent {
    pub const LOADED: Self = Self { kind: "loaded", code: None };
    pub const STREAM_READY: Self = Self { kind: "stream-ready", code: None };
    pub const MEDIA_ENDED: Self = Self { kind: "media-ended", code: None };
    pub const NAVIGATION_BLOCKED: Self = Self { kind: "navigation-blocked", code: None };

    /// A surface failure with one code of the closed vocabulary.
    pub fn failed(code: &'static str) -> Self {
        debug_assert!(remote_web::is_failure_code(code), "{code} is not a failure code");
        Self { kind: "failed", code: Some(code) }
    }

    pub fn for_surface(self, surface_id: &str) -> crate::bridge::RemoteWebEvent {
        crate::bridge::RemoteWebEvent {
            surface_id: Some(surface_id.to_owned()),
            kind: self.kind.to_owned(),
            code: self.code.map(str::to_owned),
        }
    }
}

/// A host-wide remote web event: the remote engine stopped serving.
pub fn process_terminated() -> crate::bridge::RemoteWebEvent {
    crate::bridge::RemoteWebEvent { surface_id: None, kind: "process-terminated".to_owned(), code: None }
}

/// A host-wide remote web event: the remote engine serves (again).
pub fn recovered() -> crate::bridge::RemoteWebEvent {
    crate::bridge::RemoteWebEvent { surface_id: None, kind: "recovered".to_owned(), code: None }
}

/// An engine's load result, reduced to what the failure vocabulary needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadError {
    /// No engine error (the HTTP status may still fail the load).
    None,
    /// The host cancelled the load itself: a refused navigation (already
    /// reported) or a replaced load. Not a failure.
    Cancelled,
    /// Certificate or TLS trust failure. Never bypassed.
    Tls,
    /// The device has no usable network.
    Offline,
    /// The server answered with a response the engine could not use.
    BadResponse,
    /// The engine cannot show the response (a download, an unknown type).
    Unsupported,
    /// Anything else: DNS, connection, timeout, an aborted load.
    Other,
}

/// Maps a load result to the failure vocabulary. `None` means the load
/// did not fail. An HTTP error status wins over an engine code: a served
/// error page is an HTTP error even when the engine also reports one.
pub fn load_failure_code(http_status: Option<u16>, error: LoadError) -> Option<&'static str> {
    if error == LoadError::Cancelled {
        return None;
    }
    if http_status.is_some_and(|status| status >= 400) {
        return Some("http_error");
    }
    match error {
        LoadError::None | LoadError::Cancelled => None,
        LoadError::Tls => Some("tls_failure"),
        LoadError::Offline => Some("offline"),
        LoadError::BadResponse => Some("http_error"),
        LoadError::Unsupported => Some("unsupported_content"),
        LoadError::Other => Some("load_failed"),
    }
}

/// A validated `#RRGGBB` or `#RRGGBBAA` color as opaque RGB. Surfaces
/// have an opaque backdrop; the alpha byte is ignored. Black for anything
/// the spec validator would refuse.
pub fn background_rgb(color: &str) -> (u8, u8, u8) {
    if !remote_web::valid_color(color) {
        return (0, 0, 0);
    }
    let channel = |index: usize| u8::from_str_radix(&color[index..index + 2], 16).unwrap_or(0);
    (channel(1), channel(3), channel(5))
}

/// What a finished top-level load asks of the engine.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Finished {
    /// The event to report, if this is the surface's first good load.
    pub event: Option<LayerEvent>,
    /// A script to run in the surface after the load (the page's initial
    /// scroll, or the YouTube wrapper's play or pause command).
    pub script: Option<String>,
}

/// What one live surface has reported, and its navigation and data rules.
/// Events fire once per transition; a failed surface stays silent until a
/// reload starts a new attempt.
#[derive(Debug, Clone)]
pub struct LayerState {
    /// The validated spec. The viewport, visible, and muted mirror follow
    /// later commands; content and policy never change.
    spec: SurfaceSpec,
    policy: RemoteDataPolicy,
    loaded: bool,
    stream_ready: bool,
    failed: bool,
    youtube_ended: bool,
    /// Navigated hosts, bounded, for the `first_party` cookie strip.
    hosts: Vec<String>,
}

impl LayerState {
    pub fn new(spec: SurfaceSpec) -> Self {
        let policy = RemoteDataPolicy::for_content(&spec.content);
        Self {
            spec,
            policy,
            loaded: false,
            stream_ready: false,
            failed: false,
            youtube_ended: false,
            hosts: Vec::new(),
        }
    }

    pub fn spec(&self) -> &SurfaceSpec {
        &self.spec
    }

    pub fn surface_id(&self) -> &str {
        &self.spec.surface_id
    }

    pub fn policy(&self) -> RemoteDataPolicy {
        self.policy
    }

    pub fn is_youtube(&self) -> bool {
        matches!(self.spec.content, SurfaceContent::YouTube(_))
    }

    pub fn failed(&self) -> bool {
        self.failed
    }

    pub fn loaded(&self) -> bool {
        self.loaded
    }

    pub fn visible(&self) -> bool {
        self.spec.visible
    }

    pub fn muted(&self) -> bool {
        self.spec.muted
    }

    pub fn viewport(&self) -> ViewportPx {
        self.spec.viewport
    }

    /// The navigated hosts, oldest first.
    pub fn visited_hosts(&self) -> &[String] {
        &self.hosts
    }

    /// The URL of the first top-level navigation: the configured page, or
    /// the Tilecast-owned YouTube wrapper.
    pub fn initial_url(&self) -> String {
        match &self.spec.content {
            SurfaceContent::Page(page) => page.url.clone(),
            SurfaceContent::YouTube(_) => youtube_wrapper_url(&self.spec.surface_id),
        }
    }

    /// The wrapper document of a YouTube surface. `None` for a page, or
    /// when the wrapper cannot be built (the surface must fail).
    pub fn youtube_wrapper(&self) -> Option<String> {
        match &self.spec.content {
            SurfaceContent::YouTube(content) => remote_web::youtube_wrapper(&self.spec.surface_id, content),
            SurfaceContent::Page(_) => None,
        }
    }

    /// Script, user agent (empty is the engine default), zoom percent, and
    /// background color the engine view is configured with.
    pub fn view_settings(&self) -> ViewSettings<'_> {
        match &self.spec.content {
            SurfaceContent::Page(page) => ViewSettings {
                javascript: page.javascript_enabled,
                user_agent: &page.user_agent,
                zoom_percent: page.zoom_percent,
                background: background_rgb(&page.background_color),
            },
            SurfaceContent::YouTube(_) => {
                ViewSettings { javascript: true, user_agent: "", zoom_percent: 100, background: (0, 0, 0) }
            }
        }
    }

    /// Decides a top-level navigation. An allowed one records its host; a
    /// refused one returns the `navigation-blocked` event to report. A
    /// page stays on its allowlist with the configured scheme; a YouTube
    /// surface stays on its own wrapper document.
    pub fn top_level_navigation(&mut self, url: &str) -> Result<(), LayerEvent> {
        let allowed = match &self.spec.content {
            SurfaceContent::Page(page) => remote_web::main_frame_allowed(url, &page.url, &page.allowed_hosts),
            SurfaceContent::YouTube(_) => url == "about:blank" || url == youtube_wrapper_url(&self.spec.surface_id),
        };
        if allowed {
            self.track_host(url);
            Ok(())
        } else {
            Err(LayerEvent::NAVIGATION_BLOCKED)
        }
    }

    /// Decides a subframe navigation. `from_wrapper` is true when the
    /// YouTube wrapper document itself starts the frame: those frames are
    /// confined to the YouTube hosts. Every other frame (and every frame of
    /// a page) follows the network-scheme rule. Allowed frames record
    /// their host for the cookie strip.
    pub fn subframe_navigation(&mut self, url: &str, from_wrapper: bool) -> bool {
        let allowed = if self.is_youtube() && from_wrapper {
            remote_web::youtube_subframe_allowed(url)
        } else {
            remote_web::any_frame_allowed(url)
        };
        if allowed {
            self.track_host(url);
        }
        allowed
    }

    fn track_host(&mut self, url: &str) {
        let Some(host) = remote_web::url_host(url) else { return };
        if self.hosts.contains(&host) {
            return;
        }
        if self.hosts.len() >= MAX_TRACKED_HOSTS {
            self.hosts.remove(0);
        }
        self.hosts.push(host);
    }

    /// The first content of a page is on screen: the view is the pixels
    /// (host-layer), so the first content load is the first frame. YouTube
    /// surfaces wait for the player instead ([`Self::youtube_state`]).
    pub fn content_loading(&mut self) -> Option<LayerEvent> {
        if self.is_youtube() || self.failed || self.stream_ready {
            return None;
        }
        self.stream_ready = true;
        Some(LayerEvent::STREAM_READY)
    }

    /// A top-level load ended. Returns the failure to report once, or what
    /// a successful first load asks for.
    pub fn load_finished(&mut self, http_status: Option<u16>, error: LoadError) -> Finished {
        if let Some(code) = load_failure_code(http_status, error) {
            return Finished { event: self.fail(code), script: None };
        }
        if error == LoadError::Cancelled || self.failed || self.loaded {
            return Finished::default();
        }
        match &self.spec.content {
            SurfaceContent::Page(page) => {
                self.loaded = true;
                let script = (page.javascript_enabled && (page.scroll_x != 0 || page.scroll_y != 0))
                    .then(|| format!("window.scrollTo({},{})", page.scroll_x, page.scroll_y));
                Finished { event: Some(LayerEvent::LOADED), script }
            }
            // The wrapper is not the video: the poll owns `loaded`. The
            // wrapper starts paused; visibility decides play.
            SurfaceContent::YouTube(_) => Finished { event: None, script: Some(self.youtube_command().to_owned()) },
        }
    }

    /// One YouTube wrapper poll answer (the raw `data-tc-state` token).
    /// Reports `loaded` when the player is ready, `stream-ready` at first
    /// playback, `media-ended` once, and `failed` (`youtube_error`). An
    /// unknown token is ignored.
    pub fn youtube_state(&mut self, token: &str) -> Option<LayerEvent> {
        if !self.is_youtube() || self.failed {
            return None;
        }
        match remote_web::parse_youtube_state(token)? {
            YouTubeState::Loading => None,
            state @ (YouTubeState::Ready | YouTubeState::Playing | YouTubeState::Buffering | YouTubeState::Paused) => {
                if !self.loaded {
                    self.loaded = true;
                    Some(LayerEvent::LOADED)
                } else if state == YouTubeState::Playing && !self.stream_ready {
                    self.stream_ready = true;
                    Some(LayerEvent::STREAM_READY)
                } else {
                    None
                }
            }
            YouTubeState::Ended => {
                if self.youtube_ended {
                    None
                } else {
                    self.youtube_ended = true;
                    Some(LayerEvent::MEDIA_ENDED)
                }
            }
            YouTubeState::Error(_) => self.fail("youtube_error"),
        }
    }

    /// Fails the surface once with `code`.
    pub fn fail(&mut self, code: &'static str) -> Option<LayerEvent> {
        if self.failed {
            return None;
        }
        self.failed = true;
        Some(LayerEvent::failed(code))
    }

    /// The surface's own web content process ended. The view cannot serve;
    /// the Runtime's failure policy decides what replaces it.
    pub fn content_process_ended(&mut self) -> Option<LayerEvent> {
        self.fail("renderer_crash")
    }

    /// A new load attempt: the next completion reports like the first.
    pub fn reload(&mut self) {
        self.loaded = false;
        self.stream_ready = false;
        self.failed = false;
        self.youtube_ended = false;
    }

    pub fn set_viewport(&mut self, viewport: ViewportPx) {
        self.spec.viewport = viewport;
    }

    /// Records visibility and returns the YouTube command to run, if any.
    pub fn set_visible(&mut self, visible: bool) -> Option<&'static str> {
        self.spec.visible = visible;
        self.is_youtube().then(|| self.youtube_command())
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.spec.muted = muted;
    }

    fn youtube_command(&self) -> &'static str {
        if self.spec.visible { YOUTUBE_PLAY_SCRIPT } else { YOUTUBE_PAUSE_SCRIPT }
    }

    /// The cookie hosts this surface protects on the shared first-party
    /// store: its allowlist when it uses that store.
    pub fn first_party_hosts(&self) -> &[String] {
        match &self.spec.content {
            SurfaceContent::Page(page) if self.policy == RemoteDataPolicy::PersistentFirstParty => &page.allowed_hosts,
            _ => &[],
        }
    }
}

/// How the engine view is configured for a surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewSettings<'a> {
    pub javascript: bool,
    pub user_agent: &'a str,
    pub zoom_percent: u32,
    pub background: (u8, u8, u8),
}

/// One live surface: its state and the platform's engine view.
#[derive(Debug)]
pub struct Layer<V> {
    pub state: LayerState,
    pub view: V,
}

/// A surface removed from the map, with the data work its end requires.
#[derive(Debug)]
pub struct Released<V> {
    pub surface_id: String,
    pub view: V,
    pub policy: RemoteDataPolicy,
    pub release: DataRelease,
    /// For [`DataRelease::StripForeignCookies`]: the allowed hosts of every
    /// first-party surface still open or released together with this one.
    /// The first-party store is shared, so a strip must not delete their
    /// cookies.
    pub keep_hosts: Vec<String>,
    /// The hosts the surface navigated to, a fallback cookie enumeration
    /// for engines that cannot list a whole store.
    pub visited_hosts: Vec<String>,
}

/// What a clear-data request must reach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClearPlan {
    /// Live surfaces whose stores to clear through their views: every
    /// per-surface store and one surface for each shared store in use.
    pub live: Vec<String>,
    /// Shared stores with no live surface; the engine clears them without
    /// a surface view.
    pub idle: Vec<RemoteDataPolicy>,
}

/// The UI thread's live remote surfaces, bounded like the presentation
/// task's [`remote_web::SurfaceTracker`]. `V` is the engine's view handle.
#[derive(Debug)]
pub struct RemoteLayers<V> {
    layers: HashMap<String, Layer<V>>,
    /// Creation order, which is also stacking order: a later surface sits
    /// above an earlier one.
    order: Vec<String>,
}

impl<V> Default for RemoteLayers<V> {
    fn default() -> Self {
        Self { layers: HashMap::new(), order: Vec::new() }
    }
}

impl<V> RemoteLayers<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.layers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.layers.is_empty()
    }

    pub fn contains(&self, surface_id: &str) -> bool {
        self.layers.contains_key(surface_id)
    }

    pub fn get(&self, surface_id: &str) -> Option<&Layer<V>> {
        self.layers.get(surface_id)
    }

    pub fn get_mut(&mut self, surface_id: &str) -> Option<&mut Layer<V>> {
        self.layers.get_mut(surface_id)
    }

    /// Live surfaces in stacking order, bottom first.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &Layer<V>)> {
        self.order.iter().filter_map(|id| self.layers.get(id).map(|layer| (id.as_str(), layer)))
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = (&String, &mut Layer<V>)> {
        self.layers.iter_mut()
    }

    /// Whether any live YouTube surface matches `wired` (the engine view
    /// exists), so the platform runs the wrapper poll only while needed.
    pub fn has_youtube(&self, wired: impl Fn(&V) -> bool) -> bool {
        self.layers.values().any(|layer| layer.state.is_youtube() && wired(&layer.view))
    }

    /// Admits a surface. The presentation task already refused duplicates
    /// and the bound; this side keeps the same rules so a stale command
    /// cannot leak a view.
    pub fn insert(&mut self, spec: SurfaceSpec, view: V) -> Result<&mut Layer<V>, &'static str> {
        if self.layers.contains_key(&spec.surface_id) {
            return Err("invalid_request");
        }
        if self.layers.len() >= remote_web::MAX_SURFACES {
            return Err(remote_web::LIMIT_EXCEEDED);
        }
        let surface_id = spec.surface_id.clone();
        self.order.push(surface_id.clone());
        Ok(self.layers.entry(surface_id).or_insert(Layer { state: LayerState::new(spec), view }))
    }

    fn open_first_party_hosts(&self) -> Vec<String> {
        self.layers.values().flat_map(|layer| layer.state.first_party_hosts().iter().cloned()).collect()
    }

    fn release(layer: Layer<V>, surface_id: String, keep_hosts: Vec<String>) -> Released<V> {
        let policy = layer.state.policy();
        Released {
            surface_id,
            view: layer.view,
            policy,
            release: policy.on_release(),
            keep_hosts: if policy.on_release() == DataRelease::StripForeignCookies { keep_hosts } else { Vec::new() },
            visited_hosts: layer.state.hosts,
        }
    }

    /// Removes one surface, with the data work its end requires.
    pub fn remove(&mut self, surface_id: &str) -> Option<Released<V>> {
        let layer = self.layers.remove(surface_id)?;
        self.order.retain(|id| id != surface_id);
        let mut keep_hosts = self.open_first_party_hosts();
        keep_hosts.extend(layer.state.first_party_hosts().iter().cloned());
        Some(Self::release(layer, surface_id.to_owned(), keep_hosts))
    }

    /// Removes every surface (the remote engine or the trusted renderer
    /// ended). Each still gets its data release; first-party strips keep
    /// the hosts of every surface released together.
    pub fn drain(&mut self) -> Vec<Released<V>> {
        let keep_hosts = self.open_first_party_hosts();
        let order = std::mem::take(&mut self.order);
        order
            .into_iter()
            .filter_map(|id| {
                let layer = self.layers.remove(&id)?;
                Some(Self::release(layer, id, keep_hosts.clone()))
            })
            .collect()
    }

    /// The stores a clear-data request must reach. `wired` says whether a
    /// surface's engine view can clear its store now.
    pub fn clear_plan(&self, wired: impl Fn(&V) -> bool) -> ClearPlan {
        let mut live = Vec::new();
        let mut covered = Vec::new();
        for (id, layer) in self.iter() {
            if !wired(&layer.view) {
                continue;
            }
            let policy = layer.state.policy();
            if policy.per_surface() || !covered.contains(&policy) {
                covered.push(policy);
                live.push(id.to_owned());
            }
        }
        let idle = RemoteDataPolicy::SHARED.into_iter().filter(|policy| !covered.contains(policy)).collect();
        ClearPlan { live, idle }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_web::parse_create;

    fn page(surface_id: &str, cookies: &str, dom: bool, hosts: &[&str]) -> SurfaceSpec {
        parse_create(&serde_json::json!({
            "surfaceId": surface_id,
            "content": {
                "kind": "page",
                "url": format!("https://{}/start", hosts[0]),
                "allowedHosts": hosts,
                "javascriptEnabled": true,
                "domStorageEnabled": dom,
                "cookiePolicy": cookies,
                "scrollX": 0,
                "scrollY": 40,
                "backgroundColor": "#102030",
            },
            "viewport": { "x": 0, "y": 0, "width": 640, "height": 360, "deviceScale": 1 },
            "muted": true,
            "visible": true,
        }))
        .expect("valid page spec")
    }

    fn youtube(surface_id: &str) -> SurfaceSpec {
        parse_create(&serde_json::json!({
            "surfaceId": surface_id,
            "content": { "kind": "youtube", "videoId": "dQw4w9WgXcQ" },
            "viewport": { "x": 0, "y": 0, "width": 640, "height": 360, "deviceScale": 1 },
            "visible": false,
        }))
        .expect("valid youtube spec")
    }

    #[test]
    fn every_cookie_and_dom_combination_has_one_policy() {
        use RemoteDataPolicy::*;
        for (cookies, dom, expected) in [
            ("disabled", true, EphemeralSurface),
            ("disabled", false, EphemeralSurface),
            ("first_party", false, IsolatedNoDomStorage),
            ("first_and_third_party", false, IsolatedNoDomStorage),
            ("first_party", true, PersistentFirstParty),
            ("first_and_third_party", true, PersistentAll),
        ] {
            let spec = page("rw-1", cookies, dom, &["example.com"]);
            assert_eq!(RemoteDataPolicy::for_content(&spec.content), expected, "{cookies} dom={dom}");
        }
        assert_eq!(RemoteDataPolicy::for_content(&youtube("rw-2").content), YouTube);
    }

    #[test]
    fn private_policies_discard_and_shared_ones_persist() {
        use RemoteDataPolicy::*;
        for policy in [EphemeralSurface, IsolatedNoDomStorage] {
            assert!(policy.per_surface() && !policy.persistent());
            assert_eq!(policy.on_release(), DataRelease::DiscardSurfaceStore);
            assert!(!RemoteDataPolicy::SHARED.contains(&policy));
        }
        assert_eq!(PersistentFirstParty.on_release(), DataRelease::StripForeignCookies);
        assert_eq!(PersistentAll.on_release(), DataRelease::Keep);
        assert_eq!(YouTube.on_release(), DataRelease::Keep);
        for policy in RemoteDataPolicy::SHARED {
            assert!(policy.persistent() && !policy.per_surface());
        }
    }

    #[test]
    fn load_results_map_to_the_closed_vocabulary() {
        assert_eq!(load_failure_code(Some(200), LoadError::None), None);
        assert_eq!(load_failure_code(None, LoadError::Cancelled), None);
        assert_eq!(load_failure_code(Some(404), LoadError::Cancelled), None);
        assert_eq!(load_failure_code(Some(503), LoadError::Other), Some("http_error"));
        assert_eq!(load_failure_code(Some(500), LoadError::Tls), Some("http_error"));
        assert_eq!(load_failure_code(None, LoadError::Tls), Some("tls_failure"));
        assert_eq!(load_failure_code(None, LoadError::Offline), Some("offline"));
        assert_eq!(load_failure_code(None, LoadError::BadResponse), Some("http_error"));
        assert_eq!(load_failure_code(None, LoadError::Unsupported), Some("unsupported_content"));
        assert_eq!(load_failure_code(None, LoadError::Other), Some("load_failed"));
        for error in
            [LoadError::Tls, LoadError::Offline, LoadError::BadResponse, LoadError::Unsupported, LoadError::Other]
        {
            assert!(remote_web::is_failure_code(load_failure_code(None, error).expect("fails")));
        }
    }

    #[test]
    fn page_navigation_stays_on_the_allowlist_and_tracks_hosts() {
        let mut state = LayerState::new(page("rw-1", "first_party", true, &["example.com", "cdn.example.org"]));
        assert_eq!(state.initial_url(), "https://example.com/start");
        assert!(state.top_level_navigation("https://example.com/next").is_ok());
        assert!(state.top_level_navigation("https://cdn.example.org/").is_ok());
        for refused in [
            "https://evil.example/",
            "https://example.com.evil.example/",
            "http://example.com/",
            "https://user:pw@example.com/",
            "https://example.com:8443/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hi",
            "mailto:someone@example.com",
            "tel:+15555550100",
            "macappstore://apps.apple.com/app/id1",
            "itms-apps://apps.apple.com/app/id1",
            "tilecast://runtime/index.html",
            "tcmedia://cap/abc",
        ] {
            assert_eq!(state.top_level_navigation(refused), Err(LayerEvent::NAVIGATION_BLOCKED), "{refused}");
        }
        assert_eq!(state.visited_hosts(), ["example.com", "cdn.example.org"]);
        // Third-party frames load (the allowlist is not a request firewall)
        // but never local or custom schemes.
        assert!(state.subframe_navigation("https://ads.tracker.example/frame", false));
        assert!(state.subframe_navigation("about:blank", false));
        assert!(!state.subframe_navigation("file:///etc/passwd", false));
        assert!(!state.subframe_navigation("tilecast://runtime/index.html", false));
        assert!(!state.subframe_navigation("mailto:a@example.com", false));
        assert!(state.visited_hosts().contains(&"ads.tracker.example".to_owned()));
    }

    #[test]
    fn tracked_hosts_are_bounded_and_unique() {
        let mut state = LayerState::new(page("rw-1", "first_party", true, &["example.com"]));
        for index in 0..(MAX_TRACKED_HOSTS + 5) {
            state.subframe_navigation(&format!("https://h{index}.example/"), false);
            state.subframe_navigation(&format!("https://h{index}.example/again"), false);
        }
        assert_eq!(state.visited_hosts().len(), MAX_TRACKED_HOSTS);
        assert_eq!(state.visited_hosts()[0], "h5.example");
    }

    #[test]
    fn youtube_navigation_stays_on_its_wrapper() {
        let mut state = LayerState::new(youtube("rw-7"));
        assert_eq!(state.initial_url(), "https://org.tilecast.player/rw-7.html");
        assert!(state.top_level_navigation("https://org.tilecast.player/rw-7.html").is_ok());
        assert!(state.top_level_navigation("about:blank").is_ok());
        assert!(state.top_level_navigation("https://org.tilecast.player/rw-8.html").is_err());
        assert!(state.top_level_navigation("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_err());
        // The wrapper's own frames are the embed hosts only; frames inside
        // the embed follow the general scheme rule.
        assert!(state.subframe_navigation("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", true));
        assert!(!state.subframe_navigation("https://evil.example/", true));
        assert!(state.subframe_navigation("https://accounts.google.com/frame", false));
        assert!(!state.subframe_navigation("file:///x", false));
        assert!(state.youtube_wrapper().expect("builds").contains("dQw4w9WgXcQ"));
    }

    #[test]
    fn a_page_reports_stream_ready_then_loaded_once() {
        let mut state = LayerState::new(page("rw-1", "disabled", true, &["example.com"]));
        assert_eq!(state.content_loading(), Some(LayerEvent::STREAM_READY));
        assert_eq!(state.content_loading(), None);
        let finished = state.load_finished(Some(200), LoadError::None);
        assert_eq!(finished.event, Some(LayerEvent::LOADED));
        assert_eq!(finished.script.as_deref(), Some("window.scrollTo(0,40)"));
        assert_eq!(state.load_finished(Some(200), LoadError::None), Finished::default());
        // A reload starts a new attempt that reports again.
        state.reload();
        assert_eq!(state.content_loading(), Some(LayerEvent::STREAM_READY));
        assert_eq!(state.load_finished(None, LoadError::None).event, Some(LayerEvent::LOADED));
    }

    #[test]
    fn failures_report_once_and_silence_the_surface() {
        let mut state = LayerState::new(page("rw-1", "disabled", true, &["example.com"]));
        assert_eq!(state.load_finished(None, LoadError::Cancelled), Finished::default());
        assert!(!state.failed());
        assert_eq!(state.load_finished(None, LoadError::Tls).event, Some(LayerEvent::failed("tls_failure")));
        assert_eq!(state.load_finished(Some(500), LoadError::None).event, None);
        assert_eq!(state.content_loading(), None);
        assert_eq!(state.content_process_ended(), None);
        let mut crashed = LayerState::new(page("rw-2", "disabled", true, &["example.com"]));
        assert_eq!(crashed.content_process_ended(), Some(LayerEvent::failed("renderer_crash")));
        assert_eq!(crashed.load_finished(None, LoadError::None), Finished::default());
    }

    #[test]
    fn youtube_states_become_events_once() {
        let mut state = LayerState::new(youtube("rw-7"));
        assert_eq!(state.content_loading(), None, "the wrapper is not the video");
        let finished = state.load_finished(None, LoadError::None);
        assert_eq!(finished.event, None);
        assert_eq!(finished.script.as_deref(), Some(YOUTUBE_PAUSE_SCRIPT), "hidden surfaces start paused");
        assert_eq!(state.youtube_state("loading"), None);
        assert_eq!(state.youtube_state("bogus'); x"), None);
        assert_eq!(state.youtube_state("ready"), Some(LayerEvent::LOADED));
        assert_eq!(state.youtube_state("paused"), None);
        assert_eq!(state.set_visible(true), Some(YOUTUBE_PLAY_SCRIPT));
        assert_eq!(state.youtube_state("playing"), Some(LayerEvent::STREAM_READY));
        assert_eq!(state.youtube_state("playing"), None);
        assert_eq!(state.youtube_state("ended"), Some(LayerEvent::MEDIA_ENDED));
        assert_eq!(state.youtube_state("ended"), None);
        assert_eq!(state.youtube_state("error:150"), Some(LayerEvent::failed("youtube_error")));
        assert_eq!(state.youtube_state("playing"), None);
        let mut page_state = LayerState::new(page("rw-1", "disabled", true, &["example.com"]));
        assert_eq!(page_state.youtube_state("ready"), None);
        assert_eq!(page_state.set_visible(false), None);
    }

    #[test]
    fn view_settings_follow_the_spec() {
        let state = LayerState::new(page("rw-1", "disabled", true, &["example.com"]));
        let settings = state.view_settings();
        assert!(settings.javascript);
        assert_eq!(settings.zoom_percent, 100);
        assert_eq!(settings.background, (0x10, 0x20, 0x30));
        assert_eq!(LayerState::new(youtube("rw-2")).view_settings().background, (0, 0, 0));
        assert_eq!(background_rgb("#ff8000cc"), (0xff, 0x80, 0x00));
        assert_eq!(background_rgb("red"), (0, 0, 0));
    }

    #[test]
    fn mirrors_follow_commands() {
        let mut state = LayerState::new(page("rw-1", "disabled", true, &["example.com"]));
        let moved = ViewportPx { x: -10, y: 20, width: 320, height: 180 };
        state.set_viewport(moved);
        state.set_muted(false);
        assert_eq!(state.set_visible(false), None);
        assert_eq!((state.viewport(), state.muted(), state.visible()), (moved, false, false));
    }

    #[test]
    fn the_coordinator_bounds_orders_and_releases_surfaces() {
        let mut layers: RemoteLayers<u32> = RemoteLayers::new();
        layers.insert(page("rw-a", "first_party", true, &["a.example"]), 1).expect("admits");
        layers.insert(page("rw-b", "first_party", true, &["b.example"]), 2).expect("admits");
        layers.insert(page("rw-c", "disabled", true, &["c.example"]), 3).expect("admits");
        assert_eq!(layers.insert(page("rw-a", "disabled", true, &["a.example"]), 9).err(), Some("invalid_request"));
        layers.insert(youtube("rw-y"), 4).expect("admits");
        assert_eq!(
            layers.insert(page("rw-e", "disabled", true, &["e.example"]), 5).err(),
            Some(remote_web::LIMIT_EXCEEDED)
        );
        assert_eq!(layers.iter().map(|(id, _)| id).collect::<Vec<_>>(), ["rw-a", "rw-b", "rw-c", "rw-y"]);
        assert!(layers.has_youtube(|_| true));
        assert!(!layers.has_youtube(|view| *view != 4));

        // A first-party release keeps the other open first-party surface's
        // cookies on the shared store.
        let released = layers.remove("rw-a").expect("removes");
        assert_eq!((released.view, released.release), (1, DataRelease::StripForeignCookies));
        let mut keep = released.keep_hosts.clone();
        keep.sort();
        assert_eq!(keep, ["a.example", "b.example"]);
        assert_eq!(released.visited_hosts, Vec::<String>::new());
        assert!(layers.remove("rw-a").is_none());

        let ephemeral = layers.remove("rw-c").expect("removes");
        assert_eq!(ephemeral.release, DataRelease::DiscardSurfaceStore);
        assert!(ephemeral.keep_hosts.is_empty());

        let drained = layers.drain();
        assert_eq!(drained.iter().map(|released| released.view).collect::<Vec<_>>(), [2, 4]);
        assert_eq!(drained[0].keep_hosts, ["b.example"]);
        assert_eq!(drained[1].release, DataRelease::Keep);
        assert!(layers.is_empty() && layers.iter().next().is_none());
        // A freed slot admits again.
        layers.insert(page("rw-a", "disabled", true, &["a.example"]), 6).expect("admits");
    }

    #[test]
    fn clear_plans_reach_every_store_once() {
        let mut layers: RemoteLayers<bool> = RemoteLayers::new();
        let empty = layers.clear_plan(|_| true);
        assert!(empty.live.is_empty());
        assert_eq!(empty.idle, RemoteDataPolicy::SHARED);

        layers.insert(page("rw-a", "first_party", true, &["a.example"]), true).expect("admits");
        layers.insert(page("rw-b", "first_party", true, &["b.example"]), true).expect("admits");
        layers.insert(page("rw-c", "disabled", true, &["c.example"]), true).expect("admits");
        layers.insert(page("rw-d", "first_party", false, &["d.example"]), false).expect("admits");
        let plan = layers.clear_plan(|wired| *wired);
        // One view for the shared first-party store, every wired private
        // store, and the shared stores no view reaches.
        assert_eq!(plan.live, ["rw-a", "rw-c"]);
        assert_eq!(plan.idle, [RemoteDataPolicy::PersistentAll, RemoteDataPolicy::YouTube]);
    }
}
