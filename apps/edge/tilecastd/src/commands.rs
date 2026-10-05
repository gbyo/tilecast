//! Linux command handlers and migration hold for the shared coordinator.
use player_core::PassOutcome;
use std::sync::Arc;

/// The daemon's command task.
pub async fn run(context: Arc<crate::daemon::DaemonContext>) {
    let Some(core) = context.core.as_ref() else { return };
    let coordinator = core
        .commands(crate::command_handlers::DaemonHandlers::new(&context))
        .with_hold(|| std::path::Path::new(edge_platform::paths::MIGRATION_PROBATION_FILE).exists());
    if let Err(error) = coordinator.recover().await {
        tracing::error!(component = "commands", event = "recovery_failed", reason = error.reason_code());
        return;
    }
    let server = context.command_server.subscribe();
    let mut held = false;
    core.run_commands(&coordinator, server, &context.command_wake, &context.shutdown, |outcome| {
        if (outcome == PassOutcome::Held) != held {
            held = !held;
            tracing::info!(component = "commands", event = if held { "held_for_migration" } else { "released" });
        }
        if outcome == PassOutcome::CredentialRejected {
            // The server link owns the credential and deletes it only on its
            // own explicit rejection; wake it to confirm.
            context.command_server.send_replace(None);
            context.server_wake.notify_one();
        }
    })
    .await;
}
