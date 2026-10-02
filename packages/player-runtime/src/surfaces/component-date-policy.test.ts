// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  RuntimeItem,
  RuntimeWidgetComponentPayload,
} from "../host/contract";
import type { RuntimeWidgetHost } from "../widgets/host";
import { ComponentWidgetSurface } from "./component-widget-surface";
import { LayoutSurface } from "./layout-surface";
import type { SurfaceEnvironment } from "./surface";

afterEach(() => vi.unstubAllGlobals());

it.each(["fullscreen", "layout"])(
  "honors hidden date policy in %s without mounting the Widget",
  async (placement) => {
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    const mount = vi.fn(() => {
      throw new Error("hidden Widget must not mount");
    });
    const failed = vi.fn();
    const zoneFailed = vi.fn();
    const environment: SurfaceEnvironment = {
      clock: new ManualClock({ wallMs: 0 }),
      animationScale: 0,
      widgets: { mount } as unknown as RuntimeWidgetHost,
      sink: {
        failed,
        zoneFailed,
        ended() {},
        resumed() {},
        evidence() {},
        websiteFailed() {},
        websiteRecovered() {},
        fallbackShown() {},
      },
    };
    const component: RuntimeWidgetComponentPayload = {
      component: {
        type: "tilecast.agenda",
        version: 1,
        config: {},
        dataSources: [],
        media: [],
      },
      documents: {},
      media: {},
      hidden: true,
      regional: {
        locale: "en-US",
        timeZone: "UTC",
        hourCycle: "h23",
      },
    };
    const item: RuntimeItem = {
      id: "item",
      kind: "widget",
      src: "",
      durationMs: 10000,
      fitMode: "contain",
      audioEnabled: false,
      volume: 0,
      videoStartOffsetMs: null,
      videoEndOffsetMs: null,
      widget: component,
    };
    const surface =
      placement === "fullscreen"
        ? new ComponentWidgetSurface(item, environment)
        : new LayoutSurface(
            {
              ...item,
              kind: "layout",
              layout: {
                canvasWidth: 1920,
                canvasHeight: 1080,
                background: "#000",
                zones: [
                  {
                    id: "zone",
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                    layer: 0,
                    opacity: 1,
                    component,
                  },
                ],
              },
            },
            environment,
          );
    await surface.prepare();
    await surface.activate();
    expect(mount).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(zoneFailed).not.toHaveBeenCalled();
    if (placement === "fullscreen")
      expect(surface.element.style.display).toBe("none");
    surface.dispose();
    surface.dispose();
  },
);
