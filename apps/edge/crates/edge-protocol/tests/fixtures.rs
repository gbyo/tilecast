//! Cross-language golden fixtures in `packages/edge-protocol/fixtures`.
//!
//! The renderer (C) and future clients test against the same files. Never
//! edit a fixture to make a failing test pass: a changed fixture is a
//! changed wire format.

use std::path::PathBuf;

use edge_protocol::ipc::frame;
use edge_protocol::ipc::message::Frame;
use serde_json::Value;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/edge-protocol/fixtures")
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
