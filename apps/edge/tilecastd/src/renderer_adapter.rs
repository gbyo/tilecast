//! Edge transport and generation-bound resource encoding for the semantic port.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use edge_ipc::SessionHandle;
use edge_protocol::ipc::event::{
    ActivationRef, Event, Identify, KioskPolicy, MediaAlias, MediaChannelDescriptor, PluginState, PresentationActivate,
    PresentationClear, PreviewRequest, ProjectionContext, RendererCommand, RendererCommandKind, RendererConfigure,
    RendererMediaRef, RendererShutdown, SyncTiming,
};
use edge_protocol::ipc::presentation::{PresentationDocument, parse_content_uri};
use edge_protocol::{Sha256Digest, bounded::SafeText};
use player_core::{
    ObjectBinding, PreparedDocument, RendererActivation, RendererActivationRef, RendererCaptureRequest,
    RendererConfiguration, RendererPort, RendererPortError, Resource, RuntimePayload, SemanticRendererCommand,
    VerifiedContentRef,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    media::{MediaCapability, MediaRegistry},
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

fn resource(value: &str) -> Result<Resource, RendererPortError> {
    if value.to_ascii_lowercase().starts_with("tcmedia:") {
        let object = parse_content_uri(value).ok_or(RendererPortError::InvalidActivation)?;
        Ok(Resource::Object { object })
    } else {
        Ok(Resource::External(SafeText::new(value).map_err(invalid)?))
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

fn prepared_document(document: &PresentationDocument) -> Result<PreparedDocument, RendererPortError> {
    let mut value = serde_json::to_value(document).map_err(invalid)?;
    if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            let src = item["src"].as_str().ok_or(RendererPortError::InvalidActivation)?;
            item["src"] = serde_json::to_value(resource(src)?).map_err(invalid)?;
            for field in ["viewport", "website", "widget", "layout"] {
                if let Some(nested) = item.get_mut(field) {
                    *nested = serde_json::to_value(payload(nested.take())?).map_err(invalid)?;
                }
            }
        }
    }
    if let Some(logo) = value.get_mut("logoSrc") {
        let src = logo.as_str().ok_or(RendererPortError::InvalidActivation)?;
        *logo = serde_json::to_value(resource(src)?).map_err(invalid)?;
    }
    serde_json::from_value(value).map_err(invalid)
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
        })
        .collect();
    RendererActivation::new(
        RendererActivationRef { activation_id: activation.id, generation: activation.generation },
        prepared_document(&activation.document)?,
        content,
        Some(payload(serde_json::to_value(context).map_err(invalid)?)?),
    )
    .map_err(invalid)
}

/// One host endpoint owns resource grants for its live renderer session.
#[derive(Debug)]
pub(crate) struct EdgeRendererPort {
    session: SessionHandle,
    channel: MediaChannelDescriptor,
    registry: Arc<Mutex<MediaRegistry>>,
    media: Mutex<Option<(ActivationRef, HashMap<Sha256Digest, MediaCapability>)>>,
}

impl EdgeRendererPort {
    pub(crate) fn new(
        session: SessionHandle,
        channel: MediaChannelDescriptor,
        registry: Arc<Mutex<MediaRegistry>>,
    ) -> Self {
        Self { session, channel, registry, media: Mutex::new(None) }
    }

    fn send(&self, event: Event) -> Result<(), RendererPortError> {
        self.session.send_event(event).map_err(|_| RendererPortError::QueueUnavailable)
    }
}

fn resolved_resource(
    value: &Value,
    resolve: &impl Fn(Sha256Digest) -> Option<String>,
) -> Result<Value, RendererPortError> {
    let reference: Resource = serde_json::from_value(value.clone()).map_err(invalid)?;
    let text = match reference {
        Resource::Object { object } => resolve(object).ok_or(RendererPortError::InvalidActivation)?,
        Resource::External(text) => text.as_str().to_owned(),
    };
    Ok(Value::String(text))
}

fn wire_document(
    document: &PreparedDocument,
    resolve: &impl Fn(Sha256Digest) -> Option<String>,
) -> Result<PresentationDocument, RendererPortError> {
    let mut value = serde_json::to_value(document).map_err(invalid)?;
    if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
        for item in items {
            item["src"] = resolved_resource(&item["src"], resolve)?;
            for field in ["viewport", "website", "widget", "layout"] {
                if let Some(nested) = item.get_mut(field) {
                    let payload: RuntimePayload = serde_json::from_value(nested.take()).map_err(invalid)?;
                    *nested = payload.resolve(resolve).map_err(invalid)?;
                }
            }
        }
    }
    if let Some(logo) = value.get_mut("logoSrc") {
        *logo = resolved_resource(logo, resolve)?;
    }
    serde_json::from_value(value).map_err(invalid)
}

impl RendererPort for EdgeRendererPort {
    fn configure(&self, configuration: RendererConfiguration) -> Result<(), RendererPortError> {
        self.send(Event::RendererConfigure(RendererConfigure {
            media_channel: self.channel.clone(),
            kiosk: KioskPolicy {
                prevent_display_sleep: configuration.prevent_display_sleep,
                hide_cursor: configuration.hide_cursor,
            },
        }))
    }

    fn activate(&self, activation: &RendererActivation, now_ms: i64) -> Result<(), RendererPortError> {
        let reference = activation.reference();
        let reference = ActivationRef { activation_id: reference.activation_id, generation: reference.generation };
        let mut media = self.media.lock().map_err(|_| RendererPortError::ResourceUnavailable)?;
        if media.as_ref().is_none_or(|(cached, _)| *cached != reference) {
            let mut registry = self.registry.lock().map_err(|_| RendererPortError::ResourceUnavailable)?;
            let grants = if activation.content().is_empty() {
                registry.drain_active(now_ms);
                HashMap::new()
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
                let prepared =
                    registry.prepare(self.session.id(), reference.generation, now_ms, &content).map_err(|error| {
                        tracing::error!(component = "media", event = "capability_prepare_failed", error = %error);
                        RendererPortError::ResourceUnavailable
                    })?;
                if let Err(error) = registry.activate(self.session.id(), reference.generation, now_ms) {
                    registry.retire(reference.generation);
                    tracing::error!(component = "media", event = "capability_activate_failed", error = %error);
                    return Err(RendererPortError::ResourceUnavailable);
                }
                prepared
            };
            *media = Some((reference, grants));
        }
        let grants = &media.as_ref().expect("current generation has grants").1;
        let resolve = |object| grants.get(&object).map(MediaCapability::uri);
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
        let context = activation.runtime_context().ok_or(RendererPortError::InvalidActivation)?;
        let mut context: RuntimeContext =
            serde_json::from_value(context.resolve(resolve).map_err(invalid)?).map_err(invalid)?;
        if let Some(timing) = &mut context.timing {
            timing.clock_offset_ms = context.clock_offset_ms;
        }
        if let Some(projection) = &mut context.projection {
            projection.clock_offset_ms = context.clock_offset_ms;
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
        let sent = self.send(Event::PresentationActivate(Box::new(PresentationActivate {
            activation_id: reference.activation_id,
            generation: reference.generation,
            presentation,
            content,
            timing: context.timing,
            projection: context.projection,
        })));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
            let restored = wire_document(&prepared, &|_| replacements.get(&source).cloned()).unwrap();
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
            content: vec![edge_protocol::ipc::presentation::ContentRef {
                sha256: digest,
                size_bytes: 4,
                mime_type: SafeText::new("image/png").unwrap(),
            }],
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
}
