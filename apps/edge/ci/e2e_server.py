#!/usr/bin/env python3
"""Cross-language end-to-end test: a real Tilecast Server and a real tilecastd.

Drives the production pairing flow over HTTP (setup, pairing session,
dashboard approval, enrollment), writes the resulting state in the legacy
Electron player's on-disk format, then checks that tilecastd:

1. imports it once (`tilecastd import-legacy`), leaving the legacy files
   untouched, and refuses a second import as already complete;
2. verifies installation identity and then makes ordinary player contact
   (`POST /api/v1/player/heartbeat`) the dashboard can see on the screen;
3. with a real tilecast-renderer-wpe (``--renderer``), plays what the
   dashboard assigns through the ordinary manifest: an uploaded image and
   video in a published playlist, then a published Layout containing a clock
   Widget, each committed only after the renderer's own evidence and reported
   back in the ordinary heartbeat; and plays the committed Layout from its
   cache after a restart with the server stopped;
4. deletes the credential only after the server says it was revoked.

No Edge-specific server configuration or endpoint is involved: Edge 1 uses
the same player API as every other Tilecast player.

Requirements: Go, cargo, FFmpeg, a local PostgreSQL where the current user
may create databases. Usage (from the repository root):

    apps/edge/ci/e2e_server.py [--renderer BIN --runtime-dir DIR --gst-plugin-dir DIR]

apps/edge/ci/run-e2e-server.sh runs it with the renderer in the
tilecast-edge-e2e image.
"""

import argparse
import datetime
import hashlib
import http.cookiejar
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
EDGE = os.path.join(ROOT, "apps", "edge")
SERVER = os.path.join(ROOT, "apps", "server")
DATABASE = "tilecast_edge_e2e"
PORT = 18080
BASE = f"http://127.0.0.1:{PORT}"


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def call(self, method, path, body=None, headers=None, expect=None, raw=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        request = urllib.request.Request(BASE + path, data=data, method=method)
        if raw is None:
            request.add_header("Content-Type", "application/json")
        if self.csrf and method not in ("GET", "HEAD"):
            request.add_header("X-CSRF-Token", self.csrf)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with self.opener.open(request, timeout=10) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            status, payload = error.code, error.read()
        except urllib.error.URLError:
            status, payload = 0, b""
        if expect is not None and status not in (expect if isinstance(expect, tuple) else (expect,)):
            # Never echo a credential or token, even from a throwaway server.
            text = re.sub(r"(tc_device_|Token\":\")[A-Za-z0-9._-]+", r"\1[redacted]", payload[:400].decode(errors="replace"))
            raise AssertionError(f"{method} {path}: {status} {text}")
        return status, (json.loads(payload) if payload else None)


def wait_for(predicate, what, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.5)
    raise AssertionError(f"timed out waiting for {what}")


def upload(client, path, mime):
    """Uploads a file through the dashboard's resumable upload API and waits
    for server-side processing to finish."""
    with open(path, "rb") as handle:
        data = handle.read()
    _, created = client.call("POST", "/api/v1/uploads",
                             {"filename": os.path.basename(path), "mimeType": mime, "sizeBytes": len(data)},
                             expect=(200, 201))
    upload_id = created["data"]["id"]
    client.call("PATCH", f"/api/v1/uploads/{upload_id}", raw=data, expect=(200, 204),
                headers={"Content-Type": "application/offset+octet-stream", "Upload-Offset": "0"})
    _, asset = client.call("POST", f"/api/v1/uploads/{upload_id}/complete", expect=(200, 201))
    asset_id = asset["data"]["id"]

    def ready():
        _, current = client.call("GET", f"/api/v1/assets/{asset_id}", expect=200)
        state = current["data"].get("processingStatus")
        assert state != "failed", current["data"]
        return current["data"] if state == "ready" else None

    return wait_for(ready, f"processing of {os.path.basename(path)}", timeout=120)


def item(asset_id, duration_ms=None):
    body = {"assetId": asset_id, "fitMode": "contain", "transition": "none", "audioEnabled": False, "volume": 0,
            "deliveryPolicy": "download"}
    if duration_ms is not None:
        body["durationMs"] = duration_ms
    return body


def evidence(log_path, since, kinds):
    """Evidence kinds the daemon accepted from the renderer after byte
    offset ``since`` of its log, once every kind in ``kinds`` was seen."""
    with open(log_path, encoding="utf-8", errors="replace") as handle:
        handle.seek(since)
        text = handle.read()
    seen = {kind for kind in kinds if any(kind in line for line in text.splitlines() if "evidence_accepted" in line)}
    return seen if seen == set(kinds) else None


class Renderer:
    """A real tilecast-renderer-wpe on WPE_PLATFORM=headless."""

    def __init__(self, args, runtime, work, log="renderer.log"):
        self.args, self.runtime, self.work, self.log = args, runtime, work, log
        self.process = None

    def start(self):
        env = dict(os.environ)
        # Containers without unprivileged user namespaces cannot run WebKit's
        # bubblewrap sandbox. CI only; production keeps the sandbox.
        env.setdefault("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1")
        log = open(os.path.join(self.work, self.log), "a")
        wait_for(lambda: os.path.exists(os.path.join(self.runtime, "edge.sock")), "daemon socket", timeout=30)
        self.process = subprocess.Popen(
            [self.args.renderer, "--platform=headless", f"--socket={os.path.join(self.runtime, 'edge.sock')}",
             f"--media-socket={os.path.join(self.runtime, 'media.sock')}", f"--runtime-dir={self.args.runtime_dir}",
             f"--gst-plugin-dir={self.args.gst_plugin_dir}", "--headless-size=1280x720", "--console"],
            stdout=log, stderr=subprocess.STDOUT, env=env)
        return self.process

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()


def tree(root):
    out = {}
    for base, _, files in os.walk(root):
        for name in files:
            path = os.path.join(base, name)
            with open(path, "rb") as handle:
                out[os.path.relpath(path, root)] = hashlib.sha256(handle.read()).hexdigest()
    return out


def unix_ms(value):
    """Milliseconds from an RFC 3339 timestamp with any sub-second precision."""
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)", value)
    assert match, value
    base = datetime.datetime.fromisoformat(match.group(1) + match.group(3).replace("Z", "+00:00"))
    fraction = (match.group(2) or "0")[:3].ljust(3, "0")
    return int(base.timestamp()) * 1000 + int(fraction)


