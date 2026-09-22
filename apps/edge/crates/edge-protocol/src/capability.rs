//! The Tilecast Edge capability model (RFC §21).
//!
//! A capability describes one thing a node can or cannot do, with enough
//! context for an administrator to understand why. Code decides behavior from
//! capability states and presentation requirement sets, never from a
//! platform string.
//!
//! ```json
//! {
//!   "id": "display.ddc.brightness",
//!   "state": "blocked",
//!   "provider": "ddcutil",
//!   "providerVersion": "2.1.4",
//!   "reasonCode": "i2c_permission_denied",
//!   "detail": "I²C device permission is missing.",
//!   "observedAt": "2026-09-22T19:00:00Z",
//!   "attributes": {}
//! }
//! ```
//!
//! State meanings are exact and shared with the server and Studio:
//!
//! | state | meaning |
//! | --- | --- |
//! | `supported` | implementation exists and the hardware could support it, but it is not usable right now (for example no display connected) |
//! | `available` | usable now |
//! | `degraded` | usable with a known limitation (`reasonCode` says which) |
//! | `blocked` | the hardware/provider exists, but permissions or configuration prevent use |
//! | `unsupported` | no implementation or no hardware |
//!
//! `detail` is safe for administration UI. Providers must never put command
//! output, addresses, device serials or user data in it.
//!
//! Snapshots carry a `revision` that increases only when a capability changes
//! materially ([`Capability::materially_equal`]); the server stores the
//! current snapshot and records Activity on material transitions, never a
//! per-heartbeat history.

use std::collections::BTreeMap;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::bounded::{DetailText, ShortText, ShortToken, Token, bounded_vec};
use crate::time::Timestamp;

pub const CAPABILITY_SCHEMA_V1: u32 = 1;
pub const MAX_CAPABILITIES: usize = 256;
pub const MAX_ATTRIBUTES: usize = 16;

/// Closed set of capability categories (first segment of an ID).
pub const CATEGORIES: &[&str] =
    &["renderer", "video", "mesh", "time", "display", "audio", "input", "network", "system", "external_presentation"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    Supported,
    Available,
    Degraded,
    Blocked,
    Unsupported,
}

