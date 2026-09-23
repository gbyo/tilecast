//! Frame payloads: the JSON object inside each length-prefixed frame.
//!
//! ```json
//! {"type":"hello","minProtocolVersion":1,"maxProtocolVersion":1,"role":"renderer",
//!  "client":"tilecast-renderer-wpe","clientVersion":"0.1.0","features":["image"]}
//! {"type":"welcome","protocolVersion":1,"sessionId":"…","role":"renderer",
//!  "daemonVersion":"0.1.0","features":[],"maxFrameBytes":4194304}
//! {"type":"rejected","code":"unsupported_protocol_version","message":"…",
//!  "minProtocolVersion":1,"maxProtocolVersion":1}
//! {"type":"request","id":"7","method":"status.get","params":{}}
//! {"type":"response","id":"7","result":{…}}
//! {"type":"response","id":"7","error":{"code":"not_authorized","message":"…"}}
//! {"type":"event","seq":1,"event":"renderer.ready","data":{…}}
//! {"type":"goodbye","reason":"daemon_shutdown"}
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::event::{Event, EventError};
use super::method::{Method, MethodError};
use super::{MAX_REQUEST_ID_CHARS, Role};
use crate::bounded::{SafeText, ShortText, ShortToken, Token, bounded_vec};
use crate::ids::SessionId;

