//! Presentation projection and the offline activation host.
//!
//! Schedule selection itself is Core's [`player_core::resolve`]; this
//! module projects the selection into a renderer document the way the
//! reference player builds it, onto Android shapes: `state`-tagged
//! JSON documents for the renderer engine, canonical `tcmedia:`
//! grant URIs for the media bridge, and [`AndroidPlayerConfig`]
//! sections for defaults. The projection follows Edge's candidate
//! projection over the same server manifest; only the document
//! envelope and the content URI scheme are Android's.
//!
//! `SelectionHost` implements Core's [`player_core::OfflineActivationHost`]:
//! Core drives gates, pending trials, evidence-gated promotion, and the
//! offline loop; the host projects, activates, and reports what is on
//! screen.

use std::collections::BTreeMap;
use std::sync::Arc;

use player_core::{
    ActivationSource, ActivationTime, ManifestAsset, NativeConfiguration, NativeManifest, OfflineActivationHost,
    OfflineCurrent, OfflineProjection, OfflineRendererHealth, RendererActivationRef, RendererRequirement, Selection,
    Source,
};
use player_types::Sha256Digest;
use serde_json::{Map, Value};
use tokio::sync::{Mutex, Notify};
use tokio_util::sync::CancellationToken;

use crate::config_host::{AndroidConfigHost, AndroidPlayerConfig, Playback};
use crate::renderer::{ActivateRequest, ActivationContent, PlaybackIdentity, PresentationEngine};

/// Why a manifest could not become a presentation. Codes mirror Edge's
/// manifest reason codes so Studio sees one vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    Structure,
    Bound,
    Asset,
    Reference,
    Schedule,
    Incompatible(Incompatibility),
}

impl ManifestError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Structure => "manifest_structure_invalid",
            Self::Bound => "manifest_bound_exceeded",
            Self::Asset => "manifest_asset_invalid",
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

/// A synchronized group's timeline for one presentation (the reference
/// player's `enrichSynchronizedPresentation`): every member places the
/// same items on the same anchor with the same effective durations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupTiming {
    pub group_id: String,
    /// Corrected Unix milliseconds.
    pub anchor_ms: i64,
    pub durations_ms: Vec<u64>,
}

/// What the renderer shows and why.
#[derive(Debug, Clone)]
pub struct ResolvedPresentation {
    pub document: Value,
    /// The shared timeline of a synchronized group, when the screen
    /// belongs to one and shows a playlist.
    pub timing: Option<GroupTiming>,
    pub content: Vec<ActivationContent>,
    pub projection: Option<Value>,
    pub plugins: Vec<Value>,
    pub plugin_aliases: Vec<Value>,
    pub selection: Selection,
    pub next_transition_ms: Option<i64>,
}

#[derive(Debug, PartialEq)]
pub(crate) struct SelectionKey {
    playlist: Option<uuid::Uuid>,
    layout: Option<uuid::Uuid>,
    schedule: Option<uuid::Uuid>,
    takeover: Option<uuid::Uuid>,
}

impl From<&PlaybackIdentity> for SelectionKey {
    fn from(identity: &PlaybackIdentity) -> Self {
        Self {
            playlist: identity.playlist_id,
            layout: identity.layout_id,
            schedule: identity.schedule_id,
            takeover: identity.takeover_id,
        }
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct PresentationKey {
    document: Value,
    content: Vec<ActivationContent>,
    timing: Option<(String, i64, Vec<u64>)>,
    identity: Option<SelectionKey>,
}

/// The projection size bound, shared with Edge's IPC event limit.
const MAX_PROJECTION_BYTES: usize = 3 * 1024 * 1024;

const LAYOUT_ITEM_PREFIX: &str = "layout-";
const MAX_SPAN_EDGE: u64 = 65_536;

fn availability_window(value: &Value) -> Result<(Option<i64>, Option<i64>), ManifestError> {
    let parse = |key: &str| -> Result<Option<i64>, ManifestError> {
        match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => player_types::Timestamp::parse(text)
                .map(|value| Some(value.unix_millis()))
                .map_err(|_| ManifestError::Structure),
            _ => Err(ManifestError::Structure),
        }
    };
    let from = parse("availableFrom")?;
    let until = parse("expiresAt")?;
    if from.zip(until).is_some_and(|(from, until)| from >= until) {
        return Err(ManifestError::Structure);
    }
    Ok((from, until))
}

fn available_at(value: &Value, now_ms: i64) -> Result<bool, ManifestError> {
    let (from, until) = availability_window(value)?;
    Ok(from.is_none_or(|from| now_ms >= from) && until.is_none_or(|until| now_ms < until))
}

fn playlists_of(document: &Value) -> impl Iterator<Item = &Value> {
    ["playlist", "directFallbackPlaylist"]
        .into_iter()
        .filter_map(|key| document.get(key).filter(|value| !value.is_null()))
        .chain(document.get("playlists").and_then(Value::as_array).into_iter().flatten())
}

fn next_availability_transition(document: &Value, now_ms: i64) -> Result<Option<i64>, ManifestError> {
    let mut next = None;
    let mut observe = |value: &Value| -> Result<(), ManifestError> {
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

fn is_remote_url(url: &str) -> bool {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
    let Some(rest) = rest else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    url.len() <= 2048
        && url.bytes().all(|byte| byte.is_ascii_graphic())
        && !authority.is_empty()
        && !authority.contains('@')
        && !authority.starts_with(':')
}

/// This screen's panel of a Span canvas, in the runtime's
/// `RuntimeViewport` shape. Both objects must be present and the panel
/// must lie inside the canvas; the server validates the same geometry.
fn span_viewport(document: &Value) -> Result<Option<Value>, Incompatibility> {
    let present = |key: &str| document.get(key).filter(|value| !value.is_null());
    let (canvas, viewport) = match (present("canvas"), present("viewport")) {
        (None, None) => return Ok(None),
        (Some(canvas), Some(viewport)) => (canvas, viewport),
        _ => return Err(Incompatibility::SpanViewport),
    };
    let field = |value: &Value, key: &str, max: u64| {
        value.get(key).and_then(Value::as_u64).filter(|n| *n <= max).ok_or(Incompatibility::SpanViewport)
    };
    let (canvas_width, canvas_height) =
        (field(canvas, "width", MAX_SPAN_EDGE)?, field(canvas, "height", MAX_SPAN_EDGE)?);
    let (x, y) = (field(viewport, "x", MAX_SPAN_EDGE)?, field(viewport, "y", MAX_SPAN_EDGE)?);
    let (width, height) = (field(viewport, "width", MAX_SPAN_EDGE)?, field(viewport, "height", MAX_SPAN_EDGE)?);
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
                serde_json::json!(value.as_u64().filter(|n| *n <= MAX_SPAN_EDGE).ok_or(Incompatibility::SpanViewport)?);
        }
    }
    Ok(Some(out))
}

fn fallback_duration_ms(asset_type: &str, default_image_ms: u64) -> Option<u64> {
    match asset_type {
        "image" => Some(default_image_ms),
        "video" => None,
        "website" => Some(60_000),
        _ => Some(30_000),
    }
}

fn fit(value: &str) -> &'static str {
    match value {
        "cover" => "cover",
        "stretch" => "stretch",
        _ => "contain",
    }
}

fn transition(value: &str) -> &'static str {
    match value {
        "fade" => "fade",
        "crossfade" => "crossfade",
        _ => "none",
    }
}

/// One item resolved against the playback defaults.
struct ItemSettings {
    duration_ms: Option<u64>,
    fit_mode: &'static str,
    transition: &'static str,
    audio_enabled: bool,
    volume: f64,
}

