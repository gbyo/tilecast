//! Manifest projection: the verified manifest, resolved at one corrected
//! instant, as the `RuntimePresentation` JSON the shared Runtime renders.
//!
//! The semantics are the reference hosts': native selection through Core,
//! availability windows, item defaults from the accepted player
//! configuration, content references for every media object, and a
//! projection context (manifest subset plus media aliases) the Runtime
//! projects widget and layout references from.
//!
//! Remote web renders in host-layer child views (`capabilities.remoteWeb`
//! is `host-view`): Website items project with the server's Website
//! configuration plus the player configuration's `website` overrides,
//! and web/YouTube Widgets flow through their `requiredCapabilities`
//! like any other Widget.

use player_core::{ManifestAsset, NativeManifest, Selection, Source, VerifiedContentRef};
use player_types::Timestamp;
use serde_json::Value;
use std::collections::BTreeMap;

use crate::player_config::WindowsPlayerConfig;

pub const CONTENT_URI_PREFIX: &str = "tcmedia://sha256/";
const LAYOUT_ITEM_PREFIX: &str = "layout-";
/// Largest projection context carried to the Runtime.
pub const MAX_PROJECTION_BYTES: usize = 3 * 1024 * 1024;

/// Builds the content URI for a digest. The Runtime never sees this form:
/// the port substitutes granted `tcmedia://cap/` URIs before sending.
pub fn content_uri(digest: &player_types::Sha256Digest) -> String {
    format!("{CONTENT_URI_PREFIX}{}", digest.to_hex())
}

/// Parses a content URI. Returns `None` for anything that is not exactly
/// `tcmedia://sha256/<digest>`.
pub fn parse_content_uri(value: &str) -> Option<player_types::Sha256Digest> {
    value.strip_prefix(CONTENT_URI_PREFIX).and_then(|hex| player_types::Sha256Digest::parse(hex).ok())
}

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum ProjectionError {
    #[error("manifest structure is invalid")]
    Structure,
    #[error("manifest references an unavailable or ambiguous media variant")]
    Reference,
    #[error("manifest schedule is invalid")]
    Schedule,
    #[error("presentation is incompatible with this renderer: {0}")]
    Incompatible(Incompatibility),
}

impl ProjectionError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Structure => "manifest_structure_invalid",
            Self::Reference => "manifest_reference_invalid",
            Self::Schedule => "manifest_schedule_invalid",
            Self::Incompatible(reason) => reason.code(),
        }
    }
}

/// A precise reason a presentation cannot run on this renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incompatibility {
    SynchronizedPlayback,
    SpanViewport,
    Plugin(String),
    WidgetCapability(String),
    ContentType(String),
    Requirement(String),
}

impl Incompatibility {
    pub fn code(&self) -> &'static str {
        match self {
            Self::SynchronizedPlayback => "presentation_incompatible_synchronized_playback",
            Self::SpanViewport => "presentation_incompatible_span",
            Self::Plugin(_) => "presentation_incompatible_plugin",
            Self::WidgetCapability(_) => "presentation_incompatible_widget_capability",
            Self::ContentType(_) => "presentation_incompatible_content_type",
            Self::Requirement(_) => "presentation_incompatible_requirement",
        }
    }
}

impl std::fmt::Display for Incompatibility {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SynchronizedPlayback => f.write_str("synchronized group playback is not supported by this renderer"),
            Self::SpanViewport => f.write_str("the Span canvas or panel geometry is malformed"),
            Self::Plugin(kind) => write!(f, "the {kind} plugin is not supported by this renderer"),
            Self::WidgetCapability(name) => write!(f, "a widget needs renderer capability {name}"),
            Self::ContentType(kind) => write!(f, "content type {kind} is not supported by this renderer"),
            Self::Requirement(name) => write!(f, "the presentation requires {name}"),
        }
    }
}

/// A synchronized group's timeline for one presentation (the reference
/// player's `enrichSynchronizedPresentation`): every member places the same
/// items on the same anchor with the same effective durations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupTiming {
    pub group_id: String,
    /// Corrected Unix milliseconds.
    pub anchor_ms: i64,
    pub durations_ms: Vec<u64>,
}

/// One media alias: manifest asset/variant identity to a content URI the
/// port substitutes a grant for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaAlias {
    pub asset_id: uuid::Uuid,
    pub variant_id: uuid::Uuid,
    pub uri: String,
}

