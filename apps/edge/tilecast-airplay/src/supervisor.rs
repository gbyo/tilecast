//! One control connection and at most one UxPlay process.
//!
//! systemd starts the supervisor for the first connection to
//! `tilecast-airplay.socket`. The supervisor serves the first peer that the
//! [`PeerPolicy`] allows, refuses every other connection while it does, and
//! returns when that connection closes. Before it returns, it stops UxPlay
//! and deletes the session directory's files, so a later connection always
//! starts from nothing.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use async_trait::async_trait;
use edge_ipc::lines::{Line, read_line};
use edge_protocol::airplay::{
    ControlEvent, ControlRequest, MAX_LINE_BYTES, SessionId, UXPLAY_BASELINE, VersionText, encode_line, failure,
    limitation, token,
};
use tokio::io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::OwnedWriteHalf;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::uxplay::{self, MAX_OUTPUT_LINE, OutputEvent, SessionOptions};

/// The `-rc` file in the session directory.
pub const RC_FILE: &str = "session.rc";
/// The supervisor exits when no allowed peer connects for this long.
pub const IDLE_EXIT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROBE_OUTPUT: usize = 4096;
/// Environment variables that pass from the unit to UxPlay unchanged. Every
/// other variable is removed.
pub const PASSED_ENVIRONMENT: &[&str] =
    &["LD_LIBRARY_PATH", "GST_PLUGIN_SYSTEM_PATH_1_0", "GST_PLUGIN_SCANNER_1_0", "GST_PLUGIN_PATH_1_0", "LANG"];

/// Where UxPlay is and how long its steps may take.
#[derive(Debug, Clone)]
pub struct Config {
    /// The release's `bin/uxplay`.
    pub uxplay: PathBuf,
    /// The private runtime directory (mode 0700) that holds the `-rc` file.
    pub session_dir: PathBuf,
    pub start_timeout: Duration,
    pub stop_timeout: Duration,
    pub probe_timeout: Duration,
    /// The values of [`PASSED_ENVIRONMENT`] in the supervisor's environment.
    pub environment: Vec<(OsString, OsString)>,
}

impl Config {
    pub fn new(uxplay: PathBuf, session_dir: PathBuf) -> Self {
        Self {
            uxplay,
            session_dir,
            start_timeout: Duration::from_secs(15),
            stop_timeout: Duration::from_secs(5),
            probe_timeout: Duration::from_secs(5),
            environment: PASSED_ENVIRONMENT
                .iter()
                .filter_map(|name| std::env::var_os(name).map(|value| (OsString::from(name), value)))
                .collect(),
        }
    }

    fn rc_path(&self) -> PathBuf {
        self.session_dir.join(RC_FILE)
    }
}

/// Whether avahi-daemon can advertise for UxPlay.
#[async_trait]
pub trait AvahiProbe: Send + Sync {
    async fn available(&self) -> bool;
}

/// avahi-daemon on the system D-Bus, the bus that UxPlay's
/// `avahi-compat-libdns_sd` uses.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemAvahi;

#[zbus::proxy(
    interface = "org.freedesktop.Avahi.Server",
    default_service = "org.freedesktop.Avahi",
    default_path = "/"
)]
trait AvahiServer {
    #[zbus(name = "GetState")]
    fn get_state(&self) -> zbus::Result<i32>;
}

/// `AVAHI_SERVER_RUNNING`.
const AVAHI_RUNNING: i32 = 2;

#[async_trait]
impl AvahiProbe for SystemAvahi {
    async fn available(&self) -> bool {
        let state = async {
            let connection = zbus::Connection::system().await?;
            AvahiServerProxy::new(&connection).await?.get_state().await
        };
        matches!(tokio::time::timeout(Duration::from_secs(3), state).await, Ok(Ok(AVAHI_RUNNING)))
    }
}

/// Decides whether a connected peer may use the socket.
pub trait PeerPolicy: Send + Sync {
    fn allow(&self, stream: &UnixStream) -> Result<(), &'static str>;
}

/// The production policy: the `tilecast` account in `tilecast-edge.service`
/// ([`edge_platform::peer`]). The unit has `ProtectProc=invisible`, so the
/// supervisor cannot read the peer's `/proc` entry; it reads the daemon
/// unit's `cgroup.procs` instead.
#[derive(Debug, Clone)]
pub struct DaemonOnly {
    pub tilecast_uid: u32,
}

impl PeerPolicy for DaemonOnly {
    fn allow(&self, stream: &UnixStream) -> Result<(), &'static str> {
        edge_platform::peer::allow_daemon_listed(stream, self.tilecast_uid)
    }
}

/// The supervisor.
pub struct Supervisor {
    config: Config,
    avahi: Box<dyn AvahiProbe>,
}

