#!/usr/bin/env bash
# Proves the release's Presentation Network helper under its production unit
# (docs/tilecast-edge-airplay.md section 8): real systemd, the tree's own
# tilecast-networkd.service and sysusers.d file, and the root-owned
# bin/tilecast-networkd. run-sandbox-check.sh runs it after the renderer
# self-test; it also runs on its own:
#
#   apps/edge/release/run-networkd-sandbox-check.sh /path/to/tree
#
# The sandbox image has no NetworkManager, and the check keeps it that way.
# It requires that the helper starts from the tree and creates its socket as
# root:tilecast-network 0660; that a process in the tilecast-network group
# gets a typed answer to `status` without NetworkManager; that a process
# outside the group is refused; and that nothing enabled or installed
# NetworkManager.
set -euo pipefail
tree=${1:?usage: run-networkd-sandbox-check.sh TREE}
tree=$(cd -- "$tree" && pwd)
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
name=tilecast-networkd-sandbox-check
docker build -q -t tilecast-edge-sandbox -f "$here/Dockerfile.sandbox" "$here" >/dev/null
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --privileged --tmpfs /run --tmpfs /run/lock \
  -v "$tree:/opt/tilecast-edge/current:ro" tilecast-edge-sandbox >/dev/null
trap '[ "${KEEP:-0}" = 1 ] || docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  state=$(docker exec "$name" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running|degraded) break ;; esac
  sleep 1
done
docker exec -i "$name" python3 - <<'PY'
import grp, json, os, stat, subprocess, sys, time

TREE = "/opt/tilecast-edge/current"
SOCKET = "/run/tilecast/networkd.sock"
CLIENT = r'''
import json, socket, sys
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.settimeout(30)
try:
    client.connect("/run/tilecast/networkd.sock")
except OSError as error:
    print(json.dumps({"connect": error.errno}))
    sys.exit(0)
client.sendall(json.dumps({"op": "status"}).encode() + b"\n")
print(client.makefile("rb").readline().decode().strip())
'''


def run(*argv, check=True):
    return subprocess.run(argv, check=check, capture_output=True, text=True)


def fail(message):
    print("networkd sandbox check FAILED:", message)
    print(run("journalctl", "-b", "--no-pager", "-n", "40", "-u", "tilecast-networkd.service", check=False).stdout)
    sys.exit(1)


def ask(user, groups):
    argv = ["systemd-run", "--wait", "--pipe", "--collect", "--quiet", f"--uid={user}"]
    if groups:
        argv.append(f"--property=SupplementaryGroups={groups}")
    out = run(*argv, "/usr/bin/python3", "-c", CLIENT).stdout.strip()
    return json.loads(out.splitlines()[-1])


os.makedirs("/usr/lib/sysusers.d", exist_ok=True)
run("cp", f"{TREE}/packaging/sysusers.d/tilecast-edge.conf", "/usr/lib/sysusers.d/tilecast-edge.conf")
run("cp", f"{TREE}/packaging/systemd/tilecast-networkd.service", "/etc/systemd/system/tilecast-networkd.service")
run("systemd-sysusers", "/usr/lib/sysusers.d/tilecast-edge.conf")
run("systemctl", "daemon-reload")
mode = os.stat(f"{TREE}/bin/tilecast-networkd")
assert mode.st_uid == 0 and mode.st_mode & 0o022 == 0, "the staged helper must be root-owned and not group or world writable"
run("systemctl", "start", "tilecast-networkd.service")
for _ in range(50):
    if os.path.exists(SOCKET):
        break
    time.sleep(0.2)
else:
    fail("the helper never created its socket")
info = os.stat(SOCKET)
assert stat.S_ISSOCK(info.st_mode) and info.st_uid == 0, info
assert info.st_gid == grp.getgrnam("tilecast-network").gr_gid and stat.S_IMODE(info.st_mode) == 0o660, oct(info.st_mode)

reply = ask("tilecast", "tilecast-network")
assert isinstance(reply, dict) and "ok" in reply, reply
assert "connect" not in reply, f"a tilecast-network member must reach the helper: {reply}"
denied = ask("tilecast-airplay", "")
assert denied.get("connect") in (13, 1), f"a process outside tilecast-network must be refused: {denied}"
assert run("systemctl", "is-active", "tilecast-networkd.service").stdout.strip() == "active"
assert run("systemctl", "is-enabled", "NetworkManager.service", check=False).returncode != 0, "NetworkManager must stay unenabled"
assert not os.path.exists("/usr/bin/nmcli"), "the sandbox check must run without NetworkManager"
print(f"networkd sandbox check: the release's tilecast-networkd ran as root from the tree; status answered {reply.get('code', 'ok')!r} without NetworkManager")
PY
