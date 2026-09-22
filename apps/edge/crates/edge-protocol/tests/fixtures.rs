//! Cross-language golden fixtures in `packages/edge-protocol/fixtures`.
//!
//! The Go server and the TypeScript/C clients test against the same files.
//! Signed fixtures are regenerated with `TILECAST_WRITE_FIXTURES=1 cargo test
//! -p edge-protocol --test fixtures`; the Go test then independently signs the
//! same bodies with the same published test seed and must produce identical
//! bytes. Never regenerate to make a failing cross-language test pass.

use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use edge_protocol::canonical::{canonicalize, parse_canonical};
use edge_protocol::ipc::frame;
use edge_protocol::ipc::message::Frame;
use edge_protocol::signed::change::{AuthorityKey, AuthorityTrust, verify_change};
use edge_protocol::signed::{Purpose, SignedDocument, SigningKey, signing_input};
use serde_json::{Value, json};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/edge-protocol/fixtures")
}

fn read(path: &str) -> Value {
    let text = std::fs::read_to_string(fixtures().join(path)).expect("fixture exists");
    serde_json::from_str(&text).expect("fixture is JSON")
}

#[test]
fn canonical_json_cases() {
    let cases = read("canonical-json/cases.json");
    for case in cases["valid"].as_array().expect("valid list") {
        let name = case["name"].as_str().expect("name");
        let input: Value = serde_json::from_str(case["input"].as_str().expect("input")).expect("input json");
        let canonical = canonicalize(&input).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(
            String::from_utf8(canonical.clone()).expect("utf8"),
            case["canonical"].as_str().expect("canonical"),
            "{name}"
        );
        parse_canonical(&canonical).unwrap_or_else(|e| panic!("{name} reparse: {e}"));
    }
    for case in cases["invalid"].as_array().expect("invalid list") {
        let name = case["name"].as_str().expect("name");
        let input = case["input"].as_str().expect("input");
        let result =
            serde_json::from_str::<Value>(input).map_err(|_| ()).and_then(|value| canonicalize(&value).map_err(|_| ()));
        assert!(result.is_err(), "{name} must not canonicalize");
    }
    for case in cases["notCanonical"].as_array().expect("notCanonical list") {
        let name = case["name"].as_str().expect("name");
        assert!(parse_canonical(case["input"].as_str().expect("input").as_bytes()).is_err(), "{name} must be rejected");
    }
}

const TEST_SEED_HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const INSTALLATION: &str = "5a0b8f3e-2c1d-4e6f-8a9b-0c1d2e3f4a5b";

fn seed() -> [u8; 32] {
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&TEST_SEED_HEX[index * 2..index * 2 + 2], 16).expect("hex");
    }
    out
}

fn change_bodies() -> Vec<(&'static str, Value)> {
    vec![
        (
            "presentation changed with object",
            json!({
                "schema": 1,
                "installationId": INSTALLATION,
                "authorityEpoch": 1,
                "sequence": 1234,
                "previousSequence": 1229,
                "type": "screen.presentation.changed",
                "target": {"kind": "screen", "id": "7c9e6679-7425-40de-944b-e07fc1f90ae7"},
                "object": {
                    "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
                    "sizeBytes": 18241,
                    "kind": "presentation_bundle"
                },
                "revocationGeneration": 7,
                "issuedAt": "2026-09-22T19:00:00Z",
                "expiresAt": null,
                "payload": {}
            }),
        ),
        (
            "node revoked with unicode payload text",
            json!({
                "schema": 1,
                "installationId": INSTALLATION,
                "authorityEpoch": 1,
                "sequence": 1240,
                "previousSequence": 1234,
                "type": "edge.node.revoked",
                "target": {"kind": "node", "id": "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a"},
                "object": null,
                "revocationGeneration": 8,
                "issuedAt": "2026-09-22T19:05:00Z",
                "expiresAt": "2027-03-21T19:05:00Z",
                "payload": {
                    "nodeId": "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a",
                    "screenId": null,
                    "certificatesExpireAt": "2027-03-21T19:05:00Z"
                }
            }),
        ),
    ]
}

