//! Edge-local IPC session identity. Generic Player IDs live in player-types.
pub use player_types::ids::*;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{fmt, str::FromStr};
use uuid::Uuid;

macro_rules! uuid_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(Uuid);

        impl $name {
            pub const fn from_uuid(value: Uuid) -> Self {
                Self(value)
            }

            pub const fn as_uuid(&self) -> &Uuid {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, concat!(stringify!($name), "({})"), self.0.hyphenated())
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0.hyphenated(), f)
            }
        }

        impl FromStr for $name {
            type Err = IdParseError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                parse_canonical_uuid(value).map(Self)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.collect_str(&self.0.hyphenated())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let value = String::deserialize(deserializer)?;
                value.parse().map_err(D::Error::custom)
            }
        }
    };
}

uuid_id!(
    /// One accepted Edge local IPC session.
    SessionId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_session_id_preserves_canonical_wire_form() {
        let canonical = "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a";
        let id: SessionId = canonical.parse().expect("canonical session");
        let encoded = serde_json::to_string(&id).expect("encode");
        assert_eq!(encoded, format!("\"{canonical}\""));
        assert_eq!(serde_json::from_str::<SessionId>(&encoded).expect("decode"), id);
        for invalid in [canonical.to_uppercase(), canonical.replace('-', ""), format!("{{{canonical}}}")] {
            assert!(invalid.parse::<SessionId>().is_err());
            assert!(serde_json::from_str::<SessionId>(&format!("\"{invalid}\"")).is_err());
        }
    }
}
