//! Edge identity status for `tilecastd status`: derived from stored public
//! certificate metadata only.

use edge_protocol::bounded::{ShortText, ShortToken};
use edge_protocol::ipc::status::{CertificateStatus, EdgeIdentityStatus};

use crate::daemon::DaemonContext;

/// Renew when fewer than this many days remain (RFC §11.4).
pub const RENEW_BEFORE_DAYS: i64 = 30;

pub async fn current(context: &DaemonContext) -> EdgeIdentityStatus {
    let Some(db) = context.db() else {
        return status("state_unavailable", None);
    };
    let certificate = db.run(|c| edge_state::repo::identity::active_certificate(c)).await.ok().flatten();
    let Some(certificate) = certificate else {
        return status("not_enrolled", None);
    };
    let now = context.now();
    let state = if certificate.not_after <= now { "expired" } else { "enrolled" };
    let suffix =
        certificate.fingerprint.chars().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect::<String>();
    status(
        state,
        Some(CertificateStatus {
            fingerprint_suffix: ShortText::lossy(&suffix),
            not_before: certificate.not_before,
            not_after: certificate.not_after,
            renew_after: certificate.not_after.saturating_sub(time::Duration::days(RENEW_BEFORE_DAYS)),
        }),
    )
}

fn status(state: &str, certificate: Option<CertificateStatus>) -> EdgeIdentityStatus {
    EdgeIdentityStatus { state: ShortToken::new(state).expect("literal token"), certificate, last_error: None }
}

/// Adds the server link's last stop reason, if any.
pub async fn current_with_link(context: &DaemonContext) -> EdgeIdentityStatus {
    let mut status = current(context).await;
    let reason = context.link_state.lock().unwrap_or_else(|e| e.into_inner()).reason_code();
    status.last_error = reason.and_then(|r| ShortToken::new(r).ok());
    status
}
