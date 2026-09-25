//! Crash, power-loss and failure tests for every durable update transition.
//!
//! Each test runs real release files in a temporary layout against the fake
//! host. A "crash" ends the operation at a named point without any cleanup;
//! recovery is what production does next: the guard timer or the next helper
//! start (no power loss), or a boot with the guard first (power loss). After
//! recovery every test checks the same invariants ([`World::assert_consistent`]).

#![allow(clippy::unwrap_used)]

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use edge_release::install::{
    Layout, StageOutcome, current_version, install_with_key, installed_versions, verify_installed,
};
use edge_release::protocol::{HelperRequest, Phase};
use edge_release::testing::{Signer, layout, write_archive};

use crate::fake::{Behavior, FakeHost};
use crate::host::{EDGE_DAEMON, EDGE_RENDERER};
use crate::transaction::{Transaction, TransactionStore};
use crate::updater::{CrashPoint, HelperPaths, Timing, UpdateError, Updater};

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

struct World {
    root: tempfile::TempDir,
    layout: Layout,
    store: TransactionStore,
    host: FakeHost,
    signer: Signer,
    cas_root: PathBuf,
    reserve_bytes: u64,
}

impl World {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let layout = layout(root.path());
        let signer = Signer::new();
        let first = root.path().join("tree-0.1.0");
        signer.write_release(&first, "0.1.0");
        install_with_key(&first, &layout, &signer.public()).unwrap();
        let host = FakeHost::new(layout.install_root.clone());
        host.with(|s| s.running_version = Some("0.1.0".into()));
        let store = TransactionStore::new(root.path().join("update-state"));
        let cas_root = root.path().join("cas");
        Self { root, layout, store, host, signer, cas_root, reserve_bytes: 0 }
    }

    fn updater(&self, crash: Option<CrashPoint>) -> Updater<'_, FakeHost> {
        let paths =
            HelperPaths { cas_root: self.cas_root.clone(), tilecast_uid: None, reserve_bytes: self.reserve_bytes };
        Updater::new(&self.host, self.layout.clone(), self.store.clone(), self.signer.public(), paths)
            .with_timing(TIMING)
            .crash_at(crash)
    }

    /// Builds a signed release, its archive and envelope, and puts the
    /// archive where `tilecastd` would have: in the content store.
    fn candidate(&self, version: &str) -> Candidate {
        let tree = self.root.path().join(format!("tree-{version}"));
        self.signer.write_release(&tree, version);
        let archive = self.root.path().join(format!("{version}.tar.zst"));
        write_archive(&tree, &archive);
        let envelope = self.signer.envelope_bytes(&tree, &archive, 6);
        let signature = self.signer.signature(&envelope);
        let digest = edge_protocol::Sha256Digest::of(&std::fs::read(&archive).unwrap());
        let object = self.cas_root.join("sha256").join(digest.fanout()).join(digest.to_hex());
        std::fs::create_dir_all(object.parent().unwrap()).unwrap();
        std::fs::copy(&archive, &object).unwrap();
        Candidate { envelope, signature, artifact: digest.to_hex() }
    }

    async fn stage(&self, candidate: &Candidate) -> Result<StageOutcome, UpdateError> {
        self.updater(None).stage(&candidate.artifact, &candidate.envelope, &candidate.signature).await
    }

    async fn staged(&self, version: &str) {
        let candidate = self.candidate(version);
        assert_eq!(self.stage(&candidate).await.unwrap(), StageOutcome::Staged { version: version.into() });
    }

    fn units_version(&self) -> String {
        let text = std::fs::read_to_string(self.layout.unit_dir.join("tilecast-edge.service")).unwrap();
        text.trim().rsplit(' ').next().unwrap().to_owned()
    }

    fn latest(&self) -> Transaction {
        self.store.latest().unwrap().unwrap()
    }

    /// What production does after a crash of the helper.
    async fn recover(&self, power_loss: bool) {
        if power_loss {
            self.host.power_loss();
            // The guard service runs before Edge at boot, if it is armed.
            if self.host.with(|s| s.guard_armed_for.is_some()) {
                self.updater(None).guard().await.unwrap();
            }
            self.host.boot_edge();
        }
        // The guard timer, or the next helper start, settles the rest.
        self.updater(None).guard().await.unwrap();
    }

    /// Lets a provisional candidate confirm, as its daemon would.
    async fn confirm_if_provisional(&self) {
        if self.store.load().unwrap().is_some_and(|t| t.phase == Phase::Provisional) {
            self.updater(None).confirm("0.2.0").await.unwrap();
        }
    }

    fn assert_consistent(&self, expected: Phase) {
        let transaction = self.latest();
        assert!(self.store.load().unwrap().is_none(), "a finished transaction is archived");
        assert_eq!(transaction.phase, expected, "{:?}", transaction.events);
        let current = current_version(&self.layout).unwrap();
        let wanted = if expected == Phase::Confirmed { "0.2.0" } else { "0.1.0" };
        assert_eq!(current, wanted);
        assert_eq!(self.units_version(), wanted, "system files describe the current release");
        assert!(self.host.with(|s| s.guard_armed_for.is_none()), "the guard ends with the transaction");
        assert!(self.host.is_active(EDGE_DAEMON) && self.host.is_active(EDGE_RENDERER), "the screen runs");
        assert_eq!(self.host.with(|s| s.running_version.clone()).as_deref(), Some(wanted));
        for version in ["0.1.0", "0.2.0"] {
            verify_installed(&self.layout.version_dir(version), &self.signer.public())
                .unwrap_or_else(|e| panic!("{version} must stay installed and intact: {e}"));
        }
    }
}

