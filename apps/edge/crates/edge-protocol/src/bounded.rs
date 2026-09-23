//! Length- and charset-bounded strings used by wire types.
//!
//! Two shapes cover almost every string that crosses a boundary:
//!
//! * [`Token`]: a machine-readable identifier such as a reason code, provider
//!   name or feature flag. Lowercase ASCII letters, digits, `_`, `-` and `.`,
//!   starting with a letter.
//! * [`SafeText`]: short human-readable text (a bounded detail or error
//!   message). Any Unicode except control characters, trimmed of nothing and
//!   never longer than `MAX` characters.
//!
//! Both validate during deserialization so an oversized or malformed value is
//! a decode error rather than something each caller must remember to check.

use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Why a bounded string was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BoundedError {
    #[error("value is empty")]
    Empty,
    #[error("value is longer than {max} characters")]
    TooLong { max: usize },
    #[error("value contains a character that is not allowed")]
    InvalidCharacter,
}

/// A machine-readable identifier of at most `MAX` bytes.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Token<const MAX: usize>(String);

impl<const MAX: usize> Token<MAX> {
    pub fn new(value: impl Into<String>) -> Result<Self, BoundedError> {
        let value = value.into();
        validate_token(&value, MAX)?;
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

/// Validates the [`Token`] grammar without allocating.
pub fn validate_token(value: &str, max: usize) -> Result<(), BoundedError> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(BoundedError::Empty);
    };
    if value.len() > max {
        return Err(BoundedError::TooLong { max });
    }
    if !first.is_ascii_lowercase() {
        return Err(BoundedError::InvalidCharacter);
    }
    if chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.')) {
        Ok(())
    } else {
        Err(BoundedError::InvalidCharacter)
    }
}

impl<const MAX: usize> fmt::Debug for Token<MAX> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl<const MAX: usize> fmt::Display for Token<MAX> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<const MAX: usize> Serialize for Token<MAX> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for Token<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(D::Error::custom)
    }
}

/// Human-readable text of at most `MAX` characters with no control characters.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SafeText<const MAX: usize>(String);

impl<const MAX: usize> SafeText<MAX> {
    pub fn new(value: impl Into<String>) -> Result<Self, BoundedError> {
        let value = value.into();
        if value.chars().count() > MAX {
            return Err(BoundedError::TooLong { max: MAX });
        }
        if value.chars().any(char::is_control) {
            return Err(BoundedError::InvalidCharacter);
        }
        Ok(Self(value))
    }

    /// Builds text from an arbitrary string by replacing control characters
    /// and truncating to the bound. Use this only for text the daemon itself
    /// produces (for example a local error rendered for an operator), never to
    /// launder a value received from another process.
    pub fn lossy(value: &str) -> Self {
        let cleaned: String = value.chars().map(|c| if c.is_control() { ' ' } else { c }).take(MAX).collect();
        Self(cleaned)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<const MAX: usize> fmt::Debug for SafeText<MAX> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.0, f)
    }
}

impl<const MAX: usize> fmt::Display for SafeText<MAX> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl<const MAX: usize> Serialize for SafeText<MAX> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for SafeText<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(D::Error::custom)
    }
}

/// Deserializes a `Vec` and rejects it when it has more than `max` entries.
/// Used through `#[serde(deserialize_with = ...)]` wrappers below.
pub fn bounded_vec<'de, D, T>(deserializer: D, max: usize) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    let values = Vec::<T>::deserialize(deserializer)?;
    if values.len() > max {
        return Err(D::Error::custom(format!("list has more than {max} entries")));
    }
    Ok(values)
}

/// Standard short identifiers: reason codes, provider names, features.
pub type ShortToken = Token<64>;
/// Standard bounded operator-facing detail text.
pub type DetailText = SafeText<240>;
/// Short version or label strings.
pub type ShortText = SafeText<64>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_grammar() {
        assert!(ShortToken::new("i2c_permission_denied").is_ok());
        assert!(ShortToken::new("renderer.wpe").is_ok());
        assert_eq!(ShortToken::new(""), Err(BoundedError::Empty));
        assert_eq!(ShortToken::new("Upper"), Err(BoundedError::InvalidCharacter));
        assert_eq!(ShortToken::new("9lives"), Err(BoundedError::InvalidCharacter));
        assert_eq!(ShortToken::new("has space"), Err(BoundedError::InvalidCharacter));
        assert_eq!(ShortToken::new("a/b"), Err(BoundedError::InvalidCharacter));
        assert_eq!(ShortToken::new("a".repeat(65)), Err(BoundedError::TooLong { max: 64 }));
    }

    #[test]
    fn safe_text_rejects_controls_and_length() {
        assert!(DetailText::new("I²C device permission is missing.").is_ok());
        assert_eq!(DetailText::new("line\nbreak"), Err(BoundedError::InvalidCharacter));
        assert_eq!(SafeText::<3>::new("four"), Err(BoundedError::TooLong { max: 3 }));
        assert_eq!(SafeText::<4>::lossy("a\u{7}bcdef").as_str(), "a bc");
    }

    #[test]
    fn deserialize_validates() {
        let ok: ShortToken = serde_json::from_str("\"cec-ctl\"").expect("valid token");
        assert_eq!(ok.as_str(), "cec-ctl");
        assert!(serde_json::from_str::<ShortToken>("\"CEC\"").is_err());
        assert!(serde_json::from_str::<ShortToken>("7").is_err());
    }
}