/// What the Runtime shows and why.
#[derive(Debug, Clone)]
pub struct ResolvedPresentation {
    /// The `RuntimePresentation` JSON.
    pub document: Value,
    /// The shared timeline of a synchronized group, when the screen belongs
    /// to one and shows a playlist.
    pub timing: Option<GroupTiming>,
    pub content: Vec<VerifiedContentRef>,
    /// The `ProjectionContextV1` JSON, when an item needs Runtime projection.
    pub projection: Option<Value>,
    pub plugins: Vec<Value>,
    pub plugin_aliases: Vec<MediaAlias>,
    pub selection: Selection,
    pub next_transition_ms: Option<i64>,
}

fn availability_window(value: &Value) -> Result<(Option<i64>, Option<i64>), ProjectionError> {
    let parse = |key: &str| -> Result<Option<i64>, ProjectionError> {
        match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => {
                Timestamp::parse(text).map(|value| Some(value.unix_millis())).map_err(|_| ProjectionError::Structure)
            }
            _ => Err(ProjectionError::Structure),
        }
    };
    let from = parse("availableFrom")?;
    let until = parse("expiresAt")?;
    if from.zip(until).is_some_and(|(from, until)| from >= until) {
        return Err(ProjectionError::Structure);
    }
    Ok((from, until))
}

fn available_at(value: &Value, now_ms: i64) -> Result<bool, ProjectionError> {
    let (from, until) = availability_window(value)?;
    Ok(from.is_none_or(|from| now_ms >= from) && until.is_none_or(|until| now_ms < until))
}

fn playlists_of(document: &Value) -> impl Iterator<Item = &Value> {
    ["playlist", "directFallbackPlaylist"]
        .into_iter()
        .filter_map(|key| document.get(key).filter(|value| !value.is_null()))
        .chain(document.get("playlists").and_then(Value::as_array).into_iter().flatten())
}

fn next_availability_transition(document: &Value, now_ms: i64) -> Result<Option<i64>, ProjectionError> {
    let mut next = None;
    let mut observe = |value: &Value| -> Result<(), ProjectionError> {
        let (from, until) = availability_window(value)?;
        for boundary in [from, until].into_iter().flatten().filter(|at| *at > now_ms) {
            next = Some(next.map_or(boundary, |current: i64| current.min(boundary)));
        }
        Ok(())
    };
    if let Some(assets) = document.get("assets").and_then(Value::as_array) {
        for asset in assets {
            observe(asset)?;
        }
    }
    for playlist in playlists_of(document) {
        if let Some(items) = playlist.get("items").and_then(Value::as_array) {
            for item in items {
                observe(item)?;
            }
        }
    }
    Ok(next)
}

/// This screen's panel of a Span canvas, in the runtime's `RuntimeViewport`
/// shape (the Electron player's `spanViewport`), or `None` for a Mirror
/// screen. Both objects must be present and the panel must lie inside the
/// canvas; the server validates the same geometry.
pub fn span_viewport(document: &Value) -> Result<Option<Value>, Incompatibility> {
    const MAX_EDGE: u64 = 65_536;
    let present = |key: &str| document.get(key).filter(|value| !value.is_null());
    let (canvas, viewport) = match (present("canvas"), present("viewport")) {
        (None, None) => return Ok(None),
        (Some(canvas), Some(viewport)) => (canvas, viewport),
        _ => return Err(Incompatibility::SpanViewport),
    };
    let field = |value: &Value, key: &str, max: u64| {
        value.get(key).and_then(Value::as_u64).filter(|n| *n <= max).ok_or(Incompatibility::SpanViewport)
    };
    let (canvas_width, canvas_height) = (field(canvas, "width", MAX_EDGE)?, field(canvas, "height", MAX_EDGE)?);
    let (x, y) = (field(viewport, "x", MAX_EDGE)?, field(viewport, "y", MAX_EDGE)?);
    let (width, height) = (field(viewport, "width", MAX_EDGE)?, field(viewport, "height", MAX_EDGE)?);
    let rotation = field(viewport, "rotation", 270)?;
    let order = field(viewport, "order", 1_024)?;
    if width == 0 || height == 0 || x + width > canvas_width || y + height > canvas_height || rotation % 90 != 0 {
        return Err(Incompatibility::SpanViewport);
    }
    let mut out = serde_json::json!({"x": x, "y": y, "width": width, "height": height, "rotation": rotation,
        "order": order, "canvasWidth": canvas_width, "canvasHeight": canvas_height});
    for key in ["bezelLeft", "bezelTop", "bezelRight", "bezelBottom"] {
        if let Some(value) = viewport.get(key).filter(|value| !value.is_null()) {
            out[key] =
                serde_json::json!(value.as_u64().filter(|n| *n <= MAX_EDGE).ok_or(Incompatibility::SpanViewport)?);
        }
    }
    Ok(Some(out))
}

