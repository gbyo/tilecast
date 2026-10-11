// @vitest-environment jsdom
import { createActor } from "xstate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import { zoneMachine } from "../engine/zone-machine";
import type {
  RuntimeItem,
  RuntimeLayoutZone,
  RuntimeLayoutZonePlaylistItem,
} from "../host/contract";
import { LayoutSurface } from "./layout-surface";
import type { SurfaceSink } from "./surface";

const entry = (
  id: string,
  kind: "image" | "video" = "image",
): RuntimeLayoutZonePlaylistItem => ({
  id,
  kind,
  src: `tcmedia://${id}`,
  durationMs: 100,
  fit: "contain",
  muted: true,
  volume: 0,
  loop: false,
  transition: "none",
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const surfaces: LayoutSurface[] = [];

function harness(
  items = [entry("first")],
  fallback: "background" | "hide" | "previous" = "background",
  staticImage = false,
  extraZones: RuntimeLayoutZone[] = [],
) {
  const clock = new ManualClock({ wallMs: 0 });
  const sink: SurfaceSink = {
    ended: vi.fn(),
    failed: vi.fn(),
    resumed: vi.fn(),
    evidence: vi.fn(),
    websiteFailed: vi.fn(),
    websiteRecovered: vi.fn(),
    fallbackShown: vi.fn(),
    zoneFailed: vi.fn(),
    widgetEmpty: vi.fn(),
  };
  const item: RuntimeItem = {
    id: "layout",
    kind: "layout",
    src: "",
    durationMs: null,
    fitMode: "contain",
    audioEnabled: false,
    volume: 0,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
    layout: {
      canvasWidth: 100,
      canvasHeight: 100,
      background: "#000",
      zones: [
        {
          id: "zone",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          layer: 0,
          opacity: 1,
          loop: false,
          fallback,
          ...(staticImage
            ? { image: { src: "tcmedia://still", fit: "contain" as const } }
            : { playlistItems: items }),
        },
        ...extraZones,
      ],
    },
  };
  const surface = new LayoutSurface(item, { clock, sink, animationScale: 1 });
  surfaces.push(surface);
  document.body.append(surface.element);
  return {
    surface,
    clock,
    sink,
    zone: surface.element.firstElementChild as HTMLElement,
  };
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  for (const surface of surfaces.splice(0)) surface.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Layout child media readiness", () => {
  it("enables native looping only after playback starts, including resume", async () => {
    let started!: () => void;
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    play.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          started = resolve;
        }),
    );
    const h = harness([{ ...entry("clip", "video"), loop: true }]);
    const video = h.zone.querySelector("video")!;
    expect(video.loop).toBe(false);
    await h.surface.activate();
    video.dispatchEvent(new Event("canplay"));
    await settle();
    expect(play).toHaveBeenCalledOnce();
    expect(video.loop).toBe(false);
    started();
    await settle();
    expect(video.loop).toBe(true);
    h.surface.pause();
    await h.surface.activate();
    expect(video.loop).toBe(false);
    started();
    await settle();
    expect(video.loop).toBe(true);
    expect(h.sink.evidence).toHaveBeenCalledOnce();
  });

  it("cancels image timing when disposed", async () => {
    const h = harness([entry("first"), entry("next")]);
    await h.surface.activate();
    h.zone.querySelector("img")!.dispatchEvent(new Event("load"));
    await settle();
    expect(h.clock.pendingTimers).toBe(1);
    h.surface.dispose();
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("resumes video without duplicating frame observers and releases the decoder", async () => {
    const h = harness([entry("clip", "video")]);
    const video = h.zone.querySelector("video")!;
    const request = vi.fn(() => 1);
    const cancel = vi.fn();
    Object.assign(video, {
      requestVideoFrameCallback: request,
      cancelVideoFrameCallback: cancel,
    });
    video.dispatchEvent(new Event("canplay"));
    await settle();
    await h.surface.activate();
    await settle();
    h.surface.pause();
    await h.surface.activate();
    await settle();
    expect(request).toHaveBeenCalledOnce();
    expect(h.sink.evidence).toHaveBeenCalledOnce();
    h.surface.dispose();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(video.hasAttribute("src")).toBe(false);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledOnce();
  });

  it("holds image display time while the parent is paused", async () => {
    const h = harness([entry("first"), entry("next")]);
    await h.surface.activate();
    h.zone.querySelector("img")!.dispatchEvent(new Event("load"));
    await settle();
    h.clock.advance(40);
    h.surface.pause();
    h.clock.advance(8_000);
    expect(h.zone.querySelectorAll("img")).toHaveLength(1);
    await h.surface.activate();
    h.clock.advance(59);
    expect(h.zone.querySelectorAll("img")).toHaveLength(1);
    h.clock.advance(1);
    expect(h.zone.querySelectorAll("img")).toHaveLength(2);
    expect(h.sink.evidence).toHaveBeenCalledOnce();
  });

  it("cannot accept a delayed play result after replacement or disposal", async () => {
    let finish!: () => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const h = harness([entry("clip", "video"), entry("next")]);
    await h.surface.activate();
    const clip = h.zone.querySelector("video")!;
    clip.dispatchEvent(new Event("canplay"));
    await settle();
    clip.dispatchEvent(new Event("error"));
    await settle();
    finish();
    clip.currentTime = 1;
    clip.dispatchEvent(new Event("timeupdate"));
    await settle();
    expect(h.sink.zoneFailed).toHaveBeenCalledOnce();
    expect(h.sink.evidence).not.toHaveBeenCalled();
    expect(clip.hasAttribute("src")).toBe(false);
    expect(h.zone.querySelector("img")!.src).toContain("next");
    const next = h.zone.querySelector("img")!;
    const load = next.onload!;
    h.surface.dispose();
    load.call(next, new Event("load"));
    await settle();
    expect(h.sink.evidence).not.toHaveBeenCalled();
  });

  it("keeps the previous good item when incoming video activation fails", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(
      new Error("denied"),
    );
    const h = harness([entry("first"), entry("clip", "video")], "previous");
    await h.surface.activate();
    const first = h.zone.querySelector("img")!;
    first.dispatchEvent(new Event("load"));
    await settle();
    h.clock.advance(100);
    h.zone.querySelector("video")!.dispatchEvent(new Event("canplay"));
    await settle();
    expect(h.zone.firstElementChild).toBe(first);
    expect(h.zone.childElementCount).toBe(1);
    expect(h.sink.evidence).toHaveBeenCalledOnce();
    expect(h.sink.zoneFailed).toHaveBeenCalledWith(
      "zone",
      "video autoplay failed",
    );
    h.clock.advance(2_000);
    expect(h.zone.querySelector("video")).not.toBeNull();
    expect(h.zone.firstElementChild).toBe(first);
  });

  it("does not wait for a broken child before showing the Layout or another zone", async () => {
    const h = harness([entry("clip", "video")], "background", false, [
      {
        id: "healthy",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        layer: 1,
        opacity: 1,
        image: { src: "tcmedia://healthy", fit: "contain" },
      },
    ]);
    await expect(h.surface.prepare()).resolves.toBeUndefined();
    await h.surface.activate();
    expect(h.sink.evidence).not.toHaveBeenCalled();
    h.surface.element
      .querySelector('img[src="tcmedia://healthy"]')!
      .dispatchEvent(new Event("load"));
    h.zone.querySelector("video")!.dispatchEvent(new Event("error"));
    await settle();
    expect(h.sink.zoneFailed).toHaveBeenCalledOnce();
    expect(h.sink.evidence).toHaveBeenCalledExactlyOnceWith(
      "layout-zone-rendered",
      "healthy",
    );
    expect(h.surface.element.isConnected).toBe(true);
  });

  it("does not report selection and gives an image its full duration after load", async () => {
    const h = harness([entry("first"), entry("next")]);
    await h.surface.activate();
    expect(h.sink.evidence).not.toHaveBeenCalled();
    h.clock.advance(8_000);
    expect(h.zone.querySelector("img")!.src).toContain("first");
    h.zone.querySelector("img")!.dispatchEvent(new Event("load"));
    await settle();
    expect(h.sink.evidence).toHaveBeenCalledExactlyOnceWith(
      "layout-zone-rendered",
      "zone",
    );
    h.clock.advance(99);
    expect(h.zone.querySelectorAll("img")).toHaveLength(1);
    h.clock.advance(1);
    expect(h.zone.querySelector('img[src="tcmedia://next"]')).not.toBeNull();
  });

  it("prepares a video without autoplay and reports readiness only after playable activation", async () => {
    const h = harness([entry("clip", "video")]);
    const video = h.zone.querySelector("video")!;
    expect(video.autoplay).toBe(false);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("loadeddata"));
    await settle();
    expect(h.sink.evidence).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("canplay"));
    await settle();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(h.sink.evidence).not.toHaveBeenCalled();
    await h.surface.activate();
    await settle();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
    expect(h.sink.evidence).toHaveBeenCalledExactlyOnceWith(
      "layout-zone-rendered",
      "zone",
    );
    video.currentTime = 1;
    video.dispatchEvent(new Event("timeupdate"));
    expect(h.sink.evidence).toHaveBeenCalledWith("video-progress", "zone");
  });

  it.each(["load", "play"])(
    "reports video %s failure and hides the zone without rendered evidence",
    async (failure) => {
      if (failure === "play")
        vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(
          new Error("denied"),
        );
      const h = harness([entry("clip", "video")], "hide");
      await h.surface.activate();
      h.zone
        .querySelector("video")!
        .dispatchEvent(new Event(failure === "load" ? "error" : "canplay"));
      await settle();
      expect(h.sink.zoneFailed).toHaveBeenCalledWith(
        "zone",
        expect.stringContaining("video"),
      );
      expect(h.sink.evidence).not.toHaveBeenCalled();
      expect(h.zone.style.visibility).toBe("hidden");
      expect(h.zone.childElementCount).toBe(0);
    },
  );

  it("ignores callbacks retained from a failed epoch", async () => {
    const h = harness([entry("first"), entry("next")]);
    await h.surface.activate();
    const first = h.zone.querySelector("img")!;
    const load = first.onload!;
    const error = first.onerror!;
    first.dispatchEvent(new Event("error"));
    await settle();
    const next = h.zone.querySelector("img")!;
    load.call(first, new Event("load"));
    error.call(first, new Event("error"));
    await settle();
    expect(h.sink.evidence).not.toHaveBeenCalled();
    expect(h.sink.zoneFailed).toHaveBeenCalledOnce();
    expect(h.zone.querySelector("img")).toBe(next);
    next.dispatchEvent(new Event("load"));
    await settle();
    expect(h.sink.evidence).toHaveBeenCalledOnce();
  });

  it.each(["fade", "crossfade"] as const)(
    "keeps outgoing media until the incoming %s item loads",
    async (transition) => {
      const animate = vi.fn(
        () =>
          ({
            finished: new Promise(() => {}),
            cancel: vi.fn(),
          }) as unknown as Animation,
      );
      vi.stubGlobal("Animation", class {});
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: animate,
      });
      try {
        const h = harness([entry("first"), { ...entry("next"), transition }]);
        await h.surface.activate();
        const first = h.zone.querySelector("img")!;
        first.dispatchEvent(new Event("load"));
        await settle();
        h.clock.advance(100);
        expect(first.parentElement).toBe(h.zone);
        expect(animate).not.toHaveBeenCalled();
        h.zone
          .querySelector('img[src="tcmedia://next"]')!
          .dispatchEvent(new Event("load"));
        await settle();
        expect(animate).toHaveBeenCalledTimes(2);
      } finally {
        delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
        vi.unstubAllGlobals();
      }
    },
  );

  it("reports a failed static image", async () => {
    const h = harness([], "background", true);
    h.zone.querySelector("img")!.dispatchEvent(new Event("error"));
    await settle();
    expect(h.sink.zoneFailed).toHaveBeenCalledWith(
      "zone",
      "image failed to load",
    );
    expect(h.sink.evidence).not.toHaveBeenCalled();
  });

  it("requires current-epoch readiness before starting the image timer", () => {
    const clock = new ManualClock({ wallMs: 0 });
    const onReady = vi.fn();
    const actor = createActor(zoneMachine, {
      input: { items: [entry("first"), entry("next")], clock, onReady },
    });
    actor.start();
    expect(onReady).not.toHaveBeenCalled();
    clock.advance(8_000);
    expect(actor.getSnapshot().context.shown).toBe(1);
    const epoch = actor.getSnapshot().context.epoch;
    actor.send({ type: "MEDIA_READY", epoch: epoch - 1 });
    clock.advance(100);
    expect(actor.getSnapshot().context.shown).toBe(1);
    actor.send({ type: "MEDIA_READY", epoch });
    clock.advance(99);
    expect(actor.getSnapshot().context.shown).toBe(1);
    actor.send({ type: "MEDIA_READY", epoch });
    clock.advance(1);
    expect(actor.getSnapshot().context.shown).toBe(2);
    expect(onReady).toHaveBeenCalledOnce();
    actor.stop();
  });
});
