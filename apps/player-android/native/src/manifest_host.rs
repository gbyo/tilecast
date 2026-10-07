//! Android manifest candidate and worker host.
//!
//! Core owns manifest identity, resource validation, verified preparation,
//! and pins ([`player_core::NativeManifest`],
//! [`player_core::ManifestCoordinator`]). This module owns what Core
//! cannot: the Android packaged renderer profile and the renderer
//! compatibility check over it. The shared Player Runtime is identical on
//! every host, so the declarative and Widget component capabilities come
//! from the same generated lists Edge uses; the renderer feature list and
//! the component presentation schemas are Android's own.
//!
//! [`AndroidManifestHost`] implements [`player_core::ManifestWorkerHost`]
//! for the server-link driver. The one-shot [`AndroidManifestHost::prepare_target`]
//! below serves
//! test tooling (and later background paths) with the same coordinator.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use player_cas::ContentStore;
use player_client::AuthenticatedServer;
use player_core::{
    ConnectedRendererProfile, ManifestOriginSources, ManifestPreparationError, ManifestPrepared, ManifestWorkerFailure,
    ManifestWorkerHost, NativeManifest, NativeManifestError, PlayerCore, RendererRequirement, RendererSupport,
};
use player_state::repo::manifests::Target;
use player_types::ScreenId;
use player_types::Timestamp;
use player_types::bounded::ShortToken;
use player_types::time::SharedClock;
use serde_json::Value;

pub mod profile {
    //! The renderer's packaged support: what this release can provide
    //! before any renderer process advertises.
    use super::WEB_RUNTIME_VERSION;
    pub use super::WIDGET_COMPONENTS;
    use super::{COMPONENT_PRESENTATION_SCHEMA, SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES};
    use player_core::{PackagedRendererProfile, RendererSupport};
    use player_types::bounded::ShortToken;
    use std::collections::BTreeMap;

    /// Renderer features (`renderer.ready` vocabulary) the trusted runtime
    /// implements under the Android WebView host.
    pub const FEATURES: &[&str] = &[
        "status-surfaces-v1",
        "image",
        "video",
        "render-tree-v1",
        "layout-v1",
        "synchronized-playback-v1",
        "span-viewport-v1",
        "plugin.countdown_bar",
        "plugin.alert_ticker",
        // No plugin.brand_bug: the Android Player has no brand-bug surface.
        "remote-web-v1",
        "website",
        "youtube",
    ];

    /// Presentation schemas the Android host applies: 1 (declarative and
    /// web) and 2 (first-class Widget components). Schema 3 (declared
    /// empty policy) needs host-side empty-skip handling the Android
    /// Player has not implemented yet.
    pub const PRESENTATION_SCHEMAS: &[u32] = &[1, COMPONENT_PRESENTATION_SCHEMA];

    /// Declarative capabilities the heartbeat reports: the shared
    /// runtime list plus the `web.remote` capability the remote host
    /// provides. Preparation enforces the same set.
    pub fn native_capabilities() -> BTreeMap<&'static str, u32> {
        SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES
            .iter()
            .copied()
            .chain(std::iter::once(("web.remote", WEB_RUNTIME_VERSION)))
            .collect()
    }

    /// The packaged profile for preparation-time compatibility checks.
    /// Every name comes from generator-validated lists, so construction
    /// cannot fail: the `expect` below guards a build-time invariant.
    pub fn packaged() -> PackagedRendererProfile {
        let token = |name: &str| ShortToken::new(name).expect("generated capability name");
        PackagedRendererProfile(
            RendererSupport::new(
                FEATURES.iter().map(|name| token(name)).collect(),
                PRESENTATION_SCHEMAS.iter().copied().collect(),
                SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES
                    .iter()
                    .map(|(name, version)| (token(name), *version))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .chain(std::iter::once((token("web.remote"), WEB_RUNTIME_VERSION)))
                    .collect(),
                WIDGET_COMPONENTS.iter().map(|(name, version)| (token(name), *version)).collect(),
            )
            .expect("bounded installed runtime profile"),
        )
    }
}

pub use crate::presentation_capabilities::SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES;
pub use crate::widget_capabilities::{COMPONENT_PRESENTATION_SCHEMA, WIDGET_COMPONENTS};

/// The `web.remote` declarative capability: remote web in the Android
/// remote host, shown through the renderer's remote web surface.
pub const WEB_RUNTIME_VERSION: u32 = 1;

/// What the renderer cannot safely provide, and why.
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
    #[error("manifest contains an invalid Widget bundle claim")]
    Bundle,
    #[error("manifest is incompatible with this renderer")]
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
            Self::Bundle => "manifest_bundle_invalid",
            Self::Incompatible(reason) => reason.code(),
        }
    }
}