/// Everything in `document` this renderer cannot safely provide. An empty
/// list means compatible.
pub fn incompatibilities(document: &Value, assets: &[ManifestAsset]) -> Vec<Incompatibility> {
    let packaged = crate::renderer_adapter::packaged_profile();
    let mut out = Vec::new();
    let mut push = |reason: Incompatibility| {
        if !out.contains(&reason) {
            out.push(reason);
        }
    };
    for widget in document.get("widgets").and_then(Value::as_array).into_iter().flatten() {
        if let Some(presentation) = widget.get("presentation").filter(|value| !value.is_null()) {
            match presentation.get("kind").and_then(Value::as_str) {
                Some("native") => {}
                // The runtime mounts the component; its required
                // `widget.<type>` capability is checked below.
                Some("component") => {}
                _ => push(Incompatibility::WidgetCapability("presentation kind".to_owned())),
            }
            if let Some(required) = presentation.get("requiredCapabilities").and_then(Value::as_object) {
                for (name, version) in required {
                    let requirement = version
                        .as_u64()
                        .and_then(|v| u32::try_from(v).ok())
                        .filter(|v| *v > 0)
                        .zip(player_types::bounded::ShortToken::new(name).ok())
                        .map(|(version, name)| {
                            if name.as_str().starts_with("widget.") {
                                player_core::RendererRequirement::WidgetComponent { name, version }
                            } else {
                                player_core::RendererRequirement::Declarative { name, version }
                            }
                        });
                    if requirement.as_ref().is_none_or(|required| packaged.check(required).is_err()) {
                        push(Incompatibility::WidgetCapability(name.chars().take(64).collect()));
                    }
                }
            }
        }
    }
    let by_variant: BTreeMap<(uuid::Uuid, uuid::Uuid), &ManifestAsset> =
        assets.iter().map(|asset| ((asset.asset_id, asset.variant_id), asset)).collect();
    for playlist in playlists_of(document) {
        for item in playlist.get("items").and_then(Value::as_array).into_iter().flatten() {
            let kind = item.get("assetType").and_then(Value::as_str).unwrap_or("");
            if item.get("layoutId").is_some_and(|id| !id.is_null()) || kind == "widget" {
                continue;
            }
            match kind {
                // Website items project against the remote web surface.
                "website" => continue,
                "image" | "video" => {}
                other => push(Incompatibility::ContentType(other.chars().take(32).collect())),
            }
            let variant = item.get("variantId").and_then(Value::as_str).and_then(|v| v.parse().ok());
            let asset = item.get("assetId").and_then(Value::as_str).and_then(|a| a.parse().ok());
            let Some(asset) = asset.zip(variant).and_then(|key| by_variant.get(&key)) else { continue };
            if !(asset.mime_type.starts_with("image/") || asset.mime_type.starts_with("video/")) {
                push(Incompatibility::ContentType(asset.mime_type.chars().take(32).collect()));
            }
            // `stream` and `automatic` delivery need no incompatibility:
            // every byte is verified before use, so such items are
            // downloaded into the store like any other. One too large for
            // the store fails preparation with the store's typed reason and
            // the committed presentation stays.
        }
    }
    if document.get("syncGroup").is_some_and(|group| {
        !group.is_null()
            && (group.get("id").and_then(Value::as_str).is_none_or(|id| id.is_empty() || id.len() > 64)
                || group
                    .get("playbackEpoch")
                    .and_then(Value::as_str)
                    .and_then(|epoch| epoch.parse::<jiff::Timestamp>().ok())
                    .is_none())
    }) {
        push(Incompatibility::SynchronizedPlayback);
    }
    if span_viewport(document).is_err() {
        push(Incompatibility::SpanViewport);
    }
    // A schedule's `displayAction` is not a presentation requirement: the
    // display task applies it when a provider exists and reports the typed
    // reason when none does, as the reference player does.
    for plugin in document.get("plugins").and_then(Value::as_array).into_iter().flatten() {
        let kind = plugin.get("type").and_then(Value::as_str).unwrap_or("unknown");
        if !crate::renderer_adapter::profile::FEATURES.contains(&format!("plugin.{kind}").as_str()) {
            push(Incompatibility::Plugin(kind.chars().take(32).collect()));
        }
    }
    out
}

pub struct Projector<'a> {
    native: &'a NativeManifest,
}

impl std::fmt::Debug for Projector<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Projector").finish_non_exhaustive()
    }
}

impl<'a> Projector<'a> {
    pub fn new(native: &'a NativeManifest) -> Self {
        Self { native }
    }

    fn document(&self) -> &Value {
        &self.native.document
    }

