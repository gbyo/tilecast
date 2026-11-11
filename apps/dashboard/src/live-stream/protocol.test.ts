import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  H264_CODEC,
  LiveStreamProtocolError,
  MAX_ACCESS_UNIT_BYTES,
  MAX_RECORD_BYTES,
  parseChunk,
  RecordReader,
  TCLS_V2_HEADER_BYTES,
  WATCH_LIVE_PROFILES,
} from "./protocol";

interface Fixture {
  codec: string;
  maxAccessUnitBytes: number;
  tclsV2HeaderBytes: number;
  profiles: {
    id: string;
    code: number;
    transport: string;
    maxWidth: number;
    maxHeight: number;
    fps: number;
  }[];
  tclsV2: {
    valid: {
      name: string;
      sessionId: string;
      sequence: number;
      timestampMicros: number;
      width: number;
      height: number;
      keyframe: boolean;
      payloadHex: string;
      packetHex: string;
    }[];
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/player-contracts/fixtures/watch-live.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Fixture;

function hex(value: string) {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) =>
    parseInt(byte, 16),
  );
}

function record(packet: Uint8Array) {
  const out = new Uint8Array(4 + packet.byteLength);
  new DataView(out.buffer).setUint32(0, packet.byteLength);
  out.set(packet, 4);
  return out;
}

describe("Watch Live protocol", () => {
  it("matches the shared profile corpus", () => {
    expect(fixture.codec).toBe(H264_CODEC);
    expect(fixture.maxAccessUnitBytes).toBe(MAX_ACCESS_UNIT_BYTES);
    expect(fixture.tclsV2HeaderBytes).toBe(TCLS_V2_HEADER_BYTES);
    expect(
      fixture.profiles.map(
        ({ id, code, transport, maxWidth, maxHeight, fps }) => ({
          id,
          code,
          transport,
          maxWidth,
          maxHeight,
          fps,
        }),
      ),
    ).toEqual(WATCH_LIVE_PROFILES);
  });

  it("parses the shared TCLS v2 vectors", () => {
    for (const vector of fixture.tclsV2.valid) {
      const { header, payload } = parseChunk(hex(vector.packetHex));
      expect(header).toEqual({
        sessionId: vector.sessionId,
        profileCode: 2,
        sequence: vector.sequence,
        timestamp: vector.timestampMicros,
        width: vector.width,
        height: vector.height,
        keyframe: vector.keyframe,
      });
      expect(payload).toEqual(hex(vector.payloadHex));
    }
  });

  it("rejects malformed headers", () => {
    const valid = hex(fixture.tclsV2.valid[0]!.packetHex);
    const mutations: [string, (packet: Uint8Array) => void][] = [
      ["version", (p) => (p[4] = 1)],
      ["MJPEG code", (p) => (p[5] = 0)],
      ["reserved flag", (p) => (p[6] = 3)],
      ["reserved byte", (p) => (p[7] = 1)],
      ["length", (p) => (p[47] = (p[47] ?? 0) + 1)],
      ["too wide", (p) => new DataView(p.buffer).setUint16(40, 1280)],
      ["odd height", (p) => new DataView(p.buffer).setUint16(42, 539)],
    ];
    for (const [name, mutate] of mutations) {
      const packet = valid.slice();
      mutate(packet);
      expect(() => parseChunk(packet), name).toThrow(LiveStreamProtocolError);
    }
    expect(() => parseChunk(valid.subarray(0, TCLS_V2_HEADER_BYTES))).toThrow(
      LiveStreamProtocolError,
    );
  });

  it("reads records across arbitrary read boundaries", () => {
    const packets = fixture.tclsV2.valid.map((vector) => hex(vector.packetHex));
    const stream = new Uint8Array(
      packets.reduce((size, packet) => size + 4 + packet.byteLength, 0),
    );
    let offset = 0;
    for (const packet of packets) {
      stream.set(record(packet), offset);
      offset += 4 + packet.byteLength;
    }
    // One byte at a time: split lengths, split headers, split payloads.
    const reader = new RecordReader();
    const bytewise = Array.from(stream).flatMap((byte) =>
      reader.push(Uint8Array.of(byte)),
    );
    expect(bytewise).toEqual(packets);
    expect(reader.pending).toBe(0);
    // Everything in one read.
    expect(new RecordReader().push(stream)).toEqual(packets);
    // A split right after a length prefix.
    const split = new RecordReader();
    expect(split.push(stream.subarray(0, 4))).toEqual([]);
    expect(split.push(stream.subarray(4))).toEqual(packets);
  });

  it("refuses an oversized record before buffering it", () => {
    const reader = new RecordReader();
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, MAX_RECORD_BYTES + 1);
    expect(() => reader.push(length)).toThrow(LiveStreamProtocolError);
    new DataView(length.buffer).setUint32(0, 3);
    expect(() => new RecordReader().push(length)).toThrow(
      LiveStreamProtocolError,
    );
  });
});
