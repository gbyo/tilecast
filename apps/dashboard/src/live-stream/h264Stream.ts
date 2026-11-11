import { h264DecoderConfig } from "./h264Support";
import { LiveStreamProtocolError, parseChunk, RecordReader } from "./protocol";

/**
 * Decoded frames the decoder may hold before Studio skips to the next
 * keyframe. Watch Live favors freshness over continuity.
 */
export const MAX_DECODE_QUEUE = 6;
/** Decoder errors in one stream before Studio gives up on H.264. */
export const MAX_DECODER_ERRORS = 3;

export type H264StreamEnd = "closed" | "network" | "protocol";

export interface H264StreamCallbacks {
  /** The first decoded frame was painted. */
  onFirstFrame(): void;
  /** The relay request ended; the caller renews and reconnects. */
  onEnded(reason: H264StreamEnd): void;
  /** H.264 cannot be decoded here; the caller falls back to MJPEG. */
  onDecoderFailed(): void;
}

/** The subset of `VideoDecoder` the stream uses; injectable for tests. */
export interface DecoderLike {
  readonly state: CodecState;
  readonly decodeQueueSize: number;
  configure(config: VideoDecoderConfig): void;
  decode(chunk: EncodedVideoChunk): void;
  close(): void;
}

export interface FrameLike {
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

export interface H264StreamOptions {
  url: string;
  sessionId: string;
  canvas: HTMLCanvasElement;
  callbacks: H264StreamCallbacks;
  fetchImpl?: typeof fetch;
  createDecoder?: (init: {
    output: (frame: FrameLike) => void;
    error: (error: unknown) => void;
  }) => DecoderLike;
  createChunk?: (init: EncodedVideoChunkInit) => EncodedVideoChunk;
  scheduleFrame?: (paint: () => void) => () => void;
}

function defaultSchedule(paint: () => void) {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(paint, 16);
  return () => clearTimeout(handle);
}

/**
 * Plays one H.264 relay request into a canvas. Each length-prefixed record
 * is one TCLS version 2 access unit. Decoding starts at a keyframe (the
 * relay always begins with one, carrying SPS and PPS), only the newest
 * decoded frame is painted, and every `VideoFrame` is closed promptly.
 * Returns a stop function that releases the request, decoder, and frames.
 */
export function startH264Stream(options: H264StreamOptions): () => void {
  const {
    url,
    sessionId,
    canvas,
    callbacks,
    fetchImpl = fetch,
    createDecoder = (init) => new VideoDecoder(init),
    createChunk = (init) => new EncodedVideoChunk(init),
    scheduleFrame = defaultSchedule,
  } = options;
  const abort = new AbortController();
  const records = new RecordReader();
  let stopped = false;
  let decoder: DecoderLike | null = null;
  let decoderSize = { width: 0, height: 0 };
  let awaitingKeyframe = true;
  let decoderErrors = 0;
  let pending: FrameLike | null = null;
  let cancelPaint: (() => void) | null = null;
  let painted = false;

  const closeDecoder = () => {
    if (decoder && decoder.state !== "closed") {
      try {
        decoder.close();
      } catch {
        // Already closed by an error.
      }
    }
    decoder = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    abort.abort();
    closeDecoder();
    cancelPaint?.();
    cancelPaint = null;
    pending?.close();
    pending = null;
  };

  const end = (reason: H264StreamEnd) => {
    if (stopped) return;
    stop();
    callbacks.onEnded(reason);
  };

  const paint = () => {
    cancelPaint = null;
    const frame = pending;
    pending = null;
    if (!frame || stopped) {
      frame?.close();
      return;
    }
    try {
      if (canvas.width !== frame.displayWidth)
        canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight)
        canvas.height = frame.displayHeight;
      canvas
        .getContext("2d")
        ?.drawImage(
          frame as unknown as CanvasImageSource,
          0,
          0,
          canvas.width,
          canvas.height,
        );
    } finally {
      frame.close();
    }
    if (!painted) {
      painted = true;
      callbacks.onFirstFrame();
    }
  };

  const output = (frame: FrameLike) => {
    if (stopped) {
      frame.close();
      return;
    }
    // Only the newest frame is worth painting.
    pending?.close();
    pending = frame;
    cancelPaint ??= scheduleFrame(paint);
  };

  const decoderFailed = () => {
    closeDecoder();
    awaitingKeyframe = true;
    decoderErrors += 1;
    if (decoderErrors >= MAX_DECODER_ERRORS && !stopped) {
      stop();
      callbacks.onDecoderFailed();
    }
  };

  const handle = (record: Uint8Array) => {
    const { header, payload } = parseChunk(record);
    if (header.sessionId !== sessionId) {
      throw new LiveStreamProtocolError("record belongs to another session");
    }
    if (!header.keyframe && awaitingKeyframe) return;
    if (header.keyframe) {
      const resized =
        header.width !== decoderSize.width ||
        header.height !== decoderSize.height;
      if (!decoder || decoder.state === "closed" || resized) {
        closeDecoder();
        try {
          decoder = createDecoder({ output, error: () => decoderFailed() });
          decoder.configure(h264DecoderConfig(header.width, header.height));
          decoderSize = { width: header.width, height: header.height };
        } catch {
          decoderFailed();
          return;
        }
      }
      awaitingKeyframe = false;
    } else if (!decoder || decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // The decoder is behind: skip to the next keyframe instead of
      // building latency. Skipped deltas are never decoded later.
      awaitingKeyframe = true;
      return;
    }
    try {
      decoder?.decode(
        createChunk({
          type: header.keyframe ? "key" : "delta",
          timestamp: header.timestamp,
          data: payload,
        }),
      );
    } catch {
      decoderFailed();
    }
  };

  void (async () => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        credentials: "same-origin",
        cache: "no-store",
        signal: abort.signal,
      });
    } catch {
      end("network");
      return;
    }
    if (!response.ok || !response.body) {
      end("network");
      return;
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          end("closed");
          return;
        }
        for (const record of records.push(value)) {
          handle(record);
          if (stopped) return;
        }
      }
    } catch (error) {
      end(error instanceof LiveStreamProtocolError ? "protocol" : "network");
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  })();

  return stop;
}
