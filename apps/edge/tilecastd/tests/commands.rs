//! The command crash-point and redelivery matrix (docs/tilecast-edge.md §19
//! rule 6): a real coordinator over real SQLite files, a scripted server
//! API and recording handlers. A "crash" is the coordinator being dropped or
//! its task aborted at a chosen point, then a new coordinator opening the
//! same database, as a restarted daemon does.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::time::{SharedClock, system_clock};
use edge_server::client::ServerError;
use edge_server::player_api::{AcknowledgeOutcome, CommandBatch, RejectedCommand, ReportOutcome, ServerCommand};
use edge_state::repo::commands::{self, CommandResult, CommandState, ReportState};
use edge_state::{OpenOptions, StateDb};
use tilecastd::commands::{Coordinator, Handlers, POLL_INTERVAL, PassOutcome, Plan, drive};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

const KEY: &str = "5c0b1f0e-8f1a-4c55-9a53-27f2f0b2f0aa";

fn id(n: u8) -> uuid::Uuid {
    uuid::Uuid::parse_str(&format!("0f6b2f0e-{n:04}-4c55-9a53-27f2f0b2f0aa")).unwrap()
}

fn command(delivery: uuid::Uuid, command_type: &str) -> ServerCommand {
    ServerCommand {
        id: delivery,
        command_type: command_type.to_owned(),
        idempotency_key: KEY.to_owned(),
        payload: serde_json::Map::new(),
    }
}

/// The server: deliveries it offers, how it answers, what it received.
#[derive(Default)]
struct FakeApi {
    deliveries: Mutex<Vec<ServerCommand>>,
    rejected: Mutex<Vec<RejectedCommand>>,
    acknowledge: Mutex<HashMap<uuid::Uuid, VecDeque<Result<AcknowledgeOutcome, ServerError>>>>,
    reports_fail: AtomicBool,
    reports_hang: AtomicBool,
    reports_expired: AtomicBool,
    reports: Mutex<Vec<(uuid::Uuid, CommandResult)>>,
    fetches: AtomicUsize,
    /// When set, `fetch` waits for a permit (serialization test).
    gate: Option<Arc<tokio::sync::Semaphore>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    log: Mutex<Vec<String>>,
}

#[async_trait]
impl tilecastd::commands::CommandApi for FakeApi {
    async fn fetch(&self) -> Result<CommandBatch, ServerError> {
        let running = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(running, Ordering::SeqCst);
        if let Some(gate) = &self.gate {
            gate.acquire().await.unwrap().forget();
        }
        self.fetches.fetch_add(1, Ordering::SeqCst);
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        Ok(CommandBatch {
            commands: self.deliveries.lock().unwrap().clone(),
            rejected: self.rejected.lock().unwrap().clone(),
            deferred: 0,
        })
    }

    async fn acknowledge(&self, delivery: uuid::Uuid) -> Result<AcknowledgeOutcome, ServerError> {
        self.log.lock().unwrap().push(format!("ack {delivery}"));
        self.acknowledge
            .lock()
            .unwrap()
            .get_mut(&delivery)
            .and_then(VecDeque::pop_front)
            .unwrap_or(Ok(AcknowledgeOutcome::Acknowledged))
    }

    async fn report(&self, delivery: uuid::Uuid, result: &CommandResult) -> Result<ReportOutcome, ServerError> {
        self.log.lock().unwrap().push(format!("report {delivery} {}", result.code));
        if self.reports_hang.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        if self.reports_fail.load(Ordering::SeqCst) {
            return Err(ServerError::Network);
        }
        if self.reports_expired.load(Ordering::SeqCst) {
            return Ok(ReportOutcome::NotAccepted);
        }
        self.reports.lock().unwrap().push((delivery, result.clone()));
        // The server stops delivering a command once it holds its result.
        self.deliveries.lock().unwrap().retain(|command| command.id != delivery);
        Ok(ReportOutcome::Accepted)
    }
}

/// Handlers that record every execution.
#[derive(Clone)]
struct Recorder {
    db: StateDb,
    runs: Arc<AtomicUsize>,
    hang: Arc<AtomicBool>,
    entered: Arc<Notify>,
    disrupted: Arc<Mutex<Vec<Option<commands::CommandRecord>>>>,
    api: Arc<FakeApi>,
}