    fn asset(&self, asset_id: &str, variant_id: &str) -> Option<&ManifestAsset> {
        let key: (uuid::Uuid, uuid::Uuid) = (asset_id.parse().ok()?, variant_id.parse().ok()?);
        self.native.assets.iter().find(|asset| (asset.asset_id, asset.variant_id) == key)
    }

    fn asset_value(&self, asset: &ManifestAsset) -> Option<&Value> {
        self.document().get("assets")?.as_array()?.iter().find(|value| {
            value.get("assetId").and_then(Value::as_str) == Some(&asset.asset_id.to_string())
                && value.get("variantId").and_then(Value::as_str) == Some(&asset.variant_id.to_string())
        })
    }

    fn content_ref(asset: &ManifestAsset) -> Result<VerifiedContentRef, ProjectionError> {
        Ok(VerifiedContentRef {
            sha256: asset.digest,
            size_bytes: asset.size_bytes,
            mime_type: player_types::bounded::SafeText::new(asset.mime_type.clone())
                .map_err(|_| ProjectionError::Structure)?,
        })
    }

    fn widget(&self, asset_id: &str) -> Option<&Value> {
        self.document()
            .get("widgets")?
            .as_array()?
            .iter()
            .find(|widget| widget.get("assetId").and_then(Value::as_str) == Some(asset_id))
    }

    /// A Website asset as the reference player builds it: the server's
    /// Website configuration, with the player configuration's `website`
    /// overrides. Returns `false` when the manifest has no usable Website
    /// for the asset; the caller then skips the item.
    fn website_item(
        &self,
        built: &mut Value,
        asset_id: &str,
        config: &WindowsPlayerConfig,
        now_ms: i64,
        content: &mut BTreeMap<player_types::Sha256Digest, VerifiedContentRef>,
    ) -> Result<bool, ProjectionError> {
        let Some(site) = self
            .document()
            .get("websites")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|site| site.get("assetId").and_then(Value::as_str) == Some(asset_id))
        else {
            return Ok(false);
        };
        let url = site.get("url").and_then(Value::as_str).unwrap_or("");
        if !crate::remote_web::valid_url(url) {
            return Ok(false);
        }
        let string = |key: &str| site.get(key).and_then(Value::as_str).unwrap_or("");
        let positive = |key: &str| site.get(key).and_then(Value::as_u64).filter(|value| *value > 0);
        let website = &config.runtime.website;
        let mut fallback_src = Value::Null;
        if let Some(fallback) = site.get("fallbackImageAssetId").and_then(Value::as_str) {
            let variant = site.get("fallbackVariantId").and_then(Value::as_str);
            let asset = self.native.assets.iter().find(|asset| {
                asset.asset_id.to_string() == fallback
                    && variant.is_none_or(|variant| asset.variant_id.to_string() == variant)
                    && self.asset_value(asset).is_some_and(|value| available_at(value, now_ms).unwrap_or(false))
            });
            if let Some(asset) = asset {
                fallback_src = Value::String(content_uri(&asset.digest));
                content.entry(asset.digest).or_insert(Self::content_ref(asset)?);
            }
        }
        let hosts: Vec<Value> = site
            .get("allowedHosts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(crate::remote_web::MAX_HOSTS)
            .map(|host| Value::String(host.chars().take(crate::remote_web::MAX_HOST).collect()))
            .collect();
        built["kind"] = Value::String("website".into());
        built["src"] = Value::String(url.to_owned());
        built["website"] = serde_json::json!({
            "loadTimeoutSeconds": website.timeout_seconds.or(positive("loadTimeoutSeconds")).unwrap_or(20),
            "refreshIntervalSeconds": site.get("refreshIntervalSeconds").and_then(Value::as_u64),
            "zoomPercent": positive("zoomPercent").or(website.default_zoom_percent).unwrap_or(100),
            "javascriptEnabled": site.get("javascriptEnabled").and_then(Value::as_bool).unwrap_or(true),
            "domStorageEnabled": site.get("domStorageEnabled").and_then(Value::as_bool).unwrap_or(true),
            "cookiePolicy": website.cookie_policy.as_deref().unwrap_or(match string("cookiePolicy") {
                "" => "first_party",
                policy => policy,
            }),
            "reloadPolicy": match string("reloadPolicy") { "" => "on_each_activation", policy => policy },
            "customUserAgent": string("customUserAgent").chars().take(256).collect::<String>(),
            "scrollX": site.get("scrollX").and_then(Value::as_u64).unwrap_or(0),
            "scrollY": site.get("scrollY").and_then(Value::as_u64).unwrap_or(0),
            "backgroundColor": match string("backgroundColor") { "" => "#0E141B", color => color },
            "failureBehavior": match string("failureBehavior") {
                "" => website.default_failure_behavior.as_deref().unwrap_or("placeholder"),
                behavior => behavior,
            },
            "fallbackSrc": fallback_src,
            "allowedHosts": hosts,
        });
        Ok(true)
    }

