//! The update path from a deployed Edge preview to the unified releases.
//!
//! Edge 0.2.1 and older compute an update's version code as `MAJOR * 1000000 +
//! MINOR * 1000 + PATCH`, and their update helper refuses an envelope whose
//! code is not that number. A unified release (`0.26.0-beta.1`, `0.26.0`) carries
//! the code `core * 100 + slot`, so those helpers refuse every one of them. The
//! bridge release is an Edge release with a legacy-compatible version name
//! (`0.2.2`) that carries this crate's helper. A screen installs the bridge with
//! the helper it already runs, and the bridge's own helper then installs the
//! unified Beta and the unified Stable.
//!
//! These tests walk that path with the real release files, the real verification
//! and the real transaction state machine, on an in-memory host:
//!
//! * `the_current_helper_walks_the_whole_path` and the failure tests run this
//!   crate's helper through every step on its own.
//! * `bridge_produce` and `bridge_continue_after_the_legacy_helper` are the two
//!   halves of the cross-version test that `apps/edge/release/test-bridge-path.sh`
//!   runs. Between them the script runs the *shipped* 0.2.1 helper, built from
//!   its tag, over the same files (`legacy-oracle/legacy_bridge_oracle.rs`), so
//!   the transaction record and layout it leaves are what this crate's helper
//!   must continue from.

#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use edge_release::install::{
    Layout, StageOutcome, current_version, install_with_key, installed_versions, verify_installed,
};
use edge_release::manifest::{decode_key, version_channel, version_code};
use edge_release::protocol::Phase;
use edge_release::testing::{Signer, layout, write_archive};

use crate::fake::{Behavior, FakeHost};
use crate::host::{EDGE_DAEMON, EDGE_RENDERER, EDGE_WEB};
use crate::transaction::TransactionStore;
use crate::updater::{HelperPaths, Timing, UpdateError, Updater};

const SHARED_DIR: &str = "TILECAST_BRIDGE_PATH_DIR";
/// The installed preview: the last release whose helper uses the legacy rule.
const BASE: &str = "0.2.1";
/// The bridge: a legacy-compatible name and code, built with this crate's helper.
const BRIDGE: &str = "0.2.2";
const BETA: &str = "0.26.0-beta.1";
const STABLE: &str = "0.26.0";
const NEXT_BETA: &str = "0.26.1-beta.1";
/// A Beta of the version that is already Stable: older than it.
const LATE_BETA: &str = "0.26.0-beta.2";
const STATE_SCHEMA: u32 = 8;

const TIMING: Timing = Timing {
    provisional: Duration::from_secs(600),
    daemon_restart_limit: 3,
    renderer_restart_limit: 5,
    after_rollback_wait: Duration::from_secs(10),
    poll: Duration::from_secs(1),
};

struct Candidate {
    envelope: Vec<u8>,
    signature: Vec<u8>,
    artifact: String,
}

/// Writes a signed candidate under `dir/candidates/<version>`: the tree, its
/// archive, and an envelope with the channel the version name implies (a
/// legacy name is a Beta preview, as every Edge preview was).
fn write_candidate(signer: &Signer, dir: &Path, version: &str) -> Candidate {
    let home = dir.join("candidates").join(version);
    let tree = home.join("tree");
    signer.write_release(&tree, version);
    let archive = home.join("archive.tar.zst");
    write_archive(&tree, &archive);
    let mut envelope: serde_json::Value =
        serde_json::from_slice(&signer.envelope_bytes(&tree, &archive, STATE_SCHEMA)).unwrap();
    envelope["channel"] = version_channel(version).unwrap_or("beta").into();
    let envelope = serde_json::to_vec(&envelope).unwrap();
    let signature = signer.signature(&envelope);
    std::fs::write(home.join("envelope.json"), &envelope).unwrap();
    std::fs::write(home.join("envelope.sig"), &signature).unwrap();
    let digest = edge_protocol::Sha256Digest::of(&std::fs::read(&archive).unwrap());
    Candidate { envelope, signature, artifact: digest.to_hex() }
}

/// Reads a candidate and puts its archive where `tilecastd` would have left it.
fn load_candidate(dir: &Path, version: &str) -> Candidate {
    let home = dir.join("candidates").join(version);
    let archive = std::fs::read(home.join("archive.tar.zst")).unwrap();
    let digest = edge_protocol::Sha256Digest::of(&archive);
    let object = dir.canonicalize().unwrap().join("cas").join("sha256").join(digest.fanout()).join(digest.to_hex());
    std::fs::create_dir_all(object.parent().unwrap()).unwrap();
    std::fs::write(&object, &archive).unwrap();
    Candidate {
        envelope: std::fs::read(home.join("envelope.json")).unwrap(),
        signature: std::fs::read(home.join("envelope.sig")).unwrap(),
        artifact: digest.to_hex(),
    }
}

