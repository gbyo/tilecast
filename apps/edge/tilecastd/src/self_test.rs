//! `tilecastd self-test`: the release self-test host (M7 migration step 3).
//!
//! Before the migrator touches the legacy player, it proves that the
//! installed release can show content on this machine: the real daemon, the
//! real IPC and media channel, the real renderer binary, WPE WebKit,
//! GStreamer and the shared Player Runtime. This command is the daemon half.
//! It runs in `tilecast-edge-selftest.service`, and the migrator starts the
//! renderer half, `tilecast-renderer-selftest.service`, against its socket.
//!
//! The self-test is isolated from the installation:
//!
//! * its state, content store and sockets are under a runtime directory
//!   (tmpfs), never `/var/lib/tilecast-edge`;
//! * it has no server binding and no credential, and its unit has no network;
//! * it shows only the release's built-in fixture, whose media enters the
//!   content store through the verified commit path.
//!
//! It passes only when the renderer accepted the fixture activation and
//! reported content evidence for every fixture item: an image shown, video
//! progress, a render tree or a layout drawn. A connected renderer, or a unit
//! that systemd reports as running, is not enough.
//!
//! Failures name the layer that failed. The fixture is imported and activated
//! here, not by the daemon's development task, so an import or activation
//! error ends the run at once with `fixture_import_failed` (or
//! `fixture_invalid`, `fixture_activation_failed`, `content_store_unavailable`)
//! and a bounded detail, rather than as a `fixture_not_active` timeout.
//!
//! The content store has its own policy, never the production one: the
//! fixture is a few dozen kilobytes in a runtime directory that is usually a
//! small tmpfs, and the production reserve of free space (1 GiB) would refuse
//! it there. The policy bounds the self-test's own store and reserves nothing
//! on a filesystem that holds only this run.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use edge_platform::systemd::Notifier;
use edge_protocol::ipc::presentation::PresentationDocument;
use serde::Serialize;

use crate::config::{CasConfig, EdgeConfig};
use crate::daemon::{Daemon, Environment};
use crate::fixture::bounded_detail;
use crate::presentation::ActivationSource;

