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

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

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
  widgetEmpty() {},
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
  it.each(fixtures.fallback)("$name", async (fixture) => {
    const first = playlistZone().playlistItems![0]!;
    const { surface, clock } = surfaceFor([
      playlistZone({
        fallback: fixture.fallback as "hide" | "background" | "previous",
        playlistItems: fixture.hasPrevious
          ? [first, { ...first, id: "second", src: "tcmedia://second" }]
          : [first],
      }),
    ]);
    const zone = surface.element.firstElementChild as HTMLElement;
    const previous = zone.firstElementChild as HTMLImageElement;
    await surface.activate();
    if (fixture.hasPrevious) {
      previous.dispatchEvent(new Event("load"));
      await settle();
      clock.advance(100);
    }
    const current = zone.lastElementChild as HTMLImageElement;
    current.dispatchEvent(new Event(fixture.failed ? "error" : "load"));
    await settle();
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
  it("applies item radius and hides a failed zone when selected", async () => {
    const { surface } = surfaceFor([playlistZone({ fallback: "hide" })]);
    const zone = surface.element.firstElementChild as HTMLElement;
    const image = zone.firstElementChild as HTMLImageElement;
    expect(image.style.borderRadius).toBe("12px");
    image.dispatchEvent(new Event("error"));
    await settle();
    expect(zone.style.visibility).toBe("hidden");
    expect(zone.childElementCount).toBe(0);
    surface.dispose();
  });

  it("restores the last loaded item for the previous-item fallback", async () => {
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
    await surface.activate();
    first.dispatchEvent(new Event("load"));
    await settle();
    clock.advance(100);
    const last = container.lastElementChild as HTMLImageElement;
    expect(last.src).toContain("tcmedia://last");
    last.dispatchEvent(new Event("error"));
    await settle();
    expect(container.firstElementChild).toBe(first);
    surface.dispose();
  });

  it("uses the item transition when the next image is ready", async () => {
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
    await surface.activate();
    first.dispatchEvent(new Event("load"));
    await settle();
    clock.advance(100);
    surface.element
      .querySelectorAll("img")[1]!
      .dispatchEvent(new Event("load"));
    await settle();
    expect(animate).toHaveBeenCalledTimes(2);
    surface.dispose();
  });
});

function makeSurface(zone: RuntimeLayoutZone) {
  return surfaceFor([zone]).surface;
}

describe("LayoutSurface video-zone timing", () => {
  it("reapplies a single looping video's start offset on each pass", async () => {
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
    first.dispatchEvent(new Event("loadedmetadata"));
    await surface.activate();
    first.dispatchEvent(new Event("canplay"));
    await settle();
    expect(first.currentTime).toBe(2);
    first.dispatchEvent(new Event("ended"));
    const second = surface.element.querySelectorAll("video")[1]!;
    expect(second).not.toBe(first);
    second.dispatchEvent(new Event("loadedmetadata"));
    expect(second.currentTime).toBe(2);
    surface.dispose();
  });

  it("holds a non-looping final video at its authored end offset", async () => {
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
    await surface.activate();
    video.dispatchEvent(new Event("canplay"));
    await settle();
    video.currentTime = 5;
    video.dispatchEvent(new Event("timeupdate"));
    expect(pause).toHaveBeenCalledOnce();
    expect(surface.element.querySelector("video")).toBe(video);
    surface.dispose();
  });
  it("starts at the item offset and advances at its end offset", async () => {
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
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.currentTime).toBe(2);
    await surface.activate();
    video.dispatchEvent(new Event("canplay"));
    await settle();
    video.currentTime = 5;
    video.dispatchEvent(new Event("timeupdate"));
    expect(container.lastElementChild?.tagName).toBe("IMG");
    surface.dispose();
  });

  it("advances a video without an end offset when the media ends", async () => {
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
    await surface.activate();
    video.dispatchEvent(new Event("canplay"));
    await settle();
    video.dispatchEvent(new Event("ended"));
    expect(container.lastElementChild?.tagName).toBe("IMG");
    surface.dispose();
  });
});

describe("LayoutSurface zone declarations", () => {
  it("declares every mounted zone when it is activated, rotating ones apart", async () => {
    const evidence: [string, string | undefined][] = [];
    const recording = {
      ...sink,
      evidence: (kind: string, zoneId?: string) =>
        void evidence.push([kind, zoneId]),
    } as SurfaceSink;
    const item = playlistZone().playlistItems![0]!;
    const zones = [
      playlistZone({ id: "static", playlistItems: [item] }),
      playlistZone({
        id: "promo",
        loop: true,
        playlistItems: [item, { ...item, id: "second" }],
      }),
      playlistZone({ id: "", playlistItems: [item] }),
    ];
    const layout: RuntimeLayoutPayload = {
      canvasWidth: 100,
      canvasHeight: 100,
      background: "#000",
      zones,
    };
    const surface = new LayoutSurface(
      {
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
      },
      {
        clock: new ManualClock({ wallMs: 0 }),
        sink: recording,
        animationScale: 1,
      },
    );
    expect(evidence.filter(([kind]) => kind.includes("declared"))).toEqual([]);
    await surface.activate();
    expect(
      evidence.filter(([kind]) => kind !== "layout-zone-rendered"),
    ).toEqual([
      ["layout-zone-declared", "static"],
      ["layout-zone-rotating", "promo"],
    ]);
    surface.dispose();
  });
});
