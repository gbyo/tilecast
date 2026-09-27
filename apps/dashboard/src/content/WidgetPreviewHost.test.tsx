// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      expect(
        states.some((state) => state.state === "error"),
      ).toBe(true),
    );
    expect(screen.queryByRole("img", { name: "Missing preview" })).toBeInTheDocument();
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
