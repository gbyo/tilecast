//! Edge transport and generation-bound resource encoding for the semantic port.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use edge_ipc::SessionHandle;
use edge_protocol::ipc::event::{
    ActivationRef, Event, EvidenceKind, Identify, KioskPolicy, MediaAlias, MediaChannelDescriptor, PluginState,
    PresentationClear, PreviewRequest, ProjectionContext, RendererCommand, RendererCommandKind, RendererConfigure,
    RendererFrameRef, RendererMediaRef, RendererShutdown, SyncTiming,
};
use edge_protocol::ipc::presentation::{ItemKind, PresentationDocument, parse_content_uri};
use edge_protocol::{Sha256Digest, bounded::SafeText};
use player_core::{
    Expectation, ObjectBinding, RendererActivation, RendererActivationRef, RendererCaptureRequest, RendererMetadata,
    RendererPort, RendererPortError, RuntimePayload, SemanticRendererCommand, VerifiedContentRef,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    media::{MediaCapability, MediaRegistry},
    media_channel::{ReadExpect, grant_live},
    presentation::Activation,
};

/// The existing Runtime inputs, with their object bindings separated before
/// crossing Core. This representation is private to the Edge projection adapter.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeContext {
    timing: Option<SyncTiming>,
    projection: Option<ProjectionContext>,
    plugins: Vec<Value>,
    aliases: Vec<MediaAlias>,
    server_presentation: bool,
    clock_offset_ms: i64,
}

fn invalid<T>(_: T) -> RendererPortError {
    RendererPortError::InvalidActivation
}

pub(crate) fn command(command: RendererCommandKind) -> SemanticRendererCommand {
    match command {
        RendererCommandKind::RetryItem => SemanticRendererCommand::RetryItem,
        RendererCommandKind::SkipItem => SemanticRendererCommand::SkipItem,
        RendererCommandKind::Reload => SemanticRendererCommand::Reload,
        RendererCommandKind::ClearWebsiteData => SemanticRendererCommand::ClearWebsiteData,
    }
}

fn bindings(value: &mut Value, path: &str, found: &mut Vec<ObjectBinding>) -> Result<(), RendererPortError> {
    match value {
        Value::String(text) if text.to_ascii_lowercase().starts_with("tcmedia:") => {
            let object = parse_content_uri(text).ok_or(RendererPortError::InvalidActivation)?;
            found.push(ObjectBinding { pointer: SafeText::new(path).map_err(invalid)?, object });
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

fn payload(mut value: Value) -> Result<RuntimePayload, RendererPortError> {
    let mut found = Vec::new();
    bindings(&mut value, "", &mut found)?;
    RuntimePayload::new(value, found).map_err(invalid)
}

fn prepared_document(document: &PresentationDocument) -> Result<RuntimePayload, RendererPortError> {
    payload(serde_json::to_value(document).map_err(invalid)?)
}

pub(crate) fn metadata(
    document: &PresentationDocument,
    source: crate::presentation::ActivationSource,
    projection: Option<&edge_protocol::ipc::event::ProjectionContext>,
) -> Result<RendererMetadata, edge_protocol::ipc::presentation::PresentationError> {
    use edge_protocol::ipc::presentation::PresentationError;
    use player_core::RendererRequirement;
    let mut requirements: Vec<_> = document
        .required_features()
        .into_iter()
        .map(|feature| {
            RendererRequirement::Feature(edge_protocol::bounded::ShortToken::new(feature).expect("contract feature"))
        })
        .collect();
    // This is host projection metadata, not interpretation inside Core.
    // Preserve the contract's separate declarative and component namespaces.
    if let Some(projection) = projection {
        let widgets = projection
            .manifest
            .get("widgets")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|widget| widget.get("presentation").filter(|value| !value.is_null()));
        let layouts = projection
            .manifest
            .get("layouts")
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
                .ok_or(PresentationError::InvalidRequirements)?;
            let schema = RendererRequirement::PresentationSchema(version);
            if !requirements.contains(&schema) {
                requirements.push(schema);
            }
            if let Some(required) = presentation.get("requiredCapabilities") {
                for (name, version) in required.as_object().ok_or(PresentationError::InvalidRequirements)? {
                    let name = edge_protocol::bounded::ShortToken::new(name)
                        .map_err(|_| PresentationError::InvalidRequirements)?;
                    let version = version
                        .as_u64()
                        .and_then(|version| u32::try_from(version).ok())
                        .filter(|version| *version > 0)
                        .ok_or(PresentationError::InvalidRequirements)?;
                    let requirement = if name.as_str().starts_with("widget.") {
                        RendererRequirement::WidgetComponent { name, version }
                    } else {
                        RendererRequirement::Declarative { name, version }
                    };
                    if !requirements.contains(&requirement) {
                        requirements.push(requirement);
                    }
                    if requirements.len() > player_core::MAX_RENDERER_REQUIREMENTS {
                        return Err(PresentationError::InvalidRequirements);
                    }
                }
            }
        }
    }
    let expectations = match document {
        PresentationDocument::Playing { items, .. } => {
            items.iter().rev().map(|item| (item.id.clone(), expectation_for(item.kind))).collect()
        }
        _ => Default::default(),
    };
    let capture_state = if source == crate::presentation::ActivationSource::SafeMode {
        player_core::CaptureState::SafeMode
    } else {
        match document {
            PresentationDocument::Setup {} => player_core::CaptureState::Setup,
            PresentationDocument::Pairing { .. } => player_core::CaptureState::Pairing,
            PresentationDocument::SafeMode { .. } => player_core::CaptureState::SafeMode,
            _ => player_core::CaptureState::Presentation,
        }
    };
    Ok(RendererMetadata {
        requirements,
        expectations,
        requires_content_evidence: matches!(document, PresentationDocument::Playing { items, .. } if !items.is_empty()),
        capture_state,
    })
}

pub(crate) fn packaged_profile() -> player_core::PackagedRendererProfile {
    use crate::manifest::profile;
    let token = |name| edge_protocol::bounded::ShortToken::new(name).expect("generated capability name");
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
                    token(edge_protocol::frames::EXTERNAL_RUNTIME_CAPABILITY),
                    edge_protocol::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
                )))
                .collect(),
        )
        .expect("bounded installed runtime profile"),
    )
}