fn item_settings(item: &Map<String, Value>, playback: &Playback, authored_duration_ms: Option<u64>) -> ItemSettings {
    let asset_type = item.get("assetType").and_then(Value::as_str).unwrap_or("");
    let fallback = fallback_duration_ms(asset_type, playback.default_image_duration_ms);
    let delegates = item.get("usePlayerDefaults").and_then(Value::as_bool) == Some(true);
    let authored = |key: &str| item.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
    let default_fit = playback.default_fit_mode.as_deref().unwrap_or("contain");
    let default_transition = playback.default_transition.as_deref().unwrap_or("none");
    let fit_mode = if delegates { default_fit } else { authored("fitMode").unwrap_or(default_fit) };
    let transition_mode =
        if delegates { default_transition } else { authored("transition").unwrap_or(default_transition) };
    let item_volume = item.get("volume").and_then(Value::as_f64).filter(|volume| volume.is_finite());
    let volume = match (delegates, item_volume) {
        (false, Some(volume)) => volume,
        _ => playback.default_volume,
    }
    .clamp(0.0, 1.0);
    let audio_enabled = match (delegates, item.get("audioEnabled").and_then(Value::as_bool)) {
        (false, Some(enabled)) => enabled,
        _ => playback.default_audio_enabled,
    };
    let duration_ms = if delegates && asset_type == "image" { fallback } else { authored_duration_ms.or(fallback) };
    ItemSettings {
        duration_ms,
        fit_mode: fit(fit_mode),
        transition: transition(transition_mode),
        audio_enabled,
        volume,
    }
}

/// The canonical grant URI Android's media bridge authorizes:
/// `tcmedia://variant/<assetId>/<variantId>`.
fn tcmedia_uri(asset_id: &uuid::Uuid, variant_id: &uuid::Uuid) -> String {
    format!("tcmedia://variant/{asset_id}/{variant_id}")
}

fn find_asset<'a>(assets: &'a [ManifestAsset], asset_id: &str, variant_id: &str) -> Option<&'a ManifestAsset> {
    let key: (uuid::Uuid, uuid::Uuid) = (asset_id.parse().ok()?, variant_id.parse().ok()?);
    assets.iter().find(|asset| (asset.asset_id, asset.variant_id) == key)
}

fn asset_value<'a>(document: &'a Value, asset: &ManifestAsset) -> Option<&'a Value> {
    document.get("assets")?.as_array()?.iter().find(|value| {
        value.get("assetId").and_then(Value::as_str) == Some(&asset.asset_id.to_string())
            && value.get("variantId").and_then(Value::as_str) == Some(&asset.variant_id.to_string())
    })
}

fn content_ref(asset: &ManifestAsset) -> Result<ActivationContent, ManifestError> {
    Ok(ActivationContent {
        asset_id: asset.asset_id,
        variant_id: asset.variant_id,
        digest: asset.digest,
        size_bytes: asset.size_bytes,
        mime_type: player_types::bounded::SafeText::new(&asset.mime_type).map_err(|_| ManifestError::Asset)?,
    })
}

fn media_alias(asset: &ManifestAsset) -> Value {
    serde_json::json!({
        "assetId": asset.asset_id.to_string(),
        "variantId": asset.variant_id.to_string(),
        "uri": tcmedia_uri(&asset.asset_id, &asset.variant_id),
    })
}

fn find_widget<'a>(document: &'a Value, asset_id: &str) -> Option<&'a Value> {
    document
        .get("widgets")?
        .as_array()?
        .iter()
        .find(|widget| widget.get("assetId").and_then(Value::as_str) == Some(asset_id))
}

/// A branded status surface: idle, disabled, or unavailable. The
/// manifest's branding logo travels as granted content when it names a
/// usable asset, exactly as the reference player falls back.
fn status_surface(
    candidate: &NativeManifest,
    state: &str,
    title: &str,
    message: &str,
    status: &str,
    now_ms: i64,
    config: &AndroidPlayerConfig,
) -> Result<(Value, Vec<ActivationContent>), ManifestError> {
    let mut content = Vec::new();
    let logo = candidate
        .document
        .get("branding")
        .filter(|value| !value.is_null())
        .and_then(|branding| {
            find_asset(
                &candidate.assets,
                branding.get("logoAssetId")?.as_str()?,
                branding.get("logoVariantId")?.as_str()?,
            )
        })
        .filter(|asset| {
            asset_value(&candidate.document, asset).is_some_and(|value| available_at(value, now_ms).unwrap_or(false))
        });
    let logo_src = match logo {
        Some(asset) => {
            content.push(content_ref(asset)?);
            Some(Value::String(tcmedia_uri(&asset.asset_id, &asset.variant_id)))
        }
        None => None,
    };
    let branding = &config.runtime.branding;
    let mut surface = serde_json::json!({
        "state": state,
        "title": title.chars().take(240).collect::<String>(),
        "message": message.chars().take(1000).collect::<String>(),
        "backgroundColor": branding.background(),
        "textColor": branding.text(),
        "footerText": branding.footer_text.as_deref().unwrap_or(""),
        "status": status,
    });
    if let Some(logo_src) = logo_src {
        surface["logoSrc"] = logo_src;
    }
    Ok((surface, content))
}

/// The branded surface for a screen whose playback an administrator
/// disabled (the reference player's `brandingFallback`).
fn disabled_surface(
    candidate: &NativeManifest,
    now_ms: i64,
    config: &AndroidPlayerConfig,
) -> Result<(Value, Vec<ActivationContent>), ManifestError> {
    let branding = &config.runtime.branding;
    status_surface(
        candidate,
        "disabled",
        branding.disabled_title.as_deref().unwrap_or("Screen disabled"),
        branding.disabled_message.as_deref().unwrap_or(""),
        "disabled",
        now_ms,
        config,
    )
}

/// A Website asset as the reference player builds it: the server's
/// Website configuration, with the player configuration's `website`
/// overrides. Returns `false` when the manifest has no usable Website
/// for the asset; the reference player then skips the item.
#[allow(clippy::too_many_arguments)]
fn website_item(
    built: &mut Map<String, Value>,
    candidate: &NativeManifest,
    asset_id: &str,
    config: &AndroidPlayerConfig,
    now_ms: i64,
    content: &mut BTreeMap<Sha256Digest, ActivationContent>,
) -> Result<bool, ManifestError> {
    let Some(site) = candidate
        .document
        .get("websites")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|site| site.get("assetId").and_then(Value::as_str) == Some(asset_id))
    else {
        return Ok(false);
    };
    let url = site.get("url").and_then(Value::as_str).unwrap_or("");
    if !is_remote_url(url) {
        return Ok(false);
    }
    let string = |key: &str| site.get(key).and_then(Value::as_str).unwrap_or("");
    let positive = |key: &str| site.get(key).and_then(Value::as_u64).filter(|value| *value > 0);
    let website = &config.runtime.website;
    let mut fallback_src = Value::Null;
    if let Some(fallback) = site.get("fallbackImageAssetId").and_then(Value::as_str) {
        let variant = site.get("fallbackVariantId").and_then(Value::as_str);
        let asset = candidate.assets.iter().find(|asset| {
            asset.asset_id.to_string() == fallback
                && variant.is_none_or(|variant| asset.variant_id.to_string() == variant)
                && asset_value(&candidate.document, asset)
                    .is_some_and(|value| available_at(value, now_ms).unwrap_or(false))
        });
        if let Some(asset) = asset {
            fallback_src = Value::String(tcmedia_uri(&asset.asset_id, &asset.variant_id));
            content.entry(asset.digest).or_insert(content_ref(asset)?);
        }
    }
    let hosts: Vec<Value> = site
        .get("allowedHosts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .take(25)
        .map(|host| Value::String(host.chars().take(253).collect()))
        .collect();
    built.insert("kind".to_owned(), Value::String("website".to_owned()));
    built.insert("src".to_owned(), Value::String(url.chars().take(2048).collect()));
    built.insert(
        "website".to_owned(),
        serde_json::json!({
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
        }),
    );
    Ok(true)
}

