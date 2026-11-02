//! The shipped Edge update helper as an oracle for the bridge release.
//!
//! This file is not part of the current workspace. `legacy_oracle.py` copies it
//! into a checkout of the shipped `edge-v0.2.1-preview.1` tag, as a test module
//! of `tilecast-edge-update`, and runs it there. Everything it calls is that
//! tag's own code: the update helper's state machine (`Updater`), the envelope
//! and manifest verification of `edge-release`, the archive staging, and the
//! helper's in-memory host. Nothing here re-implements a rule.
//!
//! Two tests, both ignored unless the script runs them:
//!
//! * `legacy_helper_installs_the_bridge_and_refuses_unified_releases` works on
//!   a shared directory `bridge_produce` (in this repository's helper crate)
//!   filled with signed candidates. It shows what the shipped helper does with
//!   a unified release (refuses it) and with the bridge (installs, activates
//!   and confirms it), and leaves its layout and transaction record for the
//!   current helper to continue from.
//! * `legacy_helper_against_real_assets` does the same with real release assets
//!   signed with the real key: the published preview, then the bridge a release
//!   build produced. It is how a bridge release is verified before it is
//!   published (`edge_bridge.py verify`).

#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use edge_release::install::{StageOutcome, current_version, installed_versions, switch_current};
use edge_release::manifest::{DEFAULT_PUBLIC_KEY, decode_key};
use edge_release::protocol::Phase;
use edge_release::testing::layout;

use crate::fake::FakeHost;
use crate::transaction::TransactionStore;
use crate::updater::{HelperPaths, Timing, UpdateError, Updater};

const TIMING: Timing = Timing {
    provisional: Duration::from_secs(600),
    daemon_restart_limit: 3,
    renderer_restart_limit: 5,
    after_rollback_wait: Duration::from_secs(10),
    poll: Duration::from_secs(1),
};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

struct Candidate {
    envelope: Vec<u8>,
    signature: Vec<u8>,
    artifact: String,
}

/// Puts an archive where `tilecastd` would have left it, in the content store.
fn place_in_store(dir: &Path, archive: &[u8]) -> String {
    let digest = edge_protocol::Sha256Digest::of(archive);
    let object = dir.canonicalize().unwrap().join("cas").join("sha256").join(digest.fanout()).join(digest.to_hex());
    std::fs::create_dir_all(object.parent().unwrap()).unwrap();
    std::fs::write(&object, archive).unwrap();
    digest.to_hex()
}

fn candidate(dir: &Path, envelope: &Path, signature: &Path, archive: &Path) -> Candidate {
    Candidate {
        envelope: std::fs::read(envelope).unwrap(),
        signature: std::fs::read(signature).unwrap(),
        artifact: place_in_store(dir, &std::fs::read(archive).unwrap()),
    }
}

async fn stage(updater: &Updater<'_, FakeHost>, candidate: &Candidate) -> Result<StageOutcome, UpdateError> {
    updater.stage(&candidate.artifact, &candidate.envelope, &candidate.signature).await
}

fn updater_in<'a>(dir: &Path, host: &'a FakeHost, key: [u8; 32]) -> Updater<'a, FakeHost> {
    let paths = HelperPaths { cas_root: dir.canonicalize().unwrap().join("cas"), tilecast_uid: None, reserve_bytes: 0 };
    Updater::new(host, layout(dir), TransactionStore::new(dir.join("update-state")), key, paths).with_timing(TIMING)
}

/// Activates and confirms `version` the way production does, and returns the
/// phase the transaction ended in.
async fn install(updater: &Updater<'_, FakeHost>, version: &str) -> Phase {
    let provisional = updater.activate(version).await.unwrap();
    assert_eq!(provisional.phase, Phase::Provisional, "{version}");
    updater.confirm(version).await.unwrap().phase
}

