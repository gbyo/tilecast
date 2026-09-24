//! Validation boundary and renderer projection for server manifests.
//!
//! The server remains the presentation compiler. A presentation reaches this
//! module only as the Player manifest the authenticated server returned from
//! the ordinary manifest endpoint (docs/tilecast-edge.md §8.3). This module:
//!
//! 1. checks the manifest's identity, bounds and every media claim;
//! 2. decides compatibility with the installed WPE renderer profile before
//!    anything is prepared. A manifest that needs a capability this renderer
//!    does not safely provide (websites, YouTube, server-streamed media,
//!    synchronized groups, Span walls, display control, the Noise Meter) is
//!    rejected as a whole with a typed reason, so the last usable presentation
//!    stays on screen and nothing is silently omitted (docs/tilecast-edge.md
//!    §8.4, §10.5);
//! 3. resolves, at one corrected instant, what the renderer shows: the same
//!    selection the reference player makes (`core/schedule.ts`), projected
//!    into the shared renderer contract. Widgets and layouts travel as
//!    references into a bounded projection context; the trusted runtime
//!    renders them with the reference `renderWidget`/`renderLayout`, so no
//!    render-tree logic is duplicated here.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use edge_cas::{BlobSource, CasError, FetchError, FetchObserver, FetchRequest, Fetcher, IngestMeta};
use edge_protocol::bounded::{SafeText, ShortToken};
use edge_protocol::ipc::event::{MediaAlias, ProjectionContext};
use edge_protocol::ipc::presentation::{
    ContentRef, ItemKind, PresentationDocument, PresentationItem, StatusSurface, content_uri,
};
use edge_protocol::{ScreenId, Sha256Digest};
use edge_server::AuthenticatedServer;
use edge_server::origin::OriginBlobSource;
use edge_state::repo::cas::{Domain, SourceKind};
use serde::Deserialize;
use serde_json::Value;

use crate::daemon::DaemonContext;
use crate::player_config::{self, PlayerConfig};
use crate::schedule::{self, Selection, Source};

/// Player manifest schema versions the server compiler emits and this
/// renderer understands (11 base, 12 data sources, 13 declarative widgets,
/// 14 crossfade, 15 Span/website reload).
pub const MANIFEST_SCHEMAS: std::ops::RangeInclusive<u32> = 11..=15;
const MAX_ASSETS: usize = 1024;
const MAX_PLAYLISTS: usize = 128;
const MAX_ITEMS: usize = 4096;
const MAX_LAYOUTS: usize = 128;
const MAX_WIDGETS: usize = 256;
const MAX_DATA_SOURCES: usize = 256;
const MAX_PLUGINS: usize = 64;
const AUTOMATIC_VIDEO_LIMIT_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_ACTIVATION_GRACE_SECONDS: u64 = 30;
const LAYOUT_ITEM_PREFIX: &str = "layout-";

/// The installed WPE renderer profile. It is compiled into the daemon release
/// with the renderer and runtime it ships with; the renderer's
/// `renderer.ready` may refine it but never extends it
/// (docs/tilecast-edge.md §10.4).
pub mod profile {
    /// Renderer features (`renderer.ready` vocabulary) the trusted runtime
    /// implements under WPE.
    pub const FEATURES: &[&str] = &[
        "status-surfaces-v1",
        "image",
        "video",
        "render-tree-v1",
        "layout-v1",
        "synchronized-playback-v1",
        "plugin.brand_bug",
        "plugin.countdown_bar",
        "plugin.alert_ticker",
    ];

    /// Declarative widget capabilities of the reference projection code the
    /// trusted runtime runs (the same versions the reference Linux player
    /// reports, because it is the same code).
    pub const NATIVE_CAPABILITIES: &[(&str, u32)] = &[
        ("layout.surface", 1),
        ("layout.box", 1),
        ("layout.row", 1),
        ("layout.column", 1),
        ("layout.stack", 1),
        ("layout.grid", 1),
        ("layout.spacer", 1),
        ("layout.divider", 1),
        ("content.text", 1),
        ("content.icon", 2),
        ("content.asset_image", 2),
        ("content.badge", 1),
        ("content.progress", 2),
        ("content.qr_code", 1),
        ("content.marquee", 1),
        ("content.line_chart", 2),
        ("content.bar_chart", 2),
        ("content.donut_chart", 2),
        ("collection.repeat", 2),
        ("collection.conditional", 2),
        ("collection.grouped_sections", 1),
        ("binding.core", 2),
        ("format.typed", 2),
        ("selection.relative_date", 1),
        ("selection.temporal", 1),
        ("playback.auto_skip", 1),
        // Clock, Date, Countdown and World Clock bind the current time. The
        // runtime projects them as self-updating nodes (or, for a date, text
        // that changes once a day), so re-projection never restarts playback.
        ("environment.time", 1),
    ];

    /// Remote web content is not supported until the WPE website isolation is
    /// qualified (docs/tilecast-edge.md §10.5).
    pub const WEB_RUNTIME_VERSION: u32 = 0;

    pub fn native_capability(name: &str) -> u32 {
        NATIVE_CAPABILITIES.iter().find(|(id, _)| *id == name).map_or(0, |(_, version)| *version)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub asset_id: uuid::Uuid,
    pub variant_id: uuid::Uuid,
    pub digest: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: String,
    pub download_path: String,
}

#[derive(Debug, Clone)]
pub struct Candidate {
    /// SHA-256 of the manifest's stable encoding ([`manifest_digest`]).
    pub digest: Sha256Digest,
    pub document: Value,
    pub version: i64,
    pub screen_id: ScreenId,
    pub assets: Vec<Asset>,
    /// Every variant the presentation can reference. Edge has no verified
    /// streaming path, so all of them are verified in the CAS before the
    /// candidate may become pending.
    pub required_downloads: Vec<Asset>,
}

/// What the controller shows and why.
#[derive(Debug, Clone)]
pub struct ResolvedPresentation {
    pub document: PresentationDocument,
    /// The shared timeline of a synchronized group, when the screen belongs
    /// to one and shows a playlist.
    pub timing: Option<GroupTiming>,
    pub content: Vec<ContentRef>,
    pub projection: Option<ProjectionContext>,
    pub plugins: Vec<Value>,
    pub plugin_aliases: Vec<MediaAlias>,
    pub selection: Selection,
    pub next_transition_ms: Option<i64>,
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

#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum ManifestError {
    #[error("manifest structure is invalid")]
    Structure,
    #[error("manifest schema is unsupported")]
    Schema,
    #[error("manifest targets another screen")]
    Screen,
    #[error("manifest exceeds the supported item or asset bound")]
    Bound,
    #[error("manifest contains an invalid media asset")]
    Asset,
    #[error("manifest references an unavailable or ambiguous media variant")]
    Reference,
    #[error("manifest has an unsupported delivery policy")]
    DeliveryPolicy,
    #[error("manifest schedule is invalid")]
    Schedule,
    #[error("presentation is incompatible with this renderer: {0}")]
    Incompatible(Incompatibility),
}

impl ManifestError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Structure => "manifest_structure_invalid",
            Self::Schema => "manifest_schema_unsupported",
            Self::Screen => "manifest_wrong_screen",
            Self::Bound => "manifest_bound_exceeded",
            Self::Asset => "manifest_asset_invalid",
            Self::Reference => "manifest_reference_invalid",
            Self::DeliveryPolicy => "manifest_delivery_policy_invalid",
            Self::Schedule => "manifest_schedule_invalid",
            Self::Incompatible(reason) => reason.code(),
        }
    }
}