/// Resolves the server-compiled manifest at one corrected server instant
/// under the accepted player configuration.
pub fn presentation_with(
    candidate: &NativeManifest,
    now_ms: i64,
    config: &AndroidPlayerConfig,
) -> Result<ResolvedPresentation, ManifestError> {
    let selection = player_core::resolve(&candidate.document, now_ms).map_err(|_| ManifestError::Schedule)?;
    let availability = next_availability_transition(&candidate.document, now_ms)?;
    let next_transition_ms = match (selection.next_transition_ms, availability) {
        (Some(schedule), Some(content)) => Some(schedule.min(content)),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    };
    let (plugins, plugin_aliases, plugin_content) = plugins(candidate, now_ms)?;
    let finish =
        |document: Value, mut content: Vec<ActivationContent>, projection: Option<Value>, selection: Selection| {
            for reference in &plugin_content {
                if !content.iter().any(|existing| existing.digest == reference.digest) {
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
        let (projection, content) = projection(candidate, config)?;
        let document = serde_json::json!({
            "state": "playing",
            "items": [{
                "id": format!("{LAYOUT_ITEM_PREFIX}{layout_id}"),
                "kind": "layout",
                "src": "",
                "fitMode": "contain",
                "transition": "none",
                "audioEnabled": false,
                "volume": 0.0,
                "layout": { "layoutId": layout_id.to_string() },
            }],
            "takeover": false,
            "generation": candidate.version.max(0) as u64,
            "synchronized": false,
        });
        return Ok(finish(document, content, Some(projection), selection));
    }

    let Some(playlist_id) = selection.playlist_id else {
        let branding = &config.runtime.branding;
        let (document, content) = status_surface(
            candidate,
            "idle",
            branding.no_content_title.as_deref().unwrap_or("No content assigned"),
            branding.no_content_message.as_deref().unwrap_or(""),
            "no_content",
            now_ms,
            config,
        )?;
        return Ok(finish(document, content, None, selection));
    };
    let playlist = playlists_of(&candidate.document)
        .find(|playlist| playlist.get("id").and_then(Value::as_str) == Some(&playlist_id.to_string()))
        .ok_or(ManifestError::Reference)?;
    let source_items = playlist.get("items").and_then(Value::as_array).ok_or(ManifestError::Structure)?;
    let mut items = Vec::with_capacity(source_items.len());
    let mut content_by_digest = BTreeMap::new();
    let mut needs_projection = false;
    let span = span_viewport(&candidate.document).map_err(ManifestError::Incompatible)?;
    // Images are cropped to the panel, as on the reference player; Span
    // video is a server-made panel variant and is played as it is.
    for item in source_items {
        if !available_at(item, now_ms)? {
            continue;
        }
        let item_id = item.get("id").and_then(Value::as_str).ok_or(ManifestError::Structure)?;
        let asset_type = item.get("assetType").and_then(Value::as_str).unwrap_or("");
        let authored_duration = match item.get("durationMs") {
            Some(Value::Number(value)) => Some(value.as_u64().ok_or(ManifestError::Structure)?),
            None | Some(Value::Null) => None,
            _ => return Err(ManifestError::Structure),
        };
        let settings = item_settings(
            item.as_object().ok_or(ManifestError::Structure)?,
            &config.runtime.playback,
            authored_duration,
        );
        let number = |key: &str| -> Result<Option<u64>, ManifestError> {
            match item.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::Number(value)) => value.as_u64().map(Some).ok_or(ManifestError::Structure),
                _ => Err(ManifestError::Structure),
            }
        };
        let mut built = Map::new();
        built.insert("id".to_owned(), Value::String(item_id.chars().take(160).collect()));
        built.insert("kind".to_owned(), Value::String("image".to_owned()));
        built.insert("src".to_owned(), Value::String(String::new()));
        if let Some(duration_ms) = settings.duration_ms {
            built.insert("durationMs".to_owned(), Value::from(duration_ms));
        }
        built.insert("fitMode".to_owned(), Value::String(settings.fit_mode.to_owned()));
        built.insert("transition".to_owned(), Value::String(settings.transition.to_owned()));
        built.insert("audioEnabled".to_owned(), Value::Bool(settings.audio_enabled));
        built.insert("volume".to_owned(), serde_json::json!(settings.volume));
        if let Some(layout_id) = item.get("layoutId").and_then(Value::as_str) {
            built.insert("kind".to_owned(), Value::String("layout".to_owned()));
            built.insert("layout".to_owned(), serde_json::json!({ "layoutId": layout_id }));
            needs_projection = true;
            items.push(Value::Object(built));
            continue;
        }
        let asset_id = item.get("assetId").and_then(Value::as_str).ok_or(ManifestError::Reference)?;
        if asset_type == "widget" || find_widget(&candidate.document, asset_id).is_some() {
            find_widget(&candidate.document, asset_id).ok_or(ManifestError::Reference)?;
            // A web or YouTube Widget still travels as a reference: the
            // runtime's shared projection makes it a remote web item from
            // the server-compiled presentation.
            built.insert("kind".to_owned(), Value::String("widget".to_owned()));
            built.insert("widget".to_owned(), serde_json::json!({ "widgetAssetId": asset_id }));
            needs_projection = true;
            items.push(Value::Object(built));
            continue;
        }
        if asset_type == "website" {
            if website_item(&mut built, candidate, asset_id, config, now_ms, &mut content_by_digest)? {
                items.push(Value::Object(built));
            }
            continue;
        }
        let variant_id = item.get("variantId").and_then(Value::as_str).ok_or(ManifestError::Reference)?;
        let asset = find_asset(&candidate.assets, asset_id, variant_id).ok_or(ManifestError::Reference)?;
        let asset_value = asset_value(&candidate.document, asset).ok_or(ManifestError::Reference)?;
        if !available_at(asset_value, now_ms)? {
            continue;
        }
        if asset.mime_type.starts_with("image/") {
            built.insert("kind".to_owned(), Value::String("image".to_owned()));
            built.insert("viewport".to_owned(), span.clone().unwrap_or(Value::Null));
        } else if asset.mime_type.starts_with("video/") {
            built.insert("kind".to_owned(), Value::String("video".to_owned()));
            if let Some(offset) = number("videoStartOffsetMs")? {
                built.insert("videoStartOffsetMs".to_owned(), Value::from(offset));
            }
            if let Some(offset) = number("videoEndOffsetMs")? {
                built.insert("videoEndOffsetMs".to_owned(), Value::from(offset));
            }
        } else {
            return Err(ManifestError::Incompatible(Incompatibility::ContentType(
                asset.mime_type.chars().take(32).collect(),
            )));
        }
        built.insert("src".to_owned(), Value::String(tcmedia_uri(&asset.asset_id, &asset.variant_id)));
        content_by_digest.entry(asset.digest).or_insert(content_ref(asset)?);
        items.push(Value::Object(built));
    }
    if items.is_empty() {
        let (document, content) = status_surface(
            candidate,
            "unavailable",
            "Content unavailable",
            "Assigned content is not currently available.",
            "unavailable",
            now_ms,
            config,
        )?;
        return Ok(finish(document, content, None, selection));
    }
    let mut content: Vec<ActivationContent> = content_by_digest.into_values().collect();
    let projection = if needs_projection {
        let (projection, projection_content) = projection(candidate, config)?;
        for reference in projection_content {
            if !content.iter().any(|existing| existing.digest == reference.digest) {
                content.push(reference);
            }
        }
        Some(projection)
    } else {
        None
    };
    let timing = group_timing(candidate, &selection, &items, source_items);
    let document = serde_json::json!({
        "state": "playing",
        "items": items,
        "takeover": selection.source == Source::Takeover,
        "generation": candidate.version.max(0) as u64,
        "synchronized": timing.is_some(),
    });
    let mut resolved = finish(document, content, projection, selection);
    resolved.timing = timing;
    Ok(resolved)
}