pub(crate) fn connected_profile(
    ready: &edge_protocol::ipc::event::RendererReady,
) -> player_core::ConnectedRendererProfile {
    let support = ready.support.as_ref();
    player_core::ConnectedRendererProfile(
        player_core::RendererSupport::new(
            ready.features.iter().cloned().collect(),
            support.map(|s| s.presentation_schemas.iter().copied().collect()).unwrap_or_default(),
            support.map(|s| s.declarative_capabilities.clone()).unwrap_or_default(),
            support.map(|s| s.widget_components.clone()).unwrap_or_default(),
        )
        .expect("bounded renderer.ready support"),
    )
}

/// Temporary projection bridge while activation policy still lives in Edge.
pub(crate) fn prepare(activation: &Activation, clock_offset_ms: i64) -> Result<RendererActivation, RendererPortError> {
    let context = RuntimeContext {
        timing: activation.timing.clone(),
        projection: activation.extras.projection.clone(),
        plugins: activation.extras.plugins.clone(),
        aliases: activation.extras.plugin_aliases.clone(),
        server_presentation: activation.identity.is_some(),
        clock_offset_ms,
    };
    let content = activation
        .content
        .iter()
        .map(|reference| VerifiedContentRef {
            sha256: reference.sha256,
            size_bytes: reference.size_bytes,
            mime_type: reference.mime_type.clone(),
            stream: activation.extras.streams.get(&reference.sha256).cloned(),
        })
        .collect();
    let frames = activation
        .frames
        .iter()
        .map(|reference| player_core::VerifiedFrameRef {
            package_id: reference.package_id.clone(),
            package_digest: reference.package_digest,
            sha256: reference.sha256,
            size_bytes: reference.size_bytes,
        })
        .collect();
    RendererActivation::new(
        RendererActivationRef { activation_id: activation.id, generation: activation.generation },
        prepared_document(&activation.document)?,
        activation.renderer_metadata.clone(),
        content,
        frames,
        Some(payload(serde_json::to_value(context).map_err(invalid)?)?),
    )
    .map_err(invalid)
}

/// Minted grants for one activation, by usage. Media and frame grants
/// share the registry's token space but never each other's URIs.
#[derive(Debug, Default)]
struct CachedGrants {
    media: HashMap<Sha256Digest, MediaCapability>,
    frames: HashMap<Sha256Digest, MediaCapability>,
}

/// Whether the renderer session negotiated sandbox-frame delivery. Frame
/// members cross only negotiated sessions; anything else fails the
/// activation rather than executing a frame the renderer cannot confine.
fn session_grants_frames(session: &SessionHandle) -> bool {
    session.features().iter().any(|feature| feature.as_str() == edge_protocol::ipc::RENDERER_FEATURE_WIDGET_FRAMES)
}

/// Joins verified frame claims to their minted `tcwidget://` capabilities:
/// the renderer's serve allowlist and the `projection.widgetFrames`
/// authorization table. Every claim must have a grant; a missing one
/// fails the activation rather than executing a frame unconfined.
fn frame_authorization_table(
    frames: &[player_core::VerifiedFrameRef],
    grants: &HashMap<Sha256Digest, MediaCapability>,
) -> Result<Vec<RendererFrameRef>, RendererPortError> {
    frames
        .iter()
        .map(|frame| {
            let uri = grants.get(&frame.sha256).ok_or(RendererPortError::InvalidActivation)?.frame_uri();
            Ok(RendererFrameRef {
                uri: SafeText::new(uri).map_err(invalid)?,
                package_id: frame.package_id.clone(),
                package_digest: frame.package_digest,
                frame_digest: frame.sha256,
                size_bytes: frame.size_bytes,
            })
        })
        .collect()
}