impl From<NativeManifestError> for ManifestError {
    fn from(error: NativeManifestError) -> Self {
        match error {
            NativeManifestError::Structure => Self::Structure,
            NativeManifestError::Schema => Self::Schema,
            NativeManifestError::Screen => Self::Screen,
            NativeManifestError::Bound => Self::Bound,
            NativeManifestError::Asset => Self::Asset,
            NativeManifestError::Reference => Self::Reference,
            NativeManifestError::DeliveryPolicy => Self::DeliveryPolicy,
            NativeManifestError::Schedule => Self::Schedule,
            NativeManifestError::Bundle => Self::Bundle,
        }
    }
}

fn playlists_of(document: &Value) -> impl Iterator<Item = &Value> {
    ["playlist", "directFallbackPlaylist"]
        .into_iter()
        .filter_map(|key| document.get(key).filter(|value| !value.is_null()))
        .chain(document.get("playlists").and_then(Value::as_array).into_iter().flatten())
}

/// This screen's panel of a Span canvas, or `None` for a Mirror screen.
/// Both objects must be present and the panel must lie inside the canvas.
fn span_viewport(document: &Value) -> Result<(), Incompatibility> {
    const MAX_EDGE: u64 = 65_536;
    let present = |key: &str| document.get(key).filter(|value| !value.is_null());
    let (canvas, viewport) = match (present("canvas"), present("viewport")) {
        (None, None) => return Ok(()),
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
    field(viewport, "order", 1_024)?;
    if width == 0 || height == 0 || x + width > canvas_width || y + height > canvas_height || rotation % 90 != 0 {
        return Err(Incompatibility::SpanViewport);
    }
    for key in ["bezelLeft", "bezelTop", "bezelRight", "bezelBottom"] {
        if let Some(value) = viewport.get(key).filter(|value| !value.is_null()) {
            value.as_u64().filter(|n| *n <= MAX_EDGE).ok_or(Incompatibility::SpanViewport)?;
        }
    }
    Ok(())
}

/// Manifest facts the heartbeat and status share: what the last
/// successful preparation staged. Updated only on success, so a failed
/// sync never clears the content the player still holds.
#[derive(Debug, Clone, Default)]
pub struct ManifestFacts {
    /// The direct-fallback playlist the server assigned, if any.
    pub assigned_playlist_id: Option<String>,
    /// The staged fallback presentation the player can show offline.
    pub cached_fallback_available: bool,
    /// When the last preparation succeeded.
    pub last_successful_sync: Option<Timestamp>,
}

/// Shared manifest facts, written by preparation and read by the
/// heartbeat, status, and commissioning display.
pub type SharedManifestFacts = Arc<Mutex<ManifestFacts>>;

/// The connected profile before any renderer proves itself: the release
/// features, schema 1, and the legacy declarative table, with no Widget
/// components. Mirrors the legacy fresh-process advertisement.
pub fn fresh_connected() -> ConnectedRendererProfile {
    let token = |name: &str| ShortToken::new(name).expect("generated capability name");
    ConnectedRendererProfile(
        RendererSupport::new(
            profile::FEATURES.iter().map(|name| token(name)).collect(),
            BTreeSet::from([1]),
            profile::native_capabilities().into_iter().map(|(name, version)| (token(name), version)).collect(),
            BTreeMap::new(),
        )
        .expect("bounded fresh-process profile"),
    )
}

/// Everything in `document` this renderer cannot safely provide. An empty
/// list means compatible. The packaged release and the live connection
/// both have to accept a requirement: release metadata cannot substitute
/// for an actual advertisement.
pub fn incompatibilities(
    document: &Value,
    assets: &[player_core::ManifestAsset],
    connected: &ConnectedRendererProfile,
) -> Vec<Incompatibility> {
    if connected.presentation_schemas().is_empty() {
        return vec![Incompatibility::Requirement("renderer support".to_owned())];
    }
    let packaged = profile::packaged();
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
                // Only remote pages run in the Android remote host; a
                // bundled web Widget needs a verified package runtime
                // Android does not have.
                Some("web")
                    if presentation.get("web").and_then(|web| web.get("mode")).and_then(Value::as_str)
                        == Some("remote") => {}
                Some("web") => push(Incompatibility::Requirement("web bundle".to_owned())),
                _ => push(Incompatibility::WidgetCapability("presentation kind".to_owned())),
            }
            if let Some(required) = presentation.get("requiredCapabilities").and_then(Value::as_object) {
                for (name, version) in required {
                    let requirement = version
                        .as_u64()
                        .and_then(|v| u32::try_from(v).ok())
                        .filter(|v| *v > 0)
                        .zip(ShortToken::new(name).ok())
                        .map(|(version, name)| {
                            if name.as_str().starts_with("widget.") {
                                RendererRequirement::WidgetComponent { name, version }
                            } else {
                                RendererRequirement::Declarative { name, version }
                            }
                        });
                    if requirement
                        .as_ref()
                        .is_none_or(|required| packaged.check_connected(connected, required).is_err())
                    {
                        push(Incompatibility::WidgetCapability(name.chars().take(64).collect()));
                    }
                }
            }
        }
    }
    let by_variant: BTreeMap<(uuid::Uuid, uuid::Uuid), &player_core::ManifestAsset> =
        assets.iter().map(|asset| ((asset.asset_id, asset.variant_id), asset)).collect();
    for playlist in playlists_of(document) {
        for item in playlist.get("items").and_then(Value::as_array).into_iter().flatten() {
            let kind = item.get("assetType").and_then(Value::as_str).unwrap_or("");
            if item.get("layoutId").is_some_and(|id| !id.is_null()) || kind == "widget" {
                continue;
            }
            match kind {
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
            // every byte is verified before use, so such items download
            // into the store like any other. One too large for the store
            // fails preparation with the store's typed reason and the
            // committed presentation stays.
        }
    }
    if document.get("syncGroup").is_some_and(|group| {
        !group.is_null()
            && (group.get("id").and_then(Value::as_str).is_none_or(|id| id.is_empty() || id.len() > 64)
                || group
                    .get("playbackEpoch")
                    .and_then(Value::as_str)
                    .and_then(|epoch| {
                        time::OffsetDateTime::parse(epoch, &time::format_description::well_known::Rfc3339).ok()
                    })
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
        if !profile::FEATURES.contains(&format!("plugin.{kind}").as_str()) {
            push(Incompatibility::Plugin(kind.chars().take(32).collect()));
        }
    }
    out
}

/// Validates a server manifest and its compatibility with this renderer.
/// Nothing is fetched here.
pub fn prepare_candidate(
    document: Value,
    expected_screen: ScreenId,
    connected: &ConnectedRendererProfile,
) -> Result<NativeManifest, ManifestError> {
    let digest = player_core::manifest_digest(&document);
    let candidate = NativeManifest::parse(document, expected_screen, digest)?;
    if let Some(reason) = incompatibilities(&candidate.document, &candidate.assets, connected).into_iter().next() {
        return Err(ManifestError::Incompatible(reason));
    }
    Ok(candidate)
}

/// The staged-manifest facts a successful preparation reports: the
/// assigned direct-fallback playlist, whether its presentation is on
/// disk, and when the sync succeeded. Mirrors the legacy reliability
/// preferences the commissioning display reads.
fn manifest_facts(document: &Value, now: Timestamp) -> ManifestFacts {
    let fallback = document.get("directFallbackPlaylist").filter(|value| !value.is_null());
    let assigned_playlist_id = fallback
        .and_then(|playlist| playlist.get("id"))
        .and_then(Value::as_str)
        .map(|id| id.chars().take(128).collect());
    let playlist_items = fallback
        .and_then(|playlist| playlist.get("items"))
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty());
    let layout = document.get("directFallbackLayout").is_some_and(|value| !value.is_null());
    ManifestFacts {
        assigned_playlist_id,
        cached_fallback_available: playlist_items || layout,
        last_successful_sync: Some(now),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    #[error(transparent)]
    Fetch(#[from] ManifestPreparationError),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error("local state failed")]
    State,
}

impl PrepareError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Fetch(error) => error.reason_code(),
            Self::Manifest(error) => error.reason_code(),
            Self::State => "state_error",
        }
    }

    /// Deterministic for this exact manifest: retrying cannot change the
    /// outcome, so the player waits for a new target.
    pub fn is_final(&self) -> bool {
        matches!(self, Self::Manifest(_))
    }
}