/// The group timeline when this screen is in a synchronized group. The
/// anchor is the takeover's, the Quick Present's or the active schedule
/// window's start, and otherwise the group's playback epoch.
fn group_timing(
    candidate: &NativeManifest,
    selection: &Selection,
    items: &[Value],
    source: &[Value],
) -> Option<GroupTiming> {
    let group = candidate.document.get("syncGroup").filter(|group| !group.is_null())?;
    let group_id = group.get("id")?.as_str()?.to_owned();
    let epoch = player_types::Timestamp::parse(group.get("playbackEpoch")?.as_str()?).ok()?.unix_millis();
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
            effective_duration_ms(candidate, built, item)
        })
        .collect();
    Some(GroupTiming { group_id, anchor_ms, durations_ms })
}

/// The reference player's `effectiveDurationMs`: only the manifest
/// carries an authored duration; a video otherwise runs its trimmed
/// length, other interactive kinds 30 s, anything else 10 s.
fn effective_duration_ms(candidate: &NativeManifest, built: &Value, item: Option<&Value>) -> u64 {
    let kind = built.get("kind").and_then(Value::as_str).unwrap_or("");
    let authored = item.and_then(|item| item.get("durationMs")).and_then(Value::as_u64).filter(|ms| *ms > 0);
    let explicit =
        if kind == "video" { authored } else { authored.or(built.get("durationMs").and_then(Value::as_u64)) };
    if let Some(ms) = explicit.filter(|ms| *ms > 0) {
        return ms;
    }
    match kind {
        "website" | "widget" | "layout" | "youtube" => 30_000,
        "video" => {
            let offset = |key: &str| item.and_then(|item| item.get(key)).and_then(Value::as_u64);
            let start =
                offset("videoStartOffsetMs").or(built.get("videoStartOffsetMs").and_then(Value::as_u64)).unwrap_or(0);
            let asset_seconds = item
                .and_then(|item| {
                    let asset = find_asset(
                        &candidate.assets,
                        item.get("assetId")?.as_str()?,
                        item.get("variantId")?.as_str()?,
                    )?;
                    asset_value(&candidate.document, asset)?.get("durationSeconds")?.as_f64()
                })
                .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                .map(|seconds| (seconds * 1_000.0).round() as u64);
            match offset("videoEndOffsetMs").or(built.get("videoEndOffsetMs").and_then(Value::as_u64)).or(asset_seconds)
            {
                Some(end) => end.saturating_sub(start).max(1),
                None => 10_000,
            }
        }
        _ => 10_000,
    }
}

/// The manifest subset the trusted runtime's `renderWidget` and
/// `renderLayout` read, plus the media map for every asset variant.
fn projection(
    candidate: &NativeManifest,
    config: &AndroidPlayerConfig,
) -> Result<(Value, Vec<ActivationContent>), ManifestError> {
    let mut manifest = Map::new();
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
        if let Some(value) = candidate.document.get(key).filter(|value| !value.is_null()) {
            manifest.insert(key.to_owned(), value.clone());
        }
    }
    let mut media = Vec::with_capacity(candidate.assets.len());
    let mut content = Vec::with_capacity(candidate.assets.len());
    for asset in &candidate.assets {
        media.push(media_alias(asset));
        if !content.iter().any(|existing: &ActivationContent| existing.digest == asset.digest) {
            content.push(content_ref(asset)?);
        }
    }
    let manifest = Value::Object(manifest);
    if serde_json::to_vec(&manifest).map_or(true, |bytes| bytes.len() > MAX_PROJECTION_BYTES) {
        return Err(ManifestError::Bound);
    }
    let mut context = serde_json::json!({
        "schema": 1,
        "clockOffsetMs": 0,
        "manifest": manifest,
        "media": media,
    });
    if !config.runtime.playback.context.is_empty() {
        context["playback"] = Value::Object(config.runtime.playback.context.clone());
    }
    Ok((context, content))
}

/// Supported built-in plugins, their media aliases and content.
#[allow(clippy::type_complexity)]
fn plugins(
    candidate: &NativeManifest,
    now_ms: i64,
) -> Result<(Vec<Value>, Vec<Value>, Vec<ActivationContent>), ManifestError> {
    let mut plugins = Vec::new();
    let mut aliases = Vec::new();
    let mut content = Vec::new();
    for plugin in candidate.document.get("plugins").and_then(Value::as_array).into_iter().flatten() {
        let kind = plugin.get("type").and_then(Value::as_str).unwrap_or("");
        if !crate::manifest_host::profile::FEATURES.contains(&format!("plugin.{kind}").as_str()) {
            return Err(ManifestError::Incompatible(Incompatibility::Plugin(kind.chars().take(32).collect())));
        }
        if kind == "brand_bug"
            && let Some(config) = plugin.get("config")
            && let (Some(asset_id), Some(variant_id)) = (
                config.get("imageAssetId").and_then(Value::as_str),
                config.get("imageVariantId").and_then(Value::as_str),
            )
        {
            let asset = find_asset(&candidate.assets, asset_id, variant_id).ok_or(ManifestError::Reference)?;
            aliases.push(media_alias(asset));
            let _ = now_ms;
            if !content.iter().any(|existing: &ActivationContent| existing.digest == asset.digest) {
                content.push(content_ref(asset)?);
            }
        }
        plugins.push(plugin.clone());
    }
    Ok((plugins, aliases, content))
}

/// The surface for an activation gate. The disabled surface carries the
/// manifest's branding logo when a verified candidate is available.
fn gate_document(
    gate: player_core::ActivationGate,
    config: &AndroidPlayerConfig,
    candidate: Option<&NativeManifest>,
    now_ms: i64,
) -> (Value, Vec<ActivationContent>) {
    match gate {
        player_core::ActivationGate::Rest => {
            let power = &config.runtime.power;
            let branding = &config.runtime.branding;
            (
                serde_json::json!({
                    "state": "sleep",
                    "display": power.outside_display,
                    "text": power.outside_text,
                    "textColor": branding.text(),
                }),
                Vec::new(),
            )
        }
        player_core::ActivationGate::Disabled => {
            if let Some(Ok(surface)) = candidate.map(|candidate| disabled_surface(candidate, now_ms, config)) {
                return surface;
            }
            let branding = &config.runtime.branding;
            (
                serde_json::json!({
                    "state": "disabled",
                    "title": branding.disabled_title.as_deref().unwrap_or("Screen disabled"),
                    "message": branding.disabled_message.as_deref().unwrap_or(""),
                    "backgroundColor": branding.background(),
                    "textColor": branding.text(),
                    "footerText": branding.footer_text.as_deref().unwrap_or(""),
                    "status": "disabled",
                }),
                Vec::new(),
            )
        }
    }
}