def item_starts(tilecastctl, sockets, seconds):
    """Every item start each daemon accepted from its renderer during the
    window, as (item id, accepted-at ms). The daemon stamps the evidence, so
    the 100 ms poll only has to be shorter than an item."""
    seen = {socket: [] for socket in sockets}
    deadline = time.time() + seconds
    while time.time() < deadline:
        for socket in sockets:
            out = subprocess.run([tilecastctl, "--socket", socket, "--json", "status"], capture_output=True, text=True)
            renderer = json.loads(out.stdout or "{}").get("renderer", {})
            if renderer.get("currentItemStartedAt"):
                start = (renderer.get("currentItemId"), unix_ms(renderer["currentItemStartedAt"]))
                if not seen[socket] or seen[socket][-1] != start:
                    seen[socket].append(start)
        time.sleep(0.1)
    return [seen[socket] for socket in sockets]


def grid_phase_ms(at_ms, anchor_ms, durations):
    """How far after its nearest shared boundary an instant falls."""
    cycle = sum(durations)
    within = (at_ms - anchor_ms) % cycle
    boundaries = [sum(durations[:index]) for index in range(len(durations))] + [cycle]
    return min((within - boundary for boundary in boundaries), key=abs)


# An idempotency key the legacy player had already executed.
LEGACY_COMMAND_KEY = "7d4c2f9e-6a1b-4e3d-9c8f-2b1a0e9d8c7b"


def psql(query):
    return subprocess.run(["psql", "-d", DATABASE, "-At", "-c", query], check=True, capture_output=True,
                          text=True).stdout.strip()