/// Android's [`ManifestWorkerHost`]: renderer compatibility plus the
/// authenticated origin. Verified preparation and pending storage use
/// the native manifest coordinator.
#[derive(Debug)]
pub struct AndroidManifestHost {
    core: PlayerCore,
    cas: ContentStore,
    server: AuthenticatedServer,
    engine: Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>,
    clock: SharedClock,
    facts: SharedManifestFacts,
}

impl AndroidManifestHost {
    pub fn new(
        core: PlayerCore,
        cas: ContentStore,
        server: AuthenticatedServer,
        engine: Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>,
        clock: SharedClock,
        facts: SharedManifestFacts,
    ) -> Self {
        Self { core, cas, server, engine, clock, facts }
    }

    /// The connected profile compatibility checks use: the live
    /// renderer's advertisement, or the fresh-process fallback before
    /// any renderer proves itself.
    async fn connected(&self) -> ConnectedRendererProfile {
        self.engine.lock().await.advertised_support().unwrap_or_else(fresh_connected)
    }

    /// Core records the latest validated manifest as the binding's target.
    pub async fn reconcile(
        &self,
        binding: &player_state::repo::manifests::Binding,
    ) -> Result<Option<Target>, player_core::ManifestSyncError> {
        self.core.manifests().reconcile(&self.server, binding).await
    }

