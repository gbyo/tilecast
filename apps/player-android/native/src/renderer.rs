//! Android renderer adapter: Core activation, evidence, and recovery over JNI.
//!
//! Core owns activation identity, compatibility, evidence expectations, and
//! recovery timing through [`player_core::RendererCoordinator`]; the
//! [`PresentationEngine`] below drives it the way Edge's presentation engine
//! does. Android owns the transport ([`RendererPlatform`], one semantic
//! upcall), the document projection (Kotlin's `RuntimePresentationBuilder`
//! shapes the JSON; this module only scans it for `tcmedia:` bindings and
//! explicit metadata), and the trusted WebView runtime that shows it.
//!
//! A `tcmedia:` URI names an (asset, variant) pair from the target manifest.
//! The activate call joins each pair to its verified digest; the port
//! resolves each digest to its CAS path and grants exactly that set to the
//! WebView for the activation's generation. Raw paths never reach the page:
//! it sees only the `tcmedia:` URIs it was given, and the interceptor serves
//! them from the granted set. A URI without a grant, or a grant without a
//! verified CAS object, refuses the activation instead of showing partial
//! content.
//!
//! Connection identity reuses Kotlin's renderer generation (one per WebView
//! instance, never reused after death). Reports from a dead generation are
//! dropped before they reach the coordinator, so a stale page can neither
//! fake evidence nor disturb recovery.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use player_cas::ContentStore;
use player_core::{
    ActivationSource, CaptureBroker, CaptureError, CaptureState, CapturedFrame, ConnectedRendererProfile, Expectation,
    HealAction, ObjectBinding, ProgressEvidence, RendererActivation, RendererActivationRef, RendererCaptureRequest,
    RendererCoordinator, RendererMetadata, RendererPort, RendererPortError, RendererProfileMismatch,
    RendererRequirement, RendererSupport, RuntimePayload, SemanticRendererCommand, SemanticRendererProgress,
    SupervisorConfig, VerifiedContentRef, VerifiedFrameRef,
};
use player_types::ActivationId;
use player_types::bounded::{SafeText, ShortToken};
use player_types::time::SharedClock;
use player_types::{Sha256Digest, Timestamp};
use tokio::sync::Notify;

use crate::jvm::{Jvm, method};

/// One semantic renderer upcall. Kotlin answers fast from its queue; it
/// must never block the calling worker on the UI thread or the page.
pub trait RendererPlatform: Send + Sync + std::fmt::Debug {
    fn request(&self, json: &str) -> Result<(), RendererPortError>;
}

/// Calls `CoreBridgeHandler.rendererRequest` and maps its small integer
/// answer onto the port error the coordinator understands.
#[derive(Debug)]
pub struct JvmRendererPlatform {
    jvm: Arc<Jvm>,
}

impl JvmRendererPlatform {
    pub fn new(jvm: Arc<Jvm>) -> Self {
        Self { jvm }
    }
}

/// The `rendererRequest` answer codes, shared with Kotlin. Zero queues
/// the operation; anything else names why the renderer refused it.
pub mod request_code {
    pub const QUEUED: i32 = 0;
    pub const RESOURCE_UNAVAILABLE: i32 = 1;
    pub const INVALID_ACTIVATION: i32 = 2;
    pub const NOT_READY: i32 = 3;
}

fn request_error(code: i32) -> RendererPortError {
    match code {
        request_code::RESOURCE_UNAVAILABLE => RendererPortError::ResourceUnavailable,
        request_code::INVALID_ACTIVATION => RendererPortError::InvalidActivation,
        request_code::NOT_READY => RendererPortError::NotReady,
        _ => RendererPortError::QueueUnavailable,
    }
}

impl RendererPlatform for JvmRendererPlatform {
    fn request(&self, json: &str) -> Result<(), RendererPortError> {
        match self.jvm.call_int(method::renderer_request(), Some(json)) {
            Ok(request_code::QUEUED) => Ok(()),
            Ok(code) => Err(request_error(code)),
            Err(_) => Err(RendererPortError::QueueUnavailable),
        }
    }
}

/// In-memory renderer transport for host tests: records envelopes and
/// answers from a scripted code.
#[derive(Debug, Default)]
pub struct MemRendererPlatform {
    requests: Mutex<Vec<String>>,
    code: Mutex<i32>,
}

impl MemRendererPlatform {
    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap_or_else(|error| error.into_inner()).clone()
    }

    pub fn answer(&self, code: i32) {
        *self.code.lock().unwrap_or_else(|error| error.into_inner()) = code;
    }
}

impl RendererPlatform for MemRendererPlatform {
    fn request(&self, json: &str) -> Result<(), RendererPortError> {
        self.requests.lock().unwrap_or_else(|error| error.into_inner()).push(json.to_owned());
        match *self.code.lock().unwrap_or_else(|error| error.into_inner()) {
            request_code::QUEUED => Ok(()),
            code => Err(request_error(code)),
        }
    }
}

/// One verified media object the activation may show, joined from the
/// prepared target manifest by the caller (the selection driver; the
/// device tests join their fixture the same way).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationContent {
    pub asset_id: uuid::Uuid,
    pub variant_id: uuid::Uuid,
    pub digest: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: SafeText<127>,
}

/// One verified sandbox-frame document the activation may execute. The
/// digest selects bytes from the frame domain; the package pair
/// identifies the frame-table entry the Runtime joins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationFrame {
    pub package_id: SafeText<128>,
    pub package_digest: Sha256Digest,
    pub digest: Sha256Digest,
    pub size_bytes: u64,
}

/// Which prepared manifest an activation shows and what selected it:
/// the identifiers the reference player reports for its presentation.
#[derive(Debug, Clone)]
pub struct PlaybackIdentity {
    pub manifest: Sha256Digest,
    pub manifest_version: i64,
    pub selection_source: String,
    pub playlist_id: Option<uuid::Uuid>,
    pub layout_id: Option<uuid::Uuid>,
    pub schedule_id: Option<uuid::Uuid>,
    pub takeover_id: Option<uuid::Uuid>,
    pub next_transition_ms: Option<i64>,
}

/// The explicit `activatePresentation` call: a projected host message
/// plus the verified content it may reference. Mirrors Edge's
/// `PresentationEngine::activate` argument shape; the 5d selection driver
/// becomes the production caller.
#[derive(Debug, Clone)]
pub struct ActivateRequest {
    pub envelope: serde_json::Value,
    pub content: Vec<ActivationContent>,
    pub frames: Vec<ActivationFrame>,
    pub source: ActivationSource,
    pub identity: Option<PlaybackIdentity>,
    pub clock_offset_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivateError {
    Malformed,
    UnknownMedia,
    Unverified,
    TooLarge,
    Requirements,
}

impl ActivateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Malformed => "malformed_activation",
            Self::UnknownMedia => "unknown_media",
            Self::Unverified => "unverified_content",
            Self::TooLarge => "activation_too_large",
            Self::Requirements => "invalid_requirements",
        }
    }
}

fn parse_digest(hex: &str) -> Option<Sha256Digest> {
    Sha256Digest::parse(hex).ok()
}

/// Cheap pre-check on the caller's content list. Core's own content
/// bound stays authoritative at dispatch; this only refuses absurd
/// input before any CAS work.
const MAX_ACTIVATION_CONTENT: usize = 1024;

/// Parses a `tcmedia:` URI the way `MediaAuthorization` does: the scheme,
/// an optional `variant/` prefix, and two path tokens. Anything else is
/// not host media and never becomes a binding.
fn parse_media_uri(uri: &str) -> Option<(uuid::Uuid, uuid::Uuid)> {
    let uri = uri.trim();
    if uri.len() > 512 || uri.contains('\\') || uri.contains('\0') || uri.contains("..") {
        return None;
    }
    let rest = uri.strip_prefix("tcmedia:").or_else(|| uri.strip_prefix("TCMEDIA:"))?;
    let rest = rest.trim_start_matches('/');
    if rest.is_empty() || rest.contains('?') || rest.contains('#') {
        return None;
    }
    let parts: Vec<&str> = rest.split('/').collect();
    let parts = if parts.len() == 3 && parts[0].eq_ignore_ascii_case("variant") { &parts[1..] } else { &parts[..] };
    if parts.len() != 2 {
        return None;
    }
    Some((uuid::Uuid::parse_str(parts[0]).ok()?, uuid::Uuid::parse_str(parts[1]).ok()?))
}

fn parse_activate_request(raw: &str) -> Result<ActivateRequest, ActivateError> {
    if raw.is_empty() || raw.len() > 4 * 1024 * 1024 {
        return Err(ActivateError::Malformed);
    }
    let request: serde_json::Value = serde_json::from_str(raw).map_err(|_| ActivateError::Malformed)?;
    let envelope = request.get("envelope").cloned().ok_or(ActivateError::Malformed)?;
    if !envelope.is_object() {
        return Err(ActivateError::Malformed);
    }
    let mut content = Vec::new();
    for entry in request.get("content").and_then(serde_json::Value::as_array).ok_or(ActivateError::Malformed)? {
        content.push(ActivationContent {
            asset_id: entry
                .get("assetId")
                .and_then(serde_json::Value::as_str)
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .ok_or(ActivateError::Malformed)?,
            variant_id: entry
                .get("variantId")
                .and_then(serde_json::Value::as_str)
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .ok_or(ActivateError::Malformed)?,
            digest: entry
                .get("digest")
                .and_then(serde_json::Value::as_str)
                .and_then(parse_digest)
                .ok_or(ActivateError::Malformed)?,
            size_bytes: entry.get("sizeBytes").and_then(serde_json::Value::as_u64).ok_or(ActivateError::Malformed)?,
            mime_type: entry
                .get("mimeType")
                .and_then(serde_json::Value::as_str)
                .and_then(|mime| SafeText::new(mime).ok())
                .ok_or(ActivateError::Malformed)?,
        });
        if content.len() > MAX_ACTIVATION_CONTENT {
            return Err(ActivateError::TooLarge);
        }
    }
    let source = match request.get("source").and_then(serde_json::Value::as_str) {
        Some("status_surface") => ActivationSource::StatusSurface,
        Some("fixture") => ActivationSource::Fixture,
        Some("server_manifest") => ActivationSource::ServerManifest,
        Some("safe_mode") => ActivationSource::SafeMode,
        Some("policy") => ActivationSource::Policy,
        _ => return Err(ActivateError::Malformed),
    };
    let identity = request
        .get("identity")
        .map(|identity| {
            Ok(PlaybackIdentity {
                manifest: identity
                    .get("manifest")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_digest)
                    .ok_or(ActivateError::Malformed)?,
                manifest_version: identity
                    .get("manifestVersion")
                    .and_then(serde_json::Value::as_i64)
                    .ok_or(ActivateError::Malformed)?,
                selection_source: identity
                    .get("selectionSource")
                    .and_then(serde_json::Value::as_str)
                    .ok_or(ActivateError::Malformed)?
                    .chars()
                    .take(64)
                    .collect(),
                playlist_id: identity
                    .get("playlistId")
                    .and_then(serde_json::Value::as_str)
                    .map(uuid::Uuid::parse_str)
                    .transpose()
                    .map_err(|_| ActivateError::Malformed)?,
                layout_id: identity
                    .get("layoutId")
                    .and_then(serde_json::Value::as_str)
                    .map(uuid::Uuid::parse_str)
                    .transpose()
                    .map_err(|_| ActivateError::Malformed)?,
                schedule_id: identity
                    .get("scheduleId")
                    .and_then(serde_json::Value::as_str)
                    .map(uuid::Uuid::parse_str)
                    .transpose()
                    .map_err(|_| ActivateError::Malformed)?,
                takeover_id: identity
                    .get("takeoverId")
                    .and_then(serde_json::Value::as_str)
                    .map(uuid::Uuid::parse_str)
                    .transpose()
                    .map_err(|_| ActivateError::Malformed)?,
                next_transition_ms: identity.get("nextTransitionMs").and_then(serde_json::Value::as_i64),
            })
        })
        .transpose()?;
    let clock_offset_ms = request.get("clockOffsetMs").and_then(serde_json::Value::as_i64).unwrap_or(0);
    // Frame claims ride beside the media list. Absent means no external
    // Widgets; present must be an array of complete claims.
    let mut frames = Vec::new();
    if let Some(requested) = request.get("frames") {
        for entry in requested.as_array().ok_or(ActivateError::Malformed)? {
            frames.push(ActivationFrame {
                package_id: entry
                    .get("packageId")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|id| SafeText::new(id).ok())
                    .ok_or(ActivateError::Malformed)?,
                package_digest: entry
                    .get("packageDigest")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_digest)
                    .ok_or(ActivateError::Malformed)?,
                digest: entry
                    .get("frameDigest")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_digest)
                    .ok_or(ActivateError::Malformed)?,
                size_bytes: entry
                    .get("sizeBytes")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or(ActivateError::Malformed)?,
            });
            if frames.len() > MAX_ACTIVATION_CONTENT {
                return Err(ActivateError::TooLarge);
            }
        }
    }
    Ok(ActivateRequest { envelope, content, frames, source, identity, clock_offset_ms })
}

