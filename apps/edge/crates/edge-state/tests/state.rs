//! Migration, restart-safety and repository tests against real SQLite files.

use edge_protocol::capability::{Capability, CapabilityId, CapabilityState};
use edge_protocol::{InstallationId, PlayerId, ScreenId, Sha256Digest, Timestamp};
use edge_state::repo::manifests::{self, Binding, Stage, StoredManifest, Target};
use edge_state::repo::{self, cas, daemon};
use edge_state::{Migration, OpenOptions, StateDb, StateError, latest_schema_version, migrate_with, open_connection};

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
    let latest = latest_schema_version();
    let mut broken: Vec<Migration> =
        edge_state::MIGRATIONS.iter().map(|m| Migration { version: m.version, name: m.name, sql: m.sql }).collect();
    broken.push(Migration {
        version: latest + 1,
        name: "broken",
        sql: "CREATE TABLE half_done (id INTEGER); THIS IS NOT SQL;",
    });
    let error = migrate_with(&connection, &broken).expect_err("migration fails");
    assert!(matches!(error, StateError::Migration { version, .. } if version == latest + 1));
    assert_eq!(edge_state::schema_version(&connection).expect("version"), latest);
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
fn player_identity_is_immutable() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let first: PlayerId = "1f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a".parse().expect("id");
    let second: PlayerId = "2f0c3c9e-7d2a-4b6e-9a51-0c8f2e4d6b7a".parse().expect("id");
    db.run_blocking(|c| daemon::set_player_identity(c, first, daemon::PlayerIdentitySource::LegacyImport, now()))
        .expect("set");
    db.run_blocking(|c| daemon::set_player_identity(c, first, daemon::PlayerIdentitySource::LegacyImport, now()))
        .expect("idempotent");
    assert!(
        db.run_blocking(|c| daemon::set_player_identity(c, second, daemon::PlayerIdentitySource::Generated, now()))
            .is_err()
    );
}

#[test]
fn capability_revision_moves_only_on_material_change() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let make =
        |state, at: Timestamp| vec![Capability::new(CapabilityId::new("audio.pipewire").expect("id"), state, at)];
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
fn outbox_is_bounded_oldest_first_with_counters() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    use repo::outbox::{MAX_ROWS, MAX_TELEMETRY_ROWS, OutboxKind, enqueue_activity, enqueue_telemetry, pending, stats};
    let id = |i: i64| format!("{:08x}-0000-4000-8000-{:012x}", i, i);
    // Telemetry keeps only its share of the bound, oldest dropped.
    for i in 0..(MAX_TELEMETRY_ROWS + 5) {
        db.run_blocking(|c| enqueue_telemetry(c, &id(100_000 + i), "{}", now())).expect("telemetry");
    }
    // Activity sequences are allocated in the same transaction and never reused.
    let mut sequences = vec![];
    for i in 0..(MAX_ROWS + 7) {
        let sequence = db
            .run_blocking(|c| enqueue_activity(c, &id(i), now(), |seq| format!("{{\"sequence\":{seq}}}")))
            .expect("activity");
        sequences.push(sequence);
    }
    assert_eq!(sequences.first(), Some(&1));
    assert!(sequences.windows(2).all(|w| w[1] == w[0] + 1));
    let total: i64 =
        db.run_blocking(|c| Ok(c.query_row("SELECT COUNT(*) FROM outbox", [], |r| r.get(0))?)).expect("count");
    assert_eq!(total, MAX_ROWS);
    let stats = db.run_blocking(|c| stats(c)).expect("stats");
    assert_eq!(stats.dropped_telemetry, MAX_TELEMETRY_ROWS as u64 + 5, "every telemetry row went before activity");
    assert_eq!(stats.dropped_activity, 7);
    let oldest = db.run_blocking(|c| pending(c, OutboxKind::ActivityEvent, 1)).expect("pending");
    assert_eq!(oldest[0].body, "{\"sequence\":8}", "the oldest activity rows were dropped first");
    // The sequence survives a reopen.
    drop(db);
    let db = StateDb::open(&path, OpenOptions::default()).expect("reopen");
    let next = db.run_blocking(|c| enqueue_activity(c, &id(9_999), now(), |seq| seq.to_string())).expect("again");
    assert_eq!(next, MAX_ROWS + 8);
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

fn binding() -> Binding {
    Binding {
        installation_id: InstallationId::new_random(),
        screen_id: ScreenId::new_random(),
        server_url: "https://signage.example".to_owned(),
    }
}

fn target(db: &StateDb, binding: &Binding, digest: Sha256Digest, version: i64) {
    let target = Target {
        binding: binding.clone(),
        digest,
        version,
        etag: format!("\"{}\"", digest.to_hex()),
        document: serde_json::json!({"manifestVersion": version}),
        fetched_at: now(),
    };
    db.run_blocking(move |c| manifests::put_target(c, &target)).expect("target");
}

