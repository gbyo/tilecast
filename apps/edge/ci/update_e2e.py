#!/usr/bin/env python3
"""M10 update integration test, run inside the systemd container after the M7
migration phases (migrate_e2e.py) have left Edge 0.1.0 accepted, paired to a
real Tilecast Server and playing.

run-migrate-e2e.sh drives the phases in order. Everything is real: systemd as
PID 1, the packaged tilecast-edge-update socket and service, the guard units
the helper writes, the release layout under /opt/tilecast-edge, tilecastd's
update coordinator, and the server's Player Updates deployments.

  update-releases     build and sign releases 0.2.0 and 0.3.0 (healthy) and
                      0.4.0 (a deliberately broken daemon and helper), upload
                      them through the ordinary release upload, and check that
                      the server refuses a tampered envelope
  update-success      A: 0.1.0 -> 0.2.0. The download is throttled and the
                      daemon is killed half way, so it resumes; the candidate
                      is staged, activated, runs provisionally, confirms after
                      its stable period, and the server target succeeds
  update-provisional  B: 0.2.0 -> 0.3.0, up to a healthy but unconfirmed
                      candidate; the driver then kills the container
  update-after-reboot B: the boot guard rolled the candidate back to 0.2.0
                      before it could start again, and the server target failed
  update-broken       C: 0.2.0 -> 0.4.0, whose daemon cannot start and whose
                      helper cannot run; the previous release's guard rolls
                      back and nothing activates the candidate again

Each scenario starts from the release the one before left current, because an
installed release is never replaced by an older one: A leaves 0.2.0 current,
so B and C roll back to 0.2.0, a release that was itself installed by an
update rather than by the migrator.
"""
import base64
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_server as e2e  # noqa: E402
import migrate_e2e as m  # noqa: E402

EDGE = e2e.EDGE
WORK = m.WORK
RELEASES = os.path.join(WORK, "update-releases")
INSTALL = "/opt/tilecast-edge"
STATE = "/var/lib/tilecast-edge-update"
SOCKET = "/run/tilecast-edge-update/update.sock"
GUARD_SERVICE = "/etc/systemd/system/tilecast-edge-update-guard.service"
GUARD_TIMER = "/etc/systemd/system/tilecast-edge-update-guard.timer"
EDGE_UNITS = ("tilecast-edge.service", "tilecast-renderer.service")
ARCH = os.uname().machine
# CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_DAC_READ_SEARCH, CAP_FOWNER, CAP_FSETID.
HELPER_CAPABILITIES = "000000000000001f"
BROKEN = "#!/bin/sh\necho 'e2e: deliberately broken Tilecast Edge candidate' >&2\nexit 70\n"


# ---- helpers -----------------------------------------------------------------


def output(*argv):
    return m.output(*argv)


def journal(*argv):
    text = output("journalctl", "--no-pager", "-o", "json", *argv)
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def boot_monotonic_usec():
    """Journal entries after this systemd instance started. A container
    restart keeps the host's boot ID, so a boot filter is not enough."""
    return int(output("systemctl", "show", "--property=UserspaceTimestampMonotonic", "--value").strip())


def now_usec():
    return int(time.time() * 1_000_000)


def show(unit, *properties):
    text = output("systemctl", "show", "--property=" + ",".join(properties), unit)
    return dict(line.split("=", 1) for line in text.splitlines() if "=" in line)


def main_pid(unit):
    return int(show(unit, "MainPID")["MainPID"])


def exe(pid):
    return os.readlink(f"/proc/{pid}/exe")


def proc_status(pid):
    with open(f"/proc/{pid}/status") as handle:
        return dict(line.rstrip("\n").split(":\t", 1) for line in handle if ":\t" in line)


def daemon_status():
    try:
        return json.loads(output(f"{INSTALL}/current/bin/tilecastctl", "--json", "status"))
    except (subprocess.CalledProcessError, ValueError):
        return None