/// Installs the preview and writes every candidate: the starting point of the
/// whole path. The key that signed them goes to `dir/key.pub`.
fn produce(dir: &Path, signer: &Signer, versions: &[&str]) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("key.pub"), signer.public_base64()).unwrap();
    let tree = dir.join("base-tree");
    signer.write_release(&tree, BASE);
    install_with_key(&tree, &layout(dir), &signer.public()).unwrap();
    for version in versions {
        write_candidate(signer, dir, version);
    }
}

struct PathWorld {
    dir: PathBuf,
    layout: Layout,
    store: TransactionStore,
    host: FakeHost,
    key: [u8; 32],
}

impl PathWorld {
    fn open(dir: &Path, key: [u8; 32]) -> Self {
        let layout = layout(dir);
        let host = FakeHost::new(layout.install_root.clone());
        host.with(|s| s.running_version = current_version(&layout));
        Self { dir: dir.to_path_buf(), store: TransactionStore::new(dir.join("update-state")), layout, host, key }
    }

    fn updater(&self) -> Updater<'_, FakeHost> {
        let paths = HelperPaths {
            cas_root: self.dir.canonicalize().unwrap().join("cas"),
            tilecast_uid: None,
            reserve_bytes: 0,
        };
        Updater::new(&self.host, self.layout.clone(), self.store.clone(), self.key, paths).with_timing(TIMING)
    }

    async fn stage(&self, candidate: &Candidate) -> Result<StageOutcome, UpdateError> {
        self.updater().stage(&candidate.artifact, &candidate.envelope, &candidate.signature).await
    }

    /// Stage, activate and let the running candidate confirm, as production does.
    async fn install(&self, version: &str) {
        let candidate = load_candidate(&self.dir, version);
        assert_eq!(
            self.stage(&candidate).await.unwrap(),
            StageOutcome::Staged { version: version.into() },
            "{version}"
        );
        let transaction = self.updater().activate(version).await.unwrap();
        assert_eq!(transaction.phase, Phase::Provisional, "{version}");
        assert_eq!(self.updater().confirm(version).await.unwrap().phase, Phase::Confirmed, "{version}");
        self.assert_running(version);
    }

    fn assert_running(&self, version: &str) {
        assert_eq!(current_version(&self.layout).as_deref(), Some(version));
        assert_eq!(self.host.with(|s| s.running_version.clone()).as_deref(), Some(version));
        assert!(self.host.with(|s| s.guard_armed_for.is_none()), "the guard ends with the transaction");
        for unit in [EDGE_DAEMON, EDGE_WEB, EDGE_RENDERER] {
            assert!(self.host.is_active(unit), "{unit} runs");
        }
        let units = std::fs::read_to_string(self.layout.unit_dir.join("tilecast-edge.service")).unwrap();
        assert_eq!(units.trim().rsplit(' ').next(), Some(version), "system files describe the current release");
    }

    fn intact(&self, version: &str) {
        verify_installed(&self.layout.version_dir(version), &self.key)
            .unwrap_or_else(|error| panic!("{version} must stay installed and intact: {error}"));
    }
}

fn world(versions: &[&str]) -> (tempfile::TempDir, Signer, PathWorld) {
    let dir = tempfile::tempdir().unwrap();
    let signer = Signer::new();
    produce(dir.path(), &signer, versions);
    let world = PathWorld::open(dir.path(), signer.public());
    (dir, signer, world)
}

#[test]
fn the_bridge_identity_is_valid_under_both_rules_and_a_unified_one_is_not_a_legacy_code() {
    // The rule that lets a deployed preview install the bridge: its name and
    // code agree under the legacy formula, and sit above every shipped preview.
    assert_eq!(version_code(BASE), Some(2_001));
    assert_eq!(version_code(BRIDGE), Some(2_002));
    assert_eq!(version_channel(BRIDGE), None, "a legacy name implies no channel");
    // A unified code is not a legacy code: the legacy formula would give 26000
    // for the Beta, the Stable and every later Beta alike.
    for (version, legacy) in [(BETA, 26_000), (STABLE, 26_000), (NEXT_BETA, 26_001)] {
        assert_ne!(version_code(version), Some(legacy), "{version}");
    }
    assert!(version_code(BRIDGE) < version_code(BETA) && version_code(BETA) < version_code(STABLE));
}

