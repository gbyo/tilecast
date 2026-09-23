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
use crate::context::ContextValue;
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
/// later wall-clock correction never jumps active playback (RFC §20.1).
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextSnapshot {
    pub revision: u64,
    #[serde(deserialize_with = "crate::context::bounded_values")]
    pub values: Vec<ContextValue>,
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

// ------------------------------------------------------------------- enum

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    RendererConfigure(RendererConfigure),
    PresentationActivate(Box<PresentationActivate>),
    PresentationClear(PresentationClear),
    PluginState(PluginState),
    SyncPosition(SyncPosition),
    ContextSnapshot(ContextSnapshot),
    Identify(Identify),
    RendererCommand(RendererCommand),
    PreviewRequest(PreviewRequest),
    RendererShutdown(RendererShutdown),

    RendererReady(RendererReady),
    PresentationAccepted(PresentationAccepted),
    PresentationRejected(PresentationRejected),
    RendererProgress(RendererProgress),
    ItemError(ItemError),
    RendererHealth(RendererHealth),
    PreviewResult(PreviewResult),
    ShutdownAck(ShutdownAck),
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
    ContextSnapshot => "context.snapshot", DaemonToClient, [Renderer];
    Identify => "presentation.identify", DaemonToClient, [Renderer];
    RendererCommand => "renderer.command", DaemonToClient, [Renderer];
    PreviewRequest => "preview.request", DaemonToClient, [Renderer];
    RendererShutdown => "renderer.shutdown", DaemonToClient, [Renderer];

    RendererReady => "renderer.ready", ClientToDaemon, [Renderer];
    PresentationAccepted => "presentation.accepted", ClientToDaemon, [Renderer];
    PresentationRejected => "presentation.rejected", ClientToDaemon, [Renderer];
    RendererProgress => "renderer.progress", ClientToDaemon, [Renderer];
    ItemError => "renderer.item_error", ClientToDaemon, [Renderer];
    RendererHealth => "renderer.health", ClientToDaemon, [Renderer];
    PreviewResult => "renderer.preview", ClientToDaemon, [Renderer];
    ShutdownAck => "renderer.shutdown_ack", ClientToDaemon, [Renderer];
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
