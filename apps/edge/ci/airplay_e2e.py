#!/usr/bin/env python3
"""The AirPlay supervisor under real systemd (run-airplay-e2e.sh).

Runs as root inside the systemd container. It builds tilecast-airplay,
installs it with the fake UxPlay (apps/edge/tilecast-airplay/tests/
fake-uxplay) as /opt/tilecast-edge/current/bin/{tilecast-airplay,uxplay},
installs the release's units and sysusers.d file, and drives the socket
from transient units that stand in for tilecastd and the renderer.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

EDGE = "/src/apps/edge"
TARGET = "/target/cargo-qual"
RELEASE = "/opt/tilecast-edge/airplay-e2e"
WORK = "/run/airplay-e2e"
SESSION_DIR = "/run/tilecast-airplay-session"
SOCKET = "/run/tilecast-airplay/control.sock"
SESSION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
# Test-only values, distinctive enough to search for.
PIN = "8264"
DEVICE_ID = "02:82:64:5a:6b:7c"

CLIENT = r'''
import json, socket, sys, time
mode, events = sys.argv[1], sys.argv[2]
client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
client.connect("%(socket)s")
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
    send({"type": "start", "sessionId": "%(session)s", "receiverName": "E2E Lobby", "pin": "%(pin)s",
          "deviceId": "%(device)s", "profile": "1080p30", "audioMode": "gateway_only",
          "videoPort": 42000, "audioPort": 42002})
    while record():
        pass
''' % {"socket": SOCKET, "session": SESSION, "pin": PIN, "device": DEVICE_ID}


def run(*argv, check=True, **kwargs):
    return subprocess.run(argv, check=check, **kwargs)


def output(*argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True).stdout


def step(text):
    print(f"== {text}", flush=True)


def fail(text):
    print(f"FAIL: {text}", flush=True)
    subprocess.run(["systemctl", "status", "--no-pager", "tilecast-airplay.socket", "tilecast-airplay.service"])
    subprocess.run(["journalctl", "-b", "--no-pager", "-n", "60", "-u", "tilecast-airplay.service"])
    sys.exit(1)


def wait(condition, what, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(0.1)
    fail(f"timed out waiting for {what}")


def events(name):
    path = os.path.join(WORK, name)
    if not os.path.exists(path):
        return []
    with open(path) as handle:
        return [line.strip() for line in handle if line.strip()]


def as_unit(unit, uid, mode, events_name, wait_for_exit=True):
    argv = ["systemd-run", f"--unit={unit}", f"--uid={uid}", "--collect", "--quiet",
            "--property=Type=exec", "/usr/bin/python3", os.path.join(WORK, "client.py"), mode,
            os.path.join(WORK, events_name)]
    if wait_for_exit:
        argv.insert(1, "--wait")
    run(*argv)


def unit_active(unit):
    return subprocess.run(["systemctl", "is-active", "--quiet", unit]).returncode == 0


def uxplay_pids():
    pids = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as handle:
                cmdline = handle.read()
        except OSError:
            continue
        if b"/bin/uxplay" in cmdline:
            pids.append(int(entry))
    return pids


def all_cmdlines():
    found = []
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                with open(f"/proc/{entry}/cmdline", "rb") as handle:
                    found.append(handle.read())
            except OSError:
                pass
    return found


def setup():
    step("build tilecast-airplay")
    env = dict(os.environ, CARGO_TARGET_DIR=TARGET, CARGO_HOME="/target/cargo-home", CARGO_PROFILE_DEV_DEBUG="0",
               CARGO_INCREMENTAL="0", PATH="/target/cargo-home/bin:/opt/cargo/bin:" + os.environ.get("PATH", ""))
    run("cargo", "build", "-q", "--locked", "-p", "tilecast-airplay", cwd="/src", env=env)
    step("install the units, the account and the fake UxPlay")
    # A second setup (the headless airplay scenario) replaces a binary that
    # a running supervisor may still hold open.
    run("systemctl", "stop", "tilecast-airplay.socket", "tilecast-airplay.service", check=False)
    os.makedirs(os.path.join(RELEASE, "bin"), exist_ok=True)
    shutil.copy(os.path.join(TARGET, "debug/tilecast-airplay"), os.path.join(RELEASE, "bin/tilecast-airplay"))
    shutil.copy(os.path.join(EDGE, "tilecast-airplay/tests/fake-uxplay"), os.path.join(RELEASE, "bin/uxplay"))
    for name in ("tilecast-airplay", "uxplay"):
        os.chmod(os.path.join(RELEASE, "bin", name), 0o755)
    if os.path.lexists("/opt/tilecast-edge/current"):
        os.remove("/opt/tilecast-edge/current")
    os.symlink("airplay-e2e", "/opt/tilecast-edge/current")
    for unit in ("tilecast-airplay.service", "tilecast-airplay.socket"):
        shutil.copy(os.path.join(EDGE, "packaging/systemd", unit), f"/etc/systemd/system/{unit}")
    os.makedirs("/etc/sysusers.d", exist_ok=True)
    shutil.copy(os.path.join(EDGE, "packaging/sysusers.d/tilecast-edge.conf"), "/etc/sysusers.d/tilecast-edge.conf")
    run("systemd-sysusers")
    run("systemctl", "daemon-reload")
    run("systemctl", "start", "tilecast-airplay.socket")
    os.makedirs(WORK, exist_ok=True)
    os.chmod(WORK, 0o1777)
    with open(os.path.join(WORK, "client.py"), "w") as handle:
        handle.write(CLIENT)
    groups = output("id", "-Gn", "tilecast-airplay").split()
    if groups != ["tilecast-airplay"]:
        fail(f"tilecast-airplay is in other groups: {groups}")
    stat = os.stat(SOCKET)
    if stat.st_mode & 0o777 != 0o660 or stat.st_uid != 0 or stat.st_gid != int(output("getent", "group", "tilecast").split(":")[2]):
        fail("the socket is not root:tilecast 0660")


def refusals():
    step("the renderer's control group is refused")
    as_unit("tilecast-renderer.service", "tilecast", "probe", "renderer.jsonl")
    if events("renderer.jsonl")[:1] != ['{"type":"rejected","code":"peer_not_allowed"}']:
        fail(f"renderer: {events('renderer.jsonl')}")
    step("root in the daemon's control group is refused")
    as_unit("tilecast-edge.service", "root", "probe", "root.jsonl")
    if events("root.jsonl")[:1] != ['{"type":"rejected","code":"peer_not_allowed"}']:
        fail(f"root: {events('root.jsonl')}")
    if uxplay_pids():
        fail("a refused peer started UxPlay")


def probe():
    step("tilecastd's control group is served")
    as_unit("tilecast-edge.service", "tilecast", "probe", "probe.jsonl")
    got = json.loads(events("probe.jsonl")[0])
    if got.get("type") != "probe_result" or got.get("uxplayVersion") != "1.73.7":
        fail(f"probe: {got}")
    wait(lambda: not unit_active("tilecast-airplay.service"), "the supervisor to exit after the connection closed")


def session_and_sigkill():
    step("a session: no secret in a process argument")
    as_unit("tilecast-edge.service", "tilecast", "session", "session.jsonl", wait_for_exit=False)
    wait(lambda: any('"advertising"' in line for line in events("session.jsonl")), "advertising")
    pids = uxplay_pids()
    if len(pids) != 1:
        fail(f"expected one uxplay process, found {pids}")
    with open(f"/proc/{pids[0]}/status") as handle:
        uid = next(line.split()[1] for line in handle if line.startswith("Uid:"))
    if uid != output("id", "-u", "tilecast-airplay").strip():
        fail(f"uxplay runs as uid {uid}")
    for cmdline in all_cmdlines():
        if PIN.encode() in cmdline or DEVICE_ID.encode() in cmdline or b"82:64" in cmdline:
            fail(f"a secret is in a process argument: {cmdline!r}")
    if os.path.exists(os.path.join(SESSION_DIR, "session.rc")):
        fail("the -rc file is still on disk after UxPlay read it")
    stat = os.stat(SESSION_DIR)
    if stat.st_mode & 0o777 != 0o700:
        fail(f"the session directory mode is {oct(stat.st_mode)}")
    with open(os.path.join(SESSION_DIR, "fake-uxplay.json")) as handle:
        record = json.load(handle)
    if record["rcMode"] != "0o600" or record["rcOptions"] != ["n", "nh", "pin", "m"]:
        fail(f"rc file: {record}")
    with open(os.path.join(SESSION_DIR, "fake-uxplay.cmd"), "w") as handle:
        handle.write("mirroring\n")
    wait(lambda: any('"client_connected"' in line for line in events("session.jsonl")), "client_connected")

    step("SIGKILL of the supervisor leaves no uxplay process")
    run("systemctl", "kill", "--signal=SIGKILL", "--kill-whom=main", "tilecast-airplay.service")
    wait(lambda: not uxplay_pids(), "uxplay to be gone", seconds=20)
    wait(lambda: not unit_active("tilecast-airplay.service"), "the unit to stop")
    wait(lambda: "EOF" in events("session.jsonl"), "the daemon's connection to close")
    if not unit_active("tilecast-airplay.socket"):
        fail("the socket did not stay active")

    step("the socket starts a new supervisor after the kill")
    as_unit("tilecast-edge.service", "tilecast", "probe", "probe-after.jsonl")
    if json.loads(events("probe-after.jsonl")[0]).get("type") != "probe_result":
        fail(f"probe after kill: {events('probe-after.jsonl')}")


def no_secret_in_logs():
    step("no secret in the journal")
    run("journalctl", "--sync")
    journal = output("journalctl", "-b", "--no-pager", "-o", "cat")
    # Digits only as a whole number: the PIN also occurs inside timestamps.
    for secret in (PIN, DEVICE_ID, "82:64"):
        pattern = re.compile(r"(?<![0-9.])" + re.escape(secret) + r"(?![0-9])")
        line = next((line for line in journal.splitlines() if pattern.search(line)), None)
        if line is not None:
            fail(f"{secret} is in the journal: {line}")
    supervisor = output("journalctl", "-b", "--no-pager", "-o", "cat", "-u", "tilecast-airplay.service")
    for event in ("advertising", "client_connected", "peer_refused"):
        if event not in supervisor:
            fail(f"the supervisor did not log {event}")


def report():
    step("unit exposure (informational)")
    subprocess.run(["systemd-analyze", "security", "--no-pager", "tilecast-airplay.service"])


def main():
    setup()
    refusals()
    probe()
    session_and_sigkill()
    no_secret_in_logs()
    report()
    print("airplay e2e: ok", flush=True)


if __name__ == "__main__":
    main()
