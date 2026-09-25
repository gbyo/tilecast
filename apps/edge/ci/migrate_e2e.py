#!/usr/bin/env python3
"""M7 migration integration test, run inside the systemd container.

run-migrate-e2e.sh drives the phases in order. Each phase runs as root in a
container whose PID 1 is systemd, with a real Tilecast Server, a lingering
kiosk account and a legacy player user unit, so tilecast-edge-migrate works
against real units, a real user manager and real files:

  setup           build Edge, stage and sign a release with a throwaway key,
                  install it, start a real server, pair a legacy player for
                  the kiosk account and start its user unit
  import-failure  the server is down, so the import's identity check fails:
                  the migration rolls back and the legacy player runs again
  crash           a crash injected right after Edge was enabled: the
                  service's own recovery rolls back
  start-settling  start a migration and return while it settles; the driver
                  then kills the container (a power loss)
  after-reboot    the boot recovery rolled the interrupted settlement back
  accept          a full migration is accepted; the rollback window has ended
"""
import base64
import hashlib
import json
import os
import pwd
import shutil
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import e2e_server as e2e  # noqa: E402

EDGE = e2e.EDGE
WORK = "/var/lib/e2e"
RELEASE = os.path.join(WORK, "release")
KIOSK = "kiosk"
LEGACY_DIR = f"/home/{KIOSK}/.local/share/tilecast-player"
MIGRATE = "/opt/tilecast-edge/current/bin/tilecast-edge-migrate"
TARGET = "/target/cargo-qual"
RENDERER_BUILD = "/target/renderer"
BRIDGE_BUILD = "/target/bridge"
RUNTIME = "/target/runtime"
DROPINS = "/etc/systemd/system"


def run(*argv, check=True, **kwargs):
    return subprocess.run(argv, check=check, **kwargs)


def output(*argv):
    return subprocess.run(argv, check=True, capture_output=True, text=True).stdout


def env():
    return dict(os.environ, CARGO_TARGET_DIR=TARGET, CARGO_HOME="/target/cargo-home", CARGO_PROFILE_DEV_DEBUG="0",
                CARGO_INCREMENTAL="0", GOTOOLCHAIN="auto", GOPATH="/target/go", GOCACHE="/target/go-cache",
                PATH="/target/cargo-home/bin:/opt/cargo/bin:" + os.environ.get("PATH", "/usr/bin:/bin"))


def user_systemctl(*argv, check=True):
    return subprocess.run(["systemctl", "--user", f"--machine={KIOSK}@.host", *argv], check=check,
                          capture_output=True, text=True)


def legacy_state():
    shown = user_systemctl("show", "--property=ActiveState,UnitFileState", "tilecast-player.service").stdout
    props = dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)
    return props.get("UnitFileState"), props.get("ActiveState")


def unit_state(unit):
    shown = output("systemctl", "show", "--property=ActiveState,UnitFileState", unit)
    props = dict(line.split("=", 1) for line in shown.splitlines() if "=" in line)
    return props.get("UnitFileState"), props.get("ActiveState")


def attempt():
    with open("/var/lib/tilecast-edge-migrate/state.json") as handle:
        return json.load(handle)


def legacy_digests():
    out = {}
    for base, _, names in os.walk(LEGACY_DIR):
        for name in names:
            path = os.path.join(base, name)
            if os.path.islink(path):
                out[os.path.relpath(path, LEGACY_DIR)] = "link:" + os.readlink(path)
                continue
            with open(path, "rb") as handle:
                out[os.path.relpath(path, LEGACY_DIR)] = hashlib.sha256(handle.read()).hexdigest()
    return out


def save(name, value):
    with open(os.path.join(WORK, name), "w") as handle:
        json.dump(value, handle)


def load(name):
    with open(os.path.join(WORK, name)) as handle:
        return json.load(handle)


def start_server():
    run("systemctl", "start", "postgresql")
    unit = unit_state("e2e-server.service")[1]
    if unit != "active":
        properties = [f"--setenv={key}={value}" for key, value in load("server-env.json").items()]
        run("systemd-run", "--unit=e2e-server", "--collect", *properties, os.path.join(WORK, "tilecast"))
    client = e2e.Client()
    e2e.wait_for(lambda: client.call("GET", "/readyz")[0] == 200, "server readiness")


