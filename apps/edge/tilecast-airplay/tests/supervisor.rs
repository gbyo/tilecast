//! The supervisor against a fake UxPlay (`tests/fake-uxplay`) on a real
//! Unix socket, driven with the shared protocol fixtures in
//! `packages/edge-protocol/fixtures/airplay`. The systemd integration test
//! (`ci/run-airplay-e2e.sh`) runs the same fake under the real units.
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tilecast_airplay::supervisor::{AvahiProbe, Config, PeerPolicy, Supervisor};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{UnixListener, UnixStream};

const SESSION: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

struct FakeAvahi(bool);

#[async_trait]
impl AvahiProbe for FakeAvahi {
    async fn available(&self) -> bool {
        self.0
    }
}

struct AllowAll;

impl PeerPolicy for AllowAll {
    fn allow(&self, _stream: &UnixStream) -> Result<(), &'static str> {
        Ok(())
    }
}

struct RefuseAll;

impl PeerPolicy for RefuseAll {
    fn allow(&self, _stream: &UnixStream) -> Result<(), &'static str> {
        Err("peer_not_allowed")
    }
}

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/edge-protocol/fixtures/airplay/valid")
        .join(name);
    serde_json::from_str::<Value>(&std::fs::read_to_string(path).unwrap()).unwrap()["message"].clone()
}

struct Harness {
    dir: tempfile::TempDir,
    socket: PathBuf,
    server: tokio::task::JoinHandle<()>,
}

impl Harness {
    fn session_dir(&self) -> PathBuf {
        self.dir.path().join("session")
    }

    fn uxplay(&self) -> PathBuf {
        self.dir.path().join("bin/uxplay")
    }

    fn set(&self, file: &str, text: &str) {
        std::fs::write(self.session_dir().join(file), text).unwrap();
    }

    fn record(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.session_dir().join("fake-uxplay.json")).unwrap()).unwrap()
    }

    async fn connect(&self) -> Client {
        let stream = UnixStream::connect(&self.socket).await.unwrap();
        let (read, write) = stream.into_split();
        Client { read: BufReader::new(read), write }
    }
}

fn harness_with(avahi: bool, policy: Arc<dyn PeerPolicy>, tune: impl FnOnce(&mut Config)) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("bin")).unwrap();
    std::fs::create_dir(dir.path().join("session")).unwrap();
    let uxplay = dir.path().join("bin/uxplay");
    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-uxplay"), &uxplay).unwrap();
    std::fs::set_permissions(&uxplay, std::fs::Permissions::from_mode(0o755)).unwrap();
    let socket = dir.path().join("control.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let mut config = Config::new(uxplay, dir.path().join("session"));
    config.start_timeout = Duration::from_secs(10);
    config.stop_timeout = Duration::from_secs(2);
    tune(&mut config);
    let supervisor = Supervisor::new(config, Box::new(FakeAvahi(avahi)));
    let server = tokio::spawn(async move {
        supervisor.serve(listener, policy.as_ref(), Duration::from_secs(20)).await;
    });
    Harness { dir, socket, server }
}

fn harness() -> Harness {
    harness_with(true, Arc::new(AllowAll), |_| {})
}

struct Client {
    read: BufReader<tokio::net::unix::OwnedReadHalf>,
    write: tokio::net::unix::OwnedWriteHalf,
}

impl Client {
    async fn send(&mut self, message: &Value) {
        let mut line = serde_json::to_vec(message).unwrap();
        line.push(b'\n');
        self.write.write_all(&line).await.unwrap();
    }

    async fn send_raw(&mut self, bytes: &[u8]) {
        self.write.write_all(bytes).await.unwrap();
    }

    /// The next event, or `None` when the supervisor closed the connection.
    async fn event(&mut self) -> Option<Value> {
        let mut line = String::new();
        let read =
            tokio::time::timeout(Duration::from_secs(15), self.read.read_line(&mut line)).await.unwrap().unwrap();
        (read > 0).then(|| serde_json::from_str(&line).unwrap())
    }
}

