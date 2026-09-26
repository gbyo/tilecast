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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationActivate {
    pub activation_id: ActivationId,
    /// Increases with every activation the daemon issues (process-local).
    pub generation: u64,
    pub presentation: PresentationDocument,
    #[serde(deserialize_with = "renderer_media_refs")]
    pub content: Vec<RendererMediaRef>,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererCommand {
    #[serde(with = "canonical_uuid")]
    pub command_id: uuid::Uuid,
    pub command: RendererCommandKind,
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

// ------------------------------------------------------------ Noise Meter

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

/// The runtime's smoothed level: absent, `null` or a finite value in `[0, 100]`.
fn percent_level<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    level_in(d, 100.0)
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

/// Daemon → renderer: a host-measured level for the runtime's Noise Meter
/// (`capabilities.noiseMeter = "host-levels"`). `null` while no measurement
/// is available.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoiseLevel {
    #[serde(deserialize_with = "unit_rms")]
    pub rms: Option<f64>,
}

/// The heartbeat's Noise Meter status vocabulary
/// (`apps/server/internal/devices/noise_meter_heartbeat.go`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoiseStatus {
    Active,
    Normal,
    Loud,
    Unavailable,
    Inactive,
}

impl NoiseStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Normal => "normal",
            Self::Loud => "loud",
            Self::Unavailable => "unavailable",
            Self::Inactive => "inactive",
        }
    }
}

/// The fixed Noise Meter history window.
pub const NOISE_BUCKET_MS: u32 = 10_000;

fn bucket_ms<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(d)?;
    if value > NOISE_BUCKET_MS {
        return Err(D::Error::custom("duration exceeds the bucket"));
    }
    Ok(value)
}

fn trigger_count<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let value = u32::deserialize(d)?;
    if value > 1_000 {
        return Err(D::Error::custom("trigger count exceeds its bound"));
    }
    Ok(value)
}

fn required_percent<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let value = f64::deserialize(d)?;
    if !value.is_finite() || !(0.0..=100.0).contains(&value) {
        return Err(D::Error::custom("level is out of range"));
    }
    Ok(value)
}

/// One completed ten-second aggregate (the runtime's
/// `TilecastNoiseHistoryBucket`). Derived numbers only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoiseBucket {
    pub started_at: crate::Timestamp,
    #[serde(deserialize_with = "required_percent")]
    pub average_level: f64,
    #[serde(deserialize_with = "required_percent")]
    pub peak_level: f64,
    #[serde(deserialize_with = "bucket_ms")]
    pub monitored_ms: u32,
    #[serde(deserialize_with = "bucket_ms")]
    pub warning_ms: u32,
    #[serde(deserialize_with = "bucket_ms")]
    pub loud_ms: u32,
    #[serde(deserialize_with = "trigger_count")]
    pub trigger_count: u32,
}

/// Renderer → daemon: the runtime's Noise Meter state, sent on a state change
/// and once per completed bucket, never at the sampling rate.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoiseReport {
    pub status: NoiseStatus,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "percent_level")]
    pub level: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<NoiseBucket>,
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
    NoiseLevel(NoiseLevel),
    CaptureSet(CaptureSet),

    RendererReady(RendererReady),
    PresentationAccepted(PresentationAccepted),
    PresentationRejected(PresentationRejected),
    RendererProgress(RendererProgress),
    ItemError(ItemError),
    RendererHealth(RendererHealth),
    PreviewResult(PreviewResult),
    ShutdownAck(ShutdownAck),
    NoiseReport(NoiseReport),
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
    NoiseLevel => "noise.level", DaemonToClient, [Renderer];
    CaptureSet => "capture.set", DaemonToClient, [SessionBridge];

    RendererReady => "renderer.ready", ClientToDaemon, [Renderer];
    PresentationAccepted => "presentation.accepted", ClientToDaemon, [Renderer];
    PresentationRejected => "presentation.rejected", ClientToDaemon, [Renderer];
    RendererProgress => "renderer.progress", ClientToDaemon, [Renderer];
    ItemError => "renderer.item_error", ClientToDaemon, [Renderer];
    RendererHealth => "renderer.health", ClientToDaemon, [Renderer];
    PreviewResult => "renderer.preview", ClientToDaemon, [Renderer];
    ShutdownAck => "renderer.shutdown_ack", ClientToDaemon, [Renderer];
    NoiseReport => "noise.report", ClientToDaemon, [Renderer];
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
    fn noise_and_bridge_events_carry_bounded_numbers_and_nothing_else() {
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

        let report = Event::decode(
            "noise.report",
            json!({"status": "loud", "level": 71.5, "bucket": {"startedAt": "2026-09-25T12:00:00.000Z",
                "averageLevel": 40.2, "peakLevel": 80, "monitoredMs": 10000, "warningMs": 2000, "loudMs": 500,
                "triggerCount": 1}}),
        )
        .expect("valid");
        assert_eq!(report.allowed_roles(), &[Role::Renderer]);
        assert!(Event::decode("noise.report", json!({"status": "inactive"})).is_ok());
        for bad in [
            json!({"status": "loud", "level": 101}),
            json!({"status": "shouting"}),
            json!({"status": "loud", "pcm": "AAAA"}),
            json!({"status": "loud", "bucket": {"startedAt": "2026-09-25T12:00:00Z", "averageLevel": 1,
                "peakLevel": 1, "monitoredMs": 10001, "warningMs": 0, "loudMs": 0, "triggerCount": 0}}),
            json!({"status": "loud", "bucket": {"startedAt": "2026-09-25T12:00:00Z", "averageLevel": 1,
                "peakLevel": 1, "monitoredMs": 100, "warningMs": 0, "loudMs": 0, "triggerCount": 0, "raw": []}}),
        ] {
            assert!(Event::decode("noise.report", bad.clone()).is_err(), "{bad}");
        }
        assert!(Event::decode("noise.level", json!({"rms": 0.5})).is_ok());
        assert!(Event::decode("noise.level", json!({"rms": 2})).is_err());
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
