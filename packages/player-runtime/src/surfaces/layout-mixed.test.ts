// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetMountState } from "@tilecast/widget-sdk/mount";
import { ManualClock } from "../clock/scheduler";
import type {
  RuntimeItem,
  RuntimeLayoutZonePlaylistItem,
} from "../host/contract";
import type { RuntimeWidgetHost } from "../widgets/host";
import { LayoutSurface } from "./layout-surface";
import { specFromWebDescriptor, specFromYouTube } from "../remote-web/spec";
import type { MediaSurface, SurfaceEnvironment, SurfaceSink } from "./surface";

const component: RuntimeLayoutZonePlaylistItem = {
  id: "component",
  kind: "widget",
  durationMs: 100,
  widget: {
    component: {
      type: "tilecast.clock",
      version: 1,
      config: {},
      dataSources: [],
      media: [],
      empty: "skip-eligible",
    },
    documents: {},
    media: {},
    regional: { locale: "en-US", timeZone: "UTC", hourCycle: "locale" },
  },
};
const tree: RuntimeLayoutZonePlaylistItem = {
  id: "tree",
  kind: "widget",
  durationMs: 100,
  widget: {
    background: "#000",
    root: { t: "clock", timezone: "UTC", showSeconds: true, style: {} },
  },
};
const media = (kind: "image" | "video"): RuntimeLayoutZonePlaylistItem => ({
  id: kind,
  kind,
  src: `tcmedia://${kind}`,
  durationMs: 100,
  fit: "contain",
  muted: true,
  volume: 0,
  loop: false,
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
let frames: Map<number, FrameRequestCallback>;
const paint = async () => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
  await settle();
};
const surfaces: LayoutSurface[] = [];

function harness(
  items: RuntimeLayoutZonePlaylistItem[],
  remoteWeb?: SurfaceEnvironment["remoteWeb"],
) {
  const clock = new ManualClock({ wallMs: 0 });
  const states: ((state: WidgetMountState) => void)[] = [];
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const widgets = {
    mount: vi.fn(
      (
        container: HTMLElement,
        _payload: unknown,
        onState: (state: WidgetMountState) => void,
      ) => {
        container.textContent = "component content";
        states.push(onState);
        const dispose = vi.fn();
        disposals.push(dispose);
        return { dispose };
      },
    ),
  } as unknown as RuntimeWidgetHost;
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
  const zone = {
    id: "rotating",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    layer: 0,
    opacity: 1,
    loop: true,
    playlistItems: items,
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
      canvasWidth: 200,
      canvasHeight: 100,
      background: "#000",
      zones: [
        zone,
        {
          ...zone,
          id: "adjacent",
          x: 100,
          playlistItems: undefined,
          render: { t: "text", value: "Always here", style: {} },
        },
      ],
    },
  };
  const surface = new LayoutSurface(item, {
    clock,
    sink,
    widgets,
    remoteWeb,
    animationScale: 0,
  });
  surfaces.push(surface);
  document.body.append(surface.element);
  return {
    surface,
    clock,
    sink,
    states,
    disposals,
    widgets,
    zone: surface.element.firstElementChild as HTMLElement,
    adjacent: surface.element.lastElementChild,
  };
}

