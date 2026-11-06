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
/// A transient provisioning failure is retried after this long, then after
/// twice as long each time, up to [`PROBE_INTERVAL`].
const RETRY_INITIAL: Duration = Duration::from_secs(30);

/// The delay before the next provisioning retry after `previous`.
fn next_retry_delay(previous: Option<Duration>) -> Duration {
    previous.map_or(RETRY_INITIAL, |delay| (delay * 2).min(PROBE_INTERVAL))
}

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
    // The delay of the retry that is armed, if any.
    let mut retry: Option<Duration> = None;
    let mut retry_at: Option<tokio::time::Instant> = None;
    loop {
        enum Wake {
            Configuration,
            Probe,
            Retry,
        }
        let wake = tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = context.network_wake.notified() => Wake::Configuration,
            _ = ticker.tick() => Wake::Probe,
            () = async {
                match retry_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => Wake::Retry,
        };
        let provisioner = ServerProvisioner::new(&context);
        match wake {
            Wake::Configuration => {
                let section = crate::config_sync::effective(&context).platform.presentation_network.clone();
                context.network.apply_configuration(section.as_ref(), &provisioner, context.now()).await;
                retry = None;
                retry_at = None;
            }
            Wake::Probe => {
                context.network.probe().await;
            }
            Wake::Retry => context.network.retry_provisioning(&provisioner, context.now()).await,
        }
        // A failure that can pass by itself keeps one retry armed, with a
        // growing delay; anything else clears it.
        if context.network.provisioning_retry_pending().await {
            if retry_at.is_none_or(|at| at <= tokio::time::Instant::now()) {
                let delay = next_retry_delay(retry);
                retry = Some(delay);
                retry_at = Some(tokio::time::Instant::now() + delay);
            }
        } else {
            retry = None;
            retry_at = None;
        }
        let now = context.network.status();
        if now != last {
            last = now;
            crate::capabilities::refresh(&context).await;
            context.report_status_soon();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_grows_to_the_probe_interval() {
        let mut delay = None;
        let mut seen = Vec::new();
        for _ in 0..6 {
            let next = next_retry_delay(delay);
            seen.push(next.as_secs());
            delay = Some(next);
        }
        assert_eq!(seen, [30, 60, 120, 240, 300, 300]);
    }
}
