//! Platform observations for the heartbeat: Android-owned values Core
//! cannot measure itself (update installer state, kiosk/accessibility,
//! commissioning, watchdog) cross from Kotlin as one JSON object and
//! merge into the heartbeat projection.
//!
//! The merge is allowlisted to exact server field names with per-type
//! validation. The server's strict heartbeat decoding refuses the whole
//! message for an unknown field and for several over-long ones, so
//! anything unrecognized or out of range is dropped, never sent. A
//! malformed observation degrades one reading; it must never cost the
//! heartbeat's lifecycle facts.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

/// Capped input: observations are small status facts, not documents.
pub const MAX_OBSERVATIONS_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FieldType {
    /// Short text with a per-field character cap.
    Text(usize),
    /// A JSON boolean.
    Flag,
    /// A non-negative JSON integer with an inclusive maximum.
    Count(i64),
    /// An RFC 3339 moment, stored canonicalized.
    Moment,
    /// A canonical lowercase UUID. The server rejects the whole
    /// heartbeat for a malformed deployment id, so anything else
    /// is dropped here.
    Uuid,
}

/// (server field name, expected type). Text caps match the server's
/// heartbeat validation where it enforces one
/// (`devices/credentials.go`) and stay conservative elsewhere.
const ALLOWLIST: &[(&str, FieldType)] = &[
    ("currentUpdateDeploymentId", FieldType::Uuid),
    ("updateState", FieldType::Text(40)),
    ("updateDownloadedBytes", FieldType::Count(i64::MAX)),
    ("updateExpectedBytes", FieldType::Count(i64::MAX)),
    ("updateError", FieldType::Text(120)),
    ("configuredReliabilityMode", FieldType::Text(40)),
    ("effectiveReliabilityMode", FieldType::Text(40)),
    ("foregroundState", FieldType::Text(40)),
    ("lastForegroundExitAt", FieldType::Moment),
    ("lastForegroundPackage", FieldType::Text(200)),
    ("bootRecoveryResult", FieldType::Text(40)),
    ("lastSuccessfulColdBootAt", FieldType::Moment),
    ("immersiveModeActive", FieldType::Flag),
    ("keepScreenOn", FieldType::Flag),
    ("managedKioskCapability", FieldType::Text(40)),
    ("deviceOwnerState", FieldType::Text(40)),
    ("lockTaskState", FieldType::Text(40)),
    ("accessibilityServiceState", FieldType::Text(40)),
    ("accessibilityReturnState", FieldType::Text(40)),
    ("accessibilityReturnAttempts", FieldType::Count(1_000_000)),
    ("sleepCapability", FieldType::Text(40)),
    ("lastSleepRequestResult", FieldType::Text(120)),
    ("lastWakeResult", FieldType::Text(120)),
    ("recoveryLevel", FieldType::Count(1_000_000)),
    ("recoveryCount", FieldType::Count(1_000_000)),
    ("lastWatchdogFailure", FieldType::Text(120)),
    ("lastWatchdogRecoveryAt", FieldType::Moment),
    ("maintenanceSessionExpiresAt", FieldType::Moment),
    ("adminPinChangedAt", FieldType::Moment),
    ("commissioningState", FieldType::Text(40)),
    ("commissioningStep", FieldType::Text(80)),
    ("commissioningCompletedAt", FieldType::Moment),
    ("cachedFallbackAvailable", FieldType::Flag),
    ("lastSuccessfulSyncAt", FieldType::Moment),
    ("bootAttemptCount", FieldType::Count(1000)),
    ("bootLastAttemptAt", FieldType::Moment),
    ("bootLaunchVerified", FieldType::Flag),
    ("updateReadiness", FieldType::Text(40)),
    ("selfTestResult", FieldType::Text(120)),
    ("selfTestCompletedAt", FieldType::Moment),
];

/// The latest validated platform observations, shared by the JNI
/// setter and the heartbeat projection.
pub type PlatformObservations = Arc<Mutex<BTreeMap<String, serde_json::Value>>>;

pub fn slot() -> PlatformObservations {
    Arc::new(Mutex::new(BTreeMap::new()))
}

fn clean_text(value: &serde_json::Value, max_chars: usize) -> Option<String> {
    let text = value.as_str()?;
    if text.chars().count() > max_chars || text.chars().any(|c| c.is_control()) {
        return None;
    }
    Some(text.to_owned())
}

