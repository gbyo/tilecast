// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  RuntimeItem,
  RuntimeLayoutPayload,
  RuntimeLayoutZone,
} from "../host/contract";
import { LayoutSurface } from "./layout-surface";
import fixtures from "../../../presentation-model/fixtures/zone-policy.json";
import type { SurfaceEnvironment, SurfaceSink } from "./surface";

let originalAnimate: PropertyDescriptor | undefined;
let animate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  originalAnimate = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "animate",
  );
  animate = vi.fn(
    () =>
      ({
        finished: Promise.resolve(),
        cancel: vi.fn(),
      }) as unknown as Animation,
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAnimate) {
    Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
  }
});

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

function surfaceFor(
  zones: RuntimeLayoutZone[],
  clock = new ManualClock({ wallMs: 0 }),
) {
  const layout: RuntimeLayoutPayload = {
    canvasWidth: 100,
    canvasHeight: 100,
    background: "#123456",
    zones,
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
    clock,
    sink,
    animationScale: 1,
  };
  return { surface: new LayoutSurface(item, environment), clock };
}

function playlistZone(
  overrides: Partial<RuntimeLayoutZone> = {},
): RuntimeLayoutZone {
  return {
    id: "zone",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    layer: 0,
    opacity: 1,
    loop: false,
    fallback: "background",
    playlistItems: [
      {
        id: "first",
        kind: "image",
        src: "tcmedia://first",
        durationMs: 100,
        fit: "cover",
        muted: true,
        volume: 0,
        loop: false,
        radius: 12,
        transition: "none",
      },
    ],
    ...overrides,
  };
}

describe("LayoutSurface playlist zones", () => {
  it.each(fixtures.fallback)("$name", (fixture) => {
    const first = playlistZone().playlistItems![0]!;
    const { surface, clock } = surfaceFor([
      playlistZone({
        fallback: fixture.fallback as "hide" | "background" | "previous",
        playlistItems: [
          first,
          { ...first, id: "second", src: "tcmedia://second" },
        ],
      }),
    ]);
    const zone = surface.element.firstElementChild as HTMLElement;
    const previous = zone.firstElementChild as HTMLImageElement;
    if (fixture.hasPrevious) previous.onload?.(new Event("load"));
    clock.advance(100);
    const current = zone.firstElementChild as HTMLImageElement;
    if (fixture.failed) current.onerror?.(new Event("error"));
    if (fixture.expected === "previous")
      expect(zone.firstElementChild).toBe(previous);
    else if (fixture.expected === "current")
      expect(zone.firstElementChild).toBe(current);
    else expect(zone.childElementCount).toBe(0);
    expect(zone.style.visibility).toBe(
      fixture.expected === "hide" ? "hidden" : "visible",
    );
    surface.dispose();
  });
  it("applies item radius and hides a failed zone when selected", () => {
    const { surface } = surfaceFor([playlistZone({ fallback: "hide" })]);
    const zone = surface.element.firstElementChild as HTMLElement;
    const image = zone.firstElementChild as HTMLImageElement;
    expect(image.style.borderRadius).toBe("12px");
    image.onerror?.(new Event("error"));
    expect(zone.style.visibility).toBe("hidden");
    expect(zone.childElementCount).toBe(0);
    surface.dispose();
  });

  it("restores the last loaded item for the previous-item fallback", () => {
    const zone = playlistZone({
      fallback: "previous",
      playlistItems: [
        ...playlistZone().playlistItems!,
        {
          id: "last",
          kind: "image",
          src: "tcmedia://last",
          durationMs: 100,
          fit: "contain",
          muted: true,
          volume: 0,
          loop: false,
          radius: 12,
          transition: "none",
        },
      ],
    });
    const { surface, clock } = surfaceFor([zone]);
    const container = surface.element.firstElementChild as HTMLElement;
    const first = container.firstElementChild as HTMLImageElement;
    first.onload?.(new Event("load"));
    clock.advance(100);
    const last = container.firstElementChild as HTMLImageElement;
    expect(last.src).toContain("tcmedia://last");
    last.onerror?.(new Event("error"));
    expect(container.firstElementChild).toBe(first);
    surface.dispose();
  });

  it("uses the item transition when it mounts the next image", () => {
    const zone = playlistZone({
      loop: true,
      playlistItems: [
        ...playlistZone().playlistItems!,
        {
          id: "next",
          kind: "image",
          src: "tcmedia://next",
          durationMs: 100,
          fit: "contain",
          muted: true,
          volume: 0,
          loop: false,
          radius: 0,
          transition: "crossfade",
        },
      ],
    });
    const { surface, clock } = surfaceFor([zone]);
    const first = surface.element.firstElementChild!
      .firstElementChild as HTMLImageElement;
    first.onload?.(new Event("load"));
    clock.advance(100);
    expect(animate).toHaveBeenCalledTimes(2);
    surface.dispose();
  });
});

function makeSurface(zone: RuntimeLayoutZone) {
  return surfaceFor([zone]).surface;
}

describe("LayoutSurface video-zone timing", () => {
  it("reapplies a single looping video's start offset on each pass", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const zone = playlistZone({ loop: true });
    zone.playlistItems = [
      { ...zone.playlistItems![0]!, kind: "video", videoStartOffsetMs: 2_000 },
    ];
    const surface = makeSurface(zone);
    const first = surface.element.querySelector("video")!;
    expect(first.loop).toBe(false);
    first.onloadedmetadata?.(new Event("loadedmetadata"));
    expect(first.currentTime).toBe(2);
    first.onended?.(new Event("ended"));
    const second = surface.element.querySelector("video")!;
    expect(second).not.toBe(first);
    second.onloadedmetadata?.(new Event("loadedmetadata"));
    expect(second.currentTime).toBe(2);
    surface.dispose();
  });

  it("holds a non-looping final video at its authored end offset", () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi
      .spyOn(HTMLMediaElement.prototype, "pause")
      .mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const zone = playlistZone({ loop: false });
    zone.playlistItems = [
      { ...zone.playlistItems![0]!, kind: "video", videoEndOffsetMs: 5_000 },
    ];
    const surface = makeSurface(zone);
    const video = surface.element.querySelector("video")!;
    video.currentTime = 5;
    video.ontimeupdate?.(new Event("timeupdate"));
    expect(pause).toHaveBeenCalledOnce();
    expect(surface.element.querySelector("video")).toBe(video);
    surface.dispose();
  });
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
