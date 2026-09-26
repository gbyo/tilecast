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

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use edge_platform::systemd::Notifier;
use edge_protocol::ipc::presentation::PresentationDocument;
use serde::Serialize;

use crate::config::EdgeConfig;
use crate::daemon::{Daemon, Environment};
use crate::presentation::ActivationSource;

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

/// Runs the self-test host under `runtime_root` until the fixture is proven
/// or `timeout` passes.
pub async fn run(fixture: PathBuf, runtime_root: PathBuf, timeout: Duration) -> SelfTestReport {
    let started = Instant::now();
    let mut config = EdgeConfig::default();
    config.paths.state_dir = Some(runtime_root.join("state"));
    config.paths.runtime_dir = Some(runtime_root.clone());
    config.dev.fixture = Some(fixture);
    // The self-test runs before the cutover, while the legacy player still
    // owns the display: it sends nothing to the TV or monitor.
    config.display.cec_enabled = false;
    config.display.ddc_enabled = false;
    config.dev.idle_inhibit = Some(false);
    config.log = crate::config::LogConfig::default();
    let failed = |reason, renderer, expected, proven, started: Instant| SelfTestReport {
        outcome: "failed",
        reason: Some(reason),
        daemon_version: env!("CARGO_PKG_VERSION"),
        renderer,
        expected_items: expected,
        proven_items: proven,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    let daemon = match Daemon::start_with(config, Notifier::disabled(), Environment::default()).await {
        Ok(daemon) => daemon,
        Err(error) => {
            tracing::error!(component = "self_test", event = "start_failed", error = format!("{error:#}"));
            return failed("daemon_start_failed", None, vec![], vec![], started);
        }
    };
    let context = daemon.context().clone();
    let shutdown = context.shutdown.clone();
    let running = tokio::spawn(daemon.run());

    let deadline = started + timeout;
    let report = loop {
        let observation = {
            let engine = context.presentation.lock().await;
            observe(&engine)
        };
        if let Some(reason) = observation.failure {
            break failed(reason, observation.renderer, observation.expected, observation.proven, started);
        }
        if observation.passed {
            break SelfTestReport {
                outcome: "passed",
                reason: None,
                daemon_version: env!("CARGO_PKG_VERSION"),
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
            break failed(reason, observation.renderer, observation.expected, observation.proven, started);
        }
        tokio::time::sleep(POLL).await;
    };
    shutdown.cancel();
    let _ = tokio::time::timeout(Duration::from_secs(10), running).await;
    report
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
