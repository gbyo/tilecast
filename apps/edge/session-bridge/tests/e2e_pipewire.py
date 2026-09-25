#!/usr/bin/env python3
"""tilecast-session-bridge against a real PipeWire and WirePlumber.

Runs a private session (D-Bus, PipeWire, WirePlumber) in a temporary
XDG_RUNTIME_DIR and plays the daemon's side of the Edge IPC socket. The
fake daemon checks every frame the bridge sends as strictly as tilecastd
decodes it: exact member sets, bounded numbers, per-direction sequence.

  no source     inventory says PipeWire is there with no source; asking for
                capture reports no_microphone
  tone          a pw-loopback virtual microphone fed with a 0.5 sine tone:
                capture reports levels near its RMS (0.354)
  silence       the tone stops: levels fall to near zero
  release       capture.set false: state idle, no further levels, and the
                bridge's PipeWire stream is gone from the graph
  no pipewire   PipeWire stops: inventory says unavailable

Usage: e2e_pipewire.py --bridge PATH
"""
import argparse
import json
import math
import os
import queue
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

LEVEL_KEYS = {"rms", "state"}
INVENTORY_KEYS = {"pipewire", "sources", "sinks", "defaultSource", "defaultSink"}
STATES = {"idle", "starting", "capturing", "no_microphone", "pipewire_unavailable", "permission_denied",
          "capture_failed", "recovering"}


def fail(message):
    raise AssertionError(message)


def check_event(name, data):
    """The bridge's events, decoded as strictly as edge_protocol does."""
    if name == "audio.level":
        if set(data) != LEVEL_KEYS:
            fail(f"audio.level members {sorted(data)}")
        if data["state"] not in STATES:
            fail(f"unknown state {data['state']!r}")
        rms = data["rms"]
        if data["state"] == "capturing":
            if not isinstance(rms, (int, float)) or isinstance(rms, bool) or not 0 <= rms <= 1:
                fail(f"capturing without a bounded level: {data}")
        elif rms is not None:
            fail(f"a level outside capture: {data}")
    elif name == "audio.inventory":
        if set(data) != INVENTORY_KEYS:
            fail(f"audio.inventory members {sorted(data)}")
        if data["pipewire"] not in ("available", "unavailable"):
            fail(f"pipewire {data['pipewire']!r}")
        for key in ("sources", "sinks"):
            if not isinstance(data[key], int) or isinstance(data[key], bool) or not 0 <= data[key] <= 64:
                fail(f"{key} {data[key]!r}")
        for key in ("defaultSource", "defaultSink"):
            if not isinstance(data[key], bool):
                fail(f"{key} {data[key]!r}")
    else:
        fail(f"the bridge sent {name!r}")


class FakeDaemon:
    def __init__(self, path):
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(path)
        self.listener.listen(1)
        self.events = queue.Queue()
        self.connection = None
        self.outbound_seq = 1
        self.errors = []
        threading.Thread(target=self.serve, daemon=True).start()

    def read_frame(self, connection):
        header = self.read_exactly(connection, 4)
        (length,) = struct.unpack(">I", header)
        if length == 0 or length > 4 * 1024 * 1024:
            fail(f"frame length {length}")
        return json.loads(self.read_exactly(connection, length))

    @staticmethod
    def read_exactly(connection, count):
        data = b""
        while len(data) < count:
            chunk = connection.recv(count - len(data))
            if not chunk:
                raise EOFError
            data += chunk
        return data

    def write(self, frame):
        payload = json.dumps(frame).encode()
        self.connection.sendall(struct.pack(">I", len(payload)) + payload)

    def serve(self):
        try:
            connection, _ = self.listener.accept()
            hello = self.read_frame(connection)
            expected = {"type", "minProtocolVersion", "maxProtocolVersion", "role", "client", "clientVersion",
                        "features"}
            if set(hello) != expected or hello["role"] != "session_bridge" or hello["type"] != "hello":
                fail(f"hello {hello}")
            self.connection = connection
            self.write({"type": "welcome", "protocolVersion": 1, "sessionId": "0" * 8 + "-0000-4000-8000-" + "0" * 12,
                        "role": "session_bridge", "daemonVersion": "e2e", "features": [], "maxFrameBytes": 4194304})
            seq = 1
            while True:
                frame = self.read_frame(connection)
                if frame.get("type") == "goodbye":
                    self.events.put(("goodbye", frame))
                    return
                if set(frame) != {"type", "seq", "event", "data"} or frame["type"] != "event":
                    fail(f"frame {frame}")
                if frame["seq"] != seq:
                    fail(f"sequence {frame['seq']}, expected {seq}")
                seq += 1
                check_event(frame["event"], frame["data"])
                self.events.put((frame["event"], frame["data"]))
        except EOFError:
            self.events.put(("closed", None))
        except Exception as error:  # noqa: BLE001 - reported by the main thread
            self.errors.append(error)
            self.events.put(("error", repr(error)))

    def capture(self, enabled):
        self.write({"type": "event", "seq": self.outbound_seq, "event": "capture.set", "data": {"enabled": enabled}})
        self.outbound_seq += 1

    def wait(self, description, predicate, timeout=30):
        deadline = time.monotonic() + timeout
        seen = []
        while time.monotonic() < deadline:
            try:
                name, data = self.events.get(timeout=0.5)
            except queue.Empty:
                continue
            if name == "error":
                fail(f"protocol error: {data}")
            seen.append((name, data))
            if predicate(name, data):
                return data
        fail(f"timed out waiting for {description}; last events: {seen[-8:]}")


