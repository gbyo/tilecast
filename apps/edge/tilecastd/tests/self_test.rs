//! The release self-test host against a scripted renderer on the real IPC
//! socket: the content store policy it runs under, and the layer each failure
//! names. The renderer binary itself is proven by the migration end to end.
//!
//! The media capability channel binds a renderer by its process identity
//! (`/proc`), so these scenarios run on Linux, the Edge target.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use edge_cas::space::FixedSpace;
use edge_ipc::client::{ClientOptions, Incoming, IpcClient};
use edge_platform::clock::system_clock;
use edge_protocol::bounded::{SafeText, ShortText, ShortToken};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::event::{
    ActivationRef, Event, EvidenceKind, PresentationAccepted, PresentationActivate, RendererInfo, RendererKind,
    RendererPlatform, RendererProgress, RendererReady,
};
use edge_protocol::ipc::presentation::PresentationDocument;
use tilecastd::daemon::Environment;
use tilecastd::self_test::{self, SelfTestReport};

const FEATURES: &[&str] =
    &["status-surfaces-v1", "image", "video", "render-tree-v1", "layout-v1", "synchronized-playback-v1"];

/// The built-in fixture's shape: a still image and a widget, with the image
/// file a few dozen kilobytes like the real one.
fn write_fixture(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir.join("media")).unwrap();
    std::fs::write(dir.join("media/still.png"), vec![0x89u8; 26 * 1024]).unwrap();
    let fixture = serde_json::json!({
        "media": [{"id": "still", "file": "media/still.png", "mimeType": "image/png"}],
        "presentation": {
            "state": "playing", "takeover": false, "generation": 1, "synchronized": false,
            "items": [
                {"id": "item-image", "kind": "image", "src": "media:still", "durationMs": 3000,
                 "fitMode": "contain", "audioEnabled": false, "volume": 1.0,
                 "videoStartOffsetMs": null, "videoEndOffsetMs": null},
                {"id": "item-widget", "kind": "widget", "src": "", "durationMs": 3000,
                 "fitMode": "contain", "audioEnabled": false, "volume": 1.0,
                 "videoStartOffsetMs": null, "videoEndOffsetMs": null,
                 "widget": {"background": "#123456", "root": {"t": "box", "style": {"direction": "column"},
                   "children": [{"t": "text", "value": "Tilecast Edge", "style": {"fontSize": 72, "color": "#ffffff"}}]}}}
            ]
        }
    });
    let path = dir.join("fixture.json");
    std::fs::write(&path, serde_json::to_vec(&fixture).unwrap()).unwrap();
    path
}

fn ready() -> Event {
    Event::RendererReady(RendererReady {
        renderer: RendererInfo {
            kind: RendererKind::Wpe,
            version: ShortText::new("0.1.0").unwrap(),
            engine_version: ShortText::new("2.54.0").unwrap(),
            gstreamer_version: None,
            platform: RendererPlatform::Headless,
        },
        features: FEATURES.iter().map(|f| ShortToken::new(*f).unwrap()).collect(),
        display: None,
        remote_web: None,
        support: None,
    })
}

/// Connects as the renderer once the daemon's socket exists, accepts every
/// activation and reports content evidence for every item.
fn scripted_renderer(socket: PathBuf) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let client = loop {
            if let Ok(client) =
                IpcClient::connect(&socket, ClientOptions::new(Role::Renderer, "fake-renderer", "0.1.0")).await
            {
                break Arc::new(client);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        while let Ok(Incoming::Event(_, event)) = client.next_incoming(Duration::from_secs(60)).await {
            match event {
                Event::RendererConfigure(_) => {
                    let _ = client.send_event(ready()).await;
                }
                Event::PresentationActivate(activation) => report(&client, &activation).await,
                _ => {}
            }
        }
    })
}

async fn report(client: &IpcClient, activation: &PresentationActivate) {
    let reference = ActivationRef { activation_id: activation.activation_id, generation: activation.generation };
    let _ = client.send_event(Event::PresentationAccepted(PresentationAccepted { activation: reference })).await;
    let PresentationDocument::Playing { items, .. } = &activation.presentation else { return };
    for item in items {
        let content = match item.kind {
            edge_protocol::ipc::presentation::ItemKind::Video => EvidenceKind::VideoProgress,
            edge_protocol::ipc::presentation::ItemKind::Widget => EvidenceKind::WidgetShown,
            edge_protocol::ipc::presentation::ItemKind::Layout => EvidenceKind::LayoutShown,
            _ => EvidenceKind::ImageShown,
        };
        for kind in [EvidenceKind::ItemStarted, content] {
            let _ = client
                .send_event(Event::RendererProgress(RendererProgress {
                    activation: reference,
                    item_id: Some(SafeText::new(item.id.as_str().to_owned()).unwrap()),
                    kind,
                    zone_id: None,
                }))
                .await;
        }
    }
}

