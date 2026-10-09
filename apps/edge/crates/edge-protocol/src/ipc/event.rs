//! Events: one-way messages in either direction.
//!
//! Each event has a fixed name, direction and permitted roles. Payloads are
//! strict structs; [`Event::decode`] rejects unknown names, unknown fields and
//! malformed types.

use serde::de::Error as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::presentation::PresentationDocument;
use super::{Direction, Role};
use crate::bounded::{SafeText, ShortText, ShortToken, bounded_vec};
use crate::ids::{ActivationId, canonical_uuid};

/// Identifies which activation a renderer report refers to. Reports for an
/// activation that is no longer current are ignored by the daemon, which is
/// what keeps a late report from a replaced presentation from counting as
/// progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationRef {
    pub activation_id: ActivationId,
    pub generation: u64,
}

// ------------------------------------------------------------ daemon → client

/// How the renderer reaches the daemon-owned media capability service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaChannelDescriptor {
    /// Always `daemon-cap-v1`.
    pub protocol: ShortToken,
    /// Absolute path to the daemon's bounded renderer media socket.
    pub socket: SafeText<512>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KioskPolicy {
    pub prevent_display_sleep: bool,
    pub hide_cursor: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererConfigure {
    pub media_channel: MediaChannelDescriptor,
    pub kiosk: KioskPolicy,
}

/// A renderer-visible media grant. The digest remains daemon-side; `uri` is
/// an opaque capability valid only for the current renderer generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererMediaRef {
    #[serde(deserialize_with = "media_capability_uri")]
    pub uri: SafeText<128>,
    pub size_bytes: u64,
    pub mime_type: SafeText<127>,
}

fn media_capability_uri<'de, D: serde::Deserializer<'de>>(d: D) -> Result<SafeText<128>, D::Error> {
    let uri = SafeText::<128>::deserialize(d)?;
    let Some(capability) = uri.as_str().strip_prefix("tcmedia://cap/") else {
        return Err(D::Error::custom("invalid renderer media capability URI"));
    };
    if capability.len() != 64 || !capability.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(D::Error::custom("invalid renderer media capability URI"));
    }
    Ok(uri)
}

/// Shared synchronized-playback anchor. The renderer anchors once at
/// activation and advances with its own monotonic clock afterwards, so a
/// later wall-clock correction never jumps active playback (docs/tilecast-edge.md §13).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncTiming {
    pub group_id: SafeText<64>,
    /// Anchor in corrected Unix milliseconds.
    pub anchor_unix_ms: i64,
    #[serde(deserialize_with = "durations")]
    pub durations_ms: Vec<u64>,
    /// Daemon's current corrected-minus-local wall offset at activation.
    pub clock_offset_ms: i64,
}

fn durations<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u64>, D::Error> {
    bounded_vec(d, super::presentation::MAX_ITEMS)
}

fn renderer_media_refs<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<RendererMediaRef>, D::Error> {
    bounded_vec(d, super::presentation::MAX_CONTENT_REFS)
}

/// A renderer-visible frame grant: the `projection.widgetFrames`
/// authorization entry plus the byte size the renderer's serve allowlist
/// enforces. The digests remain daemon-verified; `uri` is an opaque
/// capability valid only for the current renderer generation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererFrameRef {
    #[serde(deserialize_with = "frame_capability_uri")]
    pub uri: SafeText<128>,
    pub package_id: SafeText<128>,
    pub package_digest: crate::Sha256Digest,
    pub frame_digest: crate::Sha256Digest,
    pub size_bytes: u64,
}

fn frame_capability_uri<'de, D: serde::Deserializer<'de>>(d: D) -> Result<SafeText<128>, D::Error> {
    let uri = SafeText::<128>::deserialize(d)?;
    let Some(capability) = uri.as_str().strip_prefix("tcwidget://cap/") else {
        return Err(D::Error::custom("invalid renderer frame capability URI"));
    };
    if capability.len() != 64 || !capability.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(D::Error::custom("invalid renderer frame capability URI"));
    }
    Ok(uri)
}

