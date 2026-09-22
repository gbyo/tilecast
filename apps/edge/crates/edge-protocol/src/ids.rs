//! Strictly parsed UUID identifiers.
//!
//! Tilecast identifiers are UUIDs in canonical lowercase hyphenated form on
//! every wire. The `uuid` crate also accepts braced, URN and simple forms; the
//! newtypes here do not, so one identifier always has exactly one textual
//! representation. That matters for signed bodies (a different spelling would
//! be a different signature) and for keyspace construction.
//!
//! The newtypes are distinct types so an installation ID can never be passed
//! where a node ID is expected.

use std::fmt;
use std::str::FromStr;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("identifier must be a lowercase hyphenated UUID")]
pub struct IdParseError;

/// Parses the canonical 36-character lowercase hyphenated UUID form only.
pub fn parse_canonical_uuid(value: &str) -> Result<Uuid, IdParseError> {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return Err(IdParseError);
    }
    for (index, byte) in bytes.iter().enumerate() {
        let hyphen = matches!(index, 8 | 13 | 18 | 23);
        let valid = if hyphen { *byte == b'-' } else { byte.is_ascii_digit() || (b'a'..=b'f').contains(byte) };
        if !valid {
            return Err(IdParseError);
        }
    }
    Uuid::parse_str(value).map_err(|_| IdParseError)
}

macro_rules! uuid_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(Uuid);

        impl $name {
            pub const fn from_uuid(value: Uuid) -> Self {
                Self(value)
            }

            pub fn new_random() -> Self {
                Self(Uuid::new_v4())
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
    /// The permanent identity of one Tilecast Server installation
    /// (`organization_settings.installation_id`). Every Edge certificate,
    /// signed document and mesh key is scoped to exactly one.
    InstallationId
);
uuid_id!(
    /// The durable identity of one Edge node. It is the Linux player's
    /// `playerInstallationId`, generated once on the device and preserved
    /// across upgrades, so the server and legacy player already know it.
    NodeId
);
uuid_id!(
    /// A logical Tilecast screen record on the server. A node's screen can
    /// change through re-pairing or hardware replacement; its node ID cannot.
    ScreenId
);
uuid_id!(
    /// One daemon-initiated presentation activation sent to a renderer.
    ActivationId
);
uuid_id!(
    /// One accepted local IPC session.
    SessionId
);

/// Generic serde helper for canonical UUIDs that do not have a newtype.
pub mod canonical_uuid {
    use super::*;

    pub fn serialize<S: Serializer>(value: &Uuid, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&value.hyphenated())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Uuid, D::Error> {
        let value = String::deserialize(deserializer)?;
        parse_canonical_uuid(&value).map_err(D::Error::custom)
    }
}

/// Serde helper for optional canonical UUIDs.
pub mod canonical_uuid_option {
    use super::*;

    pub fn serialize<S: Serializer>(value: &Option<Uuid>, serializer: S) -> Result<S::Ok, S::Error> {
        match value {
            Some(value) => serializer.collect_str(&value.hyphenated()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Uuid>, D::Error> {
        let value = Option::<String>::deserialize(deserializer)?;
        value.map(|value| parse_canonical_uuid(&value).map_err(D::Error::custom)).transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a";

    #[test]
    fn parses_only_canonical_form() {
        let parsed: NodeId = ID.parse().expect("canonical");
        assert_eq!(parsed.to_string(), ID);
        for bad in [
            "1F0C3C9E-7D2A-4B6E-9A51-0C8F2E4D6B7A",
            "{1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a}",
            "urn:uuid:1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a",
            "1f0c3c9e7d2a4b6e9a510c8f2e4d6b7a",
            "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7",
            "",
        ] {
            assert!(bad.parse::<NodeId>().is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn serde_round_trip() {
        let id: InstallationId = ID.parse().expect("canonical");
        let json = serde_json::to_string(&id).expect("serialize");
        assert_eq!(json, format!("\"{ID}\""));
        let back: InstallationId = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, id);
        assert!(serde_json::from_str::<InstallationId>("\"not-a-uuid\"").is_err());
    }
}