impl std::fmt::Debug for Supervisor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Supervisor").field("config", &self.config).finish_non_exhaustive()
    }
}

/// The running session. The PIN and the device ID are not kept here: they
/// exist only in the `-rc` file until UxPlay has read it.
#[derive(Debug)]
struct Session {
    id: SessionId,
    generation: u64,
    child: Child,
    advertised: bool,
    connected: bool,
    start_deadline: Instant,
}

/// A failure that ends the control connection.
struct Closed;

impl Supervisor {
    pub fn new(config: Config, avahi: Box<dyn AvahiProbe>) -> Self {
        Self { config, avahi }
    }

    /// Deletes what an earlier supervisor process left in the session
    /// directory.
    pub fn clear_session_dir(&self) {
        remove_quietly(&self.config.rc_path());
    }

    /// Serves the first allowed connection and returns when it closes, or
    /// after `idle` without an allowed connection.
    pub async fn serve(&self, listener: tokio::net::UnixListener, policy: &dyn PeerPolicy, idle: Duration) {
        self.clear_session_dir();
        let stream = loop {
            let Ok(Ok((mut stream, _))) = tokio::time::timeout(idle, listener.accept()).await else { return };
            match policy.allow(&stream) {
                Ok(()) => break stream,
                Err(reason) => {
                    tracing::warn!(component = "airplay", event = "peer_refused", reason);
                    refuse(&mut stream, reason).await;
                }
            }
        };
        let connection = self.run_connection(stream);
        tokio::pin!(connection);
        loop {
            tokio::select! {
                () = &mut connection => break,
                accepted = listener.accept() => {
                    if let Ok((mut other, _)) = accepted {
                        let reason = policy.allow(&other).err().unwrap_or(failure::CONNECTION_BUSY);
                        tracing::warn!(component = "airplay", event = "peer_refused", reason);
                        refuse(&mut other, reason).await;
                    }
                }
            }
        }
        self.clear_session_dir();
    }

    /// Serves one control connection until it closes or sends a line that
    /// does not decode. UxPlay is stopped before this returns.
    pub async fn run_connection(&self, stream: UnixStream) {
        let (read, mut write) = stream.into_split();
        let mut requests = BufReader::new(read);
        let (output_tx, mut output_rx) = mpsc::channel::<(u64, OutputEvent)>(64);
        let mut session: Option<Session> = None;
        let mut generation = 0u64;
        tracing::info!(component = "airplay", event = "connected");
        loop {
            let deadline = session.as_ref().filter(|s| !s.advertised).map(|s| s.start_deadline);
            let result = tokio::select! {
                line = read_line(&mut requests, MAX_LINE_BYTES) => match line {
                    Line::Complete(bytes) => match ControlRequest::decode(&bytes) {
                        Ok(request) => {
                            self.handle(request, &mut session, &mut generation, &output_tx, &mut write).await
                        }
                        Err(_) => {
                            let _ = send(&mut write, &ControlEvent::Rejected { code: token(failure::INVALID_REQUEST) }).await;
                            Err(Closed)
                        }
                    },
                    Line::TooLong => {
                        let _ = send(&mut write, &ControlEvent::Rejected { code: token(failure::INVALID_REQUEST) }).await;
                        Err(Closed)
                    }
                    Line::End => Err(Closed),
                },
                Some((tagged, output)) = output_rx.recv() => {
                    match session.as_mut().filter(|s| s.generation == tagged) {
                        Some(current) => self.on_output(current, output, &mut write).await,
                        None => Ok(()),
                    }
                }
                status = child_exit(&mut session) => {
                    let ended = session.take();
                    match ended {
                        Some(ended) => {
                            let code = if ended.advertised { failure::UXPLAY_EXITED } else { failure::UXPLAY_START_FAILED };
                            tracing::warn!(component = "airplay", event = "uxplay_exited", code = status.ok().and_then(|s| s.code()));
                            remove_quietly(&self.config.rc_path());
                            send(&mut write, &ControlEvent::failed(&ended.id, code)).await
                        }
                        None => Ok(()),
                    }
                }
                () = sleep_until(deadline) => {
                    match session.take() {
                        Some(late) => {
                            tracing::warn!(component = "airplay", event = "uxplay_start_timeout");
                            self.terminate(late.child).await;
                            send(&mut write, &ControlEvent::failed(&late.id, failure::UXPLAY_START_TIMEOUT)).await
                        }
                        None => Ok(()),
                    }
                }
            };
            if result.is_err() {
                break;
            }
        }
        if let Some(open) = session.take() {
            self.terminate(open.child).await;
        }
        tracing::info!(component = "airplay", event = "disconnected");
    }

