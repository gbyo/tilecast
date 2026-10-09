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

Usage: e2e_headless.py --bin-dir DIR --renderer PATH --runtime-dir DIR
                       [--web-helper PATH]
                       [--scenario status|fixture|reconnect|selftest|website|stream|all]
"""
import argparse
import hashlib
import http.server
import json
import os
import signal
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
                "evidence for every item kind",
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
        assert report["expectedItems"] == report["provenItems"] and len(report["expectedItems"]) == 4, report
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
    return seen if required <= seen else None


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
    }
    selected = scenarios.values() if args.scenario == "all" else [scenarios[args.scenario]]
    for scenario in selected:
        scenario(args)
    print("e2e: all scenarios passed")


if __name__ == "__main__":
    sys.exit(main())
