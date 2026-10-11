//! The M7 crash-point and failure matrix, against the in-memory machine.

use crate::fake::{Broken, Edge, FakeHost, SelfTestRenderer};
use crate::host::*;
use crate::migrate::{CrashPoint, MigrateError, Migrator, Options, Timing};
use crate::state::{Backend, Kind, Phase, StateStore};

fn options() -> Options {
    Options { kind: Kind::Migration, kiosk_user: Some("kiosk".into()), backend: Backend::Drm, settle_seconds: 600 }
}

fn clean_options() -> Options {
    Options { kind: Kind::CleanInstall, kiosk_user: None, ..options() }
}

fn migrator<'a>(host: &'a FakeHost, dir: &tempfile::TempDir) -> Migrator<'a, FakeHost> {
    Migrator::new(host, StateStore::new(dir.path().join("state"))).with_timing(Timing::default())
}

/// The machine runs exactly one player, as it should after `phase`.
fn assert_one_stack(host: &FakeHost, phase: Phase, context: &str) {
    let world = host.world.lock().unwrap();
    assert!(world.violations.is_empty(), "{context}: {:?}", world.violations);
    assert!(!world.staged, "{context}: the legacy copy (with the credential file) was removed");
    assert!(!world.probation, "{context}: probation ends with the attempt");
    let expected = world.legacy_file_digests();
    drop(world);
    let edge = [host.unit_state(EDGE_DAEMON), host.unit_state(EDGE_WEB), host.unit_state(EDGE_RENDERER)];
    let update_socket = host.unit_state(crate::host::UPDATE_SOCKET);
    let recover = host.unit_state(RECOVER_UNIT);
    let display = host.unit_state("gdm3.service");
    let legacy = host.world.lock().unwrap().legacy;
    assert!(!recover.0, "{context}: the recover unit is disabled after a terminal phase");
    match phase {
        Phase::Accepted => {
            assert_eq!(edge, [(true, true), (true, true), (true, true)], "{context}: Edge runs");
            assert!(update_socket.0, "{context}: the update helper's socket is enabled with Edge");
            assert_eq!(legacy, (false, false), "{context}: legacy is disabled but left on disk");
            assert_eq!(display, (false, false), "{context}: Edge owns the display");
        }
        Phase::RolledBack | Phase::Refused => {
            assert_eq!(edge, [(false, false), (false, false), (false, false)], "{context}: Edge is off");
            assert_eq!(update_socket, (false, false), "{context}: no Edge unit stays enabled");
            assert_eq!(legacy, (true, true), "{context}: the legacy player runs again");
            assert_eq!(display, (true, true), "{context}: the display session is back");
        }
        other => panic!("{context}: not terminal: {other:?}"),
    }
    assert_eq!(host.world.lock().unwrap().legacy_file_digests(), expected);
}

#[tokio::test]
async fn a_healthy_migration_is_accepted_only_after_settlement() {
    let host = FakeHost::migration();
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(attempt.phase, Phase::Accepted, "{:?}", attempt.reason);
    assert_one_stack(&host, Phase::Accepted, "healthy");
    let started = attempt.edge_started_at_ms.unwrap();
    let accepted = attempt.events.last().unwrap().at_ms;
    assert!(accepted - started >= 60_000, "a full stable window, not the first good sample");
    assert_eq!(attempt.display_units.len(), 2, "the display manager and the console were recorded");
    assert!(attempt.settlement.is_some() && attempt.self_test.is_some() && attempt.compat.is_some());
    // Accepting ends the rollback window.
    assert!(matches!(migrator(&host, &dir).operator_rollback().await, Err(MigrateError::AlreadyAccepted)));
}

/// Crash points on the rollback path need a settlement that fails.
fn scenario_for(point: CrashPoint) -> Edge {
    use CrashPoint::*;
    match point {
        AfterRollbackIntent | AfterEdgeDisabled | AfterEdgeStopped | AfterDisplayRestored | AfterLegacyEnabled
        | AfterLegacyStarted => Edge::NeverConnects,
        _ => Edge::Healthy,
    }
}

fn expected_after(point: CrashPoint) -> Phase {
    use CrashPoint::*;
    match point {
        AfterStarted | AfterSelfTest | AfterCompat => Phase::Refused,
        AfterAcceptIntent | AfterProbationCleared | AfterRecoverDisabled => Phase::Accepted,
        _ => Phase::RolledBack,
    }
}