def assert_legacy_restored(context):
    e2e.wait_for(lambda: legacy_state() == ("enabled", "active"), f"{context}: the legacy player runs again", 90)
    for unit in ("tilecast-edge.service", "tilecast-renderer.service", "tilecast-edge-migrate-recover.service"):
        state = unit_state(unit)
        assert state[0] == "disabled" and state[1] in ("inactive", "failed"), f"{context}: {unit} {state}"
    assert not os.path.exists("/run/tilecast-edge-migrate/probation"), f"{context}: probation ended"
    for unit in ("tilecast-edge.service", "tilecast-renderer.service"):
        link = f"{DROPINS}/{unit}.requires/tilecast-edge-migrate-recover.service"
        assert not os.path.lexists(link), f"{context}: {unit} no longer requires the recovery"
    assert not os.path.exists("/var/lib/tilecast-edge/legacy-copy"), f"{context}: the legacy copy was removed"
    assert legacy_digests() == load("legacy-digests.json"), f"{context}: legacy files changed"


def migrate(expect_code, settle=120):
    started = time.monotonic()
    result = subprocess.run([MIGRATE, "migrate", f"--kiosk={KIOSK}", "--backend=headless",
                             f"--settle-seconds={settle}"], capture_output=True, text=True, timeout=1800)
    print(result.stdout[-3000:])
    if result.returncode != expect_code:
        print(result.stderr[-3000:])
        subprocess.run(["journalctl", "--no-pager", "-n", "200", "-u", "tilecast-edge-migrate.service",
                        "-u", "tilecast-edge-import.service", "-u", "tilecast-edge-selftest.service",
                        "-u", "tilecast-edge.service", "-u", "tilecast-renderer.service"], check=False)
        raise AssertionError(f"migrate exited {result.returncode}, expected {expect_code}")
    return attempt(), time.monotonic() - started