    async fn handle(
        &self,
        request: ControlRequest,
        session: &mut Option<Session>,
        generation: &mut u64,
        output: &mpsc::Sender<(u64, OutputEvent)>,
        write: &mut OwnedWriteHalf,
    ) -> Result<(), Closed> {
        match request {
            ControlRequest::Probe {} => send(write, &self.probe().await).await,
            ControlRequest::Stop { session_id } => {
                if session.as_ref().is_some_and(|s| s.id == session_id)
                    && let Some(stopping) = session.take()
                {
                    self.terminate(stopping.child).await;
                    tracing::info!(component = "airplay", event = "stopped");
                }
                send(write, &ControlEvent::Stopped { session_id }).await
            }
            ControlRequest::Start {
                session_id,
                receiver_name,
                pin,
                device_id,
                profile,
                audio_mode,
                video_port: _,
                audio_port: _,
            } => {
                if let Some(current) = session.as_ref() {
                    if current.id != session_id {
                        return send(write, &ControlEvent::failed(&session_id, failure::SESSION_ACTIVE)).await;
                    }
                    // A redelivered start: report where the session is.
                    if current.advertised {
                        send(write, &ControlEvent::Advertising { session_id: session_id.clone() }).await?;
                    }
                    if current.connected {
                        send(write, &ControlEvent::ClientConnected { session_id }).await?;
                    }
                    return Ok(());
                }
                let options = SessionOptions { receiver_name, pin, device_id, profile, audio_mode };
                *generation += 1;
                match self.spawn(&options, *generation, output.clone()) {
                    Ok(child) => {
                        tracing::info!(component = "airplay", event = "uxplay_started");
                        *session = Some(Session {
                            id: session_id,
                            generation: *generation,
                            child,
                            advertised: false,
                            connected: false,
                            start_deadline: Instant::now() + self.config.start_timeout,
                        });
                        Ok(())
                    }
                    Err(code) => {
                        tracing::warn!(component = "airplay", event = "uxplay_start_failed", code);
                        send(write, &ControlEvent::failed(&session_id, code)).await
                    }
                }
            }
        }
    }

    async fn on_output(
        &self,
        session: &mut Session,
        output: OutputEvent,
        write: &mut OwnedWriteHalf,
    ) -> Result<(), Closed> {
        let session_id = session.id.clone();
        match output {
            OutputEvent::Ready if !session.advertised => {
                session.advertised = true;
                // UxPlay reads the -rc file before it opens its sockets, so
                // the PIN and the device ID leave the disk now.
                remove_quietly(&self.config.rc_path());
                tracing::info!(component = "airplay", event = "advertising");
                send(write, &ControlEvent::Advertising { session_id }).await
            }
            OutputEvent::Mirroring if !session.connected => {
                session.connected = true;
                tracing::info!(component = "airplay", event = "client_connected");
                send(write, &ControlEvent::ClientConnected { session_id }).await
            }
            OutputEvent::Disconnected if session.connected => {
                session.connected = false;
                tracing::info!(component = "airplay", event = "client_disconnected");
                send(write, &ControlEvent::ClientDisconnected { session_id }).await
            }
            _ => Ok(()),
        }
    }

