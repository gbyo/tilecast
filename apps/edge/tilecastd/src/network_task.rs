//! The Presentation Network's daemon side: the credential source and the
//! task that keeps profiles in step with configuration
//! (`presentation_network`).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use edge_server::player_api::NetworkProvisioning;

use crate::daemon::DaemonContext;
use crate::presentation_network::Provisioner;

/// The helper's capability is refreshed this often without a change.
const PROBE_INTERVAL: Duration = Duration::from_secs(300);

/// Fetches the credential from the identity-verified server, for one helper
/// install call. Errors describe availability, never the credential.
#[derive(Debug)]
pub struct ServerProvisioner<'a> {
    context: &'a DaemonContext,
}

impl<'a> ServerProvisioner<'a> {
    pub fn new(context: &'a DaemonContext) -> Self {
        Self { context }
    }
}

#[async_trait]
impl Provisioner for ServerProvisioner<'_> {
    async fn provisioning(&self) -> Result<NetworkProvisioning, String> {
        let server = self.context.command_server.borrow().clone();
        let Some(server) = server else {
            return Err("The Tilecast Server is not reachable, so the credential could not be retrieved.".into());
        };
        server.presentation_network_provisioning().await.map_err(|error| match error {
            edge_server::ServerError::Api { code, .. } => {
                format!("The Presentation Network credential could not be retrieved ({code}).")
            }
            other => format!("The Presentation Network credential could not be retrieved ({}).", other.reason_code()),
        })
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    // Edge has no AirPlay session that could still be using a Tilecast
    // connection, so one that is up now was left by a crash.
    context.network.cleanup_orphaned(context.now()).await;
    let mut last = context.network.status();
    let mut ticker = tokio::time::interval(PROBE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;
    loop {
        let configuration = tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = context.network_wake.notified() => true,
            _ = ticker.tick() => false,
        };
        if configuration {
            let section = crate::config_sync::effective(&context).presentation_network.clone();
            let provisioner = ServerProvisioner::new(&context);
            context.network.apply_configuration(section.as_ref(), &provisioner, context.now()).await;
        } else {
            context.network.probe().await;
        }
        let now = context.network.status();
        if now != last {
            last = now;
            crate::capabilities::refresh(&context).await;
            context.report_status_soon();
        }
    }
}