impl CapabilityState {
    /// Whether a feature depending on this capability may be used now.
    pub fn is_usable(&self) -> bool {
        matches!(self, Self::Available | Self::Degraded)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("capability id must be a known category followed by 1-5 lowercase segments")]
pub struct CapabilityIdError;

/// A dotted capability identifier such as `display.cec.power`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CapabilityId(String);

impl CapabilityId {
    pub fn new(value: impl Into<String>) -> Result<Self, CapabilityIdError> {
        let value = value.into();
        if value.len() > 96 {
            return Err(CapabilityIdError);
        }
        let mut segments = value.split('.');
        let category = segments.next().ok_or(CapabilityIdError)?;
        if !CATEGORIES.contains(&category) {
            return Err(CapabilityIdError);
        }
        let mut count = 0;
        for segment in segments {
            count += 1;
            let valid = !segment.is_empty()
                && segment.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            if !valid {
                return Err(CapabilityIdError);
            }
        }
        if !(1..=5).contains(&count) {
            return Err(CapabilityIdError);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn category(&self) -> &str {
        self.0.split('.').next().unwrap_or_default()
    }
}

impl Serialize for CapabilityId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for CapabilityId {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

/// A small typed attribute, for example `maxWidth: 3840`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AttributeValue {
    Bool(bool),
    Integer(i64),
    Text(ShortText),
    List(#[serde(deserialize_with = "list16")] Vec<ShortToken>),
}

fn list16<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<ShortToken>, D::Error> {
    bounded_vec(deserializer, 16)
}

fn attributes<'de, D: Deserializer<'de>>(deserializer: D) -> Result<BTreeMap<Token<48>, AttributeValue>, D::Error> {
    let map = BTreeMap::<Token<48>, AttributeValue>::deserialize(deserializer)?;
    if map.len() > MAX_ATTRIBUTES {
        return Err(D::Error::custom("too many capability attributes"));
    }
    Ok(map)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub id: CapabilityId,
    pub state: CapabilityState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ShortToken>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_version: Option<ShortText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<ShortToken>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<DetailText>,
    pub observed_at: Timestamp,
    #[serde(default, deserialize_with = "attributes", skip_serializing_if = "BTreeMap::is_empty")]
    pub attributes: BTreeMap<Token<48>, AttributeValue>,
}

impl Capability {
    /// A capability with only an ID, state and observation time.
    pub fn new(id: CapabilityId, state: CapabilityState, observed_at: Timestamp) -> Self {
        Self {
            id,
            state,
            provider: None,
            provider_version: None,
            reason_code: None,
            detail: None,
            observed_at,
            attributes: BTreeMap::new(),
        }
    }

    /// Equality ignoring `observedAt`. Revisions and Activity events are
    /// driven by this, so re-probing an unchanged capability is free.
    pub fn materially_equal(&self, other: &Capability) -> bool {
        self.id == other.id
            && self.state == other.state
            && self.provider == other.provider
            && self.provider_version == other.provider_version
            && self.reason_code == other.reason_code
            && self.detail == other.detail
            && self.attributes == other.attributes
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SnapshotError {
    #[error("too many capabilities")]
    TooMany,
    #[error("capability {0} appears more than once")]
    Duplicate(String),
}

/// The complete current capability set of a node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilitySnapshot {
    pub schema: u32,
    pub revision: u64,
    pub generated_at: Timestamp,
    #[serde(deserialize_with = "capability_list")]
    pub capabilities: Vec<Capability>,
}

fn capability_list<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Capability>, D::Error> {
    let list: Vec<Capability> = bounded_vec(deserializer, MAX_CAPABILITIES)?;
    let mut seen = std::collections::BTreeSet::new();
    for capability in &list {
        if !seen.insert(capability.id.clone()) {
            return Err(D::Error::custom(format!("duplicate capability {}", capability.id.as_str())));
        }
    }
    Ok(list)
}

impl CapabilitySnapshot {
    /// Builds a snapshot sorted by ID, rejecting duplicates.
    pub fn new(
        revision: u64,
        generated_at: Timestamp,
        mut capabilities: Vec<Capability>,
    ) -> Result<Self, SnapshotError> {
        if capabilities.len() > MAX_CAPABILITIES {
            return Err(SnapshotError::TooMany);
        }
        capabilities.sort_by(|a, b| a.id.cmp(&b.id));
        for pair in capabilities.windows(2) {
            if pair[0].id == pair[1].id {
                return Err(SnapshotError::Duplicate(pair[0].id.as_str().to_owned()));
            }
        }
        Ok(Self { schema: CAPABILITY_SCHEMA_V1, revision, generated_at, capabilities })
    }

    pub fn get(&self, id: &str) -> Option<&Capability> {
        self.capabilities.iter().find(|c| c.id.as_str() == id)
    }

    /// Whether two capability lists differ in any material way.
    pub fn materially_differs(previous: &[Capability], next: &[Capability]) -> bool {
        previous.len() != next.len() || previous.iter().zip(next).any(|(a, b)| !a.materially_equal(b))
    }
}

/// Well-known capability IDs. Providers use these constants rather than
/// string literals so the registry and tests share one spelling.
pub mod ids {
    pub const RENDERER_WPE: &str = "renderer.wpe";
    pub const RENDERER_WPE_DRM: &str = "renderer.wpe.drm";
    pub const RENDERER_WPE_WAYLAND: &str = "renderer.wpe.wayland";
    pub const RENDERER_WPE_HEADLESS: &str = "renderer.wpe.headless";
    pub const MESH_ZENOH: &str = "mesh.zenoh";
    pub const MESH_PEER_CACHE: &str = "mesh.peer_cache";
    pub const TIME_SERVER_OFFSET: &str = "time.server_offset";
    pub const TIME_HOST_SYNC: &str = "time.host_sync";
    pub const TIME_PTP: &str = "time.ptp";
    pub const DISPLAY_CEC_POWER: &str = "display.cec.power";
    pub const DISPLAY_DDC_BRIGHTNESS: &str = "display.ddc.brightness";
    pub const AUDIO_PIPEWIRE: &str = "audio.pipewire";
    pub const NETWORK_PRESENTATION_NETWORK: &str = "network.presentation_network";
    pub const SYSTEM_SYSTEMD_WATCHDOG: &str = "system.systemd_watchdog";
    pub const SYSTEM_STATE_STORE: &str = "system.state_store";
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at() -> Timestamp {
        Timestamp::parse("2026-09-22T19:00:00Z").expect("time")
    }

    #[test]
    fn id_grammar() {
        for good in ["renderer.wpe", "display.ddc.brightness", "video.h264.hardware_decode"] {
            assert!(CapabilityId::new(good).is_ok(), "{good}");
        }
        for bad in ["renderer", "platform.linux", "display..cec", "Display.cec", "a.b.c.d.e.f.g"] {
            assert!(CapabilityId::new(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn decode_rfc_example() {
        let json = r#"{
            "id": "display.ddc.brightness",
            "state": "blocked",
            "provider": "ddcutil",
            "reasonCode": "i2c_permission_denied",
            "detail": "I²C device permission is missing.",
            "observedAt": "2026-09-22T19:00:00Z"
        }"#;
        let capability: Capability = serde_json::from_str(json).expect("valid");
        assert_eq!(capability.state, CapabilityState::Blocked);
        assert!(!capability.state.is_usable());
        assert!(serde_json::from_str::<Capability>(&json.replace("blocked", "maybe")).is_err());
        assert!(
            serde_json::from_str::<Capability>(&json.replace("\"provider\"", "\"extra\": 1, \"provider\"")).is_err()
        );
    }

    #[test]
    fn material_equality_ignores_observation_time() {
        let id = CapabilityId::new("mesh.zenoh").expect("id");
        let a = Capability::new(id.clone(), CapabilityState::Available, at());
        let mut b = a.clone();
        b.observed_at = at().saturating_add(time::Duration::minutes(5));
        assert!(a.materially_equal(&b));
        b.state = CapabilityState::Degraded;
        assert!(!a.materially_equal(&b));
    }

    #[test]
    fn snapshot_sorts_and_rejects_duplicates() {
        let make = |id: &str| Capability::new(CapabilityId::new(id).expect("id"), CapabilityState::Unsupported, at());
        let snapshot = CapabilitySnapshot::new(3, at(), vec![make("time.ptp"), make("audio.pipewire")]).expect("ok");
        assert_eq!(snapshot.capabilities[0].id.as_str(), "audio.pipewire");
        assert_eq!(
            CapabilitySnapshot::new(3, at(), vec![make("time.ptp"), make("time.ptp")]).unwrap_err(),
            SnapshotError::Duplicate("time.ptp".into())
        );
        let json = serde_json::to_string(&snapshot).expect("json");
        let duplicated = json.replace("audio.pipewire", "time.ptp");
        assert!(serde_json::from_str::<CapabilitySnapshot>(&duplicated).is_err());
    }
}
