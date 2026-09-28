//! Update job records (M10): acceptance is idempotent per deployment, a
//! retry restarts a finished failure, a newer deployment supersedes one that
//! has not started to change what runs, and the table stays bounded.
#![allow(clippy::unwrap_used)]

use edge_protocol::Sha256Digest;
use edge_state::repo::updates::{self, Accepted, JobState, Mode, NewJob};
use edge_state::{OpenOptions, open_connection};

fn new_job(n: u8) -> NewJob {
    NewJob {
        deployment_id: uuid::Uuid::parse_str(&format!("0f6b2f0e-{n:04}-4c55-9a53-27f2f0b2f0aa")).unwrap(),
        release_id: uuid::Uuid::parse_str("1f6b2f0e-0000-4c55-9a53-27f2f0b2f0aa").unwrap(),
        command_id: uuid::Uuid::new_v4(),
        expected_version_code: 2000,
        expected_artifact: Sha256Digest::of(b"archive"),
        mode: Mode::InstallNow,
        window_start_ms: None,
    }
}

#[test]
fn a_redelivered_command_finds_the_same_job_and_a_retry_restarts_a_failure() {
    let dir = tempfile::tempdir().unwrap();
    let mut connection = open_connection(&dir.path().join("state.db"), OpenOptions::default()).unwrap();
    let job = new_job(1);
    assert_eq!(updates::accept(&mut connection, &job, 1).unwrap(), Accepted::New);
    let mut again = job.clone();
    again.command_id = uuid::Uuid::new_v4();
    assert_eq!(updates::accept(&mut connection, &again, 2).unwrap(), Accepted::Existing(JobState::Accepted));

    let mut stored = updates::get(&connection, job.deployment_id).unwrap().unwrap();
    assert_eq!(stored.command_id, again.command_id, "the delivery follows the latest command");
    stored.state = JobState::Provisional;
    stored.envelope = Some(b"{}".to_vec());
    updates::save(&connection, &stored, 3).unwrap();
    assert_eq!(updates::accept(&mut connection, &job, 4).unwrap(), Accepted::Existing(JobState::Provisional));

    stored.state = JobState::RolledBack;
    stored.reason_code = Some("confirmation_timeout".into());
    stored.reported_state = Some("rolled_back".into());
    updates::save(&connection, &stored, 5).unwrap();
    assert_eq!(updates::accept(&mut connection, &job, 6).unwrap(), Accepted::Restarted);
    let restarted = updates::get(&connection, job.deployment_id).unwrap().unwrap();
    assert_eq!((restarted.state, restarted.reason_code, restarted.reported_state), (JobState::Accepted, None, None));
}

#[test]
fn a_newer_deployment_supersedes_only_what_has_not_started_to_run() {
    let dir = tempfile::tempdir().unwrap();
    let mut connection = open_connection(&dir.path().join("state.db"), OpenOptions::default()).unwrap();
    updates::accept(&mut connection, &new_job(1), 1).unwrap();
    updates::accept(&mut connection, &new_job(2), 2).unwrap();
    let first = updates::get(&connection, new_job(1).deployment_id).unwrap().unwrap();
    assert_eq!((first.state, first.reason_code.as_deref()), (JobState::Cancelled, Some("superseded")));

    let mut running = updates::get(&connection, new_job(2).deployment_id).unwrap().unwrap();
    running.state = JobState::Activating;
    updates::save(&connection, &running, 3).unwrap();
    updates::accept(&mut connection, &new_job(3), 4).unwrap();
    assert_eq!(updates::get(&connection, running.deployment_id).unwrap().unwrap().state, JobState::Activating);
    assert_eq!(updates::active(&connection).unwrap().unwrap().deployment_id, running.deployment_id);
}

#[test]
fn the_table_stays_bounded_and_keeps_unreported_results() {
    let dir = tempfile::tempdir().unwrap();
    let mut connection = open_connection(&dir.path().join("state.db"), OpenOptions::default()).unwrap();
    for n in 0..40u8 {
        let job = new_job(n);
        updates::accept(&mut connection, &job, i64::from(n) * 10).unwrap();
        let mut stored = updates::get(&connection, job.deployment_id).unwrap().unwrap();
        stored.state = JobState::Failed;
        // Every other failure has not reached the server yet.
        stored.reported_state = (n % 2 == 0).then(|| "failed".to_owned());
        updates::save(&connection, &stored, i64::from(n) * 10 + 1).unwrap();
    }
    let count: i64 = connection.query_row("SELECT count(*) FROM update_jobs", [], |r| r.get(0)).unwrap();
    assert!(count <= 40 && count >= updates::MAX_ROWS as i64);
    let unreported: i64 = connection
        .query_row("SELECT count(*) FROM update_jobs WHERE reported_state IS NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(unreported, 20, "no unreported result is pruned");
}