fn identity(candidate: &NativeManifest, resolved: &ResolvedPresentation) -> PlaybackIdentity {
    let selection = &resolved.selection;
    PlaybackIdentity {
        manifest: candidate.digest,
        manifest_version: candidate.version,
        selection_source: match selection.source {
            Source::Takeover => "takeover",
            Source::QuickPresent => "quick_present",
            Source::Schedule => "schedule",
            Source::Direct => "direct",
            Source::None => "none",
        }
        .to_owned(),
        playlist_id: selection.playlist_id,
        layout_id: selection.layout_id,
        schedule_id: selection.schedule_id,
        takeover_id: selection.takeover_id,
    }
}

fn timing_value(timing: &GroupTiming) -> Value {
    serde_json::json!({
        "groupId": timing.group_id,
        "anchorMs": timing.anchor_ms,
        "durationsMs": timing.durations_ms,
    })
}

fn timing_key(timing: &GroupTiming) -> (String, i64, Vec<u64>) {
    (timing.group_id.clone(), timing.anchor_ms, timing.durations_ms.clone())
}

fn envelope(resolved: &ResolvedPresentation, offset_ms: i64) -> Value {
    serde_json::json!({
        "presentation": resolved.document,
        "timing": resolved.timing.as_ref().map(timing_value).unwrap_or(Value::Null),
        "projection": resolved.projection.clone().unwrap_or(Value::Null),
        "plugins": resolved.plugins,
        "pluginAliases": resolved.plugin_aliases,
        "clockOffsetMs": offset_ms,
    })
}

/// Shows a policy surface unless it is already on screen.
async fn show_policy(
    engine: &Arc<Mutex<PresentationEngine>>,
    document: Value,
    content: Vec<ActivationContent>,
    local_now_ms: i64,
) {
    let mut locked = engine.lock().await;
    let showing = locked.current_activation().is_some_and(|current| {
        current.source == ActivationSource::Policy && current.presentation == document && current.content == content
    });
    if showing {
        return;
    }
    let now = player_types::Timestamp::from_unix_millis(local_now_ms)
        .unwrap_or_else(|| player_types::Timestamp::from_unix_seconds(0).expect("epoch"));
    // The native crate carries no logger; a rejected policy surface
    // simply leaves the previous activation on screen.
    let _ = locked
        .activate_request(
            ActivateRequest {
                envelope: serde_json::json!({ "presentation": document }),
                content,
                source: ActivationSource::Policy,
                identity: None,
                clock_offset_ms: 0,
            },
            now,
        )
        .await;
}

/// The selection driver host: Core drives the offline activation loop
/// and this host projects, activates, and reports what is on screen.
pub(crate) struct SelectionHost {
    engine: Arc<Mutex<PresentationEngine>>,
    config: Arc<AndroidConfigHost>,
    manifest_wake: Arc<Notify>,
}

impl SelectionHost {
    pub fn new(
        engine: Arc<Mutex<PresentationEngine>>,
        config: Arc<AndroidConfigHost>,
        manifest_wake: Arc<Notify>,
    ) -> Self {
        Self { engine, config, manifest_wake }
    }

    fn effective(&self) -> Arc<AndroidPlayerConfig> {
        self.config.effective().unwrap_or_default()
    }
}

#[async_trait::async_trait]
impl OfflineActivationHost for SelectionHost {
    type Configuration = Arc<AndroidPlayerConfig>;
    type Projection = ResolvedPresentation;
    type Key = PresentationKey;

    fn configuration(&self) -> Self::Configuration {
        self.effective()
    }

    fn native_configuration<'a>(&self, configuration: &'a Self::Configuration) -> &'a NativeConfiguration {
        &configuration.native
    }

    fn project(
        &self,
        candidate: &NativeManifest,
        configuration: &Self::Configuration,
        time: ActivationTime,
    ) -> Result<OfflineProjection<Self::Projection, Self::Key>, &'static str> {
        let resolved =
            presentation_with(candidate, time.presentation_ms(), configuration).map_err(|error| error.reason_code())?;
        let metadata = crate::renderer::projection_metadata(&resolved.document, resolved.projection.as_ref())
            .map_err(|_| "presentation_requirements_invalid")?;
        let identity = identity(candidate, &resolved);
        let key = PresentationKey {
            document: resolved.document.clone(),
            content: resolved.content.clone(),
            // Clock correction must not restart an existing synchronized timeline.
            timing: resolved.timing.as_ref().map(timing_key),
            identity: Some(SelectionKey::from(&identity)),
        };
        let source = resolved.selection.source;
        let next_transition_ms = resolved.next_transition_ms;
        Ok(OfflineProjection {
            projection: resolved,
            key,
            source,
            requirements: metadata.requirements,
            next_transition_ms,
        })
    }

    async fn current(&self) -> Option<OfflineCurrent<Self::Key>> {
        let engine = self.engine.lock().await;
        engine.current_activation().map(|activation| OfflineCurrent {
            source: activation.source,
            manifest: activation.manifest,
            key: PresentationKey {
                document: activation.presentation.clone(),
                content: activation.content.clone(),
                timing: activation.timing.as_ref().and_then(|timing| {
                    Some((
                        timing.get("groupId")?.as_str()?.to_owned(),
                        timing.get("anchorMs")?.as_i64()?,
                        timing.get("durationsMs")?.as_array()?.iter().map(Value::as_u64).collect::<Option<Vec<_>>>()?,
                    ))
                }),
                identity: activation.identity.as_ref().map(SelectionKey::from),
            },
            accepted: engine.current_is_accepted(),
            evidence: engine.current_has_activation_evidence(),
            playing: activation.presentation.get("state").and_then(Value::as_str) == Some("playing")
                && activation
                    .presentation
                    .get("items")
                    .and_then(Value::as_array)
                    .is_some_and(|items| !items.is_empty()),
        })
    }

    async fn health(&self) -> OfflineRendererHealth {
        let engine = self.engine.lock().await;
        OfflineRendererHealth { safe_mode: engine.is_safe_mode(), current_error: engine.current_has_renderer_error() }
    }

    async fn set_clock_offset(&self, offset_ms: i64) {
        self.engine.lock().await.set_clock_offset(offset_ms);
    }

    async fn supports(&self, requirements: &[RendererRequirement]) -> bool {
        self.engine.lock().await.supports(requirements)
    }

    async fn show_gate(
        &self,
        gate: player_core::ActivationGate,
        candidate: Option<&NativeManifest>,
        configuration: &Self::Configuration,
        time: ActivationTime,
    ) {
        let (document, content) = gate_document(gate, configuration, candidate, time.presentation_ms());
        show_policy(&self.engine, document, content, time.local_ms).await;
    }

    async fn show_waiting(&self, now_ms: i64) {
        let config = self.effective();
        let branding = &config.runtime.branding;
        let document = serde_json::json!({
            "state": "idle",
            "title": branding.no_content_title.as_deref().unwrap_or("No content assigned"),
            "message": branding.no_content_message.as_deref().unwrap_or(""),
            "backgroundColor": branding.background(),
            "textColor": branding.text(),
            "footerText": branding.footer_text.as_deref().unwrap_or(""),
            "status": "no_content",
        });
        let mut engine = self.engine.lock().await;
        let now = player_types::Timestamp::from_unix_millis(now_ms)
            .unwrap_or_else(|| player_types::Timestamp::from_unix_seconds(0).expect("epoch"));
        let _ = engine
            .activate_request(
                ActivateRequest {
                    envelope: serde_json::json!({ "presentation": document }),
                    content: Vec::new(),
                    source: ActivationSource::StatusSurface,
                    identity: None,
                    clock_offset_ms: 0,
                },
                now,
            )
            .await;
    }

    async fn activate(
        &self,
        candidate: &NativeManifest,
        resolved: Self::Projection,
        time: ActivationTime,
    ) -> Result<RendererActivationRef, &'static str> {
        let identity = identity(candidate, &resolved);
        let request = ActivateRequest {
            envelope: envelope(&resolved, time.offset_ms),
            content: resolved.content.clone(),
            source: ActivationSource::ServerManifest,
            identity: Some(identity),
            clock_offset_ms: time.offset_ms,
        };
        let now = player_types::Timestamp::from_unix_millis(time.local_ms)
            .unwrap_or_else(|| player_types::Timestamp::from_unix_seconds(0).expect("epoch"));
        let outcome =
            self.engine.lock().await.activate_request(request, now).await.map_err(|_| "activation_rejected")?;
        let activation_id = outcome.activation_id.parse().map_err(|_| "activation_rejected")?;
        Ok(RendererActivationRef { activation_id, generation: outcome.generation })
    }

    fn promoted(&self) {
        self.manifest_wake.notify_one();
    }
}

