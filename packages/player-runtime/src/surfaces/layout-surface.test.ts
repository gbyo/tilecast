// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  RuntimeItem,
  RuntimeLayoutPayload,
  RuntimeLayoutZone,
} from "../host/contract";
import { LayoutSurface } from "./layout-surface";
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
