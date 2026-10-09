//! Windows transport and generation-bound resource encoding for the
//! semantic port. The packaged profile is compiled into the player release
//! with the runtime it ships with; the Runtime's `ready` support may refine
//! it but never extends it.

use player_core::{
    Expectation, RendererActivation, RendererCaptureRequest, RendererMetadata, RendererPort, RendererPortError,
    RendererRequirement, RuntimePayload, SemanticRendererCommand, VerifiedContentRef, VerifiedFrameRef,
};
use player_types::bounded::{SafeText, ShortToken};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::media::{MediaCapability, MediaRegistry};

pub mod profile {
    /// Renderer features the trusted runtime implements on Windows,
    /// including remote web in isolated host-layer child views.
    pub const FEATURES: &[&str] = &[
        "status-surfaces-v1",
        "image",
        "video",
        "render-tree-v1",
        "layout-v1",
        "synchronized-playback-v1",
        "span-viewport-v1",
        "plugin.brand_bug",
        "plugin.countdown_bar",
        "plugin.alert_ticker",
        "remote-web-v1",
        "website",
        "youtube",
    ];

    /// Declarative widget capabilities of the reference projection code the
    /// trusted runtime runs (the same versions the other native hosts
    /// report, because it is the same code).
    pub const NATIVE_CAPABILITIES: &[(&str, u32)] =
        crate::presentation_capabilities::SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES;

    /// The `web.remote` declarative capability: remote web in isolated
    /// host-layer child views, shown through the renderer's remote web
    /// surface.
    pub const WEB_RUNTIME_VERSION: u32 = 1;

    /// Presentation schemas the runtime renders: 1 (declarative and web),
    /// 2 (first-class Widget components), and 3 (component empty policy).
    pub const PRESENTATION_SCHEMAS: &[u32] = &[1, 2, crate::widget_capabilities::COMPONENT_PRESENTATION_SCHEMA];
}

pub(crate) fn packaged_profile() -> player_core::PackagedRendererProfile {
    let token = |name| ShortToken::new(name).expect("generated capability name");
    player_core::PackagedRendererProfile(
        player_core::RendererSupport::new(
            profile::FEATURES.iter().map(|name| token(*name)).collect(),
            profile::PRESENTATION_SCHEMAS.iter().copied().collect(),
            profile::NATIVE_CAPABILITIES
                .iter()
                .map(|(name, version)| (token(*name), *version))
                .chain(std::iter::once((token("web.remote"), profile::WEB_RUNTIME_VERSION)))
                .collect(),
            crate::widget_capabilities::WIDGET_COMPONENTS
                .iter()
                .map(|(name, version)| (token(*name), *version))
                // The frame execution ABI is one capability for every
                // downloaded Widget, not a discovered component: this
                // release confines served frames, so it offers it.
                .chain(std::iter::once((
                    token(player_types::frames::EXTERNAL_RUNTIME_CAPABILITY),
                    player_types::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
                )))
                .collect(),
        )
        .expect("bounded installed runtime profile"),
    )
}

pub(crate) fn connected_profile(
    ready: &crate::bridge::RuntimeReady,
) -> Result<player_core::ConnectedRendererProfile, player_core::RendererProfileError> {
    let support = ready.support.as_ref();
    Ok(player_core::ConnectedRendererProfile(player_core::RendererSupport::new(
        // The Runtime advertises its live support namespaces; the feature
        // set is the packaged one, refined by what the Runtime implements.
        profile::FEATURES.iter().map(|name| ShortToken::new(*name).expect("profile feature")).collect(),
        support.map(|s| s.presentation_schemas.iter().copied().collect()).unwrap_or_default(),
        support
            .map(|s| {
                s.declarative
                    .iter()
                    .filter_map(|(name, version)| ShortToken::new(name).ok().map(|name| (name, *version)))
                    .collect()
            })
            .unwrap_or_default(),
        support
            .map(|s| {
                s.widget_components
                    .iter()
                    .filter_map(|(name, version)| ShortToken::new(name).ok().map(|name| (name, *version)))
                    .collect()
            })
            .unwrap_or_default(),
    )?))
}

fn invalid<T>(_: T) -> RendererPortError {
    RendererPortError::InvalidActivation
}

