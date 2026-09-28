//! Command records and accepted configuration: migration from every earlier
//! schema, the durable command lifecycle and configuration promotion.

use edge_protocol::{InstallationId, ScreenId, Timestamp};
use edge_state::repo::commands::{self, CommandResult, CommandState, ReportState};
use edge_state::repo::config::{self, AcceptOutcome, ConfigStage};
use edge_state::repo::manifests::Binding;
use edge_state::{MIGRATIONS, OpenOptions, StateDb, migrate_with};
use serde_json::json;

const KEY: &str = "5c0b1f0e-8f1a-4c55-9a53-27f2f0b2f0aa";
const ID_1: &str = "0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa";
const ID_2: &str = "0f6b2f0e-2222-4c55-9a53-27f2f0b2f0aa";

fn now() -> Timestamp {
    Timestamp::parse("2026-09-24T12:00:00Z").expect("time")
}

fn later(ms: i64) -> Timestamp {
    Timestamp::from_unix_millis(now().unix_millis() + ms).expect("time")
}

fn temp_db() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("state.db");
    (dir, path)
}

/// A database left at `version` by an earlier build, holding the legacy
/// idempotency keys that build's importer wrote.
fn database_at(version: u32, path: &std::path::Path) {
    let connection = rusqlite::Connection::open(path).expect("raw open");
    let migrations: Vec<_> = MIGRATIONS.iter().filter(|m| m.version <= version).collect();
    let owned: Vec<edge_state::Migration> =
        migrations.iter().map(|m| edge_state::Migration { version: m.version, name: m.name, sql: m.sql }).collect();
    migrate_with(&connection, &owned).expect("migrate to the earlier schema");
    for key in ["legacy-key-1", KEY] {
        connection
            .execute(
                "INSERT INTO command_idempotency (command_id, command_type, state, result_code, received_at_ms,
                                                  completed_at_ms)
                 VALUES (?1, 'legacy_import', 'completed', 'imported', 1, 1)",
                [key],
            )
            .expect("legacy row");
    }
}

#[test]
fn legacy_keys_survive_migration_from_every_earlier_schema() {
    for version in [1, 2] {
        let (_dir, path) = temp_db();
        database_at(version, &path);
        let db = StateDb::open(&path, OpenOptions { integrity_check: true }).expect("migrate");
        for key in ["legacy-key-1", KEY] {
            let record = db.run_blocking(|c| commands::get(c, key)).expect("read").expect("row kept");
            assert_eq!(record.state, CommandState::Completed, "from schema {version}");
            assert_eq!(record.report_state, ReportState::NotRequired);
            assert_eq!(record.command_id, None);
            assert!(record.result.as_ref().is_some_and(|r| r.success));
        }
        let old_table: i64 = db
            .run_blocking(|c| {
                Ok(c.query_row("SELECT count(*) FROM sqlite_master WHERE name = 'command_idempotency'", [], |row| {
                    row.get(0)
                })?)
            })
            .expect("schema");
        assert_eq!(old_table, 0, "the key-by-delivery table is gone");
        // A delivery of an imported key never becomes runnable.
        let seen = db.run_blocking(|c| commands::observe(c, KEY, ID_1, "reload_playback", now())).expect("observe");
        assert_eq!(seen.state, CommandState::Completed);
        assert_eq!(seen.report_state, ReportState::Pending, "the stored result is resent to the new delivery");
        assert!(!db.run_blocking(|c| commands::begin_executing(c, KEY, now())).expect("begin"));
    }
}

