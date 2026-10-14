#!/usr/bin/env python3
"""Real WPE surface ABI qualification through verified CAS and preview upload.

The Runtime copy enables the private frame channel for this test only. This
does not enable a production capability or qualify the OS process sandbox.
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
import shutil
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


class SurfaceState(WidgetState):
    def __init__(self, installation, screen, server_url, video):
        super().__init__(installation, screen, server_url)
        with open(os.path.join(repo_root(), "packages/manifest-schema/external-plugin-entry-fixture.json")) as handle:
            self.entry = json.load(handle)
        with open(os.path.join(repo_root(), "packages/package-sdk/test-fixtures/player-surface-probe.js")) as handle:
            self.plugin_frame = assemble(handle.read() + PASSIVE_VECTORS % json.dumps(self.canary), True).encode()
        self.entry["package"]["frame"].update({
            "sha256": hashlib.sha256(self.plugin_frame).hexdigest(), "fileSize": len(self.plugin_frame),
        })
        self.entry["validUntil"] = self.deadline(300)
        self.entry["state"] = {"color": "#00ff00"}
        self.base = super().manifest()
        self.base.update({"schemaVersion": 20, "widgets": [], "layouts": [], "dataSources": []})
        self.video = video
        self.base["assets"][0].update({
            "mimeType": "video/mp4", "fileSize": len(video), "sha256": hashlib.sha256(video).hexdigest(),
        })
        self.base["playlist"]["items"] = [{
            "id": self.item_full, "assetId": self.hero, "variantId": self.hero_variant,
            "assetType": "video", "durationMs": 300000, "fitMode": "fill", "transition": "none",
            "audioEnabled": False, "volume": 0.0, "deliveryPolicy": "download",
        }]
        self.previews = []
        self.plugin_requests = 0
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


def pixels(jpeg, color):
    """Count distinctive fixture pixels using the existing FFmpeg dependency."""
    raw = subprocess.run([
        "ffmpeg", "-loglevel", "error", "-f", "image2pipe", "-i", "pipe:0",
        "-vf", "scale=128:72", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], input=jpeg, capture_output=True, check=True).stdout
    assert len(raw) == 128 * 72 * 3
    if color == "green":
        return sum(g > 180 and r < 80 and b < 80 for r, g, b in zip(raw[0::3], raw[1::3], raw[2::3]))
    if color == "red":
        return sum(r > 180 and g < 80 and b < 80 for r, g, b in zip(raw[0::3], raw[1::3], raw[2::3]))
    return sum(r > 180 and b > 180 and g < 80 for r, g, b in zip(raw[0::3], raw[1::3], raw[2::3]))


def preview(state, after, color, shown=True):
    with state.lock:
        frames = [jpeg for at, jpeg in state.previews if at >= after]
    if not frames:
        return None
    count = pixels(frames[-1], color)
    return count > 100 if shown else count == 0


def qualify(args):
    with tempfile.TemporaryDirectory() as workdir:
        # The host implementation stays capability-gated until qualification
        # passes. No production source or packaged profile is changed here.
        runtime = os.path.join(workdir, "runtime")
        shutil.copytree(args.runtime_dir, runtime)
        path = os.path.join(runtime, "tilecast-bridge.js")
        with open(path) as handle:
            bridge = handle.read()
        marker = "capabilities: Object.freeze({"
        assert bridge.count(marker) == 1
        with open(path, "w") as handle:
            handle.write(bridge.replace(marker, marker + "\n      externalPluginFrames: true,", 1))
        local_args = copy.copy(args)
        local_args.runtime_dir = runtime
        installation, screen = str(uuid.uuid4()), str(uuid.uuid4())
        video_path = os.path.join(workdir, "blue.mp4")
        subprocess.run([
            "ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=2",
            "-t", "300", "-c:v", "libx264", "-profile:v", "baseline", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", video_path,
        ], check=True)
        with open(video_path, "rb") as handle:
            video = handle.read()
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), SurfaceHandler)
        server_url = f"http://127.0.0.1:{server.server_address[1]}"
        state = SurfaceState(installation, screen, server_url, video)
        server.widget_state = state
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        stack = Stack(local_args, workdir)
        try:
            stack.start_daemon()
            stack.stop()
            inject_pairing(workdir, server_url, installation, screen)
            stack.start_daemon()
            stack.start_renderer()
            wait_for("the healthy renderer", lambda: healthy(stack), timeout=90)
            wait_for("verified surface ABI and isolated bridge",
                     lambda: preview(state, 0, "green"), timeout=120, interval=2)
            print("surface: verified frame executed with isolated DOM and native bridge")
            active = stack.status()["presentation"]
            assert active["accepted"] and active["evidence"], active
            generation = active["generation"]
            wait_for("native video progress", lambda: [e for e in accepted_evidence(stack) if e[0] == "video_progress"],
                     timeout=30)
            assert_no_exfil(state)
            with state.lock:
                assert state.plugin_requests > 0
                state.entry["state"] = {"color": "#ff00ff"}
                state.entry["validUntil"] = state.deadline(300)
                state.revision += 1
                mark = time.monotonic()
            wait_for("plugin-only state delivered on the same frame",
                     lambda: preview(state, mark, "magenta"), timeout=120, interval=2)
            assert stack.status()["presentation"]["generation"] == generation
            starts = [e for e in accepted_evidence(stack) if e[0] == "item_started"]
            assert len(starts) == 1, f"plugin refresh restarted the video: {starts}"
            print("surface: verified frame, isolated ABI and state refresh")
            with state.lock:
                state.corrupt = True
                state.entry["package"]["frame"]["sha256"] = hashlib.sha256(state.plugin_frame + b"changed").hexdigest()
                state.revision += 1
                mark = time.monotonic()
            wait_for("corrupt surface bytes refused", lambda: [b for b in state.heartbeats
                     if b.get("lastSynchronizationError") == "widget_frame_digest_invalid"],
                     timeout=120, interval=2)
            wait_for("last verified surface still visible", lambda: preview(state, mark + 60, "magenta"),
                     timeout=60, interval=2)
            assert stack.status()["presentation"]["generation"] == generation
            print("surface: corrupt replacement refused while verified surface and video keep playing")
            with state.lock:
                state.removed = True
                state.revision += 1
                mark = time.monotonic()
            wait_for("package surface removal", lambda: preview(state, mark + 65, "magenta", False),
                     timeout=120, interval=2)
            assert stack.status()["presentation"]["generation"] == generation
            print("surface: removal preserved the presentation generation")
        except Exception:
            with state.lock:
                captures = list(state.previews)
            print("surface preview colors:", [
                {color: pixels(jpeg, color) for color in ("green", "red", "magenta")}
                for _, jpeg in captures[-3:]
            ])
            stack.dump_logs()
            raise
        finally:
            server.shutdown()
            thread.join(timeout=10)
            stack.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin-dir", required=True)
    parser.add_argument("--renderer", required=True)
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--gst-plugin-dir", required=True)
    qualify(parser.parse_args())