    /// Prepares the persisted target through the native coordinator:
    /// compatibility first, then verified content, then pending storage.
    pub async fn prepare_target(&self, target: &Target) -> Result<ManifestPrepared, PrepareError> {
        let connected = self.connected().await;
        let candidate = prepare_candidate(target.document.clone(), target.binding.screen_id, &connected)?;
        let plan = ManifestOriginSources { server: &self.server };
        let prepared =
            self.core.manifests().prepare_target(&self.cas, &plan, target, &candidate).await.map_err(|error| {
                match error {
                    ManifestPreparationError::State => PrepareError::State,
                    other => PrepareError::Fetch(other),
                }
            })?;
        // A superseded preparation staged nothing for this document;
        // every other success publishes the staged-manifest facts.
        if !matches!(prepared, ManifestPrepared::Superseded) {
            let facts = manifest_facts(&target.document, self.clock.now());
            *self.facts.lock().unwrap_or_else(|error| error.into_inner()) = facts;
        }
        Ok(prepared)
    }
}

fn worker_failure(error: &PrepareError) -> ManifestWorkerFailure {
    let kind = match error {
        PrepareError::Manifest(ManifestError::Incompatible(_)) => player_core::ManifestFailureKind::Incompatible,
        error if error.is_final() => player_core::ManifestFailureKind::Invalid,
        _ => player_core::ManifestFailureKind::Retryable,
    };
    ManifestWorkerFailure { kind, reason: error.reason_code() }
}

#[async_trait::async_trait]
impl ManifestWorkerHost for AndroidManifestHost {
    async fn content_intact(&self, target: &Target) -> bool {
        match prepare_candidate(target.document.clone(), target.binding.screen_id, &self.connected().await) {
            Ok(candidate) => candidate.verify_content(&self.cas).await.is_ok(),
            // Preserve the committed/pending policy: projection failure
            // cannot replace that document with another preparation of itself.
            Err(_) => true,
        }
    }

