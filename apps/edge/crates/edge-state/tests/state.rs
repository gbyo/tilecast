//! Migration, restart-safety and repository tests against real SQLite files.

use edge_protocol::capability::{Capability, CapabilityId, CapabilityState};
use edge_protocol::signed::change::{AuthorityKey, AuthorityTrust, verify_change};
use edge_protocol::signed::{Purpose, SigningKey};
use edge_protocol::{NodeId, Sha256Digest, Timestamp};
use edge_state::repo::{self, cas, changes, commands, daemon};
use edge_state::{Migration, OpenOptions, StateDb, StateError, latest_schema_version, migrate_with, open_connection};
use serde_json::json;

fn now() -> Timestamp {
    Timestamp::parse("2026-09-22T19:00:00Z").expect("time")
}

fn temp_db() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("state.db");
    (dir, path)
}

#[test]
fn fresh_database_migrates_and_reopens_idempotently() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let version = db.run_blocking(|c| edge_state::schema_version(c)).expect("version");
    assert_eq!(version, latest_schema_version());
    let mode: String = db.run_blocking(|c| Ok(c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?)).expect("pragma");
    assert_eq!(mode, "wal");
    let sync: i64 = db.run_blocking(|c| Ok(c.query_row("PRAGMA synchronous", [], |r| r.get(0))?)).expect("pragma");
    assert_eq!(sync, 2, "synchronous = FULL");
    drop(db);
    let reopened = StateDb::open(&path, OpenOptions { integrity_check: true }).expect("reopen");
    assert_eq!(reopened.run_blocking(|c| edge_state::schema_version(c)).expect("version"), latest_schema_version());
}

#[test]
fn newer_schema_is_refused_not_rewritten() {
    let (_dir, path) = temp_db();
    drop(StateDb::open(&path, OpenOptions::default()).expect("open"));
    {
        let connection = rusqlite::Connection::open(&path).expect("raw open");
        connection
            .execute("INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (99, 'future', 0)", [])
            .expect("insert");
    }
    match StateDb::open(&path, OpenOptions::default()) {
        Err(StateError::NewerSchema { found: 99, .. }) => {}
        other => panic!("expected NewerSchema, got {other:?}"),
    }
    let connection = rusqlite::Connection::open(&path).expect("raw open");
    let tables: i64 = connection
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'daemon_state'", [], |r| r.get(0))
        .expect("query");
    assert_eq!(tables, 1, "existing data untouched");
}

#[test]
fn failed_migration_rolls_back_completely() {
    let (_dir, path) = temp_db();
    let connection = open_connection(&path, OpenOptions::default()).expect("open");
    let broken = [
        Migration { version: 1, name: "initial", sql: edge_state::MIGRATIONS[0].sql },
        Migration { version: 2, name: "broken", sql: "CREATE TABLE half_done (id INTEGER); THIS IS NOT SQL;" },
    ];
    let error = migrate_with(&connection, &broken).expect_err("migration fails");
    assert!(matches!(error, StateError::Migration { version: 2, .. }));
    assert_eq!(edge_state::schema_version(&connection).expect("version"), 1);
    let half: i64 = connection
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'half_done'", [], |r| r.get(0))
        .expect("query");
    assert_eq!(half, 0, "partial DDL rolled back");
}

#[test]
fn garbage_file_is_an_error_and_is_left_in_place() {
    let (_dir, path) = temp_db();
    std::fs::write(&path, vec![0x42u8; 8192]).expect("write garbage");
    assert!(StateDb::open(&path, OpenOptions { integrity_check: true }).is_err());
    assert_eq!(std::fs::read(&path).expect("read").len(), 8192, "never recreated");
}

