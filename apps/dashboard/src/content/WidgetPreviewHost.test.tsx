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

      const listedRegion = screen.getByRole("img", { name: "Clock preview" });
      const stage = listedRegion.firstElementChild as HTMLElement;
      const intrinsicFrame = stage.firstElementChild as HTMLElement;
      expect(container.querySelector("tc-widget-clock")).toBe(before);
      expect(listedRegion.style.aspectRatio).toBe(
        `${frame.width} / ${frame.height}`,
      );
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

  function stubResizeObserver() {
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
    return {
      observe,
      fire: (width: number) =>
        act(() => {
          resize?.(
            [{ contentRect: { width } } as ResizeObserverEntry],
            {} as ResizeObserver,
          );
        }),
    };
  }

  it("never upscales the standalone editor surface above its frame", async () => {
    const { fire } = stubResizeObserver();
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
    // A viewport wider than the frame (roomy Studio column) keeps 1:1.
    fire(1440);
    const stage = region.firstElementChild as HTMLElement;
    const intrinsicFrame = stage.firstElementChild as HTMLElement;
    expect(stage.style.transform).toBe("scale(1)");
    expect(intrinsicFrame.style.width).toBe("960px");
    expect(intrinsicFrame.style.height).toBe("540px");
  });

  it.each([
    { available: 540, scale: "scale(0.5)" },
    { available: 1080, scale: "scale(1)" },
    { available: 1620, scale: "scale(1.5)" },
  ])(
    "fill mode scales a Layout zone to $available px ($scale) without changing intrinsic geometry",
    async ({ available, scale }) => {
      const { fire } = stubResizeObserver();
      render(
        <WidgetPreviewHost
          component={component(FULL_CONFIG)}
          resources={createWidgetResources({ documents: new Map() }, {})}
          context={context(new PreviewClock())}
          frame={{ width: 1080, height: 270 }}
          label="Zone preview"
          fit="fill"
        />,
      );
      const region = screen.getByRole("img", { name: "Zone preview" });
      await waitFor(() => region.querySelector("tc-widget-clock"));
      fire(available);
      const stage = region.firstElementChild as HTMLElement;
      const intrinsicFrame = stage.firstElementChild as HTMLElement;
      // The Widget itself always sees the logical 1080x270 placement;
      // only the outer presentation scales to the displayed zone.
      expect(stage.style.transform).toBe(scale);
      expect(intrinsicFrame.style.width).toBe("1080px");
      expect(intrinsicFrame.style.height).toBe("270px");
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

  describe("sandboxed external Widgets", () => {
    const sandbox = {
      frameUrl: "/api/v1/packages/acme.athletics/widgets/scoreboard/frame",
      declared: { dataSources: [], media: [] },
    };
    const external = {
      type: "acme.scoreboard",
      version: 1,
      config: { label: "Final" },
    };

    function renderSandboxed(states: WidgetMountState[]) {
      return render(
        <WidgetPreviewHost
          component={external}
          resources={createWidgetResources({ documents: new Map() }, {})}
          context={context(new PreviewClock())}
          frame={{ width: 960, height: 540 }}
          label="Scoreboard preview"
          onState={(state) => states.push(state)}
          sandbox={sandbox}
        />,
      );
    }

    it("mounts a locked-down frame from the Server document", async () => {
      const states: WidgetMountState[] = [];
      const { container } = renderSandboxed(states);
      const frame = await waitFor(() => {
        const found = container.querySelector("iframe");
        expect(found).not.toBeNull();
        return found!;
      });
      // The frame URL carries the per-attach token as a fragment the
      // server never sees; the cached document stays token-free.
      const src = frame.getAttribute("src") ?? "";
      expect(src.startsWith(`${sandbox.frameUrl}#`)).toBe(true);
      expect(src.slice(sandbox.frameUrl.length + 1)).toMatch(
        /^[A-Za-z0-9_-]{22}$/,
      );
      expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(container.querySelector("acme-scoreboard")).toBeNull();
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((state) => state.state === "pending")).toBe(true);
    });

    it("reports bridge states without importing the Widget", async () => {
      const states: WidgetMountState[] = [];
      const { container } = renderSandboxed(states);
      const frame = await waitFor(() => {
        const found = container.querySelector("iframe");
        expect(found).not.toBeNull();
        return found!;
      });
      const spy = vi
        .spyOn(frame.contentWindow!, "postMessage")
        .mockImplementation(() => {});
      // The spy types the two-argument overload; the transfer rides
      // the third argument the handshake passes.
      const posted = () =>
        (spy.mock.calls as unknown[][]).map((call) => ({
          message: call[0],
          transfer: call[2],
        }));
      // The frame hello drives the handshake; the transfer carries the
      // port the frame reports on. The sandboxed frame posts from the
      // opaque origin and echoes the fragment token bound to this attach.
      const helloToken = (frame.getAttribute("src") ?? "").split("#")[1] ?? "";
      expect(helloToken).not.toBe("");
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "null",
            source: frame.contentWindow,
            data: {
              protocol: "tilecast.widget.bridge/1",
              kind: "frame-hello",
              helloToken,
            },
          }),
        );
      });
      await waitFor(() => expect(posted()).toHaveLength(1));
      const init = posted()[0]?.message as {
        nonce?: unknown;
        revision?: unknown;
      };
      expect(typeof init.nonce).toBe("string");
      // The mount effect mounts and the sync effect immediately updates,
      // so the init already carries the second input revision.
      expect(init.revision).toBe(2);
      const framePort = (posted()[0]?.transfer as unknown[])[0] as MessagePort;
      act(() => {
        framePort.postMessage({
          protocol: "tilecast.widget.bridge/1",
          nonce: init.nonce,
          revision: init.revision,
          state: { state: "ready" },
        });
      });
      await waitFor(() =>
        expect(states.map((state) => state.state)).toContain("ready"),
      );
    });

    it("remounts when the provider crosses the trust boundary", async () => {
      const states: WidgetMountState[] = [];
      const { container, rerender } = renderSandboxed(states);
      await waitFor(() => {
        expect(container.querySelector("iframe")).not.toBeNull();
      });
      rerender(
        <WidgetPreviewHost
          component={component(FULL_CONFIG)}
          resources={createWidgetResources({ documents: new Map() }, {})}
          context={context(new PreviewClock())}
          frame={{ width: 960, height: 540 }}
          label="Scoreboard preview"
          onState={(state) => states.push(state)}
        />,
      );
      await waitFor(() => container.querySelector("tc-widget-clock"));
      expect(container.querySelector("iframe")).toBeNull();
    });

    it("updates the frame in place when the compiled config changes", async () => {
      const states: WidgetMountState[] = [];
      const { container, rerender } = renderSandboxed(states);
      const before = await waitFor(() => {
        const found = container.querySelector("iframe");
        expect(found).not.toBeNull();
        return found!;
      });
      rerender(
        <WidgetPreviewHost
          component={{ ...external, config: { label: "Halftime" } }}
          resources={createWidgetResources({ documents: new Map() }, {})}
          context={context(new PreviewClock())}
          frame={{ width: 960, height: 540 }}
          label="Scoreboard preview"
          onState={(state) => states.push(state)}
          sandbox={sandbox}
        />,
      );
      expect(container.querySelector("iframe")).toBe(before);
    });
  });
});
