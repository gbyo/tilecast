//! The Runtime bridge wire format: `TilecastRuntimeHostV1` over WebView2
//! JSON web messaging. The bootstrap (`runtime_host.js`) exposes the single
//! `globalThis.tilecastRuntimeHost` object; every call crosses as one JSON
//! message, validated here before it touches Core.
//!
//! Validated on the way in: the exact trusted source origin (checked by the
//! WebView2 handler against the event source), message schema and type,
//! bounded size, request/correlation IDs, renderer generation, and
//! activation identity where applicable.

use serde_json::Value;

/// Largest Runtime message accepted (64 KiB). Reports are small; anything
/// larger is a bug or an attack.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Largest host message posted to the Runtime (4 MiB: presentations carry
/// manifest subsets).
pub const MAX_HOST_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationRef {
    pub activation_id: uuid::Uuid,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeReady {
    pub contract_version: u32,
    pub runtime_version: String,
    pub support: Option<RuntimeSupport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RuntimeSupport {
    pub presentation_schemas: Vec<u32>,
    pub declarative: Vec<(String, u32)>,
    pub widget_components: Vec<(String, u32)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresentationResult {
    pub activation: Option<ActivationRef>,
    pub accepted: bool,
    pub code: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidenceReport {
    pub activation: Option<ActivationRef>,
    pub item_id: Option<String>,
    pub kind: String,
    pub zone_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaybackErrorReport {
    pub activation: Option<ActivationRef>,
    pub item_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRequest {
    pub id: String,
    pub method: HostMethod,
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostMethod {
    SubmitServerUrl {
        url: String,
    },
    ListDiscoveredServers,
    /// A `remoteWeb.create` spec; the handler validates it and answers
    /// `{ok, target|code}`, so refusals stay typed instead of silent.
    RemoteWebCreate {
        params: Value,
    },
    /// Fire-and-forget surface ops; the handler validates and applies.
    RemoteWebViewport {
        surface_id: String,
        viewport: Value,
    },
    RemoteWebVisible {
        surface_id: String,
        visible: bool,
    },
    RemoteWebMuted {
        surface_id: String,
        muted: bool,
    },
    RemoteWebReload {
        surface_id: String,
    },
    RemoteWebDestroy {
        surface_id: String,
    },
    RemoteWebRecovered,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeMessage {
    Ready(RuntimeReady),
    PresentationResult(PresentationResult),
    Evidence(EvidenceReport),
    PlaybackError(PlaybackErrorReport),
    Request(HostRequest),
}

/// The evidence vocabulary the supervisor understands.
pub const EVIDENCE_KINDS: &[&str] = &[
    "item-started",
    "item-transition",
    "image-shown",
    "video-progress",
    "widget-shown",
    "widget-alive",
    "widget-empty",
    "layout-shown",
    "layout-alive",
    "layout-zone-rendered",
    "website-loaded",
    "website-alive",
    "surface-shown",
];

fn text(value: &Value, max: usize) -> Option<String> {
    value.as_str().map(|text| text.chars().filter(|c| !c.is_control()).take(max).collect())
}

/// Reads an optional text field: missing or null is `None`, a present
/// string is validated, and a present non-string rejects the message.
fn optional_text(object: &serde_json::Map<String, Value>, key: &str, max: usize) -> Option<Option<String>> {
    match object.get(key).filter(|value| !value.is_null()) {
        None => Some(None),
        Some(value) => Some(Some(text(value, max)?)),
    }
}

fn activation_ref(value: &Value) -> Option<Option<ActivationRef>> {
    if value.is_null() {
        return Some(None);
    }
    let object = value.as_object()?;
    let activation_id = object.get("activationId")?.as_str()?.parse::<uuid::Uuid>().ok()?;
    let generation = object.get("generation")?.as_u64()?;
    Some(Some(ActivationRef { activation_id, generation }))
}

fn support(value: &Value) -> Option<RuntimeSupport> {
    let object = value.as_object()?;
    let schemas = object
        .get("presentationSchemas")?
        .as_array()?
        .iter()
        .map(|v| v.as_u64().and_then(|v| u32::try_from(v).ok()))
        .collect::<Option<Vec<_>>>()?;
    let table = |key: &str| -> Option<Vec<(String, u32)>> {
        object
            .get(key)?
            .as_object()?
            .iter()
            .map(|(name, version)| {
                version
                    .as_u64()
                    .and_then(|v| u32::try_from(v).ok())
                    .map(|version| (name.chars().take(128).collect(), version))
            })
            .collect()
    };
    if schemas.len() > 256 {
        return None;
    }
    let declarative = table("declarativeCapabilities")?;
    let widget_components = table("widgetComponents")?;
    if declarative.len() > 256 || widget_components.len() > 256 {
        return None;
    }
    Some(RuntimeSupport { presentation_schemas: schemas, declarative, widget_components })
}

/// Parses and validates one Runtime→host message. Returns `None` for
/// anything malformed, oversized, or outside the V1 vocabulary.
pub fn parse_runtime_message(encoded: &str) -> Option<RuntimeMessage> {
    if encoded.len() > MAX_MESSAGE_BYTES {
        return None;
    }
    let value: Value = serde_json::from_str(encoded).ok()?;
    let object = value.as_object()?;
    match object.get("kind")?.as_str()? {
        "ready" => {
            let contract_version = object.get("contractVersion")?.as_u64()?;
            let runtime_version = text(object.get("runtimeVersion")?, 32)?;
            let support = match object.get("support").filter(|v| !v.is_null()) {
                None => None,
                Some(value) => Some(support(value)?),
            };
            Some(RuntimeMessage::Ready(RuntimeReady {
                contract_version: u32::try_from(contract_version).ok()?,
                runtime_version,
                support,
            }))
        }
        "presentation-result" => {
            let activation = activation_ref(object.get("activation")?)?;
            let accepted = match object.get("outcome")?.as_str()? {
                "accepted" => true,
                "rejected" => false,
                _ => return None,
            };
            let code = optional_text(object, "code", 64)?;
            let message = optional_text(object, "message", 240)?;
            Some(RuntimeMessage::PresentationResult(PresentationResult { activation, accepted, code, message }))
        }
        "evidence" => {
            let activation = activation_ref(object.get("activation")?)?;
            let item_id = optional_text(object, "itemId", 160)?;
            let kind = object.get("evidence")?.as_str()?;
            if !EVIDENCE_KINDS.contains(&kind) {
                return None;
            }
            let zone_id = optional_text(object, "zoneId", 160)?;
            Some(RuntimeMessage::Evidence(EvidenceReport { activation, item_id, kind: kind.to_owned(), zone_id }))
        }
        "playback-error" => {
            let activation = activation_ref(object.get("activation")?)?;
            let item_id = optional_text(object, "itemId", 160)?;
            let message = text(object.get("message")?, 240)?;
            Some(RuntimeMessage::PlaybackError(PlaybackErrorReport { activation, item_id, message }))
        }
        "request" => {
            let id = text(object.get("id")?, 64)?;
            if id.is_empty() {
                return None;
            }
            let method = match object.get("method")?.as_str()? {
                "setup.submitServerUrl" => {
                    let url = text(object.get("params")?.get("url")?, 512)?;
                    HostMethod::SubmitServerUrl { url }
                }
                "discovery.list" => HostMethod::ListDiscoveredServers,
                "remoteWeb.create" => {
                    let params = object.get("params")?.as_object()?;
                    HostMethod::RemoteWebCreate { params: Value::Object(params.clone()) }
                }
                "remoteWeb.updateViewport" => {
                    let params = object.get("params")?.as_object()?;
                    let surface_id = text(params.get("surfaceId")?, 48)?;
                    let viewport = params.get("viewport")?.clone();
                    HostMethod::RemoteWebViewport { surface_id, viewport }
                }
                "remoteWeb.setVisible" => {
                    let params = object.get("params")?.as_object()?;
                    let surface_id = text(params.get("surfaceId")?, 48)?;
                    HostMethod::RemoteWebVisible { surface_id, visible: params.get("visible")?.as_bool()? }
                }
                "remoteWeb.setMuted" => {
                    let params = object.get("params")?.as_object()?;
                    let surface_id = text(params.get("surfaceId")?, 48)?;
                    HostMethod::RemoteWebMuted { surface_id, muted: params.get("muted")?.as_bool()? }
                }
                "remoteWeb.reload" => {
                    let params = object.get("params")?.as_object()?;
                    HostMethod::RemoteWebReload { surface_id: text(params.get("surfaceId")?, 48)? }
                }
                "remoteWeb.destroy" => {
                    let params = object.get("params")?.as_object()?;
                    HostMethod::RemoteWebDestroy { surface_id: text(params.get("surfaceId")?, 48)? }
                }
                "remoteWeb.reportRecovered" => HostMethod::RemoteWebRecovered,
                _ => return None,
            };
            Some(RuntimeMessage::Request(HostRequest { id, method, params: Value::Null }))
        }
        _ => None,
    }
}

/// A host→runtime response to a Runtime request.
pub fn response_message(id: &str, result: Result<Value, &str>) -> Value {
    match result {
        Ok(result) => serde_json::json!({"kind": "response", "id": id, "result": result}),
        Err(error) => serde_json::json!({"kind": "response", "id": id, "error": error}),
    }
}

/// A host→Runtime remote web event (`RemoteWebEventV1`): `surfaceId` is
/// null for host-wide events (`process-terminated`, `recovered`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteWebEvent {
    pub surface_id: Option<String>,
    pub kind: String,
    pub code: Option<String>,
}

/// Wraps a remote web event as the `remote-web` host message the
/// Runtime's remote web port receives.
pub fn remote_web_message(event: &RemoteWebEvent) -> Value {
    serde_json::json!({
        "type": "remote-web",
        "event": {
            "surfaceId": event.surface_id,
            "kind": event.kind,
            "code": event.code,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn activation() -> Value {
        serde_json::json!({"activationId": uuid::Uuid::nil(), "generation": 3})
    }

    #[test]
    fn ready_evidence_results_and_errors_parse() {
        let message = parse_runtime_message(
            &serde_json::json!({
                "kind": "ready", "contractVersion": 1, "runtimeVersion": "0.1.0",
                "support": {"presentationSchemas": [1, 2], "declarativeCapabilities": {"content.text": 1}, "widgetComponents": {}},
            })
            .to_string(),
        );
        assert!(matches!(message, Some(RuntimeMessage::Ready(_))));
        let message = parse_runtime_message(
            &serde_json::json!({
                "kind": "evidence", "activation": activation(),
                "itemId": "item-1", "evidence": "x",
            })
            .to_string(),
        );
        assert_eq!(message, None);
        let message = parse_runtime_message(
            &serde_json::json!({
                "kind": "evidence", "activation": activation(),
                "itemId": "item-1", "evidence": "image-shown",
            })
            .to_string(),
        )
        .expect("evidence");
        assert_eq!(
            message,
            RuntimeMessage::Evidence(EvidenceReport {
                activation: Some(ActivationRef { activation_id: uuid::Uuid::nil(), generation: 3 }),
                item_id: Some("item-1".into()),
                kind: "image-shown".into(),
                zone_id: None,
            })
        );
        let message = parse_runtime_message(
            &serde_json::json!({"kind": "presentation-result", "activation": activation(), "outcome": "rejected", "code": "bad", "message": "no"})
                .to_string(),
        )
        .expect("result");
        assert!(matches!(message, RuntimeMessage::PresentationResult(_)));
        let message = parse_runtime_message(
            &serde_json::json!({"kind": "playback-error", "activation": Value::Null, "itemId": Value::Null, "message": "boom"})
                .to_string(),
        )
        .expect("error");
        assert!(matches!(message, RuntimeMessage::PlaybackError(_)));
    }

    #[test]
    fn unknown_kinds_oversize_and_bad_evidence_are_refused() {
        assert_eq!(parse_runtime_message("{}"), None);
        assert_eq!(parse_runtime_message(r#"{"kind": "exec", "script": "x"}"#), None);
        assert_eq!(
            parse_runtime_message(
                &serde_json::json!({"kind": "evidence", "activation": activation(), "itemId": Value::Null, "evidence": "rm-rf"})
                    .to_string()
            ),
            None
        );
        assert_eq!(
            parse_runtime_message(
                &serde_json::json!({"kind": "ready", "contractVersion": 1, "runtimeVersion": 1}).to_string()
            ),
            None
        );
        assert_eq!(parse_runtime_message(&"x".repeat(MAX_MESSAGE_BYTES + 1)), None);
        assert_eq!(parse_runtime_message(r#"{"kind": "request", "id": "1", "method": "shell.exec"}"#), None);
        let request = parse_runtime_message(
            r#"{"kind": "request", "id": "7", "method": "setup.submitServerUrl", "params": {"url": "https://s.example"}}"#,
        )
        .expect("request");
        assert!(matches!(
            request,
            RuntimeMessage::Request(HostRequest { method: HostMethod::SubmitServerUrl { .. }, .. })
        ));
    }

    #[test]
    fn remote_web_calls_parse_with_typed_params() {
        let create = parse_runtime_message(
            &serde_json::json!({
                "kind": "request", "id": "3", "method": "remoteWeb.create",
                "params": { "surfaceId": "rw-1", "content": { "kind": "page" } },
            })
            .to_string(),
        )
        .expect("create");
        assert!(matches!(
            create,
            RuntimeMessage::Request(HostRequest { method: HostMethod::RemoteWebCreate { .. }, .. })
        ));
        let viewport = parse_runtime_message(
            &serde_json::json!({
                "kind": "request", "id": "4", "method": "remoteWeb.updateViewport",
                "params": { "surfaceId": "rw-1", "viewport": { "x": 0 } },
            })
            .to_string(),
        )
        .expect("viewport");
        assert!(matches!(
            viewport,
            RuntimeMessage::Request(HostRequest { method: HostMethod::RemoteWebViewport { .. }, .. })
        ));
        let muted = parse_runtime_message(
            &serde_json::json!({
                "kind": "request", "id": "5", "method": "remoteWeb.setMuted",
                "params": { "surfaceId": "rw-1", "muted": true },
            })
            .to_string(),
        )
        .expect("muted");
        assert!(matches!(
            muted,
            RuntimeMessage::Request(HostRequest { method: HostMethod::RemoteWebMuted { muted: true, .. }, .. })
        ));
        let recovered = parse_runtime_message(
            &serde_json::json!({ "kind": "request", "id": "6", "method": "remoteWeb.reportRecovered" }).to_string(),
        )
        .expect("recovered");
        assert!(matches!(
            recovered,
            RuntimeMessage::Request(HostRequest { method: HostMethod::RemoteWebRecovered, .. })
        ));
        // Unknown members and mistyped params are refused, never half-run.
        assert_eq!(parse_runtime_message(r#"{"kind": "request", "id": "1", "method": "remoteWeb.exec"}"#), None);
        assert_eq!(
            parse_runtime_message(
                &serde_json::json!({
                    "kind": "request", "id": "1", "method": "remoteWeb.setVisible",
                    "params": { "surfaceId": "rw-1", "visible": "yes" },
                })
                .to_string()
            ),
            None
        );
    }

    #[test]
    fn responses_carry_ids() {
        let ok = response_message("7", Ok(serde_json::json!({"ok": true})));
        assert_eq!((ok["kind"].as_str(), ok["id"].as_str()), (Some("response"), Some("7")));
        let err = response_message("7", Err("denied"));
        assert_eq!(err["error"].as_str(), Some("denied"));
    }

    #[test]
    fn remote_events_reach_the_runtime_port() {
        let loaded = remote_web_message(&RemoteWebEvent {
            surface_id: Some("rw-1".to_string()),
            kind: "loaded".to_string(),
            code: None,
        });
        assert_eq!(loaded["type"].as_str(), Some("remote-web"));
        assert_eq!(loaded["event"]["surfaceId"].as_str(), Some("rw-1"));
        assert_eq!(loaded["event"]["kind"].as_str(), Some("loaded"));
        let failed = remote_web_message(&RemoteWebEvent {
            surface_id: None,
            kind: "process-terminated".to_string(),
            code: None,
        });
        assert!(failed["event"]["surfaceId"].is_null());
        assert_eq!(failed["event"]["kind"].as_str(), Some("process-terminated"));
    }
}
