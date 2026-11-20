//! The supervisor's log never has the PIN or the device ID, although the
//! fake UxPlay prints the PIN on both of its outputs, as UxPlay does when a
//! sender starts pairing. Its own test binary, because it installs the
//! global log subscriber.
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

use std::io::Write;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::airplay::{
    AirplayDeviceId, AirplayPin, AudioMode, AudioRtpPort, ControlEvent, ControlRequest, ReceiverName, SessionId,
    VideoProfile, VideoRtpPort, encode_line,
};
use tilecast_airplay::supervisor::{AvahiProbe, Config, PeerPolicy, Supervisor};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::{UnixListener, UnixStream};

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Avahi;

#[async_trait]
impl AvahiProbe for Avahi {
    async fn available(&self) -> bool {
        true
    }
}

struct AllowAll;

impl PeerPolicy for AllowAll {
    fn allow(&self, _stream: &UnixStream) -> Result<(), &'static str> {
        Ok(())
    }
}

#[tokio::test]
async fn the_pin_and_device_id_never_reach_the_log() {
    let captured = Captured::default();
    let writer = captured.clone();
    // No timestamps: their digits could contain the PIN by chance.
    tracing_subscriber::fmt().json().without_time().with_writer(move || writer.clone()).init();

    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("session")).unwrap();
    let uxplay = dir.path().join("uxplay");
    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fake-uxplay"), &uxplay).unwrap();
    std::fs::set_permissions(&uxplay, std::fs::Permissions::from_mode(0o755)).unwrap();
    let socket = dir.path().join("control.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let supervisor = Supervisor::new(Config::new(uxplay, dir.path().join("session")), Box::new(Avahi));
    let server = tokio::spawn(async move { supervisor.serve(listener, &AllowAll, Duration::from_secs(10)).await });

    let session_id = SessionId::new("3f2504e0-4f89-41d3-9a0c-0305e82c3301").unwrap();
    let start = ControlRequest::Start {
        session_id: session_id.clone(),
        receiver_name: ReceiverName::new("Secret Lobby").unwrap(),
        pin: AirplayPin::new("7391").unwrap(),
        device_id: AirplayDeviceId::new("02:73:91:aa:bb:cc").unwrap(),
        profile: VideoProfile::P1080p30,
        audio_mode: AudioMode::GatewayOnly,
        video_port: VideoRtpPort,
        audio_port: AudioRtpPort,
    };
    let (read, mut write) = UnixStream::connect(&socket).await.unwrap().into_split();
    let mut read = BufReader::new(read);
    write.write_all(&encode_line(&start).unwrap()).await.unwrap();
    let mut line = String::new();
    read.read_line(&mut line).await.unwrap();
    assert_eq!(
        ControlEvent::decode(line.as_bytes()).unwrap(),
        ControlEvent::Advertising { session_id: session_id.clone() }
    );
    // Give the output readers time to see the PIN lines.
    tokio::time::sleep(Duration::from_millis(300)).await;
    write.write_all(&encode_line(&ControlRequest::Stop { session_id }).unwrap()).await.unwrap();
    line.clear();
    read.read_line(&mut line).await.unwrap();
    drop((read, write));
    tokio::time::timeout(Duration::from_secs(10), server).await.unwrap().unwrap();

    let log = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    assert!(log.contains("advertising") && log.contains("stopped"), "{log}");
    for secret in ["7391", "73:91", "73:91:aa", "Secret Lobby"] {
        assert!(!log.contains(secret), "{secret} in {log}");
    }
}
