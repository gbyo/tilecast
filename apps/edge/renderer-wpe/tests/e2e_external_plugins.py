#!/usr/bin/env python3
"""Real WPE external Plugin surface qualification through the shipped Runtime.

The Runtime directory is the production assembly. This test never edits it:
the packaged WPE bridge must enable the plugin surface ABI by itself, and the
daemon must report the matching heartbeat capability. The same scenario runs
on an ordinary playlist and on a synchronized group playlist, so a plugin
change is proven not to disturb either playback path.

This qualifies the surface ABI in a real WPE engine with software rendering.
It does not qualify the WebKit process sandbox (the CI lane disables it) or
physical display hardware; see docs/external-plugins.md.
"""
import argparse
import copy
import datetime
import email.parser
import email.policy
import hashlib
import http.server
import json
import os
import re
import subprocess
import tempfile
import threading
import time
import uuid

from build_frame_doc import assemble, repo_root
from e2e_headless import (
    PASSIVE_VECTORS, Stack, WidgetHandler, WidgetState, accepted_evidence,
    assert_no_exfil, healthy, inject_pairing, wait_for,
)

VIDEO_SECONDS = 2400
PHASE_SECONDS = VIDEO_SECONDS // 2
# The synchronized timeline starts this far into the video: inside the second
# (yellow) half, with enough runway that the whole scenario stays inside it.
SYNC_OFFSET_SECONDS = PHASE_SECONDS + 100
# The Runtime refuses a plugin entry that is valid for more than five minutes,
# so the server keeps a surface alive by reissuing it. The scenario does the
# same; every reissue is itself a plugin-only revision.
LEASE_SECONDS = 240
REISSUE_SECONDS = 60
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def build_video(path):
    """A 40 minute H.264 video: blue for the first half, yellow for the second,
    with a running timestamp so any two captures differ while it plays."""
    graph = (
        f"[0:v][1:v]concat=n=2:v=1:a=0,drawtext=fontfile={FONT}:text='%{{pts\\:hms}}'"
        ":fontcolor=white:fontsize=40:box=1:boxcolor=black:boxborderw=6:x=w-tw-14:y=14"
    )
    subprocess.run([
        "ffmpeg", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"color=c=blue:s=320x180:r=10:d={PHASE_SECONDS}",
        "-f", "lavfi", "-i", f"color=c=yellow:s=320x180:r=10:d={PHASE_SECONDS}",
        "-filter_complex", graph, "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
        "-g", "20", "-movflags", "+faststart", path,
    ], check=True, timeout=900)


class SurfaceState(WidgetState):
    def __init__(self, installation, screen, server_url, video, synchronized):
        super().__init__(installation, screen, server_url)
        with open(os.path.join(repo_root(), "packages/manifest-schema/external-plugin-entry-fixture.json")) as handle:
            self.entry = json.load(handle)
        with open(os.path.join(repo_root(), "packages/package-sdk/test-fixtures/player-surface-probe.js")) as handle:
            self.plugin_frame = assemble(handle.read() + PASSIVE_VECTORS % json.dumps(self.canary), True).encode()
        self.entry["package"]["frame"].update({
            "sha256": hashlib.sha256(self.plugin_frame).hexdigest(), "fileSize": len(self.plugin_frame),
        })
        self.entry["validUntil"] = self.deadline(LEASE_SECONDS)
        self.entry["state"] = {"color": "#00ff00"}
        self.base = super().manifest()
        self.base.update({"schemaVersion": 20, "widgets": [], "layouts": [], "dataSources": []})
        self.video = video
        self.base["assets"][0].update({
            "mimeType": "video/mp4", "fileSize": len(video), "sha256": hashlib.sha256(video).hexdigest(),
        })
        self.base["playlist"]["items"] = [{
            "id": self.item_full, "assetId": self.hero, "variantId": self.hero_variant,
            "assetType": "video", "durationMs": VIDEO_SECONDS * 1000, "fitMode": "fill", "transition": "none",
            "audioEnabled": False, "volume": 0.0, "deliveryPolicy": "download",
        }]
        if synchronized:
            epoch = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=SYNC_OFFSET_SECONDS)
            self.base["syncGroup"] = {"id": "qualification-wall", "playbackEpoch": epoch.isoformat()}
        self.previews = []
        self.plugin_requests = 0
        self.media_requests_by_path = 0
        self.removed = False
        self.corrupt = False

    @staticmethod
    def deadline(seconds):
        return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=seconds)).isoformat()

    def manifest(self):
        result = copy.deepcopy(self.base)
        result["manifestVersion"] = self.revision
        result["plugins"] = [] if self.removed else [copy.deepcopy(self.entry)]
        return result


