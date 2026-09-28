"""A small client for the remote web protocol v1 (tests only).

docs/tilecast-edge-remote-web-threat-review.md §6. The trusted renderer is
the production client; this one lets the helper's tests and the end-to-end
scripts drive the real helper binary.
"""

import json
import os
import socket
import struct
import subprocess
import time


class Closed(Exception):
    pass


class Client:
    def __init__(self, path, timeout=10.0):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(timeout)
        self.sock.connect(path)
        self.events = []

    def close(self):
        self.sock.close()

    def send_raw(self, payload: bytes):
        self.sock.sendall(struct.pack(">I", len(payload)) + payload)

    def send(self, message):
        self.send_raw(json.dumps(message).encode())

    def _read(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise Closed()
            data += chunk
        return data

    def recv(self):
        (length,) = struct.unpack(">I", self._read(4))
        return json.loads(self._read(length))

    def hello(self):
        self.send({"type": "hello", "version": 1})
        welcome = self.recv()
        assert welcome["type"] == "welcome", welcome
        return welcome

    def create(self, surface_id, content, width=640, height=360, muted=True, visible=True):
        self.send({"type": "create", "surfaceId": surface_id, "width": width, "height": height,
                   "muted": muted, "visible": visible, "content": content})
        while True:
            message = self.recv()
            if message["type"] in ("created", "rejected") and message["surfaceId"] == surface_id:
                return message
            self.events.append(message)

    def wait_event(self, surface_id, kinds, timeout=20.0):
        """The first event of `surface_id` whose kind is in `kinds`."""
        deadline = time.monotonic() + timeout
        while True:
            for index, event in enumerate(self.events):
                if event.get("surfaceId") == surface_id and event.get("kind") in kinds:
                    return self.events.pop(index)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no {kinds} for {surface_id}; saw {self.events}")
            self.sock.settimeout(remaining)
            self.events.append(self.recv())

    def destroy(self, surface_id):
        self.send({"type": "destroy", "surfaceId": surface_id})

    def clear(self, request_id="c-1", timeout=20.0):
        self.send({"type": "clear-data", "requestId": request_id})
        deadline = time.monotonic() + timeout
        while True:
            self.sock.settimeout(max(deadline - time.monotonic(), 0.1))
            message = self.recv()
            if message.get("type") == "cleared" and message.get("requestId") == request_id:
                return message["ok"]
            self.events.append(message)


def page(url, hosts, cookies="first_party", javascript=True, storage=True, user_agent="", zoom=100,
         scroll=(0, 0), background="#000000"):
    return {"kind": "page", "url": url, "allowedHosts": hosts, "javascriptEnabled": javascript,
            "domStorageEnabled": storage, "cookiePolicy": cookies, "userAgent": user_agent, "zoomPercent": zoom,
            "scrollX": scroll[0], "scrollY": scroll[1], "backgroundColor": background}


def youtube(video=None, playlist=None, start=0, end=None, loop=False, muted=True, volume=100, captions=False,
            language="", controls=False):
    return {"kind": "youtube", "videoId": video, "playlistId": playlist, "startSeconds": start, "endSeconds": end,
            "loop": loop, "muted": muted, "volume": volume, "captions": captions, "captionLanguage": language,
            "controls": controls}


def frames_flow(frames_dir, capability, count=3, timeout=15):
    """True when `count` frames arrive on the capability's socket."""
    path = os.path.join(frames_dir, capability + ".sock")
    result = subprocess.run(
        ["gst-launch-1.0", "-q", "unixfdsrc", f"socket-path={path}", "num-buffers=%d" % count, "!", "fakesink"],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=timeout, check=False)
    return result.returncode == 0