fn alive(pid: i64) -> bool {
    rustix::process::Pid::from_raw(pid as i32).is_some_and(|pid| rustix::process::test_kill_process(pid).is_ok())
}

async fn until(mut condition: impl FnMut() -> bool) {
    for _ in 0..300 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not reached");
}

#[tokio::test]
async fn a_session_runs_uxplay_with_a_fixed_command_line_and_reports_the_sender() {
    let harness = harness();
    let mut client = harness.connect().await;
    client.send(&fixture("request-start.json")).await;
    assert_eq!(client.event().await.unwrap(), json!({"type": "advertising", "sessionId": SESSION}));

    let record = harness.record();
    assert_eq!(
        record["argv"],
        json!([
            "-rc",
            harness.session_dir().join("session.rc").to_str().unwrap(),
            "-pin",
            "-p",
            "37000,37001,37002",
            "-s",
            "1920x1080",
            "-fps",
            "30",
            "-vs",
            "fakesink",
            "-vrtp",
            "config-interval=1 ! udpsink host=127.0.0.1 port=42000",
            "-artp",
            "pt=96 ! udpsink host=127.0.0.1 port=42002"
        ])
    );
    assert_eq!(record["rcMode"], "0o600");
    assert_eq!(record["rcOptions"], json!(["n", "nh", "pin", "m"]));
    // The environment is cleared: the test process's Cargo variables are
    // gone, and the supervisor's own are there.
    let env: Vec<String> = serde_json::from_value(record["env"].clone()).unwrap();
    assert!(!env.iter().any(|name| name.starts_with("CARGO") || name == "PATH" || name == "USER"), "{env:?}");
    for name in ["HOME", "GST_REGISTRY_1_0", "AVAHI_COMPAT_NOWARN"] {
        assert!(env.contains(&name.to_owned()), "{name} missing from {env:?}");
    }
    // The PIN and the device ID leave the disk once UxPlay has read them.
    assert!(!harness.session_dir().join("session.rc").exists());

    harness.set("fake-uxplay.cmd", "mirroring\n");
    assert_eq!(client.event().await.unwrap(), json!({"type": "client_connected", "sessionId": SESSION}));
    // A redelivered start changes nothing and reports the current state.
    client.send(&fixture("request-start.json")).await;
    assert_eq!(client.event().await.unwrap()["type"], "advertising");
    assert_eq!(client.event().await.unwrap()["type"], "client_connected");
    harness.set("fake-uxplay.cmd", "disconnect\n");
    assert_eq!(client.event().await.unwrap(), json!({"type": "client_disconnected", "sessionId": SESSION}));

    // A second session is refused while this one runs.
    let mut other = fixture("request-start.json");
    other["sessionId"] = json!("9b2c3c1e-5a43-4c9e-8a54-8f7d2f0f6a11");
    client.send(&other).await;
    assert_eq!(
        client.event().await.unwrap(),
        json!({"type": "failed", "sessionId": "9b2c3c1e-5a43-4c9e-8a54-8f7d2f0f6a11", "code": "session_active"})
    );

    let pid = record["pid"].as_i64().unwrap();
    assert!(alive(pid));
    client.send(&fixture("request-stop.json")).await;
    assert_eq!(client.event().await.unwrap(), json!({"type": "stopped", "sessionId": SESSION}));
    assert!(!alive(pid));
    // Stop is idempotent.
    client.send(&fixture("request-stop.json")).await;
    assert_eq!(client.event().await.unwrap(), json!({"type": "stopped", "sessionId": SESSION}));
}

#[tokio::test]
async fn no_audio_uses_as_zero() {
    let harness = harness();
    let mut client = harness.connect().await;
    client.send(&fixture("request-start-no-audio.json")).await;
    assert_eq!(client.event().await.unwrap()["type"], "advertising");
    let argv: Vec<String> = serde_json::from_value(harness.record()["argv"].clone()).unwrap();
    assert_eq!(&argv[argv.len() - 2..], ["-as", "0"]);
    assert!(argv.contains(&"1280x720".to_owned()));
}