fn environment(available_bytes: u64) -> Environment {
    Environment { clock: system_clock(), space: Arc::new(FixedSpace(available_bytes)) }
}

async fn run(fixture: PathBuf, runtime: &Path, available_bytes: u64, timeout: Duration) -> SelfTestReport {
    self_test::run_with(fixture, runtime.to_path_buf(), timeout, environment(available_bytes)).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_fixture_is_proven_on_a_runtime_filesystem_with_far_less_than_the_production_reserve() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = write_fixture(&dir.path().join("release"));
    let runtime = dir.path().join("selftest");
    std::fs::create_dir_all(&runtime).unwrap();
    let renderer = scripted_renderer(runtime.join("edge.sock"));
    // 8 MiB free: the production policy reserves 1 GiB and would refuse the
    // 26 KiB fixture here.
    let report = run(fixture, &runtime, 8 * 1024 * 1024, Duration::from_secs(60)).await;
    renderer.abort();
    assert!(report.passed(), "{report:?}");
    assert_eq!(report.expected_items, report.proven_items);
    assert_eq!(report.proven_items.len(), 2);
    assert!(report.detail.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_production_reserve_would_have_refused_the_same_fixture() {
    // The regression the self-test policy fixes: a daemon with the production
    // content store defaults cannot take the fixture on the same filesystem.
    let dir = tempfile::tempdir().unwrap();
    let fixture = write_fixture(&dir.path().join("release"));
    let runtime = dir.path().join("selftest");
    std::fs::create_dir_all(&runtime).unwrap();
    let mut config = tilecastd::config::EdgeConfig::default();
    config.paths.state_dir = Some(runtime.join("state"));
    config.paths.runtime_dir = Some(runtime.clone());
    config.dev.idle_inhibit = Some(false);
    assert_eq!(config.cas.reserved_free_bytes, 1024 * 1024 * 1024);
    let daemon = tilecastd::daemon::Daemon::start_with(
        config,
        edge_platform::systemd::Notifier::disabled(),
        environment(8 * 1024 * 1024),
    )
    .await
    .unwrap();
    let context = daemon.context().clone();
    let error = tilecastd::fixture::activate(&context, &fixture).await.unwrap_err();
    assert_eq!(error.reason(), "fixture_import_failed");
    assert!(error.detail().contains("free space"), "{}", error.detail());
    context.shutdown.cancel();
    let selftest = self_test::cas_config();
    assert_eq!(selftest.reserved_free_bytes, 0);
    assert!(selftest.limit_bytes < tilecastd::config::CasConfig::default().limit_bytes);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fixture_that_cannot_be_imported_fails_at_once_as_an_import_failure() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = write_fixture(&dir.path().join("release"));
    let runtime = dir.path().join("selftest");
    std::fs::create_dir_all(&runtime).unwrap();
    let started = std::time::Instant::now();
    // A filesystem with no room at all; a long timeout proves the failure
    // does not wait for it.
    let report = run(fixture, &runtime, 0, Duration::from_secs(120)).await;
    assert_eq!(report.outcome, "failed");
    assert_eq!(report.reason, Some("fixture_import_failed"), "{report:?}");
    let detail = report.detail.expect("a detail");
    assert!(detail.contains("importing still"), "{detail}");
    assert!(detail.chars().count() <= tilecastd::fixture::DETAIL_LIMIT);
    assert!(started.elapsed() < Duration::from_secs(30));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_missing_or_malformed_fixture_is_reported_as_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = dir.path().join("selftest");
    std::fs::create_dir_all(&runtime).unwrap();
    let missing = run(dir.path().join("absent.json"), &runtime, 8 << 20, Duration::from_secs(60)).await;
    assert_eq!(missing.reason, Some("fixture_invalid"), "{missing:?}");

    let runtime = dir.path().join("selftest-2");
    std::fs::create_dir_all(&runtime).unwrap();
    let broken = dir.path().join("broken.json");
    std::fs::write(&broken, "{").unwrap();
    let malformed = run(broken, &runtime, 8 << 20, Duration::from_secs(60)).await;
    assert_eq!(malformed.reason, Some("fixture_invalid"), "{malformed:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_renderer_that_never_connects_times_out_as_renderer_not_ready() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = write_fixture(&dir.path().join("release"));
    let runtime = dir.path().join("selftest");
    std::fs::create_dir_all(&runtime).unwrap();
    let report = run(fixture, &runtime, 8 << 20, Duration::from_secs(10)).await;
    assert_eq!(report.reason, Some("renderer_not_ready"), "{report:?}");
}