    /// A branded status surface, with the manifest's logo when one is
    /// available.
    #[allow(clippy::too_many_arguments)]
    fn status(
        &self,
        state: &str,
        title: &str,
        message: &str,
        status: &str,
        now_ms: i64,
        config: &WindowsPlayerConfig,
    ) -> Result<(Value, Vec<VerifiedContentRef>), ProjectionError> {
        let mut content = Vec::new();
        let logo = self
            .document()
            .get("branding")
            .filter(|value| !value.is_null())
            .and_then(|branding| {
                self.asset(branding.get("logoAssetId")?.as_str()?, branding.get("logoVariantId")?.as_str()?)
            })
            .filter(|asset| self.asset_value(asset).is_some_and(|value| available_at(value, now_ms).unwrap_or(false)));
        let logo_src = match logo {
            Some(asset) => {
                content.push(Self::content_ref(asset)?);
                Some(content_uri(&asset.digest))
            }
            None => None,
        };
        let branding = &config.runtime.branding;
        let mut surface = serde_json::json!({
            "state": state,
            "title": title.chars().take(120).collect::<String>(),
            "message": message.chars().take(480).collect::<String>(),
            "backgroundColor": branding.background(),
            "textColor": branding.text(),
            "status": status,
        });
        if let Some(logo_src) = logo_src {
            surface["logoSrc"] = Value::String(logo_src);
        }
        if let Some(footer) = branding.footer_text.as_deref() {
            surface["footerText"] = Value::String(footer.chars().take(240).collect());
        }
        Ok((surface, content))
    }

    /// The branded surface for a screen whose playback an administrator
    /// disabled (the reference player's `brandingFallback`).
    pub fn disabled_surface(
        &self,
        now_ms: i64,
        config: &WindowsPlayerConfig,
    ) -> Result<(Value, Vec<VerifiedContentRef>), ProjectionError> {
        let branding = &config.runtime.branding;
        self.status(
            "disabled",
            branding.disabled_title.as_deref().unwrap_or("Screen disabled"),
            branding.disabled_message.as_deref().unwrap_or(""),
            "disabled",
            now_ms,
            config,
        )
    }

    /// The manifest subset the trusted runtime's `renderWidget` and
    /// `renderLayout` read, plus the media map for every asset variant.
    fn projection(&self, config: &WindowsPlayerConfig) -> Result<(Value, Vec<VerifiedContentRef>), ProjectionError> {
        let mut manifest = serde_json::Map::new();
        for key in [
            "assets",
            "playlist",
            "directFallbackPlaylist",
            "playlists",
            "widgets",
            "dataSources",
            "layouts",
            "layout",
            "canvas",
            "viewport",
        ] {
            if let Some(value) = self.document().get(key).filter(|value| !value.is_null()) {
                manifest.insert(key.to_owned(), value.clone());
            }
        }
        let mut media = Vec::with_capacity(self.native.assets.len());
        let mut content = Vec::with_capacity(self.native.assets.len());
        for asset in &self.native.assets {
            media.push(serde_json::json!({
                "assetId": asset.asset_id.to_string(),
                "variantId": asset.variant_id.to_string(),
                "uri": content_uri(&asset.digest),
            }));
            if !content.iter().any(|existing: &VerifiedContentRef| existing.sha256 == asset.digest) {
                content.push(Self::content_ref(asset)?);
            }
        }
        let manifest = Value::Object(manifest);
        if serde_json::to_vec(&manifest).map_or(true, |bytes| bytes.len() > MAX_PROJECTION_BYTES) {
            return Err(ProjectionError::Structure);
        }
        let mut context = serde_json::json!({"schema": 1, "clockOffsetMs": 0, "manifest": manifest, "media": media});
        if !config.runtime.playback.context.is_empty() {
            context["playback"] = Value::Object(config.runtime.playback.context.clone());
        }
        Ok((context, content))
    }