#[async_trait]
impl Handlers for Recorder {
    fn plan(&self, command: &ServerCommand) -> Plan {
        match command.command_type.as_str() {
            "restart_player_process" => Plan::Disruptive,
            "display_power_on" => Plan::Settle(CommandResult::failed("unsupported_command", "M9")),
            _ => Plan::Run,
        }
    }

    async fn run(&self, _command: &ServerCommand) -> CommandResult {
        self.runs.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        if self.hang.load(Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        CommandResult::ok("playback_reloaded", "")
    }

    async fn prepare_disruption(&self, _command: &ServerCommand) -> Result<CommandResult, CommandResult> {
        Ok(CommandResult::ok("initiated", "restart_player_process initiated"))
    }

    fn disrupt(&self, _command: &ServerCommand) {
        self.runs.fetch_add(1, Ordering::SeqCst);
        self.api.log.lock().unwrap().push("disrupt".to_owned());
        // What is durable at the moment the disruption starts.
        let record = self.db.run_blocking(|c| commands::get(c, KEY)).unwrap();
        self.disrupted.lock().unwrap().push(record);
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    api: Arc<FakeApi>,
    runs: Arc<AtomicUsize>,
    hang: Arc<AtomicBool>,
    entered: Arc<Notify>,
    disrupted: Arc<Mutex<Vec<Option<commands::CommandRecord>>>>,
}

impl Harness {
    fn new() -> Self {
        Self::with_api(FakeApi::default())
    }

    fn with_api(api: FakeApi) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.db");
        Self {
            _dir: dir,
            path,
            api: Arc::new(api),
            runs: Arc::default(),
            hang: Arc::default(),
            entered: Arc::default(),
            disrupted: Arc::default(),
        }
    }

    fn clock(&self) -> SharedClock {
        system_clock()
    }

    /// A coordinator as a (re)started daemon builds it.
    async fn start(&self) -> Coordinator<Recorder> {
        let db = StateDb::open(&self.path, OpenOptions::default()).unwrap();
        let recorder = Recorder {
            db: db.clone(),
            runs: Arc::clone(&self.runs),
            hang: Arc::clone(&self.hang),
            entered: Arc::clone(&self.entered),
            disrupted: Arc::clone(&self.disrupted),
            api: Arc::clone(&self.api),
        };
        let coordinator = Coordinator::new(db, self.clock(), recorder);
        coordinator.recover().await.unwrap();
        coordinator
    }

    fn deliver(&self, command: ServerCommand) {
        self.api.deliveries.lock().unwrap().push(command);
    }

    fn record(&self) -> commands::CommandRecord {
        let db = StateDb::open(&self.path, OpenOptions::default()).unwrap();
        db.run_blocking(|c| commands::get(c, KEY)).unwrap().expect("record")
    }

    fn reports(&self) -> Vec<(uuid::Uuid, String)> {
        self.api.reports.lock().unwrap().iter().map(|(id, r)| (*id, r.code.clone())).collect()
    }
}

#[tokio::test]
async fn a_first_delivery_executes_once_and_reports_its_result() {
    let h = Harness::new();
    h.deliver(command(id(1), "reload_playback"));
    let coordinator = h.start().await;
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
    assert_eq!(h.reports(), vec![(id(1), "playback_reloaded".to_owned())]);
    let record = h.record();
    assert_eq!((record.state, record.report_state), (CommandState::Completed, ReportState::Reported));
    // Nothing more is delivered; later passes run nothing.
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
    let log = h.api.log.lock().unwrap().clone();
    assert_eq!(log[0], format!("ack {}", id(1)), "acknowledged before it ran");
}

#[tokio::test]
async fn the_same_delivery_again_is_answered_without_running() {
    let h = Harness::new();
    h.deliver(command(id(1), "reload_playback"));
    h.api.reports_fail.store(true, Ordering::SeqCst);
    let coordinator = h.start().await;
    assert!(matches!(coordinator.pass(&h.api).await, PassOutcome::Interrupted(_)));
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
    // The server still delivers it (no result yet); the network is back.
    h.api.reports_fail.store(false, Ordering::SeqCst);
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1, "never twice");
    assert_eq!(h.reports(), vec![(id(1), "playback_reloaded".to_owned())]);
}