def main():
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", help="tilecast-renderer-wpe binary; enables the content phase")
    parser.add_argument("--runtime-dir", help="assembled trusted web runtime (renderer-wpe/assemble-runtime.sh)")
    parser.add_argument("--gst-plugin-dir", help="directory holding the tcmediasrc GStreamer plugin")
    args = parser.parse_args()
    if args.renderer and not (args.runtime_dir and args.gst_plugin_dir):
        parser.error("--renderer needs --runtime-dir and --gst-plugin-dir")
    work = tempfile.mkdtemp(prefix="tilecast-edge-e2e-")
    processes = []
    try:
        run("dropdb", "--if-exists", DATABASE)
        run("createdb", DATABASE)
        server_bin = os.path.join(work, "tilecast")
        run("go", "build", "-o", server_bin, "./cmd/tilecast", cwd=SERVER)
        run("cargo", "build", "-q", "-p", "tilecastd", "-p", "tilecastctl", cwd=EDGE)
        target = os.path.join(os.environ.get("CARGO_TARGET_DIR", os.path.join(EDGE, "target")), "debug")
        tilecastd, tilecastctl = os.path.join(target, "tilecastd"), os.path.join(target, "tilecastctl")

        # Without the content phase nothing is uploaded, so when FFmpeg is not
        # installed the server's startup probe (`<tool> -version`) is answered
        # by a stub that refuses every other invocation.
        tools = {}
        for tool in ("ffmpeg", "ffprobe"):
            found = shutil.which(tool)
            if not found and args.renderer:
                raise AssertionError(f"the content phase needs {tool}")
            if not found:
                found = os.path.join(work, tool)
                with open(found, "w") as handle:
                    handle.write(f'#!/bin/sh\n[ "$1" = "-version" ] && echo "{tool} version e2e-stub" && exit 0\nexit 1\n')
                os.chmod(found, 0o755)
            tools[tool] = found

        server_log = open(os.path.join(work, "server.log"), "w")
        env = dict(
            os.environ,
            TILECAST_DATABASE_URL=f"postgres://localhost:5432/{DATABASE}?sslmode=disable",
            TILECAST_HTTP_ADDR=f"127.0.0.1:{PORT}",
            TILECAST_PUBLIC_URL=BASE,
            TILECAST_MDNS_ENABLED="false",
            TILECAST_MEDIA_ROOT=os.path.join(work, "server-media"),
            TILECAST_UPDATE_ROOT=os.path.join(work, "server-updates"),
            TILECAST_BACKUP_ROOT=os.path.join(work, "server-backups"),
            TILECAST_FFMPEG_PATH=tools["ffmpeg"],
            TILECAST_FFPROBE_PATH=tools["ffprobe"],
        )
        processes.append(subprocess.Popen([server_bin], env=env, stdout=server_log, stderr=subprocess.STDOUT))
        client = Client()
        wait_for(lambda: client.call("GET", "/readyz")[0] == 200, "server readiness")

        _, setup = client.call(
            "POST",
            "/api/v1/auth/setup",
            {"organizationName": "Greenwood Library", "ownerName": "E2E Owner", "username": "owner",
             "password": "correct horse battery staple"},
            expect=201,
        )
        client.csrf = setup["data"]["csrfToken"]
        _, identity = client.call("GET", "/api/v1/system/identity", expect=200)
        installation_id = identity["data"]["installationId"]

        # The legacy player's pairing flow.
        player = Client()
        player_id = str(uuid.uuid4())
        metadata = {"playerInstallationId": player_id, "platform": "linux", "manufacturer": "e2e", "model": "Linux x64",
                    "androidVersion": "6.8.0-e2e", "playerVersion": "0.1.0", "screenWidth": 1920, "screenHeight": 1080,
                    "density": 1, "locale": "en-US", "timezone": "UTC"}
        _, created = player.call("POST", "/api/v1/player/pairing-sessions",
                                 {"installationId": installation_id, "metadata": metadata}, expect=201)
        session = created["data"]
        _, resolved = client.call("POST", "/api/v1/screens/pairing/resolve", {"code": session["code"]}, expect=200)
        client.call("POST", f"/api/v1/screens/pairing/{resolved['data']['id']}/approve", {"name": "Lobby"}, expect=200)
        poll_headers = {"Authorization": f"Pairing {session['pollSecret']}"}
        _, poll = player.call("GET", f"/api/v1/player/pairing-sessions/{session['id']}", headers=poll_headers, expect=200)
        _, enrolled = player.call("POST", "/api/v1/player/enroll",
                                  {"pairingSessionId": session["id"], "enrollmentToken": poll["data"]["enrollmentToken"]},
                                  expect=201)
        screen_id = enrolled["data"]["screenId"]

        # Legacy state exactly as apps/player-linux writes it.
        legacy = os.path.join(work, "legacy")
        os.makedirs(os.path.join(legacy, "cache", "media"), mode=0o700)
        files = {
            "installation.json": {"playerInstallationId": player_id},
            "credential.json": {"serverUrl": BASE + "/", "installationId": installation_id, "screenId": screen_id,
                                "screenName": enrolled["data"]["screenName"],
                                "deviceCredential": enrolled["data"]["deviceCredential"],
                                "enrolledAt": "2026-09-22T00:00:00Z"},
            "executed-commands.json": {"keys": [LEGACY_COMMAND_KEY]},
            "playback-flags.json": {"playbackDisabled": False},
        }
        for name, value in files.items():
            with open(os.path.join(legacy, name), "w") as handle:
                json.dump(value, handle, indent=2)
            os.chmod(os.path.join(legacy, name), 0o600)
        before = tree(legacy)

        state, runtime = os.path.join(work, "state"), os.path.join(work, "run")
        config = os.path.join(work, "edge.toml")
        with open(config, "w") as handle:
            handle.write(f'[paths]\nstate_dir = "{state}"\nruntime_dir = "{runtime}"\n[log]\nformat = "text"\n')
            if args.renderer:
                handle.write(f'[renderer]\nbinary = "{args.renderer}"\nstall_threshold_seconds = 60\n')

        run(tilecastd, "--config", config, "import-legacy", "--from", legacy)
        again = subprocess.run([tilecastd, "--config", config, "import-legacy", "--from", legacy],
                               check=True, capture_output=True, text=True)
        assert json.loads(again.stdout) == {"outcome": "already_complete"}, again.stdout
        assert tree(legacy) == before, "legacy state changed"
        assert oct(os.stat(os.path.join(state, "identity", "device-credential")).st_mode & 0o777) == "0o600"

        daemon_log = open(os.path.join(work, "tilecastd.log"), "w")
        daemon = subprocess.Popen([tilecastd, "--config", config, "run"], stdout=daemon_log, stderr=subprocess.STDOUT)
        processes.append(daemon)

        def heartbeat_seen():
            status, screen = client.call("GET", f"/api/v1/screens/{screen_id}")
            data = (screen or {}).get("data", {}) if status == 200 else {}
            return data if data.get("lastHeartbeatAt") and data.get("uptimeSeconds") is not None else None

        screen = wait_for(heartbeat_seen, "player heartbeat from tilecastd")
        print("dashboard sees screen:", screen["status"], screen["lastHeartbeatAt"])
        socket = os.path.join(runtime, "edge.sock")
        status = subprocess.run([tilecastctl, "--socket", socket, "--json", "status"], check=True,
                                capture_output=True, text=True)
        daemon_status = json.loads(status.stdout)
        assert daemon_status["link"]["state"] == "connected", status.stdout
        assert daemon_status["server"]["identityVerifiedAt"], status.stdout
        assert daemon_status["playerId"] == player_id, status.stdout

        # M4: configuration from the ordinary endpoint (pushed by
        # config.changed) and durable commands through the real server.
        _, settings = client.call("GET", "/api/v1/settings", expect=200)
        client.call("PATCH", "/api/v1/settings", {"revision": settings["data"]["revision"],
                                                   "values": {"branding.disabled_title": "Closed for maintenance"}},
                    expect=200)
        wanted = psql(f"SELECT config_revision FROM screen_config_state WHERE screen_id='{screen_id}'")
        wait_for(lambda: psql(f"SELECT active_config_revision FROM screen_player_status WHERE screen_id='{screen_id}'")
                 == wanted, f"the player to report configuration revision {wanted}", timeout=120)
        print("config: revision", wanted, "accepted and reported")

        def command(kind, key=None):
            body = {"type": kind, **({"idempotencyKey": key} if key else {})}
            _, queued = client.call("POST", f"/api/v1/screens/{screen_id}/commands", body, expect=202)
            command_id = queued["data"]["id"]

            def settled():
                _, listed = client.call("GET", f"/api/v1/screens/{screen_id}/commands", expect=200)
                return next((c for c in listed["data"]["items"]
                             if c["id"] == command_id and c["state"] in ("succeeded", "failed")), None)

            return wait_for(settled, f"the {kind} result", timeout=90)

        def playback_disabled():
            return psql(f"SELECT playback_disabled FROM screen_player_status WHERE screen_id='{screen_id}'")

        result = command("disable_playback")
        assert (result["state"], result["resultCode"]) == ("succeeded", "playback_disabled"), result
        wait_for(lambda: playback_disabled() == "t", "playbackDisabled in status")
        result = command("enable_playback")
        assert (result["state"], result["resultCode"]) == ("succeeded", "playback_enabled"), result
        wait_for(lambda: playback_disabled() == "f", "playback enabled in status")
        result = command("display_power_on")
        assert (result["state"], result["resultCode"]) == ("failed", "unsupported_command"), result
        # The legacy player already ran this key: it is answered, never run.
        result = command("disable_playback", LEGACY_COMMAND_KEY)
        assert (result["state"], result["resultCode"]) == ("succeeded", "already_executed"), result
        assert playback_disabled() == "f", "an imported key must not run again"
        # A disruptive command persists its result before the daemon exits;
        # the restarted daemon never restarts again for it.
        result = command("restart_player_process")
        assert (result["state"], result["resultCode"]) == ("succeeded", "initiated"), result
        assert daemon.wait(timeout=30) == 0, "tilecastd did not exit for its restart command"
        processes.remove(daemon)
        daemon = subprocess.Popen([tilecastd, "--config", config, "run"], stdout=daemon_log, stderr=subprocess.STDOUT)
        processes.append(daemon)
        wait_for(lambda: json.loads(subprocess.run([tilecastctl, "--socket", socket, "--json", "status"],
                                                   capture_output=True, text=True).stdout or "{}")
                 .get("link", {}).get("state") == "connected", "reconnection after the restart command")
        time.sleep(15)
        daemon_log.flush()
        with open(os.path.join(work, "tilecastd.log")) as handle:
            restarts = handle.read().count("restart_requested")
        assert restarts == 1, f"the restart command ran {restarts} times"
        print("commands: at most once through the real server, including restart and a legacy key")

        if args.renderer:
            daemon_log_path = os.path.join(work, "tilecastd.log")
            renderer = Renderer(args, runtime, work)
            processes.append(renderer.start())

            last_assignment = {}

            def reported(version):
                _, assignment = client.call("GET", f"/api/v1/screens/{screen_id}/playlist-assignment", expect=200)
                data = assignment["data"] or {}
                last_assignment.update(data)
                return data if data.get("playerActiveManifestVersion") == version else None

            # An uploaded image and video in a published playlist.
            media = os.path.join(work, "media")
            os.makedirs(media)
            ffmpeg = lambda *argv: run(tools["ffmpeg"], "-loglevel", "error", "-y", *argv)  # noqa: E731
            ffmpeg("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=1", "-frames:v", "1",
                   os.path.join(media, "still.png"))
            ffmpeg("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4", "-c:v", "libx264",
                   "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                   os.path.join(media, "clip.mp4"))
            image = upload(client, os.path.join(media, "still.png"), "image/png")
            video = upload(client, os.path.join(media, "clip.mp4"), "video/mp4")
            _, playlist = client.call("POST", "/api/v1/playlists",
                                      {"name": "Lobby loop", "description": "", "sourceType": "static"},
                                      expect=(200, 201))
            playlist_id = playlist["data"]["id"]
            client.call("POST", f"/api/v1/playlists/{playlist_id}/items", item(image["id"], 3000), expect=(200, 201))
            _, playlist = client.call("POST", f"/api/v1/playlists/{playlist_id}/items", item(video["id"]),
                                      expect=(200, 201))
            client.call("POST", f"/api/v1/playlists/{playlist_id}/publish",
                        {"expectedDraftRevision": playlist["data"]["draftRevision"]}, expect=(200, 201))
            mark = os.path.getsize(daemon_log_path)
            _, assignment = client.call("PUT", f"/api/v1/screens/{screen_id}/playlist-assignment",
                                        {"playlistId": playlist_id}, expect=200)
            playlist_version = assignment["data"]["manifestVersion"]
            wait_for(lambda: evidence(daemon_log_path, mark, ("image_shown", "video_progress", "item_transition")),
                     "image and video playback evidence", timeout=180)
            try:
                shown = wait_for(lambda: reported(playlist_version), "the heartbeat to report the playlist", timeout=150)
            except AssertionError:
                print("assignment:", {k: v for k, v in last_assignment.items() if "anifest" in k or "current" in k})
                print("screen:", client.call("GET", f"/api/v1/screens/{screen_id}")[1]["data"].get("lastHeartbeatAt"))
                subprocess.run(["psql", "-d", DATABASE, "-c",
                                "SELECT screen_id, active_manifest_version, playback_state, updated_at "
                                "FROM screen_player_status"], check=False)
                raise
            assert shown["selectionSource"] == "direct_fallback", shown
            assert shown["currentPlaylistId"] == playlist_id, shown
            print("playlist: manifest", playlist_version, "committed and reported; item", shown.get("currentItemId"))

            def published_layout(name, widget_config):
                _, widget = client.call("POST", "/api/v1/widgets", {**widget_config, "name": name, "description": ""},
                                        expect=(200, 201))
                _, layout = client.call("POST", "/api/v1/layouts", {
                    "name": name, "description": "", "orientation": "landscape",
                    "canvasWidth": 1920, "canvasHeight": 1080}, expect=(200, 201))
                layout_id = layout["data"]["id"]
                document = {"schemaVersion": 2,
                            "canvas": {"width": 1920, "height": 1080, "orientation": "landscape",
                                       "backgroundColor": "#101820", "safeAreaPercent": 0,
                                       "backgroundAssetId": image["id"]},
                            "placements": [{"id": str(uuid.uuid4()), "type": "widget", "name": name, "x": 160,
                                            "y": 140, "width": 800, "height": 600, "layer": 1, "opacity": 1,
                                            "visible": True, "locked": False, "widgetId": widget["data"]["id"]}]}
                _, layout = client.call("PUT", f"/api/v1/layouts/{layout_id}/draft",
                                        {"expectedDraftRevision": layout["data"]["draftRevision"],
                                         "document": document}, expect=200)
                client.call("POST", f"/api/v1/layouts/{layout_id}/publish",
                            {"expectedDraftRevision": layout["data"]["draftRevision"]}, expect=(200, 201))
                return layout_id

            # Time-bound widgets: the shared runtime keeps a Clock ticking in
            # place, so Edge reports environment.time and the server accepts
            # the assignment.
            clock = published_layout("Lobby clock", {"provider": "clock", "configuration": {
                "timezone": "UTC", "format": "24", "showSeconds": False,
                "foregroundColor": "#ffffff", "backgroundColor": "#111111"}})
            mark = os.path.getsize(daemon_log_path)
            _, assignment = client.call("PUT", f"/api/v1/screens/{screen_id}/playlist-assignment",
                                        {"layoutId": clock}, expect=200)
            clock_version = assignment["data"]["manifestVersion"]
            wait_for(lambda: evidence(daemon_log_path, mark, ("layout_shown",)), "clock layout evidence", timeout=180)
            wait_for(lambda: reported(clock_version), "the heartbeat to report the clock layout", timeout=150)
            print("clock: manifest", clock_version, "shown with a ticking clock")

            # A published Layout with a QR Code Widget over the uploaded
            # image, assigned directly.
            layout_id = published_layout("Visit us", {"provider": "qrcode", "configuration": {
                "value": "https://tilecast.example/visit", "label": "Visit us", "errorCorrection": "medium",
                "foregroundColor": "#ffffff", "backgroundColor": "#111111"}})
            mark = os.path.getsize(daemon_log_path)
            _, assignment = client.call("PUT", f"/api/v1/screens/{screen_id}/playlist-assignment",
                                        {"layoutId": layout_id}, expect=200)
            layout_version = assignment["data"]["manifestVersion"]
            wait_for(lambda: evidence(daemon_log_path, mark, ("layout_shown", "layout_zone_rendered")), "layout evidence",
                     timeout=180)
            wait_for(lambda: reported(layout_version), "the heartbeat to report the layout", timeout=150)
            print("layout: manifest", layout_version, "committed through the reference projection")

            # Studio live preview: a lease makes Edge ask the renderer for a
            # snapshot and upload the bounded JPEG it encodes.
            client.call("POST", f"/api/v1/screens/{screen_id}/preview-session", {"forceCapture": True}, expect=200)
            preview = wait_for(lambda: (lambda data: data if data.get("imageAvailable") else None)(
                client.call("GET", f"/api/v1/screens/{screen_id}/preview", expect=200)[1]["data"]),
                "a live preview from the renderer", timeout=90)
            assert not preview.get("captureFailureStatus"), preview
            assert 0 < preview["width"] <= 960 and 0 < preview["height"] <= 540, preview
            with client.opener.open(urllib.request.Request(
                    f"{BASE}/api/v1/screens/{screen_id}/preview/image"), timeout=10) as response:
                jpeg = response.read()
            assert jpeg[:3] == b"\xff\xd8\xff" and jpeg[-2:] == b"\xff\xd9", jpeg[:8]
            assert len(jpeg) == preview["fileSize"] <= 500 * 1024, (len(jpeg), preview)
            print("preview:", f"{preview['width']}x{preview['height']} JPEG of {len(jpeg)} bytes from the renderer")

            # Offline: the committed Layout plays from the cache with the
            # server stopped and the player restarted.
            server = processes[0]
            renderer.stop()
            processes.remove(renderer.process)
            daemon.send_signal(signal.SIGTERM)
            assert daemon.wait(timeout=20) == 0, "tilecastd did not stop cleanly"
            processes.remove(daemon)
            server.terminate()
            server.wait(timeout=20)
            mark = os.path.getsize(daemon_log_path)
            daemon = subprocess.Popen([tilecastd, "--config", config, "run"], stdout=daemon_log, stderr=subprocess.STDOUT)
            processes.append(daemon)
            processes.append(renderer.start())
            wait_for(lambda: evidence(daemon_log_path, mark, ("layout_shown",)), "cached layout offline", timeout=120)
            offline = json.loads(subprocess.run([tilecastctl, "--socket", socket, "--json", "status"], check=True,
                                                capture_output=True, text=True).stdout)
            assert offline["link"]["state"] == "retrying", offline["link"]
            assert offline["renderer"]["state"] == "healthy", offline["renderer"]
            print("offline: committed layout restored from cache without the server")
            renderer.stop()
            processes.remove(renderer.process)
            processes[0] = subprocess.Popen([server_bin], env=env, stdout=server_log, stderr=subprocess.STDOUT)
            wait_for(lambda: client.call("GET", "/readyz")[0] == 200, "server readiness after restart")

        # M5: a clean installation with no legacy state pairs through the
        # ordinary protocol and connects.
        fresh_state, fresh_runtime = os.path.join(work, "fresh-state"), os.path.join(work, "fresh-run")
        fresh_config = os.path.join(work, "fresh.toml")
        with open(fresh_config, "w") as handle:
            handle.write(f'[paths]\nstate_dir = "{fresh_state}"\nruntime_dir = "{fresh_runtime}"\n[log]\nformat = "text"\n')
        fresh_log = open(os.path.join(work, "fresh.log"), "w")
        fresh = subprocess.Popen([tilecastd, "--config", fresh_config, "run"], stdout=fresh_log, stderr=subprocess.STDOUT)
        processes.append(fresh)
        fresh_socket = os.path.join(fresh_runtime, "edge.sock")
        wait_for(lambda: os.path.exists(fresh_socket), "the fresh daemon's socket")
        refused = subprocess.run([tilecastctl, "--socket", fresh_socket, "pair", "http://signs.example.org"],
                                 capture_output=True, text=True)
        assert refused.returncode != 0 and "https" in refused.stderr, refused.stderr
        run(tilecastctl, "--socket", fresh_socket, "pair", BASE)

        def fresh_status():
            return json.loads(subprocess.run([tilecastctl, "--socket", fresh_socket, "--json", "status"],
                                             check=True, capture_output=True, text=True).stdout)

        code = wait_for(lambda: (fresh_status().get("pairing") or {}).get("code"), "the pairing code")
        _, resolved = client.call("POST", "/api/v1/screens/pairing/resolve", {"code": code}, expect=200)
        client.call("POST", f"/api/v1/screens/pairing/{resolved['data']['id']}/approve", {"name": "Fresh lobby"},
                    expect=200)
        paired = wait_for(lambda: (lambda status: status if status["link"]["state"] == "connected" else None)(
            fresh_status()), "the fresh screen to connect", timeout=120)
        assert paired["server"]["hasDeviceCredential"], paired
        assert paired["playerId"], paired
        fresh_screen = paired["server"]["screenId"]
        wait_for(lambda: (lambda response: response[0] == 200 and response[1]["data"].get("lastHeartbeatAt"))(
            client.call("GET", f"/api/v1/screens/{fresh_screen}")), "the fresh screen's heartbeat")
        assert not os.path.exists(os.path.join(fresh_state, "identity", "pairing-session")), "pairing secrets remain"
        with open(os.path.join(fresh_state, "state.db"), "rb") as handle:
            assert b"tc_device_" not in handle.read(), "the credential reached SQLite"
        fresh.send_signal(signal.SIGTERM)
        assert fresh.wait(timeout=20) == 0
        processes.remove(fresh)
        print("pairing: a clean installation paired, was approved and connected")

        if args.renderer:
            # M6: two players in one synchronized group. Each is its own
            # tilecastd and WPE runtime; only the server's group epoch and
            # the manifest's item durations tie them together.
            ffmpeg("-f", "lavfi", "-i", "color=c=0x1d4ed8:size=1280x720", "-frames:v", "1",
                   os.path.join(media, "wall.png"))
            wall = upload(client, os.path.join(media, "wall.png"), "image/png")
            _, loop = client.call("POST", "/api/v1/playlists",
                                  {"name": "Wall loop", "description": "", "sourceType": "static"}, expect=(200, 201))
            loop_id = loop["data"]["id"]
            client.call("POST", f"/api/v1/playlists/{loop_id}/items", item(image["id"], 3000), expect=(200, 201))
            _, loop = client.call("POST", f"/api/v1/playlists/{loop_id}/items", item(wall["id"], 3000),
                                  expect=(200, 201))
            client.call("POST", f"/api/v1/playlists/{loop_id}/publish",
                        {"expectedDraftRevision": loop["data"]["draftRevision"]}, expect=(200, 201))
            _, group = client.call("POST", "/api/v1/screen-groups", {"name": "Lobby wall", "description": ""},
                                   expect=(200, 201))
            group_id = group["data"]["id"]
            for member in (screen_id, fresh_screen):
                client.call("POST", f"/api/v1/screen-groups/{group_id}/screens", {"screenId": member}, expect=200)
            _, group = client.call("PUT", f"/api/v1/screen-groups/{group_id}/playlist-assignment",
                                   {"playlistId": loop_id}, expect=200)
            epoch = unix_ms(group["data"]["playbackEpoch"])

            with open(fresh_config, "a") as handle:
                handle.write(f'[renderer]\nbinary = "{args.renderer}"\nstall_threshold_seconds = 60\n')
            fresh = subprocess.Popen([tilecastd, "--config", fresh_config, "run"], stdout=fresh_log,
                                     stderr=subprocess.STDOUT)
            processes.append(fresh)
            walls = [Renderer(args, runtime, work), Renderer(args, fresh_runtime, work, "fresh-renderer.log")]
            for wall_renderer in walls:
                processes.append(wall_renderer.start())
            sockets = [socket, fresh_socket]
            logs = [daemon_log_path, os.path.join(work, "fresh.log")]

            def on(member, version=None):
                _, assignment = client.call("GET", f"/api/v1/screens/{member}/playlist-assignment", expect=200)
                data = assignment["data"] or {}
                return (data.get("currentPlaylistId") == loop_id
                        and data.get("playerActiveManifestVersion") == (version or data.get("manifestVersion")))

            wait_for(lambda: on(screen_id) and on(fresh_screen), "both players on the group loop", timeout=240)

            def shared_timeline(durations, seconds, label):
                """Both players' item starts fall on the epoch's boundary grid
                and on each other's. The first sample of each may predate the
                window (or be a late join), so it is not a boundary."""
                starts = [found[1:] for found in item_starts(tilecastctl, sockets, seconds)]
                expected = seconds * 1000 // max(durations) - 1
                for index, found in enumerate(starts):
                    print(f"sync {label}: player {index} phases",
                          [grid_phase_ms(at, epoch, durations) for _, at in found])
                for found in starts:
                    assert len(found) >= expected, f"{label}: only {len(found)} boundaries in {seconds}s: {found}"
                    for _, at in found:
                        phase = grid_phase_ms(at, epoch, durations)
                        assert -20 <= phase <= 250, f"{label}: a start is {phase} ms off the shared grid"
                skews = []
                for item_id, at in starts[0]:
                    other = [b for i, b in starts[1] if i == item_id and abs(b - at) < min(durations) / 2]
                    if other:
                        skews.append(abs(other[0] - at))
                print(f"sync {label}: skews {skews}")
                assert len(skews) >= expected, f"{label}: players did not share boundaries: {starts}"
                assert max(skews) <= 250, f"{label}: boundary skew {max(skews)} ms"
                print(f"sync {label}: {len(skews)} shared boundaries, skew mean "
                      f"{sum(skews) / len(skews):.1f} ms, max {max(skews)} ms")

            shared_timeline([3000, 3000], 20, "two players")

            # A renderer crash: the restarted runtime re-reads the corrected
            # wall clock once and rejoins the group mid-cycle.
            walls[1].process.kill()
            walls[1].process.wait(timeout=10)
            processes.remove(walls[1].process)
            processes.append(walls[1].start())
            time.sleep(8)
            shared_timeline([3000, 3000], 15, "after a renderer crash")

            # A pending manifest (a third item) activates on a shared boundary
            # on both players and moves both onto the new grid together.
            marks = [os.path.getsize(path) for path in logs]

            def versions():
                # Manifest versions are per screen.
                return [client.call("GET", f"/api/v1/screens/{member}/playlist-assignment", expect=200)[1]["data"]
                        ["manifestVersion"] for member in (screen_id, fresh_screen)]

            before = versions()
            _, loop = client.call("POST", f"/api/v1/playlists/{loop_id}/items", item(wall["id"], 2000),
                                  expect=(200, 201))
            client.call("POST", f"/api/v1/playlists/{loop_id}/publish",
                        {"expectedDraftRevision": loop["data"]["draftRevision"]}, expect=(200, 201))
            grown = wait_for(lambda: (lambda now: now if all(a > b for a, b in zip(now, before)) else None)(versions()),
                             "the grown loop's manifests")

            def activated_on_boundary(path, mark, version):
                with open(path, encoding="utf-8", errors="replace") as handle:
                    handle.seek(mark)
                    lines = [line for line in handle.read().splitlines() if "activation_started" in line]
                return any(f"version={version} " in line and "boundary=true" in line for line in lines)

            wait_for(lambda: all(activated_on_boundary(*args) for args in zip(logs, marks, grown)),
                     "the grown loop to activate on a shared boundary", timeout=180)
            time.sleep(4)
            shared_timeline([3000, 3000, 2000], 20, "after a pending manifest")
            for wall_renderer in walls:
                wall_renderer.stop()
                processes.remove(wall_renderer.process)
            fresh.send_signal(signal.SIGTERM)
            assert fresh.wait(timeout=20) == 0
            processes.remove(fresh)

        daemon.send_signal(signal.SIGTERM)
        assert daemon.wait(timeout=20) == 0, "tilecastd did not stop cleanly"
        processes.remove(daemon)

        # Revocation while the daemon is stopped: on restart the server
        # rejects the credential and only then is it deleted.
        client.call("POST", f"/api/v1/screens/{screen_id}/revoke", {}, expect=204)
        daemon = subprocess.Popen([tilecastd, "--config", config, "run"], stdout=daemon_log, stderr=subprocess.STDOUT)
        processes.append(daemon)
        credential_path = os.path.join(state, "identity", "device-credential")
        wait_for(lambda: not os.path.exists(credential_path), "credential removal after revocation")
        assert tree(legacy) == before, "legacy state changed"
        print("PASS: import, identity gate, player contact, configuration, commands, "
              + ("content, offline cache, " if args.renderer else "") + "fresh pairing, "
              + ("synchronized group, " if args.renderer else "") + "revocation")
        return 0
    except Exception:
        for name in ("server.log", "tilecastd.log", "fresh.log", "renderer.log", "fresh-renderer.log"):
            path = os.path.join(work, name)
            if os.path.exists(path):
                print(f"==== {name}", file=sys.stderr)
                with open(path) as handle:
                    text = handle.read()
                if name == "server.log":
                    notable = [line for line in text.splitlines()
                               if '"level":"WARN"' in line or '"level":"ERROR"' in line or "/player/" in line]
                    print("\n".join(notable[-40:]), file=sys.stderr)
                else:
                    print(text[-6000:], file=sys.stderr)
        raise
    finally:
        for process in processes:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        subprocess.run(["dropdb", "--if-exists", DATABASE], check=False)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
