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
import type { WidgetMountState } from "@tilecast/widget-sdk/mount";
import type { RuntimeWidgetHost } from "./host";
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
    empty: "render",
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
    zoneFailed: (zoneId, message) =>
      log.push(`zoneFailed:${zoneId}:${message}`),
    widgetEmpty: () => log.push("widget-empty"),
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

const layoutItem = (
  component: RuntimeWidgetComponentPayload,
  zoneId = "zone",
): RuntimeItem => ({
  ...widgetItem(payload()),
  kind: "layout",
  widget: undefined,
  layout: {
    canvasWidth: 1920,
    canvasHeight: 1080,
    background: "#000",
    zones: [
      {
        id: zoneId,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        layer: 1,
        opacity: 1,
        component,
      },
    ],
  },
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

  it("returns the WidgetMount empty result to the playback stage", async () => {
    const { env } = environment();
    const emptyWidgets = {
      mount: (
        _container: HTMLElement,
        _payload: RuntimeWidgetComponentPayload,
        onState: (state: WidgetMountState) => void,
      ) => {
        onState({ state: "empty", reason: "no_data" });
        return { dispose: () => undefined };
      },
    } as unknown as RuntimeWidgetHost;
    const surface = new surfaceModule.ComponentWidgetSurface(
      widgetItem(payload()),
      { ...env, widgets: emptyWidgets },
    );
    expect(await surface.prepare()).toEqual({ empty: true });
    surface.dispose();
  });

  it("reports a transition to empty after the Widget was shown", async () => {
    const { env, log } = environment();
    const emptyWidgets = {
      mount: (
        _container: HTMLElement,
        _payload: RuntimeWidgetComponentPayload,
        onState: (state: WidgetMountState) => void,
      ) => {
        onState({ state: "ready" });
        queueMicrotask(() => onState({ state: "empty", reason: "no_data" }));
        return { dispose: () => undefined };
      },
    } as unknown as RuntimeWidgetHost;
    const surface = new surfaceModule.ComponentWidgetSurface(
      widgetItem(payload()),
      { ...env, widgets: emptyWidgets },
    );
    await surface.prepare();
    await Promise.resolve();
    expect(log).toContain("widget-empty");
    surface.dispose();
  });

  it("rejects an unknown component version instead of guessing", async () => {
    withAdoptedStyleSheets(true);
    const { env } = environment();
    const newer = payload();
    // Newer than every bundled Widget version.
    newer.component.version = 99;
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

  it("reports errors before first readiness as zone failures", () => {
    withAdoptedStyleSheets(true);
    const { env, log } = environment();
    const unsupported = payload();
    unsupported.component.version = 99;
    const surface = new layoutModule.LayoutSurface(
      layoutItem(unsupported),
      env,
    );

    expect(log).toEqual(["zoneFailed:zone:widget widget_unsupported"]);
    expect(log.some((entry) => entry.startsWith("layout-zone-rendered"))).toBe(
      false,
    );
    surface.dispose();
  });

  it("reports a runtime error after readiness without repeating evidence", async () => {
    withAdoptedStyleSheets(true);
    const { env, log } = environment();
    const surface = new layoutModule.LayoutSurface(layoutItem(payload()), env);
    document.body.appendChild(surface.element);
    const element = surface.element.querySelector<HTMLElement>(
      "[data-tilecast-widget]",
    )!;
    await (element as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;

    element.dispatchEvent(
      new CustomEvent("tilecast-widget-error", {
        bubbles: true,
        composed: true,
        detail: { code: "runtime_failure" },
      }),
    );

    expect(
      log.filter((entry) => entry === "layout-zone-rendered/zone"),
    ).toHaveLength(1);
    expect(log).toContain("zoneFailed:zone:widget runtime_failure");
    expect(element.isConnected).toBe(true);
    surface.dispose();
  });

  it("reports readiness once across ready, empty, and ready updates", async () => {
    withAdoptedStyleSheets(true);
    const { env, log } = environment();
    const surface = new layoutModule.LayoutSurface(layoutItem(payload()), env);
    document.body.appendChild(surface.element);
    const element = surface.element.querySelector<HTMLElement>(
      "[data-tilecast-widget]",
    )!;
    await (element as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    element.dispatchEvent(
      new CustomEvent("tilecast-widget-empty", {
        bubbles: true,
        composed: true,
        detail: { reason: "no_content" },
      }),
    );
    element.dispatchEvent(
      new CustomEvent("tilecast-widget-ready", {
        bubbles: true,
        composed: true,
      }),
    );

    expect(
      log.filter((entry) => entry === "layout-zone-rendered/zone"),
    ).toHaveLength(1);
    expect(log.some((entry) => entry.startsWith("zoneFailed:"))).toBe(false);
    surface.dispose();
  });

  it("ignores stale component errors after its zone is disposed", async () => {
    withAdoptedStyleSheets(true);
    const { env, log } = environment();
    const surface = new layoutModule.LayoutSurface(layoutItem(payload()), env);
    document.body.appendChild(surface.element);
    const element = surface.element.querySelector<HTMLElement>(
      "[data-tilecast-widget]",
    )!;
    await (element as unknown as { updateComplete: Promise<unknown> })
      .updateComplete;
    surface.dispose();

    element.dispatchEvent(
      new CustomEvent("tilecast-widget-error", {
        bubbles: true,
        composed: true,
        detail: { code: "stale_failure" },
      }),
    );

    expect(log.some((entry) => entry.includes("stale_failure"))).toBe(false);
  });
});
