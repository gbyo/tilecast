import { afterEach, describe, expect, it, vi } from "vitest";
import { detectAcceptedProfiles } from "./h264Support";
import {
  MAX_DECODE_QUEUE,
  MAX_DECODER_ERRORS,
  startH264Stream,
  type DecoderLike,
  type FrameLike,
} from "./h264Stream";

const SESSION = "bffef4b1-f9b5-4b25-9d4f-864fba88d86d";
const KEY = [
  0, 0, 0, 1, 0x67, 0x42, 0, 0x28, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1,
  0x65, 0x88, 0x84,
];
const DELTA = [0, 0, 1, 0x41, 0x88, 0xa0];

function packet(
  sequence: number,
  keyframe: boolean,
  width = 960,
  height = 540,
  session = SESSION,
) {
  const payload = Uint8Array.from(keyframe ? KEY : DELTA);
  const out = new Uint8Array(4 + 48 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 48 + payload.byteLength);
  out.set([0x54, 0x43, 0x4c, 0x53, 2, 2, keyframe ? 1 : 0, 0], 4);
  out.set(
    Uint8Array.from(session.replaceAll("-", "").match(/../g)!, (b) =>
      parseInt(b, 16),
    ),
    12,
  );
  view.setBigUint64(28, BigInt(sequence));
  view.setBigUint64(36, BigInt(sequence * 66_666));
  view.setUint16(44, width);
  view.setUint16(46, height);
  view.setUint32(48, payload.byteLength);
  out.set(payload, 52);
  return out;
}

class FakeFrame implements FrameLike {
  closed = false;
  constructor(
    readonly displayWidth: number,
    readonly displayHeight: number,
  ) {}
  close() {
    this.closed = true;
  }
}

class FakeDecoder implements DecoderLike {
  state: CodecState = "unconfigured";
  decodeQueueSize = 0;
  configs: VideoDecoderConfig[] = [];
  decoded: EncodedVideoChunkInit[] = [];
  constructor(
    readonly output: (frame: FrameLike) => void,
    readonly error: (error: unknown) => void,
  ) {}
  configure(config: VideoDecoderConfig) {
    this.state = "configured";
    this.configs.push(config);
  }
  decode(chunk: EncodedVideoChunk) {
    this.decoded.push(chunk as unknown as EncodedVideoChunkInit);
  }
  close() {
    this.state = "closed";
  }
}

