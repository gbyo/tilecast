#!/usr/bin/env bash
# Proves the release's UxPlay under the production AirPlay units
# (docs/tilecast-edge-airplay-threat-review.md §3): real systemd, the tree's
# own tilecast-airplay.socket and .service with every sandbox option, the
# operating system baseline (avahi-daemon included) and the GStreamer
# plugins that a screen has. run-sandbox-check.sh runs it after the renderer
# self-test; it also runs on its own:
#
#   apps/edge/release/run-airplay-sandbox-check.sh /path/to/tree
#
# It requires that UxPlay reports 1.73.7, that avahi-daemon is seen, that a
# session starts and UxPlay stays up with its AirPlay ports open (so its
# GStreamer pipelines parse and its DNS-SD registration works under
# MemoryDenyWriteExecute= and SystemCallFilter=@system-service), and that
# the test PIN and device ID are in no process argument and no log.
set -euo pipefail
tree=${1:?usage: run-airplay-sandbox-check.sh TREE}
tree=$(cd -- "$tree" && pwd)
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
name=tilecast-airplay-sandbox-check
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
import json, os, subprocess, sys, time

TREE = "/opt/tilecast-edge/current"
SESSION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
PIN, DEVICE = "8264", "02:82:64:5a:6b:7c"
WORK = "/run/airplay-check"
CLIENT = r'''
import json, socket, sys
mode, events = sys.argv[1], sys.argv[2]
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect("/run/tilecast-airplay/control.sock")
reader = client.makefile("rb")
def send(message):
    client.sendall(json.dumps(message).encode() + b"\n")
def record():
    line = reader.readline()
    with open(events, "a") as handle:
        handle.write(line.decode() if line else "EOF\n")
    return line
if mode == "probe":
    send({"type": "probe"})
    record()
else:
    send({"type": "start", "sessionId": "%(session)s", "receiverName": "Sandbox Check", "pin": "%(pin)s",
          "deviceId": "%(device)s", "profile": "1080p30", "audioMode": "gateway_only",
          "videoPort": 42000, "audioPort": 42002})
    while record():
        pass
''' % {"session": SESSION, "pin": PIN, "device": DEVICE}


def run(*argv, check=True):
    return subprocess.run(argv, check=check, capture_output=True, text=True)


def fail(message):
    print("airplay sandbox check FAILED:", message)
    print(run("journalctl", "-b", "--no-pager", "-n", "60", "-u", "tilecast-airplay.service", check=False).stdout)
    sys.exit(1)


def events(name):
    try:
        with open(os.path.join(WORK, name)) as handle:
            return [line.strip() for line in handle if line.strip()]
    except OSError:
        return []


def client(mode, name, wait=True):
    argv = ["systemd-run", "--unit=tilecast-edge.service", "--uid=tilecast", "--collect", "--quiet",
            "--property=Type=exec", "/usr/bin/python3", os.path.join(WORK, "client.py"), mode, os.path.join(WORK, name)]
    if wait:
        argv.insert(1, "--wait")
    run(*argv)


def listening(port):
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table) as handle:
                for line in handle.readlines()[1:]:
                    fields = line.split()
                    if int(fields[1].rsplit(":", 1)[1], 16) == port and fields[3] == "0A":
                        return True
        except OSError:
            pass
    return False


def uxplay_pids():
    found = []
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                if b"/bin/uxplay" in open(f"/proc/{entry}/cmdline", "rb").read():
                    found.append(int(entry))
            except OSError:
                pass
    return found


os.makedirs("/usr/lib/sysusers.d", exist_ok=True)
run("cp", f"{TREE}/packaging/sysusers.d/tilecast-edge.conf", "/usr/lib/sysusers.d/tilecast-edge.conf")
for unit in ("tilecast-airplay.service", "tilecast-airplay.socket"):
    run("cp", f"{TREE}/packaging/systemd/{unit}", f"/etc/systemd/system/{unit}")
run("systemd-sysusers", "/usr/lib/sysusers.d/tilecast-edge.conf")
run("systemctl", "daemon-reload")
run("systemctl", "start", "avahi-daemon.service", "tilecast-airplay.socket")
os.makedirs(WORK, exist_ok=True)
os.chmod(WORK, 0o1777)
with open(os.path.join(WORK, "client.py"), "w") as handle:
    handle.write(CLIENT)

props = run("systemctl", "show", "--property=MemoryDenyWriteExecute,SystemCallFilter,ProtectProc,User,RestrictAddressFamilies",
            "tilecast-airplay.service").stdout
assert "MemoryDenyWriteExecute=yes" in props and "ProtectProc=invisible" in props and "User=tilecast-airplay" in props, props

client("probe", "probe.jsonl")
probe = json.loads((events("probe.jsonl") or ["{}"])[0])
if probe != {"type": "probe_result", "uxplayVersion": "1.73.7", "avahiAvailable": True}:
    fail(f"probe: {probe}")

client("session", "session.jsonl", wait=False)
deadline = time.monotonic() + 30
while time.monotonic() < deadline and not any('"advertising"' in line for line in events("session.jsonl")):
    if any('"failed"' in line for line in events("session.jsonl")):
        fail(f"session: {events('session.jsonl')}")
    time.sleep(0.2)
else:
    pass
if not any('"advertising"' in line for line in events("session.jsonl")):
    fail(f"no advertising: {events('session.jsonl')}")
# UxPlay registers with avahi-daemon after it opens its sockets and exits if
# that fails; its pipelines are built at start and abort on a missing plugin.
time.sleep(5)
pids = uxplay_pids()
if len(pids) != 1 or any('"failed"' in line for line in events("session.jsonl")):
    fail(f"UxPlay did not stay up: {pids} {events('session.jsonl')}")
# UxPlay's AirPlay and RAOP server is one HTTP listener in 37000-37002
# (1.73.7 opens TCP 37001).
if not any(listening(port) for port in (37000, 37001, 37002)):
    fail("UxPlay is not listening on TCP 37000-37002")
for entry in os.listdir("/proc"):
    if entry.isdigit():
        try:
            cmdline = open(f"/proc/{entry}/cmdline", "rb").read()
        except OSError:
            continue
        if PIN.encode() in cmdline or DEVICE.encode() in cmdline:
            fail(f"a secret is in a process argument: {cmdline!r}")
run("systemctl", "stop", "tilecast-edge.service", check=False)
deadline = time.monotonic() + 20
while uxplay_pids() and time.monotonic() < deadline:
    time.sleep(0.2)
if uxplay_pids():
    fail("UxPlay outlived the control connection")
run("journalctl", "--sync")
journal = run("journalctl", "-b", "--no-pager", "-o", "cat").stdout
for secret in (PIN, DEVICE, "82:64:5a"):
    if secret in journal:
        fail(f"{secret} is in the journal")
denied = [line for line in journal.splitlines() if "audit" in line.lower() and "uxplay" in line.lower()]
if denied:
    fail(f"seccomp or audit messages for UxPlay: {denied[:3]}")
print("airplay sandbox check: UxPlay 1.73.7 ran under tilecast-airplay.service with avahi-daemon, "
      "its sockets open and no secret in an argument or the journal")
PY