def read_json(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def open_transaction():
    return read_json(f"{STATE}/transaction.json")


def finished_transaction():
    return read_json(f"{STATE}/previous.json")


def current():
    return os.readlink(f"{INSTALL}/current")


def mode_of(path):
    info = os.stat(path, follow_symlinks=False)
    return info.st_uid, info.st_gid, oct(info.st_mode & 0o7777)


def server_target(deployment):
    row = e2e.psql(f"SELECT state||'|'||COALESCE(installer_status,'')||'|'||COALESCE(safe_error,'') "
                   f"FROM screen_update_states WHERE deployment_id='{deployment}'")
    return tuple(row.split("|")) if row else None


def owner():
    client = e2e.Client()
    login = client.call("POST", "/api/v1/auth/login", {"username": "owner",
                        "password": "correct horse battery staple"}, expect=200)[1]["data"]
    client.csrf = login.get("csrfToken")
    return client


def upload(client, files, expect):
    """The ordinary Player release upload (multipart), as Studio sends it."""
    boundary = uuid.uuid4().hex
    body = b""
    for name, path, content_type in files:
        with open(path, "rb") as handle:
            data = handle.read()
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{name}\"\r\n"
                 f"Content-Type: {content_type}\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    request = urllib.request.Request(e2e.BASE + "/api/v1/player-releases/upload", data=body, method="POST")
    request.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    request.add_header("X-CSRF-Token", client.csrf)
    try:
        with client.opener.open(request, timeout=300) as response:
            status, payload = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, payload = error.code, error.read()
    assert status == expect, f"release upload: {status} {payload[:400]!r}"
    return json.loads(payload)


def deploy(client, release, name):
    screen = m.load("screen.json")["screenId"]
    created = client.call("POST", "/api/v1/update-deployments", {
        "releaseId": release, "name": name, "mode": "install_now", "screenIds": [screen]}, expect=201)[1]["data"]
    assert created["targetCount"] == 1, created
    return created["id"]


def units_match(version):
    """The installed units and system files are the ones `version` carries."""
    release = f"{INSTALL}/{version}/packaging"
    pairs = [(f"{release}/systemd/{unit}", f"/etc/systemd/system/{unit}")
             for unit in ("tilecast-edge.service", "tilecast-renderer.service", "tilecast-edge-update.service",
                          "tilecast-edge-update.socket")]
    pairs += [(f"{release}/tmpfiles.d/tilecast-edge.conf", "/usr/lib/tmpfiles.d/tilecast-edge.conf"),
              (f"{release}/sysusers.d/tilecast-edge.conf", "/usr/lib/sysusers.d/tilecast-edge.conf")]
    for source, installed in pairs:
        with open(source, "rb") as a, open(installed, "rb") as b:
            if a.read() != b.read():
                return f"{installed} differs from {source}"
    return None


def assert_running(version, context):
    """Exactly one Edge stack runs, from the immutable version directory."""
    for unit, binary in (("tilecast-edge.service", "tilecastd"), ("tilecast-renderer.service", "tilecast-renderer-wpe")):
        assert show(unit, "ActiveState")["ActiveState"] == "active", f"{context}: {unit} is not active"
        path = exe(main_pid(unit))
        assert path == f"{INSTALL}/{version}/bin/{binary}", f"{context}: {unit} runs {path}"
    daemons = output("pgrep", "-x", "tilecastd").split()
    assert len(daemons) == 1, f"{context}: {len(daemons)} tilecastd processes"
    assert current() == version, f"{context}: current is {current()}"
    problem = units_match(version)
    assert problem is None, f"{context}: {problem}"


def wait_healthy(version, context, timeout=180):
    def healthy():
        status = daemon_status()
        if not status or status.get("daemonVersion") != version or status["link"]["state"] != "connected":
            return None
        presentation = status.get("presentation") or {}
        return status if presentation.get("accepted") and presentation.get("evidence") else None

    status = e2e.wait_for(healthy, f"{context}: {version} connected and playing", timeout)
    assert_running(version, context)
    return status


def assert_migration_untouched(context):
    """An update never uses the migration's rollback: the accepted attempt,
    the disabled legacy player and the recovery unit are as M7 left them."""
    before = m.load("migration-accepted.json")
    state = m.attempt()
    assert state["attemptId"] == before["attemptId"] and state["phase"] == "accepted", f"{context}: {state['phase']}"
    assert m.legacy_state() == ("disabled", "inactive"), f"{context}: legacy {m.legacy_state()}"
    assert m.unit_state("tilecast-edge-migrate-recover.service")[0] == "disabled", context
    assert not os.path.exists("/run/tilecast-edge-migrate/probation"), context
    for unit in EDGE_UNITS:
        assert not os.path.lexists(f"{m.DROPINS}/{unit}.requires/tilecast-edge-migrate-recover.service"), context


def assert_state_files(context):
    """The root transaction record: root-owned, private, no secrets."""
    assert mode_of(STATE) == (0, 0, "0o700"), f"{context}: {STATE} {mode_of(STATE)}"
    for name in ("transaction.json", "previous.json"):
        path = f"{STATE}/{name}"
        if os.path.exists(path):
            assert mode_of(path) == (0, 0, "0o600"), f"{context}: {path} {mode_of(path)}"
            with open(path) as handle:
                text = handle.read()
            assert "tc_device_" not in text and "deviceCredential" not in text, f"{context}: {name} holds a secret"
            assert "http://" not in text and "https://" not in text, f"{context}: {name} holds a server address"


def assert_guard_armed(previous, context):
    """The guard runs the previous release's helper, before Edge at boot."""
    with open(GUARD_SERVICE) as handle:
        text = handle.read()
    assert f"ExecStart={INSTALL}/{previous}/bin/tilecast-edge-update guard\n" in text, text
    assert "/current/" not in text, f"{context}: the guard must not run the candidate's helper"
    props = show("tilecast-edge-update-guard.service", "Before", "UnitFileState", "ProtectSystem",
                 "CapabilityBoundingSet", "RestrictAddressFamilies")
    before = props["Before"].split()
    assert "tilecast-edge.service" in before and "tilecast-renderer.service" in before, f"{context}: {props}"
    assert props["UnitFileState"] == "enabled", f"{context}: the guard runs at boot: {props}"
    assert props["ProtectSystem"] == "strict" and props["RestrictAddressFamilies"] == "AF_UNIX", props
    timer = show("tilecast-edge-update-guard.timer", "ActiveState", "UnitFileState")
    assert timer == {"ActiveState": "active", "UnitFileState": "enabled"}, f"{context}: {timer}"


def assert_guard_disarmed(context):
    for path in (GUARD_SERVICE, GUARD_TIMER):
        assert not os.path.exists(path), f"{context}: {path} remains"
    timer = show("tilecast-edge-update-guard.timer", "ActiveState")["ActiveState"]
    assert timer == "inactive", f"{context}: guard timer {timer}"


def helper_request(request, user=None):
    """Sends one request on the helper socket from a transient unit that is
    not tilecast-edge.service, as the renderer or another root process would."""
    code = ("import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); "
            "s.sendall(sys.argv[2].encode()+b'\\n'); print(s.makefile().readline().strip())")
    argv = ["systemd-run", "--wait", "--pipe", "--quiet", "--collect"]
    if user:
        argv += [f"--uid={user}"]
    result = subprocess.run(argv + ["/usr/bin/python3", "-c", code, SOCKET, json.dumps(request)],
                            capture_output=True, text=True, timeout=60)
    return json.loads(result.stdout.strip() or "{}")


def assert_helper_boundary(context):
    """The socket, the peer policy and the running helper's sandbox, on a
    real systemd: what the threat review claims."""
    uid, gid, mode = mode_of(SOCKET)
    assert (uid, gid, mode) == (0, os.stat("/var/lib/tilecast-edge").st_gid, "0o660"), (uid, gid, mode)
    assert mode_of(os.path.dirname(SOCKET))[2] == "0o755"
    for user in ("tilecast", None):
        answer = helper_request({"op": "status"}, user)
        assert answer == {"ok": False, "code": "peer_not_allowed"}, f"{context}: {user or 'root'}: {answer}"
    socket_props = show("tilecast-edge-update.socket", "ActiveState", "UnitFileState")
    assert socket_props == {"ActiveState": "active", "UnitFileState": "enabled"}, socket_props

    pid = main_pid("tilecast-edge-update.service")
    assert pid, f"{context}: the helper is not running"
    status = proc_status(pid)
    assert status["Uid"].split() == ["0"] * 4, f"{context}: helper Uid {status['Uid']}"
    assert status["NoNewPrivs"] == "1" and status["Seccomp"] == "2", f"{context}: {status['NoNewPrivs']} {status['Seccomp']}"
    assert status["CapBnd"] == HELPER_CAPABILITIES, f"{context}: bounding set {status['CapBnd']}"
    assert int(status["CapEff"], 16) & ~int(HELPER_CAPABILITIES, 16) == 0, f"{context}: effective {status['CapEff']}"
    with open(f"/proc/{pid}/environ", "rb") as handle:
        environment = handle.read()
    assert b"tc_device_" not in environment and b"TILECAST" not in environment, f"{context}: helper environment"
    # No descriptor reaches tilecastd's state or identity, and every socket
    # is a Unix socket: the helper has no network.
    unix = {line.split()[6] for line in open("/proc/net/unix").read().splitlines()[1:] if len(line.split()) > 6}
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            target = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        assert not target.startswith("/var/lib/tilecast-edge/"), f"{context}: helper holds {target}"
        if target.startswith("socket:["):
            assert target[8:-1] in unix, f"{context}: helper holds a non-Unix socket {target}"
    props = show("tilecast-edge-update.service", "ProtectSystem", "RestrictAddressFamilies", "IPAddressDeny",
                 "NoNewPrivileges", "PrivateDevices", "ProtectHome", "ReadWritePaths")
    assert props["ProtectSystem"] == "strict" and props["RestrictAddressFamilies"] == "AF_UNIX", props
    assert props["NoNewPrivileges"] == "yes" and props["PrivateDevices"] == "yes", props
    assert props["ProtectHome"] == "yes" and "0.0.0.0/0" in props["IPAddressDeny"], props
    # /usr outside the four Edge configuration directories is read-only.
    probe = subprocess.run(["nsenter", "-t", str(pid), "-m", "touch", "/usr/bin/tilecast-e2e-probe"],
                           capture_output=True, text=True)
    assert probe.returncode != 0 and "Read-only" in probe.stderr, f"{context}: /usr is writable: {probe.stderr}"
    # Root as it is, the helper cannot even list the credential's directory.
    hidden = subprocess.run(["nsenter", "-t", str(pid), "-m", "ls", "/var/lib/tilecast-edge/identity"],
                            capture_output=True, text=True)
    assert hidden.returncode != 0, f"{context}: the helper can read the identity directory: {hidden.stdout}"
    assert os.listdir("/var/lib/tilecast-edge/identity"), "the credential exists outside the helper's namespace"
    print(f"{context}: helper pid {pid} runs as root with bounding set {status['CapBnd']}, NoNewPrivs, seccomp, "
          "Unix sockets only; the socket refuses root and the tilecast account outside tilecastd's unit")


def own_entries(unit, *argv):
    """What the unit's own processes logged, without PID 1's messages about it."""
    return [e for e in journal("-u", unit, *argv) if e.get("_SYSTEMD_UNIT") == unit]


def assert_switch_order(since_usec, version, helper_unit, context, candidate_was_running=True):
    """The renderer and then the daemon stopped before `current` moved to
    `version` (WPE finds its helper processes under current/lib/wpe), and the
    daemon started again before the renderer."""
    def job_done(unit, kind):
        return [int(e["__REALTIME_TIMESTAMP"]) for e in journal("-u", unit, f"--since=@{since_usec // 1_000_000}")
                if e.get("JOB_TYPE") == kind and e.get("JOB_RESULT") == "done"
                and int(e["__REALTIME_TIMESTAMP"]) >= since_usec]

    switched = [int(e["__REALTIME_TIMESTAMP"]) for e in own_entries(helper_unit, f"--since=@{since_usec // 1_000_000}")
                if '"current_switched"' in str(e.get("MESSAGE", "")) and f'"{version}"' in str(e.get("MESSAGE", ""))]
    assert switched, f"{context}: {helper_unit} logged no switch to {version}"
    switch = switched[0]
    renderer_stop = [t for t in job_done("tilecast-renderer.service", "stop") if t < switch]
    daemon_stop = [t for t in job_done("tilecast-edge.service", "stop") if t < switch]
    # A unit that systemd already gave up on has nothing left to stop.
    if candidate_was_running:
        assert renderer_stop and daemon_stop, f"{context}: the Edge units were not stopped before the switch"
    if renderer_stop and daemon_stop:
        assert renderer_stop[-1] <= daemon_stop[-1], f"{context}: the renderer stops first"
    daemon_start = [t for t in job_done("tilecast-edge.service", "start") if t > switch]
    renderer_start = [t for t in job_done("tilecast-renderer.service", "start") if t > switch]
    assert daemon_start and renderer_start, f"{context}: the candidate did not start after the switch"
    assert daemon_start[0] <= renderer_start[0], f"{context}: the daemon starts before the renderer"


def artifact_of(version):
    return m.load("update-releases.json")[version]


# ---- releases ------------------------------------------------------------------


def stage_tree(version, bin_dir, out):
    run = m.run
    sbom = os.path.join(WORK, "sbom.cdx.json")
    wpe = output("pkg-config", "--modversion", "wpe-webkit-2.0").strip()
    run(os.path.join(EDGE, "release", "stage-release.py"), "--out", out, "--version", version,
        "--bin-dir", bin_dir, "--renderer", os.path.join(m.RENDERER_BUILD, "tilecast-renderer-wpe"),
        "--session-bridge", os.path.join(m.BRIDGE_BUILD, "tilecast-session-bridge"),
        "--gst-plugin-dir", os.path.join(m.RENDERER_BUILD, "gstreamer-1.0"), "--runtime-dir", m.RUNTIME,
        "--sbom", sbom, "--wpe-version", wpe, "--base-distribution", "debian-sid-ci", stdout=subprocess.DEVNULL)
    # A marker in the daemon's unit, so the test can tell whose system files
    # are installed. The manifest entry follows it.
    unit = "packaging/systemd/tilecast-edge.service"
    with open(os.path.join(out, unit), "a") as handle:
        handle.write(f"# e2e: installed by Tilecast Edge {version}\n")
    manifest_path = os.path.join(out, "tilecast-edge-release.json")
    with open(manifest_path) as handle:
        manifest = json.load(handle)
    with open(os.path.join(out, unit), "rb") as handle:
        data = handle.read()
    for entry in manifest["files"]:
        if entry["path"] == unit:
            entry["sha256"], entry["size"] = hashlib.sha256(data).hexdigest(), len(data)
    with open(manifest_path, "w") as handle:
        json.dump(manifest, handle, indent=2, sort_keys=True)
        handle.write("\n")
    sign(manifest_path)


def sign(path):
    signature = subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", os.path.join(WORK, "release-key.pem"),
                                "-in", path], check=True, capture_output=True).stdout
    with open(path + ".sig", "w") as handle:
        handle.write(base64.b64encode(signature).decode())