/// One host endpoint owns resource grants for its live renderer session.
#[derive(Debug)]
pub(crate) struct EdgeRendererPort {
    session: SessionHandle,
    channel: MediaChannelDescriptor,
    clock: edge_protocol::time::SharedClock,
    registry: Arc<Mutex<MediaRegistry>>,
    media: Mutex<Option<(ActivationRef, CachedGrants)>>,
    /// Ephemeral loopback media port, set once the daemon binds it. Opaque
    /// frames cannot load `tcmedia:` subresources, so their media aliases
    /// are mirrored as loopback URLs only while this port is known.
    loopback_port: Mutex<Option<u16>>,
}

impl EdgeRendererPort {
    pub(crate) fn new(
        session: SessionHandle,
        channel: MediaChannelDescriptor,
        registry: Arc<Mutex<MediaRegistry>>,
        clock: edge_protocol::time::SharedClock,
    ) -> Self {
        Self { session, channel, registry, clock, media: Mutex::new(None), loopback_port: Mutex::new(None) }
    }

    /// Records the loopback media port once the daemon binds it. Activations
    /// built before the bind omit the opaque-frame media table rather than
    /// emit unusable URLs.
    pub(crate) fn set_loopback_port(&self, port: u16) {
        if let Ok(mut slot) = self.loopback_port.lock() {
            *slot = Some(port);
        }
    }

    fn send(&self, event: Event) -> Result<(), RendererPortError> {
        self.session.send_event(event).map_err(|_| RendererPortError::QueueUnavailable)
    }
}

fn wire_document(
    document: &RuntimePayload,
    resolve: &impl Fn(Sha256Digest) -> Option<String>,
) -> Result<Value, RendererPortError> {
    document.resolve(resolve).map_err(invalid)
}

/// Mirrors resolved capability aliases as loopback URLs for opaque frames.
/// Each alias URI is a `tcmedia://cap/<token>` the port minted through the
/// activation bindings; the token is re-checked live before its URL is
/// published, so a generation that retired between grant and fill fails the
/// activation instead of handing frames a dead URL.
fn widget_media_table(
    registry: &MediaRegistry,
    session: edge_protocol::ids::SessionId,
    aliases: &[MediaAlias],
    port: Option<u16>,
    now_ms: i64,
) -> Result<Option<Vec<MediaAlias>>, RendererPortError> {
    if aliases.is_empty() {
        return Ok(None);
    }
    let Some(port) = port else {
        tracing::warn!(component = "media", event = "loopback_unbound_frames_have_no_media");
        return Ok(None);
    };
    let mut table = Vec::with_capacity(aliases.len());
    for alias in aliases {
        let token = alias
            .uri
            .as_str()
            .strip_prefix("tcmedia://cap/")
            .and_then(MediaCapability::parse)
            .ok_or(RendererPortError::InvalidActivation)?;
        if !grant_live(registry, session, token.as_str(), ReadExpect::Media, now_ms) {
            return Err(RendererPortError::InvalidActivation);
        }
        let uri =
            SafeText::new(crate::media_http::media_url(port, token.as_str())).map_err(invalid)?;
        table.push(MediaAlias { asset_id: alias.asset_id, variant_id: alias.variant_id, uri });
    }
    Ok(Some(table))
}

impl EdgeRendererPort {
    pub(crate) fn configure(&self, kiosk: &KioskPolicy) -> Result<(), RendererPortError> {
        self.send(Event::RendererConfigure(RendererConfigure {
            media_channel: self.channel.clone(),
            kiosk: kiosk.clone(),
        }))
    }
}