def start(argv, env, log):
    return subprocess.Popen(argv, env=env, stdout=log, stderr=subprocess.STDOUT)


def wait_path(path, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.exists(path):
            return
        time.sleep(0.1)
    fail(f"{path} never appeared")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", required=True)
    args = parser.parse_args()
    for tool in ("pipewire", "wireplumber", "pw-loopback", "pw-dump", "gst-launch-1.0", "dbus-daemon"):
        if shutil.which(tool) is None:
            fail(f"{tool} is not installed; the PipeWire test cannot run")

    work = tempfile.mkdtemp(prefix="tilecast-bridge-e2e-")
    runtime = os.path.join(work, "runtime")
    os.makedirs(runtime, mode=0o700)
    env = dict(os.environ, XDG_RUNTIME_DIR=runtime, PIPEWIRE_RUNTIME_DIR=runtime, ORC_CODE="backup",
               HOME=work, XDG_CONFIG_HOME=os.path.join(work, "config"), XDG_STATE_HOME=os.path.join(work, "state"))
    bus = os.path.join(runtime, "bus")
    env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus}"
    log_path = os.path.join(work, "session.log")
    log = open(log_path, "w")
    processes = []
    try:
        processes.append(start(["dbus-daemon", "--session", "--nofork", f"--address=unix:path={bus}"], env, log))
        wait_path(bus)
        pipewire = start(["pipewire"], env, log)
        processes.append(pipewire)
        wait_path(os.path.join(runtime, "pipewire-0"))
        processes.append(start(["wireplumber"], env, log))

        daemon = FakeDaemon(os.path.join(work, "edge.sock"))
        bridge_log = open(os.path.join(work, "bridge.log"), "w")
        bridge = subprocess.Popen([args.bridge, f"--socket={os.path.join(work, 'edge.sock')}"], env=env,
                                  stdout=bridge_log, stderr=subprocess.STDOUT)
        processes.append(bridge)

        inventory = daemon.wait("an inventory with PipeWire",
                                lambda n, d: n == "audio.inventory" and d["pipewire"] == "available")
        print(f"no source: inventory {inventory}")
        if inventory["sources"] == 0:
            daemon.capture(True)
            daemon.wait("no_microphone", lambda n, d: n == "audio.level" and d["state"] == "no_microphone", 20)
            daemon.capture(False)
            daemon.wait("idle", lambda n, d: n == "audio.level" and d["state"] == "idle")
            print("no source: capture reports no_microphone")

        # A virtual microphone: whatever plays into tc-tone-sink comes out of
        # the Audio/Source node tc-mic.
        processes.append(start(["pw-loopback", "--capture-props=media.class=Audio/Sink node.name=tc-tone-sink",
                                "--playback-props=media.class=Audio/Source node.name=tc-mic"], env, log))
        inventory = daemon.wait("the virtual source", lambda n, d: n == "audio.inventory" and d["sources"] >= 1
                                and d["defaultSource"])
        print(f"tone: inventory {inventory}")
        tone = start(["gst-launch-1.0", "-q", "audiotestsrc", "wave=sine", "freq=440", "volume=0.5", "is-live=true",
                      "!", "audioconvert", "!", "pipewiresink", "target-object=tc-tone-sink"], env, log)
        processes.append(tone)
        daemon.capture(True)
        expected = 0.5 / math.sqrt(2)
        level = daemon.wait("the tone's level",
                            lambda n, d: n == "audio.level" and d["state"] == "capturing"
                            and abs(d["rms"] - expected) < 0.08, 30)
        print(f"tone: rms {level['rms']:.3f} (sine at 0.5 is {expected:.3f})")

        tone.send_signal(signal.SIGINT)
        tone.wait(timeout=10)
        level = daemon.wait("silence", lambda n, d: n == "audio.level" and d["state"] == "capturing"
                            and d["rms"] < 0.02, 20)
        print(f"silence: rms {level['rms']:.4f}")

        daemon.capture(False)
        daemon.wait("idle", lambda n, d: n == "audio.level" and d["state"] == "idle")
        time.sleep(1.5)
        while not daemon.events.empty():
            name, data = daemon.events.get_nowait()
            if name == "audio.level" and data["state"] == "capturing":
                fail("a level arrived after capture was released")
        graph = json.loads(subprocess.run(["pw-dump"], env=env, capture_output=True, text=True, check=True).stdout)
        streams = [obj for obj in graph if obj.get("type") == "PipeWire:Interface:Node"
                   and "tilecast-session-bridge" in json.dumps(obj.get("info", {}).get("props", {}))
                   and obj["info"]["props"].get("media.class", "").startswith("Stream/Input")]
        if streams:
            fail(f"the bridge still holds a capture stream: {streams}")
        print("release: the capture stream is gone from the PipeWire graph")

        pipewire.terminate()
        pipewire.wait(timeout=10)
        daemon.wait("PipeWire unavailable",
                    lambda n, d: n == "audio.inventory" and d["pipewire"] == "unavailable", 20)
        print("no pipewire: inventory reports it unavailable")
        if daemon.errors:
            raise daemon.errors[0]
        print("session-bridge e2e: all scenarios passed")
    except Exception:
        for name in ("bridge.log", "session.log"):
            path = os.path.join(work, name)
            if os.path.exists(path):
                print(f"----- {name} -----")
                with open(path, errors="replace") as handle:
                    print(handle.read()[-20000:])
        raise
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
