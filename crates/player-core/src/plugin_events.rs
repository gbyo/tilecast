//! Ephemeral Plugin API v2 events.
//!
//! `plugin_state` is the durable, reconcilable channel: the Server sends it
//! and a Player replays it. An event is the opposite: one bounded, typed,
//! plugin-scoped fact that crosses between the two Player parts of a single
//! plugin, such as a native input contribution and the portable behavior in
//! the Shared Runtime. Nothing here stores configuration, queues without a
//! bound, or invokes a method by name.
//!
//! Properties, all enforced here and replayed by the shared fixture
//! `packages/player-contracts/fixtures/plugin-events.json`:
//!
//! - an event belongs to one plugin and is declared in that plugin's
//!   manifest with a name, a version, and the side that raises it;
//! - the payload is a small JSON object with fixed byte, depth, and value
//!   limits;
//! - delivery is at most once and ends with the contribution: a disposed or
//!   failed contribution can neither emit nor receive;
//! - each plugin has a fixed number of undelivered events, so a stalled
//!   consumer cannot grow memory. Excess events are refused to the sender.
//!
//! Remote (Server to Player) delivery is not part of this contract. A future
//! channel would produce the same [`PluginEvent`] value and hand it to the
//! same host entry points.
use serde_json::{Map, Value};

/// The `type` of the message that carries one event between a Player host
/// and the Shared Runtime, in both directions.
pub const PLUGIN_EVENT_MESSAGE_TYPE: &str = "plugin-event";

pub const MAX_EVENT_PAYLOAD_BYTES: usize = 2 * 1024;
pub const MAX_EVENT_PAYLOAD_DEPTH: usize = 4;
pub const MAX_EVENT_PAYLOAD_VALUES: usize = 64;
/// Events a plugin may have emitted and not yet delivered.
pub const MAX_PENDING_EVENTS_PER_PLUGIN: usize = 8;
/// Events across every plugin that are emitted and not yet delivered.
pub const MAX_PENDING_EVENTS: usize = 64;

/// Which side of a plugin raises an event. The other side receives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum EventSource {
    /// A native contribution raises it; the Shared Runtime part receives it.
    Native,
    /// The Shared Runtime part raises it; a native contribution receives it.
    Runtime,
}

impl EventSource {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "native" => Some(Self::Native),
            "runtime" => Some(Self::Runtime),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PluginEventError {
    #[error("the event message is malformed")]
    Malformed,
    #[error("the event payload is outside its bounds")]
    Payload,
    #[error("the event is not declared for this contribution")]
    Undeclared,
    #[error("the contribution is no longer active")]
    Inactive,
    #[error("too many undelivered events")]
    Full,
}

/// One event: scoped to a plugin, named, versioned, with a bounded payload.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginEvent {
    pub plugin: String,
    pub name: String,
    pub version: u32,
    pub payload: Value,
}