#[test]
fn restart_cycles_track_clean_and_unclean_shutdowns() {
    let (_dir, path) = temp_db();
    for cycle in 0..200u64 {
        let db = StateDb::open(&path, OpenOptions { integrity_check: cycle % 50 == 0 }).expect("open");
        let record = db.run_blocking(|c| daemon::record_start(c, now(), "0.1.0")).expect("start");
        assert_eq!(record.boot_count, cycle + 1);
        // Every third run "crashes" without a clean shutdown.
        let crashed_previous = cycle > 0 && (cycle - 1) % 3 == 2;
        assert_eq!(record.previous_run_unclean, crashed_previous, "cycle {cycle}");
        if cycle % 3 != 2 {
            db.run_blocking(|c| daemon::record_clean_shutdown(c, now())).expect("shutdown");
            db.checkpoint().expect("checkpoint");
        }
    }
}

#[test]
fn node_identity_is_immutable() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let first: NodeId = "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a".parse().expect("id");
    let second: NodeId = "2f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a".parse().expect("id");
    db.run_blocking(|c| daemon::set_node_identity(c, first, daemon::NodeIdentitySource::LegacyImport, now()))
        .expect("set");
    db.run_blocking(|c| daemon::set_node_identity(c, first, daemon::NodeIdentitySource::LegacyImport, now()))
        .expect("idempotent");
    assert!(
        db.run_blocking(|c| daemon::set_node_identity(c, second, daemon::NodeIdentitySource::Generated, now()))
            .is_err()
    );
}

#[test]
fn change_feed_advances_only_along_the_chain() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let key = SigningKey::from_seed(&[4u8; 32]);
    let installation = "5a0b8f3e-2c1d-4e6f-8a9b-0c1d2e3f4a5b";
    let trust = AuthorityTrust {
        installation_id: installation.parse().expect("id"),
        keys: vec![AuthorityKey { epoch: 1, public_key: key.public_key().clone() }],
    };
    let change = |sequence: u64, previous: u64| {
        let body = json!({
            "schema": 1, "installationId": installation, "authorityEpoch": 1,
            "sequence": sequence, "previousSequence": previous,
            "type": "screen.configuration.changed",
            "target": {"kind": "installation", "id": null}, "object": null,
            "revocationGeneration": 0, "issuedAt": "2026-09-22T19:00:00Z", "expiresAt": null, "payload": {}
        });
        verify_change(&key.sign(Purpose::ServerChange, &body, None).expect("sign"), &trust).expect("verify")
    };
    db.run_blocking(|c| changes::set_baseline(c, 40, now())).expect("baseline");
    let skip = change(50, 45);
    assert!(
        !db.run_blocking(|c| changes::record_applied(c, &skip, "peer", changes::ApplyOutcome::Applied, now()))
            .expect("query")
    );
    let next = change(47, 40);
    assert!(
        db.run_blocking(|c| changes::record_applied(c, &next, "server", changes::ApplyOutcome::Applied, now()))
            .expect("query")
    );
    let state = db.run_blocking(|c| changes::feed_state(c)).expect("state").expect("present");
    assert_eq!(state.position.last_sequence, 47);
    assert_eq!(db.run_blocking(|c| changes::stored_digest(c, 47)).expect("digest"), Some(next.body_digest));
    assert_eq!(db.run_blocking(|c| changes::documents_after(c, 40, 10)).expect("docs").len(), 1);
    // A lower baseline never moves the position backwards.
    db.run_blocking(|c| changes::set_baseline(c, 10, now())).expect("baseline");
    assert_eq!(
        db.run_blocking(|c| changes::feed_state(c)).expect("state").expect("present").position.last_sequence,
        47
    );
}

#[test]
fn capability_revision_moves_only_on_material_change() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let make = |state, at: Timestamp| vec![Capability::new(CapabilityId::new("mesh.zenoh").expect("id"), state, at)];
    let (first, changed) = db
        .run_blocking(|c| repo::capabilities::replace(c, make(CapabilityState::Available, now()), now()))
        .expect("replace");
    assert_eq!((first.revision, changed), (1, true));
    let later = now().saturating_add(time_minutes(5));
    let (same, changed) = db
        .run_blocking(|c| repo::capabilities::replace(c, make(CapabilityState::Available, later), later))
        .expect("replace");
    assert_eq!((same.revision, changed), (1, false));
    let (next, changed) = db
        .run_blocking(|c| repo::capabilities::replace(c, make(CapabilityState::Degraded, later), later))
        .expect("replace");
    assert_eq!((next.revision, changed), (2, true));
    let loaded = db.run_blocking(|c| repo::capabilities::load(c)).expect("load").expect("stored");
    assert_eq!(loaded.snapshot.capabilities[0].state, CapabilityState::Degraded);
}