class SurfaceHandler(WidgetHandler):
    def do_GET(self):  # noqa: N802
        if self.path == f"/api/v1/player/assets/{self.state.hero}/variants/{self.state.hero_variant}" and self._authorized():
            with self.state.lock:
                self.state.media_requests_by_path += 1
            return self._send_bytes(self.state.video, "video/mp4")
        if self.path == "/api/v1/player/preview-session" and self._authorized():
            return self._send_json(200, {"data": {
                "active": True, "captureNow": True, "captureIntervalSeconds": 20,
            }})
        if self.path == self.state.entry["package"]["frame"]["downloadPath"] and self._authorized():
            with self.state.lock:
                self.state.plugin_requests += 1
                body = self.state.plugin_frame
                if self.state.corrupt:
                    body = body[:-1] + bytes([body[-1] ^ 1])
            return self._send_bytes(body, "text/html")
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        if self.path == "/api/v1/player/preview" and self._authorized():
            length = int(self.headers.get("Content-Length", "0"))
            assert 0 < length <= 2 * 1024 * 1024
            raw = self.rfile.read(length)
            message = email.parser.BytesParser(policy=email.policy.default).parsebytes(
                b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
            for part in message.iter_parts():
                if part.get_filename() == "preview.jpg":
                    with self.state.lock:
                        self.state.previews.append((time.monotonic(), part.get_payload(decode=True)))
            return self._send_json(200, {"data": {}})
        return super().do_POST()


def decode(jpeg, filters):
    return subprocess.run([
        "ffmpeg", "-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0",
        "-vf", filters, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], input=jpeg, capture_output=True, check=True, timeout=30).stdout


def pixels(jpeg, color):
    """Count distinctive fixture pixels using the existing FFmpeg dependency."""
    raw = decode(jpeg, "scale=128:72")
    assert len(raw) == 128 * 72 * 3
    triples = list(zip(raw[0::3], raw[1::3], raw[2::3]))
    if color == "green":
        return sum(g > 180 and r < 80 and b < 80 for r, g, b in triples)
    if color == "red":
        return sum(r > 180 and g < 80 and b < 80 for r, g, b in triples)
    if color == "blue":
        return sum(b > 180 and r < 80 and g < 80 for r, g, b in triples)
    if color == "yellow":
        return sum(r > 180 and g > 180 and b < 80 for r, g, b in triples)
    return sum(r > 180 and b > 180 and g < 80 for r, g, b in triples)


def video_signature(jpeg):
    """The timestamp area of the video, away from the bottom-left surface."""
    return decode(jpeg, "crop=iw/2:ih/3:iw/2:0,scale=96:36,format=gray")


def video_moved(first, second):
    changed = sum(abs(a - b) > 60 for a, b in zip(video_signature(first), video_signature(second)))
    return changed >= 6


def preview(state, after, color, shown=True):
    with state.lock:
        frames = [jpeg for at, jpeg in state.previews if at >= after]
    if not frames:
        return None
    count = pixels(frames[-1], color)
    return count > 100 if shown else count == 0


def previews_after(state, after):
    with state.lock:
        return [(at, jpeg) for at, jpeg in state.previews if at >= after]


def assert_video_playing(state, mark, label, background, timeout=150):
    """The video keeps its place and moves: two captures taken at least ten
    seconds apart after the change show the same video half and a different
    timestamp. The daemon can upload one capture twice, so equal-time
    captures do not count."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frames = previews_after(state, mark)
        if frames and frames[-1][0] - frames[0][0] >= 10:
            break
        time.sleep(2)
    else:
        raise AssertionError(f"{label}: no two captures ten seconds apart after the change")
    first, last = frames[0][1], frames[-1][1]
    assert pixels(first, background) > 100 and pixels(last, background) > 100, \
        f"{label}: the video left its {background} half of the timeline"
    assert video_moved(first, last), f"{label}: the video stopped progressing"


def activations(stack):
    """How many activations the daemon has issued so far."""
    with open(os.path.join(stack.workdir, "tilecastd.log"), encoding="utf-8", errors="replace") as handle:
        return sum(1 for line in handle if "activation_issued" in line)


def assert_shipped_bridge(runtime_dir):
    """The qualified Runtime is exactly what ships: no test-time injection."""
    path = os.path.join(runtime_dir, "tilecast-bridge.js")
    with open(path, encoding="utf-8") as handle:
        packaged = handle.read()
    with open(os.path.join(repo_root(), "apps/edge/renderer-wpe/web/tilecast-bridge.js"), encoding="utf-8") as handle:
        source = handle.read()
    assert packaged == source, "the assembled bridge differs from the shipped source"
    assert len(re.findall(r"^\s*externalPluginFrames: true,$", packaged, re.M)) == 1, \
        "the packaged WPE bridge does not enable external plugin frames"
    assert "externalFrames: true" in packaged


def assert_capability_reported(state):
    with state.lock:
        beats = [b.get("nativePresentationCapabilities", {}) for b in state.heartbeats]
    ours = [native for native in beats if native.get("plugin.external-runtime") == 1]
    assert ours, "no heartbeat reported plugin.external-runtime: 1"
    for native in ours:
        assert native.get("widget.external-runtime") == 2, native
        assert native["plugin.external-runtime"] == 1


def reissue_leases(state, stop):
    while not stop.wait(REISSUE_SECONDS):
        with state.lock:
            state.entry["validUntil"] = state.deadline(LEASE_SECONDS)
            state.revision += 1


def qualify(args, synchronized):
    name = "synchronized" if synchronized else "plain"
    assert_shipped_bridge(args.runtime_dir)
    with tempfile.TemporaryDirectory() as workdir:
        installation, screen = str(uuid.uuid4()), str(uuid.uuid4())
        video_path = os.path.join(workdir, "timeline.mp4")
        build_video(video_path)
        with open(video_path, "rb") as handle:
            video = handle.read()
        # The synchronized timeline starts in the second half, a plain
        # playlist at the beginning.
        background = "yellow" if synchronized else "blue"
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SurfaceHandler)
        server_url = f"http://127.0.0.1:{server.server_address[1]}"
        state = SurfaceState(installation, screen, server_url, video, synchronized)
        server.widget_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        stack = Stack(args, workdir)
        stop = threading.Event()
        threading.Thread(target=reissue_leases, args=(state, stop), daemon=True).start()
        try:
            stack.start_daemon()
            stack.stop()
            inject_pairing(workdir, server_url, installation, screen)
            stack.start_daemon()
            stack.start_renderer()
            wait_for("the healthy renderer", lambda: healthy(stack), timeout=90)
            wait_for("verified surface ABI and isolated bridge",
                     lambda: preview(state, 0, "green"), timeout=120, interval=2)
            print(f"[{name}] surface: verified frame executed with isolated DOM and native bridge")
            active = stack.status()["presentation"]
            assert active["accepted"] and active["evidence"], active
            generation = active["generation"]
            wait_for("native video progress", lambda: [e for e in accepted_evidence(stack) if e[0] == "video_progress"],
                     timeout=30)
            issued = activations(stack)
            assert_capability_reported(state)
            assert_no_exfil(state)
            with state.lock:
                assert state.plugin_requests > 0
                mark = time.monotonic()
            assert_video_playing(state, mark, "added surface", background)
            print(f"[{name}] video: {background} half of the timeline, progressing")

            def assert_presentation_unchanged(label):
                current = stack.status()["presentation"]
                assert current["generation"] == generation, f"{label}: new presentation generation"
                assert activations(stack) == issued, f"{label}: a plugin change activated a presentation"
                starts = [e for e in accepted_evidence(stack) if e[0] == "item_started"]
                assert len(starts) == 1, f"{label}: restarted the video item: {starts}"

            # Plugin-only state on the same verified frame.
            with state.lock:
                state.entry["state"] = {"color": "#ff00ff"}
                state.entry["validUntil"] = state.deadline(LEASE_SECONDS)
                state.revision += 1
                mark = time.monotonic()
                requests = state.plugin_requests
            wait_for("plugin-only state delivered on the same frame",
                     lambda: preview(state, mark, "magenta"), timeout=120, interval=2)
            assert_presentation_unchanged("state update")
            with state.lock:
                assert state.plugin_requests == requests, "a state update fetched the retained frame again"
            assert_video_playing(state, mark, "state update", background)
            wait_for("surface survives lease reissue", lambda: preview(state, mark + 30, "magenta"),
                     timeout=120, interval=2)
            assert_presentation_unchanged("lease reissue")
            print(f"[{name}] surface: state refresh on the same frame; lease reissues keep it")

            with state.lock:
                state.corrupt = True
                state.entry["package"]["frame"]["sha256"] = hashlib.sha256(state.plugin_frame + b"changed").hexdigest()
                state.revision += 1
                mark = time.monotonic()
            wait_for("corrupt surface bytes refused", lambda: [b for b in state.heartbeats
                     if b.get("lastSynchronizationError") == "widget_frame_digest_invalid"],
                     timeout=120, interval=2)
            wait_for("last verified surface still visible", lambda: preview(state, mark + 30, "magenta"),
                     timeout=90, interval=2)
            assert_presentation_unchanged("corrupt replacement")
            assert_video_playing(state, mark, "corrupt replacement", background)
            print(f"[{name}] surface: corrupt replacement refused; verified surface and video keep playing")

            with state.lock:
                state.removed = True
                state.revision += 1
                mark = time.monotonic()
            wait_for("package surface removal", lambda: preview(state, mark + 30, "magenta", False),
                     timeout=120, interval=2)
            assert_presentation_unchanged("removal")
            assert_video_playing(state, mark, "removal", background)
            assert_no_exfil(state)
            print(f"[{name}] surface: removal cleared only the plugin; video continued on its timeline")

            # A surface that tries to navigate its own document or reload is
            # failed closed by the Runtime. Whatever it does to itself, the
            # trusted Runtime, the presentation and the video stay in place
            # and nothing reaches the network. The engine-level refusal is
            # proven by test-frame-navigation in the same lane.
            with state.lock:
                state.removed = False
                state.corrupt = False
                state.entry["package"]["frame"]["sha256"] = hashlib.sha256(state.plugin_frame).hexdigest()
                state.entry["state"] = {"color": "#00ff00", "navigationProbe": True}
                state.entry["validUntil"] = state.deadline(LEASE_SECONDS)
                state.revision += 1
                mark = time.monotonic()
                target = state.revision
            # The probe acts within a second, so no capture shows the surface.
            wait_for("probing surface promoted", lambda: [b for b in state.heartbeats
                     if b.get("activeManifestVersion", 0) >= target], timeout=120, interval=2)
            assert_video_playing(state, mark + 5, "navigation probe", background)
            assert_presentation_unchanged("navigation probe")
            assert_no_exfil(state)
            assert healthy(stack), "the renderer is not healthy after the navigation probe"
            print(f"[{name}] surface: navigation and reload attempts left Runtime and video untouched")
        except Exception:
            with state.lock:
                captures = list(state.previews)
            artifacts = os.environ.get("TILECAST_E2E_ARTIFACT_DIR")
            if artifacts:
                for index, (at, jpeg) in enumerate(captures):
                    with open(os.path.join(artifacts, f"{name}-preview-{index:02d}-t{int(at)}.jpg"), "wb") as handle:
                        handle.write(jpeg)
                with state.lock:
                    print("last heartbeat:", json.dumps(state.heartbeats[-1:], default=str)[:1500])
                    print("plugin frame requests:", state.plugin_requests)
            print("surface preview colors:", [
                {color: pixels(jpeg, color) for color in ("green", "red", "magenta", "blue", "yellow")}
                for _, jpeg in captures[-3:]
            ])
            stack.dump_logs()
            raise
        finally:
            stop.set()
            server.shutdown()
            thread.join(timeout=10)
            stack.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin-dir", required=True)
    parser.add_argument("--renderer", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--gst-plugin-dir", required=True)
    parser.add_argument("--variant", choices=("plain", "synchronized", "all"), default="all")
    parsed = parser.parse_args()
    for variant in ("plain", "synchronized"):
        if parsed.variant in (variant, "all"):
            qualify(parsed, variant == "synchronized")