#[tokio::test]
async fn every_crash_point_recovers_to_exactly_one_player() {
    for reboot in [false, true] {
        for point in CrashPoint::ALL {
            let context = format!("{point:?} (reboot: {reboot})");
            let host = FakeHost::migration().with(|w| w.edge = scenario_for(point));
            let dir = tempfile::tempdir().unwrap();
            let crashed = migrator(&host, &dir).crash_at(Some(point)).run(&options()).await;
            assert!(matches!(crashed, Err(MigrateError::Crashed(p)) if p == point), "{context}: {crashed:?}");
            if reboot {
                host.reboot();
            }
            // The Edge link recovers after the crash, so a rollback is the
            // crash's doing, not a failing server.
            host.world.lock().unwrap().edge = Edge::Healthy;
            let recovered = migrator(&host, &dir).recover().await.unwrap().expect("an attempt");
            if reboot {
                host.finish_boot();
            }
            assert_eq!(recovered.phase, expected_after(point), "{context}: {:?}", recovered.reason);
            assert_one_stack(&host, recovered.phase, &context);
            if recovered.phase == Phase::RolledBack && recovered.kiosk.is_some() {
                assert_eq!(recovered.legacy_files_unchanged, Some(true), "{context}");
            }
            // A second recovery changes nothing.
            let again = migrator(&host, &dir).recover().await.unwrap().unwrap();
            assert_eq!(again.phase, recovered.phase, "{context}");
        }
    }
}

#[tokio::test]
async fn a_static_policy_surface_settles_without_fresh_progress() {
    let host = FakeHost::migration().with(|w| w.edge = Edge::StaticPolicy);
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(attempt.phase, Phase::Accepted, "{:?}", attempt.reason);
    assert_one_stack(&host, Phase::Accepted, "static policy");
}

#[tokio::test]
async fn failed_settlement_rolls_back_with_its_reason() {
    for (edge, reason) in [
        (Edge::NeverConnects, "settlement_timeout: server_not_connected"),
        (Edge::Incompatible, "presentation_incompatible"),
        (Edge::Frozen, "settlement_timeout: no_fresh_progress"),
        (Edge::LegacyReturns, "legacy_started_during_settlement"),
    ] {
        let host = FakeHost::migration().with(|w| w.edge = edge);
        let dir = tempfile::tempdir().unwrap();
        let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
        assert_eq!((attempt.phase, attempt.reason.as_deref()), (Phase::RolledBack, Some(reason)), "{edge:?}");
        if edge != Edge::LegacyReturns {
            assert_one_stack(&host, Phase::RolledBack, reason);
        }
        assert_eq!(attempt.legacy_active_after_rollback, Some(true));
        assert!(attempt.settlement.is_some(), "the deciding sample is recorded");
    }
}

#[tokio::test]
async fn failures_before_the_cutover_refuse_and_touch_nothing() {
    type Change = Box<dyn Fn(&mut crate::fake::World)>;
    let cases: Vec<(Change, &str)> = vec![
        (Box::new(|w| w.probe_usable = false), "drm_output_unavailable"),
        (Box::new(|w| w.self_test_passes = false), "self_test_failed: evidence_timeout"),
        (Box::new(|w| w.compat_exit = 3), "legacy_presentation_incompatible"),
        (Box::new(|w| w.legacy_installed = false), "legacy_unit_not_found"),
    ];
    for (change, reason) in cases {
        let host = FakeHost::migration();
        change(&mut host.world.lock().unwrap());
        let before = host.world.lock().unwrap().legacy;
        let dir = tempfile::tempdir().unwrap();
        let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
        assert_eq!((attempt.phase, attempt.reason.as_deref()), (Phase::Refused, Some(reason)));
        let world = host.world.lock().unwrap();
        assert_eq!(world.legacy, before, "{reason}: legacy untouched");
        assert!(!world.probation && world.violations.is_empty());
        drop(world);
        assert_eq!(host.unit_state("gdm3.service"), (true, true), "{reason}: display untouched");
        assert_eq!(host.unit_state(EDGE_DAEMON), (false, false));
    }

    // Without a kiosk account, and with Edge already enabled.
    let host = FakeHost::migration();
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&Options { kiosk_user: None, ..options() }).await.unwrap();
    assert_eq!(attempt.reason.as_deref(), Some("kiosk_account_required"));
    host.enable(&[EDGE_DAEMON]).await.unwrap();
    host.world.lock().unwrap().violations.clear();
    let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(attempt.reason.as_deref(), Some("edge_already_enabled"));
}

const LOADER_ERROR: &str =
    "error while loading shared libraries: libwpe-1.0.so.1: cannot open shared object file: No such file or directory";

fn broken(exit_status: i32, signaled: bool, diagnostic: Option<&str>) -> Broken {
    Broken { exit_status, signaled, diagnostic: diagnostic.map(str::to_owned) }
}