/// A precise reason a presentation cannot run on this renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incompatibility {
    Website,
    YouTube,
    WebWidget,
    StreamingDelivery,
    SynchronizedPlayback,
    SpanViewport,
    DisplayControl,
    Plugin(String),
    WidgetCapability(String),
    ContentType(String),
    Requirement(String),
}

impl Incompatibility {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Website => "presentation_incompatible_website",
            Self::YouTube => "presentation_incompatible_youtube",
            Self::WebWidget => "presentation_incompatible_web_widget",
            Self::StreamingDelivery => "presentation_incompatible_streaming_delivery",
            Self::SynchronizedPlayback => "presentation_incompatible_synchronized_playback",
            Self::SpanViewport => "presentation_incompatible_span",
            Self::DisplayControl => "presentation_incompatible_display_control",
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
            Self::Website => f.write_str("websites need the WPE website isolation that is not qualified yet"),
            Self::YouTube => f.write_str("YouTube needs the WPE website isolation that is not qualified yet"),
            Self::WebWidget => f.write_str("web widgets need the WPE website isolation that is not qualified yet"),
            Self::StreamingDelivery => f.write_str("server-streamed media has no verified Edge delivery path"),
            Self::SynchronizedPlayback => f.write_str("synchronized group playback is not supported by this renderer"),
            Self::SpanViewport => f.write_str("Span video walls are not supported by this renderer"),
            Self::DisplayControl => f.write_str("scheduled display control needs a display control provider"),
            Self::Plugin(kind) => write!(f, "the {kind} plugin is not supported by this renderer"),
            Self::WidgetCapability(name) => write!(f, "a widget needs renderer capability {name}"),
            Self::ContentType(kind) => write!(f, "content type {kind} is not supported by this renderer"),
            Self::Requirement(name) => write!(f, "the presentation requires {name}"),
        }
    }
}

