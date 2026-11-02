// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type { RuntimeItem } from "../host/contract";
import type { SurfaceSink } from "./surface";
import {
  HtmlVideoSurface,
  VIDEO_FIRST_FRAME_TIMEOUT_MS,
} from "./video-surface";

const sink = {
  ended: vi.fn(),
  failed: vi.fn(),
  resumed: vi.fn(),
  evidence: vi.fn(),
} as unknown as SurfaceSink;

function surface(audioEnabled = true) {
  const clock = new ManualClock({ wallMs: 0 });
  const item = {
    id: "v",
    kind: "video",
    src: "media:video",
    audioEnabled,
    volume: 1,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
  } as unknown as RuntimeItem;
  const video = new HtmlVideoSurface(
    item,
    { clock, sink, animationScale: 1 },
    1,
    { presentFirstFrame: true },
  );
  const frames: (() => void)[] = [];
  const el = video.element;
  el.play = vi.fn(() => Promise.resolve());
  el.pause = vi.fn();
  el.requestVideoFrameCallback = vi.fn((cb: () => void) => frames.push(cb));
  el.cancelVideoFrameCallback = vi.fn();
  return { video, el, clock, frames };
}

async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => (done = true));
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe("HtmlVideoSurface first frame", () => {
  it("is not ready at canplay, only once a frame has been presented", async () => {
    const { video, el, frames } = surface();
    const ready = video.prepare();
    el.dispatchEvent(new Event("canplay"));

    // Playable is not painted: a paused video presents nothing, so a swap
    // now would dissolve in an empty layer.
    expect(el.play).toHaveBeenCalledOnce();
    expect(await settled(ready)).toBe(false);

    frames[0]!();
    expect(await settled(ready)).toBe(true);
  });

  it("prerolls muted and applies the item's audio setting on activate", async () => {
    const { video, el, frames } = surface(true);
    const ready = video.prepare();
    el.dispatchEvent(new Event("canplay"));
    expect(el.muted).toBe(true);
    frames[0]!();
    await ready;

    await video.activate();
    expect(el.muted).toBe(false);
  });

  it("does not hold the playlist when no frame arrives", async () => {
    const { video, el, clock } = surface();
    const ready = video.prepare();
    el.dispatchEvent(new Event("canplay"));
    expect(await settled(ready)).toBe(false);

    clock.advance(VIDEO_FIRST_FRAME_TIMEOUT_MS);
    expect(await settled(ready)).toBe(true);
  });

  it("does not hold the swap when play is refused", async () => {
    const { video, el } = surface();
    el.play = vi.fn(() => Promise.reject(new Error("blocked")));
    const ready = video.prepare();
    el.dispatchEvent(new Event("canplay"));
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(await settled(ready)).toBe(true);
  });

  it("is ready at canplay when the surface does not present a first frame", async () => {
    const { el, clock } = surface();
    const plain = new HtmlVideoSurface(
      { id: "z", audioEnabled: true, volume: 1 } as never,
      { clock, sink, animationScale: 1 },
      2,
    );
    const ready = plain.prepare();
    plain.element.dispatchEvent(new Event("canplay"));
    expect(await settled(ready)).toBe(true);
    expect(el.play).not.toHaveBeenCalled();
  });

  it("is ready at canplay on an engine without frame callbacks", async () => {
    const { video, el } = surface();
    (el as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback =
      undefined;
    const ready = video.prepare();
    el.dispatchEvent(new Event("canplay"));
    expect(await settled(ready)).toBe(true);
  });
});