#[tokio::test]
async fn a_healthy_candidate_is_activated_confirmed_and_older_releases_are_removed() {
    let world = World::new();
    // An older release left from before: removed only after confirmation.
    let old = world.root.path().join("tree-0.0.9");
    world.signer.write_release(&old, "0.0.9");
    edge_release::install::stage_from_dir(&old, &world.layout, &world.signer.public()).unwrap();
    world.staged("0.2.0").await;
    assert_eq!(current_version(&world.layout).as_deref(), Some("0.1.0"), "staging never activates");

    let transaction = world.updater(None).activate("0.2.0").await.unwrap();
    assert_eq!(transaction.phase, Phase::Provisional);
    assert_eq!(world.host.with(|s| s.guard_armed_for.clone()).as_deref(), Some("0.1.0"));
    assert_eq!(world.units_version(), "0.2.0");
    assert_eq!(world.host.with(|s| s.running_version.clone()).as_deref(), Some("0.2.0"));
    assert!(installed_versions(&world.layout).unwrap().contains(&"0.0.9".to_owned()), "kept while provisional");
    let log = world.host.with(|s| s.log.clone());
    let renderer_stop = log.iter().position(|l| l == "stop tilecast-renderer.service").unwrap();
    let daemon_stop = log.iter().position(|l| l == "stop tilecast-edge.service").unwrap();
    assert!(renderer_stop < daemon_stop, "the renderer stops before current moves");

    let confirmed = world.updater(None).confirm("0.2.0").await.unwrap();
    assert_eq!(confirmed.phase, Phase::Confirmed);
    world.assert_consistent(Phase::Confirmed);
    assert_eq!(installed_versions(&world.layout).unwrap(), vec!["0.2.0".to_owned(), "0.1.0".to_owned()]);

    // A confirmation whose answer was lost is asked again.
    assert_eq!(world.updater(None).confirm("0.2.0").await.unwrap().phase, Phase::Confirmed);
}

#[tokio::test]
async fn every_activation_crash_point_recovers_with_and_without_power_loss() {
    for point in CrashPoint::ACTIVATION {
        for power_loss in [false, true] {
            let world = World::new();
            world.staged("0.2.0").await;
            let error = world.updater(Some(point)).activate("0.2.0").await.unwrap_err();
            assert!(matches!(error, UpdateError::Crashed(p) if p == point));
            world.recover(power_loss).await;
            world.confirm_if_provisional().await;
            // Before the window opened, or after any reboot, the candidate
            // never counts: a crash never confirms.
            let started = matches!(
                point,
                CrashPoint::AfterProvisionalSaved | CrashPoint::AfterDaemonStarted | CrashPoint::AfterRendererStarted
            );
            let expected = if started && !power_loss { Phase::Confirmed } else { Phase::RolledBack };
            world.assert_consistent(expected);
            if expected == Phase::RolledBack {
                let wanted = if started { "rebooted_while_provisional" } else { "activation_interrupted" };
                assert_eq!(world.latest().reason.as_deref(), Some(wanted), "{point:?} power loss {power_loss}");
            }
        }
    }
}