/// Scans a projected value for `tcmedia:` URIs, blanking each one and
/// recording its binding. The URI text round-trips through the port's
/// grants, so the page receives exactly the URIs it was projected.
fn scan_bindings(
    value: &mut serde_json::Value,
    path: &str,
    media: &HashMap<(uuid::Uuid, uuid::Uuid), Sha256Digest>,
    uris: &mut HashMap<Sha256Digest, String>,
    found: &mut Vec<ObjectBinding>,
) -> Result<(), ActivateError> {
    match value {
        serde_json::Value::String(text) if text.to_ascii_lowercase().starts_with("tcmedia:") => {
            let key = parse_media_uri(text).ok_or(ActivateError::Malformed)?;
            let digest = media.get(&key).copied().ok_or(ActivateError::UnknownMedia)?;
            uris.entry(digest).or_insert_with(|| text.clone());
            found.push(ObjectBinding {
                pointer: SafeText::new(path).map_err(|_| ActivateError::TooLarge)?,
                object: digest,
            });
            text.clear();
        }
        serde_json::Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                scan_bindings(item, &format!("{path}/{index}"), media, uris, found)?;
            }
        }
        serde_json::Value::Object(members) => {
            for (key, item) in members.iter_mut() {
                let key = key.replace('~', "~0").replace('/', "~1");
                scan_bindings(item, &format!("{path}/{key}"), media, uris, found)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn expectation_for(kind: &str) -> Expectation {
    match kind {
        "image" => Expectation::Still,
        "video" => Expectation::Video,
        "website" | "widget" | "youtube" => Expectation::Website,
        "layout" => Expectation::Layout,
        _ => Expectation::Indefinite,
    }
}

fn capture_state_for(state: &str) -> CaptureState {
    match state {
        "setup" => CaptureState::Setup,
        "pairing" => CaptureState::Pairing,
        "safe-mode" => CaptureState::SafeMode,
        _ => CaptureState::Presentation,
    }
}

/// Builds the explicit native semantics for a projected presentation:
/// one feature requirement per item kind, schema and capability
/// requirements from the projection manifest, per-item evidence
/// expectations, and the capture state. Status surfaces other than
/// setup, pairing, and safe mode are capturable screens with no
/// content evidence to wait for.
pub(crate) fn projection_metadata(
    presentation: &serde_json::Value,
    projection: Option<&serde_json::Value>,
) -> Result<RendererMetadata, ActivateError> {
    let mut requirements = Vec::new();
    let mut push = |requirement: RendererRequirement| {
        if !requirements.contains(&requirement) {
            requirements.push(requirement);
        }
        if requirements.len() > player_core::MAX_RENDERER_REQUIREMENTS {
            return Err(ActivateError::Requirements);
        }
        Ok(())
    };
    let items = presentation.get("items").and_then(serde_json::Value::as_array);
    let mut expectations = HashMap::new();
    // Every surface needs the status vocabulary; playing items add their
    // kind's features exactly as the Edge reference host requires them.
    push(RendererRequirement::Feature(ShortToken::new("status-surfaces-v1").expect("literal")))?;
    for item in items.into_iter().flatten() {
        let kind = item.get("kind").and_then(serde_json::Value::as_str).unwrap_or("");
        let features: &[&str] = match kind {
            "image" => &["image"],
            "video" => &["video"],
            "website" => &["website", "remote-web-v1"],
            "widget" => &["render-tree-v1"],
            "layout" => &["layout-v1"],
            "youtube" => &["youtube", "remote-web-v1"],
            _ => &[],
        };
        for feature in features.iter().copied() {
            push(RendererRequirement::Feature(ShortToken::new(feature).expect("literal")))?;
        }
        if let Some(id) = item.get("id").and_then(serde_json::Value::as_str).and_then(|id| SafeText::new(id).ok()) {
            expectations.insert(id, expectation_for(kind));
        }
    }
    if presentation.get("synchronized").and_then(serde_json::Value::as_bool).is_some_and(|sync| sync) {
        push(RendererRequirement::Feature(ShortToken::new("synchronized-playback-v1").expect("literal")))?;
    }
    if let Some(manifest) = projection.and_then(|projection| projection.get("manifest")) {
        let widgets: Vec<&serde_json::Value> =
            manifest.get("widgets").and_then(serde_json::Value::as_array).into_iter().flatten().collect();
        let layouts: Vec<&serde_json::Value> =
            manifest.get("layouts").and_then(serde_json::Value::as_array).into_iter().flatten().collect();
        // A web or YouTube Widget still travels as a reference; what it
        // needs from the renderer is recorded here, explicitly, so the
        // renderer never infers it from provider names. Only Widgets the
        // playing items actually reference count: directly, or through a
        // referenced Layout's placements.
        let mut referenced: Vec<&str> = Vec::new();
        for item in items.into_iter().flatten() {
            if let Some(id) =
                item.get("widget").and_then(|widget| widget.get("widgetAssetId")).and_then(serde_json::Value::as_str)
            {
                referenced.push(id);
            }
            if let Some(id) =
                item.get("layout").and_then(|layout| layout.get("layoutId")).and_then(serde_json::Value::as_str)
            {
                let placements = layouts
                    .iter()
                    .find(|layout| layout.get("id").and_then(serde_json::Value::as_str) == Some(id))
                    .and_then(|layout| layout.get("document"))
                    .and_then(|document| document.get("placements"))
                    .and_then(serde_json::Value::as_array);
                for placement in placements.into_iter().flatten() {
                    if placement.get("type").and_then(serde_json::Value::as_str) == Some("widget")
                        && let Some(id) = placement.get("widgetId").and_then(serde_json::Value::as_str)
                    {
                        referenced.push(id);
                    }
                }
            }
        }
        for widget in widgets.iter().filter(|widget| {
            widget.get("assetId").and_then(serde_json::Value::as_str).is_some_and(|id| referenced.contains(&id))
        }) {
            let remote = widget.get("provider").and_then(serde_json::Value::as_str) == Some("youtube")
                || widget
                    .get("presentation")
                    .and_then(|presentation| presentation.get("kind"))
                    .and_then(serde_json::Value::as_str)
                    == Some("web");
            if !remote {
                continue;
            }
            push(RendererRequirement::Feature(ShortToken::new("remote-web-v1").expect("literal")))?;
            let feature = if widget.get("provider").and_then(serde_json::Value::as_str) == Some("youtube") {
                "youtube"
            } else {
                "website"
            };
            push(RendererRequirement::Feature(ShortToken::new(feature).expect("literal")))?;
        }
        let presentations =
            widgets.iter().filter_map(|widget| widget.get("presentation").filter(|value| !value.is_null()));
        let layouts = manifest
            .get("layouts")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|layout| layout.get("document"));
        for presentation in presentations.chain(layouts) {
            let version = presentation
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
                .and_then(|version| u32::try_from(version).ok())
                .filter(|version| *version > 0)
                .ok_or(ActivateError::Requirements)?;
            push(RendererRequirement::PresentationSchema(version))?;
            if let Some(required) = presentation.get("requiredCapabilities") {
                for (name, version) in required.as_object().ok_or(ActivateError::Requirements)? {
                    let name = ShortToken::new(name).map_err(|_| ActivateError::Requirements)?;
                    let version = version
                        .as_u64()
                        .and_then(|version| u32::try_from(version).ok())
                        .filter(|version| *version > 0)
                        .ok_or(ActivateError::Requirements)?;
                    push(if name.as_str().starts_with("widget.") {
                        RendererRequirement::WidgetComponent { name, version }
                    } else {
                        RendererRequirement::Declarative { name, version }
                    })?;
                }
            }
        }
    }
    let state = presentation.get("state").and_then(serde_json::Value::as_str).unwrap_or("");
    let playing = state == "playing" && items.is_some_and(|items| !items.is_empty());
    // Core validates the shape again at activation; an oversized
    // projection refuses there rather than here.
    Ok(RendererMetadata {
        requirements,
        expectations,
        requires_content_evidence: playing,
        capture_state: capture_state_for(state),
    })
}

/// Parses a `renderer.ready` support report leniently: bounded sets, and
/// anything unreadable refuses the report rather than the renderer.
pub fn connected_profile(report: &serde_json::Value) -> Option<ConnectedRendererProfile> {
    let support = report.get("support");
    let mut features = BTreeSet::new();
    for feature in report.get("features").and_then(serde_json::Value::as_array).into_iter().flatten() {
        features.insert(ShortToken::new(feature.as_str()?).ok()?);
    }
    let mut schemas = BTreeSet::new();
    for schema in support
        .and_then(|support| support.get("presentationSchemas"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        schemas.insert(u32::try_from(schema.as_u64()?).ok()?);
    }
    let table = |key: &str| {
        let mut entries = BTreeMap::new();
        for (name, version) in
            support.and_then(|support| support.get(key)).and_then(serde_json::Value::as_object).into_iter().flatten()
        {
            entries.insert(ShortToken::new(name).ok()?, u32::try_from(version.as_u64()?).ok()?);
        }
        Some(entries)
    };
    RendererSupport::new(features, schemas, table("declarativeCapabilities")?, table("widgetComponents")?)
        .ok()
        .map(ConnectedRendererProfile)
}

/// One media grant: the URI text the page receives plus the verified
/// CAS path the interceptor serves for it. Grants live for exactly one
/// activation generation; replacing the activation retires the old set.
#[derive(Debug, Clone)]
struct Grant {
    uri: String,
    asset_id: uuid::Uuid,
    variant_id: uuid::Uuid,
    path: std::path::PathBuf,
    size_bytes: u64,
    mime_type: SafeText<127>,
}

/// One authorized frame document: the interceptor serves `path` at `uri`.
/// The URI carries an opaque per-activation token, never the digest or a
/// path; authorization is membership in this per-activation token set.
#[derive(Debug, Clone)]
struct FrameGrant {
    uri: String,
    package_id: SafeText<128>,
    package_digest: Sha256Digest,
    path: std::path::PathBuf,
    size_bytes: u64,
}

/// Mints one opaque frame token. Randomness failure refuses the
/// activation rather than reusing a predictable token.
fn mint_frame_token() -> Option<String> {
    use ring::rand::SecureRandom as _;
    let mut bytes = [0_u8; 32];
    ring::rand::SystemRandom::new().fill(&mut bytes).ok()?;
    Some(bytes.iter().fold(String::with_capacity(64), |mut token, byte| {
        use std::fmt::Write as _;
        let _ = write!(token, "{byte:02x}");
        token
    }))
}

/// The live generation's grants, if an activation is prepared.
type GenerationGrants = Option<(u64, HashMap<Sha256Digest, Grant>, HashMap<Sha256Digest, FrameGrant>)>;

/// The media and frame grant tables handed to one generation's projection.
type LiveGrants = (HashMap<Sha256Digest, Grant>, HashMap<Sha256Digest, FrameGrant>);

/// Android's [`RendererPort`]: generation-bound media grants over the one
/// semantic JNI upcall. The port never sends credentials, paths the page
/// could reach (paths travel only inside the native grant list), or
/// high-frequency presentation state.
#[derive(Debug, Clone)]
pub struct AndroidRendererPort {
    platform: Arc<dyn RendererPlatform>,
    cas: ContentStore,
    grants: Arc<Mutex<GenerationGrants>>,
}

impl AndroidRendererPort {
    pub fn new(platform: Arc<dyn RendererPlatform>, cas: ContentStore) -> Self {
        Self { platform, cas, grants: Arc::new(Mutex::new(None)) }
    }

    /// Authorizes verified CAS objects for a generation. Every digest
    /// must resolve to a verified path; the first failure refuses the
    /// activation and leaves the previous grants untouched.
    pub async fn prepare_grants(
        &self,
        generation: u64,
        content: &[ActivationContent],
        frames: &[ActivationFrame],
        uris: &HashMap<Sha256Digest, String>,
    ) -> Result<(), RendererPortError> {
        let mut grants = HashMap::new();
        for object in content {
            let uri = uris.get(&object.digest).ok_or(RendererPortError::InvalidActivation)?.clone();
            let path = self
                .cas
                .verified_path(&object.digest)
                .await
                .ok()
                .flatten()
                .ok_or(RendererPortError::ResourceUnavailable)?;
            grants.insert(
                object.digest,
                Grant {
                    uri,
                    asset_id: object.asset_id,
                    variant_id: object.variant_id,
                    path,
                    size_bytes: object.size_bytes,
                    mime_type: object.mime_type.clone(),
                },
            );
        }
        // A digest claimed as both media and a frame fails the
        // activation rather than serving one object's bytes twice.
        let mut tokens = std::collections::HashSet::new();
        let mut frame_grants = HashMap::new();
        for frame in frames {
            if grants.contains_key(&frame.digest) {
                return Err(RendererPortError::InvalidActivation);
            }
            let path = self
                .cas
                .verified_path(&frame.digest)
                .await
                .ok()
                .flatten()
                .ok_or(RendererPortError::ResourceUnavailable)?;
            let mut token = mint_frame_token().ok_or(RendererPortError::InvalidActivation)?;
            while tokens.contains(&token) {
                token = mint_frame_token().ok_or(RendererPortError::InvalidActivation)?;
            }
            tokens.insert(token.clone());
            frame_grants.insert(
                frame.digest,
                FrameGrant {
                    uri: format!("tcwidget://cap/{token}"),
                    package_id: frame.package_id.clone(),
                    package_digest: frame.package_digest,
                    path,
                    size_bytes: frame.size_bytes,
                },
            );
        }
        *self.grants.lock().unwrap_or_else(|error| error.into_inner()) = Some((generation, grants, frame_grants));
        Ok(())
    }

    fn grants_for(&self, generation: u64) -> Result<LiveGrants, RendererPortError> {
        let grants = self.grants.lock().unwrap_or_else(|error| error.into_inner());
        match grants.as_ref() {
            Some((live, grants, frames)) if *live == generation => Ok((grants.clone(), frames.clone())),
            _ => Err(RendererPortError::InvalidActivation),
        }
    }

    /// Asks Kotlin to project and offer the safe-mode surface after the
    /// recovery ladder gives up. The surface returns through the normal
    /// `activatePresentation` path with the `safe_mode` source.
    pub fn show_safe_mode(&self, reason: &str) -> Result<(), RendererPortError> {
        self.platform.request(
            &serde_json::json!({"op": "show_safe_mode", "reason": reason.chars().take(240).collect::<String>()})
                .to_string(),
        )
    }

    /// Asks Kotlin to offer the explicit unavailable surface with the
    /// compatibility reason. Unlike safe mode this is not a Core
    /// activation: no evidence is expected and nothing reports back.
    pub fn show_unavailable(&self, reason: &str) -> Result<(), RendererPortError> {
        self.platform.request(
            &serde_json::json!({"op": "show_unavailable", "reason": reason.chars().take(240).collect::<String>()})
                .to_string(),
        )
    }
}

fn wire_document(
    document: &RuntimePayload,
    resolve: &impl Fn(Sha256Digest) -> Option<String>,
) -> Result<serde_json::Value, RendererPortError> {
    document.resolve(resolve).map_err(|_| RendererPortError::InvalidActivation)
}

impl RendererPort for AndroidRendererPort {
    fn activate(&self, activation: &RendererActivation) -> Result<(), RendererPortError> {
        let reference = activation.reference();
        let (grants, frame_grants) = self.grants_for(reference.generation)?;
        let resolve = |object: Sha256Digest| grants.get(&object).map(|grant| grant.uri.clone());
        let presentation = wire_document(activation.document(), &resolve)?;
        let context = activation.runtime_context().map(|context| wire_document(context, &resolve)).transpose()?;
        let content: Vec<serde_json::Value> = activation
            .content()
            .iter()
            .map(|object| {
                let grant = grants.get(&object.sha256).ok_or(RendererPortError::InvalidActivation)?;
                Ok(serde_json::json!({
                    "uri": grant.uri,
                    "assetId": grant.asset_id.to_string(),
                    "variantId": grant.variant_id.to_string(),
                    "digest": object.sha256.to_hex(),
                    "sizeBytes": grant.size_bytes,
                    "mimeType": grant.mime_type.as_str(),
                    "path": grant.path.to_string_lossy(),
                }))
            })
            .collect::<Result<_, RendererPortError>>()?;
        // Frames ride the envelope beside the media grants, and the
        // projection carries the authorization table the projector
        // joins. Every claim must have a grant; a missing one fails
        // the activation rather than executing a frame unconfined.
        let frames: Vec<serde_json::Value> = activation
            .frames()
            .iter()
            .map(|frame| {
                let grant = frame_grants.get(&frame.sha256).ok_or(RendererPortError::InvalidActivation)?;
                Ok(serde_json::json!({
                    "uri": grant.uri,
                    "packageId": grant.package_id.as_str(),
                    "packageDigest": grant.package_digest.to_hex(),
                    "frameDigest": frame.sha256.to_hex(),
                    "sizeBytes": grant.size_bytes,
                    "path": grant.path.to_string_lossy(),
                }))
            })
            .collect::<Result<_, RendererPortError>>()?;
        let mut envelope = serde_json::json!({
            "op": "activate",
            "activationId": reference.activation_id.to_string(),
            "generation": reference.generation,
            "presentation": presentation,
            "content": content,
            "frames": frames,
        });
        if let Some(context) = context.as_ref().and_then(|context| context.as_object()) {
            if let Some(timing) = context.get("timing") {
                envelope["timing"] = timing.clone();
            }
            if let Some(projection) = context.get("projection") {
                let mut projection = projection.clone();
                if !frames.is_empty() {
                    let Some(object) = projection.as_object_mut() else {
                        return Err(RendererPortError::InvalidActivation);
                    };
                    if object.contains_key("widgetFrames") {
                        // The port builds the authorization table; a table
                        // already present means a confused upstream.
                        return Err(RendererPortError::InvalidActivation);
                    }
                    object.insert(
                        "widgetFrames".to_string(),
                        serde_json::Value::Array(
                            frames
                                .iter()
                                .map(|frame| {
                                    serde_json::json!({
                                        "packageId": frame["packageId"],
                                        "packageDigest": frame["packageDigest"],
                                        "frameDigest": frame["frameDigest"],
                                        "uri": frame["uri"],
                                    })
                                })
                                .collect(),
                        ),
                    );
                }
                envelope["projection"] = projection;
            } else if !frames.is_empty() {
                return Err(RendererPortError::InvalidActivation);
            }
            // Plugin surfaces travel beside the presentation, as Edge's
            // adapter forwards them; the runtime reads a separate
            // `plugins` host message built from these members.
            for key in ["plugins", "pluginAliases", "clockOffsetMs"] {
                if let Some(value) = context.get(key).filter(|value| !value.is_null()) {
                    envelope[key] = value.clone();
                }
            }
        }
        self.platform.request(&envelope.to_string())
    }

    fn clear(&self, reason: &ShortToken) -> Result<(), RendererPortError> {
        self.platform.request(&serde_json::json!({"op": "clear", "reason": reason.as_str()}).to_string())
    }

    fn send_command(&self, command_id: uuid::Uuid, command: &SemanticRendererCommand) -> Result<(), RendererPortError> {
        let mut envelope = serde_json::json!({"op": "command", "commandId": command_id.to_string()});
        match command {
            SemanticRendererCommand::RetryItem => envelope["command"] = serde_json::json!("retry_item"),
            SemanticRendererCommand::SkipItem => envelope["command"] = serde_json::json!("skip_item"),
            SemanticRendererCommand::Reload => envelope["command"] = serde_json::json!("reload"),
            SemanticRendererCommand::ClearWebsiteData => envelope["command"] = serde_json::json!("clear_website_data"),
            SemanticRendererCommand::Identify { name, duration_seconds } => {
                envelope["command"] = serde_json::json!("identify");
                envelope["name"] = serde_json::json!(name.as_str());
                envelope["durationSeconds"] = serde_json::json!(duration_seconds);
            }
        }
        self.platform.request(&envelope.to_string())
    }

    fn request_capture(&self, request: RendererCaptureRequest) -> Result<(), RendererPortError> {
        self.platform.request(
            &serde_json::json!({
                "op": "capture",
                "requestId": request.request_id.to_string(),
                "maxWidth": request.max_width,
                "maxHeight": request.max_height,
                "maxBytes": request.max_bytes,
            })
            .to_string(),
        )
    }

    fn request_restart(&self, reason: &ShortToken, deadline_ms: u32) -> Result<(), RendererPortError> {
        self.platform.request(
            &serde_json::json!({"op": "restart", "reason": reason.as_str(), "deadlineMs": deadline_ms}).to_string(),
        )
    }
}

/// What status, telemetry, and the heartbeat read without locking the
/// engine: the link state, the current activation's standing, and the
/// last renderer error. Updated on every engine mutation.
#[derive(Debug, Clone, Default)]
pub struct RendererSnapshot {
    pub connected: bool,
    pub ready: bool,
    pub state: String,
    pub generation: Option<u64>,
    pub accepted: bool,
    pub evidence: bool,
    /// The current activation is a playing presentation (as opposed to
    /// a status surface). Whether it proved itself is [`Self::evidence`].
    pub playing: bool,
    pub safe_mode: bool,
    pub incompatible_reason: Option<String>,
    pub last_error: Option<String>,
    pub current_item_id: Option<String>,
    /// The last meaningful renderer progress: the heartbeat's
    /// `lastHealthyPlaybackAt` while a playing presentation is healthy.
    pub last_progress_at: Option<Timestamp>,
    /// When the current activation was issued: the heartbeat's
    /// `lastPlaylistTransitionAt`.
    pub last_activation_at: Option<Timestamp>,
}

/// The prepared activation the engine issued: the caller's request for
/// reactivation, the semantic activation for dispatch, and the URI text
/// per digest for grant preparation.
#[derive(Debug, Clone)]
struct Prepared {
    request: ActivateRequest,
    reference: RendererActivationRef,
    activation: RendererActivation,
    uris: HashMap<Sha256Digest, String>,
}

#[derive(Debug)]
struct RendererLink {
    connection: uuid::Uuid,
    generation: i64,
    ready: Option<ConnectedRendererProfile>,
}

/// Drives Core's [`RendererCoordinator`] from explicit activations and
/// renderer reports. Mirrors Edge's presentation engine: the engine
/// issues activations, pushes the current one to a ready renderer,
/// feeds reports into Core, and executes the recovery ladder through
/// the port. Where activations come from is the caller's concern: the
/// device tests and the 5d selection driver call [`Self::activate`].
pub struct PresentationEngine {
    native: RendererCoordinator,
    port: AndroidRendererPort,
    clock: SharedClock,
    current: Option<Prepared>,
    link: Option<RendererLink>,
    incompatible_reason: Option<String>,
    activity: Option<player_core::ActivityHandle>,
    snapshot: Arc<Mutex<RendererSnapshot>>,
    restart_count: u64,
    clock_offset_ms: i64,
    manifest_wake: Arc<Notify>,
    item_boundary: Arc<AtomicBool>,
    last_activation_at: Option<Timestamp>,
    /// The installed runtime cannot host the player at all (its WebView
    /// lacks the bridge the trusted document needs). Sticky: no renderer
    /// will ever connect, so capability advertisement is empty rather
    /// than the fresh-process fallback.
    unsupported_runtime: bool,
}

impl std::fmt::Debug for PresentationEngine {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PresentationEngine")
            .field("current", &self.current.as_ref().map(|current| current.reference))
            .field("link", &self.link.as_ref().map(|link| link.generation))
            .field("safe_mode", &self.native.is_safe_mode())
            .finish()
    }
}

/// The current activation as the selection driver compares it.
#[derive(Debug, Clone)]
pub(crate) struct CurrentActivation {
    pub source: ActivationSource,
    pub manifest: Option<Sha256Digest>,
    pub presentation: serde_json::Value,
    pub content: Vec<ActivationContent>,
    pub timing: Option<serde_json::Value>,
    pub identity: Option<PlaybackIdentity>,
}

/// The JNI answer to `activatePresentation`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivateOutcome {
    pub activation_id: String,
    pub generation: u64,
    pub queued: bool,
    pub incompatible_reason: Option<String>,
}

