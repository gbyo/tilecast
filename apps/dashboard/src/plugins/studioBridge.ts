/**
 * The wire contract between Studio and a sandboxed package UI frame:
 * message shapes, the validation each side applies, and the frame's height
 * limits. Pure functions only; the host component owns the channel.
 */

/**
 * The bridge call one sandboxed Studio UI frame sends over its port: a
 * correlation id and the base64 guest input. Anything else is ignored.
 * The 24 KiB ceiling covers the 16 KiB call window encoded.
 */
export type StudioBridgeCall = {
  id: string;
  input: string;
};

export const bridgeSource = "tilecast-studio-ui";
const helloKind = "studio-hello";
export const handshakeKind = "studio-handshake";
const resizeKind = "studio-resize";
const maxBridgeInputChars = 24 * 1024;

/**
 * The frame's height in CSS pixels. It starts at a modest default, follows
 * the height the page reports over its port, and never leaves this range:
 * a page taller than the maximum scrolls inside the frame instead of
 * pushing the rest of Studio away.
 */
export const studioFrameHeight = { initial: 280, min: 200, max: 680 } as const;

/** The largest report treated as a measurement at all; beyond it is noise. */
const maxReportedHeight = 100_000;

export function clampStudioHeight(height: number) {
  return Math.min(
    studioFrameHeight.max,
    Math.max(studioFrameHeight.min, Math.round(height)),
  );
}

/**
 * A resize report: the frame page tells the parent how tall its content
 * wants to be. Only this exact shape counts, and only a finite positive
 * number within a sane bound; anything else is ignored rather than
 * clamped, so a malformed message cannot move the layout at all.
 */
export function parseStudioResize(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  const keys = Object.keys(message);
  if (keys.length !== 3) return null;
  if (message.source !== bridgeSource || message.kind !== resizeKind) {
    return null;
  }
  const height = message.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  if (height <= 0 || height > maxReportedHeight) return null;
  return height;
}

export function parseStudioBridgeCall(data: unknown): StudioBridgeCall | null {
  if (typeof data !== "object" || data === null) return null;
  const call = data as Record<string, unknown>;
  if (call.source !== bridgeSource) return null;
  if (typeof call.id !== "string" || call.id === "" || call.id.length > 128) {
    return null;
  }
  if (
    typeof call.input !== "string" ||
    call.input.length > maxBridgeInputChars
  ) {
    return null;
  }
  return { id: call.id, input: call.input };
}

/** The frame page's announcement before it holds the port. */
export function isStudioHello(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const hello = data as Record<string, unknown>;
  return hello.source === bridgeSource && hello.kind === helloKind;
}