/// Splits `tcmedia://sha256/` content URIs out of a Runtime document into
/// object bindings, blanking them for the grant substitution the port does
/// at send time.
fn bindings(
    value: &mut Value,
    path: &str,
    found: &mut Vec<player_core::ObjectBinding>,
) -> Result<(), RendererPortError> {
    match value {
        Value::String(text) if text.to_ascii_lowercase().starts_with("tcmedia:") => {
            let object = crate::projection::parse_content_uri(text).ok_or(RendererPortError::InvalidActivation)?;
            found.push(player_core::ObjectBinding { pointer: SafeText::new(path).map_err(invalid)?, object });
            *text = String::new();
        }
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                bindings(item, &format!("{path}/{index}"), found)?;
            }
        }
        Value::Object(members) => {
            for (key, item) in members.iter_mut() {
                let key = key.replace('~', "~0").replace('/', "~1");
                bindings(item, &format!("{path}/{key}"), found)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn payload(mut value: Value) -> Result<RuntimePayload, RendererPortError> {
    let mut found = Vec::new();
    bindings(&mut value, "", &mut found)?;
    RuntimePayload::new(value, found).map_err(invalid)
}

fn expectation_for(kind: &str) -> Expectation {
    match kind {
        "image" => Expectation::Still,
        "video" => Expectation::Video,
        "website" | "widget" | "youtube" => Expectation::Website,
        "layout" => Expectation::Layout,
        _ => Expectation::Still,
    }
}

pub(crate) fn metadata(
    document: &Value,
    projection: Option<&Value>,
    safe_mode: bool,
) -> Result<RendererMetadata, &'static str> {
    let mut requirements: Vec<RendererRequirement> = Vec::new();
    if document.get("viewport").is_some()
        || document
            .get("items")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|item| item.get("viewport").is_some()))
    {
        requirements.push(RendererRequirement::Feature(
            ShortToken::new("span-viewport-v1").map_err(|_| "presentation_requirements_invalid")?,
        ));
    }
    // Host projection metadata, not interpretation inside Core. The
    // contract's separate declarative and component namespaces stay separate.
    if let Some(projection) = projection {
        let widgets = projection
            .get("manifest")
            .and_then(|manifest| manifest.get("widgets"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|widget| widget.get("presentation").filter(|value| !value.is_null()));
        let layouts = projection
            .get("manifest")
            .and_then(|manifest| manifest.get("layouts"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|layout| layout.get("document"));
        for presentation in widgets.chain(layouts) {
            let version = presentation
                .get("schemaVersion")
                .and_then(Value::as_u64)
                .and_then(|version| u32::try_from(version).ok())
                .filter(|version| *version > 0)
                .ok_or("presentation_requirements_invalid")?;
            let schema = RendererRequirement::PresentationSchema(version);
            if !requirements.contains(&schema) {
                requirements.push(schema);
            }
            if let Some(required) = presentation.get("requiredCapabilities") {
                for (name, version) in required.as_object().ok_or("presentation_requirements_invalid")? {
                    let name = ShortToken::new(name).map_err(|_| "presentation_requirements_invalid")?;
                    let version = version
                        .as_u64()
                        .and_then(|version| u32::try_from(version).ok())
                        .filter(|version| *version > 0)
                        .ok_or("presentation_requirements_invalid")?;
                    let requirement = if name.as_str().starts_with("widget.") {
                        RendererRequirement::WidgetComponent { name, version }
                    } else {
                        RendererRequirement::Declarative { name, version }
                    };
                    if !requirements.contains(&requirement) {
                        requirements.push(requirement);
                    }
                    if requirements.len() > player_core::MAX_RENDERER_REQUIREMENTS {
                        return Err("presentation_requirements_invalid");
                    }
                }
            }
        }
    }
    let state = document.get("state").and_then(Value::as_str).unwrap_or("");
    let expectations = match document.get("items").and_then(Value::as_array) {
        Some(items) if state == "playing" => items
            .iter()
            .rev()
            .filter_map(|item| {
                let id = item.get("id")?.as_str()?;
                let kind = item.get("kind")?.as_str().unwrap_or("");
                SafeText::new(id).ok().map(|id| (id, expectation_for(kind)))
            })
            .collect(),
        _ => HashMap::new(),
    };
    let capture_state = if safe_mode {
        player_core::CaptureState::SafeMode
    } else {
        match state {
            "setup" => player_core::CaptureState::Setup,
            "pairing" => player_core::CaptureState::Pairing,
            "safe-mode" => player_core::CaptureState::SafeMode,
            _ => player_core::CaptureState::Presentation,
        }
    };
    Ok(RendererMetadata {
        requirements,
        expectations,
        requires_content_evidence: state == "playing"
            && document.get("items").and_then(Value::as_array).is_some_and(|items| !items.is_empty()),
        capture_state,
    })
}

pub fn evidence(kind: &str) -> Option<player_core::ProgressEvidence> {
    use player_core::ProgressEvidence as Semantic;
    Some(match kind {
        "item-started" => Semantic::ItemStarted,
        "item-transition" => Semantic::ItemTransition,
        "video-progress" => Semantic::VideoProgress,
        "image-shown" => Semantic::ImageShown,
        "widget-shown" => Semantic::WidgetShown,
        "widget-alive" => Semantic::WidgetAlive,
        "widget-empty" => Semantic::WidgetEmpty,
        "layout-shown" => Semantic::LayoutShown,
        "layout-alive" => Semantic::LayoutAlive,
        "layout-zone-rendered" => Semantic::LayoutZoneRendered,
        "website-loaded" => Semantic::WebsiteLoaded,
        "website-alive" => Semantic::WebsiteAlive,
        "surface-shown" => Semantic::SurfaceShown,
        _ => return None,
    })
}

/// Substitutes granted `tcmedia://cap/` URIs for the blanked binding
/// pointers in a Runtime document clone. Every binding must have a grant;
/// a missing one fails the activation rather than sending a blank.
pub fn substitute_grants(
    mut document: Value,
    bindings: &[player_core::ObjectBinding],
    grants: &HashMap<player_types::Sha256Digest, MediaCapability>,
) -> Result<Value, RendererPortError> {
    for binding in bindings {
        let uri = grants.get(&binding.object).ok_or(RendererPortError::InvalidActivation)?.uri();
        let mut target = &mut document;
        for segment in binding.pointer.as_str().split('/').filter(|s| !s.is_empty()) {
            let segment = segment.replace("~1", "/").replace("~0", "~");
            if let Some(index) = segment.parse::<usize>().ok().filter(|_| target.is_array()) {
                target = target.get_mut(index).ok_or(RendererPortError::InvalidActivation)?;
            } else {
                target = target.get_mut(&segment).ok_or(RendererPortError::InvalidActivation)?;
            }
        }
        *target = Value::String(uri);
    }
    Ok(document)
}

/// Joins verified frame claims to their minted `tcwidget://` capabilities:
/// the `projection.widgetFrames` authorization table the projector joins
/// manifest frame claims against. Every claim must have a grant; a missing
/// one fails the activation rather than executing a frame unconfined.
pub fn frame_authorization_table(
    frames: &[VerifiedFrameRef],
    grants: &HashMap<player_types::Sha256Digest, MediaCapability>,
) -> Result<Vec<Value>, RendererPortError> {
    frames
        .iter()
        .map(|frame| {
            let uri = grants.get(&frame.sha256).ok_or(RendererPortError::InvalidActivation)?.frame_uri();
            Ok(serde_json::json!({
                "packageId": frame.package_id.as_str(),
                "packageDigest": frame.package_digest.to_string(),
                "frameDigest": frame.sha256.to_string(),
                "uri": uri,
            }))
        })
        .collect()
}

/// The semantic port over the WebView2 host. Activations mint media grants,
/// substitute them into the Runtime document, and post the message; the UI
/// thread owns everything past that point.
pub struct WebViewPort {
    ui: crate::ui::UiHandle,
    media: Arc<Mutex<MediaRegistry>>,
    session: uuid::Uuid,
}

impl std::fmt::Debug for WebViewPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebViewPort").field("session", &self.session).finish_non_exhaustive()
    }
}

