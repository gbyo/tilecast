// @vitest-environment jsdom
/*
 * The runtime side of Widgets V2: discovery agrees with the generated
 * capability list hosts advertise, fullscreen Widgets and Layout zones mount
 * through the same WidgetMount, the runtime (not the Widget) turns the
 * Widget's state into evidence, and nothing is left behind on disposal.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  RuntimeItem,
  RuntimeWidgetComponentPayload,
} from "../host/contract";
import { ManualClock } from "../clock/scheduler";
import type { SurfaceEnvironment, SurfaceSink } from "../surfaces/surface";

// jsdom has no constructed-stylesheet adoption. The runtime refuses to
// mount without it (its CSP forbids the <style> fallback), so the tests that
// mount stand in for a supporting engine; the refusal is tested first.
let host: typeof import("./host");
let surfaceModule: typeof import("../surfaces/component-widget-surface");
let layoutModule: typeof import("../surfaces/layout-surface");
let generated: typeof import("./capabilities.gen");

beforeAll(async () => {
  host = await import("./host");
  surfaceModule = await import("../surfaces/component-widget-surface");
  layoutModule = await import("../surfaces/layout-surface");
  generated = await import("./capabilities.gen");
});

const WALL = Date.parse("2026-09-01T16:00:00Z");

const payload = (
  config: Record<string, unknown> = {},
): RuntimeWidgetComponentPayload => ({
  component: {
    type: "tilecast.clock",
    version: 1,
    config: {
      timeZone: "",
      format: "24",
      showSeconds: true,
      style: "standard",
      showDate: false,
      ...config,
    },
    dataSources: [],
    media: [],
  },
  documents: {},
  media: {},
  regional: { locale: "en-US", timeZone: "UTC", hourCycle: "locale" },
});

function environment() {
  const clock = new ManualClock({ wallMs: WALL });
  const widgets = new host.RuntimeWidgetHost({
    clock,
    animationScale: 0,
    reducedMotion: () => true,
  });
  widgets.setClockOffset(90_000);
  const log: string[] = [];
  const sink: SurfaceSink = {
    ended: () => log.push("ended"),
    failed: (message) => log.push(`failed:${message}`),
    resumed: () => undefined,
    evidence: (kind, zone) => log.push(`${kind}${zone ? `/${zone}` : ""}`),
    websiteFailed: () => undefined,
    websiteRecovered: () => undefined,
    fallbackShown: () => undefined,
  };
  const env: SurfaceEnvironment = { clock, sink, animationScale: 0, widgets };
  return { clock, widgets, env, log };
}

const widgetItem = (widget: RuntimeWidgetComponentPayload): RuntimeItem => ({
  id: "clock-item",
  kind: "widget",
  src: "",
  durationMs: null,
  fitMode: "contain",
  audioEnabled: false,
  volume: 1,
  videoStartOffsetMs: null,
  videoEndOffsetMs: null,
  widget,
});

function withAdoptedStyleSheets(enabled: boolean) {
  for (const proto of [Document.prototype, ShadowRoot.prototype]) {
    if (enabled) {
      Object.defineProperty(proto, "adoptedStyleSheets", {
        configurable: true,
        get: () => [],
        set: () => undefined,
      });
    } else {
      delete (proto as unknown as Record<string, unknown>)[
        "adoptedStyleSheets"
      ];
    }
  }
}

afterEach(() => {
  withAdoptedStyleSheets(false);
  document.body.replaceChildren();
});

describe("Widget discovery", () => {
  it("finds every Widget without a diagnostic", () => {
    expect(host.widgetDiscovery.problems).toEqual([]);
    expect(host.widgetDiscovery.widgets.length).toBeGreaterThan(0);
  });

  it("matches the generated capability list hosts advertise", () => {
    expect(host.widgetDiscovery.registry.capabilities()).toEqual({
      ...generated.WIDGET_COMPONENT_CAPABILITIES,
    });
  });
});

describe("ComponentWidgetSurface", () => {
  it("refuses to mount where styles cannot be adopted", async () => {
    const { env } = environment();
    const surface = new surfaceModule.ComponentWidgetSurface(
      widgetItem(payload()),
      env,
    );
    document.body.appendChild(surface.element);
    await expect(surface.prepare()).rejects.toThrow(
      "widget widget_styles_unsupported",
    );
    surface.dispose();
  });

  it("prepares once the Widget renders, on the corrected clock", async () => {
    withAdoptedStyleSheets(true);
    const { env, clock } = environment();
    const surface = new surfaceModule.ComponentWidgetSurface(
      widgetItem(payload()),
      env,
    );
    document.body.appendChild(surface.element);
    await surface.prepare();
    const element = surface.element.querySelector<HTMLElement>(
      "[data-tilecast-widget]",
    )!;
    const text = () => element.shadowRoot!.textContent!.replace(/\s+/g, "");
    // 16:00:00 local + 90 s host offset.
    expect(text()).toContain("16:0130");
    clock.advance(1_010);
    await (element as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    expect(text()).toContain("16:0131");
    surface.dispose();
    expect(element.isConnected).toBe(false);
  });

  it("rejects an unknown component version instead of guessing", async () => {
    withAdoptedStyleSheets(true);
    const { env } = environment();
    const newer = payload();
    newer.component.version = 2;
    const surface = new surfaceModule.ComponentWidgetSurface(
      widgetItem(newer),
      env,
    );
    await expect(surface.prepare()).rejects.toThrow("widget_unsupported");
  });
});

describe("Layout zones", () => {
  it("mount components and report zone evidence once each", async () => {
    withAdoptedStyleSheets(true);
    const { env, log } = environment();
    const item: RuntimeItem = {
      ...widgetItem(payload()),
      kind: "layout",
      widget: undefined,
      layout: {
        canvasWidth: 1920,
        canvasHeight: 1080,
        background: "#000",
        zones: [
          {
            id: "a",
            x: 0,
            y: 0,
            width: 960,
            height: 1080,
            layer: 1,
            opacity: 1,
            component: payload({ style: "analog" }),
          },
          {
            id: "b",
            x: 960,
            y: 0,
            width: 960,
            height: 1080,
            layer: 1,
            opacity: 1,
            component: payload({ timeZone: "Asia/Tokyo" }),
          },
        ],
      },
    };
    const surface = new layoutModule.LayoutSurface(item, env);
    document.body.appendChild(surface.element);
    const mounted = surface.element.querySelectorAll("[data-tilecast-widget]");
    expect(mounted).toHaveLength(2);
    await Promise.all(
      Array.from(
        mounted,
        (el) =>
          (el as unknown as { updateComplete: Promise<unknown> })
            .updateComplete,
      ),
    );
    expect(
      log.filter((entry) => entry.startsWith("layout-zone-rendered")).sort(),
    ).toEqual(["layout-zone-rendered/a", "layout-zone-rendered/b"]);
    surface.dispose();
    expect(
      surface.element.querySelectorAll("[data-tilecast-widget]"),
    ).toHaveLength(0);
  });
});
