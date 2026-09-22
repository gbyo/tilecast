//! Typed Context Engine values as they appear on a wire (RFC §18).
//!
//! This module only defines the *shape* of an effective context value so the
//! IPC protocol and mesh can carry it. Merging, freshness policy, source
//! authority and CEL evaluation belong to the future `edge-context` crate and
//! must not be added here. Values are deliberately limited to the RFC's small
//! type set; arbitrary JSON is not context.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

use crate::bounded::{SafeText, ShortToken, bounded_vec};
use crate::time::Timestamp;

pub const MAX_CONTEXT_VALUES: usize = 256;
pub const MAX_LIST_ITEMS: usize = 32;

/// A dotted context key such as `school.phase`.
pub type ContextKey = crate::bounded::Token<96>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    Organization,
    Location,
    DisplayGroup,
    Screen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Freshness {
    Live,
    Stale,
    Expired,
    Unavailable,
}

/// A scalar context value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum ContextScalar {
    Boolean(bool),
    Integer(i64),
    Number(f64),
    String(SafeText<512>),
    Timestamp(Timestamp),
    /// Milliseconds.
    Duration(i64),
    Enum(ShortToken),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ContextData {
    Scalar(ContextScalar),
    List {
        #[serde(deserialize_with = "scalar_list")]
        list: Vec<ContextScalar>,
    },
}

fn scalar_list<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<ContextScalar>, D::Error> {
    bounded_vec(deserializer, MAX_LIST_ITEMS)
}

/// One effective value as delivered to a renderer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextValue {
    pub key: ContextKey,
    pub scope: ScopeKind,
    pub data: ContextData,
    pub freshness: Freshness,
    pub source_id: ShortToken,
    pub source_revision: u64,
    pub observed_at: Timestamp,
    #[serde(default)]
    pub expires_at: Option<Timestamp>,
}

pub fn bounded_values<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<ContextValue>, D::Error> {
    let values: Vec<ContextValue> = bounded_vec(deserializer, MAX_CONTEXT_VALUES)?;
    for value in &values {
        if let ContextData::Scalar(ContextScalar::Number(number)) = value.data
            && !number.is_finite()
        {
            return Err(D::Error::custom("context number must be finite"));
        }
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_scalar_and_list_values() {
        let scalar: ContextValue = serde_json::from_str(
            r#"{"key":"school.phase","scope":"organization","data":{"type":"enum","value":"lunch"},
                "freshness":"live","sourceId":"bell-schedule","sourceRevision":418,
                "observedAt":"2026-09-22T20:10:00Z","expiresAt":"2026-09-22T20:55:00Z"}"#,
        )
        .expect("valid");
        assert_eq!(scalar.freshness, Freshness::Live);
        let list: ContextData =
            serde_json::from_str(r#"{"list":[{"type":"integer","value":4}]}"#).expect("valid");
        assert!(matches!(list, ContextData::List { .. }));
        assert!(serde_json::from_str::<ContextData>(r#"{"type":"object","value":{}}"#).is_err());
    }
}