    /// Writes the `-rc` file and starts UxPlay. The error is a stable code.
    fn spawn(
        &self,
        options: &SessionOptions,
        generation: u64,
        output: mpsc::Sender<(u64, OutputEvent)>,
    ) -> Result<Child, &'static str> {
        let rc_path = self.config.rc_path();
        let rc_text = rc_path.to_str().ok_or(failure::SESSION_FILE_FAILED)?.to_owned();
        write_private(&rc_path, uxplay::rc_file(options).as_bytes()).map_err(|_| failure::SESSION_FILE_FAILED)?;
        let mut command = self.command();
        command.args(uxplay::arguments(options, &rc_text)).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(_) => {
                remove_quietly(&rc_path);
                return Err(failure::UXPLAY_START_FAILED);
            }
        };
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(forward_output(stdout, generation, output.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(forward_output(stderr, generation, output));
        }
        Ok(child)
    }

    /// The one program the supervisor starts, with a fixed path and a
    /// cleared environment.
    fn command(&self) -> Command {
        let dir = &self.config.session_dir;
        let mut command = Command::new(&self.config.uxplay);
        command
            .env_clear()
            .envs(self.config.environment.iter().map(|(k, v)| (k, v)))
            .env("HOME", dir)
            .env("GST_REGISTRY_1_0", dir.join("gstreamer-registry.bin"))
            .env("AVAHI_COMPAT_NOWARN", "1")
            .current_dir(dir)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    /// Stops UxPlay: `SIGTERM`, then `SIGKILL` after the stop timeout. The
    /// `-rc` file goes with it.
    async fn terminate(&self, mut child: Child) {
        if let Some(pid) = child.id().and_then(|pid| rustix::process::Pid::from_raw(pid as i32)) {
            let _ = rustix::process::kill_process(pid, rustix::process::Signal::TERM);
        }
        if tokio::time::timeout(self.config.stop_timeout, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
        remove_quietly(&self.config.rc_path());
    }

    /// Checks UxPlay and avahi-daemon in the Electron Player's order.
    pub async fn probe(&self) -> ControlEvent {
        let (version, uxplay_limitation) = self.probe_uxplay().await;
        let avahi_available = self.avahi.available().await;
        let limitation = uxplay_limitation.or((!avahi_available).then_some(limitation::AVAHI_UNAVAILABLE));
        ControlEvent::ProbeResult {
            uxplay_version: version.and_then(|v| VersionText::new(v).ok()),
            avahi_available,
            limitation: limitation.map(token),
        }
    }

    async fn probe_uxplay(&self) -> (Option<String>, Option<&'static str>) {
        use std::os::unix::fs::PermissionsExt as _;
        let metadata = match std::fs::metadata(&self.config.uxplay) {
            Ok(metadata) if metadata.is_file() => metadata,
            _ => return (None, Some(limitation::UXPLAY_MISSING)),
        };
        if metadata.permissions().mode() & 0o111 == 0 {
            return (None, Some(limitation::UXPLAY_NOT_EXECUTABLE));
        }
        let mut command = self.command();
        command.arg("-v").stdout(Stdio::piped()).stderr(Stdio::piped());
        let Ok(mut child) = command.spawn() else { return (None, Some(limitation::UXPLAY_VERSION_FAILED)) };
        let collect = async {
            let mut text = Vec::new();
            if let Some(stdout) = child.stdout.take() {
                let _ = stdout.take(MAX_PROBE_OUTPUT as u64).read_to_end(&mut text).await;
            }
            if let Some(stderr) = child.stderr.take() {
                text.push(b'\n');
                let _ = stderr.take(MAX_PROBE_OUTPUT as u64).read_to_end(&mut text).await;
            }
            (child.wait().await, text)
        };
        let Ok((status, output)) = tokio::time::timeout(self.config.probe_timeout, collect).await else {
            return (None, Some(limitation::UXPLAY_VERSION_FAILED));
        };
        if !status.is_ok_and(|status| status.success()) {
            return (None, Some(limitation::UXPLAY_VERSION_FAILED));
        }
        match uxplay::parse_version(&String::from_utf8_lossy(&output)) {
            None => (None, Some(limitation::UXPLAY_VERSION_UNRECOGNIZED)),
            Some(version) if !uxplay::version_at_least(&version, UXPLAY_BASELINE) => {
                (Some(version), Some(limitation::UXPLAY_VERSION_UNSUPPORTED))
            }
            Some(version) => (Some(version), None),
        }
    }
}

async fn child_exit(session: &mut Option<Session>) -> std::io::Result<ExitStatus> {
    match session {
        Some(session) => session.child.wait().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Classifies UxPlay output line by line and forwards only the meaning.
async fn forward_output(stream: impl AsyncRead + Unpin, generation: u64, output: mpsc::Sender<(u64, OutputEvent)>) {
    let mut reader = BufReader::new(stream);
    loop {
        let event = match read_line(&mut reader, MAX_OUTPUT_LINE).await {
            Line::End => return,
            Line::TooLong => None,
            Line::Complete(bytes) => uxplay::classify(&bytes),
        };
        if let Some(event) = event
            && output.send((generation, event)).await.is_err()
        {
            return;
        }
    }
}

async fn send(write: &mut OwnedWriteHalf, event: &ControlEvent) -> Result<(), Closed> {
    let bytes = encode_line(event).ok_or(Closed)?;
    match tokio::time::timeout(WRITE_TIMEOUT, write.write_all(&bytes)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(Closed),
    }
}

async fn refuse(stream: &mut UnixStream, reason: &'static str) {
    if let Ok(code) = edge_protocol::bounded::ShortToken::new(reason)
        && let Some(bytes) = encode_line(&ControlEvent::Rejected { code })
    {
        let _ = tokio::time::timeout(WRITE_TIMEOUT, stream.write_all(&bytes)).await;
    }
    let _ = stream.shutdown().await;
}

/// Creates `path` with mode 0600, never through an existing file or link.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    remove_quietly(path);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    file.write_all(bytes)
}

fn remove_quietly(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rc_file_is_private_and_never_follows_a_link() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RC_FILE);
        write_private(&path, b"pin 0000\n").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        // A link planted at the path is removed, not written through.
        let target = dir.path().join("target");
        std::fs::write(&target, b"untouched").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        write_private(&path, b"pin 1111\n").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
        assert!(!std::fs::symlink_metadata(&path).unwrap().file_type().is_symlink());
    }
}