fn connection_for(generation: i64) -> uuid::Uuid {
    uuid::Uuid::from_u128(u128::from(generation.max(0) as u64))
}

fn activation_ref(activation_id: &str, generation: u64) -> Option<RendererActivationRef> {
    Some(RendererActivationRef { activation_id: activation_id.parse().ok()?, generation })
}

impl PresentationEngine {
    pub fn new(
        port: AndroidRendererPort,
        clock: SharedClock,
        snapshot: Arc<Mutex<RendererSnapshot>>,
        manifest_wake: Arc<Notify>,
        item_boundary: Arc<AtomicBool>,
        now: Timestamp,
    ) -> Self {
        let engine = Self {
            native: RendererCoordinator::new(
                crate::manifest_host::profile::packaged(),
                SupervisorConfig::default(),
                now,
            ),
            port,
            clock,
            current: None,
            link: None,
            incompatible_reason: None,
            activity: None,
            snapshot,
            restart_count: 0,
            clock_offset_ms: 0,
            manifest_wake,
            item_boundary,
            last_activation_at: None,
            unsupported_runtime: false,
        };
        engine.refresh_snapshot();
        engine
    }

    /// The installed runtime cannot host the player: no renderer will
    /// ever connect. Later connections still win if one somehow arrives;
    /// until then advertisement is empty, never the fresh fallback.
    pub fn renderer_unsupported(&mut self) {
        self.unsupported_runtime = true;
        self.refresh_snapshot();
    }