def setup():
    os.makedirs(WORK, exist_ok=True)
    environment = env()
    # The update helper as it ships, without the integration-test feature.
    run("cargo", "build", "-q", "--locked", "-p", "tilecastd", "-p", "tilecastctl", "-p", "tilecast-edge-update",
        cwd=EDGE, env=environment)
    run("cargo", "build", "-q", "--locked", "-p", "tilecast-edge-migrate", "--features", "integration-test",
        cwd=EDGE, env=environment)
    run("cmake", "-S", os.path.join(EDGE, "renderer-wpe"), "-B", RENDERER_BUILD, "-G", "Ninja",
        stdout=subprocess.DEVNULL)
    run("cmake", "--build", RENDERER_BUILD)
    run("cmake", "-S", os.path.join(EDGE, "session-bridge"), "-B", BRIDGE_BUILD, "-G", "Ninja",
        stdout=subprocess.DEVNULL)
    run("cmake", "--build", BRIDGE_BUILD)
    run(os.path.join(EDGE, "renderer-wpe", "assemble-runtime.sh"), RUNTIME)

    # A release signed with a throwaway key that the machine is told to trust.
    sbom = os.path.join(WORK, "sbom.cdx.json")
    with open(sbom, "w") as handle:
        json.dump({"bomFormat": "CycloneDX", "specVersion": "1.5", "components": []}, handle)
    wpe = output("pkg-config", "--modversion", "wpe-webkit-2.0").strip()
    run(os.path.join(EDGE, "release", "stage-release.py"), "--out", RELEASE, "--version", "0.1.0",
        "--bin-dir", os.path.join(TARGET, "debug"), "--renderer", os.path.join(RENDERER_BUILD, "tilecast-renderer-wpe"),
        "--session-bridge", os.path.join(BRIDGE_BUILD, "tilecast-session-bridge"),
        "--gst-plugin-dir", os.path.join(RENDERER_BUILD, "gstreamer-1.0"), "--runtime-dir", RUNTIME,
        "--sbom", sbom, "--wpe-version", wpe, "--base-distribution", "debian-sid-ci")
    key = os.path.join(WORK, "release-key.pem")
    run("openssl", "genpkey", "-algorithm", "ed25519", "-out", key)
    public = subprocess.run(["openssl", "pkey", "-in", key, "-pubout", "-outform", "DER"], check=True,
                            capture_output=True).stdout[-32:]
    os.makedirs("/etc/tilecast-edge", exist_ok=True)
    with open("/etc/tilecast-edge/release-signing-key", "w") as handle:
        handle.write(base64.b64encode(public).decode() + "\n")
    os.chmod("/etc/tilecast-edge/release-signing-key", 0o644)
    manifest = os.path.join(RELEASE, "tilecast-edge-release.json")
    signature = subprocess.run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", key, "-in", manifest],
                               check=True, capture_output=True).stdout
    with open(manifest + ".sig", "w") as handle:
        handle.write(base64.b64encode(signature).decode())

    # A tampered release is refused before anything is installed.
    tampered = os.path.join(WORK, "tampered")
    shutil.copytree(RELEASE, tampered)
    with open(os.path.join(tampered, "bin", "tilecastctl"), "ab") as handle:
        handle.write(b"x")
    refused = subprocess.run([os.path.join(RELEASE, "bin", "tilecast-edge-migrate"), "install", "--from", tampered],
                             capture_output=True, text=True)
    assert refused.returncode != 0 and "release_file_unavailable" in refused.stderr, refused.stderr
    assert not os.path.exists("/opt/tilecast-edge/0.1.0"), "nothing installed from a tampered release"
    run(os.path.join(RELEASE, "bin", "tilecast-edge-migrate"), "install", "--from", RELEASE)
    assert os.readlink("/opt/tilecast-edge/current") == "0.1.0"
    assert unit_state("tilecast-edge.service")[0] == "disabled", "installed, not enabled"
    print("setup: the signed release installed; a tampered copy was refused")

    # Test-only drop-ins: the headless output, and no bubblewrap sandbox in a
    # container. Production units use DRM and keep the sandbox.
    for unit in ("tilecast-renderer.service", "tilecast-renderer-selftest.service"):
        os.makedirs(f"{DROPINS}/{unit}.d", exist_ok=True)
        with open(f"{DROPINS}/{unit}.d/50-e2e.conf", "w") as handle:
            handle.write("[Service]\nEnvironment=WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1\n")
            if unit == "tilecast-renderer.service":
                handle.write(
                    "ExecStart=\nExecStart=/opt/tilecast-edge/current/bin/tilecast-renderer-wpe --platform=headless"
                    " --socket=/run/tilecast-edge/edge.sock --media-socket=/run/tilecast-edge/media.sock"
                    " --runtime-dir=/opt/tilecast-edge/current/share/tilecast/renderer-web"
                    " --gst-plugin-dir=/opt/tilecast-edge/current/lib/gstreamer-1.0\n"
                    "TTYPath=\nStandardInput=null\nTTYReset=no\nTTYVHangup=no\n")
    run("systemctl", "daemon-reload")

    # A real server with a published playlist.
    cluster = os.listdir("/etc/postgresql")[0]
    hba = f"/etc/postgresql/{cluster}/main/pg_hba.conf"
    run("sed", "-i", "-E", "s/(scram-sha-256|md5|peer)$/trust/", hba)
    run("systemctl", "restart", "postgresql")
    e2e.wait_for(lambda: subprocess.run(["sudo", "-u", "postgres", "psql", "-c", "select 1"],
                                        capture_output=True).returncode == 0, "postgres")
    subprocess.run(["sudo", "-u", "postgres", "createuser", "--superuser", "root"], capture_output=True)
    run("dropdb", "--if-exists", e2e.DATABASE)
    run("createdb", e2e.DATABASE)
    run("go", "build", "-o", os.path.join(WORK, "tilecast"), "./cmd/tilecast", cwd=e2e.SERVER, env=environment)
    save("server-env.json", {
        "TILECAST_DATABASE_URL": f"postgres://root@localhost:5432/{e2e.DATABASE}?sslmode=disable",
        "TILECAST_HTTP_ADDR": f"127.0.0.1:{e2e.PORT}", "TILECAST_PUBLIC_URL": e2e.BASE,
        "TILECAST_MDNS_ENABLED": "false", "TILECAST_MEDIA_ROOT": os.path.join(WORK, "server-media"),
        "TILECAST_UPDATE_ROOT": os.path.join(WORK, "server-updates"),
        "TILECAST_BACKUP_ROOT": os.path.join(WORK, "server-backups"),
        "TILECAST_FFMPEG_PATH": shutil.which("ffmpeg"), "TILECAST_FFPROBE_PATH": shutil.which("ffprobe"),
        # The server trusts the same throwaway key for Player releases
        # (update_e2e.py uploads Edge releases signed with it).
        "TILECAST_UPDATE_MANIFEST_PUBLIC_KEY": base64.b64encode(public).decode(),
    })
    start_server()
    client = e2e.Client()
    _, created = client.call("POST", "/api/v1/auth/setup", {
        "organizationName": "Greenwood Library", "ownerName": "E2E Owner", "username": "owner",
        "password": "correct horse battery staple"}, expect=201)
    client.csrf = created["data"]["csrfToken"]
    installation_id = client.call("GET", "/api/v1/system/identity", expect=200)[1]["data"]["installationId"]

    # The legacy player's pairing flow.
    player = e2e.Client()
    player_id = "3a0f4c1e-7b2d-4e8f-9a6b-1c2d3e4f5a6b"
    metadata = {"playerInstallationId": player_id, "platform": "linux", "manufacturer": "e2e", "model": "Linux x64",
                "androidVersion": "6.8.0-e2e", "playerVersion": "0.1.0", "screenWidth": 1920, "screenHeight": 1080,
                "density": 1, "locale": "en-US", "timezone": "UTC"}
    session = player.call("POST", "/api/v1/player/pairing-sessions",
                          {"installationId": installation_id, "metadata": metadata}, expect=201)[1]["data"]
    resolved = client.call("POST", "/api/v1/screens/pairing/resolve", {"code": session["code"]}, expect=200)[1]
    client.call("POST", f"/api/v1/screens/pairing/{resolved['data']['id']}/approve", {"name": "Lobby"}, expect=200)
    poll = player.call("GET", f"/api/v1/player/pairing-sessions/{session['id']}",
                       headers={"Authorization": f"Pairing {session['pollSecret']}"}, expect=200)[1]
    enrolled = player.call("POST", "/api/v1/player/enroll", {"pairingSessionId": session["id"],
                           "enrollmentToken": poll["data"]["enrollmentToken"]}, expect=201)[1]["data"]
    screen_id, credential = enrolled["screenId"], enrolled["deviceCredential"]

    media = os.path.join(WORK, "media")
    os.makedirs(media, exist_ok=True)
    run("ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=1", "-frames:v", "1",
        os.path.join(media, "still.png"))
    image = e2e.upload(client, os.path.join(media, "still.png"), "image/png")
    playlist = client.call("POST", "/api/v1/playlists", {"name": "Lobby loop", "description": "",
                                                          "sourceType": "static"}, expect=(200, 201))[1]["data"]
    playlist = client.call("POST", f"/api/v1/playlists/{playlist['id']}/items", e2e.item(image["id"], 4000),
                           expect=(200, 201))[1]["data"]
    client.call("POST", f"/api/v1/playlists/{playlist['id']}/publish",
                {"expectedDraftRevision": playlist["draftRevision"]}, expect=(200, 201))
    client.call("PUT", f"/api/v1/screens/{screen_id}/playlist-assignment", {"playlistId": playlist["id"]},
                expect=200)

    # The legacy player's state, as apps/player-linux writes it, including its
    # cached manifest and media, in the kiosk account's home.
    run("useradd", "--create-home", "--shell", "/bin/bash", KIOSK)
    kiosk = pwd.getpwnam(KIOSK)
    run("loginctl", "enable-linger", KIOSK)
    e2e.wait_for(lambda: unit_state(f"user@{kiosk.pw_uid}.service")[1] == "active", "the kiosk user manager", 60)
    bearer = {"Authorization": f"Bearer {credential}"}
    request = urllib.request.Request(e2e.BASE + "/api/v1/player/manifest", headers=bearer)
    with urllib.request.urlopen(request, timeout=10) as response:
        manifest = json.loads(response.read())["data"]
    os.makedirs(os.path.join(LEGACY_DIR, "cache", "media"), mode=0o700)
    files = {
        "installation.json": {"playerInstallationId": player_id},
        "credential.json": {"serverUrl": e2e.BASE + "/", "installationId": installation_id, "screenId": screen_id,
                            "screenName": enrolled["screenName"], "deviceCredential": credential,
                            "enrolledAt": "2026-09-22T00:00:00Z"},
        "executed-commands.json": {"keys": [e2e.LEGACY_COMMAND_KEY]},
        "playback-flags.json": {"playbackDisabled": False},
        "manifest-active.json": {"manifest": manifest, "etag": None, "storedAt": "2026-09-22T00:00:00Z",
                                 "clockOffsetMs": 0, "installationId": installation_id, "screenId": screen_id,
                                 "normalizedServerUrl": e2e.BASE},
    }
    for name, value in files.items():
        with open(os.path.join(LEGACY_DIR, name), "w") as handle:
            json.dump(value, handle)
    for asset in manifest["assets"]:
        request = urllib.request.Request(e2e.BASE + asset["downloadPath"], headers=bearer)
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
        with open(os.path.join(LEGACY_DIR, "cache", "media", f"{asset['assetId']}-{asset['variantId']}"), "wb") as out:
            out.write(data)
    # The legacy player itself: a stand-in process named like the AppImage's
    # executable, in the user unit that apps/player-linux installs.
    os.makedirs(f"/home/{KIOSK}/tilecast", exist_ok=True)
    shutil.copyfile("/usr/bin/sleep", f"/home/{KIOSK}/tilecast/tilecast-player")
    os.chmod(f"/home/{KIOSK}/tilecast/tilecast-player", 0o755)
    unit_dir = f"/home/{KIOSK}/.config/systemd/user"
    os.makedirs(unit_dir, exist_ok=True)
    with open(os.path.join(unit_dir, "tilecast-player.service"), "w") as handle:
        handle.write("[Unit]\nDescription=Tilecast Player (e2e stand-in)\n[Service]\n"
                     "ExecStart=%h/tilecast/tilecast-player infinity\nRestart=always\n"
                     "[Install]\nWantedBy=default.target\n")
    run("chown", "-R", f"{KIOSK}:{KIOSK}", f"/home/{KIOSK}")
    for root, dirs, names in os.walk(LEGACY_DIR):
        for name in dirs:
            os.chmod(os.path.join(root, name), 0o700)
        for name in names:
            if not os.path.islink(os.path.join(root, name)):
                os.chmod(os.path.join(root, name), 0o600)
    # A link planted where a state file belongs is never followed: the
    # import sees no executed-commands file rather than root's file.
    planted = os.path.join(LEGACY_DIR, "executed-commands.json")
    os.remove(planted)
    os.symlink("/etc/shadow", planted)
    os.lchown(planted, kiosk.pw_uid, kiosk.pw_gid)
    user_systemctl("daemon-reload")
    user_systemctl("enable", "--now", "tilecast-player.service")
    e2e.wait_for(lambda: legacy_state() == ("enabled", "active"), "the legacy player", 30)
    save("legacy-digests.json", legacy_digests())
    save("screen.json", {"screenId": screen_id, "playlistId": playlist["id"]})
    print("setup: server, paired legacy player and its user unit are running")


