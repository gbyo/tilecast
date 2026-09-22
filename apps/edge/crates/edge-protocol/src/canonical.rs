//! Canonical JSON for signed bodies (an RFC 8785 / JCS subset).
//!
//! Signed Tilecast Edge bodies are serialized with the JSON Canonicalization
//! Scheme, restricted to a subset that every implementation can reproduce
//! byte-for-byte without a floating-point formatter:
//!
//! * values: `null`, booleans, strings, arrays, objects, and **integers** in
//!   the IEEE-754 safe range `[-(2^53-1), 2^53-1]`. Any other number is
//!   rejected, so a signed body can never depend on float formatting.
//! * object members sorted by the UTF-16 code units of their names;
//! * no insignificant whitespace;
//! * strings escaped exactly as ECMAScript `JSON.stringify` does: `\"`, `\\`,
//!   `\b \f \n \r \t`, other controls as lowercase `\u00xx`, everything else
//!   emitted as literal UTF-8.
//!
//! Verification never re-serializes a typed struct. The verifier checks the
//! signature over the exact received bytes and then requires those bytes to
//! equal [`canonicalize`] of their own parse ([`parse_canonical`]). That makes
//! every accepted signed body the unique encoding of its value, which rules
//! out duplicate-key, whitespace and escape-variant tricks, and gives each
//! body one stable digest.
//!
//! The Go implementation lives in `apps/server/internal/edge/canonical.go`.
//! Both are held to `packages/edge-protocol/fixtures/canonical-json/`.

use serde_json::Value;

/// Largest integer magnitude a signed body may contain (2^53 - 1).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Nesting deeper than this is rejected; real bodies are shallow.
pub const MAX_DEPTH: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CanonicalError {
    #[error("signed JSON may contain only integers in the safe range")]
    UnsupportedNumber,
    #[error("signed JSON nesting is too deep")]
    TooDeep,
    #[error("body is not valid JSON")]
    InvalidJson,
    #[error("body is not in canonical form")]
    NotCanonical,
}

/// Serializes `value` in canonical form.
pub fn canonicalize(value: &Value) -> Result<Vec<u8>, CanonicalError> {
    let mut out = Vec::with_capacity(256);
    write_value(value, &mut out, 0)?;
    Ok(out)
}

/// Parses `bytes` and requires them to already be canonical.
pub fn parse_canonical(bytes: &[u8]) -> Result<Value, CanonicalError> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| CanonicalError::InvalidJson)?;
    let again = canonicalize(&value)?;
    if again != bytes {
        return Err(CanonicalError::NotCanonical);
    }
    Ok(value)
}

fn write_value(value: &Value, out: &mut Vec<u8>, depth: usize) -> Result<(), CanonicalError> {
    if depth > MAX_DEPTH {
        return Err(CanonicalError::TooDeep);
    }
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Number(number) => {
            if let Some(unsigned) = number.as_u64() {
                if unsigned > MAX_SAFE_INTEGER {
                    return Err(CanonicalError::UnsupportedNumber);
                }
                out.extend_from_slice(unsigned.to_string().as_bytes());
            } else if let Some(signed) = number.as_i64() {
                if signed.unsigned_abs() > MAX_SAFE_INTEGER {
                    return Err(CanonicalError::UnsupportedNumber);
                }
                out.extend_from_slice(signed.to_string().as_bytes());
            } else {
                return Err(CanonicalError::UnsupportedNumber);
            }
        }
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push(b'[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_value(item, out, depth + 1)?;
            }
            out.push(b']');
        }
        Value::Object(members) => {
            let mut keys: Vec<&String> = members.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push(b'{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                write_string(key, out);
                out.push(b':');
                write_value(&members[key.as_str()], out, depth + 1)?;
            }
            out.push(b'}');
        }
    }
    Ok(())
}

fn write_string(text: &str, out: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    for character in text.chars() {
        match character {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{08}' => out.extend_from_slice(b"\\b"),
            '\u{0c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                let code = c as u32 as usize;
                out.extend_from_slice(b"\\u00");
                out.push(HEX[code >> 4]);
                out.push(HEX[code & 0x0f]);
            }
            c => {
                let mut buffer = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buffer).as_bytes());
            }
        }
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn canon(value: Value) -> String {
        String::from_utf8(canonicalize(&value).expect("canonical")).expect("utf8")
    }

    #[test]
    fn sorts_keys_by_utf16_code_units() {
        // U+1F600 (surrogate pair D83D DE00) sorts before U+FFFD in UTF-16
        // even though its UTF-8 bytes sort after.
        let value = json!({"\u{fffd}": 1, "\u{1f600}": 2, "b": 3, "a": 4, "A": 5});
        assert_eq!(canon(value), "{\"A\":5,\"a\":4,\"b\":3,\"\u{1f600}\":2,\"\u{fffd}\":1}");
    }

    #[test]
    fn escapes_like_json_stringify() {
        let value = json!("q\"b\\\u{8}\u{c}\n\r\t\u{1}\u{1f}\u{7f}é\u{2028}");
        assert_eq!(canon(value), "\"q\\\"b\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}é\u{2028}\"");
    }

    #[test]
    fn rejects_non_integers_and_unsafe_integers() {
        assert_eq!(canonicalize(&json!(1.5)), Err(CanonicalError::UnsupportedNumber));
        assert_eq!(canonicalize(&json!(MAX_SAFE_INTEGER + 1)), Err(CanonicalError::UnsupportedNumber));
        assert_eq!(canonicalize(&json!(-(MAX_SAFE_INTEGER as i64) - 1)), Err(CanonicalError::UnsupportedNumber));
        assert_eq!(canon(json!(-(MAX_SAFE_INTEGER as i64))), "-9007199254740991");
    }

    #[test]
    fn parse_canonical_rejects_variants() {
        assert!(parse_canonical(b"{\"a\":1,\"b\":[true,null]}").is_ok());
        for bad in [
            &b"{\"b\":1,\"a\":2}"[..],
            b"{\"a\": 1}",
            b"{\"a\":1,\"a\":1}",
            b"{\"a\":\"\\u0041\"}",
            b"{\"a\":1.0}",
            b"{\"a\":1e2}",
            b" {\"a\":1}",
        ] {
            assert!(parse_canonical(bad).is_err(), "{:?}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn depth_is_bounded() {
        let mut value = json!(0);
        for _ in 0..=MAX_DEPTH {
            value = json!([value]);
        }
        assert_eq!(canonicalize(&value), Err(CanonicalError::TooDeep));
    }
}