fn features<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<ShortToken>, D::Error> {
    bounded_vec(d, 64)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub min_protocol_version: u32,
    pub max_protocol_version: u32,
    pub role: Role,
    pub client: ShortToken,
    pub client_version: ShortText,
    #[serde(deserialize_with = "features")]
    pub features: Vec<ShortToken>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Welcome {
    pub protocol_version: u32,
    pub session_id: SessionId,
    pub role: Role,
    pub daemon_version: ShortText,
    #[serde(deserialize_with = "features")]
    pub features: Vec<ShortToken>,
    pub max_frame_bytes: u32,
}

/// Why a handshake was refused. Closed set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectCode {
    UnsupportedProtocolVersion,
    RolePermissionDenied,
    RoleNotEnabled,
    MalformedHello,
    HandshakeTimeout,
    DaemonUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rejected {
    pub code: RejectCode,
    pub message: SafeText<240>,
    pub min_protocol_version: u32,
    pub max_protocol_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorBody {
    pub code: ShortToken,
    pub message: SafeText<240>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Goodbye {
    pub reason: ShortToken,
}

pub type RequestId = Token<MAX_REQUEST_ID_CHARS>;

#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: RequestId,
    pub method: Method,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub id: RequestId,
    pub outcome: Result<Value, ErrorBody>,
}

impl Response {
    /// Decodes a successful result into its typed form.
    pub fn decode_result<T: serde::de::DeserializeOwned>(&self) -> Result<T, ErrorBody> {
        match &self.outcome {
            Ok(value) => serde_json::from_value(value.clone()).map_err(|_| ErrorBody {
                code: ShortToken::new("invalid_result").unwrap_or_else(|_| unreachable_token()),
                message: SafeText::lossy("response result did not match the expected type"),
            }),
            Err(error) => Err(error.clone()),
        }
    }
}

fn unreachable_token() -> ShortToken {
    // "internal_error" is a valid token; this is only reached if the literal
    // above were ever edited into an invalid one.
    #[allow(clippy::unwrap_used)]
    ShortToken::new("internal_error").unwrap()
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventFrame {
    pub seq: u64,
    pub event: Event,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Hello(Hello),
    Welcome(Welcome),
    Rejected(Rejected),
    Request(Request),
    Response(Response),
    Event(EventFrame),
    Goodbye(Goodbye),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MessageError {
    #[error("frame is not a JSON object with a string type")]
    NotAnObject,
    #[error("unknown frame type {0}")]
    UnknownType(String),
    #[error("malformed {kind} frame: {detail}")]
    Malformed { kind: &'static str, detail: String },
    #[error(transparent)]
    Event(#[from] EventError),
    #[error(transparent)]
    Method(#[from] MethodError),
}

// Wire shapes for the frames whose payload is decoded in a second stage.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestWire {
    #[serde(rename = "type")]
    kind: String,
    id: RequestId,
    method: String,
    params: Value,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponseWire {
    #[serde(rename = "type")]
    kind: String,
    id: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventWire {
    #[serde(rename = "type")]
    kind: String,
    seq: u64,
    event: String,
    data: Value,
}

/// Decodes `payload` into a typed struct after removing the `type` member.
fn typed<T: serde::de::DeserializeOwned>(
    mut object: serde_json::Map<String, Value>,
    kind: &'static str,
) -> Result<T, MessageError> {
    object.remove("type");
    serde_json::from_value(Value::Object(object)).map_err(|e| MessageError::Malformed { kind, detail: e.to_string() })
}

fn with_type<T: Serialize>(kind: &str, value: &T) -> Value {
    let mut value = serde_json::to_value(value).unwrap_or(Value::Null);
    if let Value::Object(object) = &mut value {
        object.insert("type".into(), Value::String(kind.into()));
    }
    value
}

impl Frame {
    /// Parses one frame payload. The caller has already enforced framing.
    pub fn decode(payload: &[u8]) -> Result<Frame, MessageError> {
        let value: Value = serde_json::from_slice(payload).map_err(|_| MessageError::NotAnObject)?;
        let Value::Object(object) = value else {
            return Err(MessageError::NotAnObject);
        };
        let kind = match object.get("type") {
            Some(Value::String(kind)) => kind.clone(),
            _ => return Err(MessageError::NotAnObject),
        };
        match kind.as_str() {
            "hello" => Ok(Frame::Hello(typed(object, "hello")?)),
            "welcome" => Ok(Frame::Welcome(typed(object, "welcome")?)),
            "rejected" => Ok(Frame::Rejected(typed(object, "rejected")?)),
            "goodbye" => Ok(Frame::Goodbye(typed(object, "goodbye")?)),
            "request" => {
                let wire: RequestWire = serde_json::from_value(Value::Object(object))
                    .map_err(|e| MessageError::Malformed { kind: "request", detail: e.to_string() })?;
                Ok(Frame::Request(Request { id: wire.id, method: Method::decode(&wire.method, wire.params)? }))
            }
            "response" => {
                let wire: ResponseWire = serde_json::from_value(Value::Object(object))
                    .map_err(|e| MessageError::Malformed { kind: "response", detail: e.to_string() })?;
                let outcome = match (wire.result, wire.error) {
                    (Some(result), None) => Ok(result),
                    (None, Some(error)) => Err(error),
                    _ => {
                        return Err(MessageError::Malformed {
                            kind: "response",
                            detail: "exactly one of result or error is required".into(),
                        });
                    }
                };
                Ok(Frame::Response(Response { id: wire.id, outcome }))
            }
            "event" => {
                let wire: EventWire = serde_json::from_value(Value::Object(object))
                    .map_err(|e| MessageError::Malformed { kind: "event", detail: e.to_string() })?;
                Ok(Frame::Event(EventFrame { seq: wire.seq, event: Event::decode(&wire.event, wire.data)? }))
            }
            other => Err(MessageError::UnknownType(other.chars().take(32).collect())),
        }
    }

    pub fn to_value(&self) -> Value {
        match self {
            Frame::Hello(hello) => with_type("hello", hello),
            Frame::Welcome(welcome) => with_type("welcome", welcome),
            Frame::Rejected(rejected) => with_type("rejected", rejected),
            Frame::Goodbye(goodbye) => with_type("goodbye", goodbye),
            Frame::Request(request) => serde_json::to_value(RequestWire {
                kind: "request".into(),
                id: request.id.clone(),
                method: request.method.name().into(),
                params: request.method.params(),
            })
            .unwrap_or(Value::Null),
            Frame::Response(response) => {
                let (result, error) = match &response.outcome {
                    Ok(value) => (Some(value.clone()), None),
                    Err(error) => (None, Some(error.clone())),
                };
                serde_json::to_value(ResponseWire { kind: "response".into(), id: response.id.clone(), result, error })
                    .unwrap_or(Value::Null)
            }
            Frame::Event(frame) => serde_json::to_value(EventWire {
                kind: "event".into(),
                seq: frame.seq,
                event: frame.event.name().into(),
                data: frame.event.data(),
            })
            .unwrap_or(Value::Null),
        }
    }

    /// The `id` of a payload that is shaped like a request but whose method
    /// or params failed to decode, so the daemon can answer it with an error
    /// instead of disconnecting.
    pub fn request_id(payload: &[u8]) -> Option<RequestId> {
        let wire: RequestWire = serde_json::from_slice(payload).ok()?;
        (wire.kind == "request").then_some(wire.id)
    }

    /// Serializes the payload (without the length prefix).
    pub fn encode(&self) -> Vec<u8> {
        serde_json::to_vec(&self.to_value()).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::method::Empty;

    #[test]
    fn hello_round_trip_and_strictness() {
        let payload = br#"{"type":"hello","minProtocolVersion":1,"maxProtocolVersion":1,"role":"renderer","client":"tilecast-renderer-wpe","clientVersion":"0.1.0","features":["image"]}"#;
        let frame = Frame::decode(payload).expect("valid hello");
        let Frame::Hello(hello) = &frame else { panic!("expected hello") };
        assert_eq!(hello.role, Role::Renderer);
        assert_eq!(Frame::decode(&frame.encode()).expect("round trip"), frame);

        for bad in [
            &br#"{"type":"hello","minProtocolVersion":1,"maxProtocolVersion":1,"role":"root","client":"x","clientVersion":"1","features":[]}"#[..],
            br#"{"type":"hello","minProtocolVersion":"1","maxProtocolVersion":1,"role":"renderer","client":"x","clientVersion":"1","features":[]}"#,
            br#"{"type":"hello","minProtocolVersion":1,"maxProtocolVersion":1,"role":"renderer","client":"x","clientVersion":"1","features":[],"uid":0}"#,
            br#"["hello"]"#,
            br#"{"kind":"hello"}"#,
            b"\xff\xfe",
        ] {
            assert!(Frame::decode(bad).is_err(), "{}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn request_response_shapes() {
        let request =
            Frame::Request(Request { id: RequestId::new("r1").expect("id"), method: Method::StatusGet(Empty {}) });
        assert_eq!(Frame::decode(&request.encode()).expect("round trip"), request);
        assert!(
            Frame::decode(br#"{"type":"response","id":"r1","result":{},"error":{"code":"x","message":"y"}}"#).is_err()
        );
        assert!(Frame::decode(br#"{"type":"response","id":"r1"}"#).is_err());
        let ok = Frame::decode(br#"{"type":"response","id":"r1","error":{"code":"not_authorized","message":"no"}}"#)
            .expect("valid");
        let Frame::Response(response) = ok else { panic!("expected response") };
        assert!(response.outcome.is_err());
        assert!(Frame::decode(br#"{"type":"request","id":"Bad Id","method":"ping","params":{}}"#).is_err());
    }

    #[test]
    fn unknown_type_is_rejected() {
        assert!(matches!(Frame::decode(br#"{"type":"exec","cmd":"rm -rf /"}"#), Err(MessageError::UnknownType(_))));
    }
}
