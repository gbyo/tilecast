//! SHA-256 content identity.
//!
//! A [`Sha256Digest`] is the identity of every immutable object in Tilecast
//! Edge: media variants, Edge objects, release artifacts. On every wire and in
//! every derived filesystem path it is exactly 64 lowercase hexadecimal
//! characters. Strict parsing is what makes it safe to derive a CAS path from
//! a digest: a value that parses can contain nothing but `[0-9a-f]`.

use std::fmt;
use std::str::FromStr;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest as _, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("digest must be 64 lowercase hexadecimal characters")]
pub struct DigestParseError;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Sha256Digest([u8; 32]);

impl Sha256Digest {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Digest of an in-memory byte string.
    pub fn of(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    /// Parses the canonical lowercase form. This is the only parser to use
    /// for values from the network, IPC or the database.
    pub fn parse(value: &str) -> Result<Self, DigestParseError> {
        let bytes = value.as_bytes();
        if bytes.len() != 64 {
            return Err(DigestParseError);
        }
        let mut out = [0u8; 32];
        for (index, pair) in bytes.as_chunks::<2>().0.iter().enumerate() {
            out[index] = (hex_value(pair[0])? << 4) | hex_value(pair[1])?;
        }
        Ok(Self(out))
    }

    /// Parses a digest from legacy Linux Player state or a server manifest,
    /// where historical code compared digests case-insensitively. The result
    /// is canonical; use this only at those import boundaries.
    pub fn parse_legacy_case_insensitive(value: &str) -> Result<Self, DigestParseError> {
        Self::parse(&value.to_ascii_lowercase())
    }

    pub fn to_hex(&self) -> String {
        let mut out = String::with_capacity(64);
        for byte in self.0 {
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
        out
    }

    /// First two hex characters: the CAS fan-out directory name.
    pub fn fanout(&self) -> String {
        let byte = self.0[0];
        let mut out = String::with_capacity(2);
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
        out
    }

    /// Short suffix safe for logs and operator diagnostics.
    pub fn short(&self) -> String {
        self.to_hex()[..12].to_owned()
    }

    /// The HTTP entity tag used for this object by peer and origin blob
    /// endpoints: `"sha256:<hex>"` including the quotes.
    pub fn etag(&self) -> String {
        format!("\"sha256:{}\"", self.to_hex())
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn hex_value(byte: u8) -> Result<u8, DigestParseError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(DigestParseError),
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sha256Digest({})", self.short())
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl FromStr for Sha256Digest {
    type Err = DigestParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl Serialize for Sha256Digest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(D::Error::custom)
    }
}

/// Incremental hasher that yields a [`Sha256Digest`].
#[derive(Debug, Clone, Default)]
pub struct Sha256Hasher(Sha256);

impl Sha256Hasher {
    pub fn new() -> Self {
        Self(Sha256::new())
    }

    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    pub fn finish(self) -> Sha256Digest {
        Sha256Digest(self.0.finalize().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EMPTY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn digest_of_empty_input() {
        assert_eq!(Sha256Digest::of(b"").to_hex(), EMPTY);
        assert_eq!(
            Sha256Digest::parse(EMPTY).expect("valid"),
            Sha256Digest::of(b"")
        );
    }

    #[test]
    fn strict_parse_rejects_path_like_and_uppercase_values() {
        for bad in [
            &EMPTY.to_uppercase(),
            &EMPTY[..63],
            &format!("{EMPTY}0"),
            "../../../../etc/passwd",
            &format!("{}/{}", &EMPTY[..31], &EMPTY[32..]),
            "",
        ] {
            assert!(
                Sha256Digest::parse(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        assert!(Sha256Digest::parse_legacy_case_insensitive(&EMPTY.to_uppercase()).is_ok());
    }

    #[test]
    fn fanout_etag_and_incremental_hashing() {
        let digest = Sha256Digest::parse(EMPTY).expect("valid");
        assert_eq!(digest.fanout(), "e3");
        assert_eq!(digest.etag(), format!("\"sha256:{EMPTY}\""));
        let mut hasher = Sha256Hasher::new();
        hasher.update(b"hello ");
        hasher.update(b"world");
        assert_eq!(hasher.finish(), Sha256Digest::of(b"hello world"));
    }
}