#[tokio::test]
async fn every_confirmation_crash_point_finishes_the_confirmation() {
    for point in CrashPoint::CONFIRMATION {
        for power_loss in [false, true] {
            let world = World::new();
            world.staged("0.2.0").await;
            world.updater(None).activate("0.2.0").await.unwrap();
            let error = world.updater(Some(point)).confirm("0.2.0").await.unwrap_err();
            assert!(matches!(error, UpdateError::Crashed(p) if p == point));
            // The checks passed and ConfirmIntent is durable: recovery
            // finishes the confirmation, even after a power loss.
            world.recover(power_loss).await;
            world.assert_consistent(Phase::Confirmed);
        }
    }
}

#[tokio::test]
async fn every_rollback_crash_point_finishes_the_rollback() {
    for point in CrashPoint::ROLLBACK {
        for power_loss in [false, true] {
            let world = World::new();
            world.staged("0.2.0").await;
            world.updater(None).activate("0.2.0").await.unwrap();
            let error = world.updater(Some(point)).rollback("candidate_safe_mode").await.unwrap_err();
            assert!(matches!(error, UpdateError::Crashed(p) if p == point));
            world.recover(power_loss).await;
            world.assert_consistent(Phase::RolledBack);
            assert_eq!(world.latest().reason.as_deref(), Some("candidate_safe_mode"), "{point:?}");
        }
    }
}

#[tokio::test]
async fn a_candidate_without_valid_evidence_is_refused_and_rolled_back_at_the_deadline() {
    for (behavior, refusal) in [
        (Behavior::NoServer, "server_not_connected"),
        (Behavior::NoEvidence, "no_playback_evidence"),
        (Behavior::SafeMode, "renderer_safe_mode"),
        (Behavior::Silent, "daemon_unreachable"),
    ] {
        let world = World::new();
        world.staged("0.2.0").await;
        world.host.with(|s| s.behavior.insert("0.2.0".into(), behavior));
        world.updater(None).activate("0.2.0").await.unwrap();
        let error = world.updater(None).confirm("0.2.0").await.unwrap_err();
        assert_eq!(error.reason_code(), refusal);
        world.host.advance(Duration::from_secs(599));
        world.updater(None).guard().await.unwrap();
        assert_eq!(world.store.load().unwrap().unwrap().phase, Phase::Provisional, "not before the deadline");
        world.host.advance(Duration::from_secs(2));
        world.updater(None).guard().await.unwrap();
        world.assert_consistent(Phase::RolledBack);
        assert_eq!(world.latest().reason.as_deref(), Some("confirmation_timeout"));
    }
}

#[tokio::test]
async fn a_late_confirmation_rolls_back_instead() {
    let world = World::new();
    world.staged("0.2.0").await;
    world.updater(None).activate("0.2.0").await.unwrap();
    world.host.advance(Duration::from_secs(601));
    let error = world.updater(None).confirm("0.2.0").await.unwrap_err();
    assert_eq!(error.reason_code(), "confirmation_timeout");
    world.assert_consistent(Phase::RolledBack);
}

#[tokio::test]
async fn a_crashing_candidate_daemon_or_renderer_is_rolled_back_early() {
    for (unit, count, reason) in
        [(EDGE_DAEMON, 4, "candidate_daemon_restarting"), (EDGE_RENDERER, 6, "candidate_renderer_restarting")]
    {
        let world = World::new();
        world.staged("0.2.0").await;
        world.updater(None).activate("0.2.0").await.unwrap();
        world.host.with(|s| s.restarts.insert(unit.into(), count - 1));
        world.updater(None).guard().await.unwrap();
        assert_eq!(world.store.load().unwrap().unwrap().phase, Phase::Provisional, "within the limit");
        world.host.with(|s| s.restarts.insert(unit.into(), count));
        world.updater(None).guard().await.unwrap();
        world.assert_consistent(Phase::RolledBack);
        assert_eq!(world.latest().reason.as_deref(), Some(reason));
    }
}