impl WebViewPort {
    pub fn new(ui: crate::ui::UiHandle, media: Arc<Mutex<MediaRegistry>>, session: uuid::Uuid) -> Self {
        Self { ui, media, session }
    }

    pub fn ui(&self) -> crate::ui::UiHandle {
        self.ui.clone()
    }

    fn post(&self, message: Value) -> Result<(), RendererPortError> {
        self.ui.post(message).map_err(|_| RendererPortError::QueueUnavailable)
    }

    /// Posts a status surface outside any activation: the incompatible
    /// fallback. Surfaces carry no grants and expect no evidence.
    pub fn post_surface(&self, document: &Value) -> Result<(), RendererPortError> {
        self.post(serde_json::json!({"type": "presentation", "presentation": document}))
    }

    /// Asks the UI thread to clear remote browsing data, answering
    /// through the returned receiver.
    pub fn request_remote_clear(&self) -> Result<tokio::sync::oneshot::Receiver<bool>, crate::ui::UiError> {
        let (reply, pending) = tokio::sync::oneshot::channel();
        self.ui.remote(crate::ui::UiCommand::RemoteClearData { reply: Some(reply) })?;
        Ok(pending)
    }
}

/// Reads the projection media map out of an unsubstituted runtime context:
/// manifest asset/variant identity to the verified digest its blanked URI
/// binding names. The bindings carry the digests; the JSON carries the
/// identity; neither is trusted without the other.
fn context_aliases(
    context: &player_core::RuntimePayload,
) -> Vec<((uuid::Uuid, uuid::Uuid), player_types::Sha256Digest)> {
    let mut aliases = Vec::new();
    let media =
        context.value().get("projection").and_then(|projection| projection.get("media")).and_then(Value::as_array);
    let Some(media) = media else {
        return aliases;
    };
    for (index, entry) in media.iter().enumerate() {
        let asset = entry.get("assetId").and_then(Value::as_str).and_then(|id| id.parse().ok());
        let variant = entry.get("variantId").and_then(Value::as_str).and_then(|id| id.parse().ok());
        let (Some(asset_id), Some(variant_id)) = (asset, variant) else {
            continue;
        };
        let pointer = format!("/projection/media/{index}/uri");
        if let Some(binding) = context.bindings().iter().find(|binding| binding.pointer.as_str() == pointer) {
            aliases.push(((asset_id, variant_id), binding.object));
        }
    }
    aliases
}

