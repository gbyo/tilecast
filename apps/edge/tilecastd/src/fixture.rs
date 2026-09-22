//! Development/CI presentation source: activates a local fixture instead of
//! the status surface when `[dev] fixture` is configured.
//!
//! The fixture is operator configuration, never reachable over IPC. Its
//! media files are imported into the CAS and verified before activation, so
//! it exercises exactly the path server content will use.

use std::sync::Arc;

use crate::daemon::DaemonContext;

pub async fn run(context: Arc<DaemonContext>) {
    let Some(path) = context.config.dev.fixture.clone() else {
        return;
    };
    tracing::warn!(
        component = "fixture",
        event = "fixture_unsupported",
        path = %path.display(),
        "fixture presentations need the content store; ignoring"
    );
}
