//! The guard units, written while an activation is open.
//!
//! They are not part of any release. The helper that starts an activation
//! writes them from these constants, with `ExecStart=` naming the helper of
//! the release it replaces. The candidate's unit files therefore cannot
//! change them, and a candidate whose own helper does not run is still
//! rolled back.
//!
//! * The service runs at boot before the Edge units, so after a power loss
//!   an unconfirmed candidate is rolled back before it starts again.
//! * The timer runs the same check every 30 seconds while the window is open.

use std::path::Path;

pub fn service(install_root: &Path, previous_version: &str) -> String {
    let helper = install_root.join(previous_version).join("bin/tilecast-edge-update");
    format!(
        "# Written by tilecast-edge-update while an update is provisional; removed when it ends.
# It runs the previous release's helper, so the candidate cannot prevent its own rollback.
[Unit]
Description=Tilecast Edge update guard
Documentation=https://github.com/gbyo/tilecast/blob/main/docs/tilecast-edge.md
ConditionPathExists=/var/lib/tilecast-edge-update/transaction.json
After=dbus.service local-fs.target
Before=tilecast-edge.service tilecast-renderer.service
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart={helper} guard
TimeoutStartSec=15min
UMask=0077
# The helper's sandbox (tilecast-edge-update.service).
ProtectSystem=strict
ReadWritePaths=/etc /opt/tilecast-edge /var/lib/tilecast-edge-update -/var/lib/tilecast-edge
ReadWritePaths=-/usr/lib/sysusers.d -/usr/lib/tmpfiles.d -/usr/lib/udev/rules.d -/usr/lib/modules-load.d
InaccessiblePaths=-/var/lib/tilecast-edge/identity
NoNewPrivileges=yes
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_UNIX
SystemCallArchitectures=native
MemoryDenyWriteExecute=yes
IPAddressDeny=any
CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_FSETID

[Install]
WantedBy=multi-user.target
",
        helper = helper.display()
    )
}

pub fn timer() -> String {
    "# Written by tilecast-edge-update while an update is provisional; removed when it ends.
[Unit]
Description=Tilecast Edge update guard timer
Documentation=https://github.com/gbyo/tilecast/blob/main/docs/tilecast-edge.md

[Timer]
OnActiveSec=30s
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
"
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_guard_runs_the_previous_release_before_edge_starts() {
        let text = service(Path::new("/opt/tilecast-edge"), "0.1.0");
        assert!(text.contains("ExecStart=/opt/tilecast-edge/0.1.0/bin/tilecast-edge-update guard\n"));
        assert!(!text.contains("/current/"), "never the candidate's helper");
        assert!(text.contains("Before=tilecast-edge.service tilecast-renderer.service"));
        assert!(timer().contains("OnUnitActiveSec=30s"));
        let helper = include_str!("../../packaging/systemd/tilecast-edge-update.service");
        for line in [
            "CapabilityBoundingSet=",
            "ProtectSystem=strict",
            "InaccessiblePaths=",
            "NoNewPrivileges=yes",
            "RestrictAddressFamilies=",
        ] {
            let expected = helper.lines().find(|l| l.starts_with(line)).unwrap();
            assert!(text.lines().any(|l| l == expected), "the guard shares the helper's {line}");
        }
    }
}