function harness() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const decoders: FakeDecoder[] = [];
  const frames: FakeFrame[] = [];
  const paints: (() => void)[] = [];
  const drawn: unknown[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (frame: unknown) => drawn.push(frame) }),
  } as unknown as HTMLCanvasElement;
  const callbacks = {
    onFirstFrame: vi.fn(),
    onEnded: vi.fn(),
    onDecoderFailed: vi.fn(),
  };
  const fetchImpl = vi.fn(() =>
    Promise.resolve(new Response(body, { status: 200 })),
  );
  const stop = startH264Stream({
    url: "/h264",
    sessionId: SESSION,
    canvas,
    callbacks,
    fetchImpl,
    createDecoder: ({ output, error }) => {
      const decoder = new FakeDecoder(output, error);
      decoders.push(decoder);
      return decoder;
    },
    createChunk: (init) => init as unknown as EncodedVideoChunk,
    scheduleFrame: (paint) => {
      paints.push(paint);
      return () => paints.splice(paints.indexOf(paint), 1);
    },
  });
  const send = async (...records: Uint8Array[]) => {
    for (const r of records) controller.enqueue(r);
    await vi.waitFor(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const emit = (decoder: FakeDecoder) => {
    const frame = new FakeFrame(960, 540);
    frames.push(frame);
    decoder.output(frame);
    return frame;
  };
  return {
    controller,
    decoders,
    frames,
    paints,
    drawn,
    canvas,
    callbacks,
    stop,
    send,
    emit,
    fetchImpl,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("H.264 Watch Live stream", () => {
  it("starts at a keyframe and configures a low-latency decoder", async () => {
    const h = harness();
    await h.send(packet(1, false), packet(2, true), packet(3, false));
    expect(h.fetchImpl).toHaveBeenCalledWith(
      "/h264",
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
      }),
    );
    expect(h.decoders).toHaveLength(1);
    const decoder = h.decoders[0]!;
    expect(decoder.configs).toEqual([
      expect.objectContaining({
        codec: "avc1.42e01f",
        codedWidth: 960,
        codedHeight: 540,
        optimizeForLatency: true,
      }),
    ]);
    expect(
      decoder.decoded.map((chunk) => [chunk.type, chunk.timestamp]),
    ).toEqual([
      ["key", 133_332],
      ["delta", 199_998],
    ]);
    h.stop();
  });

  it("paints only the newest frame and closes every VideoFrame", async () => {
    const h = harness();
    await h.send(packet(1, true));
    const decoder = h.decoders[0]!;
    const stale = h.emit(decoder);
    const fresh = h.emit(decoder);
    expect(stale.closed).toBe(true);
    expect(h.paints).toHaveLength(1);
    h.paints[0]!();
    expect(h.drawn).toEqual([fresh]);
    expect(fresh.closed).toBe(true);
    expect([h.canvas.width, h.canvas.height]).toEqual([960, 540]);
    expect(h.callbacks.onFirstFrame).toHaveBeenCalledOnce();
    const pending = h.emit(decoder);
    h.stop();
    expect(pending.closed).toBe(true);
    expect(decoder.state).toBe("closed");
    // A frame that arrives after stop is closed at once.
    const late = h.emit(decoder);
    expect(late.closed).toBe(true);
  });

  it("skips to the next keyframe instead of queueing when the decoder is slow", async () => {
    const h = harness();
    await h.send(packet(1, true));
    const decoder = h.decoders[0]!;
    decoder.decodeQueueSize = MAX_DECODE_QUEUE + 1;
    await h.send(
      ...Array.from({ length: 50 }, (_, index) => packet(index + 2, false)),
    );
    expect(decoder.decoded).toHaveLength(1);
    decoder.decodeQueueSize = 0;
    await h.send(packet(60, false));
    expect(decoder.decoded).toHaveLength(1);
    await h.send(packet(61, true), packet(62, false));
    expect(decoder.decoded.map((chunk) => chunk.type)).toEqual([
      "key",
      "key",
      "delta",
    ]);
    h.stop();
  });

  it("reconfigures on a new size at a keyframe (a profile switch)", async () => {
    const h = harness();
    await h.send(packet(1, true), packet(2, false));
    await h.send(packet(3, true, 640, 360));
    expect(h.decoders).toHaveLength(2);
    expect(h.decoders[0]!.state).toBe("closed");
    expect(h.decoders[1]!.configs[0]).toEqual(
      expect.objectContaining({ codedWidth: 640, codedHeight: 360 }),
    );
    h.stop();
  });

  it("recovers from a decoder error and gives up after repeated errors", async () => {
    const h = harness();
    await h.send(packet(1, true));
    h.decoders[0]!.error(new Error("decode"));
    expect(h.decoders[0]!.state).toBe("closed");
    // A delta cannot restart decoding; the next keyframe does.
    await h.send(packet(2, false));
    expect(h.decoders).toHaveLength(1);
    await h.send(packet(3, true));
    expect(h.decoders).toHaveLength(2);
    for (let error = 1; error < MAX_DECODER_ERRORS; error += 1) {
      h.decoders.at(-1)!.error(new Error("decode"));
      await h.send(packet(10 + error, true));
    }
    expect(h.callbacks.onDecoderFailed).toHaveBeenCalledOnce();
    expect(h.decoders.every((decoder) => decoder.state === "closed")).toBe(
      true,
    );
    expect(h.callbacks.onEnded).not.toHaveBeenCalled();
  });

  it("ends on a record from another session or when the relay closes", async () => {
    const h = harness();
    await h.send(
      packet(1, true, 960, 540, "0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa"),
    );
    expect(h.callbacks.onEnded).toHaveBeenCalledWith("protocol");
    expect(h.decoders).toHaveLength(0);
    const closed = harness();
    await closed.send(packet(1, true));
    closed.controller.close();
    await vi.waitFor(() =>
      expect(closed.callbacks.onEnded).toHaveBeenCalledWith("closed"),
    );
    expect(closed.decoders[0]!.state).toBe("closed");
  });
});

describe("WebCodecs detection", () => {
  const supported = (sizes: string[]) => ({
    isConfigSupported: vi.fn((config: VideoDecoderConfig) =>
      Promise.resolve({
        supported:
          sizes.includes(`${config.codedWidth}x${config.codedHeight}`) &&
          config.codec === "avc1.42e01f",
        config,
      }),
    ),
  });

  it("offers only what the decoder accepts, always with MJPEG", async () => {
    expect(
      await detectAcceptedProfiles({
        isSecureContext: true,
        VideoDecoder: supported(["1280x720", "960x540"]),
      }),
    ).toEqual([
      "h264-720p15",
      "h264-540p15",
      "h264-540p10",
      "mjpeg-540p10",
      "mjpeg-360p8",
    ]);
    expect(
      await detectAcceptedProfiles({
        isSecureContext: true,
        VideoDecoder: supported(["960x540"]),
      }),
    ).toEqual(["h264-540p15", "h264-540p10", "mjpeg-540p10", "mjpeg-360p8"]);
  });

  it("falls back to MJPEG without WebCodecs, outside a secure context, or on a throwing probe", async () => {
    const mjpeg = ["mjpeg-540p10", "mjpeg-360p8"];
    expect(await detectAcceptedProfiles({ isSecureContext: true })).toEqual(
      mjpeg,
    );
    expect(
      await detectAcceptedProfiles({
        isSecureContext: false,
        VideoDecoder: supported(["1280x720", "960x540"]),
      }),
    ).toEqual(mjpeg);
    const throwing = {
      isConfigSupported: vi.fn(async () => Promise.reject(new TypeError("no"))),
    };
    expect(
      await detectAcceptedProfiles({
        isSecureContext: true,
        VideoDecoder: throwing,
      }),
    ).toEqual(mjpeg);
  });
});
