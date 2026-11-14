//! Peer checks for the Edge helper sockets that only `tilecastd` may use:
//! `tilecast-edge-update.socket` and `tilecast-airplay.socket`.
//!
//! Both sockets are `root:tilecast`, mode 0660. The renderer and the session
//! bridge run as the same `tilecast` account, so the file mode alone does not
//! keep them out. A peer must be the `tilecast` account (`SO_PEERCRED`) and
//! its process must be in `tilecast-edge.service`'s control group.

use std::path::Path;

/// The one control group whose processes may use a helper socket.
pub const DAEMON_CGROUP: &str = "/system.slice/tilecast-edge.service";

/// Whether `/proc/<pid>/cgroup` text places the process exactly in `group`
/// on the unified hierarchy.
pub fn cgroup_is(text: &str, group: &str) -> bool {
    text.lines().any(|line| line.strip_prefix("0::") == Some(group))
}

/// The UID of a local account, from `/etc/passwd`.
pub fn account_uid(name: &str) -> Option<u32> {
    account_uid_in(Path::new("/etc/passwd"), name)
}

fn account_uid_in(passwd: &Path, name: &str) -> Option<u32> {
    let bytes = crate::fs::read_regular(passwd, 4 * 1024 * 1024).ok()??;
    String::from_utf8_lossy(&bytes).lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        (fields.len() == 7 && fields[0] == name).then(|| fields[2].parse().ok())?
    })
}

/// Allows the peer only if it is `uid` and runs in [`DAEMON_CGROUP`]. The
/// error is a stable reason code.
#[cfg(target_os = "linux")]
pub fn allow_daemon(socket: impl std::os::fd::AsFd, uid: u32) -> Result<(), &'static str> {
    let credentials = rustix::net::sockopt::socket_peercred(socket).map_err(|_| "peer_unknown")?;
    if credentials.uid.as_raw() != uid {
        return Err("peer_not_allowed");
    }
    let cgroup = std::fs::read_to_string(format!("/proc/{}/cgroup", credentials.pid.as_raw_nonzero()))
        .map_err(|_| "peer_unknown")?;
    if cgroup_is(&cgroup, DAEMON_CGROUP) { Ok(()) } else { Err("peer_not_allowed") }
}

/// Peer credentials exist only on Linux.
#[cfg(not(target_os = "linux"))]
pub fn allow_daemon(_socket: impl std::os::fd::AsFd, _uid: u32) -> Result<(), &'static str> {
    Err("peer_not_allowed")
}

/// The unified cgroup hierarchy.
pub const CGROUP_ROOT: &str = "/sys/fs/cgroup";
#[cfg(target_os = "linux")]
const MAX_CGROUP_PROCS_BYTES: u64 = 1024 * 1024;

/// [`allow_daemon`] for a process that cannot see other accounts'
/// processes (`ProtectProc=invisible`). It reads the member list of
/// [`DAEMON_CGROUP`] from the cgroup file system instead of the peer's
/// `/proc/<pid>/cgroup`. `cgroup.procs` lists exactly the processes in that
/// group, not those in a child group, so the rule is the same.
#[cfg(target_os = "linux")]
pub fn allow_daemon_listed(socket: impl std::os::fd::AsFd, uid: u32) -> Result<(), &'static str> {
    let credentials = rustix::net::sockopt::socket_peercred(socket).map_err(|_| "peer_unknown")?;
    if credentials.uid.as_raw() != uid {
        return Err("peer_not_allowed");
    }
    let list = Path::new(CGROUP_ROOT).join(DAEMON_CGROUP.trim_start_matches('/')).join("cgroup.procs");
    // No daemon group means that no process is in it.
    let bytes = match crate::fs::read_regular(&list, MAX_CGROUP_PROCS_BYTES) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return Err("peer_not_allowed"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err("peer_not_allowed"),
        Err(_) => return Err("peer_unknown"),
    };
    if procs_contains(&String::from_utf8_lossy(&bytes), credentials.pid.as_raw_nonzero().get()) {
        Ok(())
    } else {
        Err("peer_not_allowed")
    }
}

/// Peer credentials exist only on Linux.
#[cfg(not(target_os = "linux"))]
pub fn allow_daemon_listed(_socket: impl std::os::fd::AsFd, _uid: u32) -> Result<(), &'static str> {
    Err("peer_not_allowed")
}

/// Whether a `cgroup.procs` list has `pid`.
pub fn procs_contains(text: &str, pid: i32) -> bool {
    text.lines().any(|line| line.trim().parse::<i32>() == Ok(pid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_daemon_unit_control_group_is_allowed() {
        assert!(cgroup_is("0::/system.slice/tilecast-edge.service\n", DAEMON_CGROUP));
        for other in [
            "0::/system.slice/tilecast-renderer.service\n",
            "0::/user.slice/user-999.slice/user@999.service/app.slice/tilecast-session-bridge.service\n",
            "0::/system.slice/tilecast-edge.service/child\n",
            "1:name=systemd:/system.slice/tilecast-edge.service\n",
        ] {
            assert!(!cgroup_is(other, DAEMON_CGROUP), "{other}");
        }
    }

    #[test]
    fn cgroup_procs_lists_are_matched_exactly() {
        assert!(procs_contains("12\n345\n", 345));
        assert!(!procs_contains("12\n3456\n", 345));
        assert!(!procs_contains("", 1));
    }

    #[test]
    fn account_uid_reads_the_named_account_only() {
        let dir = tempfile::tempdir().unwrap();
        let passwd = dir.path().join("passwd");
        std::fs::write(
            &passwd,
            "root:x:0:0:root:/root:/bin/bash\ntilecast-web:x:997:997::/var/lib/tilecast-web:/usr/sbin/nologin\n\
             tilecast:x:998:998:Tilecast:/var/lib/tilecast-edge:/bin/sh\nbroken:x\n",
        )
        .unwrap();
        assert_eq!(account_uid_in(&passwd, "tilecast"), Some(998));
        assert_eq!(account_uid_in(&passwd, "tilecast-airplay"), None);
        assert_eq!(account_uid_in(&dir.path().join("missing"), "tilecast"), None);
    }
}
