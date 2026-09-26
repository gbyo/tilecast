//! The helper's socket: one request per connection, from `tilecastd` only.
//!
//! `tilecast-edge-update.socket` listens on
//! `/run/tilecast-edge-update/update.sock` (root:tilecast, 0660), and systemd
//! starts the helper for the first connection. The helper answers requests
//! one at a time and exits after a minute without one.
//!
//! A peer must be the `tilecast` account (`SO_PEERCRED`) and its process must
//! be in `tilecast-edge.service`'s control group. The renderer and the
//! session bridge run as the same account but in other units, so they are
//! refused. Root uses the command line instead.

use std::time::Duration;

use base64::Engine as _;
use edge_release::protocol::{HelperRequest, HelperResponse, MAX_FRAME_BYTES, Phase, is_reason};
use tokio::io::{AsyncBufReadExt as _, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;

use crate::host::UpdateHost;
use crate::transaction::{Transaction, UpdateLock};
use crate::updater::{UpdateError, Updater};

pub const IDLE_EXIT: Duration = Duration::from_secs(60);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const LOCK_WAIT: Duration = Duration::from_secs(300);
/// The one control group whose processes may send requests.
pub const DAEMON_CGROUP: &str = "/system.slice/tilecast-edge.service";

/// Decides whether a connected peer may send requests.
pub trait PeerPolicy: Send + Sync {
    fn allow(&self, stream: &UnixStream) -> Result<(), &'static str>;
}

/// The production policy: the tilecast account, from the daemon's unit.
#[derive(Debug, Clone)]
pub struct DaemonOnly {
    pub tilecast_uid: u32,
}

#[cfg(target_os = "linux")]
impl PeerPolicy for DaemonOnly {
    fn allow(&self, stream: &UnixStream) -> Result<(), &'static str> {
        let credentials = rustix::net::sockopt::socket_peercred(stream).map_err(|_| "peer_unknown")?;
        if credentials.uid.as_raw() != self.tilecast_uid {
            return Err("peer_not_allowed");
        }
        let cgroup = std::fs::read_to_string(format!("/proc/{}/cgroup", credentials.pid.as_raw_nonzero()))
            .map_err(|_| "peer_unknown")?;
        if cgroup_is(&cgroup, DAEMON_CGROUP) { Ok(()) } else { Err("peer_not_allowed") }
    }
}

#[cfg(not(target_os = "linux"))]
impl PeerPolicy for DaemonOnly {
    fn allow(&self, _stream: &UnixStream) -> Result<(), &'static str> {
        Err("peer_not_allowed")
    }
}

/// Whether `/proc/<pid>/cgroup` text places the process exactly in `group`
/// on the unified hierarchy.
pub fn cgroup_is(text: &str, group: &str) -> bool {
    text.lines().any(|line| line.strip_prefix("0::") == Some(group))
}

fn response_for(error: &UpdateError) -> HelperResponse {
    HelperResponse::refused(error.reason_code())
}

fn decode(text: &str, max: usize) -> Option<Vec<u8>> {
    if text.len() > max.div_ceil(3) * 4 {
        return None;
    }
    base64::engine::general_purpose::STANDARD.decode(text).ok()
}

/// Handles one request. An accepted activation returns its transaction, to
/// be continued after the answer is sent: the activation stops the daemon
/// that asked.
pub async fn handle<H: UpdateHost>(
    updater: &Updater<'_, H>,
    request: HelperRequest,
) -> (HelperResponse, Option<Transaction>) {
    match request {
        HelperRequest::Status {} => {
            let mut response = HelperResponse::ok("status");
            response.status = Some(updater.status());
            (response, None)
        }
        HelperRequest::Stage { artifact_sha256, envelope, signature } => {
            let (Some(envelope), Some(signature)) =
                (decode(&envelope, edge_release::envelope::MAX_ENVELOPE_BYTES), decode(&signature, 1024))
            else {
                return (HelperResponse::refused("invalid_request"), None);
            };
            match updater.stage(&artifact_sha256, &envelope, &signature).await {
                Ok(edge_release::install::StageOutcome::Staged { version }) => {
                    (HelperResponse::ok("staged").with_version(&version), None)
                }
                Ok(edge_release::install::StageOutcome::AlreadyStaged { version }) => {
                    (HelperResponse::ok("already_staged").with_version(&version), None)
                }
                Err(error) => {
                    tracing::warn!(component = "update", event = "stage_refused", error = %error);
                    (response_for(&error), None)
                }
            }
        }
        HelperRequest::Activate { version_name } => match updater.begin_activation(&version_name) {
            Ok(transaction) => {
                (HelperResponse::ok("activation_started").with_version(&version_name), Some(transaction))
            }
            Err(error) => (response_for(&error), None),
        },
        HelperRequest::Confirm { version_name } => match updater.confirm(&version_name).await {
            Ok(transaction) if transaction.phase == Phase::Confirmed => {
                (HelperResponse::ok("confirmed").with_version(&version_name), None)
            }
            Ok(_) => (HelperResponse::refused("not_provisional"), None),
            Err(error) => (response_for(&error), None),
        },
        HelperRequest::Rollback { reason } => {
            if !is_reason(&reason) {
                return (HelperResponse::refused("invalid_request"), None);
            }
            match updater.rollback(&reason).await {
                Ok(transaction) if transaction.phase == Phase::RolledBack => {
                    (HelperResponse::ok("rolled_back").with_version(&transaction.previous.version_name), None)
                }
                Ok(_) => (HelperResponse::refused("rollback_incomplete"), None),
                Err(error) => (response_for(&error), None),
            }
        }
    }
}