fn renderer_frame_refs<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<RendererFrameRef>, D::Error> {
    bounded_vec(d, super::presentation::MAX_CONTENT_REFS)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationActivate {
    pub activation_id: ActivationId,
    /// Increases with every activation the daemon issues (process-local).
    pub generation: u64,
    pub presentation: PresentationDocument,
    #[serde(deserialize_with = "renderer_media_refs")]
    pub content: Vec<RendererMediaRef>,
    /// The activation's authorized frame allowlist, present only on
    /// sessions that negotiated [`super::RENDERER_FEATURE_WIDGET_FRAMES`].
    #[serde(default, skip_serializing_if = "Vec::is_empty", deserialize_with = "renderer_frame_refs")]
    pub frames: Vec<RendererFrameRef>,
    #[serde(default)]
    pub timing: Option<SyncTiming>,
    /// Inputs for the trusted runtime's render-tree projection of `widget`
    /// and `layout` items (the reference runtime's `renderWidget` and
    /// `renderLayout`), present when the presentation has such items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projection: Option<ProjectionContext>,
}

/// Largest projection manifest subset sent to a renderer.
pub const MAX_PROJECTION_BYTES: usize = 3 * 1024 * 1024;
pub const MAX_MEDIA_ALIASES: usize = super::presentation::MAX_CONTENT_REFS;

/// What the trusted runtime needs to project server-compiled widgets and
/// layouts into render trees at the corrected clock: the relevant subset of
/// the verified Player manifest and a map from the manifest's asset/variant
/// identity to media URIs. Every media URI must be listed in the activation's
/// `content`; the renderer never resolves a variant itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectionContext {
    pub schema: u32,
    /// Corrected-minus-local wall offset at activation.
    pub clock_offset_ms: i64,
    pub manifest: Value,
    #[serde(deserialize_with = "media_aliases")]
    pub media: Vec<MediaAlias>,
    /// The accepted player configuration's `playback` section (regional
    /// formatting and layout playlist-zone defaults), exactly as the
    /// reference player hands it to `renderLayout` and `renderWidget`.
    /// Absent means the runtime's defaults.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "playback_context")]
    pub playback: Option<Value>,
    /// Authorization table: every sandbox frame the references may
    /// execute. Present only on sessions that negotiated
    /// [`super::RENDERER_FEATURE_WIDGET_FRAMES`]; the projector joins
    /// each manifest frame claim to its authorized URI and rejects the
    /// activation on any mismatch. Absent when the activation carries
    /// no external Widgets.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "optional_widget_frames")]
    pub widget_frames: Option<Vec<RendererFrameRef>>,
    /// Media aliases for opaque sandbox frames, mirroring [`Self::media`].
    /// Some engines refuse subresource loads from opaque origins to
    /// capability schemes, so hosts that serve frames over loopback HTTP
    /// authorize the same variants a second time in a form frames can
    /// load. The projector prefers this table for Widget component
    /// media and falls back to [`Self::media`]; hosts whose frames load
    /// capability URIs directly omit it.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "optional_media_aliases")]
    pub widget_media: Option<Vec<MediaAlias>>,
}

fn optional_media_aliases<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<MediaAlias>>, D::Error> {
    let aliases = Option::<Vec<MediaAlias>>::deserialize(d)?;
    if let Some(aliases) = &aliases
        && aliases.len() > MAX_MEDIA_ALIASES
    {
        return Err(D::Error::custom(format!("list has more than {MAX_MEDIA_ALIASES} entries")));
    }
    Ok(aliases)
}

fn optional_widget_frames<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Vec<RendererFrameRef>>, D::Error> {
    let frames = Option::<Vec<RendererFrameRef>>::deserialize(d)?;
    if let Some(frames) = &frames
        && frames.len() > super::presentation::MAX_CONTENT_REFS
    {
        return Err(D::Error::custom("list has more than 1024 entries"));
    }
    Ok(frames)
}

/// Largest playback section carried in a projection context.
pub const MAX_PLAYBACK_CONTEXT_BYTES: usize = 16 * 1024;

fn playback_context<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    let value = Option::<Value>::deserialize(d)?;
    if let Some(value) = &value {
        if !value.is_object() {
            return Err(D::Error::custom("playback context must be an object"));
        }
        if serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > MAX_PLAYBACK_CONTEXT_BYTES) {
            return Err(D::Error::custom("playback context exceeds its bound"));
        }
    }
    Ok(value)
}

/// One manifest asset variant and the media URI that serves it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaAlias {
    #[serde(with = "canonical_uuid")]
    pub asset_id: uuid::Uuid,
    #[serde(with = "canonical_uuid")]
    pub variant_id: uuid::Uuid,
    pub uri: SafeText<128>,
}

