//! `tilecastd`'s AirPlay client against the real supervisor
//! (`tilecast-airplay`) and a fake UxPlay, on a real Unix socket: both sides
//! of `edge_protocol::airplay` together (review rule 8).
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::airplay::{
    AirplayDeviceId, AirplayPin, AudioMode, AudioRtpPort, ControlEvent, ControlRequest, ReceiverName, SessionId,
    VideoProfile, VideoRtpPort,
};
use tilecast_airplay::supervisor::{AvahiProbe, Config, PeerPolicy, Supervisor};
use tilecastd::airplay_receiver::{ReceiverConnection, ReceiverError};
use tokio::net::{UnixListener, UnixStream};

struct Avahi;

#[async_trait]
impl AvahiProbe for Avahi {
    async fn available(&self) -> bool {
        true
    }
}

struct Policy(bool);

impl PeerPolicy for Policy {
    fn allow(&self, _stream: &UnixStream) -> Result<(), &'static str> {
        if self.0 { Ok(()) } else { Err("peer_not_allowed") }
    }
}

fn start_supervisor(dir: &Path, allow: bool) -> tokio::task::JoinHandle<()> {
    std::fs::create_dir_all(dir.join("session")).unwrap();
    let uxplay = dir.join("uxplay");
    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tilecast-airplay/tests/fake-uxplay"), &uxplay)
        .unwrap();
    std::fs::set_permissions(&uxplay, std::fs::Permissions::from_mode(0o755)).unwrap();
    let listener = UnixListener::bind(dir.join("control.sock")).unwrap();
    let supervisor = Supervisor::new(Config::new(uxplay, dir.join("session")), Box::new(Avahi));
    tokio::spawn(async move { supervisor.serve(listener, &Policy(allow), Duration::from_secs(10)).await })
}

fn start_request(session_id: &SessionId) -> ControlRequest {
    ControlRequest::Start {
        session_id: session_id.clone(),
        receiver_name: ReceiverName::new("Lobby").unwrap(),
        pin: AirplayPin::new("0000").unwrap(),
        device_id: AirplayDeviceId::new("02:00:00:00:00:01").unwrap(),
        profile: VideoProfile::P1080p30,
        audio_mode: AudioMode::None,
        video_port: VideoRtpPort,
        audio_port: AudioRtpPort,
    }
}

const WAIT: Duration = Duration::from_secs(15);

#[tokio::test]
async fn a_session_through_the_typed_client() {
    let dir = tempfile::tempdir().unwrap();
    let server = start_supervisor(dir.path(), true);
    let mut connection = ReceiverConnection::connect(&dir.path().join("control.sock")).await.unwrap();

    connection.send(&ControlRequest::Probe {}).await.unwrap();
    let ControlEvent::ProbeResult { uxplay_version, avahi_available, limitation } =
        connection.next_event_within(WAIT).await.unwrap()
    else {
        panic!("not a probe result");
    };
    assert_eq!(uxplay_version.unwrap().as_str(), "1.73.7");
    assert!(avahi_available && limitation.is_none());

    let session_id = SessionId::new("3f2504e0-4f89-41d3-9a0c-0305e82c3301").unwrap();
    connection.send(&start_request(&session_id)).await.unwrap();
    assert_eq!(
        connection.next_event_within(WAIT).await.unwrap(),
        ControlEvent::Advertising { session_id: session_id.clone() }
    );
    std::fs::write(dir.path().join("session/fake-uxplay.cmd"), "mirroring\n").unwrap();
    assert_eq!(
        connection.next_event_within(WAIT).await.unwrap(),
        ControlEvent::ClientConnected { session_id: session_id.clone() }
    );
    connection.send(&ControlRequest::Stop { session_id: session_id.clone() }).await.unwrap();
    assert_eq!(connection.next_event_within(WAIT).await.unwrap(), ControlEvent::Stopped { session_id });
    drop(connection);
    tokio::time::timeout(WAIT, server).await.unwrap().unwrap();
}

#[tokio::test]
async fn refusals_and_a_missing_unit_are_typed_errors() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        ReceiverConnection::connect(&dir.path().join("control.sock")).await.unwrap_err(),
        ReceiverError::Missing
    );
    let _server = start_supervisor(dir.path(), false);
    let mut connection = ReceiverConnection::connect(&dir.path().join("control.sock")).await.unwrap();
    assert_eq!(
        connection.next_event_within(WAIT).await.unwrap_err(),
        ReceiverError::Rejected("peer_not_allowed".to_owned())
    );
}
