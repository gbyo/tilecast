//! Semantic verified-object bindings inside Runtime-owned data.
use std::collections::BTreeSet;

use player_types::{Sha256Digest, bounded::SafeText};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_RESOURCE_BINDINGS: usize = 1024;
pub const MAX_RUNTIME_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

/// A local verified object or an unchanged external Runtime value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Resource {
    Object { object: Sha256Digest },
    External(SafeText<2048>),
}

/// The location of one verified object in Runtime-owned JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectBinding {
    pub pointer: SafeText<4096>,
    pub object: Sha256Digest,
}

/// Bounded Runtime data with resource transport removed.
/// Binding locations contain an empty string until the host resolves them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RuntimePayload {
    value: Value,
    bindings: Vec<ObjectBinding>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResourceError {
    #[error("runtime payload exceeds its bound")]
    TooLarge,
    #[error("runtime payload has an invalid object binding")]
    InvalidBinding,
    #[error("runtime payload references an unavailable object")]
    UnavailableObject,
}

impl RuntimePayload {
    pub fn new(value: Value, bindings: Vec<ObjectBinding>) -> Result<Self, ResourceError> {
        if bindings.len() > MAX_RESOURCE_BINDINGS
            || serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_RUNTIME_PAYLOAD_BYTES)
        {
            return Err(ResourceError::TooLarge);
        }
        let mut pointers = BTreeSet::new();
        for binding in &bindings {
            if value.pointer(binding.pointer.as_str()).and_then(Value::as_str) != Some("")
                || !pointers.insert(binding.pointer.as_str())
            {
                return Err(ResourceError::InvalidBinding);
            }
        }
        Ok(Self { value, bindings })
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn bindings(&self) -> &[ObjectBinding] {
        &self.bindings
    }

    /// The host chooses a safe resource mechanism for the valid generation.
    pub fn resolve(&self, mut resource: impl FnMut(Sha256Digest) -> Option<String>) -> Result<Value, ResourceError> {
        let mut value = self.value.clone();
        for binding in &self.bindings {
            let resolved = resource(binding.object).ok_or(ResourceError::UnavailableObject)?;
            *value.pointer_mut(binding.pointer.as_str()).ok_or(ResourceError::InvalidBinding)? =
                Value::String(resolved);
        }
        Ok(value)
    }
}

impl<'de> Deserialize<'de> for RuntimePayload {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            value: Value,
            bindings: Vec<ObjectBinding>,
        }
        let raw = Raw::deserialize(decoder)?;
        Self::new(raw.value, raw.bindings).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding(pointer: &str) -> ObjectBinding {
        ObjectBinding { pointer: SafeText::new(pointer).unwrap(), object: Sha256Digest::of(b"verified") }
    }

    #[test]
    fn host_resolves_only_declared_objects_and_leaves_runtime_fields_unchanged() {
        let payload = RuntimePayload::new(json!({"image": "", "text": "Hello"}), vec![binding("/image")]).unwrap();
        let resolved = payload
            .resolve(|object| (object == Sha256Digest::of(b"verified")).then(|| "host resource".into()))
            .unwrap();
        assert_eq!(resolved, json!({"image": "host resource", "text": "Hello"}));
        assert_eq!(payload.resolve(|_| None), Err(ResourceError::UnavailableObject));
        assert_eq!(payload.value()["image"], "");
    }

    #[test]
    fn malformed_and_duplicate_bindings_are_refused() {
        for bindings in [vec![binding("/missing")], vec![binding("/image"), binding("/image")]] {
            assert_eq!(RuntimePayload::new(json!({"image": ""}), bindings), Err(ResourceError::InvalidBinding));
        }
        assert_eq!(
            RuntimePayload::new(json!({"image": "already bound"}), vec![binding("/image")]),
            Err(ResourceError::InvalidBinding)
        );
    }

    #[test]
    fn escaped_paths_round_trip_and_invalid_encoded_bindings_are_refused() {
        let payload = RuntimePayload::new(json!({"a/b": {"~": ""}}), vec![binding("/a~1b/~0")]).unwrap();
        let encoded = serde_json::to_value(&payload).unwrap();
        assert_eq!(serde_json::from_value::<RuntimePayload>(encoded.clone()).unwrap(), payload);
        assert_eq!(payload.resolve(|_| Some("resolved".into())).unwrap(), json!({"a/b": {"~": "resolved"}}));
        let mut invalid = encoded;
        invalid["bindings"][0]["pointer"] = json!("/missing");
        assert!(serde_json::from_value::<RuntimePayload>(invalid).is_err());
    }

    #[test]
    fn runtime_data_and_binding_lists_are_bounded() {
        assert_eq!(
            RuntimePayload::new(json!("x".repeat(MAX_RUNTIME_PAYLOAD_BYTES)), vec![]),
            Err(ResourceError::TooLarge)
        );
        assert_eq!(
            RuntimePayload::new(json!({"image": ""}), vec![binding("/image"); MAX_RESOURCE_BINDINGS + 1]),
            Err(ResourceError::TooLarge)
        );
    }
}