#[tokio::test]
async fn a_power_loss_while_provisional_rolls_back_before_edge_starts() {
    let world = World::new();
    world.staged("0.2.0").await;
    world.updater(None).activate("0.2.0").await.unwrap();
    world.host.power_loss();
    // The guard runs before Edge at boot.
    world.updater(None).guard().await.unwrap();
    assert_eq!(world.latest().reason.as_deref(), Some("rebooted_while_provisional"));
    world.host.boot_edge();
    world.assert_consistent(Phase::RolledBack);
}

#[tokio::test]
async fn a_forced_rollback_ends_the_window_and_a_retry_can_confirm() {
    let world = World::new();
    world.staged("0.2.0").await;
    world.updater(None).activate("0.2.0").await.unwrap();
    assert_eq!(world.updater(None).rollback("operator_requested").await.unwrap().phase, Phase::RolledBack);
    world.assert_consistent(Phase::RolledBack);
    assert_eq!(world.updater(None).rollback("operator_requested").await.unwrap().phase, Phase::RolledBack);

    // A retry of the same release activates it again.
    world.updater(None).activate("0.2.0").await.unwrap();
    world.updater(None).confirm("0.2.0").await.unwrap();
    world.assert_consistent(Phase::Confirmed);
    let error = world.updater(None).rollback("operator_requested").await.unwrap_err();
    assert_eq!(error.reason_code(), "already_confirmed", "confirmation ends the rollback window");
}

#[tokio::test]
async fn a_previous_release_that_refuses_the_newer_schema_is_reported_and_not_repaired() {
    let world = World::new();
    world.staged("0.2.0").await;
    world.host.with(|s| s.behavior.insert("0.1.0".into(), Behavior::NewerSchemaRefused));
    world.updater(None).activate("0.2.0").await.unwrap();
    world.updater(None).rollback("candidate_safe_mode").await.unwrap();
    world.assert_consistent(Phase::RolledBack);
    assert!(world.latest().schema_incompatible, "the refusal is recorded");
    let view = world.updater(None).status().transaction.unwrap();
    assert!(view.schema_incompatible);
}

#[tokio::test]
async fn a_corrupt_previous_release_keeps_the_screen_running_and_the_rollback_open() {
    let world = World::new();
    world.staged("0.2.0").await;
    world.updater(None).activate("0.2.0").await.unwrap();
    std::fs::write(world.layout.version_dir("0.1.0").join("bin/tilecastd"), b"changed").unwrap();
    let error = world.updater(None).rollback("candidate_safe_mode").await.unwrap_err();
    assert_eq!(error.reason_code(), "previous_release_corrupt");
    assert_eq!(world.store.load().unwrap().unwrap().phase, Phase::RollbackIntent, "the guard keeps trying");
    assert!(world.host.is_active(EDGE_DAEMON) && world.host.is_active(EDGE_RENDERER), "never a dark screen");
    assert_eq!(current_version(&world.layout).as_deref(), Some("0.2.0"));
}

#[tokio::test]
async fn staging_refuses_bad_signatures_digests_space_and_downgrades() {
    let world = World::new();
    let candidate = world.candidate("0.2.0");

    // Bad outer signature.
    let forged = Signer::new().signature(&candidate.envelope);
    let error = world.updater(None).stage(&candidate.artifact, &candidate.envelope, &forged).await.unwrap_err();
    assert_eq!(error.reason_code(), "release_signature_invalid");

    // A request whose digest is not the envelope's.
    let error =
        world.updater(None).stage(&"0".repeat(64), &candidate.envelope, &candidate.signature).await.unwrap_err();
    assert_eq!(error.reason_code(), "artifact_mismatch");

    // The content-store object changed after tilecastd verified it.
    let digest = edge_protocol::Sha256Digest::parse(&candidate.artifact).unwrap();
    let object = world.cas_root.join("sha256").join(digest.fanout()).join(digest.to_hex());
    let mut bytes = std::fs::read(&object).unwrap();
    bytes[10] ^= 0xff;
    std::fs::write(&object, &bytes).unwrap();
    assert_eq!(world.stage(&candidate).await.unwrap_err().reason_code(), "artifact_digest_mismatch");
    assert!(!world.layout.version_dir("0.2.0").exists());
    assert_eq!(std::fs::read_dir(world.store.work_dir()).unwrap().count(), 0, "no private copy is kept");
    std::fs::remove_file(&object).unwrap();
    assert_eq!(world.stage(&candidate).await.unwrap_err().reason_code(), "artifact_not_downloaded");

    // Not enough space for the private copy.
    let mut tight = World::new();
    tight.reserve_bytes = u64::MAX / 4;
    let candidate = tight.candidate("0.2.0");
    assert_eq!(tight.stage(&candidate).await.unwrap_err().reason_code(), "insufficient_disk");

    // Not newer than the current release.
    let world = World::new();
    let older = world.candidate("0.0.5");
    assert_eq!(world.stage(&older).await.unwrap_err().reason_code(), "update_not_newer");
}