def package(version, tree):
    """The archive and signed envelope, as build-edge-release.sh makes them."""
    archive = os.path.join(RELEASES, version, f"tilecast-edge-{version}-{ARCH}.tar.zst")
    subprocess.run(f"tar --sort=name --numeric-owner --owner=0 --group=0 -C '{tree}' -cf - . | zstd -3 -q -o '{archive}'",
                   shell=True, check=True)
    schema = max(int(os.path.basename(p).split("_", 1)[0])
                 for p in glob.glob(os.path.join(EDGE, "crates/edge-state/migrations/[0-9][0-9][0-9][0-9]_*.sql")))
    envelope = os.path.join(RELEASES, version, "tilecast-edge-update.json")
    m.run("python3", os.path.join(EDGE, "release", "envelope.py"), "--tree", tree, "--archive", archive,
          "--arch", ARCH, "--state-schema", str(schema), "--out", envelope, stdout=subprocess.DEVNULL)
    sign(envelope)
    with open(archive, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    return archive, envelope, digest


def update_releases():
    environment = m.env()
    built = {}
    for version, broken in (("0.2.0", False), ("0.3.0", False), ("0.4.0", True)):
        bin_dir = os.path.join(RELEASES, version, "bin")
        os.makedirs(bin_dir, exist_ok=True)
        if not broken:
            # The daemon reports the version it was built as.
            m.run("cargo", "build", "-q", "--locked", "-p", "tilecastd", "-p", "tilecastctl", "-p",
                  "tilecast-edge-update", cwd=EDGE, env=dict(environment, TILECAST_EDGE_VERSION=version))
        for name in ("tilecastd", "tilecastctl", "tilecast-edge-migrate", "tilecast-edge-update"):
            shutil.copyfile(os.path.join(m.TARGET, "debug", name), os.path.join(bin_dir, name))
        if broken:
            # Test-only fixture: a daemon that exits at once, and a helper that
            # cannot run. The previous release's guard must roll it back.
            for name in ("tilecastd", "tilecast-edge-update"):
                with open(os.path.join(bin_dir, name), "w") as handle:
                    handle.write(BROKEN)
        for name in os.listdir(bin_dir):
            os.chmod(os.path.join(bin_dir, name), 0o755)
        tree = os.path.join(RELEASES, version, "tree")
        stage_tree(version, bin_dir, tree)
        archive, envelope, digest = package(version, tree)
        built[version] = {"archive": archive, "envelope": envelope, "sha256": digest,
                          "size": os.path.getsize(archive)}

    client = owner()
    # A tampered envelope is refused before anything is imported.
    tampered = os.path.join(RELEASES, "tampered-envelope.json")
    with open(built["0.2.0"]["envelope"]) as handle:
        text = handle.read()
    with open(tampered, "w") as handle:
        handle.write(text.replace('"channel": "stable"', '"channel": "beta"'))
    shutil.copyfile(built["0.2.0"]["envelope"] + ".sig", tampered + ".sig")
    refusal = os.path.join(RELEASES, "refusal")
    os.makedirs(refusal, exist_ok=True)
    shutil.copyfile(tampered, os.path.join(refusal, "tilecast-edge-update.json"))
    shutil.copyfile(tampered + ".sig", os.path.join(refusal, "tilecast-edge-update.json.sig"))
    refused = upload(client, [
        (os.path.basename(built["0.2.0"]["archive"]), built["0.2.0"]["archive"], "application/zstd"),
        ("tilecast-edge-update.json", os.path.join(refusal, "tilecast-edge-update.json"), "application/json"),
        ("tilecast-edge-update.json.sig", os.path.join(refusal, "tilecast-edge-update.json.sig"), "text/plain"),
    ], expect=422)
    assert refused["error"]["code"] == "player_release_verification_failed", refused

    for version, release in built.items():
        created = upload(client, [
            (os.path.basename(release["archive"]), release["archive"], "application/zstd"),
            ("tilecast-edge-update.json", release["envelope"], "application/json"),
            ("tilecast-edge-update.json.sig", release["envelope"] + ".sig", "text/plain"),
        ], expect=201)["data"]
        assert (created["playerFamily"], created["architecture"], created["versionName"]) == ("edge", ARCH, version)
        release["releaseId"] = created["id"]
    m.save("update-releases.json", built)
    # The migration state an update must leave alone.
    m.save("migration-accepted.json", m.attempt())
    print("update-releases: 0.2.0, 0.3.0 and 0.4.0 (broken) signed and imported; a tampered envelope was refused")


# ---- A: a successful update ------------------------------------------------------


def update_success():
    screen = m.load("screen.json")["screenId"]
    e2e.wait_for(lambda: e2e.psql(f"SELECT player_family||'/'||player_architecture FROM screen_player_status "
                                  f"WHERE screen_id='{screen}'") == f"edge/{ARCH}",
                 "the screen to report the edge family and its architecture", 120)
    wait_healthy("0.1.0", "before A")
    release = artifact_of("0.2.0")
    partial = f"/var/lib/tilecast-edge/partial/{release['sha256']}.part"
    fanout = release["sha256"][:2]
    stored = f"/var/lib/tilecast-edge/cas/sha256/{fanout}/{release['sha256']}"
    started_usec = now_usec()
    restarts_before = int(show("tilecast-edge.service", "NRestarts")["NRestarts"])

    # A slow link, so the download can be interrupted half way.
    m.run("tc", "qdisc", "add", "dev", "lo", "root", "tbf", "rate", "40mbit", "burst", "256kb", "latency", "2s")
    try:
        deployment = deploy(owner(), release["releaseId"], "E2E update to 0.2.0")

        def half_way():
            try:
                return os.path.getsize(partial) >= release["size"] // 3
            except OSError:
                return False

        e2e.wait_for(half_way, "a third of the 0.2.0 archive downloaded", 300)
        m.run("systemctl", "kill", "--signal=SIGKILL", "tilecast-edge.service")
        kept = os.path.getsize(partial)
        print(f"update-success: killed tilecastd with {kept} of {release['size']} bytes downloaded")
        e2e.wait_for(lambda: int(show("tilecast-edge.service", "NRestarts")["NRestarts"]) > restarts_before,
                     "systemd to restart the daemon", 60)
        e2e.wait_for(lambda: os.path.exists(stored), "the resumed download to complete", 600)
    finally:
        subprocess.run(["tc", "qdisc", "del", "dev", "lo", "root"], check=False)
    ranged = [e for e in journal("-u", "e2e-server.service", f"--since=@{started_usec // 1_000_000}")
              if f"/api/v1/player/updates/{release['releaseId']}/artifact" in str(e.get("MESSAGE", ""))]
    statuses = [json.loads(e["MESSAGE"]).get("status") for e in ranged if str(e.get("MESSAGE", "")).startswith("{")]
    assert 206 in statuses, f"the restarted daemon resumed with a range request: {statuses}"
    assert os.stat(stored).st_uid == os.stat("/var/lib/tilecast-edge").st_uid, "the content store owns the object"
    assert not os.path.exists(partial), "the partial became the verified object"

    # Staged without activation first: the version directory appears, and
    # the helper's transaction opens only for the activation.
    e2e.wait_for(lambda: os.path.isdir(f"{INSTALL}/0.2.0"), "0.2.0 staged", 300)
    e2e.wait_for(lambda: (open_transaction() or {}).get("phase") == "provisional", "0.2.0 provisional", 300)
    transaction = open_transaction()
    assert (transaction["candidate"]["versionName"], transaction["previous"]["versionName"]) == ("0.2.0", "0.1.0")
    assert_guard_armed("0.1.0", "A provisional")
    assert_state_files("A provisional")
    status = wait_healthy("0.2.0", "A provisional", 240)
    assert status["update"]["state"] in ("provisional", "confirmed"), status["update"]
    assert_helper_boundary("A provisional")
    target = server_target(deployment)
    assert target[0] in ("reconnecting", "succeeded"), f"the server sees the candidate: {target}"
    # Not confirmed by the version appearing: the stable period comes first.
    provisional_since = time.monotonic()

    e2e.wait_for(lambda: server_target(deployment)[0] == "succeeded", "the explicit confirmation", 420)
    confirmed_after = time.monotonic() - provisional_since
    assert server_target(deployment) == ("succeeded", "confirmed", ""), server_target(deployment)
    assert e2e.psql(f"SELECT status FROM update_deployments WHERE id='{deployment}'") == "completed"
    finished = finished_transaction()
    assert finished["phase"] == "confirmed" and open_transaction() is None, finished
    assert_guard_disarmed("A confirmed")
    assert_state_files("A confirmed")
    status = wait_healthy("0.2.0", "A confirmed")
    assert status["update"]["state"] == "confirmed", status["update"]
    # The previous release is kept as the rollback generation.
    assert os.path.isdir(f"{INSTALL}/0.1.0"), "0.1.0 is retained"
    helper = json.loads(output(f"{INSTALL}/current/bin/tilecast-edge-update", "status"))
    assert {"0.1.0", "0.2.0"} <= set(helper["installed"]) and helper["current"]["versionName"] == "0.2.0", helper
    assert_switch_order(started_usec, "0.2.0", "tilecast-edge-update.service", "A")
    assert_migration_untouched("A")
    events = [e["detail"] for e in finished["events"]]
    print(f"update-success: 0.2.0 confirmed about {confirmed_after:.0f} s after the test first saw it provisional; "
          f"transaction events: {events}")


# ---- B: power loss while provisional --------------------------------------------


def update_provisional():
    wait_healthy("0.2.0", "before B")
    release = artifact_of("0.3.0")
    deployment = deploy(owner(), release["releaseId"], "E2E update to 0.3.0, power loss")
    m.save("deployment-b.json", {"id": deployment})
    e2e.wait_for(lambda: (open_transaction() or {}).get("phase") == "provisional", "0.3.0 provisional", 600)
    assert_guard_armed("0.2.0", "B provisional")
    assert_state_files("B provisional")
    # Healthy: running, reconnected and playing, but not yet confirmed.
    wait_healthy("0.3.0", "B provisional", 180)
    e2e.wait_for(lambda: server_target(deployment)[0] == "reconnecting", "the server to see the candidate", 120)
    assert open_transaction()["phase"] == "provisional", "B must be cut before the stable period ends"
    print("update-provisional: 0.3.0 is healthy and provisional; the driver now cuts the power")


def update_after_reboot():
    booted = boot_monotonic_usec()
    m.start_server()
    e2e.wait_for(lambda: (finished_transaction() or {}).get("candidate", {}).get("versionName") == "0.3.0"
                 and finished_transaction()["phase"] == "rolled_back", "the boot guard's rollback", 240)
    finished = finished_transaction()
    assert finished["reason"] == "rebooted_while_provisional", finished["reason"]
    assert open_transaction() is None
    assert_guard_disarmed("B after reboot")
    assert_state_files("B after reboot")
    wait_healthy("0.2.0", "B after reboot", 240)

    def this_boot(unit):
        return [e for e in journal("-u", unit) if int(e["__MONOTONIC_TIMESTAMP"]) > booted]

    guard = this_boot("tilecast-edge-update-guard.service")
    helpers = {e.get("_EXE") for e in guard if e.get("_SYSTEMD_UNIT") == "tilecast-edge-update-guard.service"}
    assert helpers == {f"{INSTALL}/0.2.0/bin/tilecast-edge-update"}, f"the previous release's helper ran: {helpers}"
    guard_done = [int(e["__MONOTONIC_TIMESTAMP"]) for e in guard if e.get("JOB_TYPE") == "start"]
    daemon = this_boot("tilecast-edge.service")
    daemon_starts = [int(e["__MONOTONIC_TIMESTAMP"]) for e in daemon if e.get("JOB_TYPE") == "start"
                     and e.get("JOB_RESULT") == "done"]
    assert guard_done and daemon_starts and guard_done[0] < daemon_starts[0], "the guard finished before Edge started"
    candidates = {e.get("_EXE") for e in daemon if f"{INSTALL}/0.3.0/" in str(e.get("_EXE", ""))}
    assert not candidates, f"the unconfirmed candidate never ran in this boot: {candidates}"

    deployment = m.load("deployment-b.json")["id"]
    e2e.wait_for(lambda: server_target(deployment)[0] == "failed", "the server to see the rollback", 180)
    assert server_target(deployment) == ("failed", "rolled_back", "rebooted_while_provisional"), server_target(deployment)
    assert_no_loop("0.2.0", "0.3.0", "B")
    assert_migration_untouched("B")
    print("update-after-reboot: the boot guard (0.2.0's helper) rolled 0.3.0 back before Edge started; "
          "the server target failed with rebooted_while_provisional")


def assert_no_loop(version, candidate, context):
    """Nothing activates the candidate again: the job and the deployment
    target are terminal and the guard is gone."""
    deadline = time.time() + 75
    while time.time() < deadline:
        assert current() == version, f"{context}: current moved to {current()}"
        assert open_transaction() is None, f"{context}: a transaction opened again"
        time.sleep(3)
    status = daemon_status()
    assert status["update"]["state"] == "rolled_back", f"{context}: {status['update']}"
    assert_guard_disarmed(context)
    assert_running(version, context)
    assert os.path.isdir(f"{INSTALL}/{candidate}"), f"{context}: the candidate stays installed until a confirmation"


# ---- C: a broken candidate -----------------------------------------------------------


def update_broken():
    wait_healthy("0.2.0", "before C")
    release = artifact_of("0.4.0")
    deployment = deploy(owner(), release["releaseId"], "E2E broken update to 0.4.0")
    e2e.wait_for(lambda: (open_transaction() or {}).get("candidate", {}).get("versionName") == "0.4.0"
                 and open_transaction()["phase"] == "provisional", "0.4.0 provisional", 600)
    activated_usec = now_usec()
    assert_guard_armed("0.2.0", "C provisional")
    assert current() == "0.4.0"

    def rolled_back():
        done = finished_transaction()
        return done if done and done["candidate"]["versionName"] == "0.4.0" and done["phase"] == "rolled_back" else None

    finished = e2e.wait_for(rolled_back, "the guard to roll 0.4.0 back", 720)
    assert finished["reason"] in ("candidate_daemon_restarting", "candidate_daemon_failed"), finished["reason"]
    rollback_usec = now_usec()
    guard = own_entries("tilecast-edge-update-guard.service", f"--since=@{activated_usec // 1_000_000}")
    assert {e.get("_EXE") for e in guard} == {f"{INSTALL}/0.2.0/bin/tilecast-edge-update"}, {e.get("_EXE") for e in guard}
    assert any("RollbackIntent" in str(e.get("MESSAGE", "")) for e in guard), "the guard itself rolled back"
    wait_healthy("0.2.0", "C after rollback", 240)
    assert_switch_order(activated_usec, "0.2.0", "tilecast-edge-update-guard.service", "C rollback",
                        candidate_was_running=False)
    assert_state_files("C after rollback")
    e2e.wait_for(lambda: server_target(deployment)[0] == "failed", "the server to see the rollback", 180)
    assert server_target(deployment) == ("failed", "rolled_back", finished["reason"]), server_target(deployment)
    assert_no_loop("0.2.0", "0.4.0", "C")
    attempts = [e for e in journal("-u", "tilecast-edge.service", f"--since=@{rollback_usec // 1_000_000}")
                if "deliberately broken" in str(e.get("MESSAGE", ""))
                and int(e["__REALTIME_TIMESTAMP"]) > rollback_usec]
    assert not attempts, f"C: the broken candidate ran again {len(attempts)} times"
    assert_migration_untouched("C")
    print(f"update-broken: 0.4.0 could not start and its helper could not run; 0.2.0's guard rolled it back "
          f"({finished['reason']}) and nothing activated it again")


PHASES = {"update-releases": update_releases, "update-success": update_success,
          "update-provisional": update_provisional, "update-after-reboot": update_after_reboot,
          "update-broken": update_broken}

if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    PHASES[sys.argv[1]]()
