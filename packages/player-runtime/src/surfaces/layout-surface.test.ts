// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  RuntimeItem,
  RuntimeLayoutPayload,
  RuntimeLayoutZone,
} from "../host/contract";
import { LayoutSurface } from "./layout-surface";
import type { SurfaceEnvironment, SurfaceSink } from "./surface";

afterEach(() => vi.restoreAllMocks());

const sink: SurfaceSink = {
  ended() {},
  failed() {},
  resumed() {},
  evidence() {},
  websiteFailed() {},
  websiteRecovered() {},
  fallbackShown() {},
  zoneFailed() {},
};

function makeSurface(zone: RuntimeLayoutZone) {
  const layout: RuntimeLayoutPayload = {
    canvasWidth: 100,
    canvasHeight: 100,
    background: "#000000",
    zones: [zone],
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
    layout,
  };
  const environment: SurfaceEnvironment = {
    clock: new ManualClock({ wallMs: 0 }),
    sink,
    animationScale: 1,
  };
  return new LayoutSurface(item, environment);
}

describe("LayoutSurface video-zone timing", () => {
  it("starts at the item offset and advances at its end offset", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const zone: RuntimeLayoutZone = {
      id: "zone",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      layer: 0,
      opacity: 1,
      playlistItems: [
        {
          id: "clip",
          kind: "video",
          src: "tcmedia://clip",
          durationMs: null,
          fit: "contain",
          muted: true,
          volume: 0,
          loop: false,
          videoStartOffsetMs: 2_000,
          videoEndOffsetMs: 5_000,
        },
        {
          id: "next",
          kind: "image",
          src: "tcmedia://next",
          durationMs: 1_000,
          fit: "contain",
          muted: true,
          volume: 0,
          loop: false,
        },
      ],
    };
    const surface = makeSurface(zone);
    const container = surface.element.firstElementChild as HTMLElement;
    const video = container.firstElementChild as HTMLVideoElement;
    video.onloadedmetadata?.(new Event("loadedmetadata"));
    expect(video.currentTime).toBe(2);
    video.currentTime = 5;
    video.ontimeupdate?.(new Event("timeupdate"));
    expect(container.firstElementChild?.tagName).toBe("IMG");
    surface.dispose();
  });

  it("advances a video without an end offset when the media ends", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const zone: RuntimeLayoutZone = {
      id: "zone",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      layer: 0,
      opacity: 1,
      playlistItems: [
        {
          id: "clip",
          kind: "video",
          src: "tcmedia://clip",
          durationMs: null,
          fit: "contain",
          muted: true,
          volume: 0,
          loop: false,
        },
        {
          id: "next",
          kind: "image",
          src: "tcmedia://next",
          durationMs: 1_000,
          fit: "contain",
          muted: true,
          volume: 0,
          loop: false,
        },
      ],
    };
    const surface = makeSurface(zone);
    const container = surface.element.firstElementChild as HTMLElement;
    const video = container.firstElementChild as HTMLVideoElement;
    video.onended?.(new Event("ended"));
    expect(container.firstElementChild?.tagName).toBe("IMG");
    surface.dispose();
  });
});