#[tokio::test]
async fn an_interrupted_stage_is_redone_and_a_durable_one_is_kept() {
    let world = World::new();
    // A stage that died while unpacking leaves only its staging directory.
    std::fs::create_dir_all(world.layout.install_root.join("0.2.0.staging/bin")).unwrap();
    std::fs::write(world.layout.install_root.join("0.2.0.staging/bin/tilecastd"), b"half").unwrap();
    let candidate = world.candidate("0.2.0");
    assert_eq!(world.stage(&candidate).await.unwrap(), StageOutcome::Staged { version: "0.2.0".into() });
    assert!(!world.layout.install_root.join("0.2.0.staging").exists());
    // Once the version directory exists, staging again is a verified no-op.
    assert_eq!(world.stage(&candidate).await.unwrap(), StageOutcome::AlreadyStaged { version: "0.2.0".into() });
    // A crash after the directory became durable and before activation
    // leaves a release that activates normally later.
    world.updater(None).activate("0.2.0").await.unwrap();
    world.updater(None).confirm("0.2.0").await.unwrap();
    world.assert_consistent(Phase::Confirmed);
}

#[tokio::test]
async fn activation_preflight_refuses_what_it_cannot_finish() {
    let world = World::new();
    assert_eq!(world.updater(None).activate("0.2.0").await.unwrap_err().reason_code(), "release_not_staged");
    assert_eq!(world.updater(None).activate("0.1.0").await.unwrap_err().reason_code(), "already_current");
    assert_eq!(world.updater(None).activate("../0.1.0").await.unwrap_err().reason_code(), "invalid_version");
    world.staged("0.2.0").await;
    world.updater(None).activate("0.2.0").await.unwrap();
    world.staged("0.3.0").await;
    assert_eq!(world.updater(None).activate("0.3.0").await.unwrap_err().reason_code(), "transaction_open");
    assert!(world.host.with(|s| s.log.is_empty() || !s.log.last().unwrap().contains("0.3.0")));
}

#[tokio::test]
async fn the_request_handler_speaks_only_the_fixed_vocabulary() {
    let world = World::new();
    let updater = world.updater(None);
    let (response, continuation) = crate::server::handle(&updater, HelperRequest::Status {}).await;
    assert!(response.ok && continuation.is_none());
    assert_eq!(response.status.unwrap().current.unwrap().version_name, "0.1.0");

    let (response, _) = crate::server::handle(
        &updater,
        HelperRequest::Stage { artifact_sha256: "0".repeat(64), envelope: "!!".into(), signature: "!!".into() },
    )
    .await;
    assert_eq!(response.code, "invalid_request");
    let (response, _) = crate::server::handle(&updater, HelperRequest::Rollback { reason: "; rm -rf /".into() }).await;
    assert_eq!(response.code, "invalid_request");

    let candidate = world.candidate("0.2.0");
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    let (response, _) = crate::server::handle(
        &updater,
        HelperRequest::Stage {
            artifact_sha256: candidate.artifact.clone(),
            envelope: b64(&candidate.envelope),
            signature: b64(&candidate.signature),
        },
    )
    .await;
    assert_eq!((response.ok, response.code.as_str()), (true, "staged"));
    let (response, continuation) =
        crate::server::handle(&updater, HelperRequest::Activate { version_name: "0.2.0".into() }).await;
    assert_eq!(response.code, "activation_started");
    assert_eq!(current_version(&world.layout).as_deref(), Some("0.1.0"), "nothing runs differently yet");
    updater.run_activation(continuation.unwrap()).await.unwrap();
    let (response, _) = crate::server::handle(&updater, HelperRequest::Confirm { version_name: "0.2.0".into() }).await;
    assert_eq!(response.code, "confirmed");
    world.assert_consistent(Phase::Confirmed);
}