#[tokio::test]
async fn a_new_delivery_id_with_a_completed_key_receives_the_stored_result() {
    let h = Harness::new();
    h.deliver(command(id(1), "reload_playback"));
    let coordinator = h.start().await;
    coordinator.pass(&h.api).await;
    h.deliver(command(id(2), "reload_playback"));
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
    assert_eq!(
        h.reports(),
        vec![(id(1), "playback_reloaded".to_owned()), (id(2), "playback_reloaded".to_owned())],
        "the original result, not a generic already-executed one"
    );
    assert!(!h.api.log.lock().unwrap().iter().any(|line| line == &format!("ack {}", id(2))));
}

#[tokio::test]
async fn an_imported_legacy_key_suppresses_execution() {
    let h = Harness::new();
    {
        let db = StateDb::open(&h.path, OpenOptions::default()).unwrap();
        db.run_blocking(|c| commands::import_completed(c, KEY, system_clock().now())).unwrap();
    }
    h.deliver(command(id(3), "disable_playback"));
    let coordinator = h.start().await;
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 0);
    assert_eq!(h.reports(), vec![(id(3), "already_executed".to_owned())]);
    assert!(h.api.reports.lock().unwrap()[0].1.success);
}

#[tokio::test]
async fn a_crash_before_the_executing_commit_runs_the_command_after_restart() {
    for reached in [CommandState::Received, CommandState::Acknowledged] {
        let h = Harness::new();
        {
            // The previous process recorded the delivery (and maybe its
            // acknowledgement) and stopped before `executing` committed.
            let db = StateDb::open(&h.path, OpenOptions::default()).unwrap();
            let now = system_clock().now();
            db.run_blocking(|c| commands::observe(c, KEY, &id(1).to_string(), "reload_playback", now)).unwrap();
            if reached == CommandState::Acknowledged {
                db.run_blocking(|c| commands::mark_acknowledged(c, KEY, now)).unwrap();
            }
        }
        h.deliver(command(id(1), "reload_playback"));
        let coordinator = h.start().await;
        assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
        assert_eq!(h.runs.load(Ordering::SeqCst), 1, "safe to run: the handler had not begun ({reached:?})");
        assert_eq!(h.reports(), vec![(id(1), "playback_reloaded".to_owned())]);
    }
}

#[tokio::test]
async fn a_crash_inside_the_handler_is_reported_as_interrupted_and_never_rerun() {
    let h = Harness::new();
    h.deliver(command(id(1), "reload_playback"));
    h.hang.store(true, Ordering::SeqCst);
    {
        let coordinator = Arc::new(h.start().await);
        let api = Arc::clone(&h.api);
        let running = Arc::clone(&coordinator);
        let task = tokio::spawn(async move { running.pass(&api).await });
        h.entered.notified().await;
        // The process dies while the handler runs.
        task.abort();
        let _ = task.await;
    }
    assert_eq!(h.record().state, CommandState::Executing);
    h.hang.store(false, Ordering::SeqCst);

    let coordinator = h.start().await;
    let record = h.record();
    assert_eq!(record.state, CommandState::Completed);
    assert_eq!(record.result.as_ref().unwrap().code, commands::INTERRUPTED_CODE);
    // The server still offers the acknowledged command; it gets the stored
    // interrupted result and the handler is not entered again.
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
    assert_eq!(h.reports(), vec![(id(1), commands::INTERRUPTED_CODE.to_owned())]);
    assert!(!h.api.reports.lock().unwrap()[0].1.success);
}

#[tokio::test]
async fn a_crash_after_the_handler_but_before_the_report_resends_the_original_result() {
    let h = Harness::new();
    h.deliver(command(id(1), "reload_playback"));
    h.api.reports_fail.store(true, Ordering::SeqCst);
    {
        let coordinator = h.start().await;
        coordinator.pass(&h.api).await;
    }
    let record = h.record();
    assert_eq!((record.state, record.report_state), (CommandState::Completed, ReportState::Pending));
    // Restart; the server no longer offers it (for example after a server
    // restart it is still acknowledged but the first thing sent is the
    // pending report).
    h.api.deliveries.lock().unwrap().clear();
    h.api.reports_fail.store(false, Ordering::SeqCst);
    let coordinator = h.start().await;
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
    assert_eq!(h.reports(), vec![(id(1), "playback_reloaded".to_owned())]);
    assert_eq!(h.record().report_state, ReportState::Reported);
}