/// Validates one observation object into the slot, replacing previous
/// values field by field. Returns how many fields were stored.
pub fn apply_observations(slot: &PlatformObservations, json: &str) -> usize {
    if json.len() > MAX_OBSERVATIONS_BYTES {
        return 0;
    }
    let Ok(serde_json::Value::Object(object)) = serde_json::from_str(json) else {
        return 0;
    };
    let mut stored = slot.lock().unwrap_or_else(|error| error.into_inner());
    let mut kept = 0;
    for (name, field) in ALLOWLIST {
        let Some(value) = object.get(*name) else { continue };
        let clean = match field {
            FieldType::Text(max) => clean_text(value, *max).map(serde_json::Value::String),
            FieldType::Flag => value.as_bool().map(serde_json::Value::Bool),
            FieldType::Count(max) => {
                value.as_i64().filter(|count| (0..=*max).contains(count)).map(|count| serde_json::json!(count))
            }
            FieldType::Moment => value
                .as_str()
                .and_then(|text| player_types::Timestamp::parse(text).ok())
                .map(|at| serde_json::Value::String(at.to_string())),
            FieldType::Uuid => value.as_str().and_then(|text| {
                uuid::Uuid::parse_str(text)
                    .ok()
                    .filter(|id| id.to_string() == text)
                    .map(|id| serde_json::json!(id.to_string()))
            }),
        };
        if let Some(clean) = clean {
            stored.insert((*name).to_owned(), clean);
            kept += 1;
        }
    }
    kept
}

/// Merges the stored observations into a heartbeat. Core-owned fields
/// always win: observations only fill fields Core did not set.
pub fn merge_observations(heartbeat: &mut serde_json::Value, slot: &PlatformObservations) {
    let stored = slot.lock().unwrap_or_else(|error| error.into_inner()).clone();
    let Some(object) = heartbeat.as_object_mut() else { return };
    for (name, value) in stored {
        if !object.contains_key(&name) {
            object.insert(name, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observations_keep_valid_fields_and_drop_the_rest() {
        let slot = slot();
        let too_long = "x".repeat(121);
        let kept = apply_observations(
            &slot,
            &format!(
                r#"{{
                "updateState": "installing",
                "updateDownloadedBytes": 1024,
                "immersiveModeActive": true,
                "commissioningState": "in_progress",
                "commissioningCompletedAt": "2026-10-05T00:00:00+02:00",
                "currentUpdateDeploymentId": "0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa",
                "bootAttemptCount": 3,
                "lastMeaningfulProgressAt": "rejected: unknown field",
                "updateExpectedBytes": -5,
                "keepScreenOn": "yes",
                "selfTestResult": "{too_long}",
                "bootLaunchVerified": 1,
                "maintenanceSessionExpiresAt": "not a moment",
                "recoveryLevel": 1.5
            }}"#
            ),
        );
        assert_eq!(kept, 7);
        let stored = slot.lock().expect("lock");
        assert_eq!(stored["updateState"], "installing");
        assert_eq!(stored["updateDownloadedBytes"], 1024);
        assert_eq!(stored["immersiveModeActive"], true);
        assert_eq!(stored["commissioningState"], "in_progress");
        assert_eq!(stored["commissioningCompletedAt"], "2026-10-04T22:00:00Z");
        assert_eq!(stored["currentUpdateDeploymentId"], "0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa");
        assert_eq!(stored["bootAttemptCount"], 3);
        assert!(!stored.contains_key("lastMeaningfulProgressAt"));
        assert!(!stored.contains_key("updateExpectedBytes"));
        assert!(!stored.contains_key("keepScreenOn"));
        assert!(!stored.contains_key("selfTestResult"));
        assert!(!stored.contains_key("bootLaunchVerified"));
        assert!(!stored.contains_key("maintenanceSessionExpiresAt"));
        assert!(!stored.contains_key("recoveryLevel"));
    }

    #[test]
    fn observations_reject_oversized_and_malformed_input() {
        let slot = slot();
        assert_eq!(apply_observations(&slot, "not json"), 0);
        assert_eq!(apply_observations(&slot, "[1, 2]"), 0);
        assert_eq!(apply_observations(&slot, &"x".repeat(MAX_OBSERVATIONS_BYTES + 1)), 0);
        assert!(slot.lock().expect("lock").is_empty());
        // A later report replaces field by field; untouched fields stay.
        assert_eq!(apply_observations(&slot, r#"{"updateState": "idle", "recoveryLevel": 2}"#), 2);
        assert_eq!(apply_observations(&slot, r#"{"updateState": "downloading"}"#), 1);
        let stored = slot.lock().expect("lock");
        assert_eq!(stored["updateState"], "downloading");
        assert_eq!(stored["recoveryLevel"], 2);
    }

    #[test]
    fn merge_never_overwrites_core_fields() {
        let slot = slot();
        assert_eq!(apply_observations(&slot, r#"{"updateState": "idle", "foregroundState": "foreground"}"#), 2);
        let mut heartbeat = serde_json::json!({"playbackState": "playing"});
        merge_observations(&mut heartbeat, &slot);
        assert_eq!(heartbeat["updateState"], "idle");
        assert_eq!(heartbeat["foregroundState"], "foreground");
        assert_eq!(heartbeat["playbackState"], "playing");
    }
}