#[tokio::test]
async fn closing_the_connection_stops_uxplay_and_the_supervisor() {
    let harness = harness();
    let mut client = harness.connect().await;
    client.send(&fixture("request-start.json")).await;
    assert_eq!(client.event().await.unwrap()["type"], "advertising");
    let pid = harness.record()["pid"].as_i64().unwrap();
    drop(client);
    tokio::time::timeout(Duration::from_secs(10), harness.server).await.unwrap().unwrap();
    assert!(!alive(pid));
}

#[tokio::test]
async fn uxplay_that_ignores_sigterm_is_killed() {
    let harness = harness_with(true, Arc::new(AllowAll), |config| config.stop_timeout = Duration::from_millis(300));
    harness.set("fake-uxplay.mode", "ignore-term");
    let mut client = harness.connect().await;
    client.send(&fixture("request-start.json")).await;
    assert_eq!(client.event().await.unwrap()["type"], "advertising");
    let pid = harness.record()["pid"].as_i64().unwrap();
    client.send(&fixture("request-stop.json")).await;
    assert_eq!(client.event().await.unwrap()["type"], "stopped");
    assert!(!alive(pid));
}

#[tokio::test]
async fn uxplay_failures_end_the_session_with_a_stable_code() {
    let harness = harness_with(true, Arc::new(AllowAll), |config| config.start_timeout = Duration::from_secs(3));
    let mut client = harness.connect().await;

    harness.set("fake-uxplay.mode", "crash");
    client.send(&fixture("request-start.json")).await;
    assert_eq!(
        client.event().await.unwrap(),
        json!({"type": "failed", "sessionId": SESSION, "code": "uxplay_start_failed"})
    );
    assert!(!harness.session_dir().join("session.rc").exists());

    harness.set("fake-uxplay.mode", "hang");
    client.send(&fixture("request-start.json")).await;
    assert_eq!(
        client.event().await.unwrap(),
        json!({"type": "failed", "sessionId": SESSION, "code": "uxplay_start_timeout"})
    );
    let pid = harness.record()["pid"].as_i64().unwrap();
    until(|| !alive(pid)).await;

    harness.set("fake-uxplay.mode", "ready");
    client.send(&fixture("request-start.json")).await;
    assert_eq!(client.event().await.unwrap()["type"], "advertising");
    harness.set("fake-uxplay.cmd", "exit 3\n");
    assert_eq!(client.event().await.unwrap(), json!({"type": "failed", "sessionId": SESSION, "code": "uxplay_exited"}));

    // The session is gone, so a new start works.
    client.send(&fixture("request-start.json")).await;
    assert_eq!(client.event().await.unwrap()["type"], "advertising");
}

#[tokio::test]
async fn probe_reports_the_first_missing_dependency() {
    let harness = harness();
    let mut client = harness.connect().await;
    client.send(&fixture("request-probe.json")).await;
    assert_eq!(client.event().await.unwrap(), fixture("event-probe-result.json"));

    harness.set("fake-uxplay.version", "1.73.6");
    client.send(&fixture("request-probe.json")).await;
    assert_eq!(
        client.event().await.unwrap(),
        json!({"type": "probe_result", "uxplayVersion": "1.73.6", "avahiAvailable": true, "limitation": "uxplay_version_unsupported"})
    );
    harness.set("fake-uxplay.version", "");
    client.send(&fixture("request-probe.json")).await;
    assert_eq!(client.event().await.unwrap()["limitation"], "uxplay_version_unrecognized");

    std::fs::set_permissions(harness.uxplay(), std::fs::Permissions::from_mode(0o644)).unwrap();
    client.send(&fixture("request-probe.json")).await;
    assert_eq!(client.event().await.unwrap()["limitation"], "uxplay_not_executable");
    std::fs::remove_file(harness.uxplay()).unwrap();
    client.send(&fixture("request-probe.json")).await;
    assert_eq!(client.event().await.unwrap(), fixture("event-probe-result-missing.json"));

    let without_avahi = harness_with(false, Arc::new(AllowAll), |_| {});
    let mut client = without_avahi.connect().await;
    client.send(&fixture("request-probe.json")).await;
    assert_eq!(client.event().await.unwrap(), fixture("event-probe-result-limited.json"));
}