#[test]
fn a_new_delivery_id_for_a_completed_key_never_executes_and_resends_the_stored_result() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let first = db.run_blocking(|c| commands::observe(c, KEY, ID_1, "disable_playback", now())).expect("observe");
    assert_eq!(first.state, CommandState::Received);
    assert!(db.run_blocking(|c| commands::begin_executing(c, KEY, now())).expect("begin"));
    assert!(!db.run_blocking(|c| commands::begin_executing(c, KEY, now())).expect("begin twice"));
    let result = CommandResult::ok("playback_disabled", "");
    assert!(db.run_blocking(|c| commands::complete(c, KEY, &result, ReportState::Pending, now())).expect("complete"));
    db.run_blocking(|c| commands::mark_reported(c, KEY, ID_1, now())).expect("reported");

    let redelivered =
        db.run_blocking(|c| commands::observe(c, KEY, ID_2, "disable_playback", later(10))).expect("observe");
    assert_eq!(redelivered.state, CommandState::Completed);
    assert_eq!(redelivered.command_id.as_deref(), Some(ID_2));
    assert_eq!(redelivered.result, Some(result.clone()), "the original result, not a generic one");
    assert_eq!(redelivered.report_state, ReportState::Pending);
    assert!(!db.run_blocking(|c| commands::begin_executing(c, KEY, now())).expect("begin"));
    // A report acknowledged for the old delivery does not settle the new one.
    db.run_blocking(|c| commands::mark_reported(c, KEY, ID_1, now())).expect("stale report");
    let pending = db.run_blocking(|c| commands::pending_reports(c, 10)).expect("pending");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].command_id.as_deref(), Some(ID_2));
    // A completed result is never overwritten.
    let other = CommandResult::failed("command_failed", "");
    assert!(!db.run_blocking(|c| commands::complete(c, KEY, &other, ReportState::Pending, now())).expect("complete"));
}

#[test]
fn executing_rows_are_settled_as_interrupted_after_a_restart() {
    let (_dir, path) = temp_db();
    {
        let db = StateDb::open(&path, OpenOptions::default()).expect("open");
        db.run_blocking(|c| commands::observe(c, KEY, ID_1, "restart_player_process", now())).expect("observe");
        db.run_blocking(|c| commands::mark_acknowledged(c, KEY, now())).expect("ack");
        assert!(db.run_blocking(|c| commands::begin_executing(c, KEY, now())).expect("begin"));
        // The process dies inside the handler.
    }
    let db = StateDb::open(&path, OpenOptions { integrity_check: true }).expect("reopen");
    assert_eq!(db.run_blocking(|c| commands::recover_interrupted(c, later(5))).expect("recover"), 1);
    let record = db.run_blocking(|c| commands::get(c, KEY)).expect("read").expect("row");
    assert_eq!(record.state, CommandState::Completed);
    let result = record.result.expect("result");
    assert!(!result.success);
    assert_eq!(result.code, commands::INTERRUPTED_CODE);
    assert_eq!(record.report_state, ReportState::Pending);
    assert!(!db.run_blocking(|c| commands::begin_executing(c, KEY, now())).expect("begin"));
    assert_eq!(db.run_blocking(|c| commands::recover_interrupted(c, later(6))).expect("recover"), 0);
}

#[test]
fn pruning_keeps_unreported_results_and_running_commands() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let old = Timestamp::from_unix_millis(1_000).expect("time");
    let setup = |key: &str, id: &str| {
        db.run_blocking(|c| commands::observe(c, key, id, "reload_playback", old).map(|_| ())).expect("observe");
    };
    setup("unreported", ID_1);
    db.run_blocking(|c| commands::begin_executing(c, "unreported", old)).expect("begin");
    db.run_blocking(|c| {
        commands::complete(c, "unreported", &CommandResult::ok("x", ""), ReportState::Pending, old).map(|_| ())
    })
    .expect("complete");
    setup("running", ID_2);
    db.run_blocking(|c| commands::begin_executing(c, "running", old)).expect("begin");
    setup("reported", "0f6b2f0e-3333-4c55-9a53-27f2f0b2f0aa");
    db.run_blocking(|c| commands::begin_executing(c, "reported", old)).expect("begin");
    db.run_blocking(|c| {
        commands::complete(c, "reported", &CommandResult::ok("x", ""), ReportState::Pending, old).map(|_| ())
    })
    .expect("complete");
    db.run_blocking(|c| commands::mark_reported(c, "reported", "0f6b2f0e-3333-4c55-9a53-27f2f0b2f0aa", old))
        .expect("reported");
    setup("never-started", "0f6b2f0e-4444-4c55-9a53-27f2f0b2f0aa");

    let removed = db.run_blocking(|c| commands::prune(c, now())).expect("prune");
    assert_eq!(removed, 2);
    for (key, kept) in [("unreported", true), ("running", true), ("reported", false), ("never-started", false)] {
        assert_eq!(db.run_blocking(|c| commands::get(c, key)).expect("read").is_some(), kept, "{key}");
    }
}

