// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWidgetResources,
  TILECAST_DISPLAY_THEME,
  type WidgetContext,
} from "@tilecast/widget-sdk";
import type {
  WidgetComponentRef,
  WidgetMountState,
} from "@tilecast/widget-sdk/mount";
import type { WidgetClock } from "@tilecast/widget-sdk";
import { studioWidgetDiscovery } from "./studioWidgets";
import { WidgetPreviewHost } from "./WidgetPreviewHost";
import { PreviewClock } from "./previewClock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const definition = studioWidgetDiscovery.registry.lookup("tilecast.clock", 1)!;

function context(clock: WidgetClock): WidgetContext {
  return {
    clock,
    locale: "en-US",
    timeZone: "UTC",
    hourCycle: "locale",
    theme: TILECAST_DISPLAY_THEME,
    motion: { reduced: false },
    mode: "preview",
  };
}

function component(config: Record<string, unknown>): WidgetComponentRef {
  return { type: "tilecast.clock", version: 1, config };
}

const FULL_CONFIG = {
  timeZone: "",
  format: "locale",
  showSeconds: false,
  style: "standard",
  showDate: false,
  background: "#0E141B",
  foreground: "#F5F7FA",
};

describe("WidgetPreviewHost", () => {
  it("mounts the real Web Component from the Studio registry", async () => {
    expect(definition).toBeDefined();
    const states: WidgetMountState[] = [];
    render(
      <WidgetPreviewHost
        component={component(FULL_CONFIG)}
        resources={createWidgetResources({ documents: new Map() }, {})}
        context={context(new PreviewClock())}
        frame={{ width: 960, height: 540 }}
        label="Clock preview"
        onState={(state) => states.push(state)}
      />,
    );
    const region = screen.getByRole("img", { name: "Clock preview" });
    const element = await waitFor(() =>
      region.querySelector("tc-widget-clock"),
    );
    expect(element).toBeInTheDocument();
    await waitFor(() =>
      expect(states.map((state) => state.state)).toContain("ready"),
    );
    // The mounted element is the registered Clock class, not a stand-in.
    expect(customElements.get("tc-widget-clock")).toBe(
      definition.element as CustomElementConstructor,
    );
  });

  it("fits the selected frame inside a narrower editor column without cropping", async () => {
    let resize: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }

        observe = observe;
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );

    render(
      <WidgetPreviewHost
        component={component(FULL_CONFIG)}
        resources={createWidgetResources({ documents: new Map() }, {})}
        context={context(new PreviewClock())}
        frame={{ width: 960, height: 540 }}
        label="Clock preview"
      />,
    );

    const region = screen.getByRole("img", { name: "Clock preview" });
    await waitFor(() => region.querySelector("tc-widget-clock"));
    expect(observe).toHaveBeenCalledWith(region);

    act(() => {
      resize?.(
        [
          {
            // Prefer the content box over the legacy rectangle when both are
            // available. The conflicting fallback value makes that explicit.
            contentBoxSize: [{ inlineSize: 600, blockSize: 338 }],
            contentRect: { width: 400 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });

    const stage = region.firstElementChild as HTMLElement;
    const intrinsicFrame = stage.firstElementChild as HTMLElement;
    expect(region.style.aspectRatio).toBe("960 / 540");
    expect(region.style.overflow).toBe("hidden");
    expect(stage.style.width).toBe("960px");
    expect(stage.style.height).toBe("540px");
    expect(stage.style.transform).toBe("scale(0.625)");
    expect(intrinsicFrame.style.width).toBe("960px");
    expect(intrinsicFrame.style.height).toBe("540px");
  });

  it("falls back to contentRect when contentBoxSize is unavailable", async () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }

        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );

    render(
      <WidgetPreviewHost
        component={component(FULL_CONFIG)}
        resources={createWidgetResources({ documents: new Map() }, {})}
        context={context(new PreviewClock())}
        frame={{ width: 960, height: 540 }}
        label="Clock preview"
      />,
    );

    const region = screen.getByRole("img", { name: "Clock preview" });
    await waitFor(() => region.querySelector("tc-widget-clock"));
    act(() => {
      resize?.(
        [{ contentRect: { width: 480 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect((region.firstElementChild as HTMLElement).style.transform).toBe(
      "scale(0.5)",
    );
  });

  it.each([
    ["Landscape", { width: 960, height: 540 }],
    ["Portrait", { width: 540, height: 960 }],
    ["Wide strip", { width: 960, height: 240 }],
    ["Tall sidebar", { width: 360, height: 960 }],
    ["Small zone", { width: 320, height: 180 }],
    ["Custom", { width: 777, height: 333 }],
  ])(
    "keeps the %s frame intrinsic while the Widget stays mounted",
    async (_name, frame) => {
      const resources = createWidgetResources(
        { documents: new Map() },
        { dataSources: ["probe"] },
      );
      const previewContext = context(new PreviewClock());
      const { container, rerender } = render(
        <WidgetPreviewHost
          component={component(FULL_CONFIG)}
          resources={resources}
          context={previewContext}
          frame={{ width: 960, height: 540 }}
          label="Clock preview"
        />,
      );
      const before = await waitFor(() =>
        container.querySelector("tc-widget-clock"),
      );

      rerender(
        <WidgetPreviewHost
          component={component(FULL_CONFIG)}
          resources={createWidgetResources(
            { documents: new Map() },
            { dataSources: ["probe-next"] },
          )}
          context={{ ...previewContext, locale: "fr-FR" }}
          frame={frame}
          label="Clock preview"
        />,
      );

      const region = screen.getByRole("img", { name: "Clock preview" });
      const stage = region.firstElementChild as HTMLElement;
      const intrinsicFrame = stage.firstElementChild as HTMLElement;
      expect(container.querySelector("tc-widget-clock")).toBe(before);
      expect(region.style.aspectRatio).toBe(`${frame.width} / ${frame.height}`);
      expect(stage.style.width).toBe(`${frame.width}px`);
      expect(stage.style.height).toBe(`${frame.height}px`);
      expect(intrinsicFrame.style.width).toBe(`${frame.width}px`);
      expect(intrinsicFrame.style.height).toBe(`${frame.height}px`);
      expect(
        (
          before as HTMLElement & {
            context: WidgetContext;
          }
        ).context.locale,
      ).toBe("fr-FR");
    },
  );

  it("updates the element in place when the compiled config changes", async () => {
    const { container, rerender } = render(
      <WidgetPreviewHost
        component={component(FULL_CONFIG)}
        resources={createWidgetResources({ documents: new Map() }, {})}
        context={context(new PreviewClock())}
        frame={{ width: 960, height: 540 }}
        label="Clock preview"
      />,
    );
    const before = await waitFor(() =>
      container.querySelector("tc-widget-clock"),
    );
    rerender(
      <WidgetPreviewHost
        component={component({ ...FULL_CONFIG, showSeconds: true })}
        resources={createWidgetResources({ documents: new Map() }, {})}
        context={context(new PreviewClock())}
        frame={{ width: 960, height: 540 }}
        label="Clock preview"
      />,
    );
    expect(container.querySelector("tc-widget-clock")).toBe(before);
  });

  it("reports mount errors for unknown components", async () => {
    const states: WidgetMountState[] = [];
    render(
      <WidgetPreviewHost
        component={{ type: "tilecast.missing", version: 1, config: {} }}
        resources={createWidgetResources({ documents: new Map() }, {})}
        context={context(new PreviewClock())}
        frame={{ width: 320, height: 180 }}
        label="Missing preview"
        onState={(state) => states.push(state)}
      />,
    );
    await waitFor(() =>
      expect(states.some((state) => state.state === "error")).toBe(true),
    );
    expect(
      screen.queryByRole("img", { name: "Missing preview" }),
    ).toBeInTheDocument();
  });

  it("disposes the element on unmount", async () => {
    const { container, unmount } = render(
      <WidgetPreviewHost
        component={component(FULL_CONFIG)}
        resources={createWidgetResources({ documents: new Map() }, {})}
        context={context(new PreviewClock())}
        frame={{ width: 320, height: 180 }}
        label="Clock preview"
      />,
    );
    await waitFor(() => container.querySelector("tc-widget-clock"));
    unmount();
    expect(container.querySelector("tc-widget-clock")).toBeNull();
  });
});
