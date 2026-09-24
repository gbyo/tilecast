//! The ordinary player configuration and command contracts, validated at
//! the server boundary.
//!
//! Commands (`apps/server/internal/httpapi/operations.go`): a poll returns
//! every command in `pending`, `delivered`, `acknowledged` or `running` that
//! has not expired, so an acknowledged command is delivered again until its
//! result arrives. Each item carries a delivery `id` and a semantic
//! `idempotencyKey`. Acknowledging an already settled command answers `200`
//! with its terminal state; an expired or cancelled one answers `409`.
//!
//! Nothing here executes anything. A malformed item is returned as rejected
//! with a bounded reason, so the caller can report it without running it.

use serde_json::{Map, Value};

/// Far above a real configuration document (a few KiB).
pub const MAX_CONFIG_BYTES: usize = 256 * 1024;
/// The server's largest accepted command payload.
pub const MAX_COMMAND_PAYLOAD_BYTES: usize = 8 * 1024;
/// Commands handled per poll. The rest arrive in the next poll: the handled
/// ones are settled and no longer delivered.
pub const MAX_COMMANDS_PER_POLL: usize = 64;
pub const MAX_COMMAND_TYPE_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq)]
pub enum ConfigFetch {
    NotModified,
    Modified { document: Value, etag: Option<String> },
}

/// One validated command delivery.
#[derive(Debug, Clone, PartialEq)]
pub struct ServerCommand {
    pub id: uuid::Uuid,
    pub command_type: String,
    /// Canonical lowercase UUID text, as the legacy player persisted it.
    pub idempotency_key: String,
    pub payload: Map<String, Value>,
}

/// A delivery that failed validation. Only an item with a readable `id` can
/// be answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectedCommand {
    pub id: Option<uuid::Uuid>,
    pub reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct CommandBatch {
    pub commands: Vec<ServerCommand>,
    pub rejected: Vec<RejectedCommand>,
    /// Items beyond [`MAX_COMMANDS_PER_POLL`], left for the next poll.
    pub deferred: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcknowledgeOutcome {
    Acknowledged,
    /// The server already holds a terminal result for this delivery.
    AlreadySettled {
        succeeded: bool,
    },
    /// Expired, cancelled or otherwise not actionable.
    NotActionable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReportOutcome {
    Accepted,
    /// The server can no longer take a result for this delivery.
    NotAccepted,
}

fn valid_command_type(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_COMMAND_TYPE_LEN
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

fn canonical_uuid(value: Option<&Value>) -> Option<uuid::Uuid> {
    edge_protocol::ids::parse_canonical_uuid(value?.as_str()?).ok()
}

fn parse_command(item: &Value) -> Result<ServerCommand, RejectedCommand> {
    let object = item.as_object().ok_or(RejectedCommand { id: None, reason: "command_malformed" })?;
    let id = canonical_uuid(object.get("id")).ok_or(RejectedCommand { id: None, reason: "command_malformed" })?;
    let reject = |reason| RejectedCommand { id: Some(id), reason };
    let command_type = object
        .get("type")
        .and_then(Value::as_str)
        .filter(|value| valid_command_type(value))
        .ok_or(reject("command_type_invalid"))?;
    let key = canonical_uuid(object.get("idempotencyKey")).ok_or(reject("command_idempotency_key_invalid"))?;
    let payload = match object.get("payload") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err(reject("command_invalid_payload")),
    };
    let encoded = serde_json::to_vec(&payload).map_err(|_| reject("command_invalid_payload"))?;
    if encoded.len() > MAX_COMMAND_PAYLOAD_BYTES {
        return Err(reject("command_payload_too_large"));
    }
    Ok(ServerCommand { id, command_type: command_type.to_owned(), idempotency_key: key.to_string(), payload })
}

/// Parses `{"items": [...]}`. `None` when the envelope itself is malformed.
pub fn parse_command_batch(data: &Value) -> Option<CommandBatch> {
    let items = data.get("items")?.as_array()?;
    let mut batch = CommandBatch { deferred: items.len().saturating_sub(MAX_COMMANDS_PER_POLL), ..Default::default() };
    for item in items.iter().take(MAX_COMMANDS_PER_POLL) {
        match parse_command(item) {
            Ok(command) => batch.commands.push(command),
            Err(rejected) => batch.rejected.push(rejected),
        }
    }
    Some(batch)
}

pub fn acknowledge_outcome(data: &Value) -> AcknowledgeOutcome {
    match data.get("state").and_then(Value::as_str) {
        Some("succeeded") => AcknowledgeOutcome::AlreadySettled { succeeded: true },
        Some("failed") => AcknowledgeOutcome::AlreadySettled { succeeded: false },
        _ => AcknowledgeOutcome::Acknowledged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ID: &str = "0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa";
    const KEY: &str = "5c0b1f0e-8f1a-4c55-9a53-27f2f0b2f0aa";

    fn item(overrides: Value) -> Value {
        let mut value = json!({"id": ID, "type": "identify_screen", "idempotencyKey": KEY,
                               "payload": {"durationSeconds": 30}, "state": "delivered"});
        for (key, field) in overrides.as_object().unwrap() {
            value[key] = field.clone();
        }
        value
    }

    #[test]
    fn valid_commands_keep_both_identifiers() {
        let batch = parse_command_batch(&json!({"items": [item(json!({}))]})).unwrap();
        assert_eq!(batch.commands.len(), 1);
        assert_eq!(batch.commands[0].id.to_string(), ID);
        assert_eq!(batch.commands[0].idempotency_key, KEY);
        assert_eq!(batch.commands[0].payload["durationSeconds"], 30);
    }

    #[test]
    fn malformed_items_are_rejected_not_run() {
        let batch = parse_command_batch(&json!({"items": [
            item(json!({"type": "rm -rf /"})),
            item(json!({"idempotencyKey": "not-a-uuid"})),
            item(json!({"payload": [1, 2]})),
            item(json!({"payload": {"x": "a".repeat(MAX_COMMAND_PAYLOAD_BYTES)}})),
            item(json!({"id": ID.to_uppercase()})),
            json!("text"),
        ]}))
        .unwrap();
        assert!(batch.commands.is_empty());
        let reasons: Vec<_> = batch.rejected.iter().map(|r| (r.id.is_some(), r.reason)).collect();
        assert_eq!(
            reasons,
            vec![
                (true, "command_type_invalid"),
                (true, "command_idempotency_key_invalid"),
                (true, "command_invalid_payload"),
                (true, "command_payload_too_large"),
                (false, "command_malformed"),
                (false, "command_malformed"),
            ]
        );
        assert!(parse_command_batch(&json!({"items": {}})).is_none());
    }

    #[test]
    fn a_poll_handles_a_bounded_number_of_items() {
        let items: Vec<Value> = (0..(MAX_COMMANDS_PER_POLL + 5)).map(|_| item(json!({}))).collect();
        let batch = parse_command_batch(&json!({ "items": items })).unwrap();
        assert_eq!(batch.commands.len(), MAX_COMMANDS_PER_POLL);
        assert_eq!(batch.deferred, 5);
    }

    #[test]
    fn acknowledgement_reports_already_settled_commands() {
        assert_eq!(acknowledge_outcome(&json!({"state": "acknowledged"})), AcknowledgeOutcome::Acknowledged);
        assert_eq!(
            acknowledge_outcome(&json!({"state": "succeeded"})),
            AcknowledgeOutcome::AlreadySettled { succeeded: true }
        );
    }
}