def import_failure():
    run("systemctl", "stop", "e2e-server.service")
    result, _ = migrate(expect_code=1)
    assert result["phase"] == "rolled_back", result["phase"]
    # The importer's own typed reason, not a missing report.
    assert result["reason"].startswith("import_failed: server_"), result["reason"]
    assert result["import"]["outcome"] == "failed", result["import"]
    assert result["edgeStartedAtMs"] is None, "Edge never started"
    assert result["selfTest"]["outcome"] == "passed", result["selfTest"]
    assert result["compat"]["outcome"] == "compatible", result["compat"]
    assert result["legacyFilesUnchanged"] is True
    assert_legacy_restored("import failure")
    start_server()
    print(f"import-failure: rolled back ({result['reason']}); the legacy player runs again")


def crash():
    os.makedirs(f"{DROPINS}/tilecast-edge-migrate.service.d", exist_ok=True)
    dropin = f"{DROPINS}/tilecast-edge-migrate.service.d/50-crash.conf"
    with open(dropin, "w") as handle:
        handle.write("[Service]\nEnvironment=TILECAST_MIGRATE_CRASH_AT=AfterEdgeEnabled\n")
    run("systemctl", "daemon-reload")
    try:
        result, _ = migrate(expect_code=1)
    finally:
        os.remove(dropin)
        run("systemctl", "daemon-reload")
    assert result["phase"] == "rolled_back", result["phase"]
    # The crash point was reached: Edge had been enabled, and the rollback
    # came from the recovery, not from a failed step.
    assert result["reason"] == "interrupted", result["reason"]
    assert result["edgeStartedAtMs"] is not None or any(e["detail"] == "enabling Edge" for e in result["events"])
    assert result["import"]["outcome"] == "imported", result["import"]
    assert_legacy_restored("crash after Edge was enabled")
    print("crash: the service's recovery rolled back an attempt that crashed after enabling Edge")


