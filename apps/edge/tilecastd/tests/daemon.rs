//! Runs a real `tilecastd` in-process against temporary directories and
//! drives it as a renderer and as `tilecastctl` over the real socket.
#![allow(clippy::unwrap_used)]

use std::os::unix::net::UnixDatagram;
use std::time::Duration;

use edge_ipc::client::{ClientOptions, Incoming, IpcClient};
use edge_platform::systemd::Notifier;
use edge_protocol::bounded::{ShortText, ShortToken};
use edge_protocol::ipc::Role;
use edge_protocol::ipc::event::{
    ActivationRef, Event, EvidenceKind, PresentationAccepted, RendererInfo, RendererKind, RendererPlatform,
    RendererProgress, RendererReady,
};
use edge_protocol::ipc::method::{Empty, Method, ShowDiagnosticResult};
use edge_protocol::ipc::presentation::PresentationDocument;
use edge_protocol::ipc::status::{DaemonMode, DaemonStatus};
use tilecastd::config::EdgeConfig;
use tilecastd::daemon::Daemon;

struct Running {
    dir: tempfile::TempDir,
    socket: std::path::PathBuf,
    admin: std::path::PathBuf,
    notify: UnixDatagram,
    shutdown: tokio_util::sync::CancellationToken,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

fn config(dir: &std::path::Path) -> EdgeConfig {
    let mut config = EdgeConfig::default();
    config.paths.state_dir = Some(dir.join("state"));
    config.paths.runtime_dir = Some(dir.join("run"));
    config.renderer.binary = dir.join("no-renderer");
    // Empty hardware roots: no test daemon may reach a real TV or monitor.
    config.dev.hardware_dev_dir = Some(dir.join("hardware/dev"));
    config.dev.hardware_sys_dir = Some(dir.join("hardware/sys"));
    config.dev.networkd_socket = Some(dir.join("hardware/networkd.sock"));
    config.dev.idle_inhibit = Some(false);
    config
}

async fn start_in(dir: tempfile::TempDir) -> Running {
    let notify_path = dir.path().join("notify.sock");
    let notify = UnixDatagram::bind(&notify_path).unwrap();
    notify.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let notifier = Notifier::with_socket(notify_path, Some(Duration::from_millis(400)));
    let daemon = Daemon::start(config(dir.path()), notifier).await.unwrap();
    let socket = daemon.socket_path();
    let admin = daemon.socket_path();
    let shutdown = daemon.context().shutdown.clone();
    let task = tokio::spawn(daemon.run());
    Running { dir, socket, admin, notify, shutdown, task }
}

fn next_notify(running: &Running) -> String {
    let mut buffer = [0u8; 512];
    let n = running.notify.recv(&mut buffer).unwrap();
    String::from_utf8_lossy(&buffer[..n]).into_owned()
}

fn ready_event(features: &[&str]) -> Event {
    Event::RendererReady(RendererReady {
        renderer: RendererInfo {
            kind: RendererKind::Wpe,
            version: ShortText::new("0.1.0").unwrap(),
            engine_version: ShortText::new("2.54.0").unwrap(),
            gstreamer_version: None,
            platform: RendererPlatform::Headless,
        },
        features: features.iter().map(|f| ShortToken::new(*f).unwrap()).collect(),
        display: None,
    })
}

/// The next event other than `plugin.state`, which accompanies every
/// activation (empty unless a server presentation carries plugins).
async fn expect_event(client: &IpcClient) -> Event {
    loop {
        match client.next_incoming(Duration::from_secs(5)).await.unwrap() {
            Incoming::Event(_, Event::PluginState(state)) => assert!(state.plugins.is_empty()),
            Incoming::Event(_, event) => return event,
            Incoming::Goodbye(reason) => panic!("unexpected goodbye {reason}"),
        }
    }
}

async fn renderer(socket: &std::path::Path) -> IpcClient {
    IpcClient::connect(socket, ClientOptions::new(Role::Renderer, "fake-renderer", "0.1.0")).await.unwrap()
}

async fn ctl(socket: &std::path::Path) -> IpcClient {
    IpcClient::connect(socket, ClientOptions::new(Role::Tilecastctl, "tilecastctl", "0.1.0")).await.unwrap()
}

async fn status(client: &IpcClient) -> DaemonStatus {
    serde_json::from_value(client.request(Method::StatusGet(Empty {})).await.unwrap().unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn presentation_lifecycle_readiness_watchdog_and_clean_shutdown() {
    let running = start_in(tempfile::tempdir().unwrap()).await;
    assert!(next_notify(&running).starts_with("READY=1\nSTATUS="));

    // Renderer lifecycle: configure → ready → activate → accepted → progress.
    let client = renderer(&running.socket).await;
    let Event::RendererConfigure(configure) = expect_event(&client).await else { panic!("configure first") };
    assert_eq!(configure.media_channel.protocol.as_str(), "daemon-cap-v1");
    assert!(configure.media_channel.socket.as_str().ends_with("/run/media.sock"));
    client.send_event(ready_event(&["status-surfaces-v1"])).await.unwrap();
    let Event::PresentationActivate(activation) = expect_event(&client).await else { panic!("activation") };
    assert_eq!(activation.presentation, PresentationDocument::Setup {}, "unbound node shows setup");
    let reference = ActivationRef { activation_id: activation.activation_id, generation: activation.generation };
    client.send_event(Event::PresentationAccepted(PresentationAccepted { activation: reference })).await.unwrap();
    client
        .send_event(Event::RendererProgress(RendererProgress {
            activation: reference,
            item_id: None,
            kind: EvidenceKind::SurfaceShown,
            zone_id: None,
        }))
        .await
        .unwrap();

    let admin = ctl(&running.admin).await;
    let mut observed = status(&admin).await;
    for _ in 0..50 {
        if observed.renderer.state.as_str() == "healthy" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        observed = status(&admin).await;
    }
    assert_eq!(observed.mode, DaemonMode::Normal);
    assert_eq!(observed.renderer.state.as_str(), "healthy");
    assert_eq!(observed.renderer.current_activation_generation, Some(activation.generation));
    assert!(observed.systemd_watchdog);

    // An administrative self-test activation reaches the renderer.
    let shown: ShowDiagnosticResult =
        serde_json::from_value(admin.request(Method::DiagnosticsShowStatus(Empty {})).await.unwrap().unwrap()).unwrap();
    let Event::PresentationActivate(second) = expect_event(&client).await else { panic!("second activation") };
    assert_eq!(second.generation, shown.generation);
    assert!(second.generation > activation.generation);

    // Reconnect: the renderer gets configure, then the *same* activation.
    drop(client);
    let client = renderer(&running.socket).await;
    assert!(matches!(expect_event(&client).await, Event::RendererConfigure(_)));
    client.send_event(ready_event(&["status-surfaces-v1"])).await.unwrap();
    let Event::PresentationActivate(again) = expect_event(&client).await else { panic!("re-sent activation") };
    assert_eq!((again.activation_id, again.generation), (second.activation_id, second.generation));

    // The watchdog pings while the daemon is healthy.
    let mut saw_watchdog = false;
    for _ in 0..5 {
        if next_notify(&running) == "WATCHDOG=1" {
            saw_watchdog = true;
            break;
        }
    }
    assert!(saw_watchdog);

    // Clean shutdown: goodbye to sessions, STOPPING=1, clean marker.
    running.shutdown.cancel();
    let goodbye = loop {
        match client.next_incoming(Duration::from_secs(5)).await.unwrap() {
            Incoming::Event(_, Event::PluginState(_)) => continue,
            other => break other,
        }
    };
    assert_eq!(goodbye, Incoming::Goodbye("daemon_shutdown".into()));
    running.task.await.unwrap().unwrap();
    let mut saw_stopping = false;
    while let Ok(n) = running.notify.recv(&mut [0u8; 512]) {
        let _ = n;
        saw_stopping = true;
    }
    assert!(saw_stopping);
    let db = edge_state::StateDb::open(running.dir.path().join("state/state.db"), Default::default()).unwrap();
    let start = db
        .run_blocking(|c| {
            edge_state::repo::daemon::record_start(c, edge_protocol::Timestamp::from_unix_seconds(9).unwrap(), "t")
        })
        .unwrap();
    assert!(!start.previous_run_unclean, "shutdown was recorded as clean");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn incompatible_renderer_gets_explicit_unavailable_surface() {
    let running = start_in(tempfile::tempdir().unwrap()).await;
    let client = renderer(&running.socket).await;
    assert!(matches!(expect_event(&client).await, Event::RendererConfigure(_)));
    client.send_event(ready_event(&["image"])).await.unwrap();
    let Event::PresentationActivate(activation) = expect_event(&client).await else { panic!("activation") };
    assert!(matches!(activation.presentation, PresentationDocument::Unavailable(_)));
    let admin = ctl(&running.admin).await;
    let observed = status(&admin).await;
    assert_eq!(observed.renderer.state.as_str(), "incompatible");
    assert!(observed.renderer.incompatible_reason.unwrap().as_str().contains("status-surfaces-v1"));
    running.shutdown.cancel();
    running.task.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn corrupt_state_enters_recovery_mode_without_recreating_it() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("state")).unwrap();
    std::fs::write(dir.path().join("state/state.db"), vec![0x42u8; 4096]).unwrap();
    let running = start_in(dir).await;
    assert!(next_notify(&running).contains("Recovery mode"), "READY is still sent in recovery");
    let admin = ctl(&running.admin).await;
    let observed = status(&admin).await;
    assert_eq!(observed.mode, DaemonMode::Recovery);
    assert_eq!(observed.recovery_reason.unwrap().as_str(), "state_db_open_failed");
    let client = renderer(&running.socket).await;
    assert!(matches!(expect_event(&client).await, Event::RendererConfigure(_)));
    client.send_event(ready_event(&["status-surfaces-v1"])).await.unwrap();
    let Event::PresentationActivate(activation) = expect_event(&client).await else { panic!("activation") };
    assert!(matches!(activation.presentation, PresentationDocument::Unavailable(_)));
    running.shutdown.cancel();
    running.task.await.unwrap().unwrap();
    assert_eq!(std::fs::read(running.dir.path().join("state/state.db")).unwrap().len(), 4096, "not recreated");
}
