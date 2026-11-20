#!/usr/bin/env python3
"""Stage 4 latency spike: the sender side, in place of UxPlay.

Sends a pre-encoded H.264 Annex B file as RTP (RFC 6184, single NAL units
and FU-A) to 127.0.0.1:42000 at its frame rate, and, with --audio, L16
stereo 44.1 kHz silence to 127.0.0.1:42002. These are the streams and
ports of UxPlay's `-vrtp` and `-artp` forward. The file alternates black
and white phases; the sender prints the wall-clock time at which the first
packet of each phase's first frame leaves:

    send white <unix microseconds>
    send black <unix microseconds>

It also answers the present grant on --media-socket, as tilecastd does.
"""
import argparse
import json
import os
import socket
import struct
import threading
import time

MTU_PAYLOAD = 1400


def access_units(data):
    """Splits Annex B into access units, each starting at an AUD (type 9)."""
    nals, i, n = [], 0, len(data)
    starts = []
    while i < n - 3:
        if data[i] == 0 and data[i + 1] == 0 and (data[i + 2] == 1 or (data[i + 2] == 0 and data[i + 3] == 1)):
            length = 3 if data[i + 2] == 1 else 4
            starts.append((i, i + length))
            i += length
        else:
            i += 1
    for index, (_, begin) in enumerate(starts):
        end = starts[index + 1][0] if index + 1 < len(starts) else n
        nals.append(data[begin:end].rstrip(b"\x00"))
    units, current = [], []
    for nal in nals:
        if nal and nal[0] & 0x1F == 9 and current:
            units.append(current)
            current = []
        if nal and nal[0] & 0x1F != 9:
            current.append(nal)
    if current:
        units.append(current)
    return units


def rtp_header(marker, payload_type, sequence, timestamp, ssrc):
    return struct.pack("!BBHII", 0x80, (0x80 if marker else 0) | payload_type, sequence & 0xFFFF, timestamp & 0xFFFFFFFF, ssrc)


def packetize(unit):
    """RTP payloads for one access unit (single NAL or FU-A)."""
    payloads = []
    for nal in unit:
        if len(nal) <= MTU_PAYLOAD:
            payloads.append(nal)
            continue
        header, body = nal[0], nal[1:]
        indicator = (header & 0xE0) | 28
        kind = header & 0x1F
        first = True
        while body:
            chunk, body = body[: MTU_PAYLOAD - 2], body[MTU_PAYLOAD - 2 :]
            fu = kind | (0x80 if first else 0) | (0x40 if not body else 0)
            payloads.append(bytes([indicator, fu]) + chunk)
            first = False
    return payloads


def serve_grant(path, audio):
    if os.path.exists(path):
        os.unlink(path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(8)
    reply = {"status": "ok", "videoPort": 42000}
    if audio:
        reply["audioPort"] = 42002
    body = json.dumps(reply, separators=(",", ":")).encode()
    while True:
        connection, _ = server.accept()
        with connection:
            size = struct.unpack("!I", connection.recv(4, socket.MSG_WAITALL))[0]
            request = json.loads(connection.recv(size, socket.MSG_WAITALL))
            assert request["op"] == "present", request
            connection.sendall(struct.pack("!I", len(body)) + body)


def audio_loop(stop):
    out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    samples = 300  # 6.8 ms of 44.1 kHz stereo S16BE: 1200 bytes
    payload = bytes(samples * 4)
    start = time.monotonic()
    sequence = timestamp = 0
    while not stop.is_set():
        out.sendto(rtp_header(False, 96, sequence, timestamp, 0x5A5A0002) + payload, ("127.0.0.1", 42002))
        sequence += 1
        timestamp += samples
        delay = start + timestamp / 44100 - time.monotonic()
        if delay > 0:
            time.sleep(delay)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--phase-frames", type=int, default=30)
    parser.add_argument("--audio", action="store_true")
    parser.add_argument("--media-socket")
    parser.add_argument("--serve-only", action="store_true")
    args = parser.parse_args()
    if args.media_socket:
        threading.Thread(target=serve_grant, args=(args.media_socket, args.audio), daemon=True).start()
    if args.serve_only:
        while True:
            time.sleep(3600)
    with open(args.video, "rb") as handle:
        units = access_units(handle.read())
    stop = threading.Event()
    if args.audio:
        threading.Thread(target=audio_loop, args=(stop,), daemon=True).start()
    out = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    out.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4 * 1024 * 1024)
    start = time.monotonic()
    sequence = 0
    for index, unit in enumerate(units):
        due = start + index / args.fps
        delay = due - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        payloads = packetize(unit)
        if index % args.phase_frames == 0:
            phase = "white" if (index // args.phase_frames) % 2 else "black"
            print(f"send {phase} {time.time_ns() // 1000}", flush=True)
        for number, payload in enumerate(payloads):
            marker = number == len(payloads) - 1
            out.sendto(rtp_header(marker, 96, sequence, index * 90000 // args.fps, 0x5A5A0001) + payload, ("127.0.0.1", 42000))
            sequence += 1
    stop.set()


if __name__ == "__main__":
    main()
