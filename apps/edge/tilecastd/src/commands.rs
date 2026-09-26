//! Player commands (M4): at-most-once local execution with durable
//! non-replay.
//!
//! Commands come only from the ordinary command endpoint. It is polled at
//! once when the authenticated server relationship starts, every
//! [`POLL_INTERVAL`] for as long as it lasts (whether or not the player
//! WebSocket is up), and at once on a `commands.available` push. One task
//! runs every pass, so a timer tick and a push can never race into two
//! handlers; a push that arrives during a pass causes exactly one more.
//!
//! For each delivery:
//!
//! ```text
//! validate → record by idempotency key → acknowledge → acknowledged
//!          → executing (committed) → fixed typed handler → completed result
//!          → report → reported
//! ```
//!
//! * The handler runs only after `executing` has committed. A record found
//!   `executing` at start may or may not have had its effect, so it is never
//!   run again: it is completed as `command_interrupted` and that result is
//!   reported. This is why the guarantee is at-most-once, not exactly-once.
//! * A completed record is never executed again, under its first delivery ID
//!   or any later one. Every delivery of a completed key receives the stored
//!   result, not a reconstructed one.
//! * Result delivery is separate from execution. A result the server has not
//!   taken is retried on every pass and after restarts until the server takes
//!   it or can no longer take it (expired or cancelled).
//! * An expired or cancelled command is never executed. A transient
//!   acknowledgement failure only postpones it.
//! * A disruptive command (one that restarts this process) persists its
//!   `initiated` result and tries to report it, bounded in time, before the
//!   disruption starts; the next process resends it if the report was lost.
//!
//! Commands whose feature belongs to a later milestone are answered with a
//! typed `unsupported_command` result, never silently ignored. There is no
//! generic command: every supported type has a fixed handler.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::time::SharedClock;
use edge_server::AuthenticatedServer;
use edge_server::client::ServerError;
use edge_server::player_api::{AcknowledgeOutcome, CommandBatch, ReportOutcome, ServerCommand};
use edge_state::StateDb;
use edge_state::repo::commands::{self, CommandResult, CommandState, ReportState};
use tokio::sync::{Notify, watch};
use tokio_util::sync::CancellationToken;

pub const POLL_INTERVAL: Duration = Duration::from_secs(7);
/// How long a disruptive command waits for its result report before it
/// disrupts anyway; the stored result is resent by the next process.
pub const REPORT_BEFORE_DISRUPTION_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REPORTS_PER_PASS: usize = 32;

/// The server side of the command contract.
#[async_trait]
pub trait CommandApi: Send + Sync {
    async fn fetch(&self) -> Result<CommandBatch, ServerError>;
    async fn acknowledge(&self, id: uuid::Uuid) -> Result<AcknowledgeOutcome, ServerError>;
    async fn report(&self, id: uuid::Uuid, result: &CommandResult) -> Result<ReportOutcome, ServerError>;
}

#[async_trait]
impl CommandApi for AuthenticatedServer {
    async fn fetch(&self) -> Result<CommandBatch, ServerError> {
        self.player_commands().await
    }

    async fn acknowledge(&self, id: uuid::Uuid) -> Result<AcknowledgeOutcome, ServerError> {
        self.acknowledge_command(id).await
    }

    async fn report(&self, id: uuid::Uuid, result: &CommandResult) -> Result<ReportOutcome, ServerError> {
        self.report_command_result(id, result.success, &result.code, &result.message).await
    }
}

#[async_trait]
impl<T: CommandApi + ?Sized> CommandApi for Arc<T> {
    async fn fetch(&self) -> Result<CommandBatch, ServerError> {
        self.as_ref().fetch().await
    }

    async fn acknowledge(&self, id: uuid::Uuid) -> Result<AcknowledgeOutcome, ServerError> {
        self.as_ref().acknowledge(id).await
    }

    async fn report(&self, id: uuid::Uuid, result: &CommandResult) -> Result<ReportOutcome, ServerError> {
        self.as_ref().report(id, result).await
    }
}