pub(crate) fn valid_event_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.as_bytes()[0].is_ascii_lowercase()
        && name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_plugin(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && name.as_bytes()[0].is_ascii_lowercase()
        && name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn within_bounds(value: &Value, depth: usize, values: &mut usize) -> bool {
    *values += 1;
    if *values > MAX_EVENT_PAYLOAD_VALUES || depth > MAX_EVENT_PAYLOAD_DEPTH {
        return false;
    }
    match value {
        Value::Array(items) => items.iter().all(|item| within_bounds(item, depth + 1, values)),
        Value::Object(fields) => fields.values().all(|field| within_bounds(field, depth + 1, values)),
        _ => true,
    }
}

/// A payload is a JSON object within the fixed byte, depth, and value limits.
pub fn validate_event_payload(payload: &Value) -> Result<(), PluginEventError> {
    if !payload.is_object() {
        return Err(PluginEventError::Payload);
    }
    let bytes = serde_json::to_vec(payload).map_err(|_| PluginEventError::Payload)?;
    let mut values = 0;
    if bytes.len() > MAX_EVENT_PAYLOAD_BYTES || !within_bounds(payload, 0, &mut values) {
        return Err(PluginEventError::Payload);
    }
    Ok(())
}

impl PluginEvent {
    pub fn new(plugin: &str, name: &str, version: u32, payload: Value) -> Result<Self, PluginEventError> {
        if !valid_plugin(plugin) || !valid_event_name(name) || !(1..=1000).contains(&version) {
            return Err(PluginEventError::Malformed);
        }
        validate_event_payload(&payload)?;
        Ok(Self { plugin: plugin.to_owned(), name: name.to_owned(), version, payload })
    }

    /// The wire message for this event.
    pub fn to_message(&self) -> Value {
        let mut message = Map::new();
        message.insert("type".into(), PLUGIN_EVENT_MESSAGE_TYPE.into());
        message.insert("plugin".into(), self.plugin.clone().into());
        message.insert("event".into(), self.name.clone().into());
        message.insert("version".into(), self.version.into());
        message.insert("payload".into(), self.payload.clone());
        Value::Object(message)
    }

    /// Parse a wire message. Unknown members are refused, like every other
    /// bounded Player message.
    pub fn from_message(message: &Value) -> Result<Self, PluginEventError> {
        let object = message.as_object().ok_or(PluginEventError::Malformed)?;
        let known = ["type", "plugin", "event", "version", "payload"];
        if object.get("type").and_then(Value::as_str) != Some(PLUGIN_EVENT_MESSAGE_TYPE)
            || object.keys().any(|key| !known.contains(&key.as_str()))
        {
            return Err(PluginEventError::Malformed);
        }
        let text = |key: &str| object.get(key).and_then(Value::as_str).ok_or(PluginEventError::Malformed);
        let version = object
            .get("version")
            .and_then(Value::as_u64)
            .and_then(|version| u32::try_from(version).ok())
            .ok_or(PluginEventError::Malformed)?;
        let payload = object.get("payload").cloned().ok_or(PluginEventError::Malformed)?;
        Self::new(text("plugin")?, text("event")?, version, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../../packages/player-contracts/fixtures/plugin-events.json");

    #[test]
    fn replays_the_shared_event_fixture() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        let limits = &fixture["limits"];
        assert_eq!(limits["maxPayloadBytes"], MAX_EVENT_PAYLOAD_BYTES);
        assert_eq!(limits["maxPayloadDepth"], MAX_EVENT_PAYLOAD_DEPTH);
        assert_eq!(limits["maxPayloadValues"], MAX_EVENT_PAYLOAD_VALUES);
        assert_eq!(fixture["messageType"], PLUGIN_EVENT_MESSAGE_TYPE);
        for case in fixture["valid"].as_array().unwrap() {
            let event =
                PluginEvent::from_message(&case["message"]).unwrap_or_else(|error| panic!("{}: {error}", case["name"]));
            assert_eq!(event.to_message(), case["message"], "{}", case["name"]);
        }
        for case in fixture["invalid"].as_array().unwrap() {
            assert!(PluginEvent::from_message(&case["message"]).is_err(), "{}", case["name"]);
        }
        // The size cases are generated rather than checked in.
        let big = json!({"text": "x".repeat(MAX_EVENT_PAYLOAD_BYTES)});
        assert_eq!(validate_event_payload(&big), Err(PluginEventError::Payload));
        let mut deep = json!(1);
        for _ in 0..=MAX_EVENT_PAYLOAD_DEPTH {
            deep = json!({ "n": deep });
        }
        assert_eq!(validate_event_payload(&deep), Err(PluginEventError::Payload));
        let wide: Map<String, Value> = (0..=MAX_EVENT_PAYLOAD_VALUES).map(|i| (format!("k{i}"), json!(i))).collect();
        assert_eq!(validate_event_payload(&Value::Object(wide)), Err(PluginEventError::Payload));
    }

    #[test]
    fn a_payload_is_a_plain_object() {
        for payload in [json!([]), json!(1), json!("text"), Value::Null] {
            assert_eq!(validate_event_payload(&payload), Err(PluginEventError::Payload));
        }
        assert_eq!(validate_event_payload(&json!({})), Ok(()));
    }
}