/// Drives offline activation until shutdown: the committed presentation
/// re-resolved at every boundary, pending trials at item boundaries,
/// and promotion only on evidence.
pub(crate) async fn run_selection(
    core: player_core::PlayerCore,
    cas: player_cas::ContentStore,
    host: SelectionHost,
    manifest_wake: Arc<Notify>,
    item_boundary: Arc<std::sync::atomic::AtomicBool>,
    shutdown: CancellationToken,
) {
    let state = core.offline_activation(Some(cas));
    player_core::drive_offline_activation(
        state,
        &host,
        player_core::OfflineActivationSignals {
            wake: &manifest_wake,
            item_boundary: &item_boundary,
            shutdown: &shutdown,
        },
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: &str = "c791e841-b6ab-4e3f-a9f5-3b763cb47bd9";
    const ASSET: &str = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
    const VARIANT: &str = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";
    const ITEM: &str = "ca48c671-8e48-4bad-ab75-6125064d0f5c";
    const PLAYLIST: &str = "e719e602-3b8f-4a2f-bec5-24b16e14725f";
    const LAYOUT: &str = "5e2b86f4-4d49-4a8e-b0a4-2b5c1c9f7d10";
    const WIDGET: &str = "0c3e1d2f-7a55-4b1e-9c33-6f0d2e8a4b91";
    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn manifest_id() -> Sha256Digest {
        Sha256Digest::of(b"manifest")
    }

    fn manifest() -> Value {
        serde_json::json!({
            "schemaVersion": 11, "manifestVersion": 8, "screenId": SCREEN, "mode": "presentation",
            "assets": [{"assetId": ASSET, "variantId": VARIANT, "sha256": DIGEST,
                "fileSize": 100, "mimeType": "image/png",
                "downloadPath": format!("/api/v1/player/assets/{ASSET}/variants/{VARIANT}")}],
            "playlist": {"id": PLAYLIST, "items": [{
                "id": ITEM, "assetId": ASSET, "variantId": VARIANT,
                "assetType": "image", "deliveryPolicy": "automatic", "durationMs": 10000,
                "fitMode": "cover", "transition": "fade", "audioEnabled": true, "volume": 0.8
            }]},
            "playlists": [], "schedules": [], "websites": [], "widgets": [], "dataSources": [],
            "plugins": [], "layouts": []
        })
    }

    fn parse(value: Value) -> Result<NativeManifest, player_core::NativeManifestError> {
        NativeManifest::parse(value, SCREEN.parse().expect("screen"), manifest_id())
    }

    fn project(value: Value, now_ms: i64) -> Result<ResolvedPresentation, ManifestError> {
        let candidate = parse(value).expect("fixture parses");
        presentation_with(&candidate, now_ms, &AndroidPlayerConfig::default())
    }

    #[test]
    fn resolves_server_playlist_into_playing_document() {
        let resolved = project(manifest(), 1_000).expect("playing");
        assert_eq!(resolved.document["state"], "playing");
        assert_eq!(resolved.document["takeover"], false);
        assert_eq!(resolved.document["generation"], 8);
        assert_eq!(resolved.document["synchronized"], false);
        let items = resolved.document["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], ITEM);
        assert_eq!(items[0]["kind"], "image");
        assert_eq!(items[0]["src"], format!("tcmedia://variant/{ASSET}/{VARIANT}"));
        assert_eq!(items[0]["durationMs"], 10_000);
        assert_eq!(items[0]["fitMode"], "cover");
        assert_eq!(items[0]["transition"], "fade");
        assert_eq!(resolved.content.len(), 1);
        assert!(resolved.projection.is_none());
        assert_eq!(resolved.selection.source, Source::Direct);
    }

    #[test]
    fn availability_is_half_open_and_rechecks_at_its_boundary() {
        let mut value = manifest();
        value["playlist"]["items"][0]["availableFrom"] = serde_json::json!("1970-01-01T00:00:02Z");
        let before = project(value.clone(), 1_000).expect("unavailable");
        assert_eq!(before.document["state"], "unavailable");
        assert_eq!(before.next_transition_ms, Some(2_000));
        let at_boundary = project(value, 2_000).expect("playing");
        assert_eq!(at_boundary.document["state"], "playing");
    }

    #[test]
    fn nothing_selected_is_the_branded_idle_surface() {
        let mut value = manifest();
        value.as_object_mut().expect("object").remove("playlist");
        let resolved = project(value, 1_000).expect("idle");
        assert_eq!(resolved.document["state"], "idle");
        assert_eq!(resolved.document["status"], "no_content");
        assert_eq!(resolved.document["title"], "No content assigned");
    }

    #[test]
    fn malformed_durations_are_typed_not_guessed() {
        let mut value = manifest();
        value["playlist"]["items"][0]["durationMs"] = serde_json::json!("ten seconds");
        let candidate = parse(value).expect("fixture parses");
        assert_eq!(
            presentation_with(&candidate, 1_000, &AndroidPlayerConfig::default()).expect_err("structure"),
            ManifestError::Structure
        );
    }

    #[test]
    fn unknown_media_types_are_typed_not_dropped() {
        let mut value = manifest();
        value["assets"][0]["mimeType"] = serde_json::json!("application/pdf");
        let candidate = parse(value).expect("fixture parses");
        assert_eq!(
            presentation_with(&candidate, 1_000, &AndroidPlayerConfig::default()).expect_err("content type"),
            ManifestError::Incompatible(Incompatibility::ContentType("application/pdf".to_owned()))
        );
    }

    #[test]
    fn brand_bug_is_rejected_without_a_surface() {
        let mut value = manifest();
        value["plugins"] = serde_json::json!([{"id": ITEM, "type": "brand_bug", "version": 1, "config": {}}]);
        let candidate = parse(value).expect("fixture parses");
        assert_eq!(
            presentation_with(&candidate, 1_000, &AndroidPlayerConfig::default()).expect_err("plugin"),
            ManifestError::Incompatible(Incompatibility::Plugin("brand_bug".to_owned()))
        );
        // The countdown bar the Android runtime implements passes through.
        let mut value = manifest();
        value["plugins"] = serde_json::json!([{"id": ITEM, "type": "countdown_bar", "version": 1, "config": {}}]);
        let resolved = project(value, 1_000).expect("playing");
        assert_eq!(resolved.plugins.len(), 1);
    }

    const WEBSITE: &str = "2f1c0e3d-5a7b-4c9d-8e1f-0a2b3c4d5e6f";

    fn site() -> Value {
        serde_json::json!({"assetId": WEBSITE, "name": "Menu", "url": "https://menu.example.org/today",
            "allowedHosts": ["menu.example.org"], "javascriptEnabled": true, "domStorageEnabled": false,
            "cookiePolicy": "first_party", "reloadPolicy": "interval", "refreshIntervalSeconds": 120,
            "loadTimeoutSeconds": 25, "zoomPercent": 0, "scrollX": 0, "scrollY": 300, "customUserAgent": "",
            "backgroundColor": "#101820", "failureBehavior": "fallback_image",
            "fallbackImageAssetId": ASSET, "fallbackVariantId": VARIANT})
    }

    fn website_manifest(site: Value) -> Value {
        let mut value = manifest();
        value["schemaVersion"] = serde_json::json!(15);
        value["websites"] = serde_json::json!([site]);
        value["playlist"]["items"] = serde_json::json!([{
            "id": ITEM, "assetId": WEBSITE, "assetType": "website", "deliveryPolicy": "stream",
            "durationMs": 45000, "fitMode": "cover", "transition": "fade", "audioEnabled": false, "volume": 1
        }]);
        value
    }

    #[test]
    fn website_assets_play_from_the_server_configuration() {
        let candidate = parse(website_manifest(site())).expect("parses");
        let mut config = AndroidPlayerConfig::default();
        config.runtime.website.cookie_policy = Some("disabled".to_owned());
        config.runtime.website.default_zoom_percent = Some(125);
        let resolved = presentation_with(&candidate, 1_000, &config).expect("playing");
        let items = resolved.document["items"].as_array().expect("items");
        assert_eq!(items[0]["kind"], "website");
        assert_eq!(items[0]["src"], "https://menu.example.org/today");
        let website = &items[0]["website"];
        assert_eq!(website["cookiePolicy"], "disabled", "the player configuration overrides the policy");
        assert_eq!(website["zoomPercent"], 125, "a Website without its own zoom takes the default");
        assert_eq!(website["loadTimeoutSeconds"], 25);
        assert_eq!(website["refreshIntervalSeconds"], 120);
        assert_eq!(website["allowedHosts"], serde_json::json!(["menu.example.org"]));
        // The fallback image travels as content, like any other media.
        assert_eq!(website["fallbackSrc"], format!("tcmedia://variant/{ASSET}/{VARIANT}"));
        assert!(resolved.content.iter().any(|reference| reference.digest.to_hex() == DIGEST));
    }

    #[test]
    fn a_website_without_a_usable_url_is_skipped_like_the_reference_player() {
        for url in ["file:///data/data/org.tilecast.player/state.db", "https://user@menu.example.org/", "javascript:x"]
        {
            let mut bad = site();
            bad["url"] = serde_json::json!(url);
            let resolved = project(website_manifest(bad), 1_000).expect("unavailable");
            assert_eq!(resolved.document["state"], "unavailable", "{url}");
        }
    }

    #[test]
    fn widgets_travel_as_references_for_the_runtime_projector() {
        let mut value = manifest();
        value["schemaVersion"] = serde_json::json!(13);
        value["widgets"] = serde_json::json!([
            {"assetId": WIDGET, "name": "News", "provider": "website", "configVersion": 1, "configuration": {},
             "presentation": {"schemaVersion": 1, "kind": "web", "requiredCapabilities": {"web.remote": 1},
                "web": {"mode": "remote", "url": "https://news.example.org/", "allowedHosts": ["news.example.org"]}}},
        ]);
        value["playlist"]["items"] = serde_json::json!([
            {"id": ITEM, "assetId": WIDGET, "assetType": "widget", "deliveryPolicy": "stream", "durationMs": 30000},
        ]);
        let resolved = project(value, 1_000).expect("playing");
        let items = resolved.document["items"].as_array().expect("items");
        assert_eq!(items[0]["kind"], "widget");
        assert_eq!(items[0]["widget"]["widgetAssetId"], WIDGET);
        let projection = resolved.projection.as_ref().expect("the runtime projects the Widget");
        assert_eq!(projection["schema"], 1);
        assert!(projection["manifest"]["widgets"].is_array());
        assert_eq!(projection["media"][0]["uri"], format!("tcmedia://variant/{ASSET}/{VARIANT}"));
        // The metadata names what the reference needs from the renderer.
        let metadata =
            crate::renderer::projection_metadata(&resolved.document, resolved.projection.as_ref()).expect("metadata");
        let features: Vec<String> = metadata
            .requirements
            .iter()
            .filter_map(|requirement| match requirement {
                RendererRequirement::Feature(name) => Some(name.as_str().to_owned()),
                _ => None,
            })
            .collect();
        for feature in ["remote-web-v1", "website"] {
            assert!(features.contains(&feature.to_owned()), "{feature}");
        }
    }

    #[test]
    fn directly_assigned_layout_is_one_fullscreen_item() {
        let mut value = manifest();
        value["playlist"] = Value::Null;
        value["layouts"] = serde_json::json!([{"id": LAYOUT, "document": {"schemaVersion": 2,
            "canvas": {"width": 1920, "height": 1080}, "placements": []}}]);
        value["layout"] = value["layouts"][0].clone();
        value["directFallbackLayout"] = value["layouts"][0].clone();
        let resolved = project(value, 1_000).expect("playing");
        let items = resolved.document["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], format!("layout-{LAYOUT}"));
        assert_eq!(items[0]["kind"], "layout");
        assert!(resolved.projection.is_some());
    }

    #[test]
    fn span_panels_crop_images_and_reach_the_projector() {
        let mut value = manifest();
        value["canvas"] = serde_json::json!({"width": 3840, "height": 1080});
        value["viewport"] =
            serde_json::json!({"x": 1920, "y": 0, "width": 1920, "height": 1080, "rotation": 0, "order": 1});
        let resolved = project(value.clone(), 1_000).expect("playing");
        let items = resolved.document["items"].as_array().expect("items");
        assert_eq!(items[0]["viewport"]["x"], 1920);
        assert_eq!(items[0]["viewport"]["canvasWidth"], 3840);
        let mut bad = value;
        bad["viewport"] = serde_json::json!({"x": 0});
        let candidate = parse(bad).expect("parses");
        assert_eq!(
            presentation_with(&candidate, 1_000, &AndroidPlayerConfig::default()).expect_err("span"),
            ManifestError::Incompatible(Incompatibility::SpanViewport)
        );
    }

    #[test]
    fn synchronized_groups_share_one_anchor_and_the_reference_durations() {
        let mut value = manifest();
        value["syncGroup"] = serde_json::json!({"id": ITEM, "playbackEpoch": "2026-01-01T00:00:00Z"});
        let resolved = project(value, 1_000).expect("playing");
        assert_eq!(resolved.document["synchronized"], true);
        let timing = resolved.timing.as_ref().expect("timeline");
        assert_eq!(timing.group_id, ITEM);
        assert_eq!(timing.durations_ms, vec![10_000]);
    }

    #[test]
    fn disabled_surface_carries_the_manifest_logo_as_content() {
        let mut value = manifest();
        value["branding"] = serde_json::json!({"logoAssetId": ASSET, "logoVariantId": VARIANT});
        let candidate = parse(value).expect("parses");
        let config = AndroidPlayerConfig::default();
        let (surface, content) = disabled_surface(&candidate, 1_000, &config).expect("surface");
        assert_eq!(surface["state"], "disabled");
        assert_eq!(surface["logoSrc"], format!("tcmedia://variant/{ASSET}/{VARIANT}"));
        assert_eq!(content.len(), 1);
    }

    const TAKEOVER_PLAYLIST: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TAKEOVER_ITEM: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SCHEDULED_PLAYLIST: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const SCHEDULED_ITEM: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const SCHEDULE: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const TAKEOVER: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    fn at(value: &str) -> i64 {
        player_types::Timestamp::parse(value).expect("timestamp").unix_millis()
    }

    fn extra_playlist(id: &str, item: &str) -> Value {
        serde_json::json!({"id": id, "items": [{
            "id": item, "assetId": ASSET, "variantId": VARIANT,
            "assetType": "image", "deliveryPolicy": "automatic", "durationMs": 5000,
            "fitMode": "cover", "transition": "fade", "audioEnabled": true, "volume": 0.8
        }]})
    }

    #[test]
    fn takeover_wins_and_projects_its_playlist() {
        let mut value = manifest();
        value["playlists"] = serde_json::json!([extra_playlist(TAKEOVER_PLAYLIST, TAKEOVER_ITEM)]);
        value["takeover"] = serde_json::json!({"id": TAKEOVER, "playlistId": TAKEOVER_PLAYLIST,
            "activatedAt": "2026-07-17T10:30:00Z", "expiresAt": "2026-07-17T11:00:00Z"});
        let live = project(value.clone(), at("2026-07-17T10:45:00Z")).expect("takeover");
        assert_eq!(live.selection.source, Source::Takeover);
        assert_eq!(live.document["takeover"], true);
        assert_eq!(live.document["items"][0]["id"], TAKEOVER_ITEM);
        assert_eq!(live.next_transition_ms, Some(at("2026-07-17T11:00:00Z")));
        let ended = project(value, at("2026-07-17T11:00:00Z")).expect("direct");
        assert_eq!(ended.selection.source, Source::Direct);
        assert_eq!(ended.document["takeover"], false);
        assert_eq!(ended.document["items"][0]["id"], ITEM);
    }

    #[test]
    fn quick_present_override_projects_without_the_takeover_flag() {
        let mut value = manifest();
        value["playlists"] = serde_json::json!([extra_playlist(TAKEOVER_PLAYLIST, TAKEOVER_ITEM)]);
        value["presentationOverride"] = serde_json::json!({"contentType": "playlist", "contentId": TAKEOVER_PLAYLIST,
            "startedAt": "2026-07-17T10:15:00Z", "expiresAt": "2026-07-17T11:45:00Z"});
        let live = project(value, at("2026-07-17T10:20:00Z")).expect("quick present");
        assert_eq!(live.selection.source, Source::QuickPresent);
        assert_eq!(live.document["takeover"], false);
        assert_eq!(live.document["items"][0]["id"], TAKEOVER_ITEM);
    }

    #[test]
    fn weekly_schedule_with_timezone_beats_direct_in_its_window() {
        let mut value = manifest();
        value["playlists"] = serde_json::json!([extra_playlist(SCHEDULED_PLAYLIST, SCHEDULED_ITEM)]);
        value["schedules"] = serde_json::json!([{"id": SCHEDULE, "playlistId": SCHEDULED_PLAYLIST,
            "type": "weekly", "timezone": "America/New_York", "priority": 10, "specificity": 1,
            "dailyStart": "09:00", "dailyEnd": "17:00", "daysOfWeek": [1, 2, 3, 4, 5]}]);
        // Friday 11:00 in New York is inside the window.
        let live = project(value.clone(), at("2026-07-17T15:00:00Z")).expect("scheduled");
        assert_eq!(live.selection.source, Source::Schedule);
        assert_eq!(live.document["items"][0]["id"], SCHEDULED_ITEM);
        assert_eq!(live.next_transition_ms, Some(at("2026-07-17T21:00:00Z")));
        // 17:00 Eastern ends it; the direct playlist returns.
        let ended = project(value, at("2026-07-17T21:00:00Z")).expect("direct");
        assert_eq!(ended.selection.source, Source::Direct);
        assert_eq!(ended.document["items"][0]["id"], ITEM);
    }

    #[test]
    fn rest_gate_projects_the_off_hours_surface() {
        let document = serde_json::json!({
            "schemaVersion": 1, "configRevision": 7, "generatedAt": "2026-09-24T00:00:00Z",
            "power": {"activeHoursEnabled": true, "activeHoursTimezone": "America/New_York",
                "activeHoursDays": [1, 2, 3, 4, 5], "activeHoursStart": "09:00", "activeHoursEnd": "17:00",
                "outsideActiveHoursDisplay": "custom_text", "outsideActiveHoursText": "Closed"}
        });
        let native = player_core::NativeConfiguration::parse(&document).expect("native");
        // Friday 11:00 Eastern is inside hours: no gate.
        let (open, _) = player_core::activation_gate(&native, false, at("2026-07-17T15:00:00Z"));
        assert_eq!(open, None);
        // Friday 20:00 Eastern is outside hours: the rest gate applies.
        let (rest, transition) = player_core::activation_gate(&native, false, at("2026-07-18T00:00:00Z"));
        assert_eq!(rest, Some(player_core::ActivationGate::Rest));
        assert!(transition.is_some());
        let config = AndroidPlayerConfig::parse(&document).expect("projected");
        let (surface, content) =
            gate_document(player_core::ActivationGate::Rest, &config, None, at("2026-07-18T00:00:00Z"));
        assert_eq!(surface["state"], "sleep");
        assert_eq!(surface["display"], "custom_text");
        assert_eq!(surface["text"], "Closed");
        assert!(content.is_empty());
        // Takeover and Quick Present override the gate; schedules do not.
        assert!(player_core::overrides_activation_gate(player_core::Source::Takeover));
        assert!(player_core::overrides_activation_gate(player_core::Source::QuickPresent));
        assert!(!player_core::overrides_activation_gate(player_core::Source::Schedule));
        assert!(!player_core::overrides_activation_gate(player_core::Source::Direct));
    }

    #[test]
    fn disabled_gate_falls_back_without_a_branded_candidate() {
        let config = AndroidPlayerConfig::default();
        let (surface, content) = gate_document(player_core::ActivationGate::Disabled, &config, None, 1_000);
        assert_eq!(surface["state"], "disabled");
        assert_eq!(surface["status"], "disabled");
        assert!(content.is_empty());
    }

    #[test]
    fn spring_forward_gap_starts_at_the_first_real_minute() {
        let mut value = manifest();
        value["playlists"] = serde_json::json!([extra_playlist(SCHEDULED_PLAYLIST, SCHEDULED_ITEM)]);
        // 2026-03-08 is the spring-forward Sunday: 02:30 never happens in
        // New York, so the window opens at 03:00 Eastern (07:00Z).
        value["schedules"] = serde_json::json!([{"id": SCHEDULE, "playlistId": SCHEDULED_PLAYLIST,
            "type": "weekly", "timezone": "America/New_York", "priority": 10, "specificity": 1,
            "dailyStart": "02:30", "dailyEnd": "04:00", "daysOfWeek": [0]}]);
        let live = project(value.clone(), at("2026-03-08T07:15:00Z")).expect("scheduled");
        assert_eq!(live.selection.source, Source::Schedule);
        assert_eq!(live.document["items"][0]["id"], SCHEDULED_ITEM);
        let before = project(value, at("2026-03-08T06:59:00Z")).expect("direct");
        assert_eq!(before.selection.source, Source::Direct);
    }
}