    /// The support heartbeat and preparation-time compatibility checks
    /// advertise: the live connection's ready report, empty when the
    /// runtime is unsupported, or `None` before any renderer proves
    /// itself (callers use the fresh-process fallback then).
    pub fn advertised_support(&self) -> Option<ConnectedRendererProfile> {
        if self.unsupported_runtime && self.link.as_ref().is_none_or(|link| link.ready.is_none()) {
            return Some(ConnectedRendererProfile(player_core::RendererSupport::default()));
        }
        self.link.as_ref().and_then(|link| link.ready.clone())
    }

    /// The corrected server clock offset the selection driver last
    /// reported. Reactivation refreshes a stored request with it so a
    /// clock correction is not lost to an older activation.
    pub fn set_clock_offset(&mut self, offset_ms: i64) {
        self.clock_offset_ms = offset_ms;
    }

    pub fn set_activity(&mut self, activity: player_core::ActivityHandle) {
        self.activity = Some(activity);
    }

    /// Whether the live renderer provides every requirement, as the
    /// selection driver checks before projecting onto it.
    pub(crate) fn supports(&self, requirements: &[RendererRequirement]) -> bool {
        self.native.supports(requirements)
    }

    /// The current activation as the selection driver compares it.
    /// Policy and status surfaces report like any other activation:
    /// the driver must see what is actually on screen.
    pub(crate) fn current_activation(&self) -> Option<CurrentActivation> {
        let current = self.current.as_ref()?;
        Some(CurrentActivation {
            source: current.request.source,
            manifest: current.request.identity.as_ref().map(|identity| identity.manifest),
            presentation: current.request.envelope.get("presentation").cloned().unwrap_or(serde_json::Value::Null),
            content: current.request.content.clone(),
            timing: current.request.envelope.get("timing").cloned(),
            identity: current.request.identity.clone(),
        })
    }

    pub(crate) fn current_is_accepted(&self) -> bool {
        self.native.tracker().accepted_current()
    }

    pub(crate) fn current_has_activation_evidence(&self) -> bool {
        self.native.has_activation_evidence()
    }

    pub(crate) fn current_has_renderer_error(&self) -> bool {
        self.native.tracker().has_error()
    }

    pub fn port(&self) -> &AndroidRendererPort {
        &self.port
    }

    pub fn clock(&self) -> &SharedClock {
        &self.clock
    }

    fn signal(&self, signal: player_core::ActivitySignal) {
        if let Some(activity) = &self.activity {
            activity.send(signal);
        }
    }

    /// Issues a new activation and pushes it when a ready renderer is
    /// connected. Unknown media, unverified content, and oversized
    /// projections refuse before Core sees anything.
    pub async fn activate(&mut self, raw: &str, now: Timestamp) -> Result<ActivateOutcome, ActivateError> {
        let request = parse_activate_request(raw)?;
        self.activate_request(request, now).await
    }

    pub(crate) async fn activate_request(
        &mut self,
        request: ActivateRequest,
        now: Timestamp,
    ) -> Result<ActivateOutcome, ActivateError> {
        let media: HashMap<(uuid::Uuid, uuid::Uuid), Sha256Digest> =
            request.content.iter().map(|entry| ((entry.asset_id, entry.variant_id), entry.digest)).collect();
        let mut presentation = request.envelope.get("presentation").cloned().ok_or(ActivateError::Malformed)?;
        if !presentation.is_object() {
            return Err(ActivateError::Malformed);
        }
        let mut context = serde_json::json!({
            "timing": request.envelope.get("timing").cloned().unwrap_or(serde_json::Value::Null),
            "projection": request.envelope.get("projection").cloned().unwrap_or(serde_json::Value::Null),
            "plugins": request.envelope.get("plugins").cloned().unwrap_or(serde_json::Value::Null),
            "pluginAliases": request.envelope.get("pluginAliases").cloned().unwrap_or(serde_json::Value::Null),
            "clockOffsetMs": request.clock_offset_ms,
        });
        // The corrected clock offset is stamped at activation, as Edge
        // stamps it when preparing its runtime context.
        if let Some(timing) = context.get_mut("timing").filter(|timing| timing.is_object()) {
            timing["clockOffsetMs"] = serde_json::json!(request.clock_offset_ms);
        }
        if let Some(projection) = context.get_mut("projection").filter(|projection| projection.is_object()) {
            projection["clockOffsetMs"] = serde_json::json!(request.clock_offset_ms);
        }
        // The scan blanks only `tcmedia:` strings, so the state, items,
        // and projection manifest stay readable for the metadata below.
        let mut uris = HashMap::new();
        let mut document_bindings = Vec::new();
        scan_bindings(&mut presentation, "", &media, &mut uris, &mut document_bindings)?;
        let mut context_bindings = Vec::new();
        scan_bindings(&mut context, "", &media, &mut uris, &mut context_bindings)?;
        let metadata = projection_metadata(&presentation, request.envelope.get("projection"))?;
        let document = RuntimePayload::new(presentation, document_bindings).map_err(|_| ActivateError::TooLarge)?;
        let runtime_context =
            Some(RuntimePayload::new(context, context_bindings).map_err(|_| ActivateError::TooLarge)?);
        let content: Vec<VerifiedContentRef> = request
            .content
            .iter()
            .map(|entry| VerifiedContentRef {
                sha256: entry.digest,
                size_bytes: entry.size_bytes,
                mime_type: entry.mime_type.clone(),
                // The Android host requires downloads; stream-backed
                // claims are an Edge capability it does not advertise.
                stream: None,
            })
            .collect();
        let frames: Vec<VerifiedFrameRef> = request
            .frames
            .iter()
            .map(|entry| VerifiedFrameRef {
                package_id: entry.package_id.clone(),
                package_digest: entry.package_digest,
                sha256: entry.digest,
                size_bytes: entry.size_bytes,
            })
            .collect();
        let prepared_error = |error: player_core::PreparedActivationError| match error {
            player_core::PreparedActivationError::TooLarge => ActivateError::TooLarge,
            player_core::PreparedActivationError::UnlistedObject => ActivateError::UnknownMedia,
        };
        let reference = self
            .native
            .begin_activation(ActivationId::from_uuid(uuid::Uuid::new_v4()), metadata.clone(), now)
            .map_err(prepared_error)?;
        let activation = RendererActivation::new(reference, document, metadata, content, frames, runtime_context)
            .map_err(prepared_error)?;
        // Grants resolve before the activation is stored: a failure
        // withdraws the begun activation so the recovery ladder never
        // runs against content it cannot authorize.
        if let Err(error) =
            self.port.prepare_grants(reference.generation, &request.content, &request.frames, &uris).await
        {
            self.native.clear();
            return Err(match error {
                RendererPortError::ResourceUnavailable => ActivateError::Unverified,
                _ => ActivateError::Malformed,
            });
        }
        if let Some(presented) = presented_signal(&request) {
            self.signal(player_core::ActivitySignal::Presented(presented));
        }
        self.current = Some(Prepared { request, reference, activation, uris });
        self.last_activation_at = Some(now);
        self.push_current().await;
        self.refresh_snapshot();
        Ok(ActivateOutcome {
            activation_id: reference.activation_id.to_string(),
            generation: reference.generation,
            queued: self.incompatible_reason.is_none() && self.link.as_ref().is_some_and(|link| link.ready.is_some()),
            incompatible_reason: self.incompatible_reason.clone(),
        })
    }

    /// Pushes the current activation to a ready renderer. Without one
    /// the activation waits; the ready report pushes it. Incompatible
    /// content shows the explicit unavailable surface with the reason
    /// instead of failing silently.
    async fn push_current(&mut self) {
        let Some(link) = self.link.as_ref().filter(|link| link.ready.is_some()) else { return };
        let connection = link.connection;
        let Some(current) = self.current.clone() else { return };
        if self
            .port
            .prepare_grants(
                current.reference.generation,
                &current.request.content,
                &current.request.frames,
                &current.uris,
            )
            .await
            .is_err()
        {
            self.incompatible_reason = None;
            return;
        }
        let incompatible = match self.native.dispatch(connection, &current.activation, &self.port) {
            Ok(player_core::RendererDispatch::Queued) => {
                self.incompatible_reason = None;
                return;
            }
            Ok(player_core::RendererDispatch::Incompatible(missing)) => missing,
            Err(_) => {
                self.incompatible_reason = None;
                return;
            }
        };
        let missing: Vec<String> = incompatible
            .iter()
            .map(|(requirement, _)| match requirement {
                RendererRequirement::Feature(name) => name.as_str().to_owned(),
                RendererRequirement::PresentationSchema(version) => format!("presentation schema {version}"),
                RendererRequirement::Declarative { name, version }
                | RendererRequirement::WidgetComponent { name, version } => format!("{name} version {version}"),
            })
            .collect();
        if missing.is_empty() {
            self.incompatible_reason = None;
            return;
        }
        let reason = if incompatible.iter().any(|(_, source)| *source == RendererProfileMismatch::Packaged) {
            format!("This Player release does not support: {}.", missing.join(", "))
        } else {
            format!("This display engine does not support: {}.", missing.join(", "))
        };
        self.incompatible_reason = Some(reason.clone());
        let _ = self.port.show_unavailable(&reason);
    }

    fn refresh_snapshot(&self) {
        let link = self.link.as_ref();
        let ready = link.and_then(|link| link.ready.as_ref());
        let state = match (link, ready, self.native.is_safe_mode()) {
            (_, _, true) => "safe_mode",
            (None, _, _) => "disconnected",
            (Some(_), None, _) => "starting",
            (Some(_), Some(_), _) if self.incompatible_reason.is_some() => "incompatible",
            (Some(_), Some(_), _) if self.native.tracker().last_progress().is_some() => "healthy",
            _ => "waiting_for_progress",
        };
        *self.snapshot.lock().unwrap_or_else(|error| error.into_inner()) = RendererSnapshot {
            connected: link.is_some(),
            ready: ready.is_some(),
            state: state.to_owned(),
            generation: self.current.as_ref().map(|current| current.reference.generation),
            accepted: self.native.tracker().accepted_current(),
            evidence: self.native.has_activation_evidence(),
            playing: self
                .current
                .as_ref()
                .is_some_and(|current| current.activation.metadata().requires_content_evidence),
            safe_mode: self.native.is_safe_mode(),
            incompatible_reason: self.incompatible_reason.clone(),
            last_error: self.native.tracker().last_error().map(|code| code.as_str().to_owned()),
            current_item_id: self.native.tracker().current_item().map(|(id, _)| id),
            last_progress_at: self.native.tracker().last_progress(),
            last_activation_at: self.last_activation_at,
        };
    }
}