fn availability_window(value: &Value) -> Result<(Option<i64>, Option<i64>), ManifestError> {
    let parse = |key: &str| -> Result<Option<i64>, ManifestError> {
        match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => edge_protocol::Timestamp::parse(text)
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

fn token_or(value: Option<&str>, fallback: &str) -> Result<ShortToken, ManifestError> {
    ShortToken::new(value.unwrap_or(fallback).to_owned()).map_err(|_| ManifestError::Structure)
}

fn text<const N: usize>(value: &str) -> Result<SafeText<N>, ManifestError> {
    SafeText::new(value.to_owned()).map_err(|_| ManifestError::Structure)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireManifest {
    schema_version: u32,
    manifest_version: i64,
    screen_id: ScreenId,
    mode: String,
    assets: Vec<WireAsset>,
    playlist: Option<WirePlaylist>,
    direct_fallback_playlist: Option<WirePlaylist>,
    playlists: Vec<WirePlaylist>,
    #[serde(default)]
    layouts: Vec<Value>,
    #[serde(default)]
    widgets: Vec<Value>,
    #[serde(default)]
    data_sources: Vec<Value>,
    #[serde(default)]
    plugins: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireAsset {
    asset_id: uuid::Uuid,
    variant_id: uuid::Uuid,
    sha256: String,
    file_size: i64,
    mime_type: String,
    download_path: String,
}

#[derive(Deserialize)]
struct WirePlaylist {
    items: Vec<WireItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireItem {
    asset_id: uuid::Uuid,
    variant_id: Option<uuid::Uuid>,
    asset_type: String,
    layout_id: Option<uuid::Uuid>,
    delivery_policy: String,
}

fn exact_asset(
    value: &Value,
    asset_key: &str,
    variant_key: &str,
    catalog: &BTreeMap<(uuid::Uuid, uuid::Uuid), usize>,
) -> Result<Option<usize>, ManifestError> {
    let Some(asset) = value.get(asset_key).filter(|value| !value.is_null()) else { return Ok(None) };
    let asset: uuid::Uuid =
        asset.as_str().ok_or(ManifestError::Reference)?.parse().map_err(|_| ManifestError::Reference)?;
    let variant: uuid::Uuid = value
        .get(variant_key)
        .and_then(Value::as_str)
        .ok_or(ManifestError::Reference)?
        .parse()
        .map_err(|_| ManifestError::Reference)?;
    catalog.get(&(asset, variant)).copied().map(Some).ok_or(ManifestError::Reference)
}

fn check_layout(layout: &Value, catalog: &BTreeMap<(uuid::Uuid, uuid::Uuid), usize>) -> Result<(), ManifestError> {
    let document = layout.get("document").ok_or(ManifestError::Structure)?;
    layout.get("id").and_then(Value::as_str).ok_or(ManifestError::Structure)?;
    if let Some(canvas) = document.get("canvas") {
        exact_asset(canvas, "backgroundAssetId", "backgroundVariantId", catalog)?;
    }
    if let Some(placements) = document.get("placements") {
        let placements = placements.as_array().ok_or(ManifestError::Structure)?;
        if placements.len() > MAX_ITEMS {
            return Err(ManifestError::Bound);
        }
        for placement in placements {
            if placement.get("type").and_then(Value::as_str) == Some("asset") {
                exact_asset(placement, "assetId", "variantId", catalog)?;
            }
        }
    }
    Ok(())
}

/// Everything in `document` this renderer cannot safely provide. An empty
/// list means compatible.
pub fn incompatibilities(document: &Value, assets: &[Asset]) -> Vec<Incompatibility> {
    let mut out = Vec::new();
    let mut push = |reason: Incompatibility| {
        if !out.contains(&reason) {
            out.push(reason);
        }
    };
    if document.get("websites").and_then(Value::as_array).is_some_and(|sites| !sites.is_empty()) {
        push(Incompatibility::Website);
    }
    for widget in document.get("widgets").and_then(Value::as_array).into_iter().flatten() {
        if widget.get("provider").and_then(Value::as_str) == Some("youtube") {
            push(Incompatibility::YouTube);
        }
        if let Some(presentation) = widget.get("presentation").filter(|value| !value.is_null()) {
            match presentation.get("kind").and_then(Value::as_str) {
                Some("native") => {}
                Some("web") => push(Incompatibility::WebWidget),
                _ => push(Incompatibility::WidgetCapability("presentation kind".to_owned())),
            }
            if let Some(required) = presentation.get("requiredCapabilities").and_then(Value::as_object) {
                for (name, version) in required {
                    let version = version.as_u64().unwrap_or(u64::MAX);
                    let supported = if name == "web.remote" {
                        profile::WEB_RUNTIME_VERSION
                    } else {
                        profile::native_capability(name)
                    };
                    if version > u64::from(supported) {
                        push(Incompatibility::WidgetCapability(name.chars().take(64).collect()));
                    }
                }
            }
        }
    }
    let by_variant: BTreeMap<(uuid::Uuid, uuid::Uuid), &Asset> =
        assets.iter().map(|asset| ((asset.asset_id, asset.variant_id), asset)).collect();
    for playlist in playlists_of(document) {
        for item in playlist.get("items").and_then(Value::as_array).into_iter().flatten() {
            let kind = item.get("assetType").and_then(Value::as_str).unwrap_or("");
            if item.get("layoutId").is_some_and(|id| !id.is_null()) || kind == "widget" {
                continue;
            }
            match kind {
                "website" => push(Incompatibility::Website),
                "youtube" => push(Incompatibility::YouTube),
                "image" | "video" => {}
                other => push(Incompatibility::ContentType(other.chars().take(32).collect())),
            }
            let variant = item.get("variantId").and_then(Value::as_str).and_then(|v| v.parse().ok());
            let asset = item.get("assetId").and_then(Value::as_str).and_then(|a| a.parse().ok());
            let Some(asset) = asset.zip(variant).and_then(|key| by_variant.get(&key)) else { continue };
            if !(asset.mime_type.starts_with("image/") || asset.mime_type.starts_with("video/")) {
                push(Incompatibility::ContentType(asset.mime_type.chars().take(32).collect()));
            }
            let streamed = match item.get("deliveryPolicy").and_then(Value::as_str) {
                Some("stream") => true,
                Some("automatic") => {
                    asset.mime_type.starts_with("video/") && asset.size_bytes > AUTOMATIC_VIDEO_LIMIT_BYTES
                }
                _ => false,
            };
            if streamed {
                push(Incompatibility::StreamingDelivery);
            }
        }
    }
    if document.get("syncGroup").is_some_and(|group| {
        !group.is_null()
            && (group.get("id").and_then(Value::as_str).is_none_or(|id| id.is_empty() || id.len() > 64)
                || group.get("playbackEpoch").and_then(Value::as_str).is_none())
    }) {
        push(Incompatibility::SynchronizedPlayback);
    }
    if document.get("viewport").is_some_and(|value| !value.is_null())
        || document.get("canvas").is_some_and(|value| !value.is_null())
    {
        push(Incompatibility::SpanViewport);
    }
    if document
        .get("schedules")
        .and_then(Value::as_array)
        .is_some_and(|schedules| schedules.iter().any(|s| s.get("displayAction").is_some_and(|v| !v.is_null())))
    {
        push(Incompatibility::DisplayControl);
    }
    for plugin in document.get("plugins").and_then(Value::as_array).into_iter().flatten() {
        let kind = plugin.get("type").and_then(Value::as_str).unwrap_or("unknown");
        if !profile::FEATURES.contains(&format!("plugin.{kind}").as_str()) {
            push(Incompatibility::Plugin(kind.chars().take(32).collect()));
        }
    }
    out
}

impl Candidate {
    /// Validates a server manifest and its compatibility with this renderer.
    /// Nothing is fetched here.
    pub fn prepare_candidate(document: Value, expected_screen: ScreenId) -> Result<Self, ManifestError> {
        let digest = manifest_digest(&document);
        let candidate = Self::parse(document, expected_screen, digest)?;
        if let Some(reason) = incompatibilities(&candidate.document, &candidate.assets).into_iter().next() {
            return Err(ManifestError::Incompatible(reason));
        }
        Ok(candidate)
    }

    /// Re-validates a stored document (offline start, activation).
    pub fn parse(document: Value, expected_screen: ScreenId, digest: Sha256Digest) -> Result<Self, ManifestError> {
        let wire: WireManifest = serde_json::from_value(document.clone()).map_err(|_| ManifestError::Structure)?;
        if !MANIFEST_SCHEMAS.contains(&wire.schema_version) || wire.mode != "presentation" || wire.manifest_version < 0
        {
            return Err(ManifestError::Schema);
        }
        if wire.screen_id != expected_screen {
            return Err(ManifestError::Screen);
        }
        if wire.assets.len() > MAX_ASSETS
            || wire.playlists.len() > MAX_PLAYLISTS
            || wire.layouts.len() > MAX_LAYOUTS
            || wire.widgets.len() > MAX_WIDGETS
            || wire.data_sources.len() > MAX_DATA_SOURCES
            || wire.plugins.len() > MAX_PLUGINS
        {
            return Err(ManifestError::Bound);
        }
        let mut assets = Vec::with_capacity(wire.assets.len());
        let mut by_variant = BTreeMap::new();
        let mut by_digest = BTreeMap::new();
        for source in wire.assets {
            let digest =
                Sha256Digest::parse_legacy_case_insensitive(&source.sha256).map_err(|_| ManifestError::Asset)?;
            let size_bytes = u64::try_from(source.file_size).map_err(|_| ManifestError::Asset)?;
            if size_bytes == 0
                || source.mime_type.is_empty()
                || source.mime_type.len() > 127
                || !source.mime_type.is_ascii()
                || source.mime_type.bytes().any(|byte| byte.is_ascii_control())
                || OriginBlobSource::validate_path(&source.download_path).is_err()
                || by_variant.insert((source.asset_id, source.variant_id), assets.len()).is_some()
                || by_digest.insert(digest, size_bytes).is_some_and(|old| old != size_bytes)
            {
                return Err(ManifestError::Asset);
            }
            assets.push(Asset {
                asset_id: source.asset_id,
                variant_id: source.variant_id,
                digest,
                size_bytes,
                mime_type: source.mime_type,
                download_path: source.download_path,
            });
        }
        let widget_ids: BTreeSet<uuid::Uuid> = wire
            .widgets
            .iter()
            .filter_map(|widget| widget.get("assetId").and_then(Value::as_str).and_then(|id| id.parse().ok()))
            .collect();
        let layout_ids: BTreeSet<uuid::Uuid> = document
            .get("layouts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(["layout", "directFallbackLayout"].into_iter().filter_map(|key| document.get(key)))
            .filter_map(|layout| layout.get("id").and_then(Value::as_str).and_then(|id| id.parse().ok()))
            .collect();
        let mut item_count = 0;
        for playlist in wire.playlist.into_iter().chain(wire.direct_fallback_playlist).chain(wire.playlists) {
            item_count += playlist.items.len();
            if item_count > MAX_ITEMS {
                return Err(ManifestError::Bound);
            }
            for item in playlist.items {
                if !matches!(item.delivery_policy.as_str(), "download" | "stream" | "automatic") {
                    return Err(ManifestError::DeliveryPolicy);
                }
                if let Some(layout) = item.layout_id {
                    if !layout_ids.contains(&layout) {
                        return Err(ManifestError::Reference);
                    }
                    continue;
                }
                match item.asset_type.as_str() {
                    "widget" => {
                        if !widget_ids.contains(&item.asset_id) {
                            return Err(ManifestError::Reference);
                        }
                        continue;
                    }
                    "website" => continue,
                    _ => {}
                }
                let Some(variant) = item.variant_id else { return Err(ManifestError::Reference) };
                by_variant.get(&(item.asset_id, variant)).ok_or(ManifestError::Reference)?;
            }
        }
        if let Some(branding) = document.get("branding").filter(|value| !value.is_null()) {
            exact_asset(branding, "logoAssetId", "logoVariantId", &by_variant)?;
        }
        if let Some(websites) = document.get("websites") {
            for website in websites.as_array().ok_or(ManifestError::Structure)? {
                exact_asset(website, "fallbackImageAssetId", "fallbackVariantId", &by_variant)?;
            }
        }
        for key in ["layout", "directFallbackLayout"] {
            if let Some(layout) = document.get(key).filter(|value| !value.is_null()) {
                check_layout(layout, &by_variant)?;
            }
        }
        for layout in &wire.layouts {
            check_layout(layout, &by_variant)?;
        }
        for plugin in &wire.plugins {
            if plugin.get("type").and_then(Value::as_str) == Some("brand_bug")
                && let Some(config) = plugin.get("config")
            {
                exact_asset(config, "imageAssetId", "imageVariantId", &by_variant)?;
            }
        }
        schedule::resolve(&document, 0).map_err(|_| ManifestError::Schedule)?;
        let required_downloads = assets.clone();
        Ok(Self {
            digest,
            document,
            version: wire.manifest_version,
            screen_id: wire.screen_id,
            assets,
            required_downloads,
        })
    }

    fn asset(&self, asset_id: &str, variant_id: &str) -> Option<&Asset> {
        let key: (uuid::Uuid, uuid::Uuid) = (asset_id.parse().ok()?, variant_id.parse().ok()?);
        self.assets.iter().find(|asset| (asset.asset_id, asset.variant_id) == key)
    }

    fn asset_value(&self, asset: &Asset) -> Option<&Value> {
        self.document.get("assets")?.as_array()?.iter().find(|value| {
            value.get("assetId").and_then(Value::as_str) == Some(&asset.asset_id.to_string())
                && value.get("variantId").and_then(Value::as_str) == Some(&asset.variant_id.to_string())
        })
    }

    fn content_ref(asset: &Asset) -> Result<ContentRef, ManifestError> {
        Ok(ContentRef {
            sha256: asset.digest,
            size_bytes: asset.size_bytes,
            mime_type: SafeText::new(asset.mime_type.clone()).map_err(|_| ManifestError::Asset)?,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn status(
        &self,
        state: &str,
        title: &str,
        message: &str,
        status: &str,
        now_ms: i64,
        config: &PlayerConfig,
    ) -> Result<(PresentationDocument, Vec<ContentRef>), ManifestError> {
        let mut content = Vec::new();
        let logo = self
            .document
            .get("branding")
            .filter(|value| !value.is_null())
            .and_then(|branding| {
                self.asset(branding.get("logoAssetId")?.as_str()?, branding.get("logoVariantId")?.as_str()?)
            })
            .filter(|asset| self.asset_value(asset).is_some_and(|value| available_at(value, now_ms).unwrap_or(false)));
        let logo_src = match logo {
            Some(asset) => {
                content.push(Self::content_ref(asset)?);
                Some(text(&content_uri(&asset.digest))?)
            }
            None => None,
        };
        let branding = &config.branding;
        let surface = StatusSurface {
            title: SafeText::lossy(title),
            message: SafeText::lossy(message),
            background_color: Some(text(branding.background())?),
            text_color: Some(text(branding.text())?),
            logo_src,
            footer_text: branding.footer_text.as_deref().map(SafeText::lossy),
            status: Some(text(status)?),
        };
        let document = match state {
            "unavailable" => PresentationDocument::Unavailable(surface),
            "disabled" => PresentationDocument::Disabled(surface),
            _ => PresentationDocument::Idle(surface),
        };
        Ok((document, content))
    }

    /// The branded surface for a screen whose playback an administrator
    /// disabled (the reference player's `brandingFallback`).
    pub fn disabled_surface(
        &self,
        now_ms: i64,
        config: &PlayerConfig,
    ) -> Result<(PresentationDocument, Vec<ContentRef>), ManifestError> {
        let branding = &config.branding;
        self.status(
            "disabled",
            branding.disabled_title.as_deref().unwrap_or("Screen disabled"),
            branding.disabled_message.as_deref().unwrap_or(""),
            "disabled",
            now_ms,
            config,
        )
    }

    fn widget(&self, asset_id: &str) -> Option<&Value> {
        self.document
            .get("widgets")?
            .as_array()?
            .iter()
            .find(|widget| widget.get("assetId").and_then(Value::as_str) == Some(asset_id))
    }

    /// Resolves the manifest with default player configuration.
    pub fn presentation(&self, now_ms: i64) -> Result<ResolvedPresentation, ManifestError> {
        self.presentation_with(now_ms, &PlayerConfig::default())
    }

    /// Resolves the server-compiled manifest at one corrected server instant
    /// under the accepted player configuration.
    pub fn presentation_with(&self, now_ms: i64, config: &PlayerConfig) -> Result<ResolvedPresentation, ManifestError> {
        let selection = schedule::resolve(&self.document, now_ms).map_err(|_| ManifestError::Schedule)?;
        let availability = next_availability_transition(&self.document, now_ms)?;
        let next_transition_ms = match (selection.next_transition_ms, availability) {
            (Some(schedule), Some(content)) => Some(schedule.min(content)),
            (Some(value), None) | (None, Some(value)) => Some(value),
            (None, None) => None,
        };
        let (plugins, plugin_aliases, plugin_content) = self.plugins(now_ms)?;
        let finish = |document: PresentationDocument,
                      mut content: Vec<ContentRef>,
                      projection: Option<ProjectionContext>,
                      selection: Selection| {
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
            let item = PresentationItem {
                id: text(&format!("{LAYOUT_ITEM_PREFIX}{layout_id}"))?,
                kind: ItemKind::Layout,
                src: text("")?,
                duration_ms: None,
                fit_mode: token_or(None, "contain")?,
                transition: Some(token_or(None, "none")?),
                audio_enabled: false,
                volume: 0.0,
                video_start_offset_ms: None,
                video_end_offset_ms: None,
                viewport: None,
                website: None,
                widget: None,
                layout: Some(serde_json::json!({ "layoutId": layout_id.to_string() })),
            };
            let (projection, content) = self.projection(now_ms, config)?;
            let document = PresentationDocument::Playing {
                items: vec![item],
                takeover: false,
                generation: self.version.max(0) as u64,
                synchronized: false,
            };
            return Ok(finish(document, content, Some(projection), selection));
        }

        let Some(playlist_id) = selection.playlist_id else {
            let branding = &config.branding;
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
        let playlist = playlists_of(&self.document)
            .find(|playlist| playlist.get("id").and_then(Value::as_str) == Some(&playlist_id.to_string()))
            .ok_or(ManifestError::Reference)?;
        let source_items = playlist.get("items").and_then(Value::as_array).ok_or(ManifestError::Structure)?;
        let mut items = Vec::with_capacity(source_items.len());
        let mut content_by_digest = BTreeMap::new();
        let mut needs_projection = false;
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
            let settings = player_config::item_settings(
                item.as_object().ok_or(ManifestError::Structure)?,
                &config.playback,
                authored_duration,
            );
            let (duration_ms, fit_mode, transition, volume, audio_enabled) =
                (settings.duration_ms, settings.fit_mode, settings.transition, settings.volume, settings.audio_enabled);
            let number = |key: &str| -> Result<Option<u64>, ManifestError> {
                match item.get(key) {
                    None | Some(Value::Null) => Ok(None),
                    Some(Value::Number(value)) => value.as_u64().map(Some).ok_or(ManifestError::Structure),
                    _ => Err(ManifestError::Structure),
                }
            };
            let mut built = PresentationItem {
                id: text(item_id)?,
                kind: ItemKind::Image,
                src: text("")?,
                duration_ms,
                fit_mode: token_or(Some(fit_mode), "contain")?,
                transition: Some(token_or(Some(transition), "none")?),
                audio_enabled,
                volume,
                video_start_offset_ms: None,
                video_end_offset_ms: None,
                viewport: None,
                website: None,
                widget: None,
                layout: None,
            };
            if let Some(layout_id) = item.get("layoutId").and_then(Value::as_str) {
                built.kind = ItemKind::Layout;
                built.layout = Some(serde_json::json!({ "layoutId": layout_id }));
                needs_projection = true;
                items.push(built);
                continue;
            }
            let asset_id = item.get("assetId").and_then(Value::as_str).ok_or(ManifestError::Reference)?;
            if asset_type == "widget" || self.widget(asset_id).is_some() {
                let widget = self.widget(asset_id).ok_or(ManifestError::Reference)?;
                if widget.get("provider").and_then(Value::as_str) == Some("youtube")
                    || widget.get("presentation").and_then(|p| p.get("kind")).and_then(Value::as_str) == Some("web")
                {
                    return Err(ManifestError::Incompatible(Incompatibility::WebWidget));
                }
                built.kind = ItemKind::Widget;
                built.widget = Some(serde_json::json!({ "widgetAssetId": asset_id }));
                needs_projection = true;
                items.push(built);
                continue;
            }
            if asset_type == "website" {
                return Err(ManifestError::Incompatible(Incompatibility::Website));
            }
            let variant_id = item.get("variantId").and_then(Value::as_str).ok_or(ManifestError::Reference)?;
            let asset = self.asset(asset_id, variant_id).ok_or(ManifestError::Reference)?;
            let asset_value = self.asset_value(asset).ok_or(ManifestError::Reference)?;
            if !available_at(asset_value, now_ms)? {
                continue;
            }
            built.kind = if asset.mime_type.starts_with("image/") {
                ItemKind::Image
            } else if asset.mime_type.starts_with("video/") {
                ItemKind::Video
            } else {
                return Err(ManifestError::Incompatible(Incompatibility::ContentType(asset.mime_type.clone())));
            };
            if built.kind == ItemKind::Video {
                built.video_start_offset_ms = number("videoStartOffsetMs")?;
                built.video_end_offset_ms = number("videoEndOffsetMs")?;
            }
            built.src = text(&content_uri(&asset.digest))?;
            content_by_digest.entry(asset.digest).or_insert(Self::content_ref(asset)?);
            items.push(built);
        }
        if items.is_empty() {
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
        let mut content: Vec<ContentRef> = content_by_digest.into_values().collect();
        let projection = if needs_projection {
            let (projection, projection_content) = self.projection(now_ms, config)?;
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
        let document = PresentationDocument::Playing {
            items,
            takeover: selection.source == Source::Takeover,
            generation: self.version.max(0) as u64,
            synchronized: timing.is_some(),
        };
        let mut resolved = finish(document, content, projection, selection);
        resolved.timing = timing;
        Ok(resolved)
    }

    /// The group timeline when this screen is in a synchronized group. The
    /// anchor is the takeover's, the Quick Present's or the active schedule
    /// window's start, and otherwise the group's playback epoch.
    fn group_timing(&self, selection: &Selection, items: &[PresentationItem], source: &[Value]) -> Option<GroupTiming> {
        let group = self.document.get("syncGroup").filter(|group| !group.is_null())?;
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
                let item = source.iter().find(|item| item.get("id").and_then(Value::as_str) == Some(built.id.as_str()));
                self.effective_duration_ms(built, item)
            })
            .collect();
        Some(GroupTiming { group_id, anchor_ms, durations_ms })
    }

    /// The reference player's `effectiveDurationMs`, shared with Android: only
    /// the manifest carries an authored duration; a video otherwise runs its
    /// trimmed length, other interactive kinds 30 s, anything else 10 s.
    fn effective_duration_ms(&self, built: &PresentationItem, item: Option<&Value>) -> u64 {
        let authored = item.and_then(|item| item.get("durationMs")).and_then(Value::as_u64).filter(|ms| *ms > 0);
        let explicit = if built.kind == ItemKind::Video { authored } else { authored.or(built.duration_ms) };
        if let Some(ms) = explicit.filter(|ms| *ms > 0) {
            return ms;
        }
        match built.kind {
            ItemKind::Website | ItemKind::Widget | ItemKind::Layout | ItemKind::Youtube => 30_000,
            ItemKind::Video => {
                let offset = |key: &str| item.and_then(|item| item.get(key)).and_then(Value::as_u64);
                let start = offset("videoStartOffsetMs").or(built.video_start_offset_ms).unwrap_or(0);
                let asset_seconds = item
                    .and_then(|item| {
                        let asset = self.asset(item.get("assetId")?.as_str()?, item.get("variantId")?.as_str()?)?;
                        self.asset_value(asset)?.get("durationSeconds")?.as_f64()
                    })
                    .filter(|seconds| seconds.is_finite() && *seconds > 0.0)
                    .map(|seconds| (seconds * 1_000.0).round() as u64);
                match offset("videoEndOffsetMs").or(built.video_end_offset_ms).or(asset_seconds) {
                    Some(end) => end.saturating_sub(start).max(1),
                    None => 10_000,
                }
            }
            ItemKind::Image => 10_000,
        }
    }

    /// The manifest subset the trusted runtime's `renderWidget` and
    /// `renderLayout` read, plus the media map for every asset variant.
    fn projection(
        &self,
        now_ms: i64,
        config: &PlayerConfig,
    ) -> Result<(ProjectionContext, Vec<ContentRef>), ManifestError> {
        let mut manifest = serde_json::Map::new();
        for key in
            ["assets", "playlist", "directFallbackPlaylist", "playlists", "widgets", "dataSources", "layouts", "layout"]
        {
            if let Some(value) = self.document.get(key).filter(|value| !value.is_null()) {
                manifest.insert(key.to_owned(), value.clone());
            }
        }
        let mut media = Vec::with_capacity(self.assets.len());
        let mut content = Vec::with_capacity(self.assets.len());
        for asset in &self.assets {
            media.push(MediaAlias {
                asset_id: asset.asset_id,
                variant_id: asset.variant_id,
                uri: text(&content_uri(&asset.digest))?,
            });
            if !content.iter().any(|existing: &ContentRef| existing.sha256 == asset.digest) {
                content.push(Self::content_ref(asset)?);
            }
        }
        let manifest = Value::Object(manifest);
        if serde_json::to_vec(&manifest)
            .map_or(true, |bytes| bytes.len() > edge_protocol::ipc::event::MAX_PROJECTION_BYTES)
        {
            return Err(ManifestError::Bound);
        }
        let _ = now_ms;
        let playback = (!config.playback.context.is_empty()).then(|| Value::Object(config.playback.context.clone()));
        Ok((ProjectionContext { schema: 1, clock_offset_ms: 0, manifest, media, playback }, content))
    }

    /// Supported built-in plugins, their media aliases and content.
    #[allow(clippy::type_complexity)]
    fn plugins(&self, now_ms: i64) -> Result<(Vec<Value>, Vec<MediaAlias>, Vec<ContentRef>), ManifestError> {
        let mut plugins = Vec::new();
        let mut aliases = Vec::new();
        let mut content = Vec::new();
        for plugin in self.document.get("plugins").and_then(Value::as_array).into_iter().flatten() {
            let kind = plugin.get("type").and_then(Value::as_str).unwrap_or("");
            if !profile::FEATURES.contains(&format!("plugin.{kind}").as_str()) {
                return Err(ManifestError::Incompatible(Incompatibility::Plugin(kind.chars().take(32).collect())));
            }
            if kind == "brand_bug"
                && let Some(config) = plugin.get("config")
                && let (Some(asset_id), Some(variant_id)) = (
                    config.get("imageAssetId").and_then(Value::as_str),
                    config.get("imageVariantId").and_then(Value::as_str),
                )
            {
                let asset = self.asset(asset_id, variant_id).ok_or(ManifestError::Reference)?;
                aliases.push(MediaAlias {
                    asset_id: asset.asset_id,
                    variant_id: asset.variant_id,
                    uri: text(&content_uri(&asset.digest))?,
                });
                if !content.iter().any(|existing: &ContentRef| existing.sha256 == asset.digest) {
                    content.push(Self::content_ref(asset)?);
                }
            }
            plugins.push(plugin.clone());
        }
        let _ = now_ms;
        Ok((plugins, aliases, content))
    }
}

/// A stored candidate is usable offline only while every required object is
/// still present and verified. Opening a suspect CAS record re-hashes it.
pub async fn verify_cached(
    context: &DaemonContext,
    candidate: &Candidate,
) -> Result<Vec<Sha256Digest>, PreparationError> {
    let store = context.cas.clone().ok_or(PreparationError::StoreUnavailable)?;
    let mut digests = BTreeSet::new();
    for asset in &candidate.required_downloads {
        let Some((_, record)) = store.open_verified(&asset.digest).await? else {
            return Err(PreparationError::Missing);
        };
        if record.size_bytes != asset.size_bytes {
            return Err(PreparationError::SizeMismatch);
        }
        digests.insert(asset.digest);
    }
    Ok(digests.into_iter().collect())
}

/// CAS pin holder for one prepared manifest.
pub fn pin_holder(manifest: &Sha256Digest) -> String {
    format!("{PIN_PREFIX}{}", manifest.to_hex())
}

pub const PIN_PREFIX: &str = "manifest-";

/// The manifest's identity: SHA-256 of its encoding without the two
/// per-request clock members, so an unchanged manifest keeps its identity and
/// any other change produces a new one.
pub fn manifest_digest(document: &Value) -> Sha256Digest {
    let mut stable = document.clone();
    if let Some(members) = stable.as_object_mut() {
        members.remove("serverTime");
        members.remove("generatedAt");
    }
    Sha256Digest::of(&serde_json::to_vec(&stable).unwrap_or_default())
}

pub fn activation_grace_ms(document: &Value) -> i64 {
    let seconds = document
        .get("activationGraceSeconds")
        .and_then(Value::as_u64)
        .filter(|seconds| *seconds > 0)
        .unwrap_or(DEFAULT_ACTIVATION_GRACE_SECONDS)
        .clamp(1, 3_600);
    (seconds * 1_000) as i64
}

#[derive(Debug, thiserror::Error)]
pub enum PreparationError {
    #[error("the content store is unavailable")]
    StoreUnavailable,
    #[error("a manifest download path is invalid")]
    InvalidDownloadPath,
    #[error("the content store failed: {0}")]
    Store(#[from] CasError),
    #[error("a required object could not be fetched: {0}")]
    Fetch(#[from] FetchError),
    #[error("a cached object has the wrong size")]
    SizeMismatch,
    #[error("a required object is not in the content store")]
    Missing,
}

impl PreparationError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::StoreUnavailable => "content_store_unavailable",
            Self::InvalidDownloadPath => "download_path_invalid",
            Self::Store(_) => "content_store_failed",
            Self::Fetch(_) => "media_fetch_failed",
            Self::SizeMismatch => "media_size_mismatch",
            Self::Missing => "media_missing",
        }
    }
}

/// Where preparation obtains verified bytes. Production uses the
/// authenticated origin (docs/tilecast-edge.md §9.2); tests substitute
/// failing or corrupt sources. Every source feeds the same `Fetcher`, and the
/// content store verifies every byte.
pub trait SourcePlan: Send + Sync {
    fn sources(
        &self,
        digest: Sha256Digest,
        size: u64,
        origin_path: &str,
    ) -> impl std::future::Future<Output = Result<Vec<Arc<dyn BlobSource>>, PreparationError>> + Send;
    fn observer(&self, digest: Sha256Digest) -> Option<Box<dyn FetchObserver + '_>>;
}

/// The authenticated Tilecast Server origin.
#[derive(Debug)]
pub struct OriginSources<'a> {
    pub server: &'a AuthenticatedServer,
}

impl SourcePlan for OriginSources<'_> {
    async fn sources(
        &self,
        _digest: Sha256Digest,
        _size: u64,
        origin_path: &str,
    ) -> Result<Vec<Arc<dyn BlobSource>>, PreparationError> {
        let origin = OriginBlobSource::new(self.server.clone(), origin_path)
            .map_err(|_| PreparationError::InvalidDownloadPath)?;
        Ok(vec![Arc::new(origin) as Arc<dyn BlobSource>])
    }

    fn observer(&self, _digest: Sha256Digest) -> Option<Box<dyn FetchObserver + '_>> {
        None
    }
}

/// Fetches one object into the CAS through the verified `Fetcher`.
pub async fn fetch_object<P: SourcePlan>(
    store: &edge_cas::ContentStore,
    plan: &P,
    digest: Sha256Digest,
    size_bytes: u64,
    origin_path: &str,
    meta: IngestMeta,
) -> Result<(), PreparationError> {
    if let Some((_, record)) = store.open_verified(&digest).await? {
        if record.size_bytes != size_bytes {
            return Err(PreparationError::SizeMismatch);
        }
        return Ok(());
    }
    let request = FetchRequest { digest, size_bytes, meta };
    let sources = plan.sources(digest, size_bytes, origin_path).await?;
    let observer = plan.observer(digest);
    let record = Fetcher::new(store.clone(), 2).fetch(&request, &sources, observer.as_deref()).await?;
    if record.size_bytes != size_bytes {
        return Err(PreparationError::SizeMismatch);
    }
    Ok(())
}

/// Fetches every variant the candidate needs. The caller persists and pins a
/// candidate only after this succeeds.
pub async fn prepare<P: SourcePlan>(
    store: &edge_cas::ContentStore,
    plan: &P,
    candidate: &Candidate,
) -> Result<Vec<Sha256Digest>, PreparationError> {
    let mut digests = BTreeSet::new();
    for asset in &candidate.required_downloads {
        let meta = IngestMeta {
            domain: Domain::Media,
            content_type: Some(asset.mime_type.clone()),
            source: SourceKind::Origin,
        };
        fetch_object(store, plan, asset.digest, asset.size_bytes, &asset.download_path, meta).await?;
        digests.insert(asset.digest);
    }
    for digest in &digests {
        if store.verified_path(digest).await?.is_none() {
            return Err(PreparationError::Missing);
        }
    }
    Ok(digests.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: &str = "c791e841-b6ab-4e3f-a9f5-3b763cb47bd9";
    const ASSET: &str = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
    const VARIANT: &str = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";
    const ITEM: &str = "ca48c671-8e48-4bad-ab75-6125064d0f5c";
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
            "playlist": {"id": "e719e602-3b8f-4a2f-bec5-24b16e14725f", "items": [{
                "id": ITEM, "assetId": ASSET, "variantId": VARIANT,
                "assetType": "image", "deliveryPolicy": "automatic", "durationMs": 10000,
                "fitMode": "cover", "transition": "fade", "audioEnabled": true, "volume": 0.8
            }]},
            "playlists": [], "schedules": [], "websites": [], "widgets": [], "dataSources": [],
            "plugins": [], "layouts": []
        })
    }

    fn parse(value: Value) -> Result<Candidate, ManifestError> {
        Candidate::parse(value, SCREEN.parse().unwrap(), manifest_id())
    }

    #[test]
    fn accepts_exact_server_asset_identity_and_requires_every_variant() {
        let parsed = parse(manifest()).unwrap();
        assert_eq!(parsed.version, 8);
        assert_eq!(parsed.assets[0].digest.to_hex(), DIGEST);
        assert_eq!(parsed.required_downloads, parsed.assets);
        assert!(incompatibilities(&parsed.document, &parsed.assets).is_empty());
    }

    #[test]
    fn resolves_server_playlist_into_shared_renderer_contract() {
        let candidate = parse(manifest()).unwrap();
        let resolved = candidate.presentation(1_000).unwrap();
        let PresentationDocument::Playing { items, takeover, generation, .. } = resolved.document else {
            panic!("assigned playlist should produce a playing presentation");
        };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id.as_str(), ITEM);
        assert_eq!(items[0].kind, ItemKind::Image);
        assert_eq!(items[0].src.as_str(), format!("tcmedia://sha256/{DIGEST}"));
        assert_eq!(items[0].duration_ms, Some(10_000));
        assert_eq!(items[0].fit_mode.as_str(), "cover");
        assert_eq!(items[0].transition.as_ref().unwrap().as_str(), "fade");
        assert!(!takeover);
        assert_eq!(generation, 8);
        assert_eq!(resolved.content.len(), 1);
        assert!(resolved.projection.is_none());
    }

    #[test]
    fn availability_is_half_open_and_rechecks_at_its_boundary() {
        let mut value = manifest();
        value["playlist"]["items"][0]["availableFrom"] = serde_json::json!("1970-01-01T00:00:02Z");
        let candidate = parse(value).unwrap();
        let before = candidate.presentation(1_000).unwrap();
        assert!(matches!(before.document, PresentationDocument::Unavailable(_)));
        assert_eq!(before.next_transition_ms, Some(2_000));
        let at_boundary = candidate.presentation(2_000).unwrap();
        assert!(matches!(at_boundary.document, PresentationDocument::Playing { .. }));
    }

    #[test]
    fn accepts_every_schema_the_server_compiler_emits_and_nothing_else() {
        for schema in [11, 12, 13, 14, 15] {
            let mut value = manifest();
            value["schemaVersion"] = serde_json::json!(schema);
            assert!(parse(value).is_ok(), "schema {schema}");
        }
        for schema in [10, 16] {
            let mut value = manifest();
            value["schemaVersion"] = serde_json::json!(schema);
            assert_eq!(parse(value).unwrap_err(), ManifestError::Schema, "schema {schema}");
        }
    }

    #[test]
    fn rejects_wrong_target_missing_variant_and_invalid_references() {
        assert_eq!(
            Candidate::parse(manifest(), ScreenId::new_random(), manifest_id()).unwrap_err(),
            ManifestError::Screen
        );
        let mut value = manifest();
        value["playlist"]["items"][0]["variantId"] = Value::Null;
        assert_eq!(parse(value).unwrap_err(), ManifestError::Reference);
        let mut value = manifest();
        value["playlist"]["items"][0]["layoutId"] = serde_json::json!(LAYOUT);
        assert_eq!(parse(value).unwrap_err(), ManifestError::Reference, "layout item must name a projected layout");
        let mut value = manifest();
        value["playlist"]["items"][0]["assetType"] = serde_json::json!("widget");
        assert_eq!(parse(value).unwrap_err(), ManifestError::Reference, "widget item must name a projected widget");
        let mut value = manifest();
        value["layouts"] = serde_json::json!([{"id": LAYOUT, "document": {"canvas": {"backgroundAssetId": ASSET},
            "placements": []}}]);
        assert_eq!(parse(value).unwrap_err(), ManifestError::Reference, "layout background needs an exact variant");
    }

    #[test]
    fn rejects_untrusted_paths_duplicates_and_conflicting_hash_claims() {
        let mut value = manifest();
        value["assets"][0]["downloadPath"] = serde_json::json!("https://other.example/media");
        assert_eq!(parse(value).unwrap_err(), ManifestError::Asset);
        let mut value = manifest();
        let duplicate = value["assets"][0].clone();
        value["assets"].as_array_mut().unwrap().push(duplicate);
        assert_eq!(parse(value).unwrap_err(), ManifestError::Asset, "duplicate variant identity");
        let mut value = manifest();
        let mut second = value["assets"][0].clone();
        second["variantId"] = serde_json::json!("473f4f7b-2ac9-47a3-8872-f0a309ecae83");
        second["fileSize"] = serde_json::json!(101);
        value["assets"].as_array_mut().unwrap().push(second);
        assert_eq!(parse(value).unwrap_err(), ManifestError::Asset, "same digest, conflicting size");
        let mut value = manifest();
        value["playlist"]["items"][0]["deliveryPolicy"] = serde_json::json!("sometimes");
        assert_eq!(parse(value).unwrap_err(), ManifestError::DeliveryPolicy);
    }

    #[test]
    fn enforces_bounds_and_schedule_validity() {
        let mut value = manifest();
        let asset = value["assets"][0].clone();
        value["assets"] = Value::Array(
            (0..=MAX_ASSETS)
                .map(|index| {
                    let mut asset = asset.clone();
                    asset["variantId"] = serde_json::json!(uuid::Uuid::from_u128(index as u128).to_string());
                    asset
                })
                .collect(),
        );
        assert_eq!(parse(value).unwrap_err(), ManifestError::Bound);
        let mut value = manifest();
        value["schedules"] = serde_json::json!([{"id": ITEM, "playlistId": ITEM, "type": "weekly", "timezone": "Mars/Base",
            "priority": 1, "specificity": 1, "dailyStart": "08:00", "dailyEnd": "09:00", "daysOfWeek": [1]}]);
        assert_eq!(parse(value).unwrap_err(), ManifestError::Schedule);
    }

    #[test]
    fn unsupported_capabilities_are_typed_not_dropped() {
        type Mutate = Box<dyn Fn(&mut Value)>;
        let cases: Vec<(Mutate, &str)> = vec![
            (
                Box::new(|v| v["websites"] = serde_json::json!([{"assetId": ASSET}])),
                "presentation_incompatible_website",
            ),
            (
                Box::new(|v| v["playlist"]["items"][0]["deliveryPolicy"] = serde_json::json!("stream")),
                "presentation_incompatible_streaming_delivery",
            ),
            (
                // A group without an epoch cannot be placed on a shared timeline.
                Box::new(|v| v["syncGroup"] = serde_json::json!({"id": ITEM})),
                "presentation_incompatible_synchronized_playback",
            ),
            (Box::new(|v| v["viewport"] = serde_json::json!({"x": 0})), "presentation_incompatible_span"),
            (
                Box::new(|v| {
                    v["plugins"] = serde_json::json!([{"id": ITEM, "type": "noise_meter", "version": 1, "config": {}}])
                }),
                "presentation_incompatible_plugin",
            ),
            (
                Box::new(|v| {
                    v["widgets"] = serde_json::json!([{"assetId": WIDGET, "name": "Clip", "provider": "youtube"}]);
                }),
                "presentation_incompatible_youtube",
            ),
            (
                Box::new(|v| {
                    v["widgets"] = serde_json::json!([{"assetId": WIDGET, "name": "Future",
                        "presentation": {"schemaVersion": 1, "kind": "native", "requiredCapabilities": {"content.hologram": 1},
                            "native": {"root": {"type": "text"}}}}]);
                }),
                "presentation_incompatible_widget_capability",
            ),
        ];
        for (mutate, code) in cases {
            let mut value = manifest();
            mutate(&mut value);
            let candidate = parse(value).unwrap();
            let reasons = incompatibilities(&candidate.document, &candidate.assets);
            assert_eq!(reasons.first().map(Incompatibility::code), Some(code));
        }
        let mut value = manifest();
        value["assets"][0]["mimeType"] = serde_json::json!("video/mp4");
        value["assets"][0]["fileSize"] = serde_json::json!(AUTOMATIC_VIDEO_LIMIT_BYTES + 1);
        let candidate = parse(value).unwrap();
        assert_eq!(
            incompatibilities(&candidate.document, &candidate.assets),
            vec![Incompatibility::StreamingDelivery],
            "automatic video above the download threshold would need streaming"
        );
    }

    #[test]
    fn synchronized_groups_share_one_anchor_and_the_reference_durations() {
        const VIDEO: &str = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
        const VIDEO_VARIANT: &str = "6b5c4d3e-2f1a-4b0c-9d8e-7f6a5b4c3d2e";
        let mut value = manifest();
        value["syncGroup"] = serde_json::json!({"id": "lobby-wall", "playbackEpoch": "2026-09-01T00:00:00Z"});
        value["assets"].as_array_mut().unwrap().push(serde_json::json!({"assetId": VIDEO, "variantId": VIDEO_VARIANT,
            "sha256": "f".repeat(64), "fileSize": 200, "mimeType": "video/mp4", "durationSeconds": 12.5,
            "downloadPath": format!("/api/v1/player/assets/{VIDEO}/variants/{VIDEO_VARIANT}")}));
        value["playlist"]["items"].as_array_mut().unwrap().push(serde_json::json!({
            "id": "7c6d5e4f-3a2b-4c1d-8e9f-0a1b2c3d4e5f", "assetId": VIDEO, "variantId": VIDEO_VARIANT,
            "assetType": "video", "deliveryPolicy": "automatic", "videoStartOffsetMs": 2500,
            "fitMode": "contain", "transition": "none", "audioEnabled": false, "volume": 0}));
        let candidate = parse(value.clone()).unwrap();
        assert!(incompatibilities(&candidate.document, &candidate.assets).is_empty());
        let resolved = candidate.presentation(1_789_000_000_000).unwrap();
        let timing = resolved.timing.expect("group timing");
        assert_eq!(timing.group_id, "lobby-wall");
        assert_eq!(timing.anchor_ms, "2026-09-01T00:00:00Z".parse::<jiff::Timestamp>().unwrap().as_millisecond());
        // The image's authored 10 s; the video's trimmed file length.
        assert_eq!(timing.durations_ms, vec![10_000, 10_000]);
        let PresentationDocument::Playing { synchronized, .. } = resolved.document else { panic!("playing") };
        assert!(synchronized);

        // A takeover anchors on its activation, not the epoch.
        let takeover_playlist = "8d7e6f5a-4b3c-4d2e-9f0a-1b2c3d4e5f6a";
        value["playlists"] =
            serde_json::json!([{"id": takeover_playlist, "items": [value["playlist"]["items"][0].clone()]}]);
        value["takeover"] = serde_json::json!({"id": ITEM, "playlistId": takeover_playlist,
            "activatedAt": "2026-09-24T10:00:00Z", "expiresAt": "2099-01-01T00:00:00Z"});
        let candidate = parse(value).unwrap();
        let at = "2026-09-24T10:05:00Z".parse::<jiff::Timestamp>().unwrap().as_millisecond();
        let timing = candidate.presentation(at).unwrap().timing.expect("group timing");
        assert_eq!(timing.anchor_ms, "2026-09-24T10:00:00Z".parse::<jiff::Timestamp>().unwrap().as_millisecond());

        // No group, no timeline.
        assert!(parse(manifest()).unwrap().presentation(at).unwrap().timing.is_none());
    }

    #[test]
    fn time_bound_widgets_are_compatible() {
        let mut value = manifest();
        value["widgets"] = serde_json::json!([{"assetId": WIDGET, "name": "Lobby clock", "provider": "clock",
            "presentation": {"schemaVersion": 1, "kind": "native",
                "requiredCapabilities": {"content.text": 1, "binding.core": 1, "environment.time": 1},
                "native": {"root": {"type": "text", "binding": {"source": "environment", "path": "currentTime",
                    "format": "time:24:false:UTC"}}}}}]);
        let candidate = parse(value).unwrap();
        assert!(incompatibilities(&candidate.document, &candidate.assets).is_empty());
        assert_eq!(profile::native_capability("environment.time"), 1);
    }

    #[test]
    fn layouts_and_widgets_travel_as_projection_references() {
        let mut value = manifest();
        value["schemaVersion"] = serde_json::json!(13);
        value["layouts"] = serde_json::json!([{"id": LAYOUT, "document": {"schemaVersion": 2,
            "canvas": {"width": 1920, "height": 1080, "backgroundAssetId": ASSET, "backgroundVariantId": VARIANT},
            "placements": [{"id": "zone", "type": "widget", "widgetId": WIDGET}]}}]);
        value["widgets"] = serde_json::json!([{"assetId": WIDGET, "name": "Clock", "provider": "clock",
            "presentation": {"schemaVersion": 1, "kind": "native", "requiredCapabilities": {"content.text": 1},
                "native": {"root": {"type": "text"}}}}]);
        value["playlist"]["items"] = serde_json::json!([
            {"id": ITEM, "assetId": LAYOUT, "layoutId": LAYOUT, "assetType": "layout", "deliveryPolicy": "stream",
             "durationMs": 5000, "fitMode": "contain", "transition": "none", "audioEnabled": false, "volume": 0},
            {"id": "ab6f2c1d-4b2e-4e1f-9a3c-2d1e0f9b8a7c", "assetId": WIDGET, "assetType": "widget",
             "deliveryPolicy": "stream", "durationMs": 5000, "fitMode": "contain", "transition": "none",
             "audioEnabled": false, "volume": 0}
        ]);
        let candidate = parse(value).unwrap();
        assert!(incompatibilities(&candidate.document, &candidate.assets).is_empty());
        let resolved = candidate.presentation(1_000).unwrap();
        let PresentationDocument::Playing { items, .. } = &resolved.document else { panic!("playing") };
        assert_eq!(items[0].kind, ItemKind::Layout);
        assert_eq!(items[0].layout.as_ref().unwrap()["layoutId"], LAYOUT);
        assert_eq!(items[1].kind, ItemKind::Widget);
        assert_eq!(items[1].widget.as_ref().unwrap()["widgetAssetId"], WIDGET);
        let projection = resolved.projection.expect("projection context");
        assert_eq!(projection.media.len(), 1);
        assert_eq!(projection.media[0].uri.as_str(), format!("tcmedia://sha256/{DIGEST}"));
        assert!(projection.manifest["layouts"].is_array());
        assert_eq!(resolved.content.len(), 1, "layout background media is part of the activation");
        edge_protocol::ipc::presentation::validate_content_references(&resolved.document, &resolved.content).unwrap();
    }

    #[test]
    fn directly_assigned_layout_is_one_fullscreen_item() {
        let mut value = manifest();
        value["playlist"] = Value::Null;
        value["layouts"] = serde_json::json!([{"id": LAYOUT, "document": {"schemaVersion": 2,
            "canvas": {"width": 1920, "height": 1080}, "placements": []}}]);
        value["layout"] = value["layouts"][0].clone();
        value["directFallbackLayout"] = value["layouts"][0].clone();
        let candidate = parse(value).unwrap();
        let resolved = candidate.presentation(1_000).unwrap();
        let PresentationDocument::Playing { items, .. } = &resolved.document else { panic!("playing") };
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id.as_str(), format!("layout-{LAYOUT}"));
    }

    #[test]
    fn brand_bug_media_is_aliased_and_part_of_the_activation() {
        let mut value = manifest();
        value["plugins"] = serde_json::json!([{"id": ITEM, "type": "brand_bug", "version": 1,
            "config": {"corner": "top-right", "imageAssetId": ASSET, "imageVariantId": VARIANT}}]);
        let candidate = parse(value).unwrap();
        let resolved = candidate.presentation(1_000).unwrap();
        assert_eq!(resolved.plugins.len(), 1);
        assert_eq!(resolved.plugin_aliases.len(), 1);
        assert_eq!(resolved.plugin_aliases[0].asset_id.to_string(), ASSET);
    }

    #[test]
    fn activation_grace_uses_server_default_and_clamps_to_the_player_bounds() {
        assert_eq!(activation_grace_ms(&serde_json::json!({})), 30_000);
        assert_eq!(activation_grace_ms(&serde_json::json!({"activationGraceSeconds": 0})), 30_000);
        assert_eq!(activation_grace_ms(&serde_json::json!({"activationGraceSeconds": 0.5})), 30_000);
        assert_eq!(activation_grace_ms(&serde_json::json!({"activationGraceSeconds": 9_000})), 3_600_000);
        assert_eq!(activation_grace_ms(&serde_json::json!({"activationGraceSeconds": 1})), 1_000);
    }
}