/// How a command type is handled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// A fixed handler that returns while this process keeps running.
    Run,
    /// A handler that ends this process.
    Disruptive,
    /// Settled without running anything.
    Settle(CommandResult),
}

/// The fixed handlers. Implementations never run a command twice because
/// the coordinator never calls them twice for one idempotency key.
#[async_trait]
pub trait Handlers: Send + Sync {
    fn plan(&self, command: &ServerCommand) -> Plan;
    async fn run(&self, command: &ServerCommand) -> CommandResult;
    /// Validates a disruptive command. `Ok` is the `initiated` result that is
    /// persisted before the disruption; `Err` a failure that disrupts
    /// nothing.
    async fn prepare_disruption(&self, command: &ServerCommand) -> Result<CommandResult, CommandResult>;
    /// Starts the disruption. Called only after the result is durable.
    fn disrupt(&self, command: &ServerCommand);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassOutcome {
    Completed,
    CredentialRejected,
    /// The server could not be reached or answered with a transient error;
    /// nothing unsafe happened and the next pass retries.
    Interrupted(&'static str),
    /// A disruptive command started; the coordinator stops.
    Disrupted,
}

enum Step {
    Continue,
    Stop(PassOutcome),
}

fn server_step(error: &ServerError) -> Step {
    match error {
        ServerError::CredentialRejected => Step::Stop(PassOutcome::CredentialRejected),
        other => Step::Stop(PassOutcome::Interrupted(other.reason_code())),
    }
}

#[derive(Debug)]
pub struct Coordinator<H> {
    db: StateDb,
    clock: SharedClock,
    handlers: H,
}

impl<H: Handlers> Coordinator<H> {
    pub fn new(db: StateDb, clock: SharedClock, handlers: H) -> Self {
        Self { db, clock, handlers }
    }

    pub fn handlers(&self) -> &H {
        &self.handlers
    }

    /// Settles what a previous run left `executing` and prunes old records.
    /// Runs at start, before any network access.
    pub async fn recover(&self) -> Result<usize, edge_state::StateError> {
        let now = self.clock.now();
        let interrupted = self.db.run(move |c| commands::recover_interrupted(c, now)).await?;
        if interrupted > 0 {
            tracing::warn!(component = "commands", event = "interrupted_commands_settled", count = interrupted);
        }
        let _ = self.db.run(move |c| commands::prune(c, now)).await;
        Ok(interrupted)
    }

    /// One pass: resend stored results, then fetch and handle deliveries.
    pub async fn pass<A: CommandApi + ?Sized>(&self, api: &A) -> PassOutcome {
        if let Step::Stop(outcome) = self.flush_reports(api).await {
            return outcome;
        }
        let batch = match api.fetch().await {
            Ok(batch) => batch,
            Err(error) => {
                if let Step::Stop(outcome) = server_step(&error) {
                    return outcome;
                }
                return PassOutcome::Interrupted("command_fetch_failed");
            }
        };
        for rejected in &batch.rejected {
            tracing::warn!(component = "commands", event = "command_rejected", reason = rejected.reason);
            // Invalid deliveries are answered without running anything. They
            // have no usable idempotency key, so nothing is recorded; the
            // server treats a repeated report as success.
            if let Some(id) = rejected.id {
                let result = CommandResult::failed(rejected.reason, "The command was malformed and was not run.");
                if let Err(ServerError::CredentialRejected) = api.report(id, &result).await {
                    return PassOutcome::CredentialRejected;
                }
            }
        }
        for command in &batch.commands {
            match self.handle(api, command).await {
                Step::Continue => {}
                Step::Stop(outcome) => return outcome,
            }
        }
        PassOutcome::Completed
    }

    async fn flush_reports<A: CommandApi + ?Sized>(&self, api: &A) -> Step {
        let Ok(pending) = self.db.run(|c| commands::pending_reports(c, MAX_REPORTS_PER_PASS)).await else {
            return Step::Stop(PassOutcome::Interrupted("state_unavailable"));
        };
        for record in pending {
            let (Some(id), Some(result)) = (record.command_id.as_deref(), record.result.as_ref()) else { continue };
            let Ok(id) = uuid::Uuid::parse_str(id) else { continue };
            if let Step::Stop(outcome) = self.report(api, &record.idempotency_key, id, result).await {
                return Step::Stop(outcome);
            }
        }
        Step::Continue
    }

    async fn report<A: CommandApi + ?Sized>(&self, api: &A, key: &str, id: uuid::Uuid, result: &CommandResult) -> Step {
        let (key, id_text, now) = (key.to_owned(), id.to_string(), self.clock.now());
        match api.report(id, result).await {
            Ok(ReportOutcome::Accepted) => {
                let _ = self.db.run(move |c| commands::mark_reported(c, &key, &id_text, now)).await;
                Step::Continue
            }
            Ok(ReportOutcome::NotAccepted) => {
                tracing::info!(component = "commands", event = "result_not_accepted", code = result.code.as_str());
                let _ = self.db.run(move |c| commands::mark_abandoned(c, &key, &id_text, now)).await;
                Step::Continue
            }
            // Kept pending: the next pass or the next process resends it.
            Err(error) => server_step(&error),
        }
    }

    async fn complete(&self, key: &str, result: &CommandResult, report: ReportState) -> Result<(), Step> {
        let (key, result_copy, now) = (key.to_owned(), result.clone(), self.clock.now());
        self.db
            .run(move |c| commands::complete(c, &key, &result_copy, report, now))
            .await
            .map(|_| ())
            .map_err(|_| Step::Stop(PassOutcome::Interrupted("state_unavailable")))
    }

    async fn handle<A: CommandApi + ?Sized>(&self, api: &A, command: &ServerCommand) -> Step {
        let (key, id, kind, now) =
            (command.idempotency_key.clone(), command.id.to_string(), command.command_type.clone(), self.clock.now());
        let Ok(record) = self.db.run(move |c| commands::observe(c, &key, &id, &kind, now)).await else {
            return Step::Stop(PassOutcome::Interrupted("state_unavailable"));
        };
        match record.state {
            CommandState::Completed => {
                // Already settled here, possibly under another delivery or by
                // the legacy player. Never run again; send what is stored.
                let Some(result) = record.result else { return Step::Continue };
                tracing::info!(
                    component = "commands",
                    event = "redelivery_answered",
                    command_type = command.command_type.as_str(),
                    code = result.code.as_str()
                );
                return self.report(api, &command.idempotency_key, command.id, &result).await;
            }
            // Only this task executes, and start-up settles every executing
            // record before the first pass: nothing to do.
            CommandState::Executing => return Step::Continue,
            CommandState::Received | CommandState::Acknowledged => {}
        }

        match api.acknowledge(command.id).await {
            Ok(AcknowledgeOutcome::Acknowledged) => {
                let (key, now) = (command.idempotency_key.clone(), self.clock.now());
                if self.db.run(move |c| commands::mark_acknowledged(c, &key, now)).await.is_err() {
                    return Step::Stop(PassOutcome::Interrupted("state_unavailable"));
                }
            }
            Ok(AcknowledgeOutcome::AlreadySettled { succeeded }) => {
                let result = CommandResult::new(
                    succeeded,
                    "already_completed",
                    "The server already holds a result for this command.",
                );
                return match self.complete(&command.idempotency_key, &result, ReportState::NotRequired).await {
                    Ok(()) => Step::Continue,
                    Err(step) => step,
                };
            }
            Ok(AcknowledgeOutcome::NotActionable) => {
                tracing::info!(
                    component = "commands",
                    event = "command_not_actionable",
                    command_type = command.command_type.as_str()
                );
                let result = CommandResult::failed("command_not_actionable", "The command expired or was cancelled.");
                return match self.complete(&command.idempotency_key, &result, ReportState::Abandoned).await {
                    Ok(()) => Step::Continue,
                    Err(step) => step,
                };
            }
            // Not executed yet; the next pass retries the acknowledgement.
            Err(error) => return server_step(&error),
        }

        let plan = self.handlers.plan(command);
        if let Plan::Settle(result) = plan {
            if let Err(step) = self.complete(&command.idempotency_key, &result, ReportState::Pending).await {
                return step;
            }
            return self.report(api, &command.idempotency_key, command.id, &result).await;
        }

        let (key, now) = (command.idempotency_key.clone(), self.clock.now());
        match self.db.run(move |c| commands::begin_executing(c, &key, now)).await {
            Ok(true) => {}
            Ok(false) => return Step::Continue,
            Err(_) => return Step::Stop(PassOutcome::Interrupted("state_unavailable")),
        }
        tracing::info!(
            component = "commands",
            event = "command_executing",
            command_type = command.command_type.as_str()
        );

        if plan == Plan::Disruptive {
            let result = match self.handlers.prepare_disruption(command).await {
                Ok(initiated) => initiated,
                Err(failure) => {
                    if let Err(step) = self.complete(&command.idempotency_key, &failure, ReportState::Pending).await {
                        return step;
                    }
                    return self.report(api, &command.idempotency_key, command.id, &failure).await;
                }
            };
            if let Err(step) = self.complete(&command.idempotency_key, &result, ReportState::Pending).await {
                // The result could not be stored: the record stays
                // `executing` and is settled as interrupted by the next
                // process. Do not disrupt without a durable result.
                return step;
            }
            let _ = tokio::time::timeout(
                REPORT_BEFORE_DISRUPTION_TIMEOUT,
                self.report(api, &command.idempotency_key, command.id, &result),
            )
            .await;
            tracing::warn!(
                component = "commands",
                event = "command_disrupting",
                command_type = command.command_type.as_str()
            );
            self.handlers.disrupt(command);
            return Step::Stop(PassOutcome::Disrupted);
        }

        let result = self.handlers.run(command).await;
        tracing::info!(
            component = "commands",
            event = "command_completed",
            command_type = command.command_type.as_str(),
            success = result.success,
            code = result.code.as_str()
        );
        if let Err(step) = self.complete(&command.idempotency_key, &result, ReportState::Pending).await {
            return step;
        }
        self.report(api, &command.idempotency_key, command.id, &result).await
    }
}

/// Drives passes: at once when a server becomes available, every
/// [`POLL_INTERVAL`] of monotonic time while it stays available, and at once
/// on `wake`. Returns when `shutdown` fires, a disruptive command started, or
/// `on_rejected` reports that the credential is gone.
pub async fn drive<H, A>(
    coordinator: &Coordinator<H>,
    mut server: watch::Receiver<Option<A>>,
    wake: &Notify,
    shutdown: &CancellationToken,
    mut on_outcome: impl FnMut(PassOutcome),
) where
    H: Handlers,
    A: CommandApi + Clone,
{
    // The first pass is the one at the top of the loop; the cadence starts
    // one interval after it.
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + POLL_INTERVAL, POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let current = server.borrow_and_update().clone();
        if let Some(api) = current {
            let outcome = coordinator.pass(&api).await;
            on_outcome(outcome);
            if outcome == PassOutcome::Disrupted {
                return;
            }
        }
        tokio::select! {
            () = shutdown.cancelled() => return,
            _ = ticker.tick() => {}
            () = wake.notified() => {}
            changed = server.changed() => {
                if changed.is_err() {
                    return;
                }
                // A new relationship polls at once and restarts the cadence.
                ticker.reset();
            }
        }
    }
}

/// The daemon's command task.
pub async fn run(context: Arc<crate::daemon::DaemonContext>) {
    let Some(db) = context.db().cloned() else { return };
    let coordinator =
        Coordinator::new(db, context.clock.clone(), crate::command_handlers::DaemonHandlers::new(&context));
    if let Err(error) = coordinator.recover().await {
        tracing::error!(component = "commands", event = "recovery_failed", reason = error.reason_code());
        return;
    }
    let server = context.command_server.subscribe();
    drive(&coordinator, server, &context.command_wake, &context.shutdown, |outcome| {
        if outcome == PassOutcome::CredentialRejected {
            // The server link owns the credential and deletes it only on its
            // own explicit rejection; wake it to confirm.
            context.command_server.send_replace(None);
            context.server_wake.notify_one();
        }
    })
    .await;
}