#[tokio::test]
async fn the_current_helper_walks_the_whole_path() {
    let (_dir, _signer, world) = world(&[BRIDGE, BETA, STABLE, NEXT_BETA, LATE_BETA]);
    world.assert_running(BASE);
    world.install(BRIDGE).await;
    world.install(BETA).await;
    world.install(STABLE).await;
    // Retention keeps the confirmed release and the one it replaced, and the
    // release the screen can still roll back to stays intact.
    assert_eq!(installed_versions(&world.layout).unwrap(), vec![STABLE.to_owned(), BETA.to_owned()]);
    world.intact(BETA);
    world.intact(STABLE);
    // A Beta of the release that is already Stable is older than it, however
    // late it is published, and is never staged.
    let stale = load_candidate(&world.dir, LATE_BETA);
    assert_eq!(world.stage(&stale).await.unwrap_err().reason_code(), "update_not_newer");
    // The next Beta is newer than the Stable that came before it.
    world.install(NEXT_BETA).await;
}

#[tokio::test]
async fn a_forged_or_altered_candidate_is_refused_before_anything_is_staged() {
    let (_dir, _signer, world) = world(&[BRIDGE, BETA]);
    world.install(BRIDGE).await;
    let mut altered = load_candidate(&world.dir, BETA);
    let last = altered.envelope.len() - 2;
    altered.envelope[last] ^= 1;
    assert_eq!(world.stage(&altered).await.unwrap_err().reason_code(), "release_signature_invalid");

    // An attacker's own key does not become trusted by being well formed.
    write_candidate(&Signer::new(), &world.dir, "0.26.0-beta.2");
    let forged = load_candidate(&world.dir, "0.26.0-beta.2");
    assert_eq!(world.stage(&forged).await.unwrap_err().reason_code(), "release_signature_invalid");
    world.assert_running(BRIDGE);
    assert_eq!(installed_versions(&world.layout).unwrap().len(), 2, "nothing was staged");
}

#[tokio::test]
async fn a_unified_envelope_with_the_wrong_code_or_channel_is_refused() {
    let (_dir, signer, world) = world(&[BRIDGE]);
    world.install(BRIDGE).await;
    for (version, code, channel, refused) in [
        (BETA, 26_000_u64, "beta", "legacy code of a Beta"),
        (STABLE, 26_000, "stable", "legacy code of a Stable"),
        (BETA, 2_600_001, "stable", "a Beta declared Stable"),
        (STABLE, 2_600_099, "beta", "a Stable declared Beta"),
    ] {
        let home = world.dir.join("candidates").join(format!("{version}-bad"));
        let tree = home.join("tree");
        signer.write_release(&tree, version);
        let archive = home.join("archive.tar.zst");
        write_archive(&tree, &archive);
        let mut envelope: serde_json::Value =
            serde_json::from_slice(&signer.envelope_bytes(&tree, &archive, STATE_SCHEMA)).unwrap();
        envelope["versionCode"] = code.into();
        envelope["channel"] = channel.into();
        let envelope = serde_json::to_vec(&envelope).unwrap();
        let object = world.dir.canonicalize().unwrap().join("cas/sha256");
        let digest = edge_protocol::Sha256Digest::of(&std::fs::read(&archive).unwrap());
        std::fs::create_dir_all(object.join(digest.fanout())).unwrap();
        std::fs::copy(&archive, object.join(digest.fanout()).join(digest.to_hex())).unwrap();
        let candidate = Candidate { signature: signer.signature(&envelope), envelope, artifact: digest.to_hex() };
        let error = world.stage(&candidate).await.unwrap_err();
        assert_eq!(error.reason_code(), "release_manifest_invalid", "{refused}");
    }
    world.assert_running(BRIDGE);
}