#[test]
fn pruning_bounds_the_table() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    db.run_blocking(|c| {
        for index in 0..(commands::MAX_ROWS + 25) {
            commands::import_completed(c, &format!("key-{index:05}"), later(index))?;
        }
        Ok(())
    })
    .expect("import");
    db.run_blocking(|c| commands::prune(c, now())).expect("prune");
    assert_eq!(db.run_blocking(|c| commands::count(c)).expect("count"), commands::MAX_ROWS);
    assert!(db.run_blocking(|c| commands::get(c, "key-00000")).expect("read").is_none(), "oldest first");
}

fn binding() -> Binding {
    Binding {
        installation_id: InstallationId::new_random(),
        screen_id: ScreenId::new_random(),
        server_url: "https://signs.example.org".to_owned(),
    }
}

#[test]
fn configuration_moves_only_forward_and_keeps_the_previous_document() {
    let (_dir, path) = temp_db();
    let mut binding_value = binding();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    let accept = |revision: i64, etag: &str, marker: &str, bind: &Binding| {
        let (bind, etag, document) = (bind.clone(), etag.to_owned(), json!({"configRevision": revision, "m": marker}));
        db.run_blocking(move |c| config::accept(c, &bind, 1, revision, Some(&etag), &document, now())).expect("accept")
    };
    assert_eq!(accept(3, "\"e3\"", "three", &binding_value), AcceptOutcome::Accepted);
    assert_eq!(accept(3, "\"e3b\"", "three-again", &binding_value), AcceptOutcome::NotNewer { current_revision: 3 });
    assert_eq!(accept(2, "\"e2\"", "two", &binding_value), AcceptOutcome::NotNewer { current_revision: 3 });
    assert_eq!(accept(4, "\"e4\"", "four", &binding_value), AcceptOutcome::Accepted);
    let bind = binding_value.clone();
    let current = db.run_blocking(move |c| config::get_for(c, ConfigStage::Current, &bind)).expect("read").unwrap();
    assert_eq!((current.revision, current.etag.as_deref()), (4, Some("\"e4\"")));
    assert_eq!(current.document["m"], "four");
    let bind = binding_value.clone();
    let previous = db.run_blocking(move |c| config::get_for(c, ConfigStage::Previous, &bind)).expect("read").unwrap();
    assert_eq!((previous.revision, previous.etag), (3, None));

    // Another screen never sees this screen's configuration, and its first
    // acceptance replaces both rows instead of inheriting them.
    binding_value.screen_id = ScreenId::new_random();
    let bind = binding_value.clone();
    assert!(db.run_blocking(move |c| config::get_for(c, ConfigStage::Current, &bind)).expect("read").is_none());
    assert_eq!(accept(1, "\"x1\"", "other", &binding_value), AcceptOutcome::Accepted);
    let bind = binding_value.clone();
    assert!(db.run_blocking(move |c| config::get_for(c, ConfigStage::Previous, &bind)).expect("read").is_none());
}

#[test]
fn configuration_outcomes_are_recorded_in_place() {
    let (_dir, path) = temp_db();
    let db = StateDb::open(&path, OpenOptions::default()).expect("open");
    db.run_blocking(|c| config::record_outcome(c, None, now())).expect("ok");
    db.run_blocking(|c| config::record_outcome(c, Some(&"x".repeat(200)), later(1))).expect("error");
    let status = db.run_blocking(|c| config::status(c)).expect("status");
    assert_eq!(status.last_fetched_at, Some(now()));
    assert_eq!(status.last_error_code.as_deref().map(str::len), Some(64));
    db.run_blocking(|c| config::record_outcome(c, None, later(2))).expect("ok");
    let status = db.run_blocking(|c| config::status(c)).expect("status");
    assert_eq!((status.last_fetched_at, status.last_error_code), (Some(later(2)), None));
}