fn time_minutes(minutes: i64) -> ::time::Duration {
    ::time::Duration::minutes(minutes)
}

#[test]
fn pinned_objects_are_never_eviction_candidates() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let a = Sha256Digest::of(b"a");
    let b = Sha256Digest::of(b"b");
    for (digest, age) in [(a, 1), (b, 2)] {
        let record = cas::ObjectRecord {
            sha256: digest,
            size_bytes: 1,
            domain: cas::Domain::Media,
            content_type: None,
            peerable: true,
            source_kind: cas::SourceKind::Origin,
            verify_state: cas::VerifyState::Verified,
            verified_at: now(),
            created_at: now(),
            last_accessed_at: Timestamp::from_unix_seconds(age).expect("time"),
        };
        db.run_blocking(|c| cas::put_object(c, &record)).expect("put");
    }
    db.run_blocking(|c| cas::replace_pins(c, cas::PinReason::ActivePresentation, "activation-1", &[a], now()))
        .expect("pin");
    let candidates = db.run_blocking(|c| cas::eviction_candidates(c, 10)).expect("candidates");
    assert_eq!(candidates.iter().map(|o| o.sha256).collect::<Vec<_>>(), vec![b]);
    let usage = db.run_blocking(|c| cas::usage(c)).expect("usage");
    assert_eq!((usage.object_count, usage.used_bytes, usage.pinned_bytes), (2, 2, 1));
}

#[test]
fn command_idempotency_survives_reopen() {
    let (_dir, path) = temp_db();
    {
        let db = StateDb::open(&path, OpenOptions::default()).expect("open");
        assert_eq!(
            db.run_blocking(|c| commands::observe(c, "cmd-1", "restart_player_process", now())).expect("observe"),
            commands::CommandState::Received
        );
        db.run_blocking(|c| commands::advance(c, "cmd-1", commands::CommandState::Executing, None, now()))
            .expect("advance");
    }
    let db = StateDb::open(&path, OpenOptions::default()).expect("reopen");
    assert_eq!(
        db.run_blocking(|c| commands::observe(c, "cmd-1", "restart_player_process", now())).expect("observe"),
        commands::CommandState::Executing,
        "a restart sees the command was already started and must not run it again"
    );
}

#[test]
fn outbox_is_bounded_and_coalesces() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    use repo::outbox::{OutboxKind, due, enqueue};
    for index in 0..(repo::outbox::MAX_ROWS + 20) {
        db.run_blocking(|c| enqueue(c, OutboxKind::ActivityEvent, &format!("event-{index}"), "{}", now()))
            .expect("enqueue");
    }
    db.run_blocking(|c| enqueue(c, OutboxKind::EdgeStatus, "status", "{\"a\":1}", now())).expect("enqueue");
    db.run_blocking(|c| enqueue(c, OutboxKind::EdgeStatus, "status", "{\"a\":2}", now())).expect("enqueue");
    let status = db.run_blocking(|c| due(c, OutboxKind::EdgeStatus, now(), 10)).expect("due");
    assert_eq!(status.len(), 1);
    assert_eq!(status[0].payload, "{\"a\":2}");
    let total: i64 =
        db.run_blocking(|c| Ok(c.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0))?)).expect("count");
    assert_eq!(total, repo::outbox::MAX_ROWS);
}

#[tokio::test]
async fn async_access_runs_on_blocking_pool() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let record = db
        .run(|c| daemon::record_start(c, Timestamp::from_unix_seconds(1).expect("time"), "0.1.0"))
        .await
        .expect("start");
    assert!(record.first_start);
}