impl RendererPort for WebViewPort {
    fn activate(&self, activation: &RendererActivation) -> Result<(), RendererPortError> {
        let now_ms = self.ui.now_ms();
        let mut media = self.media.lock().map_err(|_| RendererPortError::InvalidActivation)?;
        media.expire(now_ms);
        let reference = activation.reference();
        let minted = media
            .prepare(self.session, reference.generation, now_ms, activation.content())
            .map_err(|_| RendererPortError::InvalidActivation)?;
        let frame_grants = media
            .prepare_frames(self.session, reference.generation, now_ms, activation.frames())
            .map_err(|_| RendererPortError::InvalidActivation)?;
        let document =
            substitute_grants(activation.document().value().clone(), activation.document().bindings(), &minted)?;
        let mut context = match activation.runtime_context() {
            Some(context) => {
                media
                    .register_aliases(self.session, reference.generation, &context_aliases(context))
                    .map_err(|_| RendererPortError::InvalidActivation)?;
                substitute_grants(context.value().clone(), context.bindings(), &minted).map(Some)?
            }
            None => None,
        };
        // Frames ride the projection's authorization table, joined by
        // digest. A frame claim without a projection to authorize it
        // fails the activation rather than executing unconfined.
        if !activation.frames().is_empty() {
            let table = frame_authorization_table(activation.frames(), &frame_grants)?;
            let Some(context) = context.as_mut() else {
                return Err(RendererPortError::InvalidActivation);
            };
            let Some(projection) = context.get_mut("projection") else {
                return Err(RendererPortError::InvalidActivation);
            };
            let Some(projection) = projection.as_object_mut() else {
                return Err(RendererPortError::InvalidActivation);
            };
            projection.insert("widgetFrames".to_string(), Value::Array(table));
        }
        media.activate(self.session, reference.generation, now_ms).map_err(|_| RendererPortError::InvalidActivation)?;
        drop(media);
        // The host envelope splits back into contract fields: timing and
        // projection ride the presentation message; plugins get their own
        // message, always, so a plugin-less activation clears stale
        // surfaces instead of leaving them mounted.
        let timing = context.as_ref().and_then(|context| context.get("timing")).filter(|value| !value.is_null());
        let projection =
            context.as_ref().and_then(|context| context.get("projection")).filter(|value| !value.is_null());
        let (plugins, clock_offset_ms) = match context.as_ref() {
            Some(context) => (
                context.get("plugins").and_then(Value::as_array).cloned().unwrap_or_default(),
                context.get("clockOffsetMs").and_then(Value::as_i64).unwrap_or(0),
            ),
            None => (Vec::new(), 0),
        };
        let mut message = serde_json::json!({
            "type": "presentation",
            "presentation": document,
            "activation": {"activationId": reference.activation_id.to_string(), "generation": reference.generation},
        });
        if let Some(timing) = timing {
            message["timing"] = timing.clone();
        }
        if let Some(projection) = projection {
            message["projection"] = projection.clone();
        }
        self.post(message)?;
        self.post(serde_json::json!({
            "type": "plugins",
            "plugins": plugins,
            "clockOffsetMs": clock_offset_ms,
        }))
    }

    fn clear(&self, reason: &player_types::bounded::ShortToken) -> Result<(), RendererPortError> {
        self.post(serde_json::json!({"type": "clear", "reason": reason.as_str()}))
    }

