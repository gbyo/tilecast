//! WebView transport and generation-bound resource encoding for the
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
    /// Renderer features the trusted runtime implements on every WebView
    /// host. [`REMOTE_WEB_FEATURES`] join them only on a host that shows
    /// remote web in isolated host-layer views.
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
    ];

    /// The features of remote web in isolated host-layer views.
    pub const REMOTE_WEB_FEATURES: &[&str] = &["remote-web-v1", "website", "youtube"];

    /// Declarative widget capabilities of the reference projection code the
    /// trusted runtime runs (the same versions the other native hosts
    /// report, because it is the same code).
    pub const NATIVE_CAPABILITIES: &[(&str, u32)] =
        crate::presentation_capabilities::SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES;

    /// The `web.remote` declarative capability: remote web in isolated
    /// host-layer child views, shown through the renderer's remote web
    /// surface.
    pub const WEB_RUNTIME_VERSION: u32 = 2;

    /// Presentation schemas the runtime renders: 1 (declarative and web),
    /// 2 (first-class Widget components), and 3 (component empty policy).
    pub const PRESENTATION_SCHEMAS: &[u32] = &[1, 2, crate::widget_capabilities::COMPONENT_PRESENTATION_SCHEMA];
}

/// The installed-release ceiling for a host with `features`. Remote web and
/// the external Widget frame ABI are part of it only where the platform
/// implements them.
pub(crate) fn packaged_profile(features: crate::host::RendererFeatures) -> player_core::PackagedRendererProfile {
    let token = |name| ShortToken::new(name).expect("generated capability name");
    let remote_web: &[&str] = if features.remote_web { profile::REMOTE_WEB_FEATURES } else { &[] };
    player_core::PackagedRendererProfile(
        player_core::RendererSupport::new(
            profile::FEATURES.iter().chain(remote_web).map(|name| token(*name)).collect(),
            profile::PRESENTATION_SCHEMAS.iter().copied().collect(),
            profile::NATIVE_CAPABILITIES
                .iter()
                .map(|(name, version)| (token(*name), *version))
                .chain(features.remote_web.then(|| (token("web.remote"), profile::WEB_RUNTIME_VERSION)))
                // The host script sets pluginState, so the Runtime hosts
                // Plugin API v2 contributions with its own services.
                .chain(player_core::shared_runtime_plugin_capabilities().map(|(name, version)| (token(name), version)))
                .collect(),
            crate::widget_capabilities::WIDGET_COMPONENTS
                .iter()
                .map(|(name, version)| (token(*name), *version))
                // The frame execution ABI is one capability for every
                // downloaded Widget, not a discovered component: a host
                // that confines served frames offers it.
                .chain(features.external_frames.then(|| {
                    (
                        token(player_types::frames::EXTERNAL_RUNTIME_CAPABILITY),
                        player_types::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
                    )
                }))
                .collect(),
        )
        .expect("bounded installed runtime profile"),
    )
}

/// What the heartbeat advertises: the live Runtime's ready report inside
/// the installed ceiling. Before a Runtime proves itself, the ceiling.
pub(crate) fn advertised_support(
    features: crate::host::RendererFeatures,
    ready: Option<&crate::bridge::RuntimeReady>,
) -> (Vec<u32>, Vec<(String, u32)>) {
    use player_core::RendererRequirement as Requirement;
    let packaged = &packaged_profile(features);
    let ceiling = &packaged.0;
    let Some(connected) = ready.and_then(|ready| connected_profile(ready, features).ok()) else {
        let declared = player_core::ConnectedRendererProfile(ceiling.clone());
        let mut table = declared.declarative_capabilities();
        table.extend(declared.widget_components());
        return (declared.presentation_schemas(), table);
    };
    let schemas = connected
        .presentation_schemas()
        .into_iter()
        .filter(|version| packaged.check(&Requirement::PresentationSchema(*version)).is_ok())
        .collect();
    let within = |name: &str, version: u32, widget: bool| {
        let Ok(name) = ShortToken::new(name) else { return false };
        let requirement = if widget {
            Requirement::WidgetComponent { name, version }
        } else {
            Requirement::Declarative { name, version }
        };
        packaged.check(&requirement).is_ok()
    };
    let mut table: Vec<(String, u32)> = connected
        .declarative_capabilities()
        .into_iter()
        .filter(|(name, version)| within(name, *version, false))
        .collect();
    table.extend(connected.widget_components().into_iter().filter(|(name, version)| within(name, *version, true)));
    (schemas, table)
}