    async fn prepare(&self, target: &Target) -> Result<ManifestPrepared, ManifestWorkerFailure> {
        self.prepare_target(target).await.map_err(|error| worker_failure(&error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::{LruByDomain, StorePolicy};
    use player_state::{OpenOptions, StateDb};
    use serde_json::json;

    const SCREEN: &str = "c791e841-b6ab-4e3f-a9f5-3b763cb47bd9";
    const ASSET: &str = "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a";
    const VARIANT: &str = "46784d73-3daf-45cf-8ff0-7cb4a3d12852";
    const ITEM: &str = "ca48c671-8e48-4bad-ab75-6125064d0f5c";

    fn payload() -> Vec<u8> {
        let mut bytes = b"tilecast-manifest-bytes:".to_vec();
        bytes.resize(100, 0x5A);
        bytes
    }

    fn manifest() -> Value {
        let digest = player_types::Sha256Digest::of(&payload());
        json!({
            "schemaVersion": 11, "manifestVersion": 8, "screenId": SCREEN, "mode": "presentation",
            "assets": [{"assetId": ASSET, "variantId": VARIANT, "sha256": digest.to_hex(),
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

    fn screen() -> ScreenId {
        SCREEN.parse().expect("screen")
    }

    fn candidate_of(document: Value) -> NativeManifest {
        let digest = player_core::manifest_digest(&document);
        NativeManifest::parse(document, screen(), digest).expect("parse")
    }

    /// The connected profile of a fully proven renderer: everything
    /// the packaged release offers. Existing checks run against this so
    /// they keep testing packaged behavior.
    fn full_connected() -> ConnectedRendererProfile {
        let token = |name: &str| ShortToken::new(name).expect("generated capability name");
        ConnectedRendererProfile(
            RendererSupport::new(
                profile::FEATURES.iter().map(|name| token(name)).collect(),
                profile::PRESENTATION_SCHEMAS.iter().copied().collect(),
                profile::native_capabilities().into_iter().map(|(name, version)| (token(name), version)).collect(),
                profile::WIDGET_COMPONENTS.iter().map(|(name, version)| (token(name), *version)).collect(),
            )
            .expect("bounded full profile"),
        )
    }

    fn check(document: Value) -> Vec<Incompatibility> {
        check_as(document, &full_connected())
    }

    fn check_as(document: Value, connected: &ConnectedRendererProfile) -> Vec<Incompatibility> {
        let candidate = candidate_of(document.clone());
        incompatibilities(&candidate.document, &candidate.assets, connected)
    }

    #[test]
    fn compatible_manifest_passes() {
        let candidate = prepare_candidate(manifest(), screen(), &full_connected()).expect("candidate");
        assert_eq!(candidate.required_downloads.len(), 1);
        assert_eq!(candidate.version, 8);
    }

    #[test]
    fn brand_bug_plugin_is_incompatible_but_siblings_pass() {
        let mut document = manifest();
        document["plugins"] = json!([{"id": "p1", "type": "brand_bug", "version": 1, "config": {}}]);
        let found = check(document);
        assert_eq!(found, vec![Incompatibility::Plugin("brand_bug".to_owned())]);
        assert_eq!(found[0].code(), "presentation_incompatible_plugin");

        let mut document = manifest();
        document["plugins"] = json!([
            {"id": "p1", "type": "countdown_bar", "version": 1, "config": {}},
            {"id": "p2", "type": "alert_ticker", "version": 1, "config": {}},
        ]);
        assert!(check(document).is_empty());
    }

    #[test]
    fn widget_capabilities_check_against_the_packaged_profile() {
        // A real shared-runtime capability at a supported version passes.
        let mut document = manifest();
        document["widgets"] = json!([{
            "assetId": "0c3e1d2f-7a55-4b1e-9c33-6f0d2e8a4b91",
            "presentation": {"kind": "component", "requiredCapabilities": {"content.text": 1}},
        }]);
        assert!(check(document).is_empty());

        // Unknown capabilities and versions above the packaged release fail.
        let mut document = manifest();
        document["widgets"] = json!([{
            "assetId": "0c3e1d2f-7a55-4b1e-9c33-6f0d2e8a4b91",
            "presentation": {"kind": "component",
                "requiredCapabilities": {"content.text": 99, "content.nope": 1, "widget.tilecast.clock": 2}},
        }]);
        let found = check(document);
        assert!(found.contains(&Incompatibility::WidgetCapability("content.text".to_owned())), "{found:?}");
        assert!(found.contains(&Incompatibility::WidgetCapability("content.nope".to_owned())), "{found:?}");
        assert!(
            !found
                .iter()
                .any(|item| matches!(item, Incompatibility::WidgetCapability(name) if name == "widget.tilecast.clock")),
            "{found:?}"
        );
    }

    #[test]
    fn web_bundle_is_incompatible_while_remote_web_passes() {
        let mut document = manifest();
        document["widgets"] = json!([{
            "assetId": "0c3e1d2f-7a55-4b1e-9c33-6f0d2e8a4b91",
            "presentation": {"kind": "web", "web": {"mode": "bundled"}},
        }]);
        assert_eq!(check(document), vec![Incompatibility::Requirement("web bundle".to_owned())]);

        let mut document = manifest();
        document["widgets"] = json!([{
            "assetId": "0c3e1d2f-7a55-4b1e-9c33-6f0d2e8a4b91",
            "presentation": {"kind": "web", "web": {"mode": "remote"}},
        }]);
        assert!(check(document).is_empty());
    }

    #[test]
    fn sync_group_and_span_geometry_gate_compatibility() {
        let mut document = manifest();
        document["syncGroup"] = json!({"id": "", "playbackEpoch": "not-a-time"});
        assert_eq!(check(document), vec![Incompatibility::SynchronizedPlayback]);

        let mut document = manifest();
        document["syncGroup"] = json!({"id": "group-1", "playbackEpoch": "2026-10-05T00:00:00Z"});
        assert!(check(document).is_empty());

        let mut document = manifest();
        document["canvas"] = json!({"width": 3840, "height": 2160});
        document["viewport"] = json!({"x": 4000, "y": 0, "width": 1920, "height": 1080, "rotation": 0, "order": 1});
        assert_eq!(check(document), vec![Incompatibility::SpanViewport]);

        let mut document = manifest();
        document["canvas"] = json!({"width": 3840, "height": 2160});
        document["viewport"] = json!({"x": 0, "y": 0, "width": 1920, "height": 1080, "rotation": 0, "order": 1});
        assert!(check(document).is_empty());
    }

    #[test]
    fn foreign_and_broken_manifests_keep_their_reason_codes() {
        let other = ScreenId::from_uuid(uuid::Uuid::from_u128(0xBEAD));
        assert_eq!(
            prepare_candidate(manifest(), other, &full_connected()).expect_err("wrong screen"),
            ManifestError::Screen
        );
        assert_eq!(ManifestError::Screen.reason_code(), "manifest_wrong_screen");
        let mut document = manifest();
        document["assets"][0]["downloadPath"] = json!("https://evil.example/x");
        assert_eq!(
            prepare_candidate(document, screen(), &full_connected()).expect_err("bad path"),
            ManifestError::Asset
        );
        let mut document = manifest();
        document["playlist"]["items"][0]["deliveryPolicy"] = json!("pigeon");
        assert_eq!(
            prepare_candidate(document, screen(), &full_connected()).expect_err("bad policy"),
            ManifestError::DeliveryPolicy
        );
    }

    #[test]
    fn worker_failures_sort_by_kind() {
        let incompatible =
            worker_failure(&PrepareError::Manifest(ManifestError::Incompatible(Incompatibility::SpanViewport)));
        assert_eq!(incompatible.kind, player_core::ManifestFailureKind::Incompatible);
        assert_eq!(incompatible.reason, "presentation_incompatible_span");
        let invalid = worker_failure(&PrepareError::Manifest(ManifestError::Asset));
        assert_eq!(invalid.kind, player_core::ManifestFailureKind::Invalid);
        assert_eq!(invalid.reason, "manifest_asset_invalid");
        let retryable = worker_failure(&PrepareError::Fetch(ManifestPreparationError::Missing));
        assert_eq!(retryable.kind, player_core::ManifestFailureKind::Retryable);
        assert_eq!(retryable.reason, "media_missing");
        assert!(PrepareError::Manifest(ManifestError::Screen).is_final());
        assert!(!PrepareError::Fetch(ManifestPreparationError::Missing).is_final());
    }

    #[test]
    fn packaged_profile_matches_android_truth() {
        let packaged = profile::packaged();
        assert_eq!(profile::PRESENTATION_SCHEMAS, &[1, 2]);
        assert!(!profile::FEATURES.contains(&"plugin.brand_bug"));
        for feature in ["image", "video", "website", "youtube", "remote-web-v1", "synchronized-playback-v1"] {
            let token = ShortToken::new(feature).expect("feature");
            assert!(packaged.check(&RendererRequirement::Feature(token)).is_ok(), "{feature}");
        }
        let missing = ShortToken::new("plugin.brand_bug").expect("token");
        assert!(packaged.check(&RendererRequirement::Feature(missing)).is_err());
    }

    const INSTALLATION: &str = "39e0c9bd-0e84-4e4d-a1f9-4cdbc1e96035";

    /// A canned server that answers identity, the manifest fetch, and
    /// origin byte requests for exactly one manifest document.
    async fn canned_server(document: Value, stored: Value) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://127.0.0.1:{}", listener.local_addr().expect("addr").port());
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let document = document.clone();
                let stored = stored.clone();
                tokio::spawn(async move {
                    let mut request = vec![0u8; 8192];
                    let Ok(read) = stream.read(&mut request).await else { return };
                    let head = String::from_utf8_lossy(&request[..read]);
                    let line = head.lines().next().unwrap_or_default();
                    // The canned server is a fixed fixture: identity, one
                    // manifest document with a stable validator, and the one
                    // origin object that document references.
                    let (status, content_type, extra, body): (&str, &str, &str, Vec<u8>) =
                        if line.starts_with("GET /api/v1/system/identity") {
                            let body = json!({"data": {
                                "product": "Tilecast", "installationId": INSTALLATION,
                                "organizationName": "Test Org", "apiVersion": "v1",
                                "pairingEnabled": true,
                            }})
                            .to_string();
                            ("200 OK", "application/json", "", body.into_bytes())
                        } else if line.starts_with("GET /api/v1/player/manifest") {
                            let body = json!({"data": document}).to_string();
                            ("200 OK", "application/json", "etag: \"manifest-v8\"\r\n", body.into_bytes())
                        } else if line.starts_with("GET /api/v1/player/assets/") {
                            ("200 OK", "image/png", "", payload())
                        } else {
                            ("404 Not Found", "application/json", "", stored.to_string().into_bytes())
                        };
                    let head = format!(
                        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&body).await;
                });
            }
        });
        (base, handle)
    }

    async fn scratch_parts(dir: &std::path::Path) -> (player_core::PlayerCore, ContentStore) {
        std::fs::create_dir_all(dir).expect("scratch dir");
        let db = StateDb::open(dir.join("state.db"), OpenOptions::default()).expect("state");
        let clock = std::sync::Arc::new(crate::host::SystemClock);
        let core = player_core::PlayerCore::new(player_core::Dependencies { state: db.clone(), clock: clock.clone() });
        let store = ContentStore::open(
            dir.join("cas"),
            dir.join("partial"),
            db,
            clock,
            std::sync::Arc::new(crate::host::StatvfsProbe),
            std::sync::Arc::new(crate::host::AndroidSecureOpener),
            StorePolicy { limit_bytes: 8 * 1024 * 1024, reserved_free_bytes: 0 },
            std::sync::Arc::new(LruByDomain),
        )
        .await
        .expect("store open");
        (core, store)
    }

    /// A live engine, clock, and facts slot for host construction.
    /// The engine has no connection, so compatibility checks use the
    /// fresh-process fallback unless the test connects a renderer.
    fn engine_parts(
        store: &ContentStore,
    ) -> (std::sync::Arc<tokio::sync::Mutex<crate::renderer::PresentationEngine>>, SharedClock, SharedManifestFacts)
    {
        let clock: SharedClock = std::sync::Arc::new(crate::host::SystemClock);
        let platform = std::sync::Arc::new(crate::renderer::MemRendererPlatform::default());
        let snapshot = std::sync::Arc::new(Mutex::new(crate::renderer::RendererSnapshot::default()));
        let engine = crate::renderer::PresentationEngine::new(
            crate::renderer::AndroidRendererPort::new(platform, store.clone()),
            clock.clone(),
            snapshot,
            std::sync::Arc::new(tokio::sync::Notify::new()),
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            clock.now(),
        );
        let facts: SharedManifestFacts = std::sync::Arc::new(Mutex::new(ManifestFacts::default()));
        (std::sync::Arc::new(tokio::sync::Mutex::new(engine)), clock, facts)
    }

    async fn verified(base: &str) -> player_client::AuthenticatedServer {
        let client = player_client::ServerClient::new(base, "tilecast-android-test").expect("client");
        let credential = format!("tc_device_{}.{}", "a".repeat(26), "b".repeat(40));
        let credential = player_client::DeviceCredential::parse(&credential).expect("credential");
        let installation: player_types::InstallationId = INSTALLATION.parse().expect("installation");
        client.verify_installation(installation, credential).await.expect("verify")
    }

    fn binding(base: String) -> player_state::repo::manifests::Binding {
        player_state::repo::manifests::Binding {
            installation_id: INSTALLATION.parse().expect("installation"),
            screen_id: screen(),
            server_url: base,
        }
    }

    #[tokio::test]
    async fn reconcile_prepare_round_trip_serves_the_stored_object() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, store) = scratch_parts(dir.path()).await;
        // The 404 arm is unreachable in this fixture: the canned server
        // answers every route the reconciliation uses. It only satisfies
        // the fixture builder's shared signature shape.
        let unreachable = json!({"error": {"code": "not_found", "message": "unused"}});
        let (base, task) = canned_server(manifest(), unreachable).await;
        let server = verified(&base).await;
        let (engine, clock, facts) = engine_parts(&store);
        let host = AndroidManifestHost::new(core, store, server, engine, clock, facts);
        let binding = binding(base);

        // First sync discovers the pending target and prepares it.
        let pending = host.reconcile(&binding).await.expect("reconcile").expect("target");
        assert_eq!(pending.version, 8);
        assert!(!host.content_intact(&pending).await);
        let prepared = host.prepare(&pending).await.expect("prepare");
        assert_eq!(prepared, player_core::ManifestPrepared::Pending);

        // A second sync keeps the recorded validator and reports it current.
        let current = host.reconcile(&binding).await.expect("reconcile").expect("target");
        assert_eq!(current.version, 8);
        assert!(!current.etag.is_empty());
        let again = host.prepare(&current).await.expect("prepare");
        assert_eq!(again, player_core::ManifestPrepared::Current);

        // The verified bytes are servable from the store.
        let digest = player_types::Sha256Digest::of(&payload());
        let (mut file, record) = host.cas.open_verified(&digest).await.expect("open").expect("object");
        assert_eq!(record.size_bytes, payload().len() as u64);
        let mut served = Vec::new();
        use std::io::Read as _;
        file.read_to_end(&mut served).expect("read");
        assert_eq!(served, payload());
        task.abort();
    }

    #[tokio::test]
    async fn incompatible_manifest_never_reaches_the_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, store) = scratch_parts(dir.path()).await;
        let mut document = manifest();
        document["plugins"] = json!([{"id": "p1", "type": "brand_bug", "version": 1, "config": {}}]);
        let unreachable = json!({"error": {"code": "not_found", "message": "unused"}});
        let (base, task) = canned_server(document, unreachable).await;
        let server = verified(&base).await;
        let (engine, clock, facts) = engine_parts(&store);
        let host = AndroidManifestHost::new(core, store, server, engine, clock, facts);
        let binding = binding(base);

        // Fetch validates structure; preparation enforces the renderer profile.
        let target = host.reconcile(&binding).await.expect("reconcile").expect("target");
        let err = host.prepare_target(&target).await.expect_err("incompatible");
        assert_eq!(err.reason_code(), "presentation_incompatible_plugin");
        let failure = worker_failure(&err);
        assert_eq!(failure.kind, player_core::ManifestFailureKind::Incompatible);

        // No object was committed for the rejected document.
        let digest = player_types::Sha256Digest::of(&payload());
        assert!(host.cas.open_verified(&digest).await.expect("open").is_none());
        task.abort();
    }

