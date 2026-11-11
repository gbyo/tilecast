import { useEffect, useRef } from "react";
import { startH264Stream, type H264StreamEnd } from "./h264Stream";

export interface SurfaceEvents {
  /** The first frame is on screen. */
  onPlaying(): void;
  /** The relay request failed or ended; the viewer renews and retries. */
  onTransportEnded(reason: H264StreamEnd | "error"): void;
  /** This browser cannot decode the stream; the viewer falls back to MJPEG. */
  onDecoderFailed(): void;
}

/** The multipart MJPEG relay, shown by the browser's image decoder. */
export function MjpegSurface({
  url,
  alt,
  events,
}: {
  url: string;
  alt: string;
  events: SurfaceEvents;
}) {
  return (
    <img
      className="block size-full object-contain"
      src={url}
      alt={alt}
      onLoad={() => events.onPlaying()}
      onError={() => events.onTransportEnded("error")}
    />
  );
}

/**
 * The H.264 relay, decoded with WebCodecs into a canvas. Mounting starts
 * one relay request and unmounting releases it with its decoder and frames.
 */
export function H264Surface({
  url,
  sessionId,
  alt,
  events,
}: {
  url: string;
  sessionId: string;
  alt: string;
  events: SurfaceEvents;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const latestEvents = useRef(events);
  useEffect(() => {
    latestEvents.current = events;
  }, [events]);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return undefined;
    return startH264Stream({
      url,
      sessionId,
      canvas: target,
      callbacks: {
        onFirstFrame: () => latestEvents.current.onPlaying(),
        onEnded: (reason) => latestEvents.current.onTransportEnded(reason),
        onDecoderFailed: () => latestEvents.current.onDecoderFailed(),
      },
    });
  }, [sessionId, url]);

  return (
    <canvas
      ref={canvas}
      className="block size-full object-contain"
      role="img"
      aria-label={alt}
    />
  );
}