impl PresentationEngine {
    /// A WebView instance connected. Its generation becomes the live
    /// connection; the previous one, if any, is dead.
    pub fn renderer_connected(&mut self, generation: i64, now: Timestamp) {
        let connection = connection_for(generation);
        self.link = Some(RendererLink { connection, generation, ready: None });
        self.native.connected(connection, now);
        self.refresh_snapshot();
    }

    /// A WebView instance disconnected. Reports from its generation
    /// stop here from now on.
    pub fn renderer_disconnected(&mut self, generation: i64) {
        let matches = self.link.as_ref().is_some_and(|link| link.generation == generation);
        if matches {
            self.native.disconnected(connection_for(generation));
            self.link = None;
            self.refresh_snapshot();
        }
    }

    fn live_connection(&self, generation: i64) -> Option<uuid::Uuid> {
        self.link.as_ref().filter(|link| link.generation == generation).map(|link| link.connection)
    }

    /// The runtime page reported ready with its support. An unreadable
    /// report leaves the renderer unready; the current activation, if
    /// any, pushes once a readable report arrives.
    pub async fn renderer_ready(&mut self, generation: i64, report: &serde_json::Value) -> bool {
        let Some(connection) = self.live_connection(generation) else { return false };
        let Some(profile) = connected_profile(report) else { return false };
        if let Some(link) = self.link.as_mut().filter(|link| link.connection == connection) {
            link.ready = Some(profile.clone());
        }
        self.native.ready(connection, profile);
        self.push_current().await;
        self.refresh_snapshot();
        true
    }

    /// The page accepted an activation for the live connection.
    pub fn accepted(&mut self, generation: i64, activation_id: &str, activation_generation: u64) -> bool {
        let (Some(connection), Some(reference)) =
            (self.live_connection(generation), activation_ref(activation_id, activation_generation))
        else {
            return false;
        };
        self.native.accepted(connection, reference);
        self.manifest_wake.notify_one();
        self.refresh_snapshot();
        true
    }

    /// The page refused an activation, or an item failed, for the live
    /// connection. A first refusal also records the renderer's error.
    pub fn rejected(
        &mut self,
        generation: i64,
        activation_id: &str,
        activation_generation: u64,
        code: Option<&str>,
    ) -> bool {
        let (Some(connection), Some(reference)) =
            (self.live_connection(generation), activation_ref(activation_id, activation_generation))
        else {
            return false;
        };
        let first = self.native.rejected(connection, reference, code.and_then(|code| ShortToken::new(code).ok()));
        self.manifest_wake.notify_one();
        self.refresh_snapshot();
        first
    }

    /// One evidence report for the live connection. Returns whether the
    /// report was current and whether it was meaningful.
    #[allow(clippy::too_many_arguments)]
    pub fn progress(
        &mut self,
        generation: i64,
        activation_id: &str,
        activation_generation: u64,
        kind: &str,
        item_id: Option<&str>,
        zone_id: Option<&str>,
        now: Timestamp,
    ) -> (bool, bool) {
        let (Some(connection), Some(reference), Some(kind)) = (
            self.live_connection(generation),
            activation_ref(activation_id, activation_generation),
            evidence_kind(kind),
        ) else {
            return (false, false);
        };
        let report = SemanticRendererProgress {
            activation: reference,
            kind,
            item_id: item_id.and_then(|id| SafeText::new(id).ok()),
            zone_id: zone_id.and_then(|id| SafeText::new(id).ok()),
        };
        let decision = self.native.progress(connection, &report, now);
        if let Some(kind) = decision.activity_signal {
            self.signal(player_core::ActivitySignal::Renderer { kind, item_id: item_id.map(str::to_owned) });
        }
        if decision.meaningful {
            // A pending presentation may now promote; an item boundary
            // additionally lets it activate at the transition.
            if kind == ProgressEvidence::ItemTransition {
                self.item_boundary.store(true, Ordering::Relaxed);
            }
            self.manifest_wake.notify_one();
        }
        self.refresh_snapshot();
        (decision.current, decision.meaningful)
    }

    /// A playback error for the live connection. The first error for an
    /// activation also becomes an Activity playback-error signal.
    pub fn item_error(
        &mut self,
        generation: i64,
        activation_id: &str,
        activation_generation: u64,
        code: &str,
        item_id: Option<&str>,
        message: &str,
    ) -> bool {
        if !self.rejected(generation, activation_id, activation_generation, Some(code)) {
            return false;
        }
        self.signal(player_core::ActivitySignal::PlaybackError {
            item_id: item_id.map(str::to_owned),
            message: message.chars().take(240).collect(),
        });
        true
    }

    /// Periodic supervision. Returns the action taken, for logging/tests.
    pub async fn tick(&mut self, now: Timestamp) -> HealAction {
        let action = self.native.evaluate_recovery(now);
        self.execute_recovery(action, now).await
    }

    async fn execute_recovery(&mut self, action: HealAction, now: Timestamp) -> HealAction {
        match action {
            HealAction::None => {}
            HealAction::Reactivate => {
                if let Some(current) = self.current.clone() {
                    let mut request = current.request;
                    request.clock_offset_ms = self.clock_offset_ms;
                    let _ = self.activate_request(request, now).await;
                }
            }
            HealAction::ReloadRenderer | HealAction::RestartRenderer => {
                if action == HealAction::RestartRenderer {
                    self.restart_count += 1;
                }
                if self.link.as_ref().is_some_and(|link| link.ready.is_some()) {
                    let _ = self.native.dispatch_recovery(&self.port, action, uuid::Uuid::new_v4());
                }
            }
            HealAction::EnterSafeMode => {
                let reason = self.native.safe_mode_reason();
                let _ = self.port.show_safe_mode(reason.as_str());
            }
        }
        if action != HealAction::None
            && let Some(event) = self.native.recovery_event(action)
        {
            self.signal(player_core::ActivitySignal::Event(Box::new(event)));
        }
        self.refresh_snapshot();
        action
    }

    /// Withdraws the current activation and clears the renderer.
    pub fn clear(&mut self, reason: &str) {
        self.current = None;
        self.incompatible_reason = None;
        self.native.clear();
        let reason = ShortToken::new(reason).unwrap_or_else(|_| ShortToken::new("cleared").expect("literal"));
        let _ = self.port.clear(&reason);
        self.refresh_snapshot();
    }

    /// Leaves safe mode and restarts the ladder. Returns whether safe
    /// mode was active.
    pub fn clear_safe_mode(&mut self, now: Timestamp) -> bool {
        let was = self.native.clear_safe_mode(now);
        self.refresh_snapshot();
        was
    }

    /// Allows the next recovery rung at once and evaluates it.
    pub async fn retry_recovery(&mut self, now: Timestamp) -> HealAction {
        let action = self.native.retry_recovery(now);
        self.execute_recovery(action, now).await
    }

    /// Issues the current activation again under a new generation: the
    /// runtime starts the presentation from the beginning.
    pub async fn reload_current(&mut self, now: Timestamp) -> bool {
        let Some(current) = self.current.clone() else { return false };
        self.activate_request(current.request, now).await.is_ok()
    }

    /// Shows the screen's name over the presentation. Returns whether a
    /// ready renderer received the request.
    pub fn identify(&self, name: &str, duration_seconds: u32) -> bool {
        if !self.is_ready() {
            return false;
        }
        self.port
            .send_command(
                uuid::Uuid::new_v4(),
                &SemanticRendererCommand::Identify { name: SafeText::lossy(name), duration_seconds },
            )
            .is_ok()
    }

    /// Sends a playback command to a ready renderer. Returns whether it
    /// was delivered; the renderer's evidence, not this, shows its effect.
    pub fn renderer_command(&self, command: SemanticRendererCommand) -> bool {
        if !self.is_ready() {
            return false;
        }
        self.port.send_command(uuid::Uuid::new_v4(), &command).is_ok()
    }

    /// Asks the connected renderer to exit so the host recreates it; the
    /// current activation is restored when it reconnects.
    pub fn restart_renderer(&mut self, reason: &str) -> bool {
        if self.link.is_none() {
            return false;
        }
        let reason = ShortToken::new(reason).unwrap_or_else(|_| ShortToken::new("command").expect("literal"));
        let sent = self.port.request_restart(&reason, 5_000).is_ok();
        if sent {
            self.restart_count += 1;
        }
        sent
    }

    /// Asks the ready renderer for a capture. False without one.
    pub fn request_preview(&self, request_id: uuid::Uuid, max_width: u32, max_height: u32, max_bytes: u32) -> bool {
        if !self.is_ready() {
            return false;
        }
        self.port.request_capture(RendererCaptureRequest { request_id, max_width, max_height, max_bytes }).is_ok()
    }

    /// The capture state of the current activation, for the preview
    /// host's protection check.
    pub fn capture_state(&self) -> Option<CaptureState> {
        self.current.as_ref().map(|current| current.activation.metadata().capture_state)
    }

    /// Digests the current activation needs pinned.
    pub fn pinned_content(&self) -> std::collections::BTreeSet<Sha256Digest> {
        self.current
            .iter()
            .flat_map(|current| current.activation.content().iter().map(|object| object.sha256))
            .collect()
    }

    pub fn restart_count(&self) -> u64 {
        self.restart_count
    }

    pub fn is_safe_mode(&self) -> bool {
        self.native.is_safe_mode()
    }

    fn is_ready(&self) -> bool {
        self.link.as_ref().is_some_and(|link| link.ready.is_some())
    }

    /// Whether a renderer is connected and has reported ready.
    pub fn renderer_is_ready(&self) -> bool {
        self.is_ready()
    }
}

/// The Activity session signal for an issued activation. Fixtures are
/// not player activity; anything that is not a server-manifest playing
/// presentation stops the current session.
fn presented_signal(request: &ActivateRequest) -> Option<player_core::ActivityPresented> {
    use player_core::{ActivityItem, ActivityPresentationContext, ActivityPresented, activity_reason};
    match request.source {
        ActivationSource::Fixture => None,
        ActivationSource::SafeMode => {
            Some(ActivityPresented::Stopped { reason: activity_reason::RECOVERY_ACTION, failed: true })
        }
        ActivationSource::ServerManifest => {
            let presentation = request.envelope.get("presentation")?;
            if presentation.get("state").and_then(serde_json::Value::as_str)? != "playing" {
                return Some(ActivityPresented::Stopped {
                    reason: activity_reason::SCHEDULE_TRANSITION,
                    failed: false,
                });
            }
            let items: Vec<&serde_json::Value> =
                presentation.get("items").and_then(serde_json::Value::as_array).map(|items| items.iter().collect())?;
            if items.is_empty() {
                return Some(ActivityPresented::Stopped {
                    reason: activity_reason::SCHEDULE_TRANSITION,
                    failed: false,
                });
            }
            let identity = request.identity.as_ref()?;
            let presentation_id = identity
                .layout_id
                .or(identity.playlist_id)
                .map(|id| id.to_string())
                .or_else(|| items[0].get("id").and_then(serde_json::Value::as_str).map(str::to_owned))?;
            let source = identity.selection_source.clone();
            let replaced = if identity.takeover_id.is_some() {
                activity_reason::TAKEOVER
            } else if identity.schedule_id.is_some() {
                activity_reason::SCHEDULE_TRANSITION
            } else if source == "direct" {
                activity_reason::DIRECT_ASSIGNMENT_CHANGE
            } else {
                activity_reason::MANIFEST_REPLACEMENT
            };
            Some(ActivityPresented::Playing {
                context: ActivityPresentationContext {
                    key: format!("{source}:{presentation_id}:{}", identity.manifest_version),
                    presentation_type: if identity.layout_id.is_some() { "layout" } else { "playlist" }.into(),
                    presentation_id,
                    trigger: Some(source),
                    schedule_id: identity.schedule_id.map(|id| id.to_string()),
                    takeover_id: identity.takeover_id.map(|id| id.to_string()),
                    manifest_version: Some(identity.manifest_version),
                },
                replaced,
                items: items
                    .iter()
                    .map(|item| ActivityItem {
                        id: item.get("id").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned(),
                        kind: item.get("kind").and_then(serde_json::Value::as_str).unwrap_or_default().to_owned(),
                        duration_ms: item.get("durationMs").and_then(serde_json::Value::as_u64),
                    })
                    .collect(),
            })
        }
        _ => Some(ActivityPresented::Stopped { reason: activity_reason::SCHEDULE_TRANSITION, failed: false }),
    }
}