#[tokio::test]
async fn a_result_the_server_can_no_longer_take_stops_being_resent() {
    let h = Harness::new();
    h.deliver(command(id(1), "reload_playback"));
    h.api.reports_expired.store(true, Ordering::SeqCst);
    let coordinator = h.start().await;
    coordinator.pass(&h.api).await;
    assert_eq!(h.record().report_state, ReportState::Abandoned);
    assert_eq!(h.record().result.unwrap().code, "playback_reloaded", "the result itself is kept");
}

#[tokio::test]
async fn a_disruptive_command_persists_and_reports_its_result_before_disrupting() {
    let h = Harness::new();
    h.deliver(command(id(1), "restart_player_process"));
    let coordinator = h.start().await;
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Disrupted);
    let at_disruption = h.disrupted.lock().unwrap()[0].clone().expect("record");
    assert_eq!(at_disruption.state, CommandState::Completed);
    assert_eq!(at_disruption.result.unwrap().code, "initiated");
    let log = h.api.log.lock().unwrap().clone();
    let report = log.iter().position(|line| line.starts_with("report")).unwrap();
    let disrupt = log.iter().position(|line| line == "disrupt").unwrap();
    assert!(report < disrupt, "the report is attempted first: {log:?}");

    // The next process never restarts again for the same key.
    h.deliver(command(id(1), "restart_player_process"));
    let coordinator = h.start().await;
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_disruptive_command_does_not_wait_forever_for_an_unreachable_server() {
    let h = Harness::new();
    h.deliver(command(id(1), "restart_player_process"));
    h.api.reports_hang.store(true, Ordering::SeqCst);
    {
        let coordinator = h.start().await;
        assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Disrupted);
    }
    assert_eq!(h.record().report_state, ReportState::Pending, "durable, so the next process resends it");
    h.api.reports_hang.store(false, Ordering::SeqCst);
    h.api.deliveries.lock().unwrap().clear();
    let coordinator = h.start().await;
    coordinator.pass(&h.api).await;
    assert_eq!(h.reports(), vec![(id(1), "initiated".to_owned())]);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn expired_cancelled_or_already_settled_commands_never_execute() {
    for outcome in [AcknowledgeOutcome::NotActionable, AcknowledgeOutcome::AlreadySettled { succeeded: true }] {
        let h = Harness::new();
        h.deliver(command(id(1), "reload_playback"));
        h.api.acknowledge.lock().unwrap().insert(id(1), VecDeque::from([Ok(outcome)]));
        let coordinator = h.start().await;
        assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
        assert_eq!(h.runs.load(Ordering::SeqCst), 0, "{outcome:?}");
        assert!(h.reports().is_empty());
        assert_eq!(h.record().state, CommandState::Completed);
        // Even if it were offered again, it stays settled.
        coordinator.pass(&h.api).await;
        assert_eq!(h.runs.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn a_transient_acknowledgement_failure_postpones_without_executing() {
    let h = Harness::new();
    h.deliver(command(id(1), "reload_playback"));
    h.api.acknowledge.lock().unwrap().insert(id(1), VecDeque::from([Err(ServerError::Network)]));
    let coordinator = h.start().await;
    assert!(matches!(coordinator.pass(&h.api).await, PassOutcome::Interrupted(_)));
    assert_eq!(h.runs.load(Ordering::SeqCst), 0);
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unsupported_and_malformed_commands_get_typed_results_without_running() {
    let h = Harness::new();
    h.deliver(command(id(1), "display_power_on"));
    h.api.rejected.lock().unwrap().push(RejectedCommand { id: Some(id(9)), reason: "command_type_invalid" });
    h.api.rejected.lock().unwrap().push(RejectedCommand { id: None, reason: "command_malformed" });
    let coordinator = h.start().await;
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 0);
    let reports = h.reports();
    assert!(reports.contains(&(id(1), "unsupported_command".to_owned())));
    assert!(reports.contains(&(id(9), "command_type_invalid".to_owned())));
    assert_eq!(reports.len(), 2);
    assert!(h.api.reports.lock().unwrap().iter().all(|(_, result)| !result.success));
}

#[tokio::test]
async fn a_revoked_credential_stops_the_pass() {
    struct Revoked;
    #[async_trait]
    impl tilecastd::commands::CommandApi for Revoked {
        async fn fetch(&self) -> Result<CommandBatch, ServerError> {
            Err(ServerError::CredentialRejected)
        }
        async fn acknowledge(&self, _: uuid::Uuid) -> Result<AcknowledgeOutcome, ServerError> {
            unreachable!()
        }
        async fn report(&self, _: uuid::Uuid, _: &CommandResult) -> Result<ReportOutcome, ServerError> {
            unreachable!()
        }
    }
    let h = Harness::new();
    let coordinator = h.start().await;
    assert_eq!(coordinator.pass(&Revoked).await, PassOutcome::CredentialRejected);
}

/// Lets spawned work finish without moving the paused clock: state writes
/// run on the blocking pool, which advances in real time.
async fn settle() {
    for _ in 0..40 {
        std::thread::sleep(Duration::from_millis(2));
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn polling_starts_with_the_relationship_then_follows_the_timer_and_pushes() {
    let h = Harness::new();
    let coordinator = Arc::new(h.start().await);
    let (server, receiver) = watch::channel::<Option<Arc<FakeApi>>>(None);
    let wake = Arc::new(Notify::new());
    let shutdown = CancellationToken::new();
    let driver = {
        let (coordinator, wake, shutdown) = (Arc::clone(&coordinator), Arc::clone(&wake), shutdown.clone());
        tokio::spawn(async move { drive(&coordinator, receiver, &wake, &shutdown, |_| {}).await })
    };
    settle().await;
    tokio::time::advance(POLL_INTERVAL * 3).await;
    settle().await;
    assert_eq!(h.api.fetches.load(Ordering::SeqCst), 0, "nothing is polled without a verified server");

    server.send_replace(Some(Arc::clone(&h.api)));
    settle().await;
    assert_eq!(h.api.fetches.load(Ordering::SeqCst), 1, "at once when the relationship starts");

    tokio::time::advance(POLL_INTERVAL - Duration::from_millis(10)).await;
    settle().await;
    assert_eq!(h.api.fetches.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_millis(20)).await;
    settle().await;
    assert_eq!(h.api.fetches.load(Ordering::SeqCst), 2, "every seven seconds with no push at all");
    tokio::time::advance(POLL_INTERVAL).await;
    settle().await;
    assert_eq!(h.api.fetches.load(Ordering::SeqCst), 3);

    wake.notify_one();
    settle().await;
    assert_eq!(h.api.fetches.load(Ordering::SeqCst), 4, "commands.available polls at once");

    shutdown.cancel();
    driver.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn pushes_during_a_pass_cause_exactly_one_more_pass_never_a_concurrent_one() {
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let h = Harness::with_api(FakeApi { gate: Some(Arc::clone(&gate)), ..FakeApi::default() });
    h.deliver(command(id(1), "reload_playback"));
    let coordinator = Arc::new(h.start().await);
    let (_server, receiver) = watch::channel(Some(Arc::clone(&h.api)));
    let wake = Arc::new(Notify::new());
    let shutdown = CancellationToken::new();
    let driver = {
        let (coordinator, wake, shutdown) = (Arc::clone(&coordinator), Arc::clone(&wake), shutdown.clone());
        tokio::spawn(async move { drive(&coordinator, receiver, &wake, &shutdown, |_| {}).await })
    };
    settle().await;
    // The first pass is blocked inside fetch while two pushes arrive.
    wake.notify_one();
    wake.notify_one();
    settle().await;
    assert_eq!(h.api.in_flight.load(Ordering::SeqCst), 1);
    gate.add_permits(10);
    settle().await;
    assert_eq!(h.api.max_in_flight.load(Ordering::SeqCst), 1, "passes never overlap");
    assert_eq!(h.api.fetches.load(Ordering::SeqCst), 2, "the queued pushes collapse into one pass");
    assert_eq!(h.runs.load(Ordering::SeqCst), 1);
    shutdown.cancel();
    driver.await.unwrap();
}

#[tokio::test]
async fn a_migration_probation_leaves_commands_on_the_server_until_it_ends() {
    let h = Harness::new();
    h.deliver(command(id(1), "reload_playback"));
    let probation = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let held = Arc::clone(&probation);
    let coordinator = h.start().await.with_hold(move || held.load(Ordering::SeqCst));
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Held);
    assert_eq!(h.api.fetches.load(Ordering::SeqCst), 0, "nothing is fetched, so nothing is acknowledged");
    assert_eq!(h.runs.load(Ordering::SeqCst), 0);

    probation.store(false, Ordering::SeqCst);
    assert_eq!(coordinator.pass(&h.api).await, PassOutcome::Completed);
    assert_eq!(h.runs.load(Ordering::SeqCst), 1, "after acceptance the command runs once");
}