#[tokio::test]
async fn a_malformed_or_oversized_line_closes_the_connection() {
    for bad in [
        b"{\"type\": \"exec\", \"program\": \"/bin/sh\"}\n".to_vec(),
        [vec![b' '; 5000], b"\n".to_vec()].concat(),
        b"not json\n".to_vec(),
    ] {
        let harness = harness();
        let mut client = harness.connect().await;
        client.send(&fixture("request-start.json")).await;
        assert_eq!(client.event().await.unwrap()["type"], "advertising");
        let pid = harness.record()["pid"].as_i64().unwrap();
        client.send_raw(&bad).await;
        assert_eq!(client.event().await.unwrap(), fixture("event-rejected.json"));
        assert_eq!(client.event().await, None);
        until(|| !alive(pid)).await;
    }
}

#[tokio::test]
async fn only_one_connection_is_served() {
    let harness = harness();
    let mut first = harness.connect().await;
    first.send(&fixture("request-probe.json")).await;
    assert_eq!(first.event().await.unwrap()["type"], "probe_result");
    let mut second = harness.connect().await;
    assert_eq!(second.event().await.unwrap(), json!({"type": "rejected", "code": "connection_busy"}));
    assert_eq!(second.event().await, None);
    first.send(&fixture("request-probe.json")).await;
    assert_eq!(first.event().await.unwrap()["type"], "probe_result");
}

#[tokio::test]
async fn a_refused_peer_gets_nothing_else() {
    let harness = harness_with(true, Arc::new(RefuseAll), |_| {});
    let mut client = harness.connect().await;
    assert_eq!(client.event().await.unwrap(), json!({"type": "rejected", "code": "peer_not_allowed"}));
    assert_eq!(client.event().await, None);
    assert!(!harness.session_dir().join("fake-uxplay.json").exists());
}

#[tokio::test]
async fn a_stale_rc_file_is_deleted_at_start() {
    let harness = harness();
    // serve() clears the directory before it accepts; the planted file
    // arrives after that, so plant it and start a fresh harness instead.
    let dir = harness.session_dir();
    let uxplay = harness.uxplay();
    drop(harness.connect().await);
    tokio::time::timeout(Duration::from_secs(10), harness.server).await.unwrap().unwrap();
    std::fs::write(dir.join("session.rc"), "pin 9999\n").unwrap();
    let listener = UnixListener::bind(harness.dir.path().join("again.sock")).unwrap();
    let supervisor = Supervisor::new(Config::new(uxplay, dir.clone()), Box::new(FakeAvahi(true)));
    let serve = tokio::spawn(async move { supervisor.serve(listener, &AllowAll, Duration::from_millis(200)).await });
    tokio::time::timeout(Duration::from_secs(5), serve).await.unwrap().unwrap();
    assert!(!dir.join("session.rc").exists());
}

#[tokio::test]
async fn too_many_wrong_pins_end_the_session() {
    let harness = harness();
    let mut client = harness.connect().await;
    client.send(&fixture("request-start.json")).await;
    assert_eq!(client.event().await.unwrap()["type"], "advertising");
    let pid = harness.record()["pid"].as_i64().unwrap();
    harness.set("fake-uxplay.cmd", &"wrong-pin\n".repeat(9));
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(alive(pid), "nine wrong PINs are allowed");
    harness.set("fake-uxplay.cmd", "wrong-pin\n");
    assert_eq!(
        client.event().await.unwrap(),
        json!({"type": "failed", "sessionId": SESSION, "code": "pin_attempts_exceeded"})
    );
    until(|| !alive(pid)).await;
}