/// Maps the runtime bridge's kebab-case evidence onto Core's semantic
/// progress. The Android contract has no `frame-changed`; an unknown
/// kind is refused, never guessed.
pub fn evidence_kind(kind: &str) -> Option<ProgressEvidence> {
    match kind {
        "item-started" => Some(ProgressEvidence::ItemStarted),
        "item-transition" => Some(ProgressEvidence::ItemTransition),
        "video-progress" => Some(ProgressEvidence::VideoProgress),
        "image-shown" => Some(ProgressEvidence::ImageShown),
        "widget-shown" => Some(ProgressEvidence::WidgetShown),
        "widget-alive" => Some(ProgressEvidence::WidgetAlive),
        "widget-empty" => Some(ProgressEvidence::WidgetEmpty),
        "layout-shown" => Some(ProgressEvidence::LayoutShown),
        "layout-alive" => Some(ProgressEvidence::LayoutAlive),
        "layout-zone-rendered" => Some(ProgressEvidence::LayoutZoneRendered),
        "website-loaded" => Some(ProgressEvidence::WebsiteLoaded),
        "website-alive" => Some(ProgressEvidence::WebsiteAlive),
        "surface-shown" => Some(ProgressEvidence::SurfaceShown),
        _ => None,
    }
}

fn decode_capture(
    request: RendererCaptureRequest,
    jpeg_base64: Option<&str>,
    width: u32,
    height: u32,
) -> Result<CapturedFrame, CaptureError> {
    use base64::Engine as _;
    // Dimensions are checked before decoding, so a hostile answer
    // cannot make the host decode unbounded bytes.
    request.check_dimensions(width, height).map_err(|_| CaptureError::OutOfBounds)?;
    let encoded = jpeg_base64.ok_or(CaptureError::Invalid)?;
    if encoded.len() > 4 * 1024 * 1024 {
        return Err(CaptureError::Invalid);
    }
    let jpeg = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| CaptureError::Invalid)?;
    CapturedFrame::new(request, jpeg, width, height).map_err(|_| CaptureError::Invalid)
}

/// Completes a pending capture from the Kotlin answer envelope:
/// `{"requestId","jpegBase64","width","height"}` or
/// `{"requestId","unavailable","code"}`. Malformed answers and answers
/// for requests nobody waits for are dropped; false names that.
pub fn complete_capture(broker: &CaptureBroker, raw: &str) -> bool {
    if raw.is_empty() || raw.len() > 4 * 1024 * 1024 + 1024 {
        return false;
    }
    let answer: serde_json::Value = match serde_json::from_str(raw) {
        Ok(answer) => answer,
        Err(_) => return false,
    };
    let Some(id) =
        answer.get("requestId").and_then(serde_json::Value::as_str).and_then(|id| uuid::Uuid::parse_str(id).ok())
    else {
        return false;
    };
    if answer.get("unavailable").and_then(serde_json::Value::as_bool).is_some_and(|down| down) {
        broker.complete_with(id, |_| Err(CaptureError::RendererUnavailable));
        return true;
    }
    let jpeg = answer.get("jpegBase64").and_then(serde_json::Value::as_str).map(str::to_owned);
    let width = answer.get("width").and_then(serde_json::Value::as_u64).and_then(|width| u32::try_from(width).ok());
    let height = answer.get("height").and_then(serde_json::Value::as_u64).and_then(|height| u32::try_from(height).ok());
    let (Some(width), Some(height)) = (width, height) else { return false };
    broker.complete_with(id, move |request| decode_capture(request, jpeg.as_deref(), width, height));
    true
}

/// Android's [`player_core::PreviewHost`]: Core's periodic preview
/// policy with the WebView capture implementation behind it. The
/// engine lock is held only for the pre-checks; the capture itself
/// waits on the broker without it, so answers always get through.
pub struct AndroidPreviewHost {
    engine: Arc<tokio::sync::Mutex<PresentationEngine>>,
    broker: Arc<CaptureBroker>,
    health: Mutex<player_core::PreviewHealth>,
    clock: SharedClock,
    player_version: String,
}

impl std::fmt::Debug for AndroidPreviewHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("AndroidPreviewHost").finish_non_exhaustive()
    }
}

impl AndroidPreviewHost {
    pub fn new(
        engine: Arc<tokio::sync::Mutex<PresentationEngine>>,
        broker: Arc<CaptureBroker>,
        clock: SharedClock,
        player_version: String,
    ) -> Self {
        Self { engine, broker, health: Mutex::new(player_core::PreviewHealth::default()), clock, player_version }
    }
}

#[async_trait::async_trait]
impl player_core::PreviewHost for AndroidPreviewHost {
    async fn capture_preview(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<CapturedFrame, CaptureError> {
        let port = {
            let engine = self.engine.lock().await;
            engine.capture_state().ok_or(CaptureError::NothingShown)?.check(false)?;
            if !engine.renderer_is_ready() {
                return Err(CaptureError::RendererNotReady);
            }
            engine.port().clone()
        };
        self.broker
            .capture(uuid::Uuid::new_v4(), max_width, max_height, max_bytes, |request| async move {
                port.request_capture(request).map_err(|error| match error {
                    RendererPortError::NotReady => CaptureError::RendererNotReady,
                    RendererPortError::QueueUnavailable => CaptureError::RendererUnavailable,
                    _ => CaptureError::Invalid,
                })
            })
            .await
    }

    fn preview_health(&self) -> &Mutex<player_core::PreviewHealth> {
        &self.health
    }

    fn now(&self) -> Timestamp {
        self.clock.now()
    }

    fn player_version(&self) -> &str {
        &self.player_version
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_cas::{IngestMeta, LruByDomain, StorePolicy};
    use player_core::PreviewHost as _;
    use player_state::repo::cas::{Domain, SourceKind};
    use player_state::{OpenOptions, StateDb};

    const ASSET: &str = "11111111-1111-1111-1111-111111111111";
    const VARIANT: &str = "22222222-2222-2222-2222-222222222222";
    const BASE_MS: i64 = 1_700_000_000_000;

    fn now(ms: i64) -> Timestamp {
        Timestamp::from_unix_millis(ms).expect("time")
    }

    fn meta() -> IngestMeta {
        IngestMeta { domain: Domain::Media, content_type: None, source: SourceKind::Local }
    }

    struct Scratch {
        engine: PresentationEngine,
        platform: Arc<MemRendererPlatform>,
        snapshot: Arc<Mutex<RendererSnapshot>>,
        activity_rx: tokio::sync::mpsc::Receiver<player_core::ActivitySignal>,
        _dir: tempfile::TempDir,
    }

    async fn scratch() -> Scratch {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path()).expect("scratch dir");
        let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).expect("state");
        let clock: SharedClock = Arc::new(crate::host::SystemClock);
        let store = ContentStore::open(
            dir.path().join("cas"),
            dir.path().join("partial"),
            db,
            clock.clone(),
            Arc::new(crate::host::StatvfsProbe),
            Arc::new(crate::host::AndroidSecureOpener),
            StorePolicy { limit_bytes: 8 * 1024 * 1024, reserved_free_bytes: 0 },
            Arc::new(LruByDomain),
        )
        .await
        .expect("store open");
        let platform = Arc::new(MemRendererPlatform::default());
        let snapshot = Arc::new(Mutex::new(RendererSnapshot::default()));
        let mut engine = PresentationEngine::new(
            AndroidRendererPort::new(platform.clone(), store.clone()),
            clock,
            snapshot.clone(),
            Arc::new(Notify::new()),
            Arc::new(AtomicBool::new(false)),
            now(BASE_MS),
        );
        let (activity, activity_rx) = player_core::ActivityHandle::channel();
        engine.set_activity(activity);
        Scratch { engine, platform, snapshot, activity_rx, _dir: dir }
    }

    async fn seed(store: &ContentStore, bytes: &[u8]) -> Sha256Digest {
        let digest = Sha256Digest::of(bytes);
        let mut session = store.begin_write(digest, bytes.len() as u64, meta()).await.expect("begin").expect("fresh");
        session.write(bytes).expect("write");
        session.commit().await.expect("commit");
        digest
    }

    fn playing_request(digest: &Sha256Digest, size: u64, kind: &str) -> String {
        let src = ["tcmedia:", ASSET, "/", VARIANT].concat();
        serde_json::json!({
            "envelope": {
                "presentation": {
                    "state": "playing",
                    "items": [{"id": "item-1", "kind": kind, "src": src}],
                },
            },
            "content": [{
                "assetId": ASSET,
                "variantId": VARIANT,
                "digest": digest.to_hex(),
                "sizeBytes": size,
                "mimeType": "image/png",
            }],
            "source": "server_manifest",
            "identity": {
                "manifest": Sha256Digest::of(b"manifest").to_hex(),
                "manifestVersion": 7,
                "selectionSource": "schedule",
                "playlistId": "33333333-3333-3333-3333-333333333333",
                "scheduleId": "44444444-4444-4444-4444-444444444444",
            },
            "clockOffsetMs": 1500,
        })
        .to_string()
    }