pub(crate) fn connected_profile(
    ready: &crate::bridge::RuntimeReady,
    features: crate::host::RendererFeatures,
) -> Result<player_core::ConnectedRendererProfile, player_core::RendererProfileError> {
    let support = ready.support.as_ref();
    let remote_web: &[&str] = if features.remote_web { profile::REMOTE_WEB_FEATURES } else { &[] };
    Ok(player_core::ConnectedRendererProfile(player_core::RendererSupport::new(
        // The Runtime advertises its live support namespaces; the feature
        // set is the packaged one, refined by what the Runtime implements.
        profile::FEATURES
            .iter()
            .chain(remote_web)
            .map(|name| ShortToken::new(*name).expect("profile feature"))
            .collect(),
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
        "layout-zone-declared" => Semantic::LayoutZoneDeclared,
        "layout-zone-rotating" => Semantic::LayoutZoneRotating,
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

/// The semantic port over the platform WebView host. Activations mint media grants,
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

    fn post_all(&self, messages: Vec<Value>) -> Result<(), RendererPortError> {
        self.ui.post_all(messages).map_err(|_| RendererPortError::QueueUnavailable)
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

/// Reads the media maps out of an unsubstituted runtime context: manifest
/// asset/variant identity to the verified digest its blanked URI binding
/// names. `projection.media` carries presentation media and `pluginAliases`
/// carries the variants Plugin API v2 state declares. The bindings carry the
/// digests; the JSON carries the identity; neither is trusted without the
/// other.
fn context_aliases(
    context: &player_core::RuntimePayload,
) -> Vec<((uuid::Uuid, uuid::Uuid), player_types::Sha256Digest)> {
    let mut aliases = Vec::new();
    let sources = [
        (context.value().get("projection").and_then(|projection| projection.get("media")), "/projection/media"),
        (context.value().get("pluginAliases"), "/pluginAliases"),
    ];
    for (media, base) in sources {
        let Some(media) = media.and_then(Value::as_array) else {
            continue;
        };
        for (index, entry) in media.iter().enumerate() {
            let asset = entry.get("assetId").and_then(Value::as_str).and_then(|id| id.parse().ok());
            let variant = entry.get("variantId").and_then(Value::as_str).and_then(|id| id.parse().ok());
            let (Some(asset_id), Some(variant_id)) = (asset, variant) else {
                continue;
            };
            let pointer = format!("{base}/{index}/uri");
            if let Some(binding) = context.bindings().iter().find(|binding| binding.pointer.as_str() == pointer) {
                aliases.push(((asset_id, variant_id), binding.object));
            }
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
        let widget_frames: Vec<_> =
            activation.frames().iter().filter(|frame| frame.kind.is_widget()).cloned().collect();
        let plugin_frames: Vec<_> =
            activation.frames().iter().filter(|frame| !frame.kind.is_widget()).cloned().collect();
        let plugin_table = frame_authorization_table(&plugin_frames, &frame_grants)?;
        if !widget_frames.is_empty() {
            let table = frame_authorization_table(&widget_frames, &frame_grants)?;
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
        // One queue reservation covers both messages. A full queue must not
        // accept the presentation and drop the plugin state: the Runtime
        // would keep mounting the previous plugin entries.
        self.post_all(vec![
            message,
            serde_json::json!({
                "type": "plugins",
                "plugins": plugins,
                "clockOffsetMs": clock_offset_ms,
                "pluginFrames": plugin_table,
            }),
        ])
    }

    fn update_plugins(
        &self,
        reference: player_core::RendererActivationRef,
        context: &RuntimePayload,
    ) -> Result<(), RendererPortError> {
        self.update_plugin_frames(reference, context, &[])
    }

    fn update_plugin_frames(
        &self,
        reference: player_core::RendererActivationRef,
        context: &RuntimePayload,
        frames: &[VerifiedFrameRef],
    ) -> Result<(), RendererPortError> {
        let now_ms = self.ui.now_ms();
        let mut media = self.media.lock().map_err(|_| RendererPortError::ResourceUnavailable)?;
        let grants =
            media.active_grants(self.session, reference.generation).ok_or(RendererPortError::InvalidActivation)?;
        let context = substitute_grants(context.value().clone(), context.bindings(), &grants)?;
        let update = media
            .prepare_plugin_frames(self.session, reference.generation, now_ms, frames)
            .map_err(|_| RendererPortError::ResourceUnavailable)?;
        let table = match frame_authorization_table(frames, &update.grants) {
            Ok(table) => table,
            Err(error) => {
                let _ = media.finish_plugin_frames(update, false, now_ms);
                return Err(error);
            }
        };
        let delivered = self.post(serde_json::json!({
            "type": "plugins", "plugins": context.get("plugins").cloned().unwrap_or(serde_json::json!([])),
            "clockOffsetMs": context.get("clockOffsetMs").and_then(Value::as_i64).unwrap_or(0),
            "pluginFrames": table,
        }));
        media
            .finish_plugin_frames(update, delivered.is_ok(), now_ms)
            .map_err(|_| RendererPortError::InvalidActivation)?;
        delivered
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

    /// The Windows host: every optional feature.
    const FULL: crate::host::RendererFeatures =
        crate::host::RendererFeatures { remote_web: true, external_frames: true };

    #[test]
    fn packaged_profile_advertises_remote_web() {
        assert!(profile::REMOTE_WEB_FEATURES.contains(&"remote-web-v1"));
        assert!(profile::REMOTE_WEB_FEATURES.contains(&"website"));
        assert!(profile::REMOTE_WEB_FEATURES.contains(&"youtube"));
        assert_eq!(profile::WEB_RUNTIME_VERSION, 2);
        let web_remote = player_types::bounded::ShortToken::new("web.remote").expect("test fixture");
        packaged_profile(FULL)
            .check(&player_core::RendererRequirement::Declarative { name: web_remote, version: 2 })
            .expect("web.remote v2 periodic reload");
    }

    /// Plugin API v2: the host script sets pluginState, so the packaged
    /// profile offers the Player Plugin Host and the Shared Runtime
    /// services, exactly as the other hosts that run the same Runtime do.
    #[test]
    fn packaged_profile_offers_the_plugin_api_2_host_and_its_runtime_services() {
        let declarative = |name: &str, version| player_core::RendererRequirement::Declarative {
            name: player_types::bounded::ShortToken::new(name).expect("test fixture"),
            version,
        };
        for (name, version) in player_core::shared_runtime_plugin_capabilities() {
            packaged_profile(FULL).check(&declarative(name, version)).expect(name);
        }
        assert!(packaged_profile(FULL).check(&declarative(player_core::PLAYER_PLUGIN_HOST_CAPABILITY, 3)).is_err());
        // Events need a transport this host does not have.
        assert!(packaged_profile(FULL).check(&declarative("player.events", 1)).is_err());
        let script = include_str!("runtime_host.js");
        assert!(!script.contains("pluginState"), "the capability comes from the native host table");
    }

    #[test]
    fn a_base_host_claims_neither_remote_web_nor_external_frames() {
        let feature = |name: &str| player_core::RendererRequirement::Feature(ShortToken::new(name).expect("token"));
        let external = player_core::RendererRequirement::WidgetComponent {
            name: ShortToken::new(player_types::frames::EXTERNAL_RUNTIME_CAPABILITY).expect("token"),
            version: player_types::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
        };
        let web = player_core::RendererRequirement::Declarative {
            name: ShortToken::new("web.remote").expect("token"),
            version: profile::WEB_RUNTIME_VERSION,
        };
        let base = packaged_profile(crate::host::RendererFeatures::BASE);
        for name in profile::REMOTE_WEB_FEATURES {
            assert!(base.check(&feature(name)).is_err(), "{name}");
            packaged_profile(FULL).check(&feature(name)).expect(name);
        }
        assert!(base.check(&web).is_err() && base.check(&external).is_err());
        packaged_profile(FULL).check(&web).expect("web.remote");
        packaged_profile(FULL).check(&external).expect("frame ABI");
        // Everything else is the same shared Runtime.
        base.check(&feature("video")).expect("video");
        base.check(&player_core::RendererRequirement::PresentationSchema(3)).expect("schema 3");
    }

    #[test]
    fn remote_web_alone_claims_no_external_frames() {
        let remote_only = crate::host::RendererFeatures { remote_web: true, external_frames: false };
        let profile = packaged_profile(remote_only);
        for name in profile::REMOTE_WEB_FEATURES {
            let token = ShortToken::new(*name).expect("token");
            profile.check(&player_core::RendererRequirement::Feature(token)).expect(name);
        }
        profile
            .check(&player_core::RendererRequirement::Declarative {
                name: ShortToken::new("web.remote").expect("token"),
                version: profile::WEB_RUNTIME_VERSION,
            })
            .expect("web.remote");
        let external = player_core::RendererRequirement::WidgetComponent {
            name: ShortToken::new(player_types::frames::EXTERNAL_RUNTIME_CAPABILITY).expect("token"),
            version: player_types::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
        };
        assert!(profile.check(&external).is_err(), "remote web does not imply the frame ABI");
        let (_, table) = advertised_support(remote_only, None);
        assert!(table.iter().any(|(name, _)| name == "web.remote"));
    }

    #[test]
    fn the_heartbeat_follows_the_ready_report_inside_the_ceiling() {
        let base = crate::host::RendererFeatures::BASE;
        // Before a Runtime proves itself: the ceiling.
        let (schemas, table) = advertised_support(base, None);
        assert_eq!(schemas, profile::PRESENTATION_SCHEMAS);
        assert!(table.iter().any(|(name, _)| name == "content.text"));
        assert!(!table.iter().any(|(name, _)| name == "web.remote"));
        // A Runtime that claims more than the platform implements is
        // clipped to the ceiling; what it does not prove is dropped.
        let ready = crate::bridge::RuntimeReady {
            contract_version: 1,
            runtime_version: "1.0.0".into(),
            support: Some(crate::bridge::RuntimeSupport {
                presentation_schemas: vec![1, 2, 99],
                declarative: vec![("content.text".into(), 1), ("web.remote".into(), 2)],
                widget_components: vec![(player_types::frames::EXTERNAL_RUNTIME_CAPABILITY.into(), 2)],
            }),
        };
        let (schemas, table) = advertised_support(base, Some(&ready));
        assert_eq!(schemas, vec![1, 2]);
        assert_eq!(table, vec![("content.text".to_owned(), 1)]);
        let (_, table) = advertised_support(FULL, Some(&ready));
        assert!(table.contains(&("web.remote".to_owned(), 2)));
        assert!(table.contains(&(player_types::frames::EXTERNAL_RUNTIME_CAPABILITY.to_owned(), 2)));
    }

    /// Plugin media aliases are registered by identity beside the
    /// presentation's, each through the digest its binding names.
    #[test]
    fn plugin_aliases_register_beside_projection_media() {
        let asset = uuid::Uuid::from_u128(1);
        let variant = uuid::Uuid::from_u128(2);
        let plugin_variant = uuid::Uuid::from_u128(3);
        let pixels = player_types::Sha256Digest::of(b"pixels");
        let sound = player_types::Sha256Digest::of(b"sound");
        let payload = payload(serde_json::json!({
            "projection": {"media": [{"assetId": asset, "variantId": variant,
                "uri": crate::projection::content_uri(&pixels)}]},
            "pluginAliases": [{"assetId": asset, "variantId": plugin_variant,
                "uri": crate::projection::content_uri(&sound)}],
            "plugins": [],
        }))
        .expect("payload");
        assert_eq!(context_aliases(&payload), vec![((asset, variant), pixels), ((asset, plugin_variant), sound)]);
    }

    fn frame(document: &[u8]) -> VerifiedFrameRef {
        VerifiedFrameRef {
            kind: player_types::frames::FrameKind::Widget,
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
        packaged_profile(FULL)
            .check(&player_core::RendererRequirement::WidgetComponent {
                name: name(),
                version: player_types::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
            })
            .expect("external-runtime @2");
        assert!(
            packaged_profile(FULL)
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