async fn read_request(stream: &mut UnixStream) -> Result<HelperRequest, &'static str> {
    let mut reader = BufReader::new(stream.take(MAX_FRAME_BYTES as u64 + 1));
    let mut line = Vec::new();
    tokio::time::timeout(READ_TIMEOUT, reader.read_until(b'\n', &mut line))
        .await
        .map_err(|_| "request_timeout")?
        .map_err(|_| "invalid_request")?;
    if line.len() > MAX_FRAME_BYTES || !line.ends_with(b"\n") {
        return Err("invalid_request");
    }
    serde_json::from_slice(&line).map_err(|_| "invalid_request")
}

async fn write_response(stream: &mut UnixStream, response: &HelperResponse) {
    let Ok(mut bytes) = serde_json::to_vec(response) else { return };
    bytes.push(b'\n');
    let _ = tokio::time::timeout(READ_TIMEOUT, stream.write_all(&bytes)).await;
    let _ = stream.shutdown().await;
}

/// Serves connections until [`IDLE_EXIT`] passes without one.
pub async fn serve<H: UpdateHost>(
    listener: tokio::net::UnixListener,
    updater: &Updater<'_, H>,
    policy: &dyn PeerPolicy,
    idle_exit: Duration,
) {
    loop {
        let accepted = tokio::time::timeout(idle_exit, listener.accept()).await;
        let Ok(Ok((mut stream, _))) = accepted else { return };
        if let Err(reason) = policy.allow(&stream) {
            tracing::warn!(component = "update", event = "peer_refused", reason);
            write_response(&mut stream, &HelperResponse::refused(reason)).await;
            continue;
        }
        let request = match read_request(&mut stream).await {
            Ok(request) => request,
            Err(reason) => {
                write_response(&mut stream, &HelperResponse::refused(reason)).await;
                continue;
            }
        };
        // Status reads only; everything else takes the update lock, which the
        // guard also takes.
        let lock = if matches!(request, HelperRequest::Status {}) {
            None
        } else {
            match UpdateLock::acquire(updater.store().dir(), LOCK_WAIT).await {
                Ok(lock) => Some(lock),
                Err(_) => {
                    write_response(&mut stream, &HelperResponse::refused("update_busy")).await;
                    continue;
                }
            }
        };
        let (response, continuation) = handle(updater, request).await;
        write_response(&mut stream, &response).await;
        drop(stream);
        if let Some(transaction) = continuation
            && let Err(error) = updater.run_activation(transaction).await
        {
            tracing::error!(component = "update", event = "activation_incomplete", error = %error);
        }
        drop(lock);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_daemon_unit_control_group_is_allowed() {
        assert!(cgroup_is("0::/system.slice/tilecast-edge.service\n", DAEMON_CGROUP));
        for other in [
            "0::/system.slice/tilecast-renderer.service\n",
            "0::/user.slice/user-999.slice/user@999.service/app.slice/tilecast-session-bridge.service\n",
            "0::/system.slice/tilecast-edge.service/child\n",
            "1:name=systemd:/system.slice/tilecast-edge.service\n",
        ] {
            assert!(!cgroup_is(other, DAEMON_CGROUP), "{other}");
        }
    }

    #[test]
    fn oversized_base64_is_refused_before_decoding() {
        assert!(decode(&"A".repeat(40_000), edge_release::envelope::MAX_ENVELOPE_BYTES).is_none());
        assert_eq!(decode("eyJ9", 16).as_deref(), Some(&b"{\"}"[..]));
    }
}