def start_settling():
    previous = attempt()["attemptId"]
    subprocess.Popen([MIGRATE, "migrate", f"--kiosk={KIOSK}", "--backend=headless", "--settle-seconds=600"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

    def settling():
        try:
            state = attempt()
        except (OSError, ValueError):
            return None
        return state if state["phase"] == "settling" and state["attemptId"] != previous else None

    state = e2e.wait_for(settling, "the migration to settle", 300)
    assert os.path.exists("/run/tilecast-edge-migrate/probation"), "probation holds commands while settling"
    assert unit_state("tilecast-edge-migrate-recover.service")[0] == "enabled"
    for unit in ("tilecast-edge.service", "tilecast-renderer.service"):
        assert os.path.lexists(f"{DROPINS}/{unit}.requires/tilecast-edge-migrate-recover.service"), unit
    print(f"start-settling: attempt {state['attemptId']} is settling; the driver now cuts the power")


def after_reboot():
    e2e.wait_for(lambda: attempt()["phase"] == "rolled_back", "the boot recovery", 180)
    result = attempt()
    assert result["events"][-1]["detail"].startswith("rolled back"), result["events"][-1]
    assert_legacy_restored("power loss during settlement")
    # The unaccepted Edge never started in this boot: it required the
    # recovery, which disabled it and cancelled its start.
    # A container restart keeps the host's boot ID, so select the entries
    # after this systemd instance started.
    booted = int(output("systemctl", "show", "--property=UserspaceTimestampMonotonic", "--value").strip())
    entries = [json.loads(line) for line in output("journalctl", "--no-pager", "-o", "json", "-u",
                                                    "tilecast-edge.service").splitlines() if line.strip()]
    started = [e for e in entries if int(e["__MONOTONIC_TIMESTAMP"]) > booted
               and "Started tilecast-edge.service" in str(e.get("MESSAGE", ""))]
    assert not started, started
    print("after-reboot: the boot recovery rolled the unaccepted Edge back to the legacy player")


def accept():
    start_server()
    screen = load("screen.json")
    result, elapsed = migrate(expect_code=0, settle=600)
    assert result["phase"] == "accepted", result
    assert result["import"]["outcome"] == "imported" and result["import"]["summary"]["refreshed"], result["import"]
    assert result["mediaCopied"] is True
    presentation = result["settlement"]["presentation"]
    assert presentation["source"] == "server_manifest" and presentation["accepted"] and presentation["evidence"]
    assert legacy_state() == ("disabled", "inactive"), legacy_state()
    for unit in ("tilecast-edge.service", "tilecast-renderer.service"):
        assert unit_state(unit) == ("enabled", "active"), (unit, unit_state(unit))
    assert unit_state("tilecast-edge-migrate-recover.service")[0] == "disabled"
    assert not os.path.lexists(f"{DROPINS}/tilecast-edge.service.requires/tilecast-edge-migrate-recover.service")
    assert not os.path.exists("/run/tilecast-edge-migrate/probation")
    assert not os.path.exists("/var/lib/tilecast-edge/legacy-copy")
    assert legacy_digests() == load("legacy-digests.json"), "legacy files are left intact"
    status = json.loads(output("/opt/tilecast-edge/current/bin/tilecastctl", "--json", "status"))
    assert status["server"]["screenId"] == screen["screenId"] and status["link"]["state"] == "connected", status
    check_hardware_packaging()
    rollback = subprocess.run([MIGRATE, "rollback"], capture_output=True, text=True)
    assert rollback.returncode != 0 and "rollback window has ended" in rollback.stderr, rollback.stderr
    print(f"accept: accepted after {elapsed:.0f} s of migration; Edge plays the server presentation, the legacy "
          "player is disabled and its files are unchanged, and rollback is refused")


def tilecast_systemctl(*argv):
    return subprocess.run(["systemctl", "--user", "--machine=tilecast@.host", *argv], capture_output=True, text=True)


def bridge_pid():
    shown = tilecast_systemctl("show", "--property=MainPID", "tilecast-session-bridge.service").stdout.strip()
    return int(shown.split("=", 1)[1])


def print_bridge_diagnostics():
    """What the tilecast session, the bridge and tilecastd saw."""
    uid = pwd.getpwnam("tilecast").pw_uid
    for argv in (["systemctl", "status", "--no-pager", f"user@{uid}.service"],
                 ["systemctl", "--user", "--machine=tilecast@.host", "status", "--no-pager",
                  "tilecast-session-bridge.path", "tilecast-session-bridge.service",
                  "pipewire.service", "wireplumber.service"],
                 ["systemctl", "--user", "--machine=tilecast@.host", "show", "--property=ActiveState,SubState,"
                  "NRestarts,ExecMainStatus,ExecMainCode,Result", "tilecast-session-bridge.service"],
                 ["ls", "-la", "/run/tilecast-edge", f"/run/user/{uid}", "/etc/systemd/user",
                  "/etc/systemd/user/default.target.wants"],
                 ["journalctl", "--no-pager", "-o", "cat", "-n", "150", f"_UID={uid}"],
                 ["journalctl", "--no-pager", "-o", "cat", "-n", "80", "-u", "tilecast-edge.service",
                  "--grep", "audio|ipc|session"],
                 ["/opt/tilecast-edge/current/bin/tilecastctl", "--json", "capabilities"],
                 # The socket directory as the bridge's mount namespace sees it.
                 ["sh", "-c", "pid=$(systemctl --user --machine=tilecast@.host show -P MainPID "
                  "tilecast-session-bridge.service); ls -la /proc/$pid/root/run/tilecast-edge; "
                  "cat /proc/$pid/uid_map /proc/$pid/gid_map; grep -E '^(Uid|Gid|Groups)' /proc/$pid/status"]):
        result = subprocess.run(argv, capture_output=True, text=True)
        print(f"$ {' '.join(argv)}  (exit {result.returncode})\n{result.stdout[-8000:]}{result.stderr[-2000:]}",
              flush=True)


BRIDGE_SANDBOX_VARIANTS = (
    ("none", []),
    ("PrivateUsers", ["PrivateUsers=yes"]),
    ("PrivateUsers+ProtectSystem", ["PrivateUsers=yes", "ProtectSystem=strict"]),
    ("PrivateUsers+ProtectHome", ["PrivateUsers=yes", "ProtectHome=tmpfs", "BindReadOnlyPaths=%t"]),
    ("PrivateUsers+PrivateTmp", ["PrivateUsers=yes", "PrivateTmp=yes"]),
    ("PrivateUsers+InaccessiblePaths", ["PrivateUsers=yes",
                                        "InaccessiblePaths=-/var/lib/tilecast-edge -/run/tilecast -/dev/snd"]),
    ("PrivateUsers+ProtectKernelTunables+ControlGroups", ["PrivateUsers=yes", "ProtectKernelTunables=yes",
                                                          "ProtectControlGroups=yes"]),
    ("seccomp", ["NoNewPrivileges=yes", "RestrictAddressFamilies=AF_UNIX", "SystemCallFilter=@system-service",
                 "MemoryDenyWriteExecute=yes", "RestrictNamespaces=yes", "LockPersonality=yes"]),
)


def probe_bridge_sandbox():
    """Which sandbox option keeps the bridge's account from connecting to
    tilecastd's socket: the same connect() under each subset."""
    connect = ("import socket; s = socket.socket(socket.AF_UNIX); "
               "s.connect('/run/tilecast-edge/edge.sock'); print('connected')")
    for label, properties in BRIDGE_SANDBOX_VARIANTS:
        argv = ["systemd-run", "--user", "--machine=tilecast@.host", "--wait", "--pipe", "--quiet"]
        for prop in properties:
            argv += ["-p", prop]
        result = subprocess.run(argv + ["/usr/bin/python3", "-c", connect], capture_output=True, text=True,
                                timeout=60)
        outcome = result.stdout.strip() or result.stderr.strip().splitlines()[-1:]
        print(f"bridge sandbox probe [{label}]: exit {result.returncode}: {outcome}", flush=True)


def check_hardware_packaging():
    """M9 packaging on a real systemd: the display group and device policy of
    the daemon, and the session bridge in the lingering tilecast session with
    its sandbox."""
    shown = output("systemctl", "show", "--property=SupplementaryGroups,DevicePolicy,DeviceAllow",
                   "tilecast-edge.service")
    assert "SupplementaryGroups=tilecast-display" in shown and "DevicePolicy=closed" in shown, shown
    assert "char-cec rw" in shown and "char-i2c rw" in shown, shown
    renderer_mount = output("systemctl", "show", "--property=TemporaryFileSystem", "tilecast-renderer.service")
    assert "/run/tilecast:ro,mode=0000" in renderer_mount, renderer_mount
    groups = output("id", "-nG", "tilecast").split()
    assert "tilecast-display" not in groups, "the account itself never joins tilecast-display"
    assert os.path.exists("/usr/lib/udev/rules.d/70-tilecast-display.rules")
    assert os.path.exists("/usr/lib/modules-load.d/tilecast-edge.conf")
    assert os.path.exists("/var/lib/systemd/linger/tilecast"), "tilecast lingers so its session starts at boot"
    # The packaged configuration asks logind for the idle lock (test harnesses
    # alone turn it off); whether logind grants it depends on the host.
    listed = json.loads(output("/opt/tilecast-edge/current/bin/tilecastctl", "--json", "capabilities"))
    idle = next(c for c in listed["capabilities"] if c["id"] == "system.idle_inhibit")
    assert idle.get("reasonCode") != "not_requested", idle
    print(f"accept: system.idle_inhibit is {idle['state']} ({idle.get('reasonCode', 'lock held')})")
    def bridge_running():
        # Running, and not crash-looping: `is-active` alone is true for the
        # moment between each failed start and its restart.
        shown = tilecast_systemctl("show", "--property=SubState,NRestarts,ExecMainStatus",
                                   "tilecast-session-bridge.service").stdout
        return "SubState=running" in shown and "NRestarts=0" in shown

    try:
        e2e.wait_for(bridge_running, "the session bridge started by its path unit and still running", 90)
    except AssertionError:
        print_bridge_diagnostics()
        raise
    sandbox = tilecast_systemctl("show", "--property=RestrictAddressFamilies,NoNewPrivileges,"
                                 "MemoryDenyWriteExecute,SystemCallFilter,RestrictNamespaces",
                                 "tilecast-session-bridge.service").stdout
    for expected in ("RestrictAddressFamilies=AF_UNIX", "NoNewPrivileges=yes", "MemoryDenyWriteExecute=yes",
                     "RestrictNamespaces=yes"):
        assert expected in sandbox, (expected, sandbox)
    assert "SystemCallFilter=" in sandbox and "SystemCallFilter=\n" not in sandbox, sandbox
    # The seccomp layer holds on every host, even where systemd could not
    # give the unit a user namespace for the mount options.
    status = subprocess.run(["grep", "-E", "^(Seccomp|NoNewPrivs):", f"/proc/{bridge_pid()}/status"],
                            capture_output=True, text=True).stdout
    assert "Seccomp:\t2" in status and "NoNewPrivs:\t1" in status, status
    effective = subprocess.run(["grep", "-E", "^Cap(Eff|Prm|Bnd)", f"/proc/{bridge_pid()}/status"],
                               capture_output=True, text=True).stdout
    assert "CapEff:\t0000000000000000" in effective and "CapPrm:\t0000000000000000" in effective, effective

    def bridge_connected():
        capabilities = json.loads(output("/opt/tilecast-edge/current/bin/tilecastctl", "--json", "capabilities"))
        noise = next((c for c in capabilities["capabilities"] if c["id"] == "audio.noise_meter"), None)
        return noise if noise and noise.get("reasonCode") != "session_bridge_not_connected" else None

    try:
        noise = e2e.wait_for(bridge_connected, "the session bridge connected to tilecastd", 90)
    except AssertionError:
        print_bridge_diagnostics()
        probe_bridge_sandbox()
        raise
    print(f"accept: the session bridge runs sandboxed in the tilecast session; audio.noise_meter is "
          f"{noise['state']} ({noise.get('reasonCode', 'no reason')})")


PHASES = {"setup": setup, "import-failure": import_failure, "crash": crash, "start-settling": start_settling,
          "after-reboot": after_reboot, "accept": accept}

if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    PHASES[sys.argv[1]]()
