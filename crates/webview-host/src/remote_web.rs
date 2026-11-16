//! Remote Website/YouTube host layers (`remoteWeb: "host-view"`).
//!
//! The shared Runtime owns remote-web policy and lifecycle orchestration;
//! this module owns the host side of the closed contract
//! (`packages/player-runtime/src/host/contract.ts`): validated surface
//! specs, the bounded surface tracker, the navigation policy, the
//! Tilecast-owned YouTube wrapper, and the browser-data boundary.
//!
//! The bounds and the validation rules are the Edge remote-web protocol's
//! (`apps/edge/web-renderer-wpe/src/rw-protocol.*`); the host-view call
//! shape follows Android (`RemoteWebCallHandler`), which proves it. The
//! render target is always `host-layer`: each surface is a child WebView2
//! in the separate remote environment (see `webview.rs`), never a page of
//! the trusted Runtime.
//!
//! Browser data follows the one cross-engine contract: the wire values are
//! persistence guarantees, and an engine may enforce stronger behavior.
//! `disabled` keeps no Website state past the surface lifecycle (Windows
//! uses an ephemeral profile per surface); `first_party` keeps only
//! cookies that belong to the surface's allowed hosts (Windows strips the
//! rest when the surface is released, because WebView2 has no per-view
//! third-party switch); `first_and_third_party` keeps browser cookies by
//! the normal profile rules. `domStorageEnabled: false` requires that DOM
//! storage cannot survive the surface lifecycle.

use std::collections::HashMap;

/// Live remote surfaces, warm ones included. The Edge protocol's bound.
pub const MAX_SURFACES: usize = 4;
/// A surface's smallest and largest edge, in device pixels.
pub const MIN_EDGE_PX: i64 = 16;
pub const MAX_EDGE_PX: i64 = 3840;
/// A surface's largest area, in device pixels.
pub const MAX_PIXELS: i64 = 8_294_400;
/// How far offscreen a surface origin may sit, in device pixels.
pub const MAX_ORIGIN_PX: i64 = 100_000;
/// The longest configured page URL.
pub const MAX_URL: usize = 2048;
/// Allowed hosts per page surface.
pub const MAX_HOSTS: usize = 25;
/// One allowed host.
pub const MAX_HOST: usize = 253;
/// A page's custom user agent; empty means the engine default.
pub const MAX_USER_AGENT: usize = 256;
/// A page's initial scroll offset.
pub const MAX_SCROLL: i64 = 100_000;
/// The longest `create` the UI thread waits for.
pub const CREATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// How often the UI thread polls YouTube wrapper state.
pub const YOUTUBE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// Why a `create` was refused. Validation failures name their field (as
/// Android does); capacity and availability use the Edge protocol's codes.
pub const BAD_SURFACE_ID: &str = "bad_surface_id";
pub const BAD_CONTENT: &str = "bad_content";
pub const BAD_VIEWPORT: &str = "bad_viewport";
pub const LIMIT_EXCEEDED: &str = "limit_exceeded";
pub const UNAVAILABLE: &str = "unavailable";
pub const UNKNOWN_SURFACE: &str = "unknown_surface";

/// The stable failure codes, the Edge protocol's closed set.
pub const FAILURE_CODES: &[&str] = &[
    UNAVAILABLE,
    LIMIT_EXCEEDED,
    "invalid_request",
    "load_failed",
    "http_error",
    "tls_failure",
    "offline",
    "blocked_navigation",
    "renderer_crash",
    "helper_terminated",
    "youtube_error",
    "stream_failed",
    "unsupported_content",
];