impl RendererPort for EdgeRendererPort {
    fn activate(&self, activation: &RendererActivation) -> Result<(), RendererPortError> {
        let now_ms = self.clock.now().unix_millis();
        let reference = activation.reference();
        let reference = ActivationRef { activation_id: reference.activation_id, generation: reference.generation };
        let mut media = self.media.lock().map_err(|_| RendererPortError::ResourceUnavailable)?;
        if media.as_ref().is_none_or(|(cached, _)| *cached != reference) {
            let mut registry = self.registry.lock().map_err(|_| RendererPortError::ResourceUnavailable)?;
            let grants = if activation.content().is_empty() && activation.frames().is_empty() {
                registry.drain_active(now_ms);
                CachedGrants::default()
            } else {
                let content: Vec<_> = activation
                    .content()
                    .iter()
                    .map(|object| edge_protocol::ipc::presentation::ContentRef {
                        sha256: object.sha256,
                        size_bytes: object.size_bytes,
                        mime_type: object.mime_type.clone(),
                    })
                    .collect();
                let frames: Vec<_> = activation
                    .frames()
                    .iter()
                    .map(|frame| edge_protocol::ipc::presentation::FrameRef {
                        package_id: frame.package_id.clone(),
                        package_digest: frame.package_digest,
                        sha256: frame.sha256,
                        size_bytes: frame.size_bytes,
                    })
                    .collect();
                let streams: HashMap<_, _> = activation
                    .content()
                    .iter()
                    .filter_map(|object| object.stream.clone().map(|stream| (object.sha256, stream)))
                    .collect();
                let prepared = registry
                    .prepare(self.session.id(), reference.generation, now_ms, &content, &streams)
                    .map_err(|error| {
                        tracing::error!(component = "media", event = "capability_prepare_failed", error = %error);
                        RendererPortError::ResourceUnavailable
                    })?;
                let prepared_frames = registry
                    .prepare_frames(self.session.id(), reference.generation, now_ms, &frames)
                    .map_err(|error| {
                        registry.retire(reference.generation);
                        tracing::error!(component = "media", event = "frame_prepare_failed", error = %error);
                        RendererPortError::ResourceUnavailable
                    })?;
                if let Err(error) = registry.activate(self.session.id(), reference.generation, now_ms) {
                    registry.retire(reference.generation);
                    tracing::error!(component = "media", event = "capability_activate_failed", error = %error);
                    return Err(RendererPortError::ResourceUnavailable);
                }
                CachedGrants { media: prepared, frames: prepared_frames }
            };
            *media = Some((reference, grants));
        }
        let grants = &media.as_ref().expect("current generation has grants").1;
        let resolve = |object| grants.media.get(&object).map(MediaCapability::uri);
        let presentation = wire_document(activation.document(), &resolve)?;
        let content: Vec<RendererMediaRef> = activation
            .content()
            .iter()
            .map(|object| {
                Ok(RendererMediaRef {
                    uri: SafeText::new(resolve(object.sha256).ok_or(RendererPortError::InvalidActivation)?)
                        .map_err(invalid)?,
                    size_bytes: object.size_bytes,
                    mime_type: object.mime_type.clone(),
                })
            })
            .collect::<Result<_, RendererPortError>>()?;
        let frames = frame_authorization_table(activation.frames(), &grants.frames)?;
        if !frames.is_empty() && !session_grants_frames(&self.session) {
            // The renderer never negotiated frame delivery: fail the
            // activation rather than execute frames it cannot confine.
            return Err(RendererPortError::InvalidActivation);
        }
        let context = activation.runtime_context().ok_or(RendererPortError::InvalidActivation)?;
        let mut context: RuntimeContext =
            serde_json::from_value(context.resolve(resolve).map_err(invalid)?).map_err(invalid)?;
        if let Some(timing) = &mut context.timing {
            timing.clock_offset_ms = context.clock_offset_ms;
        }
        if let Some(projection) = &mut context.projection {
            projection.clock_offset_ms = context.clock_offset_ms;
            if !frames.is_empty() {
                if projection.widget_frames.is_some() {
                    // Core never builds the authorization table; a table
                    // already present means a confused upstream.
                    return Err(RendererPortError::InvalidActivation);
                }
                projection.widget_frames = Some(frames.clone());
                if projection.widget_media.is_some() {
                    // Same rule for the opaque-frame media table: only the
                    // port mirrors aliases onto the loopback transport.
                    return Err(RendererPortError::InvalidActivation);
                }
                let registry = self.registry.lock().map_err(|_| RendererPortError::ResourceUnavailable)?;
                let port = *self.loopback_port.lock().map_err(|_| RendererPortError::ResourceUnavailable)?;
                projection.widget_media =
                    widget_media_table(&registry, self.session.id(), &context.aliases, port, now_ms)?;
            }
        } else if !frames.is_empty() {
            return Err(RendererPortError::InvalidActivation);
        }
        let plugins = if context.server_presentation {
            let plugin_content = content
                .iter()
                .filter(|object| context.aliases.iter().any(|alias| alias.uri == object.uri))
                .cloned()
                .collect();
            PluginState {
                plugins: context.plugins,
                content: plugin_content,
                clock_offset_ms: context.clock_offset_ms,
                aliases: context.aliases,
            }
        } else {
            PluginState { plugins: vec![], content: vec![], clock_offset_ms: context.clock_offset_ms, aliases: vec![] }
        };
        let sent = self
            .session
            .send_presentation(reference, presentation, content, frames, context.timing, context.projection)
            .map_err(|_| RendererPortError::QueueUnavailable);
        let plugins_sent = self.send(Event::PluginState(plugins));
        sent.and(plugins_sent)
    }

    fn clear(&self, reason: &edge_protocol::bounded::ShortToken) -> Result<(), RendererPortError> {
        self.send(Event::PresentationClear(PresentationClear { reason: reason.clone() }))
    }

    fn send_command(&self, command_id: uuid::Uuid, command: &SemanticRendererCommand) -> Result<(), RendererPortError> {
        let command = match command {
            SemanticRendererCommand::RetryItem => RendererCommandKind::RetryItem,
            SemanticRendererCommand::SkipItem => RendererCommandKind::SkipItem,
            SemanticRendererCommand::Reload => RendererCommandKind::Reload,
            SemanticRendererCommand::ClearWebsiteData => RendererCommandKind::ClearWebsiteData,
            SemanticRendererCommand::Identify { name, duration_seconds } => {
                return self
                    .send(Event::Identify(Identify { name: name.clone(), duration_seconds: *duration_seconds }));
            }
        };
        self.send(Event::RendererCommand(RendererCommand { command_id, command }))
    }