#[tokio::test]
async fn a_unified_candidate_that_does_not_come_up_rolls_back_to_the_bridge() {
    for behavior in [Behavior::SafeMode, Behavior::NoServer, Behavior::NoEvidence, Behavior::Silent] {
        let (_dir, _signer, world) = world(&[BRIDGE, BETA, NEXT_BETA]);
        world.install(BRIDGE).await;
        let beta = load_candidate(&world.dir, BETA);
        world.stage(&beta).await.unwrap();
        world.host.with(|s| s.behavior.insert(BETA.into(), behavior));
        world.updater().activate(BETA).await.unwrap();
        assert!(world.updater().confirm(BETA).await.is_err(), "{behavior:?} must not confirm");
        let rolled = world.updater().rollback("candidate_unhealthy").await.unwrap();
        assert_eq!(rolled.phase, Phase::RolledBack, "{behavior:?}");
        // The screen runs the bridge again, with the bridge's own files, and the
        // bridge is intact: nothing about the failed Beta is left in charge.
        world.assert_running(BRIDGE);
        world.intact(BRIDGE);
        world.intact(BASE);
        // The next Beta installs normally from the bridge.
        world.install(NEXT_BETA).await;
    }
}

#[tokio::test]
async fn an_interrupted_unified_activation_leaves_the_bridge_running() {
    use crate::updater::CrashPoint;
    for point in CrashPoint::ACTIVATION {
        let (_dir, _signer, world) = world(&[BRIDGE, BETA]);
        world.install(BRIDGE).await;
        world.stage(&load_candidate(&world.dir, BETA)).await.unwrap();
        let crashed = world.updater().crash_at(Some(point)).activate(BETA).await.unwrap_err();
        assert!(matches!(crashed, UpdateError::Crashed(p) if p == point));
        // Power returns: the guard, armed first, settles the transaction.
        world.host.power_loss();
        if world.host.with(|s| s.guard_armed_for.is_some()) {
            world.updater().guard().await.unwrap();
        }
        world.host.boot_edge();
        world.updater().guard().await.unwrap();
        world.assert_running(BRIDGE);
        world.intact(BRIDGE);
    }
}

/// Half of the cross-version test: installs the preview and writes the signed
/// candidates for the script to hand to the shipped helper.
#[test]
#[ignore = "run by apps/edge/release/test-bridge-path.sh"]
fn bridge_produce() {
    let dir = PathBuf::from(std::env::var(SHARED_DIR).expect("TILECAST_BRIDGE_PATH_DIR"));
    produce(&dir, &Signer::new(), &[BRIDGE, BETA, STABLE, NEXT_BETA]);
}

/// The other half: the shipped 0.2.1 helper has installed and confirmed the
/// bridge in the shared directory. This crate's helper takes over from the
/// layout and the transaction record that helper left.
#[tokio::test]
#[ignore = "run by apps/edge/release/test-bridge-path.sh"]
async fn bridge_continue_after_the_legacy_helper() {
    let dir = PathBuf::from(std::env::var(SHARED_DIR).expect("TILECAST_BRIDGE_PATH_DIR"));
    let key = decode_key(std::fs::read_to_string(dir.join("key.pub")).unwrap().trim()).unwrap();
    let world = PathWorld::open(&dir, key);

    // What the shipped helper recorded and left behind.
    let results: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("legacy-results.json")).unwrap()).unwrap();
    for (version, reason) in results["unified_refused"].as_object().unwrap() {
        assert_eq!(reason, "release_manifest_invalid", "the shipped helper must refuse {version}");
    }
    assert_eq!(results["bridge_phase"], "confirmed");
    world.assert_running(BRIDGE);
    let record = world.store.latest().unwrap().expect("the shipped helper's transaction record");
    assert_eq!(
        (record.phase, record.candidate.version_name.as_str(), record.previous.version_name.as_str()),
        (Phase::Confirmed, BRIDGE, BASE)
    );
    assert_eq!(world.updater().status().current.map(|release| release.version_name).as_deref(), Some(BRIDGE));
    world.intact(BASE);
    world.intact(BRIDGE);

    // From here only this crate's helper acts.
    world.install(BETA).await;
    world.install(STABLE).await;
    world.intact(BETA);
    // The rollback target of the Stable is the Beta; the bridge was retired.
    assert_eq!(installed_versions(&world.layout).unwrap(), vec![STABLE.to_owned(), BETA.to_owned()]);
}

#[test]
fn the_producer_writes_a_key_the_helpers_decode() {
    let dir = tempfile::tempdir().unwrap();
    let signer = Signer::new();
    produce(dir.path(), &signer, &[BRIDGE]);
    let written = std::fs::read_to_string(dir.path().join("key.pub")).unwrap();
    assert_eq!(decode_key(written.trim()).unwrap(), signer.public());
    assert_eq!(base64::engine::general_purpose::STANDARD.decode(written.trim()).unwrap().len(), 32);
}