fn stored(binding: &Binding, digest: Sha256Digest, version: i64) -> StoredManifest {
    StoredManifest {
        binding: binding.clone(),
        digest,
        version,
        document: serde_json::json!({"manifestVersion": version}),
        stored_at: now(),
    }
}

#[test]
fn prepared_manifest_survives_restart_and_promotes_without_losing_previous() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let binding = binding();
    let (a, b) = (Sha256Digest::of(b"a"), Sha256Digest::of(b"b"));
    let first = stored(&binding, a, 7);
    let pending = first.clone();
    assert!(!db.run_blocking(move |c| manifests::put_pending_for_target(c, &pending)).unwrap(), "not the target yet");
    target(&db, &binding, a, 7);
    let pending = first.clone();
    assert!(db.run_blocking(move |c| manifests::put_pending_for_target(c, &pending)).unwrap());
    drop(db);
    let db = StateDb::open(&path, OpenOptions { integrity_check: true }).expect("reopen");
    assert_eq!(db.run_blocking(|c| manifests::get_for(c, Stage::Active, &binding)).unwrap(), None);
    assert_eq!(db.run_blocking(|c| manifests::get_for(c, Stage::Pending, &binding)).unwrap(), Some(first.clone()));
    let promote = binding.clone();
    assert!(db.run_blocking(move |c| manifests::promote_pending(c, &promote, &a)).unwrap());

    let second = stored(&binding, b, 8);
    target(&db, &binding, b, 8);
    let pending = second.clone();
    assert!(db.run_blocking(move |c| manifests::put_pending_for_target(c, &pending)).unwrap());
    let promote = binding.clone();
    assert!(!db.run_blocking(move |c| manifests::promote_pending(c, &promote, &a)).unwrap(), "wrong digest");
    let promote = binding.clone();
    assert!(db.run_blocking(move |c| manifests::promote_pending(c, &promote, &b)).unwrap());
    drop(db);
    let reopened = StateDb::open(&path, OpenOptions { integrity_check: true }).expect("reopen again");
    assert_eq!(reopened.run_blocking(|c| manifests::get_for(c, Stage::Active, &binding)).unwrap(), Some(second));
    assert_eq!(reopened.run_blocking(|c| manifests::get_for(c, Stage::Previous, &binding)).unwrap(), Some(first));
    assert_eq!(reopened.run_blocking(|c| manifests::get_for(c, Stage::Pending, &binding)).unwrap(), None);
}

#[test]
fn superseded_preparation_can_never_become_active() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let binding = binding();
    let (b, c_digest) = (Sha256Digest::of(b"b"), Sha256Digest::of(b"c"));
    target(&db, &binding, b, 5);
    let prepared = stored(&binding, b, 5);
    assert!(db.run_blocking(move |c| manifests::put_pending_for_target(c, &prepared)).unwrap());
    // C becomes the server's answer before B is confirmed.
    target(&db, &binding, c_digest, 6);
    let promote = binding.clone();
    assert!(!db.run_blocking(move |c| manifests::promote_pending(c, &promote, &b)).unwrap());
    assert_eq!(db.run_blocking(|c| manifests::get_for(c, Stage::Active, &binding)).unwrap(), None);
    let late = stored(&binding, b, 5);
    assert!(!db.run_blocking(move |c| manifests::put_pending_for_target(c, &late)).unwrap(), "late preparation");
    let discard = binding.clone();
    assert!(db.run_blocking(move |c| manifests::discard_pending(c, &discard, &b)).unwrap());
}

#[test]
fn cached_manifest_is_bound_to_one_screen_server_and_version() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let binding = binding();
    let digest = Sha256Digest::of(b"active");
    target(&db, &binding, digest, 10);
    let active = stored(&binding, digest, 10);
    let pending = active.clone();
    db.run_blocking(move |c| manifests::put_pending_for_target(c, &pending)).unwrap();
    let promote = binding.clone();
    db.run_blocking(move |c| manifests::promote_pending(c, &promote, &digest)).unwrap();
    let stale = Target {
        binding: binding.clone(),
        digest: Sha256Digest::of(b"stale"),
        version: 9,
        etag: "\"stale\"".to_owned(),
        document: serde_json::json!({}),
        fetched_at: now(),
    };
    assert!(db.run_blocking(move |c| manifests::put_target(c, &stale)).is_err(), "versions never regress");
    let foreign = Binding { screen_id: ScreenId::new_random(), ..binding.clone() };
    assert_eq!(db.run_blocking(|c| manifests::get_for(c, Stage::Active, &foreign)).unwrap(), None);
    let foreign = Binding { server_url: "https://other.example".to_owned(), ..binding.clone() };
    assert_eq!(db.run_blocking(|c| manifests::get_for(c, Stage::Active, &foreign)).unwrap(), None);
    let foreign = Binding { installation_id: InstallationId::new_random(), ..binding.clone() };
    assert_eq!(db.run_blocking(|c| manifests::get_for(c, Stage::Active, &foreign)).unwrap(), None);
    assert_eq!(db.run_blocking(move |c| manifests::target(c, &foreign)).unwrap(), None);
}

