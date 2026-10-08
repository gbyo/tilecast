#!/usr/bin/env bash
# Proves a finished release tree under the production systemd sandbox, with
# WebKit's bubblewrap sandbox on and nothing that disables it.
#
#   apps/edge/release/run-sandbox-check.sh /path/to/tree
#
# On a clean Debian 13 with real systemd as PID 1 it installs the tree's own
# units, starts the release self-test exactly as the migrator does (the
# renderer unit, then the self-test host unit, which draws the built-in
# fixture off screen), and requires that the self-test passes while the
# renderer's web process runs inside bubblewrap. The container is privileged
# for systemd; the host kernel must allow unprivileged user namespaces
# (Ubuntu 24.04: sysctl kernel.apparmor_restrict_unprivileged_userns=0).
set -euo pipefail
tree=${1:?usage: run-sandbox-check.sh TREE}
tree=$(cd -- "$tree" && pwd)
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
name=tilecast-sandbox-check
docker build -q -t tilecast-edge-sandbox -f "$here/Dockerfile.sandbox" "$here" >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --privileged --tmpfs /run --tmpfs /run/lock \
  -v "$tree:/opt/tilecast-edge/current:ro" tilecast-edge-sandbox >/dev/null
trap '[ "${KEEP:-0}" = 1 ] || docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker exec "$name" sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
for _ in $(seq 1 60); do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running|degraded) break ;; esac
  sleep 1
done
docker exec -i "$name" python3 - <<'PY'
import json, os, subprocess, sys, time

TREE = "/opt/tilecast-edge/current"
UNITS = ["tilecast-edge-selftest.service", "tilecast-renderer-selftest.service", "tilecast-renderer-probe.service",
         "tilecast-renderer.service", "tilecast-web-renderer.service"]


def run(*argv, check=True):
    return subprocess.run(argv, check=check, capture_output=True, text=True)


def show(unit, *props):
    text = run("systemctl", "show", "--property=" + ",".join(props), unit).stdout
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


for source, target in (("sysusers.d/tilecast-edge.conf", "/usr/lib/sysusers.d/tilecast-edge.conf"),
                       ("tmpfiles.d/tilecast-edge.conf", "/usr/lib/tmpfiles.d/tilecast-edge.conf")):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    run("cp", f"{TREE}/packaging/{source}", target)
for unit in UNITS:
    run("cp", f"{TREE}/packaging/systemd/{unit}", f"/etc/systemd/system/{unit}")
os.makedirs("/run/tilecast-edge-migrate", exist_ok=True)
run("systemd-sysusers", "/usr/lib/sysusers.d/tilecast-edge.conf")
run("systemd-tmpfiles", "--create", "/usr/lib/tmpfiles.d/tilecast-edge.conf")
run("systemctl", "daemon-reload")

# The units as packaged: nothing disables WebKit's sandbox, and none of the
# directives that stop its bubblewrap from mounting /proc is set.
for unit in ("tilecast-renderer.service", "tilecast-renderer-selftest.service", "tilecast-web-renderer.service"):
    props = show(unit, "Environment", "ProtectKernelTunables", "ProtectKernelLogs", "RestrictSUIDSGID", "ProtectSystem",
                 "ProtectHome", "NoNewPrivileges", "PrivateTmp", "CapabilityBoundingSet", "InaccessiblePaths")
    assert "WEBKIT_DISABLE_SANDBOX" not in props["Environment"], (unit, props)
    assert props["ProtectKernelTunables"] == props["ProtectKernelLogs"] == props["RestrictSUIDSGID"] == "no", props
    assert props["ProtectSystem"] == "strict" and props["ProtectHome"] == "yes", props
    assert props["NoNewPrivileges"] == "yes" and props["PrivateTmp"] == "yes", props
    assert "/var/lib/tilecast-edge" in props["InaccessiblePaths"], props
home = show("tilecast-renderer-selftest.service", "Environment")["Environment"]
assert "HOME=/var/cache/tilecast-renderer-selftest/home" in home and "/var/lib/tilecast-edge" not in home, home

# The release self-test, started as the migrator starts it: the renderer
# first, then the host that waits for it. /run here is a small tmpfs.
run("systemctl", "start", "tilecast-renderer-selftest.service")
sandboxed = []


def watch():
    """While the host runs, WebKit's web process must be inside bubblewrap."""
    table = {}
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                stat = open(f"/proc/{entry}/stat").read()
                cmd = open(f"/proc/{entry}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace")
            except OSError:
                continue
            table[int(entry)] = (stat[stat.index("(") + 1:stat.rindex(")")], int(stat[stat.rindex(")") + 2:].split()[1]), cmd)
    for pid, (_, _, cmd) in table.items():
        if "WPEWebProcess" in cmd:
            cursor = pid
            while cursor in table:
                if table[cursor][0] == "bwrap":
                    sandboxed.append(pid)
                    break
                cursor = table[cursor][1]


host = subprocess.Popen(["systemctl", "start", "tilecast-edge-selftest.service"])
while host.poll() is None:
    watch()
    time.sleep(0.5)
result = show("tilecast-edge-selftest.service", "ExecMainStatus", "Result")
report = {}
try:
    report = json.loads(open("/run/tilecast-edge-migrate/selftest.json").read().strip().splitlines()[-1])
except (OSError, ValueError, IndexError):
    pass
if os.path.exists("/run/tilecast-edge-migrate/selftest-renderer.err"):
    print("renderer stderr:", open("/run/tilecast-edge-migrate/selftest-renderer.err").read()[-1500:])
assert result["ExecMainStatus"] == "0" and report.get("outcome") == "passed", (result, report)
assert sandboxed, "the renderer's web process never ran inside bubblewrap"
print(f"sandbox check: the release self-test passed in {report['elapsedMs']} ms with WebKit's bubblewrap sandbox on "
      f"({len(set(sandboxed))} sandboxed web process(es)); items {report['provenItems']}")
PY