async fn refused_with(change: impl FnOnce(&mut crate::fake::World)) -> (FakeHost, crate::state::Attempt) {
    let host = FakeHost::migration();
    change(&mut host.world.lock().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(attempt.phase, Phase::Refused, "{:?}", attempt.reason);
    assert_eq!(host.world.lock().unwrap().legacy, (true, true), "legacy untouched");
    (host, attempt)
}

#[tokio::test]
async fn a_probe_that_cannot_start_is_a_probe_failure_not_a_missing_output() {
    // Exit 127 is the dynamic loader failing: the real 0.2.0 failure.
    let (_, attempt) = refused_with(|w| w.probe_broken = Some(broken(127, false, Some(LOADER_ERROR)))).await;
    let reason = attempt.reason.unwrap();
    assert!(reason.starts_with("drm_probe_failed: exit status 127: error while loading shared libraries"), "{reason}");
    assert!(reason.contains("libwpe-1.0.so.1"));
    assert!(!reason.contains("drm_output_unavailable"));

    let (_, attempt) = refused_with(|w| w.probe_broken = Some(broken(11, true, None))).await;
    assert_eq!(attempt.reason.as_deref(), Some("drm_probe_failed: signal 11"));

    // A probe that ran and found no output is still that, with its exit 5.
    let (_, attempt) = refused_with(|w| w.probe_usable = false).await;
    assert_eq!(attempt.reason.as_deref(), Some("drm_output_unavailable"));
}

#[tokio::test]
async fn a_renderer_that_cannot_start_ends_the_self_test_at_once() {
    let (host, attempt) = refused_with(|w| {
        w.self_test_renderer = SelfTestRenderer::FailsToStart(broken(127, false, Some(LOADER_ERROR)));
    })
    .await;
    let reason = attempt.reason.unwrap();
    assert!(reason.starts_with("self_test_failed: renderer_start_failed: exit status 127"), "{reason}");
    assert!(reason.contains("libwpe-1.0.so.1"));
    let report = attempt.self_test.unwrap();
    assert_eq!(report["outcome"], "failed");
    assert_eq!(report["reason"], "renderer_start_failed");
    assert!(report["detail"].as_str().unwrap().contains("exit status 127"));
    assert!(!host.world.lock().unwrap().self_test_host_ran, "the host never waited for a dead renderer");
}

#[tokio::test]
async fn a_renderer_that_crashes_during_the_self_test_ends_it_with_its_signal() {
    // WebKit's sandbox failing aborts the renderer with SIGTRAP (signal 5).
    let (host, attempt) =
        refused_with(|w| w.self_test_renderer = SelfTestRenderer::EndsEarly(broken(5, true, Some("bwrap: denied"))))
            .await;
    assert_eq!(attempt.reason.as_deref(), Some("self_test_failed: renderer_exited: signal 5: bwrap: denied"));
    assert_eq!(attempt.self_test.unwrap()["reason"], "renderer_exited");
    assert!(!host.world.lock().unwrap().self_test_host_ran);
    assert_eq!(host.unit_state(SELFTEST_RENDERER_UNIT), (false, false), "the renderer unit is stopped");
}

#[tokio::test]
async fn the_hosts_own_reason_and_detail_reach_the_attempt() {
    // The host names the failing layer; a fixture import failure is not
    // reported as a timeout.
    let host = FakeHost::migration();
    {
        let mut world = host.world.lock().unwrap();
        world.self_test_passes = false;
        world.self_test_reason = "fixture_import_failed";
    }
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(attempt.reason.as_deref(), Some("self_test_failed: fixture_import_failed"));
    assert_eq!(attempt.self_test.unwrap()["reason"], "fixture_import_failed");
}

#[tokio::test]
async fn acceptance_clears_the_failed_state_of_the_stopped_legacy_player() {
    let host = FakeHost::migration().with(|w| w.legacy_stop_leaves_failed = true);
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(attempt.phase, Phase::Accepted);
    let world = host.world.lock().unwrap();
    assert!(!world.legacy_failed, "disabled and inactive, not failed");
    assert_eq!(world.legacy_reset_failed_calls, 1);
    assert!(world.legacy_installed, "the unit itself stays");
    assert_eq!(world.legacy, (false, false));
}

#[tokio::test]
async fn a_rollback_leaves_the_legacy_player_unit_state_alone() {
    let host = FakeHost::migration().with(|w| {
        w.legacy_stop_leaves_failed = true;
        w.edge = Edge::NeverConnects;
    });
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(attempt.phase, Phase::RolledBack);
    assert_eq!(host.world.lock().unwrap().legacy_reset_failed_calls, 0, "only acceptance normalizes it");
}

#[tokio::test]
async fn a_failed_import_rolls_back_before_edge_ever_starts() {
    let host = FakeHost::migration().with(|w| w.import_exit = 1);
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(attempt.phase, Phase::RolledBack);
    assert_eq!(attempt.reason.as_deref(), Some("import_failed: installation_identity_mismatch"));
    assert!(attempt.edge_started_at_ms.is_none());
    assert_one_stack(&host, Phase::RolledBack, "import failure");
}

#[tokio::test]
async fn a_second_migration_after_a_rollback_imports_again() {
    let host = FakeHost::migration().with(|w| w.edge = Edge::NeverConnects);
    let dir = tempfile::tempdir().unwrap();
    let first = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(first.phase, Phase::RolledBack);
    host.world.lock().unwrap().edge = Edge::Healthy;
    let second = migrator(&host, &dir).run(&options()).await.unwrap();
    assert_eq!(second.phase, Phase::Accepted);
    assert_ne!(first.attempt_id, second.attempt_id);
    assert_eq!(host.world.lock().unwrap().imports, 2, "every attempt imports (with --refresh)");
    assert!(dir.path().join("state/previous.json").exists(), "the earlier attempt is kept");
    assert_one_stack(&host, Phase::Accepted, "second attempt");
}

#[tokio::test]
async fn an_unfinished_attempt_must_be_recovered_first() {
    let host = FakeHost::migration();
    let dir = tempfile::tempdir().unwrap();
    let crashed = migrator(&host, &dir).crash_at(Some(CrashPoint::AfterImport)).run(&options()).await;
    assert!(matches!(crashed, Err(MigrateError::Crashed(_))));
    assert!(matches!(migrator(&host, &dir).run(&options()).await, Err(MigrateError::Unfinished)));
    // An operator rollback finishes it.
    let rolled = migrator(&host, &dir).operator_rollback().await.unwrap().unwrap();
    assert_eq!((rolled.phase, rolled.reason.as_deref()), (Phase::RolledBack, Some("operator_requested")));
    assert_one_stack(&host, Phase::RolledBack, "operator rollback");
}

#[tokio::test]
async fn a_clean_install_settles_on_the_setup_surface_or_restores_the_display() {
    let host = FakeHost::clean().with(|w| w.edge = Edge::Unpaired);
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&clean_options()).await.unwrap();
    assert_eq!(attempt.phase, Phase::Accepted, "{:?}", attempt.reason);
    assert!(attempt.compat.is_none() && attempt.import.is_none(), "nothing to check or import");
    assert_eq!(host.unit_state(EDGE_DAEMON), (true, true));
    assert_eq!(host.unit_state("gdm3.service"), (false, false));
    assert!(host.world.lock().unwrap().violations.is_empty());

    // A renderer that cannot show the setup surface: Edge is disabled again
    // and the display session comes back.
    let host = FakeHost::clean().with(|w| w.edge = Edge::Incompatible);
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&clean_options()).await.unwrap();
    assert_eq!((attempt.phase, attempt.reason.as_deref()), (Phase::RolledBack, Some("presentation_incompatible")));
    assert_eq!(host.unit_state(EDGE_DAEMON), (false, false));
    assert_eq!(host.unit_state("gdm3.service"), (true, true));
    assert!(host.world.lock().unwrap().violations.is_empty());

    // A legacy player that is running blocks a clean install.
    let host = FakeHost::clean().with(|w| w.legacy = (true, true));
    let dir = tempfile::tempdir().unwrap();
    let attempt = migrator(&host, &dir).run(&clean_options()).await.unwrap();
    assert_eq!(attempt.reason.as_deref(), Some("legacy_player_running"));
}

