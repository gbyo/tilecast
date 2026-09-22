//! Minimal native `sd_notify` (RFC §27.2–27.3).
//!
//! * `READY=1` is sent once the state store is open (or recovery mode is
//!   entered) and the IPC socket is listening. It never waits for the
//!   Tilecast Server.
//! * `WATCHDOG=1` is sent by the daemon's own health loop at half of
//!   `WATCHDOG_USEC`, and only while that loop observes the daemon healthy.
//!   A stuck renderer does not stop it; a stuck daemon does.
//! * `STOPPING=1` is sent when graceful shutdown begins.
//!
//! When `NOTIFY_SOCKET` is absent (development, tests) every call is a no-op
//! that reports `false`. Child processes must not inherit the notify or
//! watchdog variables: spawn them with [`CHILD_ENV_REMOVE`] removed.

use std::path::PathBuf;
use std::time::Duration;

/// Environment variables that must be removed from any spawned child.
pub const CHILD_ENV_REMOVE: &[&str] = &["NOTIFY_SOCKET", "WATCHDOG_USEC", "WATCHDOG_PID"];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    Path(PathBuf),
    #[cfg(target_os = "linux")]
    Abstract(Vec<u8>),
}

#[derive(Debug, Clone)]
pub struct Notifier {
    target: Option<Target>,
    watchdog: Option<Duration>,
}

impl Notifier {
    /// Reads `NOTIFY_SOCKET`, `WATCHDOG_USEC` and `WATCHDOG_PID`.
    pub fn from_environment() -> Self {
        let target = std::env::var_os("NOTIFY_SOCKET").and_then(|value| parse_target(value.to_str()?));
        let pid_matches = match std::env::var("WATCHDOG_PID") {
            Ok(pid) => pid.parse::<i32>().ok() == Some(rustix::process::getpid().as_raw_nonzero().get()),
            Err(_) => true,
        };
        let watchdog = std::env::var("WATCHDOG_USEC")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|usec| *usec > 0 && pid_matches)
            .map(Duration::from_micros);
        Self { target, watchdog }
    }

    /// A notifier that sends nothing.
    pub fn disabled() -> Self {
        Self { target: None, watchdog: None }
    }

    /// For tests: send to a datagram socket at `path`.
    pub fn with_socket(path: PathBuf, watchdog: Option<Duration>) -> Self {
        Self { target: Some(Target::Path(path)), watchdog }
    }

    pub fn is_enabled(&self) -> bool {
        self.target.is_some()
    }

    /// The configured watchdog timeout, if systemd supervises this process.
    pub fn watchdog_timeout(&self) -> Option<Duration> {
        self.watchdog
    }

    /// How often to send `WATCHDOG=1`: half the timeout, per sd_notify(3).
    pub fn watchdog_interval(&self) -> Option<Duration> {
        self.watchdog.map(|timeout| timeout / 2)
    }

    pub fn ready(&self, status: &str) -> bool {
        self.send(&format!("READY=1\nSTATUS={}", sanitize(status)))
    }

    pub fn status(&self, status: &str) -> bool {
        self.send(&format!("STATUS={}", sanitize(status)))
    }

    pub fn watchdog(&self) -> bool {
        self.watchdog.is_some() && self.send("WATCHDOG=1")
    }

    pub fn stopping(&self) -> bool {
        self.send("STOPPING=1")
    }

    fn send(&self, message: &str) -> bool {
        let Some(target) = &self.target else {
            return false;
        };
        let Ok(socket) = std::os::unix::net::UnixDatagram::unbound() else {
            return false;
        };
        let result = match target {
            Target::Path(path) => socket.send_to(message.as_bytes(), path),
            #[cfg(target_os = "linux")]
            Target::Abstract(name) => {
                use std::os::linux::net::SocketAddrExt;
                match std::os::unix::net::SocketAddr::from_abstract_name(name) {
                    Ok(address) => socket.send_to_addr(message.as_bytes(), &address),
                    Err(error) => Err(error),
                }
            }
        };
        result.is_ok()
    }
}

fn parse_target(value: &str) -> Option<Target> {
    if let Some(name) = value.strip_prefix('@') {
        #[cfg(target_os = "linux")]
        return Some(Target::Abstract(name.as_bytes().to_vec()));
        #[cfg(not(target_os = "linux"))]
        {
            let _ = name;
            return None;
        }
    }
    let path = PathBuf::from(value);
    path.is_absolute().then_some(Target::Path(path))
}

/// Status text is one line: newlines would inject additional assignments.
fn sanitize(status: &str) -> String {
    status.chars().map(|c| if c.is_control() { ' ' } else { c }).take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_ready_watchdog_and_stopping() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notify.sock");
        let receiver = std::os::unix::net::UnixDatagram::bind(&path).expect("bind");
        let notifier = Notifier::with_socket(path, Some(Duration::from_secs(30)));
        assert_eq!(notifier.watchdog_interval(), Some(Duration::from_secs(15)));
        assert!(notifier.ready("State open\nWATCHDOG=1"));
        assert!(notifier.watchdog());
        assert!(notifier.stopping());
        let mut buffer = [0u8; 256];
        let read = |buffer: &mut [u8]| {
            let n = receiver.recv(buffer).expect("recv");
            String::from_utf8_lossy(&buffer[..n]).into_owned()
        };
        assert_eq!(read(&mut buffer), "READY=1\nSTATUS=State open WATCHDOG=1");
        assert_eq!(read(&mut buffer), "WATCHDOG=1");
        assert_eq!(read(&mut buffer), "STOPPING=1");
    }

    #[test]
    fn disabled_notifier_is_a_no_op() {
        let notifier = Notifier::disabled();
        assert!(!notifier.ready("x"));
        assert!(!notifier.watchdog());
        assert_eq!(notifier.watchdog_interval(), None);
    }

    #[test]
    fn relative_socket_paths_are_ignored() {
        assert_eq!(parse_target("relative/notify"), None);
        assert!(matches!(parse_target("/run/systemd/notify"), Some(Target::Path(_))));
    }
}