    #[test]
    fn unproven_renderer_rejects_widget_components_but_allows_schema_1() {
        // Schema-1 image content prepares before any renderer proves itself.
        assert!(check_as(manifest(), &fresh_connected()).is_empty());
        // A Widget component the packaged release supports still waits
        // for the live renderer to advertise it.
        let mut document = manifest();
        document["widgets"] = json!([{
            "assetId": "0c3e1d2f-7a55-4b1e-9c33-6f0d2e8a4b91",
            "presentation": {"kind": "component",
                "requiredCapabilities": {"widget.tilecast.clock": 2}},
        }]);
        let found = check_as(document.clone(), &fresh_connected());
        assert_eq!(found, vec![Incompatibility::WidgetCapability("widget.tilecast.clock".to_owned())]);
        assert!(check_as(document, &full_connected()).is_empty());
    }

    #[test]
    fn unsupported_runtime_rejects_everything() {
        let empty = ConnectedRendererProfile(RendererSupport::default());
        assert_eq!(check_as(manifest(), &empty), vec![Incompatibility::Requirement("renderer support".to_owned())]);
    }

    #[tokio::test]
    async fn successful_prepare_publishes_manifest_facts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, store) = scratch_parts(dir.path()).await;
        let mut document = manifest();
        let fallback_id = "f001ba11-0000-4000-8000-000000000001";
        document["directFallbackPlaylist"] = json!({"id": fallback_id, "items": [{
            "id": ITEM, "assetId": ASSET, "variantId": VARIANT,
            "assetType": "image", "deliveryPolicy": "automatic", "durationMs": 10000,
            "fitMode": "cover", "transition": "fade", "audioEnabled": true, "volume": 0.8
        }]});
        let unreachable = json!({"error": {"code": "not_found", "message": "unused"}});
        let (base, task) = canned_server(document, unreachable).await;
        let server = verified(&base).await;
        let (engine, clock, facts) = engine_parts(&store);
        let seen = facts.clone();
        let host = AndroidManifestHost::new(core, store, server, engine, clock, facts);
        let target = host.reconcile(&binding(base)).await.expect("reconcile").expect("target");
        host.prepare_target(&target).await.expect("prepare");
        let facts = seen.lock().expect("facts");
        assert_eq!(facts.assigned_playlist_id.as_deref(), Some(fallback_id));
        assert!(facts.cached_fallback_available);
        assert!(facts.last_successful_sync.is_some());
        task.abort();
    }

    #[tokio::test]
    async fn failed_prepare_keeps_the_previous_facts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (core, store) = scratch_parts(dir.path()).await;
        let mut document = manifest();
        document["plugins"] = json!([{"id": "p1", "type": "brand_bug", "version": 1, "config": {}}]);
        let unreachable = json!({"error": {"code": "not_found", "message": "unused"}});
        let (base, task) = canned_server(document, unreachable).await;
        let server = verified(&base).await;
        let (engine, clock, facts) = engine_parts(&store);
        let seen = facts.clone();
        let host = AndroidManifestHost::new(core, store, server, engine, clock, facts);
        let target = host.reconcile(&binding(base)).await.expect("reconcile").expect("target");
        host.prepare_target(&target).await.expect_err("incompatible");
        let facts = seen.lock().expect("facts");
        assert_eq!(facts.assigned_playlist_id, None);
        assert!(!facts.cached_fallback_available);
        assert_eq!(facts.last_successful_sync, None);
        task.abort();
    }
}