#[tokio::test]
#[ignore = "run by apps/edge/release/legacy_oracle.py"]
async fn legacy_helper_installs_the_bridge_and_refuses_unified_releases() {
    let dir = PathBuf::from(env("TILECAST_BRIDGE_PATH_DIR"));
    let base = env("TILECAST_BRIDGE_BASE");
    let bridge = env("TILECAST_BRIDGE_VERSION");
    let unified = env("TILECAST_BRIDGE_UNIFIED");
    let key = decode_key(std::fs::read_to_string(dir.join("key.pub")).unwrap().trim()).unwrap();
    let layout = layout(&dir);
    let host = FakeHost::new(layout.install_root.clone());
    host.with(|s| s.running_version = current_version(&layout));
    assert_eq!(current_version(&layout).as_deref(), Some(base.as_str()), "the preview is installed and current");
    let updater = updater_in(&dir, &host, key);
    let load = |version: &str| {
        let home = dir.join("candidates").join(version);
        candidate(&dir, &home.join("envelope.json"), &home.join("envelope.sig"), &home.join("archive.tar.zst"))
    };

    // The shipped helper refuses every unified release, before it stages anything.
    let mut refused = serde_json::Map::new();
    for version in unified.split_whitespace() {
        let error = stage(&updater, &load(version)).await.unwrap_err();
        refused.insert(version.into(), error.reason_code().into());
    }
    assert_eq!(installed_versions(&layout).unwrap(), vec![base.clone()], "a refused release leaves nothing behind");

    // It installs the bridge: a legacy name and code.
    assert_eq!(stage(&updater, &load(&bridge)).await.unwrap(), StageOutcome::Staged { version: bridge.clone() });
    assert_eq!(install(&updater, &bridge).await, Phase::Confirmed);
    assert_eq!(current_version(&layout).as_deref(), Some(bridge.as_str()));

    // While it is still running, with the bridge current, it still refuses a
    // unified release. It exits after a minute without a request, and the
    // bridge's own helper starts next (docs/release-process.md).
    let still = stage(&updater, &load(unified.split_whitespace().next().unwrap())).await.unwrap_err();
    let results = serde_json::json!({
        "unified_refused": refused,
        "bridge_phase": "confirmed",
        "unified_refused_after_bridge": still.reason_code(),
    });
    std::fs::write(dir.join("legacy-results.json"), serde_json::to_vec_pretty(&results).unwrap()).unwrap();
}

/// The shipped helper against real assets. `TILECAST_BRIDGE_ORACLE_ASSETS`
/// holds `base/` and `bridge/`, each with `update.json`, `update.json.sig` and
/// `archive.tar.zst` for the host architecture. The base is the published
/// preview (or any release the shipped helper can stage). The key is the real
/// signing key unless `key.pub` is present.
#[tokio::test]
#[ignore = "run by apps/edge/release/legacy_oracle.py"]
async fn legacy_helper_against_real_assets() {
    let assets = PathBuf::from(env("TILECAST_BRIDGE_ORACLE_ASSETS"));
    let work = PathBuf::from(env("TILECAST_BRIDGE_ORACLE_WORK"));
    let base_version = env("TILECAST_BRIDGE_BASE");
    let bridge_version = env("TILECAST_BRIDGE_VERSION");
    let key_text = std::fs::read_to_string(assets.join("key.pub")).unwrap_or_else(|_| DEFAULT_PUBLIC_KEY.to_owned());
    let key = decode_key(key_text.trim()).unwrap();
    let layout = layout(&work);
    let host = FakeHost::new(layout.install_root.clone());
    let updater = updater_in(&work, &host, key);
    let load = |name: &str| {
        let home = assets.join(name);
        candidate(&work, &home.join("update.json"), &home.join("update.json.sig"), &home.join("archive.tar.zst"))
    };

    // The preview as it was installed: staged by the same code, made current.
    assert_eq!(stage(&updater, &load("base")).await.unwrap(), StageOutcome::Staged { version: base_version.clone() });
    switch_current(&layout, &base_version).unwrap();
    host.with(|s| s.running_version = Some(base_version.clone()));

    // The bridge release a build produced, installed by the preview's helper.
    assert_eq!(stage(&updater, &load("bridge")).await.unwrap(), StageOutcome::Staged { version: bridge_version.clone() });
    assert_eq!(install(&updater, &bridge_version).await, Phase::Confirmed);
    assert_eq!(current_version(&layout).as_deref(), Some(bridge_version.as_str()));
    std::fs::write(work.join("real-results.json"), br#"{"bridge_installed_by_shipped_helper": true}"#).unwrap();
}