fn generate_signed() -> Value {
    let key = SigningKey::from_seed(&seed());
    let mut cases = Vec::new();
    let mut last = None;
    for (name, body) in change_bodies() {
        let canonical = canonicalize(&body).expect("canonical");
        let document = key.sign(Purpose::ServerChange, &body, None).expect("sign");
        cases.push(json!({
            "name": name,
            "purpose": "server.change",
            "body": body,
            "canonicalBody": String::from_utf8(canonical.clone()).expect("utf8"),
            "signingInputBase64url": URL_SAFE_NO_PAD.encode(signing_input(Purpose::ServerChange, &canonical)),
            "document": serde_json::to_value(&document).expect("json"),
        }));
        last = Some(document);
    }
    let document = last.expect("at least one case");
    let tamper = |mutate: &dyn Fn(&mut SignedDocument)| {
        let mut copy = document.clone();
        mutate(&mut copy);
        serde_json::to_value(copy).expect("json")
    };
    let tampered = json!([
        {"name": "body altered", "expectError": "bad_signature",
         "document": tamper(&|d| d.body = URL_SAFE_NO_PAD.encode(br#"{"sequence":1}"#))},
        {"name": "signature zeroed", "expectError": "bad_signature",
         "document": tamper(&|d| d.signature.value = URL_SAFE_NO_PAD.encode([0u8; 64]))},
        {"name": "purpose swapped", "expectError": "wrong_purpose",
         "document": tamper(&|d| d.purpose = Purpose::ServerSnapshot)},
        {"name": "unknown key", "expectError": "untrusted_key",
         "document": tamper(&|d| d.signature.key_id = format!("sha256:{}", "0".repeat(64)))},
        {"name": "future format", "expectError": "unsupported_format",
         "document": tamper(&|d| d.format = "tilecast-edge-signed-v2".into())}
    ]);
    json!({
        "description": "Server change envelopes signed with a PUBLISHED TEST SEED. This key is not secret and must never be trusted outside tests.",
        "testSeedHex": TEST_SEED_HEX,
        "publicKeyBase64url": key.public_key().to_base64url(),
        "keyId": key.public_key().key_id(),
        "authorityEpoch": 1,
        "installationId": INSTALLATION,
        "cases": cases,
        "tampered": tampered,
    })
}

#[test]
fn signed_change_fixtures() {
    let path = fixtures().join("signed/server-change-v1.json");
    let generated = generate_signed();
    if std::env::var_os("TILECAST_WRITE_FIXTURES").is_some() {
        let text = serde_json::to_string_pretty(&generated).expect("pretty") + "\n";
        std::fs::write(&path, text).expect("write fixture");
    }
    let stored = read("signed/server-change-v1.json");
    assert_eq!(stored, generated, "signed fixture drifted; see module docs");

    let key = SigningKey::from_seed(&seed());
    let trust = AuthorityTrust {
        installation_id: INSTALLATION.parse().expect("id"),
        keys: vec![AuthorityKey { epoch: 1, public_key: key.public_key().clone() }],
    };
    for case in stored["cases"].as_array().expect("cases") {
        let document: SignedDocument = serde_json::from_value(case["document"].clone()).expect("document");
        let verified = verify_change(&document, &trust).expect("fixture verifies");
        assert_eq!(String::from_utf8(verified.document.body.clone().into_bytes()).expect("utf8"), document.body);
    }
    for case in stored["tampered"].as_array().expect("tampered") {
        let document: SignedDocument = serde_json::from_value(case["document"].clone()).expect("document");
        assert!(verify_change(&document, &trust).is_err(), "{}", case["name"]);
    }
}

#[test]
fn ipc_frame_fixtures() {
    for (directory, valid) in [("ipc/valid", true), ("ipc/invalid", false)] {
        let entries = std::fs::read_dir(fixtures().join(directory)).expect("fixture dir");
        let mut count = 0;
        for entry in entries {
            let path = entry.expect("entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            count += 1;
            let fixture: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
            let payload = serde_json::to_vec(&fixture["frame"]).expect("payload");
            let decoded = frame::encode(&payload).map_err(|e| e.to_string()).and_then(|framed| {
                let mut decoder = frame::FrameDecoder::new();
                decoder.push(&framed);
                let bytes = decoder.next_frame().map_err(|e| e.to_string())?.ok_or("incomplete")?;
                Frame::decode(&bytes).map_err(|e| e.to_string())
            });
            assert_eq!(decoded.is_ok(), valid, "{}: {:?}", path.display(), decoded.err());
            if let Ok(frame) = decoded {
                assert_eq!(frame.to_value(), fixture["frame"], "{} must round-trip", path.display());
            }
        }
        assert!(count > 0, "{directory} has fixtures");
    }
}