beforeEach(() => {
  frames = new Map();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  surfaces.splice(0).forEach((surface) => surface.dispose());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mixed Layout playlist lifecycle", () => {
  it("mounts sandboxed occurrences through the shared Widget host and releases their execution at the boundary", async () => {
    if (component.kind !== "widget" || !("component" in component.widget))
      throw new Error("expected component fixture");
    const widget = {
      ...component.widget,
      execution: { kind: "sandboxed" as const, frameUrl: "authorized-frame" },
      media: { "asset/variant": "authorized-media" },
    };
    const h = harness([{ ...component, widget }, tree]);
    await h.surface.activate();
    expect(h.widgets.mount).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      widget,
      expect.any(Function),
    );
    h.clock.advance(1000);
    expect(h.disposals[0]).not.toHaveBeenCalled();
    h.states[0]!({ state: "ready" });
    await settle();
    await paint();
    h.clock.advance(100);
    await settle();
    await paint();
    expect(h.disposals[0]).toHaveBeenCalledOnce();
    expect(h.adjacent?.textContent).toBe("Always here");
  });

  it.each([
    {
      provider: "remote page",
      spec: specFromWebDescriptor({
        mode: "remote",
        url: "https://example.org",
      })!,
    },
    {
      provider: "fixed YouTube",
      spec: specFromYouTube(
        { videoId: "dQw4w9WgXcQ", fixedDurationSeconds: 1 },
        null,
      )!,
    },
  ])(
    "gives $provider its full slot after host readiness and retains its audio policy",
    async ({ spec }) => {
      let prepared!: () => void;
      const dispose = vi.fn();
      const remote = vi.fn(
        (_item: RuntimeItem, _sink: SurfaceSink): MediaSurface => ({
          element: document.createElement("div"),
          prepare: () =>
            new Promise<void>((resolve) => {
              prepared = resolve;
            }),
          activate: vi.fn().mockResolvedValue(undefined),
          pause: vi.fn(),
          seek: vi.fn().mockResolvedValue(undefined),
          dispose,
        }),
      );
      const h = harness(
        [
          {
            id: "timed-web",
            kind: "remote-web",
            durationMs: 100,
            remoteWeb: spec,
            audioEnabled: true,
            volume: 0.4,
          },
          tree,
        ],
        remote,
      );
      await h.surface.activate();
      h.clock.advance(1000);
      expect(
        h.zone.firstElementChild?.getAttribute("data-tilecast-zone-item"),
      ).toBe("timed-web");
      expect(h.sink.evidence).not.toHaveBeenCalledWith(
        "layout-zone-rendered",
        "rotating",
      );
      prepared();
      await settle();
      expect(remote.mock.calls[0]?.[0]).toMatchObject({
        remoteWeb: spec,
        audioEnabled: true,
        volume: 0.4,
      });
      h.clock.advance(99);
      expect(dispose).not.toHaveBeenCalled();
      h.clock.advance(1);
      await settle();
      await paint();
      expect(dispose).toHaveBeenCalledOnce();
      expect(h.adjacent?.textContent).toBe("Always here");
      expect(h.sink.ended).not.toHaveBeenCalled();
    },
  );

  it("waits for YouTube completion and disposes its player before the next occurrence without accepting duplicate ends", async () => {
    const instances: {
      sink: SurfaceSink;
      dispose: ReturnType<typeof vi.fn>;
    }[] = [];
    const remote = vi.fn(
      (_item: RuntimeItem, sink: SurfaceSink): MediaSurface => {
        expect(
          instances.every(
            (instance) => instance.dispose.mock.calls.length === 1,
          ),
        ).toBe(true);
        const dispose = vi.fn();
        instances.push({ sink, dispose });
        return {
          element: document.createElement("div"),
          prepare: vi.fn().mockResolvedValue(undefined),
          activate: vi.fn().mockResolvedValue(undefined),
          pause: vi.fn(),
          seek: vi.fn().mockResolvedValue(undefined),
          dispose,
        };
      },
    );
    const spec = specFromYouTube({ videoId: "dQw4w9WgXcQ" }, null)!;
    const h = harness(
      [
        { id: "first", kind: "remote-web", durationMs: 100, remoteWeb: spec },
        { id: "second", kind: "remote-web", durationMs: 100, remoteWeb: spec },
        tree,
      ],
      remote,
    );
    await h.surface.activate();
    await settle();
    h.clock.advance(1000);
    expect(remote).toHaveBeenCalledOnce();
    instances[0]!.sink.ended("ended");
    await settle();
    expect(remote).toHaveBeenCalledTimes(2);
    instances[0]!.sink.ended("ended");
    expect(
      h.zone.firstElementChild?.getAttribute("data-tilecast-zone-item"),
    ).toBe("second");
    instances[1]!.sink.ended("ended");
    await settle();
    await paint();
    expect(instances[1]!.dispose).toHaveBeenCalledOnce();
    expect(
      h.zone.firstElementChild?.getAttribute("data-tilecast-zone-item"),
    ).toBe("tree");
    expect(h.adjacent?.textContent).toBe("Always here");
    expect(h.sink.ended).not.toHaveBeenCalled();
  });

  it("rotates image → component → video → compatibility Widget with independent adjacent content", async () => {
    const h = harness([media("image"), component, media("video"), tree]);
    await h.surface.activate();
    await paint();
    expect(h.sink.evidence).not.toHaveBeenCalledWith(
      "layout-zone-rendered",
      "rotating",
    );
    h.zone.querySelector("img")!.dispatchEvent(new Event("load"));
    await settle();
    h.clock.advance(100);
    await settle();
    expect(h.zone.textContent).toContain("component content");
    h.clock.advance(10_000);
    expect(h.states).toHaveLength(1);
    h.states[0]!({ state: "ready" });
    await settle();
    await paint();
    h.states[0]!({ state: "ready" });
    h.clock.advance(40);
    h.surface.pause();
    h.clock.advance(1000);
    expect(h.zone.querySelector("video")).toBeNull();
    await h.surface.activate();
    await settle();
    h.clock.advance(59);
    expect(h.zone.querySelector("video")).toBeNull();
    h.clock.advance(1);
    const video = h.zone.querySelector("video")!;
    video.dispatchEvent(new Event("canplay"));
    await settle();
    expect(h.disposals[0]).toHaveBeenCalledOnce();
    h.states[0]!({ state: "error", code: "stale" });
    expect(h.sink.zoneFailed).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("ended"));
    await settle();
    await paint();
    expect(h.zone.querySelector("video")).toBeNull();
    expect(h.clock.pendingTimers).toBeGreaterThan(0);
    expect(h.adjacent?.textContent).toBe("Always here");
    h.clock.advance(100);
    await settle();
    expect(h.zone.querySelector("img")).not.toBeNull();
    h.surface.dispose();
    h.clock.advance(100_000);
    expect(h.clock.pendingTimers).toBe(0);
    expect(frames.size).toBe(0);
  });

  it("expected-empty components stay zone-local and late lifecycle errors report only their zone", async () => {
    const h = harness([component, tree]);
    await h.surface.activate();
    h.states[0]!({ state: "empty", reason: "no records" });
    await settle();
    await paint();
    expect(h.sink.widgetEmpty).not.toHaveBeenCalled();
    expect(h.sink.ended).not.toHaveBeenCalled();
    h.states[0]!({ state: "error", code: "render_failed" });
    await settle();
    await paint();
    expect(h.sink.zoneFailed).toHaveBeenCalledWith(
      "rotating",
      "widget render_failed",
    );
    expect(h.adjacent?.textContent).toBe("Always here");
    expect(h.disposals[0]).toHaveBeenCalledOnce();
  });

  it("disposes replaced remote surfaces and ignores stale asynchronous completion", async () => {
    let complete!: () => void;
    let remoteSink!: SurfaceSink;
    const dispose = vi.fn();
    const remote = vi.fn(
      (_item: RuntimeItem, sink: SurfaceSink): MediaSurface => {
        remoteSink = sink;
        return {
          element: document.createElement("div"),
          prepare: () =>
            new Promise<void>((resolve) => {
              complete = resolve;
            }),
          activate: vi.fn().mockResolvedValue(undefined),
          pause: vi.fn(),
          seek: vi.fn().mockResolvedValue(undefined),
          dispose,
        };
      },
    );
    const h = harness(
      [
        {
          id: "web",
          kind: "remote-web",
          durationMs: 100,
          remoteWeb: {
            content: {
              kind: "page",
              url: "https://example.org",
              allowedHosts: ["example.org"],
              javascriptEnabled: true,
              domStorageEnabled: false,
              cookiePolicy: "disabled",
              userAgent: "",
              zoomPercent: 100,
              scrollX: 0,
              scrollY: 0,
              backgroundColor: "#000",
            },
            presentation: {
              loadTimeoutSeconds: 15,
              reloadIntervalSeconds: null,
              lifecycle: "destroy_on_hide",
              warmSeconds: 0,
              onlineOnly: true,
              failureBehavior: "placeholder",
              fallbackSrc: null,
              playUntilEnd: false,
            },
          },
        },
        tree,
      ],
      remote,
    );
    await h.surface.activate();
    remoteSink.failed("load failed");
    await settle();
    await paint();
    const evidence = vi.mocked(h.sink.evidence).mock.calls.length;
    complete();
    remoteSink.evidence("website-loaded");
    await settle();
    expect(vi.mocked(h.sink.evidence).mock.calls).toHaveLength(evidence);
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.adjacent?.textContent).toBe("Always here");
  });
});