pub fn is_failure_code(code: &str) -> bool {
    FAILURE_CODES.contains(&code)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookiePolicy {
    Disabled,
    FirstParty,
    All,
}

impl CookiePolicy {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "disabled" => Some(Self::Disabled),
            "first_party" => Some(Self::FirstParty),
            "first_and_third_party" => Some(Self::All),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageContent {
    pub url: String,
    pub allowed_hosts: Vec<String>,
    pub javascript_enabled: bool,
    pub dom_storage_enabled: bool,
    pub cookie_policy: CookiePolicy,
    pub user_agent: String,
    pub zoom_percent: u32,
    pub scroll_x: i64,
    pub scroll_y: i64,
    pub background_color: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YouTubeContent {
    pub video_id: Option<String>,
    pub playlist_id: Option<String>,
    pub start_seconds: u32,
    pub end_seconds: Option<u32>,
    pub loop_playback: bool,
    pub author_muted: bool,
    pub volume: u32,
    pub captions: bool,
    pub caption_language: String,
    pub controls: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SurfaceContent {
    Page(PageContent),
    YouTube(YouTubeContent),
}

/// A validated surface viewport in device pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ViewportPx {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

/// A validated `create` spec.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfaceSpec {
    pub surface_id: String,
    pub content: SurfaceContent,
    pub viewport: ViewportPx,
    pub muted: bool,
    pub visible: bool,
}

/// `true` for `[a-z0-9-]{1,48}`.
pub fn valid_surface_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 48
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn printable_ascii(value: &str, max: usize) -> bool {
    value.len() <= max && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// Lowercases and strips one trailing dot; `None` when not a host. DNS
/// names and IPv4 literals; IPv6 literals are not allowlist entries.
pub fn normalize_host(value: &str) -> Option<String> {
    let trimmed = value.strip_suffix('.').unwrap_or(value);
    if trimmed.is_empty() || trimmed.len() > MAX_HOST {
        return None;
    }
    if !trimmed.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
    }) {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

pub fn valid_url(value: &str) -> bool {
    if !printable_ascii(value, MAX_URL) || value.contains(' ') {
        return false;
    }
    let Some(rest) = value.strip_prefix("https://").or_else(|| value.strip_prefix("http://")) else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let Some(host) = authority.rsplit('@').next() else {
        return false;
    };
    // No user information; IPv6 literals are refused with the allowlist.
    !authority.contains('@') && !host.is_empty() && normalize_host(host.split(':').next().unwrap_or("")).is_some()
}

/// `true` for a YouTube video or playlist id: 6 to 128 URL-safe chars.
pub fn valid_youtube_id(value: &str) -> bool {
    (6..=128).contains(&value.len())
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// `true` for `^[A-Za-z]{2,3}(-[A-Za-z]{2})?$`, the server's caption
/// language rule.
pub fn valid_language_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    let letters = bytes.iter().take_while(|byte| byte.is_ascii_alphabetic()).count();
    if !(2..=3).contains(&letters) {
        return false;
    }
    if letters == bytes.len() {
        return true;
    }
    bytes.len() == letters + 3
        && bytes[letters] == b'-'
        && bytes[letters + 1].is_ascii_alphabetic()
        && bytes[letters + 2].is_ascii_alphabetic()
}

/// `true` for `#RRGGBB` or `#RRGGBBAA`.
pub fn valid_color(value: &str) -> bool {
    (value.len() == 7 || value.len() == 9)
        && value.as_bytes()[0] == b'#'
        && value.bytes().skip(1).all(|byte| byte.is_ascii_hexdigit())
}

fn number(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

/// CSS pixels plus the device scale into integer device pixels. Negative
/// origins are legal (the runtime clips partially offscreen surfaces);
/// edges follow the Edge protocol's bounds.
pub fn map_viewport(viewport: &serde_json::Value) -> Option<ViewportPx> {
    let object = viewport.as_object()?;
    let (Some(x), Some(y), Some(width), Some(height), Some(scale)) = (
        number(object.get("x")?),
        number(object.get("y")?),
        number(object.get("width")?),
        number(object.get("height")?),
        number(object.get("deviceScale")?),
    ) else {
        return None;
    };
    if !(1.0..=4.0).contains(&scale) || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let (x, y) = ((x * scale).round() as i64, (y * scale).round() as i64);
    let (width, height) = ((width * scale).round() as i64, (height * scale).round() as i64);
    if x.abs() > MAX_ORIGIN_PX || y.abs() > MAX_ORIGIN_PX {
        return None;
    }
    if !(MIN_EDGE_PX..=MAX_EDGE_PX).contains(&width)
        || !(MIN_EDGE_PX..=MAX_EDGE_PX).contains(&height)
        || width.saturating_mul(height) > MAX_PIXELS
    {
        return None;
    }
    Some(ViewportPx { x, y, width, height })
}

fn text(content: &serde_json::Map<String, serde_json::Value>, name: &str) -> Option<String> {
    content.get(name)?.as_str().map(str::to_owned)
}

fn flag(content: &serde_json::Map<String, serde_json::Value>, name: &str, default: bool) -> Option<bool> {
    match content.get(name) {
        None => Some(default),
        Some(value) => value.as_bool(),
    }
}

fn integer(content: &serde_json::Map<String, serde_json::Value>, name: &str, default: i64) -> Option<i64> {
    match content.get(name) {
        None => Some(default),
        Some(value) => value.as_i64(),
    }
}

fn parse_page(content: &serde_json::Map<String, serde_json::Value>) -> Option<PageContent> {
    let url = text(content, "url")?;
    if !valid_url(&url) {
        return None;
    }
    let hosts = content.get("allowedHosts")?.as_array()?;
    if hosts.is_empty() || hosts.len() > MAX_HOSTS {
        return None;
    }
    let mut allowed_hosts = Vec::with_capacity(hosts.len());
    for host in hosts {
        allowed_hosts.push(normalize_host(host.as_str()?)?);
    }
    let cookie_policy = CookiePolicy::parse(text(content, "cookiePolicy")?.as_str())?;
    let user_agent = text(content, "userAgent").unwrap_or_default();
    if !printable_ascii(&user_agent, MAX_USER_AGENT) {
        return None;
    }
    let zoom_percent = integer(content, "zoomPercent", 100)?;
    if !(25..=500).contains(&zoom_percent) {
        return None;
    }
    let (scroll_x, scroll_y) = (integer(content, "scrollX", 0)?, integer(content, "scrollY", 0)?);
    if !(0..=MAX_SCROLL).contains(&scroll_x) || !(0..=MAX_SCROLL).contains(&scroll_y) {
        return None;
    }
    let background_color = text(content, "backgroundColor").unwrap_or_else(|| "#000000".to_string());
    if !valid_color(&background_color) {
        return None;
    }
    Some(PageContent {
        url,
        allowed_hosts,
        javascript_enabled: flag(content, "javascriptEnabled", false)?,
        dom_storage_enabled: flag(content, "domStorageEnabled", false)?,
        cookie_policy,
        user_agent,
        zoom_percent: zoom_percent as u32,
        scroll_x,
        scroll_y,
        background_color,
    })
}

fn parse_youtube(content: &serde_json::Map<String, serde_json::Value>) -> Option<YouTubeContent> {
    let token = |name: &str| match content.get(name) {
        None | Some(serde_json::Value::Null) => Some(None),
        Some(value) => value.as_str().map(str::to_owned).map(Some),
    };
    let (video_id, playlist_id) = (token("videoId")?, token("playlistId")?);
    if video_id.is_some() == playlist_id.is_some() {
        return None;
    }
    for id in video_id.iter().chain(playlist_id.iter()) {
        if !valid_youtube_id(id) {
            return None;
        }
    }
    let start_seconds = integer(content, "startSeconds", 0)?;
    if !(0..=86400).contains(&start_seconds) {
        return None;
    }
    let end_seconds = match content.get("endSeconds") {
        None | Some(serde_json::Value::Null) => None,
        Some(value) => {
            let end = value.as_i64()?;
            if !(1..=86400 * 2).contains(&end) || end <= start_seconds {
                return None;
            }
            Some(end as u32)
        }
    };
    let volume = integer(content, "volume", 100)?;
    if !(0..=100).contains(&volume) {
        return None;
    }
    let caption_language = text(content, "captionLanguage").unwrap_or_default();
    if !caption_language.is_empty() && !valid_language_code(&caption_language) {
        return None;
    }
    Some(YouTubeContent {
        video_id,
        playlist_id,
        start_seconds: start_seconds as u32,
        end_seconds,
        loop_playback: flag(content, "loop", false)?,
        author_muted: flag(content, "muted", false)?,
        volume: volume as u32,
        captions: flag(content, "captions", false)?,
        caption_language,
        controls: flag(content, "controls", false)?,
    })
}

/// Parses a `remoteWeb.create` spec. `None` names nothing: the caller maps
/// the failure to `bad_surface_id`, `bad_viewport`, or `bad_content` by
/// which part failed.
pub fn parse_create(params: &serde_json::Value) -> Result<SurfaceSpec, &'static str> {
    let params = params.as_object().ok_or(BAD_CONTENT)?;
    let surface_id = text(params, "surfaceId").ok_or(BAD_SURFACE_ID)?;
    if !valid_surface_id(&surface_id) {
        return Err(BAD_SURFACE_ID);
    }
    let viewport = params.get("viewport").and_then(map_viewport).ok_or(BAD_VIEWPORT)?;
    let content = params.get("content").and_then(|content| content.as_object()).ok_or(BAD_CONTENT)?;
    let kind = content.get("kind").and_then(|kind| kind.as_str()).ok_or(BAD_CONTENT)?;
    let content = match kind {
        "page" => SurfaceContent::Page(parse_page(content).ok_or(BAD_CONTENT)?),
        "youtube" => SurfaceContent::YouTube(parse_youtube(content).ok_or(BAD_CONTENT)?),
        _ => return Err(BAD_CONTENT),
    };
    Ok(SurfaceSpec {
        surface_id,
        content,
        viewport,
        muted: flag(params, "muted", true).ok_or(BAD_CONTENT)?,
        visible: flag(params, "visible", false).ok_or(BAD_CONTENT)?,
    })
}

fn split_authority(url: &str) -> Option<(String, String, Option<String>)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() => (host, Some(port.to_string())),
        _ => (authority, None),
    };
    Some((scheme.to_ascii_lowercase(), host.to_string(), port))
}

/// A main-frame document for a page surface: https is always a candidate,
/// http only when the configured URL is http, no user information, only
/// the scheme's default port, and the host must equal one allowlist entry.
/// Mirrors `tc_policy_main_frame`.
pub fn main_frame_allowed(target: &str, configured: &str, allowed_hosts: &[String]) -> bool {
    let Some((scheme, host, port)) = split_authority(target) else {
        return false;
    };
    let configured_https = configured.starts_with("https://");
    if scheme != "https" && !(scheme == "http" && !configured_https) {
        return false;
    }
    if target
        .split("://")
        .nth(1)
        .is_some_and(|rest| rest.split('/').next().is_some_and(|authority| authority.contains('@')))
    {
        return false;
    }
    let default_port = if scheme == "https" { "443" } else { "80" };
    if port.is_some_and(|port| port != default_port) {
        return false;
    }
    let Some(host) = normalize_host(&host) else {
        return false;
    };
    allowed_hosts.contains(&host)
}

/// A navigation in any frame. The host cannot see which frame an action
/// targets, so every frame follows the scheme rule and the main frame is
/// allowlisted separately at commit: network URLs plus the documents pages
/// build frames from. Every local or custom scheme is refused. Mirrors
/// `tc_policy_any_frame`.
pub fn any_frame_allowed(target: &str) -> bool {
    if target == "about:blank" || target == "about:srcdoc" {
        return true;
    }
    let Some((scheme, _, _)) = split_authority(target) else {
        // `data:` and `blob:` carry no authority component.
        return target.starts_with("data:") || target.starts_with("blob:");
    };
    if scheme != "https" && scheme != "http" {
        return false;
    }
    !target
        .split("://")
        .nth(1)
        .is_some_and(|rest| rest.split('/').next().is_some_and(|authority| authority.contains('@')))
}

/// A YouTube wrapper subframe: the embed and API hosts over plain https.
/// Mirrors `tc_youtube_subframe_allowed`.
pub fn youtube_subframe_allowed(uri: &str) -> bool {
    if uri == "about:blank" {
        return true;
    }
    let Some((scheme, host, port)) = split_authority(uri) else {
        return false;
    };
    if scheme != "https" || port.is_some() {
        return false;
    }
    if uri
        .split("://")
        .nth(1)
        .is_some_and(|rest| rest.split('/').next().is_some_and(|authority| authority.contains('@')))
    {
        return false;
    }
    host == "www.youtube-nocookie.com" || host == "www.youtube.com"
}

/// `true` when a cookie belongs to one of the surface's allowed hosts: the
/// cookie domain (leading dot stripped) equals the host or sits below it.
/// Drives the `first_party` release strip.
pub fn cookie_belongs_to_hosts(cookie_domain: &str, allowed_hosts: &[String]) -> bool {
    let domain = normalize_host(cookie_domain.strip_prefix('.').unwrap_or(cookie_domain));
    let Some(domain) = domain else {
        return false;
    };
    allowed_hosts.iter().any(|host| domain == *host || domain.ends_with(&format!(".{host}")))
}

/// The host of a URL for a log line, never its path or query.
pub fn log_host(url: &str) -> String {
    url_host(url).unwrap_or_else(|| "-".to_string())
}

/// The normalized host of a URL, for the cookie-strip enumeration. `None`
/// for anything without an authority component.
pub fn url_host(url: &str) -> Option<String> {
    split_authority(url).and_then(|(_, host, _)| normalize_host(&host))
}

/// The fixed base origin of the Tilecast-owned YouTube wrapper, shared
/// with Edge. The host maps it to the wrapper file; the embed request
/// carries the HTTPS reverse-DNS Referer YouTube requires.
pub const YOUTUBE_BASE_URI: &str = "https://org.tilecast.player/";

/// Builds the Tilecast-owned YouTube wrapper document for a validated
/// surface. The privacy-enhanced embed iframe is created with documented
/// parameters only; player state is one token in `data-tc-state`, and
/// visibility commands arrive through `data-tc-command`. The wrapper has
/// no message handler and no way to call the host; its own frames are
/// confined to the YouTube hosts by its CSP. Mirrors `tc_youtube_wrapper`.
pub fn youtube_wrapper(surface_id: &str, content: &YouTubeContent) -> Option<String> {
    let config = serde_json::json!({
        "videoId": content.video_id,
        "playlistId": content.playlist_id,
        "startSeconds": content.start_seconds,
        "endSeconds": content.end_seconds,
        "loop": content.loop_playback,
        "muted": content.author_muted,
        "volume": content.volume,
        "captions": content.captions,
        "captionLanguage": content.caption_language,
        "controls": content.controls,
    });
    let config = serde_json::to_string(&config).ok()?;
    // Validated tokens cannot contain '<'; refuse rather than escape.
    if config.contains('<') {
        return None;
    }
    Some(format!(
        "<!doctype html><html data-tc-state=\"loading\"><head><meta charset=\"utf-8\">\
        <meta name=\"referrer\" content=\"strict-origin-when-cross-origin\">\
        <meta http-equiv=\"Content-Security-Policy\" content=\"frame-src https://www.youtube-nocookie.com https://www.youtube.com\">\
        <style>html,body{{margin:0;width:100%;height:100%;overflow:hidden;background:#000}}\
        iframe{{border:0;width:100%;height:100%;display:block}}</style></head><body>\
        <script type=\"application/json\" id=\"tc-config\">{config}</script><script>\n\
        (function () {{\n\
        var root = document.documentElement;\n\
        var config = JSON.parse(document.getElementById('tc-config').textContent);\n\
        var origin = 'https://org.tilecast.player';\n\
        var state = function (value) {{ root.setAttribute('data-tc-state', value); }};\n\
        var p = new URLSearchParams();\n\
        p.set('enablejsapi', '1'); p.set('origin', origin); p.set('autoplay', '0');\n\
        p.set('playsinline', '1'); p.set('controls', config.controls ? '1' : '0');\n\
        p.set('rel', '0'); p.set('disablekb', '1'); p.set('fs', '0');\n\
        p.set('cc_load_policy', config.captions ? '1' : '0');\n\
        if (config.captions && config.captionLanguage) p.set('cc_lang_pref', config.captionLanguage);\n\
        if (config.startSeconds > 0) p.set('start', String(config.startSeconds));\n\
        if (config.endSeconds !== null) p.set('end', String(config.endSeconds));\n\
        var src;\n\
        if (config.playlistId) {{\n\
        p.set('listType', 'playlist'); p.set('list', config.playlistId);\n\
        if (config.loop) p.set('loop', '1');\n\
        src = 'https://www.youtube-nocookie.com/embed?' + p.toString();\n\
        }} else {{\n\
        if (config.loop) {{ p.set('loop', '1'); p.set('playlist', config.videoId); }}\n\
        src = 'https://www.youtube-nocookie.com/embed/' + config.videoId + '?' + p.toString();\n\
        }}\n\
        var frame = document.createElement('iframe');\n\
        frame.id = 'tc-player'; frame.allow = 'autoplay; encrypted-media'; frame.src = src;\n\
        document.body.appendChild(frame);\n\
        var player = null, ready = false;\n\
        var apply = function () {{\n\
        if (!ready) return;\n\
        if (root.getAttribute('data-tc-command') === 'play') player.playVideo(); else player.pauseVideo();\n\
        }};\n\
        new MutationObserver(apply).observe(root, {{ attributes: true, attributeFilter: ['data-tc-command'] }});\n\
        window.onYouTubeIframeAPIReady = function () {{\n\
        player = new YT.Player('tc-player', {{ events: {{\n\
        onReady: function (e) {{\n\
        if (config.muted) e.target.mute(); else {{ e.target.unMute(); e.target.setVolume(config.volume); }}\n\
        ready = true; state('ready'); apply();\n\
        }},\n\
        onStateChange: function (e) {{\n\
        var names = {{ '0': 'ended', '1': 'playing', '2': 'paused', '3': 'buffering', '5': 'ready' }};\n\
        if (names[String(e.data)]) state(names[String(e.data)]);\n\
        }},\n\
        onError: function (e) {{ state('error:' + (Number(e.data) | 0)); }}\n\
        }} }});\n\
        }};\n\
        var api = document.createElement('script');\n\
        api.src = 'https://www.youtube.com/iframe_api';\n\
        document.body.appendChild(api);\n\
        }})();\n\
        </script></body></html><!-- {surface_id} -->"
    ))
}

/// A YouTube wrapper state token, validated like the helper's poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YouTubeState {
    Loading,
    Ready,
    Playing,
    Paused,
    Buffering,
    Ended,
    Error(u32),
}

pub fn parse_youtube_state(value: &str) -> Option<YouTubeState> {
    match value {
        "loading" => Some(YouTubeState::Loading),
        "ready" => Some(YouTubeState::Ready),
        "playing" => Some(YouTubeState::Playing),
        "paused" => Some(YouTubeState::Paused),
        "buffering" => Some(YouTubeState::Buffering),
        "ended" => Some(YouTubeState::Ended),
        _ => {
            let code = value.strip_prefix("error:")?;
            if code.is_empty() || code.len() > 4 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            Some(YouTubeState::Error(code.parse().ok()?))
        }
    }
}

/// What a live surface has already reported, so events fire once per
/// transition and a failed surface stays silent and muted.
#[derive(Debug, Clone)]
pub struct TrackedSurface {
    pub spec: SurfaceSpec,
    pub failed: bool,
    pub loaded: bool,
    pub created_at_ms: i64,
    pub youtube_state: String,
    pub youtube_ended: bool,
}

/// Tracks live surfaces on the presentation task; the UI thread owns the
/// child views. At most [`MAX_SURFACES`]; creating over an existing id
/// is refused like any invalid create.
#[derive(Debug, Default)]
pub struct SurfaceTracker {
    surfaces: HashMap<String, TrackedSurface>,
}

impl SurfaceTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, surface_id: &str) -> Option<&TrackedSurface> {
        self.surfaces.get(surface_id)
    }

    pub fn get_mut(&mut self, surface_id: &str) -> Option<&mut TrackedSurface> {
        self.surfaces.get_mut(surface_id)
    }

    pub fn len(&self) -> usize {
        self.surfaces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.surfaces.is_empty()
    }

    pub fn create(&mut self, spec: SurfaceSpec) -> Result<(), &'static str> {
        if self.surfaces.contains_key(&spec.surface_id) {
            return Err("invalid_request");
        }
        if self.surfaces.len() >= MAX_SURFACES {
            return Err(LIMIT_EXCEEDED);
        }
        self.surfaces.insert(
            spec.surface_id.clone(),
            TrackedSurface {
                spec,
                failed: false,
                loaded: false,
                created_at_ms: 0,
                youtube_state: "loading".to_string(),
                youtube_ended: false,
            },
        );
        Ok(())
    }

    pub fn update_viewport(&mut self, surface_id: &str, viewport: ViewportPx) -> bool {
        match self.surfaces.get_mut(surface_id) {
            Some(surface) => {
                surface.spec.viewport = viewport;
                true
            }
            None => false,
        }
    }

    pub fn set_visible(&mut self, surface_id: &str, visible: bool) -> bool {
        match self.surfaces.get_mut(surface_id) {
            Some(surface) => {
                surface.spec.visible = visible;
                true
            }
            None => false,
        }
    }

    pub fn set_muted(&mut self, surface_id: &str, muted: bool) -> bool {
        match self.surfaces.get_mut(surface_id) {
            Some(surface) => {
                surface.spec.muted = muted;
                true
            }
            None => false,
        }
    }

    pub fn fail(&mut self, surface_id: &str) -> bool {
        match self.surfaces.get_mut(surface_id) {
            Some(surface) => {
                let first = !surface.failed;
                surface.failed = true;
                first
            }
            None => false,
        }
    }

    pub fn destroy(&mut self, surface_id: &str) -> Option<TrackedSurface> {
        self.surfaces.remove(surface_id)
    }

    /// Marks a surface loaded: its host-side create timeout is over (the
    /// Runtime still owns the load timers the user sees).
    pub fn mark_loaded(&mut self, surface_id: &str) -> bool {
        match self.surfaces.get_mut(surface_id) {
            Some(surface) => {
                surface.loaded = true;
                true
            }
            None => false,
        }
    }

    /// Drops surfaces that never loaded within [`CREATE_TIMEOUT`] of
    /// their creation, returning their ids oldest first. A stuck create
    /// must not hold a child view forever.
    pub fn take_expired(&mut self, now_ms: i64) -> Vec<String> {
        let timeout_ms = i64::try_from(CREATE_TIMEOUT.as_millis()).unwrap_or(i64::MAX);
        let mut expired: Vec<(i64, String)> = self
            .surfaces
            .iter()
            .filter(|(_, surface)| !surface.loaded && now_ms.saturating_sub(surface.created_at_ms) > timeout_ms)
            .map(|(id, surface)| (surface.created_at_ms, id.clone()))
            .collect();
        expired.sort();
        for (_, id) in &expired {
            self.surfaces.remove(id);
        }
        expired.into_iter().map(|(_, id)| id).collect()
    }

    /// Drops every surface, returning their ids. The trusted renderer's
    /// restart takes the remote layers with it: a reloaded Runtime
    /// re-creates what it still shows.
    pub fn reset(&mut self) -> Vec<String> {
        let removed: Vec<String> = self.surfaces.keys().cloned().collect();
        self.surfaces.clear();
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn viewport(width: f64, height: f64) -> serde_json::Value {
        serde_json::json!({ "x": 0, "y": 0, "width": width, "height": height, "deviceScale": 1 })
    }

    fn page_params(url: &str) -> serde_json::Value {
        serde_json::json!({
            "surfaceId": "rw-1",
            "content": {
                "kind": "page",
                "url": url,
                "allowedHosts": ["example.com"],
                "javascriptEnabled": true,
                "domStorageEnabled": false,
                "cookiePolicy": "first_party",
                "userAgent": "",
                "zoomPercent": 100,
                "scrollX": 0,
                "scrollY": 0,
                "backgroundColor": "#000000",
            },
            "viewport": viewport(640.0, 360.0),
            "muted": true,
            "visible": true,
        })
    }

    #[test]
    fn viewports_map_css_pixels_by_the_device_scale() {
        let mapped = map_viewport(&viewport(640.0, 360.0)).expect("maps");
        assert_eq!(mapped, ViewportPx { x: 0, y: 0, width: 640, height: 360 });
        let scaled = map_viewport(&serde_json::json!({
            "x": -10.4, "y": 5.5, "width": 320.0, "height": 180.0, "deviceScale": 2
        }))
        .expect("maps");
        assert_eq!(scaled, ViewportPx { x: -21, y: 11, width: 640, height: 360 });
        assert!(map_viewport(&viewport(8.0, 360.0)).is_none());
        assert!(map_viewport(&viewport(4000.0, 360.0)).is_none());
        assert!(map_viewport(&viewport(1920.0, 5000.0)).is_none());
        assert!(
            map_viewport(&serde_json::json!(
                { "x": 0, "y": 0, "width": 640, "height": 360, "deviceScale": 0.5 }
            ))
            .is_none()
        );
    }

    #[test]
    fn surface_ids_hosts_and_urls_follow_the_protocol() {
        assert!(valid_surface_id("rw-1"));
        assert!(!valid_surface_id("RW-1"));
        assert!(!valid_surface_id(""));
        assert_eq!(normalize_host("Example.COM.").as_deref(), Some("example.com"));
        assert!(normalize_host("2001:db8::1").is_none());
        assert!(valid_url("https://example.com/a?b#c"));
        assert!(!valid_url("https://user@example.com/"));
        assert!(!valid_url("file:///etc/passwd"));
        assert!(!valid_url("https://example.com/has space"));
    }

    #[test]
    fn youtube_ids_languages_and_colors_are_tokens() {
        assert!(valid_youtube_id("dQw4w9WgXcQ"));
        assert!(!valid_youtube_id("short"));
        assert!(!valid_youtube_id("has space here!"));
        assert!(valid_language_code("en"));
        assert!(valid_language_code("pt-BR"));
        assert!(!valid_language_code("e"));
        assert!(!valid_language_code("english"));
        assert!(valid_color("#1a2b3c"));
        assert!(valid_color("#1a2b3cff"));
        assert!(!valid_color("red"));
    }

    #[test]
    fn page_specs_parse_and_reject() {
        let spec = parse_create(&page_params("https://example.com/")).expect("parses");
        assert_eq!(spec.surface_id, "rw-1");
        assert!(matches!(spec.content, SurfaceContent::Page(_)));
        assert_eq!(parse_create(&page_params("file:///x")).err(), Some(BAD_CONTENT));
        let mut hundreds = page_params("https://example.com/");
        hundreds["content"]["zoomPercent"] = serde_json::json!(24);
        assert_eq!(parse_create(&hundreds).err(), Some(BAD_CONTENT));
        let mut bad_id = page_params("https://example.com/");
        bad_id["surfaceId"] = serde_json::json!("RW-1");
        assert_eq!(parse_create(&bad_id).err(), Some(BAD_SURFACE_ID));
        let mut bad_viewport = page_params("https://example.com/");
        bad_viewport["viewport"] = viewport(8.0, 360.0);
        assert_eq!(parse_create(&bad_viewport).err(), Some(BAD_VIEWPORT));
    }

    #[test]
    fn youtube_specs_need_exactly_one_id() {
        let mut params = page_params("https://example.com/");
        params["content"] = serde_json::json!({
            "kind": "youtube",
            "videoId": "dQw4w9WgXcQ",
            "playlistId": null,
            "startSeconds": 10,
            "endSeconds": 20,
            "loop": true,
            "muted": true,
            "volume": 80,
            "captions": true,
            "captionLanguage": "en",
            "controls": false,
        });
        let spec = parse_create(&params).expect("parses");
        assert!(matches!(spec.content, SurfaceContent::YouTube(_)));
        params["content"]["playlistId"] = serde_json::json!("PL0123456789abcdef");
        assert_eq!(parse_create(&params).err(), Some(BAD_CONTENT));
        params["content"]["playlistId"] = serde_json::Value::Null;
        params["content"]["videoId"] = serde_json::Value::Null;
        assert_eq!(parse_create(&params).err(), Some(BAD_CONTENT));
    }

    #[test]
    fn the_main_frame_policy_matches_edge() {
        let hosts = vec!["example.com".to_string()];
        let configured = "https://example.com/";
        assert!(main_frame_allowed("https://example.com/other", configured, &hosts));
        assert!(main_frame_allowed("https://example.com:443/", configured, &hosts));
        assert!(!main_frame_allowed("https://evil.com/", configured, &hosts));
        assert!(!main_frame_allowed("https://example.com.evil.com/", configured, &hosts));
        assert!(!main_frame_allowed("https://example.com:8443/", configured, &hosts));
        assert!(!main_frame_allowed("https://user@example.com/", configured, &hosts));
        assert!(!main_frame_allowed("http://example.com/", configured, &hosts));
        assert!(main_frame_allowed("http://example.com/", "http://example.com/", &hosts));
        assert!(!main_frame_allowed("file:///etc/passwd", configured, &hosts));
        assert!(!main_frame_allowed("tilecast://runtime/index.html", configured, &hosts));
    }

    #[test]
    fn any_frame_refuses_local_and_custom_schemes() {
        assert!(any_frame_allowed("https://example.com/"));
        assert!(any_frame_allowed("about:blank"));
        assert!(any_frame_allowed("data:text/html,hi"));
        assert!(!any_frame_allowed("file:///x"));
        assert!(!any_frame_allowed("tilecast://runtime/index.html"));
        assert!(!any_frame_allowed("tcmedia://cap/abc"));
        assert!(!any_frame_allowed("javascript:alert(1)"));
        assert!(!any_frame_allowed("https://user@example.com/"));
    }

    #[test]
    fn youtube_subframes_stay_on_the_youtube_hosts() {
        assert!(youtube_subframe_allowed("about:blank"));
        assert!(youtube_subframe_allowed("https://www.youtube-nocookie.com/embed/abc"));
        assert!(youtube_subframe_allowed("https://www.youtube.com/iframe_api"));
        assert!(!youtube_subframe_allowed("https://evil.com/"));
        assert!(!youtube_subframe_allowed("https://www.youtube.com:443/x"));
        assert!(!youtube_subframe_allowed("http://www.youtube.com/"));
    }

    #[test]
    fn first_party_cookies_belong_to_the_allowlist() {
        let hosts = vec!["example.com".to_string()];
        assert!(cookie_belongs_to_hosts("example.com", &hosts));
        assert!(cookie_belongs_to_hosts(".example.com", &hosts));
        assert!(cookie_belongs_to_hosts("cdn.example.com", &hosts));
        assert!(!cookie_belongs_to_hosts("tracker.com", &hosts));
        assert!(!cookie_belongs_to_hosts("example.com.evil.com", &hosts));
        assert!(!cookie_belongs_to_hosts("not a host", &hosts));
    }

    #[test]
    fn the_wrapper_carries_config_not_script() {
        let content = YouTubeContent {
            video_id: Some("dQw4w9WgXcQ".to_string()),
            playlist_id: None,
            start_seconds: 10,
            end_seconds: Some(20),
            loop_playback: true,
            author_muted: true,
            volume: 80,
            captions: true,
            caption_language: "en".to_string(),
            controls: false,
        };
        let wrapper = youtube_wrapper("rw-7", &content).expect("builds");
        assert!(wrapper.contains("youtube-nocookie.com/embed/"));
        assert!(wrapper.contains("\"videoId\":\"dQw4w9WgXcQ\""));
        assert!(wrapper.contains("data-tc-state"));
        assert!(wrapper.contains("frame-src https://www.youtube-nocookie.com"));
        assert!(!wrapper.contains("postMessage"));
        assert!(!wrapper.contains("chrome.webview"));
    }

    #[test]
    fn wrapper_state_tokens_are_closed() {
        assert_eq!(parse_youtube_state("playing"), Some(YouTubeState::Playing));
        assert_eq!(parse_youtube_state("error:150"), Some(YouTubeState::Error(150)));
        assert_eq!(parse_youtube_state("error:"), None);
        assert_eq!(parse_youtube_state("error:10000"), None);
        assert_eq!(parse_youtube_state("playing '; DROP"), None);
        assert_eq!(parse_youtube_state(""), None);
    }

    #[test]
    fn the_tracker_bounds_surfaces_and_fails_once() {
        let mut tracker = SurfaceTracker::new();
        let spec = parse_create(&page_params("https://example.com/")).expect("parses");
        tracker.create(spec.clone()).expect("creates");
        assert!(tracker.create(spec).is_err());
        assert!(tracker.update_viewport("rw-1", ViewportPx { x: 0, y: 0, width: 320, height: 180 }));
        assert!(!tracker.update_viewport("rw-9", ViewportPx { x: 0, y: 0, width: 320, height: 180 }));
        assert!(tracker.fail("rw-1"));
        assert!(!tracker.fail("rw-1"));
        assert!(!tracker.fail("rw-9"));
        for index in 2..=MAX_SURFACES {
            let mut params = page_params("https://example.com/");
            params["surfaceId"] = serde_json::json!(format!("rw-{index}"));
            let spec = parse_create(&params).expect("parses");
            tracker.create(spec).expect("creates");
        }
        let mut params = page_params("https://example.com/");
        params["surfaceId"] = serde_json::json!("rw-9");
        let spec = parse_create(&params).expect("parses");
        assert_eq!(tracker.create(spec).err(), Some(LIMIT_EXCEEDED));
        assert_eq!(tracker.reset().len(), MAX_SURFACES);
        assert!(tracker.is_empty());
    }

    #[test]
    fn failure_codes_are_the_closed_set() {
        for code in ["tls_failure", "blocked_navigation", "youtube_error", "renderer_crash", "offline"] {
            assert!(is_failure_code(code));
        }
        assert!(!is_failure_code("bogus"));
    }

    #[test]
    fn url_hosts_come_out_normalized() {
        assert_eq!(url_host("https://Example.COM:443/a?b#c").as_deref(), Some("example.com"));
        assert_eq!(url_host("http://10.0.0.9/").as_deref(), Some("10.0.0.9"));
        assert_eq!(url_host("about:blank"), None);
        assert_eq!(url_host("not a url"), None);
    }

    #[test]
    fn unloaded_surfaces_expire_but_loaded_ones_stay() {
        let mut tracker = SurfaceTracker::new();
        let mut slow = page_params("https://example.com/");
        slow["surfaceId"] = serde_json::json!("rw-slow");
        tracker.create(parse_create(&slow).expect("parses")).expect("creates");
        tracker.get_mut("rw-slow").expect("tracked").created_at_ms = 1_000;
        let mut quick = page_params("https://example.org/");
        quick["surfaceId"] = serde_json::json!("rw-quick");
        tracker.create(parse_create(&quick).expect("parses")).expect("creates");
        tracker.get_mut("rw-quick").expect("tracked").created_at_ms = 1_000;
        assert!(tracker.mark_loaded("rw-quick"));
        assert!(!tracker.mark_loaded("rw-missing"));
        let timeout_ms = i64::try_from(CREATE_TIMEOUT.as_millis()).expect("fits");
        assert!(tracker.take_expired(1_000 + timeout_ms).is_empty());
        assert_eq!(tracker.take_expired(1_001 + timeout_ms), vec!["rw-slow".to_string()]);
        assert!(tracker.get("rw-slow").is_none());
        assert!(tracker.get("rw-quick").is_some());
    }
}