fn media_aliases<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<MediaAlias>, D::Error> {
    bounded_vec(d, MAX_MEDIA_ALIASES)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationClear {
    pub reason: ShortToken,
}

/// Built-in plugin surfaces, independent of playlist activation. The array's
/// schema is the web runtime's `RendererPlugin`; the daemon validates media
/// references and size only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginState {
    pub plugins: Vec<Value>,
    #[serde(deserialize_with = "renderer_media_refs")]
    pub content: Vec<RendererMediaRef>,
    pub clock_offset_ms: i64,
    /// Media the reference runtime addresses by asset/variant identity
    /// (the Brand Bug logo). The host resolves `tcmedia://variant/<asset>/
    /// <variant>` only through this list, and only to a URI in `content`.
    #[serde(default, deserialize_with = "media_aliases", skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<MediaAlias>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncPosition {
    pub activation: ActivationRef,
    pub item_id: SafeText<160>,
    pub occurrence: u64,
    pub offset_ms: u64,
    #[serde(default)]
    pub video_start_offset_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identify {
    pub name: SafeText<120>,
    pub duration_seconds: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererCommandKind {
    RetryItem,
    SkipItem,
    /// Reload the trusted runtime and re-apply the current activation.
    Reload,
    /// Clear the isolated remote web helper's website data (never the
    /// trusted runtime's). The renderer answers `renderer.command_result`.
    ClearWebsiteData,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererCommand {
    #[serde(with = "canonical_uuid")]
    pub command_id: uuid::Uuid,
    pub command: RendererCommandKind,
}

/// The outcome of a renderer command that reports one (today only
/// `clear_website_data`). `code` is a stable token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererCommandResult {
    #[serde(with = "canonical_uuid")]
    pub command_id: uuid::Uuid,
    pub success: bool,
    pub code: ShortToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    #[serde(with = "canonical_uuid")]
    pub request_id: uuid::Uuid,
    pub max_width: u32,
    pub max_height: u32,
    pub max_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererShutdown {
    pub reason: ShortToken,
    pub deadline_ms: u32,
}

// ------------------------------------------------------------ client → daemon

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererKind {
    Wpe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RendererPlatform {
    Drm,
    Wayland,
    Headless,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererInfo {
    pub kind: RendererKind,
    pub version: ShortText,
    pub engine_version: ShortText,
    /// The GStreamer library the renderer runs with (release diagnostics).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gstreamer_version: Option<ShortText>,
    pub platform: RendererPlatform,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DisplayInfo {
    pub connected: bool,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub refresh_millihertz: Option<u32>,
}

fn features<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<ShortToken>, D::Error> {
    bounded_vec(d, 64)
}

/// The renderer's runtime is loaded and able to accept activations.
/// **Not** evidence of playback: health is judged from `renderer.progress`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererReady {
    pub renderer: RendererInfo,
    /// Presentation features this renderer can show, e.g. `image`, `video`,
    /// `render-tree-v1`, `layout-v1`.
    #[serde(deserialize_with = "features")]
    pub features: Vec<ShortToken>,
    #[serde(default)]
    pub display: Option<DisplayInfo>,
    /// The isolated remote web helper as the renderer sees it. Absent from a
    /// renderer without remote web support.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_web: Option<RemoteWebStatus>,
    /// Support reported by the running Runtime, never inferred from release metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub support: Option<Box<RuntimeSupport>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeSupport {
    #[serde(deserialize_with = "support_schemas")]
    pub presentation_schemas: Vec<u32>,
    #[serde(deserialize_with = "support_versions")]
    pub declarative_capabilities: std::collections::BTreeMap<ShortToken, u32>,
    #[serde(deserialize_with = "support_versions")]
    pub widget_components: std::collections::BTreeMap<ShortToken, u32>,
}

fn support_schemas<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<u32>, D::Error> {
    let schemas: Vec<u32> = bounded_vec(d, 256)?;
    let unique: std::collections::BTreeSet<_> = schemas.iter().collect();
    if schemas.contains(&0) || unique.len() != schemas.len() {
        return Err(D::Error::custom("invalid Runtime support schemas"));
    }
    Ok(schemas)
}

fn support_versions<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<std::collections::BTreeMap<ShortToken, u32>, D::Error> {
    struct Versions;
    impl<'de> serde::de::Visitor<'de> for Versions {
        type Value = std::collections::BTreeMap<ShortToken, u32>;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("at most 256 distinct capability tokens with positive versions")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
            let mut out = Self::Value::new();
            while let Some((name, version)) = map.next_entry::<ShortToken, u32>()? {
                if out.len() == 256 || version == 0 || out.insert(name, version).is_some() {
                    return Err(M::Error::custom("invalid Runtime support versions"));
                }
            }
            Ok(out)
        }
    }
    d.deserialize_map(Versions)
}

/// Whether remote web works, and why not (docs/tilecast-edge-remote-web-
/// threat-review.md §16). `available` stays true after a helper crash; the
/// crash is a degraded health reason, not a missing feature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteWebStatus {
    pub available: bool,
    /// The helper exports GPU (DMA-BUF) frames rather than software frames.
    pub accelerated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ShortToken>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationAccepted {
    pub activation: ActivationRef,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationRejected {
    pub activation: ActivationRef,
    pub code: ShortToken,
    pub message: SafeText<240>,
}

/// Evidence of what is actually on screen. The vocabulary is the one the
/// reference web runtime already reports; the daemon maps it to meaningful
/// progress exactly as `apps/player-linux/src/core/render-progress.ts` does
/// (for example `renderer_alive` counts only for indefinite content).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    ItemStarted,
    ItemTransition,
    VideoProgress,
    ImageShown,
    WidgetShown,
    WidgetEmpty,
    WidgetAlive,
    LayoutShown,
    LayoutAlive,
    LayoutZoneRendered,
    WebsiteLoaded,
    WebsiteAlive,
    FrameChanged,
    /// The status surface (idle, setup, pairing…) has been painted.
    SurfaceShown,
}

impl EvidenceKind {
    /// The wire name (snake_case).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ItemStarted => "item_started",
            Self::ItemTransition => "item_transition",
            Self::VideoProgress => "video_progress",
            Self::ImageShown => "image_shown",
            Self::WidgetShown => "widget_shown",
            Self::WidgetEmpty => "widget_empty",
            Self::WidgetAlive => "widget_alive",
            Self::LayoutShown => "layout_shown",
            Self::LayoutAlive => "layout_alive",
            Self::LayoutZoneRendered => "layout_zone_rendered",
            Self::WebsiteLoaded => "website_loaded",
            Self::WebsiteAlive => "website_alive",
            Self::FrameChanged => "frame_changed",
            Self::SurfaceShown => "surface_shown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererProgress {
    pub activation: ActivationRef,
    #[serde(default)]
    pub item_id: Option<SafeText<160>>,
    pub kind: EvidenceKind,
    #[serde(default)]
    pub zone_id: Option<SafeText<160>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemError {
    pub activation: ActivationRef,
    #[serde(default)]
    pub item_id: Option<SafeText<160>>,
    pub code: ShortToken,
    pub message: SafeText<240>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HealthState {
    Healthy,
    Degraded,
    Failing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererHealth {
    pub state: HealthState,
    #[serde(default)]
    pub reason_code: Option<ShortToken>,
    /// Web-process terminations since the renderer process started.
    pub web_process_terminations: u32,
    #[serde(default)]
    pub resident_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case", deny_unknown_fields)]
pub enum PreviewOutcome {
    Captured {
        #[serde(rename = "jpegBase64")]
        jpeg_base64: String,
        width: u32,
        height: u32,
    },
    Unavailable {
        code: ShortToken,
    },
}

/// Largest base64 preview payload (a 2 MiB JPEG).
pub const MAX_PREVIEW_BASE64_CHARS: usize = 2 * 1024 * 1024 * 4 / 3 + 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewResult {
    #[serde(with = "canonical_uuid")]
    pub request_id: uuid::Uuid,
    pub result: PreviewOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShutdownAck {}

// ------------------------------------------------- Session bridge audio

/// A finite level in `[0, max]`; anything else is a malformed frame.
fn level_in<'de, D: serde::Deserializer<'de>>(d: D, max: f64) -> Result<Option<f64>, D::Error> {
    let value = Option::<f64>::deserialize(d)?;
    if value.is_some_and(|v| !v.is_finite() || !(0.0..=max).contains(&v)) {
        return Err(D::Error::custom("level is out of range"));
    }
    Ok(value)
}

/// A root-mean-square amplitude: `null` or a finite value in `[0, 1]`.
fn unit_rms<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    level_in(d, 1.0)
}

/// Largest number of sources or sinks a bridge may report.
pub const MAX_AUDIO_DEVICES: u16 = 64;

fn device_count<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u16, D::Error> {
    let value = u16::deserialize(d)?;
    if value > MAX_AUDIO_DEVICES {
        return Err(D::Error::custom("device count exceeds its bound"));
    }
    Ok(value)
}

/// Daemon → session bridge: hold the microphone open, or release it. The
/// bridge opens capture only while the last one said `enabled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureSet {
    pub enabled: bool,
}

/// What the bridge's capture is doing. Closed set; each non-capturing state
/// is a typed reason the daemon reports as a capability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    /// Not asked to capture.
    Idle,
    /// Asked to capture; the pipeline is starting.
    Starting,
    Capturing,
    /// PipeWire runs, but it offers no audio source.
    NoMicrophone,
    /// The PipeWire GStreamer element is missing or the session's PipeWire
    /// cannot be reached.
    PipewireUnavailable,
    /// PipeWire refused access to the source.
    PermissionDenied,
    /// The pipeline failed for another reason.
    CaptureFailed,
    /// The pipeline failed and the bridge is retrying.
    Recovering,
}

impl CaptureState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Capturing => "capturing",
            Self::NoMicrophone => "no_microphone",
            Self::PipewireUnavailable => "pipewire_unavailable",
            Self::PermissionDenied => "permission_denied",
            Self::CaptureFailed => "capture_failed",
            Self::Recovering => "recovering",
        }
    }
}

/// Session bridge → daemon: one derived level measurement, never audio. A
/// level is present only while the state is `capturing`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioLevel {
    #[serde(deserialize_with = "unit_rms")]
    pub rms: Option<f64>,
    pub state: CaptureState,
}

impl AudioLevel {
    /// A level without capture, or capture without a level, is a buggy peer.
    pub fn is_consistent(&self) -> bool {
        self.rms.is_some() == (self.state == CaptureState::Capturing)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PipewireState {
    Available,
    Unavailable,
}

/// Session bridge → daemon: which audio endpoints the session offers, from
/// WirePlumber's object graph and default nodes. Counts and flags only; no
/// device names and no PipeWire object IDs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioInventory {
    pub pipewire: PipewireState,
    /// `Audio/Source` nodes.
    #[serde(deserialize_with = "device_count")]
    pub sources: u16,
    /// `Audio/Sink` nodes.
    #[serde(deserialize_with = "device_count")]
    pub sinks: u16,
    /// WirePlumber names a default source that exists.
    pub default_source: bool,
    /// WirePlumber names a default sink that exists.
    pub default_sink: bool,
}

// ------------------------------------------------------------------- enum

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    RendererConfigure(RendererConfigure),
    PresentationActivate(Box<PresentationActivate>),
    PresentationClear(PresentationClear),
    PluginState(PluginState),
    SyncPosition(SyncPosition),
    Identify(Identify),
    RendererCommand(RendererCommand),
    PreviewRequest(PreviewRequest),
    RendererShutdown(RendererShutdown),
    CaptureSet(CaptureSet),

    RendererReady(RendererReady),
    PresentationAccepted(PresentationAccepted),
    PresentationRejected(PresentationRejected),
    RendererProgress(RendererProgress),
    ItemError(ItemError),
    RendererHealth(RendererHealth),
    PreviewResult(PreviewResult),
    RendererCommandResult(RendererCommandResult),
    ShutdownAck(ShutdownAck),
    AudioLevel(AudioLevel),
    AudioInventory(AudioInventory),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EventError {
    #[error("unknown event {0}")]
    Unknown(String),
    #[error("invalid {name} payload: {detail}")]
    InvalidPayload { name: &'static str, detail: String },
}

macro_rules! events {
    ($( $variant:ident => $name:literal, $dir:ident, [$($role:ident),*] $(, boxed $boxed:tt)? ;)*) => {
        impl Event {
            pub fn name(&self) -> &'static str {
                match self { $( Event::$variant(_) => $name, )* }
            }

            pub fn direction(&self) -> Direction {
                match self { $( Event::$variant(_) => Direction::$dir, )* }
            }

            pub fn allowed_roles(&self) -> &'static [Role] {
                match self { $( Event::$variant(_) => &[$(Role::$role),*], )* }
            }

            pub fn decode(name: &str, data: Value) -> Result<Event, EventError> {
                match name {
                    $( $name => events!(@decode $variant, $name, data $(, $boxed)?), )*
                    other => Err(EventError::Unknown(other.chars().take(64).collect())),
                }
            }

            pub fn data(&self) -> Value {
                let value = match self { $( Event::$variant(inner) => serde_json::to_value(inner), )* };
                value.unwrap_or(Value::Null)
            }
        }
    };
    (@decode $variant:ident, $name:literal, $data:ident, $boxed:tt) => {
        serde_json::from_value($data)
            .map(|inner| Event::$variant(Box::new(inner)))
            .map_err(|e| EventError::InvalidPayload { name: $name, detail: e.to_string() })
    };
    (@decode $variant:ident, $name:literal, $data:ident) => {
        serde_json::from_value($data)
            .map(Event::$variant)
            .map_err(|e| EventError::InvalidPayload { name: $name, detail: e.to_string() })
    };
}

events! {
    RendererConfigure => "renderer.configure", DaemonToClient, [Renderer];
    PresentationActivate => "presentation.activate", DaemonToClient, [Renderer], boxed yes;
    PresentationClear => "presentation.clear", DaemonToClient, [Renderer];
    PluginState => "plugin.state", DaemonToClient, [Renderer];
    SyncPosition => "sync.position", DaemonToClient, [Renderer];
    Identify => "presentation.identify", DaemonToClient, [Renderer];
    RendererCommand => "renderer.command", DaemonToClient, [Renderer];
    PreviewRequest => "preview.request", DaemonToClient, [Renderer];
    RendererShutdown => "renderer.shutdown", DaemonToClient, [Renderer];
    CaptureSet => "capture.set", DaemonToClient, [SessionBridge];

    RendererReady => "renderer.ready", ClientToDaemon, [Renderer];
    PresentationAccepted => "presentation.accepted", ClientToDaemon, [Renderer];
    PresentationRejected => "presentation.rejected", ClientToDaemon, [Renderer];
    RendererProgress => "renderer.progress", ClientToDaemon, [Renderer];
    ItemError => "renderer.item_error", ClientToDaemon, [Renderer];
    RendererHealth => "renderer.health", ClientToDaemon, [Renderer];
    PreviewResult => "renderer.preview", ClientToDaemon, [Renderer];
    RendererCommandResult => "renderer.command_result", ClientToDaemon, [Renderer];
    ShutdownAck => "renderer.shutdown_ack", ClientToDaemon, [Renderer];
    AudioLevel => "audio.level", ClientToDaemon, [SessionBridge];
    AudioInventory => "audio.inventory", ClientToDaemon, [SessionBridge];
}

impl PreviewResult {
    /// Size check that cannot be expressed as a serde bound on a String.
    pub fn within_limits(&self) -> bool {
        match &self.result {
            PreviewOutcome::Captured { jpeg_base64, width, height } => {
                jpeg_base64.len() <= MAX_PREVIEW_BASE64_CHARS && *width <= 3840 && *height <= 2160
            }
            PreviewOutcome::Unavailable { .. } => true,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn runtime_support_is_optional_bounded_and_keeps_namespaces_separate() {
        use super::RendererReady;
        use serde_json::json;
        let legacy =
            include_str!("../../../../../../packages/edge-protocol/fixtures/ipc/valid/event-renderer-ready.json");
        let frame: serde_json::Value = serde_json::from_str(legacy).unwrap();
        let mut ready = frame["frame"]["data"].clone();
        assert!(serde_json::from_value::<RendererReady>(ready.clone()).unwrap().support.is_none());
        let support = json!({"presentationSchemas": [1, 2],
            "declarativeCapabilities": {"content.text": 2}, "widgetComponents": {"widget.tilecast.clock": 1}});
        ready["support"] = support.clone();
        let parsed: RendererReady = serde_json::from_value(ready.clone()).unwrap();
        assert_eq!(parsed.support.unwrap().widget_components.values().copied().collect::<Vec<_>>(), vec![1]);
        for invalid in [
            json!({"presentationSchemas": [1,1], "declarativeCapabilities": {}, "widgetComponents": {}}),
            json!({"presentationSchemas": [0], "declarativeCapabilities": {}, "widgetComponents": {}}),
            json!({"presentationSchemas": [1], "declarativeCapabilities": {"content.text": 0}, "widgetComponents": {}}),
            json!({"presentationSchemas": [1], "declarativeCapabilities": {}, "widgetComponents": {"bad/name": 1}}),
            json!({"presentationSchemas": [1], "declarativeCapabilities": {}, "widgetComponents": {"widget.a": 4294967296_u64}}),
            json!({"presentationSchemas": (1..=257).collect::<Vec<_>>(), "declarativeCapabilities": {}, "widgetComponents": {}}),
        ] {
            ready["support"] = invalid;
            assert!(serde_json::from_value::<RendererReady>(ready.clone()).is_err());
        }
        let mut excessive = support.clone();
        excessive["widgetComponents"] =
            serde_json::Value::Object((0..257).map(|i| (format!("widget.a{i}"), json!(1))).collect());
        ready["support"] = excessive;
        assert!(serde_json::from_value::<RendererReady>(ready).is_err());
        assert!(serde_json::from_str::<super::RuntimeSupport>(
            r#"{"presentationSchemas":[1],"declarativeCapabilities":{"content.text":1,"content.text":2},"widgetComponents":{}}"#
        ).is_err());
    }
    use super::*;
    use serde_json::json;

    const ACTIVATION: &str = "3f2b8c1d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

    #[test]
    fn decode_known_events() {
        let progress = Event::decode(
            "renderer.progress",
            json!({"activation": {"activationId": ACTIVATION, "generation": 2},
                   "itemId": "item-1", "kind": "video_progress"}),
        )
        .expect("valid");
        assert_eq!(progress.name(), "renderer.progress");
        assert_eq!(progress.direction(), Direction::ClientToDaemon);
        assert_eq!(progress.allowed_roles(), &[Role::Renderer]);
        let round = Event::decode(progress.name(), progress.data()).expect("round trip");
        assert_eq!(round, progress);
    }

    #[test]
    fn rejects_unknown_names_fields_and_types() {
        assert!(matches!(Event::decode("renderer.exec", json!({})), Err(EventError::Unknown(_))));
        assert!(
            Event::decode(
                "renderer.progress",
                json!({
                    "activation": {"activationId": ACTIVATION, "generation": 2},
                    "kind": "video_progress", "path": "/etc/shadow"
                })
            )
            .is_err()
        );
        assert!(
            Event::decode(
                "renderer.progress",
                json!({
                    "activation": {"activationId": ACTIVATION, "generation": "2"},
                    "kind": "video_progress"
                })
            )
            .is_err()
        );
        assert!(
            Event::decode(
                "renderer.progress",
                json!({
                    "activation": {"activationId": ACTIVATION, "generation": 2},
                    "kind": "teleport"
                })
            )
            .is_err()
        );
    }

    #[test]
    fn bridge_events_carry_bounded_numbers_and_nothing_else() {
        let level = Event::decode("audio.level", json!({"rms": 0.25, "state": "capturing"})).expect("valid");
        assert_eq!(level.allowed_roles(), &[Role::SessionBridge]);
        assert_eq!(level.direction(), Direction::ClientToDaemon);
        assert!(matches!(&level, Event::AudioLevel(l) if l.is_consistent()));
        let silent = Event::decode("audio.level", json!({"rms": null, "state": "no_microphone"})).expect("valid");
        assert!(matches!(&silent, Event::AudioLevel(l) if l.is_consistent()));
        assert!(matches!(
            Event::decode("audio.level", json!({"rms": 0.1, "state": "idle"})),
            Ok(Event::AudioLevel(l)) if !l.is_consistent()
        ));
        for bad in [
            json!({"rms": 1.5, "state": "capturing"}),
            json!({"rms": -0.1, "state": "capturing"}),
            json!({"state": "capturing"}),
            json!({"rms": 0.1, "state": "capturing", "samples": [0.1, 0.2]}),
            json!({"rms": 0.1, "state": "listening"}),
            json!({"rms": "0.1", "state": "capturing"}),
        ] {
            assert!(Event::decode("audio.level", bad.clone()).is_err(), "{bad}");
        }
        let inventory = |extra: Value| {
            let mut value = json!({"pipewire": "available", "sources": 1, "sinks": 2,
                "defaultSource": true, "defaultSink": true});
            if let (Some(target), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
                target.extend(extra.clone());
            }
            Event::decode("audio.inventory", value)
        };
        assert!(inventory(json!({})).is_ok());
        assert!(inventory(json!({"sources": 65})).is_err());
        assert!(inventory(json!({"names": ["USB mic"]})).is_err(), "no device names");
        assert!(inventory(json!({"defaultSourceId": 42})).is_err(), "no PipeWire object IDs");
        let capture = Event::decode("capture.set", json!({"enabled": true})).expect("valid");
        assert_eq!(capture.direction(), Direction::DaemonToClient);
        assert_eq!(capture.allowed_roles(), &[Role::SessionBridge]);

        assert!(matches!(Event::decode("noise.report", json!({"status": "inactive"})), Err(EventError::Unknown(_))));
        assert!(matches!(Event::decode("noise.level", json!({"rms": 0.5})), Err(EventError::Unknown(_))));
    }

    #[test]
    fn widget_media_mirrors_the_alias_bound_and_omits_when_empty() {
        let alias = json!({
            "assetId": "844f4a48-a47c-4fbd-8a84-f8d61cc64b6a",
            "variantId": "46784d73-3daf-45cf-8ff0-7cb4a3d12852",
            "uri": format!("http://127.0.0.1:8471/media/{}", "d".repeat(64)),
        });
        let mut projection = json!({"schema": 19, "clockOffsetMs": 0, "manifest": {}, "media": []});
        let parsed: ProjectionContext = serde_json::from_value(projection.clone()).expect("parses");
        assert!(parsed.widget_media.is_none());
        assert!(!serde_json::to_value(&parsed).expect("json").as_object().expect("obj").contains_key("widgetMedia"));
        projection["widgetMedia"] = json!([alias]);
        let parsed: ProjectionContext = serde_json::from_value(projection.clone()).expect("parses");
        assert_eq!(parsed.widget_media.expect("table").len(), 1);
        projection["widgetMedia"] = json!([alias.clone(), alias]);
        let parsed: ProjectionContext = serde_json::from_value(projection).expect("parses");
        assert_eq!(parsed.widget_media.expect("table").len(), 2);
    }

    #[test]
    fn frame_refs_pin_the_widget_scheme_and_bound_the_list() {
        let entry = json!({
            "uri": format!("tcwidget://cap/{}", "d".repeat(64)),
            "packageId": "acme.athletics",
            "packageDigest": "e".repeat(64),
            "frameDigest": "f".repeat(64),
            "sizeBytes": 512,
        });
        let parsed: RendererFrameRef = serde_json::from_value(entry.clone()).expect("valid");
        assert_eq!(parsed.size_bytes, 512);
        for bad_uri in [
            format!("tcmedia://cap/{}", "d".repeat(64)),
            "tcwidget://cap/short".to_string(),
            format!("tcwidget://cap/{}", "D".repeat(64)),
            format!("tcwidget://cap/{}/extra", "d".repeat(64)),
            format!("tcwidget://cap/{}#frag", "d".repeat(64)),
        ] {
            let mut bad = entry.clone();
            bad["uri"] = json!(bad_uri);
            assert!(serde_json::from_value::<RendererFrameRef>(bad).is_err());
        }
        // The projection table omits when empty, parses when present, and
        // refuses an entry that is not a frame capability.
        let mut projection = json!({"schema": 19, "clockOffsetMs": 0, "manifest": {}, "media": []});
        let parsed: ProjectionContext = serde_json::from_value(projection.clone()).expect("parses");
        assert!(parsed.widget_frames.is_none());
        assert!(!serde_json::to_value(&parsed).expect("json").as_object().expect("obj").contains_key("widgetFrames"));
        projection["widgetFrames"] = json!([entry]);
        let parsed: ProjectionContext = serde_json::from_value(projection.clone()).expect("parses");
        assert_eq!(parsed.widget_frames.expect("frames").len(), 1);
        projection["widgetFrames"] = json!([{"uri": "tcmedia://cap/".to_string() + &"d".repeat(64),
            "packageId": "acme.athletics", "packageDigest": "e".repeat(64),
            "frameDigest": "f".repeat(64), "sizeBytes": 512}]);
        assert!(serde_json::from_value::<ProjectionContext>(projection).is_err());
    }

    #[test]
    fn frame_table_uris_match_the_shared_contract() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../../packages/player-contracts/fixtures/widget-frames.json"
        ))
        .expect("fixture parses");
        for case in fixture["tableUris"].as_array().expect("corpus") {
            let uri = case["uri"].as_str().expect("uri");
            let entry = serde_json::json!({
                "uri": uri,
                "packageId": "acme.athletics",
                "packageDigest": "e".repeat(64),
                "frameDigest": "f".repeat(64),
                "sizeBytes": 512,
            });
            assert_eq!(
                serde_json::from_value::<RendererFrameRef>(entry).is_ok(),
                case["accepted"].as_bool().expect("accepted"),
                "{}",
                case["name"].as_str().unwrap_or(uri),
            );
        }
    }

    #[test]
    fn preview_limits() {
        let ok = PreviewResult {
            request_id: uuid::Uuid::nil(),
            result: PreviewOutcome::Captured { jpeg_base64: "AAAA".into(), width: 960, height: 540 },
        };
        assert!(ok.within_limits());
        let huge = PreviewResult {
            request_id: uuid::Uuid::nil(),
            result: PreviewOutcome::Captured {
                jpeg_base64: "A".repeat(MAX_PREVIEW_BASE64_CHARS + 1),
                width: 960,
                height: 540,
            },
        };
        assert!(!huge.within_limits());
    }
}