    fn ready_report(features: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "features": features,
            "support": {
                "presentationSchemas": [1, 2],
                "declarativeCapabilities": {"content.text": 1},
                "widgetComponents": {},
            },
        })
    }

    #[tokio::test]
    async fn advertised_support_tracks_the_live_ready_report() {
        let mut test = scratch().await;
        // Before any renderer proves itself there is nothing to advertise.
        assert!(test.engine.advertised_support().is_none());
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let advertised = test.engine.advertised_support().expect("profile");
        assert_eq!(advertised.presentation_schemas(), vec![1, 2]);
        assert_eq!(advertised.declarative_capabilities(), vec![("content.text".to_owned(), 1)]);
        assert!(advertised.widget_components().is_empty());
        // A newer ready report replaces the advertisement.
        let proved = serde_json::json!({
            "features": FULL_FEATURES,
            "support": {
                "presentationSchemas": [1, 2],
                "declarativeCapabilities": {"content.text": 1},
                "widgetComponents": {"widget.tilecast.clock": 2},
            },
        });
        assert!(test.engine.renderer_ready(1, &proved).await);
        let advertised = test.engine.advertised_support().expect("profile");
        assert_eq!(advertised.widget_components(), vec![("widget.tilecast.clock".to_owned(), 2)]);
    }

    #[tokio::test]
    async fn unsupported_runtime_advertises_an_empty_profile() {
        let mut test = scratch().await;
        test.engine.renderer_unsupported();
        let advertised = test.engine.advertised_support().expect("profile");
        assert!(advertised.presentation_schemas().is_empty());
        assert!(advertised.declarative_capabilities().is_empty());
        assert!(advertised.widget_components().is_empty());
    }

    const FULL_FEATURES: &[&str] = &[
        "status-surfaces-v1",
        "image",
        "video",
        "render-tree-v1",
        "layout-v1",
        "synchronized-playback-v1",
        "span-viewport-v1",
        "plugin.countdown_bar",
        "plugin.alert_ticker",
        "remote-web-v1",
        "website",
        "youtube",
    ];

    #[test]
    fn media_uris_parse_like_the_kotlin_authorizer() {
        let asset = uuid::Uuid::parse_str(ASSET).expect("uuid");
        let variant = uuid::Uuid::parse_str(VARIANT).expect("uuid");
        assert_eq!(parse_media_uri(&format!("tcmedia:{ASSET}/{VARIANT}")), Some((asset, variant)));
        assert_eq!(parse_media_uri(&format!("tcmedia://variant/{ASSET}/{VARIANT}")), Some((asset, variant)));
        assert_eq!(parse_media_uri(&format!("TCMEDIA:{ASSET}/{VARIANT}")), Some((asset, variant)));
        assert_eq!(parse_media_uri("tcmedia:only-one"), None);
        assert_eq!(parse_media_uri("tcmedia:a/b/c"), None);
        assert_eq!(parse_media_uri("tcmedia:../x"), None);
        assert_eq!(parse_media_uri("tcmedia:a/b?x=1"), None);
        assert_eq!(parse_media_uri("file:///etc/passwd"), None);
        assert_eq!(parse_media_uri("tcmedia:not-a-uuid/also-not"), None);
        assert_eq!(evidence_kind("frame-changed"), None);
        assert_eq!(evidence_kind("bogus"), None);
    }

    #[tokio::test]
    async fn activate_dispatches_resolved_documents_with_verified_grants() {
        let mut test = scratch().await;
        let bytes = b"fake-image-bytes";
        let digest = seed(&test.engine.port.cas, bytes).await;
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let outcome = test
            .engine
            .activate(&playing_request(&digest, bytes.len() as u64, "image"), now(BASE_MS))
            .await
            .expect("activate");
        assert_eq!(outcome.generation, 1);
        assert!(outcome.queued);
        let requests = test.platform.requests();
        assert_eq!(requests.len(), 1);
        let envelope: serde_json::Value = serde_json::from_str(&requests[0]).expect("parses");
        assert_eq!(envelope["op"], "activate");
        assert_eq!(envelope["activationId"], outcome.activation_id);
        assert_eq!(envelope["presentation"]["items"][0]["src"], format!("tcmedia:{ASSET}/{VARIANT}"));
        assert_eq!(envelope["content"][0]["digest"], digest.to_hex());
        assert_eq!(envelope["content"][0]["sizeBytes"], bytes.len() as u64);
        let path = envelope["content"][0]["path"].as_str().expect("str");
        assert_eq!(std::fs::read(path).expect("read"), bytes);
        let snapshot = test.snapshot.lock().expect("lock").clone();
        assert!(snapshot.connected && snapshot.ready);
        assert_eq!(snapshot.state, "waiting_for_progress");
        assert_eq!(snapshot.generation, Some(1));
        // The server-manifest playing activation opens an Activity session.
        match test.activity_rx.try_recv() {
            Ok(player_core::ActivitySignal::Presented(player_core::ActivityPresented::Playing { context, .. })) => {
                assert_eq!(context.key, "schedule:33333333-3333-3333-3333-333333333333:7");
                assert_eq!(context.presentation_type, "playlist");
            }
            other => panic!("expected Presented::Playing, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn activate_grants_frames_with_a_widget_table() {
        let mut test = scratch().await;
        let bytes = b"fake-image-bytes";
        let digest = seed(&test.engine.port.cas, bytes).await;
        let frame_bytes = b"<frame/>";
        let frame = seed(&test.engine.port.cas, frame_bytes).await;
        let package = Sha256Digest::of(b"package");
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let mut request: serde_json::Value =
            serde_json::from_str(&playing_request(&digest, bytes.len() as u64, "image")).expect("parses");
        request["frames"] = serde_json::json!([{
            "packageId": "acme.athletics",
            "packageDigest": package.to_hex(),
            "frameDigest": frame.to_hex(),
            "sizeBytes": frame_bytes.len(),
        }]);
        request["envelope"]["projection"] = serde_json::json!({"schema": 19});
        test.engine.activate(&request.to_string(), now(BASE_MS)).await.expect("activate");
        let requests = test.platform.requests();
        assert_eq!(requests.len(), 1);
        let envelope: serde_json::Value = serde_json::from_str(&requests[0]).expect("parses");
        assert_eq!(envelope["frames"][0]["frameDigest"], frame.to_hex());
        assert_eq!(envelope["frames"][0]["packageId"], "acme.athletics");
        assert_eq!(envelope["frames"][0]["packageDigest"], package.to_hex());
        let uri = envelope["frames"][0]["uri"].as_str().expect("str");
        let token = uri.strip_prefix("tcwidget://cap/").expect("opaque capability");
        assert_eq!(token.len(), 64);
        assert_ne!(token, frame.to_hex());
        let path = envelope["frames"][0]["path"].as_str().expect("str");
        assert_eq!(std::fs::read(path).expect("read"), frame_bytes);
        let table = envelope["projection"]["widgetFrames"].as_array().expect("table");
        assert_eq!(table.len(), 1);
        assert_eq!(table[0]["frameDigest"], frame.to_hex());
        assert_eq!(table[0]["uri"], uri);
        assert!(table[0].get("path").is_none());
    }

    #[tokio::test]
    async fn dual_claimed_media_and_frame_digests_fail_activation() {
        let mut test = scratch().await;
        let bytes = b"fake-image-bytes";
        let digest = seed(&test.engine.port.cas, bytes).await;
        let package = Sha256Digest::of(b"package");
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let mut request: serde_json::Value =
            serde_json::from_str(&playing_request(&digest, bytes.len() as u64, "image")).expect("parses");
        // The same digest rides both the media grant list and the frame
        // claims: no grant may serve one object's bytes twice.
        request["frames"] = serde_json::json!([{
            "packageId": "acme.athletics",
            "packageDigest": package.to_hex(),
            "frameDigest": digest.to_hex(),
            "sizeBytes": bytes.len(),
        }]);
        request["envelope"]["projection"] = serde_json::json!({"schema": 19});
        assert!(test.engine.activate(&request.to_string(), now(BASE_MS)).await.is_err());
        assert!(test.platform.requests().is_empty());
    }

    #[tokio::test]
    async fn downgrade_to_a_frameless_manifest_empties_the_table() {
        let mut test = scratch().await;
        let bytes = b"fake-image-bytes";
        let digest = seed(&test.engine.port.cas, bytes).await;
        let frame = seed(&test.engine.port.cas, b"<frame/>").await;
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let mut framed: serde_json::Value =
            serde_json::from_str(&playing_request(&digest, bytes.len() as u64, "image")).expect("parses");
        framed["frames"] = serde_json::json!([{
            "packageId": "acme.athletics",
            "packageDigest": Sha256Digest::of(b"package").to_hex(),
            "frameDigest": frame.to_hex(),
            "sizeBytes": 8,
        }]);
        framed["envelope"]["projection"] = serde_json::json!({"schema": 19});
        test.engine.activate(&framed.to_string(), now(BASE_MS)).await.expect("activate");
        // The next revision carries no frames: the table empties and the
        // old frame URIs stop resolving with their drained generation.
        test.engine
            .activate(&playing_request(&digest, bytes.len() as u64, "image"), now(BASE_MS + 1))
            .await
            .expect("activate");
        let requests = test.platform.requests();
        assert_eq!(requests.len(), 2);
        let envelope: serde_json::Value = serde_json::from_str(&requests[1]).expect("parses");
        assert_eq!(envelope["generation"], 2);
        assert_eq!(envelope["frames"], serde_json::json!([]));
        assert!(envelope["projection"].is_null());
    }

    #[test]
    fn frame_claims_parse_strictly_and_default_to_none() {
        let minimal = serde_json::json!({
            "envelope": {"presentation": {"state": "playing", "items": []}},
            "content": [],
            "source": "server_manifest",
        });
        let parsed = parse_activate_request(&minimal.to_string()).expect("parses");
        assert!(parsed.frames.is_empty());
        for bad in [
            serde_json::json!("nope"),
            serde_json::json!([{"packageId": "acme.athletics"}]),
            serde_json::json!([{
                "packageId": "acme.athletics",
                "packageDigest": "x",
                "frameDigest": Sha256Digest::of(b"frame").to_hex(),
                "sizeBytes": 1,
            }]),
        ] {
            let mut request = minimal.clone();
            request["frames"] = bad;
            assert!(matches!(parse_activate_request(&request.to_string()), Err(ActivateError::Malformed)));
        }
    }

    #[tokio::test]
    async fn activate_forwards_plugin_surfaces_beside_the_presentation() {
        let mut test = scratch().await;
        let bytes = b"fake-image-bytes";
        let digest = seed(&test.engine.port.cas, bytes).await;
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let mut request: serde_json::Value =
            serde_json::from_str(&playing_request(&digest, bytes.len() as u64, "image")).expect("parses");
        request["envelope"]["plugins"] =
            serde_json::json!([{"id": "p1", "type": "countdown_bar", "version": 1, "config": {}}]);
        request["envelope"]["pluginAliases"] = serde_json::json!([]);
        test.engine.activate(&request.to_string(), now(BASE_MS)).await.expect("activate");
        let requests = test.platform.requests();
        assert_eq!(requests.len(), 1);
        let envelope: serde_json::Value = serde_json::from_str(&requests[0]).expect("parses");
        assert_eq!(envelope["plugins"][0]["type"], "countdown_bar");
        assert_eq!(envelope["pluginAliases"], serde_json::json!([]));
        assert_eq!(envelope["clockOffsetMs"], 1500);
    }

    #[tokio::test]
    async fn unknown_media_refuses_before_core_sees_anything() {
        let mut test = scratch().await;
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let mut request: serde_json::Value =
            serde_json::from_str(&playing_request(&Sha256Digest::of(b"listed"), 8, "image")).expect("parses");
        request["envelope"]["presentation"]["items"][0]["src"] =
            serde_json::json!("tcmedia:55555555-5555-5555-5555-555555555555/66666666-6666-6666-6666-666666666666");
        assert_eq!(test.engine.activate(&request.to_string(), now(BASE_MS)).await, Err(ActivateError::UnknownMedia));
        assert!(test.platform.requests().is_empty());
        assert_eq!(test.snapshot.lock().expect("lock").generation, None);
        assert!(test.activity_rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn unverified_content_refuses_and_leaves_no_activation_for_the_ladder() {
        let mut test = scratch().await;
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let digest = Sha256Digest::of(b"never-seeded");
        assert_eq!(
            test.engine.activate(&playing_request(&digest, 12, "image"), now(BASE_MS)).await,
            Err(ActivateError::Unverified)
        );
        assert!(test.platform.requests().is_empty());
        // The withdrawn activation must not feed the recovery ladder.
        assert_eq!(test.engine.tick(now(BASE_MS + 3_600_000)).await, HealAction::None);
        let bytes = b"now-seeded";
        let digest = seed(&test.engine.port.cas, bytes).await;
        let outcome = test
            .engine
            .activate(&playing_request(&digest, bytes.len() as u64, "image"), now(BASE_MS))
            .await
            .expect("activate");
        assert!(outcome.queued);
    }

    #[tokio::test]
    async fn incompatible_content_shows_unavailable_with_the_reason() {
        let mut test = scratch().await;
        let bytes = b"fake-video-bytes";
        let digest = seed(&test.engine.port.cas, bytes).await;
        test.engine.renderer_connected(1, now(BASE_MS));
        // The packaged release supports video; this connected engine
        // does not advertise it.
        let connected: Vec<&str> = FULL_FEATURES.iter().copied().filter(|feature| *feature != "video").collect();
        assert!(test.engine.renderer_ready(1, &ready_report(&connected)).await);
        let outcome = test
            .engine
            .activate(&playing_request(&digest, bytes.len() as u64, "video"), now(BASE_MS))
            .await
            .expect("activate");
        assert!(!outcome.queued);
        let reason = outcome.incompatible_reason.expect("reason");
        assert!(reason.contains("video"), "{reason}");
        assert!(reason.contains("display engine"), "{reason}");
        let requests = test.platform.requests();
        assert_eq!(requests.len(), 1);
        let envelope: serde_json::Value = serde_json::from_str(&requests[0]).expect("parses");
        assert_eq!(envelope["op"], "show_unavailable");
        assert_eq!(envelope["reason"], reason);
        assert_eq!(test.snapshot.lock().expect("lock").state, "incompatible");
    }

    #[tokio::test]
    async fn stale_generations_cannot_report_and_reconnects_restore_current() {
        let mut test = scratch().await;
        let bytes = b"stale-image";
        let digest = seed(&test.engine.port.cas, bytes).await;
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let outcome = test
            .engine
            .activate(&playing_request(&digest, bytes.len() as u64, "image"), now(BASE_MS))
            .await
            .expect("activate");
        assert_eq!(test.platform.requests().len(), 1);
        // The renderer dies and a fresh WebView connects as generation 2.
        test.engine.renderer_disconnected(1);
        test.engine.renderer_connected(2, now(BASE_MS + 1_000));
        assert!(!test.engine.accepted(1, &outcome.activation_id, outcome.generation));
        assert_eq!(
            test.engine.progress(
                1,
                &outcome.activation_id,
                outcome.generation,
                "image-shown",
                Some("item-1"),
                None,
                now(BASE_MS)
            ),
            (false, false)
        );
        assert!(!test.engine.rejected(1, &outcome.activation_id, outcome.generation, Some("boom")));
        assert!(!test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        // The new renderer receives the current activation again.
        assert!(test.engine.renderer_ready(2, &ready_report(FULL_FEATURES)).await);
        let requests = test.platform.requests();
        assert_eq!(requests.len(), 2);
        let envelope: serde_json::Value = serde_json::from_str(&requests[1]).expect("parses");
        assert_eq!(envelope["op"], "activate");
        assert_eq!(envelope["activationId"], outcome.activation_id);
        assert_eq!(envelope["generation"], 1);
    }

    #[tokio::test]
    async fn evidence_feeds_activity_and_promotes_the_snapshot() {
        let mut test = scratch().await;
        let bytes = b"evidence-image";
        let digest = seed(&test.engine.port.cas, bytes).await;
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let outcome = test
            .engine
            .activate(&playing_request(&digest, bytes.len() as u64, "image"), now(BASE_MS))
            .await
            .expect("activate");
        assert!(test.engine.accepted(1, &outcome.activation_id, outcome.generation));
        assert!(test.snapshot.lock().expect("lock").accepted);
        let _ = test.activity_rx.try_recv().expect("presented");
        let (current, meaningful) = test.engine.progress(
            1,
            &outcome.activation_id,
            outcome.generation,
            "item-started",
            Some("item-1"),
            None,
            now(BASE_MS + 1_000),
        );
        assert!(current && meaningful);
        match test.activity_rx.try_recv() {
            Ok(player_core::ActivitySignal::Renderer { item_id, .. }) => assert_eq!(item_id.as_deref(), Some("item-1")),
            other => panic!("expected Renderer signal, got {other:?}"),
        }
        let (current, meaningful) = test.engine.progress(
            1,
            &outcome.activation_id,
            outcome.generation,
            "image-shown",
            Some("item-1"),
            None,
            now(BASE_MS + 2_000),
        );
        assert!(current && meaningful);
        let snapshot = test.snapshot.lock().expect("lock").clone();
        assert!(snapshot.evidence);
        assert_eq!(snapshot.state, "healthy");
        assert_eq!(snapshot.current_item_id.as_deref(), Some("item-1"));
        // The first item error becomes a playback-error signal; repeats do not.
        assert!(test.engine.item_error(
            1,
            &outcome.activation_id,
            outcome.generation,
            "decode_failed",
            Some("item-1"),
            "broken bytes"
        ));
        match test.activity_rx.try_recv() {
            Ok(player_core::ActivitySignal::PlaybackError { message, .. }) => assert_eq!(message, "broken bytes"),
            other => panic!("expected PlaybackError, got {other:?}"),
        }
        // Every error for the live activation reports, as on Edge.
        assert!(test.engine.item_error(
            1,
            &outcome.activation_id,
            outcome.generation,
            "decode_failed",
            Some("item-1"),
            "again"
        ));
        match test.activity_rx.try_recv() {
            Ok(player_core::ActivitySignal::PlaybackError { message, .. }) => assert_eq!(message, "again"),
            other => panic!("expected PlaybackError, got {other:?}"),
        }
        assert_eq!(test.snapshot.lock().expect("lock").last_error.as_deref(), Some("decode_failed"));
    }

    #[tokio::test]
    async fn recovery_reactivates_then_escalates_through_reload_and_restart() {
        let mut test = scratch().await;
        let bytes = b"recovery-image";
        let digest = seed(&test.engine.port.cas, bytes).await;
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        test.engine
            .activate(&playing_request(&digest, bytes.len() as u64, "image"), now(BASE_MS))
            .await
            .expect("activate");
        let _ = test.activity_rx.try_recv().expect("presented");
        // The default ladder rungs, pinned by Core's own coordinator
        // test: reactivate after 180 idle seconds, reload 180 later,
        // restart 90 after that.
        assert_eq!(test.engine.tick(now(BASE_MS + 179_999)).await, HealAction::None);
        assert_eq!(test.engine.tick(now(BASE_MS + 180_000)).await, HealAction::Reactivate);
        let requests = test.platform.requests();
        assert_eq!(requests.len(), 2);
        let envelope: serde_json::Value = serde_json::from_str(&requests[1]).expect("parses");
        assert_eq!(envelope["op"], "activate");
        assert_eq!(envelope["generation"], 2);
        let _ = test.activity_rx.try_recv().expect("re-presented");
        assert_eq!(test.engine.tick(now(BASE_MS + 359_999)).await, HealAction::None);
        assert_eq!(test.engine.tick(now(BASE_MS + 360_000)).await, HealAction::ReloadRenderer);
        let requests = test.platform.requests();
        let envelope: serde_json::Value = serde_json::from_str(&requests[2]).expect("parses");
        assert_eq!(envelope["command"], "reload");
        assert_eq!(test.engine.tick(now(BASE_MS + 449_999)).await, HealAction::None);
        assert_eq!(test.engine.tick(now(BASE_MS + 450_000)).await, HealAction::RestartRenderer);
        let requests = test.platform.requests();
        let envelope: serde_json::Value = serde_json::from_str(&requests[3]).expect("parses");
        assert_eq!(envelope["op"], "restart");
        assert_eq!(test.engine.restart_count(), 1);
        match test.activity_rx.try_recv() {
            Ok(player_core::ActivitySignal::Event(event)) => assert_eq!(event.event_type, "self_heal.attempted"),
            other => panic!("expected recovery event, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn capture_answers_decode_behind_the_broker() {
        use base64::Engine as _;
        let broker = Arc::new(CaptureBroker::default());
        assert!(!complete_capture(&broker, "not json"));
        assert!(!complete_capture(&broker, &serde_json::json!({"width": 1, "height": 1}).to_string()));
        // An unavailable renderer resolves without decoding.
        let (down_tx, down_rx) = tokio::sync::oneshot::channel();
        let waiting = Arc::clone(&broker);
        let down = tokio::spawn(async move {
            waiting
                .capture(uuid::Uuid::new_v4(), 640, 360, 64, |request| async move {
                    down_tx.send(request.request_id).expect("send");
                    Ok(())
                })
                .await
        });
        let down_id = down_rx.await.expect("recv");
        assert!(complete_capture(
            &broker,
            &serde_json::json!({"requestId": down_id.to_string(), "unavailable": true, "code": "blank"}).to_string(),
        ));
        assert_eq!(down.await.expect("join"), Err(CaptureError::RendererUnavailable));
        // A captured frame decodes behind the broker.
        let (id_tx, id_rx) = tokio::sync::oneshot::channel();
        let waiting = Arc::clone(&broker);
        let pending = tokio::spawn(async move {
            waiting
                .capture(uuid::Uuid::new_v4(), 640, 360, 1024, |request| async move {
                    id_tx.send(request.request_id).expect("send");
                    Ok(())
                })
                .await
        });
        let id = id_rx.await.expect("recv");
        let jpeg = vec![0xff, 0xd8, 0xff, 0xd9];
        assert!(complete_capture(
            &broker,
            &serde_json::json!({
                "requestId": id.to_string(),
                "jpegBase64": base64::engine::general_purpose::STANDARD.encode(&jpeg),
                "width": 640,
                "height": 360,
            })
            .to_string(),
        ));
        let frame = pending.await.expect("join").expect("frame");
        assert_eq!(frame.dimensions(), (640, 360));
        assert_eq!(frame.into_jpeg(), jpeg);
        // Dimensions are checked before the bytes are touched.
        let request =
            RendererCaptureRequest { request_id: uuid::Uuid::nil(), max_width: 640, max_height: 360, max_bytes: 4 };
        assert_eq!(decode_capture(request, Some("!!!not-base64!!!"), 641, 360), Err(CaptureError::OutOfBounds));
        assert_eq!(decode_capture(request, Some("!!!not-base64!!!"), 640, 360), Err(CaptureError::Invalid));
        assert_eq!(decode_capture(request, None, 640, 360), Err(CaptureError::Invalid));
    }

    #[tokio::test]
    async fn preview_host_refuses_empty_and_protected_presentations() {
        let test = scratch().await;
        let engine = Arc::new(tokio::sync::Mutex::new(PresentationEngine::new(
            test.engine.port.clone(),
            test.engine.clock.clone(),
            test.snapshot.clone(),
            Arc::new(Notify::new()),
            Arc::new(AtomicBool::new(false)),
            now(BASE_MS),
        )));
        let broker = Arc::new(CaptureBroker::default());
        let preview = AndroidPreviewHost::new(engine.clone(), broker, test.engine.clock.clone(), "0.0.0-test".into());
        assert_eq!(preview.capture_preview(640, 360, 1024).await, Err(CaptureError::NothingShown));
        let mut locked = engine.lock().await;
        locked.renderer_connected(1, now(BASE_MS));
        assert!(locked.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        let pairing = serde_json::json!({
            "envelope": {"presentation": {"state": "pairing", "code": "ABCDEF"}},
            "content": [],
            "source": "status_surface",
            "clockOffsetMs": 0,
        })
        .to_string();
        locked.activate(&pairing, now(BASE_MS)).await.expect("pairing");
        drop(locked);
        assert_eq!(preview.capture_preview(640, 360, 1024).await, Err(CaptureError::ProtectedState));
    }

    #[tokio::test]
    async fn engine_controls_reach_only_a_ready_renderer() {
        let mut test = scratch().await;
        let bytes = b"controls-image";
        let digest = seed(&test.engine.port.cas, bytes).await;
        assert!(!test.engine.identify("Lobby", 5));
        assert!(!test.engine.renderer_command(SemanticRendererCommand::SkipItem));
        assert!(!test.engine.restart_renderer("command"));
        assert!(!test.engine.request_preview(uuid::Uuid::new_v4(), 320, 180, 1024));
        assert!(!test.engine.reload_current(now(BASE_MS)).await);
        test.engine.renderer_connected(1, now(BASE_MS));
        assert!(test.engine.renderer_ready(1, &ready_report(FULL_FEATURES)).await);
        // Identify is readiness-gated like Edge: no activation needed.
        assert!(test.engine.identify("Lobby", 5));
        test.engine
            .activate(&playing_request(&digest, bytes.len() as u64, "image"), now(BASE_MS))
            .await
            .expect("activate");
        assert!(test.engine.identify("Lobby", 5));
        assert!(test.engine.renderer_command(SemanticRendererCommand::SkipItem));
        assert!(test.engine.restart_renderer("command"));
        assert_eq!(test.engine.restart_count(), 1);
        assert!(test.engine.request_preview(uuid::Uuid::new_v4(), 320, 180, 1024));
        let requests = test.platform.requests();
        let commands: Vec<serde_json::Value> =
            requests.iter().map(|request| serde_json::from_str(request).expect("parses")).collect();
        assert_eq!(commands[0]["command"], "identify");
        assert_eq!(commands[1]["op"], "activate");
        assert_eq!(commands[2]["command"], "identify");
        assert_eq!(commands[2]["name"], "Lobby");
        assert_eq!(commands[3]["command"], "skip_item");
        assert_eq!(commands[4]["op"], "restart");
        assert_eq!(commands[5]["op"], "capture");
        assert_eq!(commands[5]["maxWidth"], 320);
        assert!(test.engine.reload_current(now(BASE_MS)).await);
        assert_eq!(test.platform.requests().len(), 7);
        assert!(!test.engine.clear_safe_mode(now(BASE_MS)));
        test.engine.clear("test done");
        assert_eq!(test.snapshot.lock().expect("lock").generation, None);
        let requests = test.platform.requests();
        let envelope: serde_json::Value = serde_json::from_str(requests.last().expect("last request")).expect("parses");
        assert_eq!(envelope["op"], "clear");
    }

    #[tokio::test]
    async fn presented_signals_follow_the_activation_source() {
        let mut test = scratch().await;
        let fixture = serde_json::json!({
            "envelope": {"presentation": {"state": "playing", "items": []}},
            "content": [],
            "source": "fixture",
            "clockOffsetMs": 0,
        })
        .to_string();
        test.engine.activate(&fixture, now(BASE_MS)).await.expect("fixture");
        assert!(test.activity_rx.try_recv().is_err(), "fixtures are not activity");
        let safe_mode = serde_json::json!({
            "envelope": {"presentation": {"state": "safe-mode", "reason": "ladder gave up"}},
            "content": [],
            "source": "safe_mode",
            "clockOffsetMs": 0,
        })
        .to_string();
        test.engine.activate(&safe_mode, now(BASE_MS)).await.expect("safe mode");
        match test.activity_rx.try_recv() {
            Ok(player_core::ActivitySignal::Presented(player_core::ActivityPresented::Stopped { reason, failed })) => {
                assert_eq!(reason, player_core::activity_reason::RECOVERY_ACTION);
                assert!(failed);
            }
            other => panic!("expected Stopped failed, got {other:?}"),
        }
    }
}