    /// Supported built-in plugins, their media aliases and content.
    #[allow(clippy::type_complexity)]
    fn plugins(&self) -> Result<(Vec<Value>, Vec<MediaAlias>, Vec<VerifiedContentRef>), ProjectionError> {
        let mut plugins = Vec::new();
        let mut aliases = Vec::new();
        let mut content = Vec::new();
        for plugin in self.document().get("plugins").and_then(Value::as_array).into_iter().flatten() {
            let kind = plugin.get("type").and_then(Value::as_str).unwrap_or("");
            if !crate::renderer_adapter::profile::FEATURES.contains(&format!("plugin.{kind}").as_str()) {
                return Err(ProjectionError::Incompatible(Incompatibility::Plugin(kind.chars().take(32).collect())));
            }
            if kind == "brand_bug"
                && let Some(config) = plugin.get("config")
                && let (Some(asset_id), Some(variant_id)) = (
                    config.get("imageAssetId").and_then(Value::as_str),
                    config.get("imageVariantId").and_then(Value::as_str),
                )
            {
                let asset = self.asset(asset_id, variant_id).ok_or(ProjectionError::Reference)?;
                aliases.push(MediaAlias {
                    asset_id: asset.asset_id,
                    variant_id: asset.variant_id,
                    uri: content_uri(&asset.digest),
                });
                if !content.iter().any(|existing: &VerifiedContentRef| existing.sha256 == asset.digest) {
                    content.push(Self::content_ref(asset)?);
                }
            }
            plugins.push(plugin.clone());
        }
        Ok((plugins, aliases, content))
    }