#[tokio::test]
async fn the_socket_serves_one_request_per_connection_and_refuses_disallowed_peers() {
    struct Allow(bool);
    impl crate::server::PeerPolicy for Allow {
        fn allow(&self, _stream: &tokio::net::UnixStream) -> Result<(), &'static str> {
            if self.0 { Ok(()) } else { Err("peer_not_allowed") }
        }
    }
    use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _};
    for (allowed, expected) in [(true, "status"), (false, "peer_not_allowed")] {
        let world = World::new();
        let path = world.root.path().join("update.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let client = async {
            let mut stream = tokio::net::UnixStream::connect(&path).await.unwrap();
            stream.write_all(b"{\"op\":\"status\"}\n").await.unwrap();
            let mut line = String::new();
            tokio::io::BufReader::new(stream).read_line(&mut line).await.unwrap();
            serde_json::from_str::<edge_release::protocol::HelperResponse>(&line).unwrap()
        };
        let updater = world.updater(None);
        let policy = Allow(allowed);
        let server = crate::server::serve(listener, &updater, &policy, Duration::from_millis(300));
        let (response, ()) = tokio::join!(client, server);
        assert_eq!(response.code, expected);
    }
}

#[tokio::test]
async fn restarts_of_the_previous_daemon_do_not_raise_the_candidates_limit() {
    let world = World::new();
    world.staged("0.2.0").await;
    // The previous daemon crashed and was restarted before this update.
    world.host.with(|s| s.restarts.insert(EDGE_DAEMON.into(), 7));
    world.updater(None).activate("0.2.0").await.unwrap();
    world.host.with(|s| s.restarts.insert(EDGE_DAEMON.into(), 4));
    world.updater(None).guard().await.unwrap();
    world.assert_consistent(Phase::RolledBack);
    assert_eq!(world.latest().reason.as_deref(), Some("candidate_daemon_restarting"));
}

#[tokio::test]
async fn a_guard_tick_keeps_the_candidates_restart_count() {
    let world = World::new();
    world.staged("0.2.0").await;
    world.updater(None).activate("0.2.0").await.unwrap();
    world.host.with(|s| s.restarts.insert(EDGE_DAEMON.into(), 2));
    world.updater(None).guard().await.unwrap();
    assert_eq!(world.store.load().unwrap().unwrap().phase, Phase::Provisional);
    assert_eq!(world.host.with(|s| s.restarts.get(EDGE_DAEMON).copied()), Some(2), "the guard did not restart it");
    world.host.with(|s| s.restarts.insert(EDGE_DAEMON.into(), 4));
    world.updater(None).guard().await.unwrap();
    world.assert_consistent(Phase::RolledBack);
}

#[tokio::test]
async fn a_candidate_unit_that_systemd_gave_up_on_is_rolled_back() {
    for (unit, reason) in [(EDGE_DAEMON, "candidate_daemon_failed"), (EDGE_RENDERER, "candidate_renderer_failed")] {
        let world = World::new();
        world.staged("0.2.0").await;
        world.updater(None).activate("0.2.0").await.unwrap();
        world.host.with(|s| {
            s.active.remove(unit);
            s.failed.insert(unit.into());
        });
        world.updater(None).guard().await.unwrap();
        world.assert_consistent(Phase::RolledBack);
        assert_eq!(world.latest().reason.as_deref(), Some(reason));
    }
}

#[tokio::test]
async fn a_guard_rollback_never_waits_for_the_previous_daemon() {
    let world = World::new();
    world.staged("0.2.0").await;
    world.host.with(|s| s.behavior.insert("0.1.0".into(), Behavior::Silent));
    world.updater(None).activate("0.2.0").await.unwrap();
    world.host.power_loss();
    let before = world.host.with(|s| s.boottime_ms);
    world.updater(None).guard().await.unwrap();
    assert_eq!(world.host.with(|s| s.boottime_ms), before, "the Edge units wait for the guard to exit");
    world.host.boot_edge();
    world.assert_consistent(Phase::RolledBack);
}