    fn request_capture(&self, request: RendererCaptureRequest) -> Result<(), RendererPortError> {
        self.send(Event::PreviewRequest(PreviewRequest {
            request_id: request.request_id,
            max_width: request.max_width,
            max_height: request.max_height,
            max_bytes: request.max_bytes,
        }))
    }

    fn request_restart(
        &self,
        reason: &edge_protocol::bounded::ShortToken,
        deadline_ms: u32,
    ) -> Result<(), RendererPortError> {
        self.send(Event::RendererShutdown(RendererShutdown { reason: reason.clone(), deadline_ms }))
    }
}

pub fn evidence(kind: EvidenceKind) -> player_core::ProgressEvidence {
    use player_core::ProgressEvidence as Semantic;
    match kind {
        EvidenceKind::ItemStarted => Semantic::ItemStarted,
        EvidenceKind::ItemTransition => Semantic::ItemTransition,
        EvidenceKind::VideoProgress => Semantic::VideoProgress,
        EvidenceKind::ImageShown => Semantic::ImageShown,
        EvidenceKind::WidgetShown => Semantic::WidgetShown,
        EvidenceKind::WidgetAlive => Semantic::WidgetAlive,
        EvidenceKind::WidgetEmpty => Semantic::WidgetEmpty,
        EvidenceKind::LayoutShown => Semantic::LayoutShown,
        EvidenceKind::LayoutAlive => Semantic::LayoutAlive,
        EvidenceKind::LayoutZoneRendered => Semantic::LayoutZoneRendered,
        EvidenceKind::WebsiteLoaded => Semantic::WebsiteLoaded,
        EvidenceKind::WebsiteAlive => Semantic::WebsiteAlive,
        EvidenceKind::SurfaceShown => Semantic::SurfaceShown,
        EvidenceKind::FrameChanged => Semantic::FrameChanged,
    }
}