    /// The group timeline when this screen is in a synchronized group. The
    /// anchor is the takeover's, the Quick Present's or the active schedule
    /// window's start, and otherwise the group's playback epoch.
    fn group_timing(&self, selection: &Selection, items: &[Value], source: &[Value]) -> Option<GroupTiming> {
        let group = self.document().get("syncGroup").filter(|group| !group.is_null())?;
        let group_id = group.get("id")?.as_str()?.to_owned();
        let epoch = group.get("playbackEpoch")?.as_str()?.parse::<jiff::Timestamp>().ok()?.as_millisecond();
        if items.is_empty() {
            return None;
        }
        let anchor_ms = match selection.source {
            Source::Takeover | Source::QuickPresent | Source::Schedule => selection.playback_anchor_ms.unwrap_or(epoch),
            Source::Direct | Source::None => epoch,
        };
        let durations_ms = items
            .iter()
            .map(|built| {
                let item = source
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == built.get("id").and_then(Value::as_str));
                self.effective_duration_ms(built, item)
            })
            .collect();
        Some(GroupTiming { group_id, anchor_ms, durations_ms })
    }

    /// The reference player's `effectiveDurationMs`, shared with Android: only
    /// the manifest carries an authored duration; a video otherwise runs its
    /// trimmed length, other interactive kinds 30 s, anything else 10 s.
    fn effective_duration_ms(&self, built: &Value, item: Option<&Value>) -> u64 {
        let authored = item.and_then(|item| item.get("durationMs")).and_then(Value::as_u64).filter(|ms| *ms > 0);
        let kind = built.get("kind").and_then(Value::as_str).unwrap_or("");
        let built_duration = built.get("durationMs").and_then(Value::as_u64);
        let explicit = if kind == "video" { authored } else { authored.or(built_duration) };
        if let Some(ms) = explicit.filter(|ms| *ms > 0) {
            return ms;
        }
        match kind {
            "website" | "widget" | "layout" | "youtube" => 30_000,
            "video" => {
                let offset = |key: &str| item.and_then(|item| item.get(key)).and_then(Value::as_u64);
                let start = offset("videoStartOffsetMs")
                    .or_else(|| built.get("videoStartOffsetMs").and_then(Value::as_u64))
                    .unwrap_or(0);
                let asset_seconds = item
                    .and_then(|item| {
                        let asset = self.asset(item.get("assetId")?.as_str()?, item.get("variantId")?.as_str()?)?;
                        self.asset_value(asset)?.get("durationSeconds")?.as_f64()
                    })
                    .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                    .map(|seconds| (seconds * 1_000.0).round() as u64);
                match offset("videoEndOffsetMs")
                    .or_else(|| built.get("videoEndOffsetMs").and_then(Value::as_u64))
                    .or(asset_seconds)
                {
                    Some(end) => end.saturating_sub(start).max(1),
                    None => 10_000,
                }
            }
            _ => 10_000,
        }
    }

    /// Resolves the server-compiled manifest at one corrected server instant
    /// under the accepted player configuration.
    pub fn resolve(&self, now_ms: i64, config: &WindowsPlayerConfig) -> Result<ResolvedPresentation, ProjectionError> {
        let selection = player_core::resolve(self.document(), now_ms).map_err(|_| ProjectionError::Schedule)?;
        let availability = next_availability_transition(self.document(), now_ms)?;
        let next_transition_ms = match (selection.next_transition_ms, availability) {
            (Some(schedule), Some(content)) => Some(schedule.min(content)),
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        };
        let (plugins, plugin_aliases, plugin_content) = self.plugins()?;
        let finish =
            |document: Value, mut content: Vec<VerifiedContentRef>, projection: Option<Value>, selection: Selection| {
                for reference in &plugin_content {
                    if !content.iter().any(|existing| existing.sha256 == reference.sha256) {
                        content.push(reference.clone());
                    }
                }
                ResolvedPresentation {
                    document,
                    timing: None,
                    content,
                    projection,
                    plugins: plugins.clone(),
                    plugin_aliases: plugin_aliases.clone(),
                    selection,
                    next_transition_ms,
                }
            };

        if let (Some(layout_id), None) = (selection.layout_id, selection.playlist_id) {
            let (projection, content) = self.projection(config)?;
            let document = serde_json::json!({
                "state": "playing",
                "items": [{
                    "id": format!("{LAYOUT_ITEM_PREFIX}{layout_id}"),
                    "kind": "layout",
                    "src": "",
                    "durationMs": Value::Null,
                    "fitMode": "contain",
                    "transition": "none",
                    "audioEnabled": false,
                    "volume": 0.0,
                    "videoStartOffsetMs": Value::Null,
                    "videoEndOffsetMs": Value::Null,
                    "layout": {"layoutId": layout_id.to_string()},
                }],
                "generation": self.native.version.max(0) as u64,
                "synchronized": false,
            });
            return Ok(finish(document, content, Some(projection), selection));
        }

        let Some(playlist_id) = selection.playlist_id else {
            let branding = &config.runtime.branding;
            let (document, content) = self.status(
                "idle",
                branding.no_content_title.as_deref().unwrap_or("No content assigned"),
                branding.no_content_message.as_deref().unwrap_or(""),
                "no_content",
                now_ms,
                config,
            )?;
            return Ok(finish(document, content, None, selection));
        };
        let playlist = playlists_of(self.document())
            .find(|playlist| playlist.get("id").and_then(Value::as_str) == Some(&playlist_id.to_string()))
            .ok_or(ProjectionError::Reference)?;
        let source_items = playlist.get("items").and_then(Value::as_array).ok_or(ProjectionError::Structure)?;
        let mut items = Vec::with_capacity(source_items.len());
        let mut content_by_digest = BTreeMap::new();
        let mut needs_projection = false;
        let mut skipped_unsupported = false;
        let span = span_viewport(self.document()).map_err(ProjectionError::Incompatible)?;
        // Images are cropped to the panel, as on Electron; Layouts are
        // clipped by the shared projector; Span video is a server-made panel
        // variant and is played as it is.
        for item in source_items {
            if !available_at(item, now_ms)? {
                continue;
            }
            let item_id = item.get("id").and_then(Value::as_str).ok_or(ProjectionError::Structure)?;
            let asset_type = item.get("assetType").and_then(Value::as_str).unwrap_or("");
            let authored_duration = match item.get("durationMs") {
                Some(Value::Number(value)) => Some(value.as_u64().ok_or(ProjectionError::Structure)?),
                None | Some(Value::Null) => None,
                _ => return Err(ProjectionError::Structure),
            };
            let settings = crate::player_config::item_settings(
                item.as_object().ok_or(ProjectionError::Structure)?,
                &config.runtime.playback,
                authored_duration,
            );
            let number = |key: &str| -> Result<Option<u64>, ProjectionError> {
                match item.get(key) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::Number(value)) => value.as_u64().map(Some).ok_or(ProjectionError::Structure),
                    _ => Err(ProjectionError::Structure),
                }
            };
            let mut built = serde_json::json!({
                "id": item_id.chars().take(128).collect::<String>(),
                "kind": "image",
                "src": "",
                "durationMs": settings.duration_ms,
                "fitMode": settings.fit_mode,
                "transition": settings.transition,
                "audioEnabled": settings.audio_enabled,
                "volume": settings.volume,
                "videoStartOffsetMs": Value::Null,
                "videoEndOffsetMs": Value::Null,
            });
            if let Some(layout_id) = item.get("layoutId").and_then(Value::as_str) {
                built["kind"] = Value::String("layout".into());
                built["layout"] = serde_json::json!({ "layoutId": layout_id });
                needs_projection = true;
                items.push(built);
                continue;
            }
            let asset_id = item.get("assetId").and_then(Value::as_str).ok_or(ProjectionError::Reference)?;
            if asset_type == "widget" || self.widget(asset_id).is_some() {
                self.widget(asset_id).ok_or(ProjectionError::Reference)?;
                built["kind"] = Value::String("widget".into());
                built["widget"] = serde_json::json!({ "widgetAssetId": asset_id });
                needs_projection = true;
                items.push(built);
                continue;
            }
            if asset_type == "website" {
                if !self.website_item(&mut built, asset_id, config, now_ms, &mut content_by_digest)? {
                    skipped_unsupported = true;
                    continue;
                }
                items.push(built);
                continue;
            }
            let variant_id = item.get("variantId").and_then(Value::as_str).ok_or(ProjectionError::Reference)?;
            let asset = self.asset(asset_id, variant_id).ok_or(ProjectionError::Reference)?;
            let asset_value = self.asset_value(asset).ok_or(ProjectionError::Reference)?;
            if !available_at(asset_value, now_ms)? {
                continue;
            }
            let kind = if asset.mime_type.starts_with("image/") {
                "image"
            } else if asset.mime_type.starts_with("video/") {
                "video"
            } else {
                return Err(ProjectionError::Incompatible(Incompatibility::ContentType(
                    asset.mime_type.chars().take(32).collect(),
                )));
            };
            built["kind"] = Value::String(kind.into());
            if kind == "video" {
                built["videoStartOffsetMs"] = number("videoStartOffsetMs")?.into();
                built["videoEndOffsetMs"] = number("videoEndOffsetMs")?.into();
            } else if let Some(span) = span.clone() {
                built["viewport"] = span;
            }
            built["src"] = Value::String(content_uri(&asset.digest));
            content_by_digest.entry(asset.digest).or_insert(Self::content_ref(asset)?);
            items.push(built);
        }
        // Synchronized groups fail closed: removing an entry changes their
        // shared timeline.
        let synchronized = self.document().get("syncGroup").is_some_and(|group| !group.is_null());
        if items.is_empty() || (synchronized && skipped_unsupported) {
            let (document, content) = self.status(
                "unavailable",
                "Content unavailable",
                "Assigned content is not currently available.",
                "unavailable",
                now_ms,
                config,
            )?;
            return Ok(finish(document, content, None, selection));
        }
        let mut content: Vec<VerifiedContentRef> = content_by_digest.into_values().collect();
        let projection = if needs_projection {
            let (projection, projection_content) = self.projection(config)?;
            for reference in projection_content {
                if !content.iter().any(|existing| existing.sha256 == reference.sha256) {
                    content.push(reference);
                }
            }
            Some(projection)
        } else {
            None
        };
        let timing = self.group_timing(&selection, &items, source_items);
        let document = serde_json::json!({
            "state": "playing",
            "items": items,
            "generation": self.native.version.max(0) as u64,
            "takeover": selection.source == Source::Takeover,
            "synchronized": timing.is_some(),
        });
        let mut resolved = finish(document, content, projection, selection);
        resolved.timing = timing;
        Ok(resolved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn website_native() -> NativeManifest {
        NativeManifest {
            digest: player_types::Sha256Digest::from_bytes([7; 32]),
            document: serde_json::json!({
                "websites": [{
                    "assetId": "site-1",
                    "url": "https://example.com/board",
                    "allowedHosts": ["example.com"],
                    "zoomPercent": 125,
                    "backgroundColor": "#112233",
                }],
            }),
            version: 1,
            screen_id: player_types::ScreenId::from_uuid(uuid::Uuid::from_u128(3)),
            assets: Vec::new(),
            required_downloads: Vec::new(),
            required_bundles: Vec::new(),
        }
    }

    #[test]
    fn website_items_project_with_config_overrides() {
        let native = website_native();
        let projector = Projector::new(&native);
        let mut config = WindowsPlayerConfig::default();
        config.runtime.website.timeout_seconds = Some(45);
        let mut built = serde_json::json!({"id": "item-1"});
        let mut content = BTreeMap::new();
        assert!(projector.website_item(&mut built, "site-1", &config, 1_000, &mut content).expect("projects"));
        assert_eq!(built["kind"].as_str(), Some("website"));
        assert_eq!(built["src"].as_str(), Some("https://example.com/board"));
        assert_eq!(built["website"]["loadTimeoutSeconds"].as_u64(), Some(45));
        assert_eq!(built["website"]["zoomPercent"].as_u64(), Some(125));
        assert_eq!(built["website"]["backgroundColor"].as_str(), Some("#112233"));
        assert_eq!(built["website"]["cookiePolicy"].as_str(), Some("first_party"));
        assert_eq!(built["website"]["reloadPolicy"].as_str(), Some("on_each_activation"));
        assert!(content.is_empty());
    }

    #[test]
    fn website_items_skip_without_a_usable_site() {
        let native = website_native();
        let projector = Projector::new(&native);
        let config = WindowsPlayerConfig::default();
        let mut built = serde_json::json!({"id": "item-1"});
        let mut content = BTreeMap::new();
        assert!(!projector.website_item(&mut built, "missing", &config, 1_000, &mut content).expect("answers"));
    }
}