#[test]
fn noise_history_is_bounded_acknowledged_exactly_and_sanitized() {
    use edge_state::repo::noise_history::{self, Bucket};
    let dir = tempfile::tempdir().expect("tempdir");
    let mut connection = open_connection(&dir.path().join("state.db"), OpenOptions::default()).expect("open");
    let now = 1_790_000_000_000i64;
    let bucket = |start: i64| Bucket {
        started_at_ms: start,
        average_level: 40.0,
        peak_level: 60.0,
        monitored_ms: 10_000,
        warning_ms: 1_000,
        loud_ms: 500,
        trigger_count: 1,
    };
    // Sanitizing aligns to the grid, refuses the future and impossible sums.
    let aligned = noise_history::sanitize(&bucket(now - 12_345), now, 7).expect("valid");
    assert_eq!(aligned.started_at_ms % noise_history::BUCKET_MS, 0);
    assert!(noise_history::sanitize(&bucket(now + 3_600_000), now, 7).is_none(), "from the future");
    assert!(noise_history::sanitize(&bucket(now - 8 * 86_400_000), now, 7).is_none(), "past retention");
    assert!(noise_history::sanitize(&Bucket { warning_ms: 9_000, loud_ms: 2_000, ..bucket(now) }, now, 7).is_none());
    assert!(noise_history::sanitize(&Bucket { average_level: f64::NAN, ..bucket(now) }, now, 7).is_none());
    let raised = noise_history::sanitize(&Bucket { peak_level: 10.0, ..bucket(now) }, now, 7).expect("valid");
    assert_eq!(raised.peak_level, 40.0, "a peak is never below the average");

    for index in 0..5 {
        let start = (now / 10_000 - 10 + index) * 10_000;
        noise_history::add(&mut connection, &bucket(start), now, 7).expect("add");
    }
    // A repeated slot replaces, never duplicates.
    let first = (now / 10_000 - 10) * 10_000;
    noise_history::add(&mut connection, &Bucket { average_level: 1.0, ..bucket(first) }, now, 7).expect("add");
    assert_eq!(noise_history::count(&connection).expect("count"), 5);
    let batch = noise_history::peek(&connection, 3).expect("peek");
    assert_eq!(batch.len(), 3);
    assert_eq!(batch[0].average_level, 1.0);
    // Peeking removes nothing; a partial acknowledgement removes only that many.
    let sent: Vec<i64> = batch.iter().map(|b| b.started_at_ms).collect();
    assert_eq!(noise_history::acknowledge(&mut connection, &sent, 0).expect("ack"), 0);
    assert_eq!(noise_history::acknowledge(&mut connection, &sent, 2).expect("ack"), 2);
    assert_eq!(noise_history::count(&connection).expect("count"), 3);
    assert_eq!(noise_history::peek(&connection, 120).expect("peek")[0].started_at_ms, sent[2]);

    // Retention moves with the plugin's setting.
    let later = now + 2 * 86_400_000;
    noise_history::add(&mut connection, &bucket((later / 10_000) * 10_000), later, 1).expect("add");
    assert_eq!(noise_history::count(&connection).expect("count"), 1, "a one-day window prunes the rest");
}

#[test]
fn the_presentation_network_state_has_no_place_for_a_credential() {
    use edge_state::repo::presentation_network::{self, NetworkState};
    let dir = tempfile::tempdir().expect("tempdir");
    let connection = open_connection(&dir.path().join("state.db"), OpenOptions::default()).expect("open");
    let now = edge_protocol::Timestamp::parse("2026-09-25T12:00:00Z").expect("time");
    assert_eq!(presentation_network::get(&connection).expect("get"), NetworkState::default());
    assert!(NetworkState::default().radio_was_enabled, "the safe default never turns a radio off");
    let state = NetworkState {
        active_network_id: Some("6f0c2b1e-9d2a-4b7e-8f3a-2c1d0e9f8a7b".into()),
        radio_was_enabled: false,
    };
    presentation_network::put(&connection, &state, now).expect("put");
    assert_eq!(presentation_network::get(&connection).expect("get"), state);
    let columns: Vec<String> = connection
        .prepare("SELECT name FROM pragma_table_info('presentation_network_state')")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("columns");
    assert_eq!(columns, ["singleton", "active_network_id", "radio_was_enabled", "updated_at_ms"]);
}