/// The self-test content store: far more than the built-in fixture needs, and
/// bounded so a malformed fixture cannot fill the runtime tmpfs.
pub const CAS_LIMIT_BYTES: u64 = 16 * 1024 * 1024;

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(90);
pub const TIMEOUT_RANGE_SECONDS: std::ops::RangeInclusive<u64> = 10..=600;
const POLL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelfTestReport {
    /// `passed` or `failed`.
    pub outcome: &'static str,
    /// Why the self-test failed.
    pub reason: Option<&'static str>,
    /// One bounded printable line that says more about `reason`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub daemon_version: &'static str,
    pub renderer: Option<RendererReport>,
    pub expected_items: Vec<String>,
    pub proven_items: Vec<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RendererReport {
    pub version: String,
    pub engine_version: String,
    pub gstreamer_version: Option<String>,
    pub platform: &'static str,
    pub features: Vec<String>,
    pub display_connected: Option<bool>,
    pub display_width: Option<u32>,
    pub display_height: Option<u32>,
}

impl SelfTestReport {
    pub fn passed(&self) -> bool {
        self.outcome == "passed"
    }
}

/// The content store policy of the self-test host.
pub fn cas_config() -> CasConfig {
    CasConfig { limit_bytes: CAS_LIMIT_BYTES, reserved_free_bytes: 0, max_concurrent_downloads: 1 }
}

/// Runs the self-test host under `runtime_root` until the fixture is proven
/// or `timeout` passes.
pub async fn run(fixture: PathBuf, runtime_root: PathBuf, timeout: Duration) -> SelfTestReport {
    run_with(fixture, runtime_root, timeout, Environment::default()).await
}

/// [`run`] with the host facts (clock, free space) supplied by the caller.
pub async fn run_with(
    fixture: PathBuf,
    runtime_root: PathBuf,
    timeout: Duration,
    environment: Environment,
) -> SelfTestReport {
    let started = Instant::now();
    let mut config = EdgeConfig::default();
    config.paths.state_dir = Some(runtime_root.join("state"));
    config.paths.runtime_dir = Some(runtime_root.clone());
    config.cas = cas_config();
    // The fixture is activated below so that its failure is reported here.
    config.dev.fixture = None;
    // The self-test runs before the cutover, while the legacy player still
    // owns the display: it sends nothing to the TV or monitor.
    config.display.cec_enabled = false;
    config.display.ddc_enabled = false;
    config.dev.idle_inhibit = Some(false);
    config.log = crate::config::LogConfig::default();
    let failed = |reason, detail: Option<String>, renderer, expected, proven, started: Instant| SelfTestReport {
        outcome: "failed",
        reason: Some(reason),
        detail,
        daemon_version: crate::daemon::VERSION,
        renderer,
        expected_items: expected,
        proven_items: proven,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let daemon = match Daemon::start_with(config, Notifier::disabled(), environment).await {
        Ok(daemon) => daemon,
        Err(error) => {
            let detail = bounded_detail(&format!("{error:#}"));
            tracing::error!(component = "self_test", event = "start_failed", error = detail);
            return failed("daemon_start_failed", Some(detail), None, vec![], vec![], started);
        }
    };
    let context = daemon.context().clone();
    let shutdown = context.shutdown.clone();
    let running = tokio::spawn(daemon.run());

    let report = match crate::fixture::activate(&context, &fixture).await {
        Err(error) => {
            tracing::error!(component = "self_test", event = "fixture_failed", reason = error.reason(), error = %error);
            failed(error.reason(), Some(error.detail()), None, vec![], vec![], started)
        }
        Ok(_) => wait_for_proof(&context, started, timeout).await,
    };
    shutdown.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(10), running).await;
    report
}

async fn wait_for_proof(context: &crate::daemon::DaemonContext, started: Instant, timeout: Duration) -> SelfTestReport {
    let failed = |reason, renderer, expected, proven| SelfTestReport {
        outcome: "failed",
        reason: Some(reason),
        detail: None,
        daemon_version: crate::daemon::VERSION,
        renderer,
        expected_items: expected,
        proven_items: proven,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let deadline = started + timeout;
    loop {
        let observation = {
            let engine = context.presentation.lock().await;
            observe(&engine)
        };
        if let Some(reason) = observation.failure {
            return failed(reason, observation.renderer, observation.expected, observation.proven);
        }
        if observation.passed {
            return SelfTestReport {
                outcome: "passed",
                reason: None,
                detail: None,
                daemon_version: crate::daemon::VERSION,
                renderer: observation.renderer,
                expected_items: observation.expected,
                proven_items: observation.proven,
                elapsed_ms: started.elapsed().as_millis() as u64,
            };
        }
        if Instant::now() >= deadline {
            let reason = match (&observation.renderer, observation.fixture_active) {
                (None, _) => "renderer_not_ready",
                (Some(_), false) => "fixture_not_active",
                (Some(_), true) => "evidence_timeout",
            };
            return failed(reason, observation.renderer, observation.expected, observation.proven);
        }
        tokio::time::sleep(POLL).await;
    }
}

struct Observation {
    renderer: Option<RendererReport>,
    fixture_active: bool,
    expected: Vec<String>,
    proven: Vec<String>,
    passed: bool,
    failure: Option<&'static str>,
}

fn observe(engine: &crate::presentation::PresentationEngine) -> Observation {
    let renderer = engine.ready_info().map(|ready| RendererReport {
        version: ready.renderer.version.as_str().to_owned(),
        engine_version: ready.renderer.engine_version.as_str().to_owned(),
        gstreamer_version: ready.renderer.gstreamer_version.as_ref().map(|v| v.as_str().to_owned()),
        platform: match ready.renderer.platform {
            edge_protocol::ipc::event::RendererPlatform::Drm => "drm",
            edge_protocol::ipc::event::RendererPlatform::Wayland => "wayland",
            edge_protocol::ipc::event::RendererPlatform::Headless => "headless",
        },
        features: ready.features.iter().map(|f| f.as_str().to_owned()).collect(),
        display_connected: ready.display.as_ref().map(|d| d.connected),
        display_width: ready.display.as_ref().map(|d| d.width),
        display_height: ready.display.as_ref().map(|d| d.height),
    });
    let current = engine.current().filter(|a| a.source == ActivationSource::Fixture);
    let expected: BTreeSet<String> = match current.map(|a| &a.document) {
        Some(PresentationDocument::Playing { items, .. }) => items.iter().map(|i| i.id.as_str().to_owned()).collect(),
        _ => BTreeSet::new(),
    };
    let proven: BTreeSet<String> = engine.content_evidence_items().intersection(&expected).cloned().collect();
    let status = engine.status();
    let failure = if current.is_some() && status.incompatible_reason.is_some() {
        Some("renderer_incompatible")
    } else if current.is_some() && status.last_error_code.is_some() {
        // A rejected activation or an item error on built-in media.
        Some("renderer_error")
    } else {
        None
    };
    let passed = current.is_some() && engine.current_is_accepted() && !expected.is_empty() && proven == expected;
    Observation {
        renderer,
        fixture_active: current.is_some(),
        expected: expected.into_iter().collect(),
        proven: proven.into_iter().collect(),
        passed,
        failure,
    }
}