    fn send_command(&self, command_id: uuid::Uuid, command: &SemanticRendererCommand) -> Result<(), RendererPortError> {
        // Website data lives in the host-layer remote views, which only
        // the UI thread can clear; the Runtime never sees this command.
        if matches!(command, SemanticRendererCommand::ClearWebsiteData) {
            let _ = command_id;
            return self
                .ui
                .remote(crate::ui::UiCommand::RemoteClearData { reply: None })
                .map_err(|_| RendererPortError::QueueUnavailable);
        }
        let message = match command {
            SemanticRendererCommand::RetryItem => serde_json::json!({"type": "command", "command": "retry-item"}),
            SemanticRendererCommand::SkipItem => serde_json::json!({"type": "command", "command": "skip-item"}),
            SemanticRendererCommand::Reload => serde_json::json!({"type": "reload"}),
            SemanticRendererCommand::ClearWebsiteData => unreachable!("handled above"),
            SemanticRendererCommand::Identify { name, duration_seconds } => serde_json::json!({
                "type": "identify", "name": name.as_str(), "durationSeconds": duration_seconds,
            }),
        };
        let _ = command_id;
        self.post(message)
    }

    fn request_capture(&self, request: RendererCaptureRequest) -> Result<(), RendererPortError> {
        self.post(serde_json::json!({"type": "capture", "request": request.request_id.to_string()}))
    }

    fn request_restart(
        &self,
        reason: &player_types::bounded::ShortToken,
        deadline_ms: u32,
    ) -> Result<(), RendererPortError> {
        self.ui.restart(reason.as_str(), deadline_ms).map_err(|_| RendererPortError::QueueUnavailable)
    }
}

pub fn content_refs(content: &[VerifiedContentRef]) -> Vec<VerifiedContentRef> {
    content.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packaged_profile_advertises_remote_web() {
        assert!(profile::FEATURES.contains(&"remote-web-v1"));
        assert!(profile::FEATURES.contains(&"website"));
        assert!(profile::FEATURES.contains(&"youtube"));
        assert_eq!(profile::WEB_RUNTIME_VERSION, 1);
        let web_remote = player_types::bounded::ShortToken::new("web.remote").expect("test fixture");
        packaged_profile()
            .check(&player_core::RendererRequirement::Declarative { name: web_remote, version: 1 })
            .expect("web.remote v1");
    }

    fn frame(document: &[u8]) -> VerifiedFrameRef {
        VerifiedFrameRef {
            package_id: SafeText::new("acme.athletics").expect("test fixture"),
            package_digest: player_types::Sha256Digest::of(b"package"),
            sha256: player_types::Sha256Digest::of(document),
            size_bytes: document.len() as u64,
        }
    }

    #[test]
    fn frame_table_joins_claims_to_confined_uris() {
        let reference = frame(b"frame");
        let token = MediaCapability::parse(&"c".repeat(64)).expect("test fixture");
        let grants = HashMap::from([(reference.sha256, token)]);
        let table = frame_authorization_table(std::slice::from_ref(&reference), &grants).expect("table");
        assert_eq!(table.len(), 1);
        assert_eq!(table[0]["packageId"], "acme.athletics");
        assert_eq!(table[0]["packageDigest"], player_types::Sha256Digest::of(b"package").to_string());
        assert_eq!(table[0]["frameDigest"], player_types::Sha256Digest::of(b"frame").to_string());
        let uri = table[0]["uri"].as_str().expect("uri");
        assert!(uri.starts_with("tcwidget://cap/"), "{uri}");
        assert!(!uri.contains("athletics"), "{uri}");
        // The projector's join key survives the round trip.
        let parsed = crate::schemes::parse_widget_url(uri).expect("parses");
        assert_eq!(parsed.capability, "c".repeat(64));
    }

    #[test]
    fn packaged_profile_offers_the_frame_execution_abi_at_two() {
        let name = || {
            player_types::bounded::ShortToken::new(player_types::frames::EXTERNAL_RUNTIME_CAPABILITY)
                .expect("test fixture")
        };
        packaged_profile()
            .check(&player_core::RendererRequirement::WidgetComponent {
                name: name(),
                version: player_types::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
            })
            .expect("external-runtime @2");
        assert!(
            packaged_profile()
                .check(&player_core::RendererRequirement::WidgetComponent {
                    name: name(),
                    version: player_types::frames::EXTERNAL_RUNTIME_FRAME_VERSION + 1,
                })
                .is_err()
        );
    }

    #[test]
    fn frame_table_without_a_grant_fails_closed() {
        let reference = frame(b"frame");
        assert_eq!(
            frame_authorization_table(std::slice::from_ref(&reference), &HashMap::new()),
            Err(RendererPortError::InvalidActivation)
        );
        assert!(frame_authorization_table(&[], &HashMap::new()).expect("empty").is_empty());
    }
}
