/**
 * Watch Live wire contract on the Studio side: the profile vocabulary and
 * the TCLS version 2 records of the H.264 relay. Pinned by
 * packages/player-contracts/fixtures/watch-live.json (protocol.test.ts).
 */

export const H264_CODEC = "avc1.42e01f";
export const TCLS_V2_HEADER_BYTES = 48;
export const MAX_ACCESS_UNIT_BYTES = 512 * 1024;
export const MAX_RECORD_BYTES = TCLS_V2_HEADER_BYTES + MAX_ACCESS_UNIT_BYTES;

export type WatchLiveTransport = "h264" | "mjpeg";

export interface WatchLiveProfile {
  id: string;
  code: number;
  transport: WatchLiveTransport;
  maxWidth: number;
  maxHeight: number;
  fps: number;
}

/** Every profile, best first. */
export const WATCH_LIVE_PROFILES: readonly WatchLiveProfile[] = [
  {
    id: "h264-720p15",
    code: 1,
    transport: "h264",
    maxWidth: 1280,
    maxHeight: 720,
    fps: 15,
  },
  {
    id: "h264-540p15",
    code: 2,
    transport: "h264",
    maxWidth: 960,
    maxHeight: 540,
    fps: 15,
  },
  {
    id: "h264-540p10",
    code: 3,
    transport: "h264",
    maxWidth: 960,
    maxHeight: 540,
    fps: 10,
  },
  {
    id: "mjpeg-540p10",
    code: 0,
    transport: "mjpeg",
    maxWidth: 960,
    maxHeight: 540,
    fps: 10,
  },
  {
    id: "mjpeg-360p8",
    code: 0,
    transport: "mjpeg",
    maxWidth: 640,
    maxHeight: 360,
    fps: 8,
  },
];

/** What every Studio can consume: the multipart MJPEG relay. */
export const MJPEG_PROFILE_IDS: readonly string[] = WATCH_LIVE_PROFILES.filter(
  (profile) => profile.transport === "mjpeg",
).map((profile) => profile.id);

export function profileById(id: string | undefined) {
  return WATCH_LIVE_PROFILES.find((profile) => profile.id === id);
}

export interface ChunkHeader {
  sessionId: string;
  profileCode: number;
  sequence: number;
  /** Presentation timestamp in microseconds. */
  timestamp: number;
  width: number;
  height: number;
  keyframe: boolean;
}

export class LiveStreamProtocolError extends Error {}

function uuidFromBytes(bytes: Uint8Array) {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Parses and validates one TCLS version 2 packet. The payload is a view
 * into `packet`, not a copy.
 */
export function parseChunk(packet: Uint8Array): {
  header: ChunkHeader;
  payload: Uint8Array;
} {
  if (
    packet.byteLength < TCLS_V2_HEADER_BYTES + 4 ||
    packet.byteLength > MAX_RECORD_BYTES
  ) {
    throw new LiveStreamProtocolError("packet size is out of range");
  }
  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );
  if (
    packet[0] !== 0x54 ||
    packet[1] !== 0x43 ||
    packet[2] !== 0x4c ||
    packet[3] !== 0x53 ||
    packet[4] !== 2
  ) {
    throw new LiveStreamProtocolError("unsupported header");
  }
  const profile = WATCH_LIVE_PROFILES.find(
    (candidate) => candidate.code !== 0 && candidate.code === packet[5],
  );
  if (!profile) throw new LiveStreamProtocolError("unknown profile");
  const flags = packet[6] ?? 0;
  if ((flags & ~1) !== 0 || packet[7] !== 0) {
    throw new LiveStreamProtocolError("reserved bits are set");
  }
  const sequence = Number(view.getBigUint64(24));
  const timestamp = Number(view.getBigUint64(32));
  const width = view.getUint16(40);
  const height = view.getUint16(42);
  const length = view.getUint32(44);
  if (length !== packet.byteLength - TCLS_V2_HEADER_BYTES) {
    throw new LiveStreamProtocolError("payload length does not match");
  }
  if (
    width < 16 ||
    height < 16 ||
    width % 2 !== 0 ||
    height % 2 !== 0 ||
    width > profile.maxWidth ||
    height > profile.maxHeight ||
    !Number.isSafeInteger(sequence) ||
    !Number.isSafeInteger(timestamp)
  ) {
    throw new LiveStreamProtocolError("header values are out of range");
  }
  return {
    header: {
      sessionId: uuidFromBytes(packet.subarray(8, 24)),
      profileCode: profile.code,
      sequence,
      timestamp,
      width,
      height,
      keyframe: (flags & 1) === 1,
    },
    payload: packet.subarray(TCLS_V2_HEADER_BYTES),
  };
}

/**
 * Incremental reader for the relay's records: a big-endian u32 length and
 * that many bytes. It accepts arbitrary read boundaries (split headers,
 * split payloads, several records in one read) and never buffers more than
 * one record plus one read.
 */
export class RecordReader {
  private buffered: Uint8Array[] = [];
  private size = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength === 0) return [];
    this.buffered.push(chunk);
    this.size += chunk.byteLength;
    const records: Uint8Array[] = [];
    for (;;) {
      if (this.size < 4) break;
      const head = this.peek(4);
      const length = new DataView(head.buffer, head.byteOffset, 4).getUint32(0);
      if (length < TCLS_V2_HEADER_BYTES + 4 || length > MAX_RECORD_BYTES) {
        throw new LiveStreamProtocolError("record length is out of range");
      }
      if (this.size < 4 + length) break;
      this.take(4);
      records.push(this.take(length));
    }
    return records;
  }

  /** Bytes held for an incomplete record. */
  get pending() {
    return this.size;
  }

  private peek(count: number) {
    const first = this.buffered[0];
    if (first && first.byteLength >= count) return first.subarray(0, count);
    const out = new Uint8Array(count);
    let offset = 0;
    for (const part of this.buffered) {
      const slice = part.subarray(0, count - offset);
      out.set(slice, offset);
      offset += slice.byteLength;
      if (offset === count) break;
    }
    return out;
  }

  private take(count: number) {
    const first = this.buffered[0];
    if (first && first.byteLength >= count) {
      // The common case: the record is inside one read. Copy it so the
      // record does not pin the whole read buffer.
      const out = first.slice(0, count);
      if (first.byteLength === count) this.buffered.shift();
      else this.buffered[0] = first.subarray(count);
      this.size -= count;
      return out;
    }
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const part = this.buffered[0];
      if (!part) break;
      const needed = count - offset;
      if (part.byteLength <= needed) {
        out.set(part, offset);
        offset += part.byteLength;
        this.buffered.shift();
      } else {
        out.set(part.subarray(0, needed), offset);
        this.buffered[0] = part.subarray(needed);
        offset += needed;
      }
    }
    this.size -= count;
    return out;
  }
}