pub fn expectation_for(kind: ItemKind) -> Expectation {
    match kind {
        ItemKind::Image => Expectation::Still,
        ItemKind::Video => Expectation::Video,
        ItemKind::Website | ItemKind::Widget | ItemKind::Youtube => Expectation::Website,
        ItemKind::Layout => Expectation::Layout,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_versions_are_independent_of_the_packaged_profile() {
        use player_core::{RendererProfileMismatch, RendererRequirement};
        let frame: Value = serde_json::from_str(include_str!(
            "../../../../packages/edge-protocol/fixtures/ipc/valid/event-renderer-ready.json"
        ))
        .unwrap();
        let mut ready: edge_protocol::ipc::event::RendererReady =
            serde_json::from_value(frame["frame"]["data"].clone()).unwrap();
        let packaged = packaged_profile();
        let schema = RendererRequirement::PresentationSchema(2);
        let component = RendererRequirement::WidgetComponent {
            name: edge_protocol::bounded::ShortToken::new("widget.tilecast.clock").unwrap(),
            version: 2,
        };
        let declarative = RendererRequirement::Declarative {
            name: edge_protocol::bounded::ShortToken::new("content.text").unwrap(),
            version: 1,
        };
        for requirement in [&schema, &component, &declarative] {
            assert_eq!(packaged.check(requirement), Ok(()));
            assert_eq!(
                packaged.check_connected(&connected_profile(&ready), requirement),
                Err(RendererProfileMismatch::Connected)
            );
        }
        ready.support = Some(
            serde_json::from_value(json!({"presentationSchemas": [1,2],
            "declarativeCapabilities": {"content.text": 1}, "widgetComponents": {"widget.tilecast.clock": 2}}))
            .unwrap(),
        );
        for requirement in [&schema, &component, &declarative] {
            assert_eq!(packaged.check_connected(&connected_profile(&ready), requirement), Ok(()));
        }
        ready.support.as_mut().unwrap().widget_components.values_mut().for_each(|v| *v = 99);
        let future = RendererRequirement::WidgetComponent {
            name: edge_protocol::bounded::ShortToken::new("widget.tilecast.clock").unwrap(),
            version: 99,
        };
        assert_eq!(connected_profile(&ready).check(&future), Ok(()));
        assert_eq!(
            packaged.check_connected(&connected_profile(&ready), &future),
            Err(RendererProfileMismatch::Packaged)
        );
    }

    #[test]
    fn projection_supplies_explicit_schema_and_capability_requirements() {
        use player_core::RendererRequirement;
        let mut projection = edge_protocol::ipc::event::ProjectionContext {
            schema: 1,
            clock_offset_ms: 0,
            media: vec![],
            playback: None,
            widget_frames: None,
            widget_media: None,
            manifest: json!({"widgets": [{"presentation": {"schemaVersion": 2, "kind": "component",
                "requiredCapabilities": {"widget.tilecast.clock": 2, "content.text": 1}}}]}),
        };
        let metadata = metadata(
            &PresentationDocument::Setup {},
            crate::presentation::ActivationSource::ServerManifest,
            Some(&projection),
        )
        .unwrap();
        assert!(metadata.requirements.contains(&RendererRequirement::PresentationSchema(2)));
        assert!(metadata.requirements.contains(&RendererRequirement::WidgetComponent {
            name: edge_protocol::bounded::ShortToken::new("widget.tilecast.clock").unwrap(),
            version: 2,
        }));
        assert!(metadata.requirements.contains(&RendererRequirement::Declarative {
            name: edge_protocol::bounded::ShortToken::new("content.text").unwrap(),
            version: 1,
        }));
        projection.manifest["widgets"][0]["presentation"]["requiredCapabilities"]["content.text"] = json!(0);
        assert!(
            super::metadata(
                &PresentationDocument::Setup {},
                crate::presentation::ActivationSource::ServerManifest,
                Some(&projection)
            )
            .is_err()
        );
    }

    #[test]
    fn unknown_runtime_fields_survive_preparation_and_resource_resolution() {
        let digest = Sha256Digest::of(b"verified");
        let source = edge_protocol::ipc::presentation::content_uri(&digest);
        let input = json!({"state": "playing", "futureTransition": {"curve": [0.1, 0.9]},
            "website": {"futureOption": true}, "layout": {"futureProperty": "same", "resource": source}});
        let prepared = payload(input.clone()).unwrap();
        let activation = RendererActivation::new(
            RendererActivationRef {
                activation_id: edge_protocol::ids::ActivationId::from_uuid(uuid::Uuid::nil()),
                generation: 8,
            },
            prepared,
            RendererMetadata {
                requirements: vec![],
                expectations: Default::default(),
                requires_content_evidence: true,
                capture_state: player_core::CaptureState::Presentation,
            },
            vec![VerifiedContentRef {
                sha256: digest,
                size_bytes: 8,
                mime_type: SafeText::new("image/png").unwrap(),
                stream: None,
            }],
            Vec::new(),
            None,
        )
        .unwrap();
        let resolved = wire_document(activation.document(), &|_| Some("authorized resource".into())).unwrap();
        let mut expected = input;
        expected["layout"]["resource"] = json!("authorized resource");
        assert_eq!(resolved, expected);
        assert!(wire_document(activation.document(), &|_| None).is_err());
    }

    #[test]
    fn golden_presentation_shapes_survive_the_semantic_boundary() {
        let digest = Sha256Digest::of(b"fixture");
        let source = edge_protocol::ipc::presentation::content_uri(&digest);
        for encoded in [
            include_str!("../../../../packages/edge-protocol/fixtures/ipc/valid/event-activate-playing.json"),
            include_str!("../../../../packages/edge-protocol/fixtures/ipc/valid/event-activate-idle.json"),
            include_str!(
                "../../../../packages/edge-protocol/fixtures/ipc/valid/event-activate-requires-remote-web.json"
            ),
            include_str!(
                "../../../../packages/edge-protocol/fixtures/ipc/valid/event-activate-projection-playback.json"
            ),
        ] {
            let fixture: Value = serde_json::from_str(encoded).unwrap();
            let original = fixture["frame"]["data"]["presentation"].clone();
            let mut input = original.clone();
            let mut replacements = HashMap::new();
            fn replace(value: &mut Value, source: &str, replacements: &mut HashMap<String, String>) {
                match value {
                    Value::String(text) if text.starts_with("tcmedia://cap/") => {
                        replacements.insert(source.to_owned(), text.clone());
                        *text = source.to_owned();
                    }
                    Value::Array(values) => values.iter_mut().for_each(|value| replace(value, source, replacements)),
                    Value::Object(values) => values.values_mut().for_each(|value| replace(value, source, replacements)),
                    _ => {}
                }
            }
            replace(&mut input, &source, &mut replacements);
            let document: PresentationDocument = serde_json::from_value(input).unwrap();
            let prepared = prepared_document(&document).unwrap();
            let restored: PresentationDocument =
                serde_json::from_value(wire_document(&prepared, &|_| replacements.get(&source).cloned()).unwrap())
                    .unwrap();
            // Compare typed values so serde defaults do not alter the fixture.
            let expected: PresentationDocument = serde_json::from_value(original).unwrap();
            assert_eq!(restored, expected);
        }
    }

    #[test]
    fn runtime_bindings_escape_paths_and_refuse_malformed_or_unavailable_objects() {
        let digest = Sha256Digest::of(b"verified");
        let uri = edge_protocol::ipc::presentation::content_uri(&digest);
        let input = json!({"a/b": {"~": [uri]}, "label": "unchanged"});
        let prepared = payload(input.clone()).unwrap();
        assert_eq!(prepared.bindings()[0].pointer.as_str(), "/a~1b/~0/0");
        assert_eq!(prepared.resolve(|_| Some(uri.clone())).unwrap(), input);
        assert!(prepared.resolve(|_| None).is_err());
        assert_eq!(payload(json!({"src": "TCMEDIA://sha256/../../etc"})), Err(RendererPortError::InvalidActivation));
    }

    #[test]
    fn synchronization_and_plugin_context_keep_their_object_membership() {
        use crate::presentation::{ActivationSource, PlaybackIdentity, ServerExtras};
        let digest = Sha256Digest::of(b"logo");
        let uri = edge_protocol::ipc::presentation::content_uri(&digest);
        let mut activation = Activation {
            id: edge_protocol::ids::ActivationId::from_uuid(uuid::Uuid::nil()),
            generation: 7,
            identity: Some(PlaybackIdentity {
                manifest: digest,
                manifest_version: 3,
                selection_source: "direct",
                playlist_id: None,
                layout_id: None,
                schedule_id: None,
                takeover_id: None,
                next_transition_ms: None,
            }),
            document: PresentationDocument::Setup {},
            renderer_metadata: metadata(&PresentationDocument::Setup {}, ActivationSource::ServerManifest, None)
                .unwrap(),
            content: vec![edge_protocol::ipc::presentation::ContentRef {
                sha256: digest,
                size_bytes: 4,
                mime_type: SafeText::new("image/png").unwrap(),
            }],
            frames: Vec::new(),
            timing: Some(SyncTiming {
                group_id: SafeText::new("group").unwrap(),
                anchor_unix_ms: 42,
                durations_ms: vec![5000],
                clock_offset_ms: 99,
            }),
            source: ActivationSource::ServerManifest,
            extras: ServerExtras {
                plugins: vec![json!({"logo": uri})],
                plugin_aliases: vec![MediaAlias {
                    asset_id: uuid::Uuid::nil(),
                    variant_id: uuid::Uuid::nil(),
                    uri: SafeText::new(&uri).unwrap(),
                }],
                ..ServerExtras::default()
            },
        };
        let prepared = prepare(&activation, 123).unwrap();
        assert_eq!(prepared.reference().generation, 7);
        let context = prepared.runtime_context().unwrap();
        assert_eq!(context.bindings().len(), 2);
        let decoded: RuntimeContext = serde_json::from_value(context.resolve(|_| Some(uri.clone())).unwrap()).unwrap();
        assert_eq!(decoded.clock_offset_ms, 123);
        assert_eq!(decoded.timing.unwrap().anchor_unix_ms, 42);
        assert_eq!(decoded.plugins, activation.extras.plugins);
        assert_eq!(decoded.aliases, activation.extras.plugin_aliases);
        activation.content.clear();
        assert_eq!(prepare(&activation, 123), Err(RendererPortError::InvalidActivation));
    }

    #[test]
    fn packaged_profile_offers_the_frame_execution_abi_at_two() {
        use player_core::RendererRequirement;
        let name =
            || edge_protocol::bounded::ShortToken::new(edge_protocol::frames::EXTERNAL_RUNTIME_CAPABILITY).unwrap();
        packaged_profile()
            .check(&RendererRequirement::WidgetComponent {
                name: name(),
                version: edge_protocol::frames::EXTERNAL_RUNTIME_FRAME_VERSION,
            })
            .expect("external-runtime @2");
        assert!(
            packaged_profile()
                .check(&RendererRequirement::WidgetComponent {
                    name: name(),
                    version: edge_protocol::frames::EXTERNAL_RUNTIME_FRAME_VERSION + 1,
                })
                .is_err()
        );
    }

    #[test]
    fn frame_table_joins_claims_to_confined_uris() {
        let package = Sha256Digest::parse(&"e".repeat(64)).unwrap();
        let document = Sha256Digest::parse(&"f".repeat(64)).unwrap();
        let claim = player_core::VerifiedFrameRef {
            package_id: SafeText::new("acme.athletics").unwrap(),
            package_digest: package,
            sha256: document,
            size_bytes: 512,
        };
        let token = MediaCapability::parse(&"c".repeat(64)).unwrap();
        let table =
            frame_authorization_table(std::slice::from_ref(&claim), &HashMap::from([(document, token)])).unwrap();
        assert_eq!(table.len(), 1);
        assert_eq!(table[0].package_id.as_str(), "acme.athletics");
        assert_eq!(table[0].package_digest, package);
        assert_eq!(table[0].frame_digest, document);
        assert_eq!(table[0].size_bytes, 512);
        assert!(table[0].uri.as_str().starts_with("tcwidget://cap/"));
        assert_eq!(
            frame_authorization_table(std::slice::from_ref(&claim), &HashMap::new()),
            Err(RendererPortError::InvalidActivation)
        );
        assert!(frame_authorization_table(&[], &HashMap::new()).unwrap().is_empty());
    }

    #[test]
    fn extras_streams_become_content_backends_while_uris_stay_opaque() {
        use crate::presentation::{ActivationSource, ServerExtras};
        let digest = Sha256Digest::of(b"streamed");
        let source = player_core::StreamSource::new(
            "/api/v1/player/assets/844f4a48-a47c-4fbd-8a84-f8d61cc64b6a/variants/46784d73-3daf-45cf-8ff0-7cb4a3d12852"
                .to_owned(),
        )
        .unwrap();
        let other = Sha256Digest::of(b"cached");
        let activation = Activation {
            id: edge_protocol::ids::ActivationId::from_uuid(uuid::Uuid::nil()),
            generation: 3,
            identity: None,
            document: PresentationDocument::Setup {},
            renderer_metadata: metadata(&PresentationDocument::Setup {}, ActivationSource::ServerManifest, None)
                .unwrap(),
            content: vec![
                edge_protocol::ipc::presentation::ContentRef {
                    sha256: digest,
                    size_bytes: 8,
                    mime_type: SafeText::new("video/mp4").unwrap(),
                },
                edge_protocol::ipc::presentation::ContentRef {
                    sha256: other,
                    size_bytes: 8,
                    mime_type: SafeText::new("image/png").unwrap(),
                },
            ],
            frames: Vec::new(),
            timing: None,
            source: ActivationSource::ServerManifest,
            extras: ServerExtras {
                streams: std::collections::HashMap::from([(digest, source.clone())]),
                ..ServerExtras::default()
            },
        };
        let prepared = prepare(&activation, 0).unwrap();
        let objects: std::collections::HashMap<_, _> =
            prepared.content().iter().map(|object| (object.sha256, object.stream.clone())).collect();
        assert_eq!(objects[&digest], Some(source));
        assert_eq!(objects[&other], None);
        // The renderer-visible document resolves digests to opaque URIs;
        // the download path never enters the presentation.
        let resolved =
            prepared.document().resolve(&|object| objects.contains_key(&object).then(|| "tcmedia://cap/x".into()));
        let encoded = serde_json::to_string(&resolved.unwrap()).unwrap();
        assert!(!encoded.contains("api/v1"));
    }

    fn granted_alias(session: edge_protocol::ids::SessionId) -> (MediaRegistry, MediaAlias, String) {
        use edge_protocol::ipc::presentation::ContentRef;
        let digest = Sha256Digest::of(b"frame media");
        let content = ContentRef {
            sha256: digest,
            size_bytes: 11,
            mime_type: SafeText::new("image/png").unwrap(),
        };
        let mut registry = MediaRegistry::new();
        registry.bind_renderer(crate::media::RendererInstance {
            session,
            uid: 0,
            pid: 0,
            start_ticks: 0,
        });
        let token = registry
            .prepare(session, 7, 1_700_000_000_000, &[content], &HashMap::new())
            .unwrap()
            .remove(&digest)
            .unwrap();
        registry.activate(session, 7, 1_700_000_000_000).unwrap();
        let alias = MediaAlias {
            asset_id: uuid::Uuid::new_v4(),
            variant_id: uuid::Uuid::new_v4(),
            uri: SafeText::new(token.uri()).unwrap(),
        };
        (registry, alias, token.as_str().to_owned())
    }

    #[test]
    fn widget_media_table_mirrors_live_aliases_onto_loopback() {
        let session = edge_protocol::ids::SessionId::from_uuid(uuid::Uuid::new_v4());
        let (registry, alias, token) = granted_alias(session);
        let table =
            widget_media_table(&registry, session, &[alias.clone()], Some(8471), 1_700_000_000_000)
                .unwrap()
                .unwrap();
        assert_eq!(table.len(), 1);
        assert_eq!(table[0].asset_id, alias.asset_id);
        assert_eq!(table[0].variant_id, alias.variant_id);
        assert_eq!(table[0].uri.as_str(), format!("http://127.0.0.1:8471/media/{token}"));
    }

    #[test]
    fn widget_media_table_omits_without_aliases_or_port() {
        let session = edge_protocol::ids::SessionId::from_uuid(uuid::Uuid::new_v4());
        let (registry, alias, _) = granted_alias(session);
        assert!(
            widget_media_table(&registry, session, &[], Some(8471), 1_700_000_000_000)
                .unwrap()
                .is_none()
        );
        assert!(
            widget_media_table(&registry, session, &[alias], None, 1_700_000_000_000).unwrap().is_none()
        );
    }

    #[test]
    fn widget_media_table_rejects_unresolved_and_retired_aliases() {
        let session = edge_protocol::ids::SessionId::from_uuid(uuid::Uuid::new_v4());
        let (mut registry, alias, _) = granted_alias(session);
        // An alias URI that is not a minted capability means a confused
        // upstream; it must fail the activation, not mint a loopback URL.
        let unresolved = MediaAlias {
            uri: SafeText::new(format!(
                "tcmedia://variant/{}/{}",
                uuid::Uuid::nil(),
                uuid::Uuid::nil()
            ))
            .unwrap(),
            ..alias.clone()
        };
        assert!(
            widget_media_table(&registry, session, &[unresolved], Some(8471), 1_700_000_000_000)
                .is_err()
        );
        // A generation that retired between grant and fill hands frames a
        // dead URL unless the fill fails loudly.
        registry.retire(7);
        assert!(
            widget_media_table(&registry, session, &[alias], Some(8471), 1_700_000_000_000).is_err()
        );
    }
}