/// Exhaustive on purpose: a new crash point does not compile until it is
/// placed here, and the test then requires it in `CrashPoint::ALL`, which
/// the matrix above runs.
fn position(point: CrashPoint) -> usize {
    use CrashPoint::*;
    match point {
        AfterStarted => 0,
        AfterSelfTest => 1,
        AfterCompat => 2,
        AfterCutoverIntent => 3,
        AfterProbation => 4,
        AfterRecoverEnabled => 5,
        AfterLegacyDisabled => 6,
        AfterLegacyStopped => 7,
        AfterDisplayStopped => 8,
        AfterLegacyStoppedSaved => 9,
        AfterStage => 10,
        AfterImport => 11,
        AfterImportedSaved => 12,
        AfterEdgeStartIntent => 13,
        AfterEdgeEnabled => 14,
        AfterDaemonStarted => 15,
        AfterWebStarted => 16,
        AfterRendererStarted => 17,
        AfterSettlingSaved => 18,
        DuringSettling => 19,
        AfterAcceptIntent => 20,
        AfterProbationCleared => 21,
        AfterRecoverDisabled => 22,
        AfterRollbackIntent => 23,
        AfterEdgeDisabled => 24,
        AfterEdgeStopped => 25,
        AfterDisplayRestored => 26,
        AfterLegacyEnabled => 27,
        AfterLegacyStarted => 28,
    }
}

#[test]
fn every_crash_point_is_in_the_matrix() {
    for (index, point) in CrashPoint::ALL.into_iter().enumerate() {
        assert_eq!(position(point), index, "{point:?}");
        assert_eq!(CrashPoint::parse(&point.name()), Some(point));
    }
}
