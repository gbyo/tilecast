// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  THUMBNAIL_STAGE_COLOR,
  WIDGET_THUMBNAIL_FRAME,
  captureLayoutPreview,
  captureWidgetPreview,
  thumbnailPlacement,
} from "./widgetPreviewCapture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("captureWidgetPreview", () => {
  it("loads the temporary SVG from a CSP-compatible data URL", async () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 640,
      height: 360,
      top: 0,
      right: 640,
      bottom: 360,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
    );
    let imageSource = "";
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(value: string) {
          imageSource = value;
          queueMicrotask(() => this.onload?.());
        }
      },
    );

    const preview = document.createElement("div");
    preview.textContent = "12:34 PM";

    await expect(captureWidgetPreview(preview)).resolves.toMatchObject({
      type: "image/jpeg",
    });
    expect(imageSource).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(decodeURIComponent(imageSource.split(",", 2)[1]!)).toContain(
      "12:34 PM",
    );
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it("preserves generated ::before/::after content in captures", async () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 960,
      height: 540,
      top: 0,
      right: 960,
      bottom: 540,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
    );
    let imageSource = "";
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(value: string) {
          imageSource = value;
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    // jsdom does not resolve pseudo-element styles, so stand in for the
    // engine: the Timeline line (empty content, absolute box) and a
    // milestone dot (string content), plus a content:none control.
    const pseudoStyle = (entries: [string, string][]) => {
      const map = new Map(entries);
      return {
        getPropertyValue: (name: string) => map.get(name) ?? "",
        getPropertyPriority: () => "",
        [Symbol.iterator]: function* () {
          yield* map.keys();
        },
      } as unknown as CSSStyleDeclaration;
    };
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element: Element, pseudo?: string | null) => {
        if (
          element instanceof Element &&
          element.classList.contains("timeline") &&
          pseudo === "::before"
        )
          return pseudoStyle([
            ["content", '""'],
            ["position", "absolute"],
            ["width", "2px"],
            ["background", "rgb(245, 247, 250)"],
            ["opacity", "0.3"],
          ]);
        if (
          element instanceof Element &&
          element.classList.contains("milestone") &&
          pseudo === "::after"
        )
          return pseudoStyle([
            ["content", '"•"'],
            ["position", "absolute"],
            ["width", "9px"],
            ["height", "9px"],
          ]);
        return realGetComputedStyle(element, pseudo);
      },
    );

    const preview = document.createElement("div");
    const timeline = document.createElement("div");
    timeline.className = "timeline";
    const milestone = document.createElement("div");
    milestone.className = "milestone";
    const title = document.createElement("span");
    title.textContent = "Board meeting";
    milestone.appendChild(title);
    const plain = document.createElement("div");
    plain.className = "plain";
    plain.textContent = "No generated content here";
    timeline.appendChild(milestone);
    preview.appendChild(timeline);
    preview.appendChild(plain);

    await expect(captureWidgetPreview(preview)).resolves.toMatchObject({
      type: "image/jpeg",
    });
    const markup = decodeURIComponent(imageSource.split(",", 2)[1]!);
    // The Timeline line survives as a leading surrogate with its box style.
    const lineIndex = markup.indexOf('data-tc-captured-pseudo="::before"');
    expect(lineIndex).toBeGreaterThan(-1);
    expect(markup).toContain("width: 2px");
    expect(markup).toContain("opacity: 0.3");
    // ::before sorts before real children; the dot text is real text.
    expect(lineIndex).toBeLessThan(markup.indexOf("Board meeting"));
    expect(markup).toContain('data-tc-captured-pseudo="::after"');
    expect(markup).toContain("•");
    expect(markup.indexOf("Board meeting")).toBeLessThan(
      markup.indexOf('data-tc-captured-pseudo="::after"'),
    );
    // content:none/normal and url() generate no surrogate elements.
    expect(markup.match(/data-tc-captured-pseudo/g)).toHaveLength(2);
  });

  it("does not synthesize the Layout editor selection outline", async () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 960,
      height: 540,
      top: 0,
      right: 960,
      bottom: 540,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
    );
    let imageSource = "";
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(value: string) {
          imageSource = value;
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    const pseudoStyle = (entries: [string, string][]) => {
      const map = new Map(entries);
      return {
        getPropertyValue: (name: string) => map.get(name) ?? "",
        getPropertyPriority: () => "",
        [Symbol.iterator]: function* () {
          yield* map.keys();
        },
      } as unknown as CSSStyleDeclaration;
    };
    const preview = document.createElement("div");
    const placement = document.createElement("div");
    placement.className = "layout-placement is-selected";
    placement.textContent = "Selected placement";
    preview.appendChild(placement);
    const selectedPseudoRead = vi.fn();
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element: Element, pseudo?: string | null) => {
        if (element === placement && pseudo === "::after") {
          selectedPseudoRead();
          return pseudoStyle([
            ["content", '""'],
            ["border", "2px solid rgb(30, 100, 255)"],
          ]);
        }
        return realGetComputedStyle(element, pseudo);
      },
    );

    await expect(
      captureLayoutPreview(preview, 1920, 1080),
    ).resolves.toMatchObject({
      type: "image/jpeg",
    });
    const markup = decodeURIComponent(imageSource.split(",", 2)[1]!);
    expect(markup).toContain("Selected placement");
    expect(selectedPseudoRead).not.toHaveBeenCalled();
    expect(markup).not.toContain("data-tc-captured-pseudo");
    expect(markup).not.toContain("rgb(30, 100, 255)");
  });

  it("captures rendered content from open Widget shadow roots", async () => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 960,
      height: 540,
      top: 0,
      right: 960,
      bottom: 540,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
    );
    let imageSource = "";
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(value: string) {
          imageSource = value;
          queueMicrotask(() => this.onload?.());
        }
      },
    );

    const preview = document.createElement("div");
    const widget = document.createElement("tc-test-widget");
    const shadow = widget.attachShadow({ mode: "open" });
    const value = document.createElement("strong");
    value.className = "clock-value";
    value.textContent = "12:34 PM from Shadow DOM";
    shadow.appendChild(value);
    preview.appendChild(widget);

    await expect(captureWidgetPreview(preview)).resolves.toMatchObject({
      type: "image/jpeg",
    });
    const markup = decodeURIComponent(imageSource.split(",", 2)[1]!);
    expect(markup).toContain("12:34 PM from Shadow DOM");
    expect(markup).toContain("clock-value");
  });
});

describe("thumbnail geometry", () => {
  const snapshot = { width: 960, height: 540 };

  it("fills the snapshot for a frame of the same shape", () => {
    expect(thumbnailPlacement({ width: 960, height: 540 }, snapshot)).toEqual({
      x: 0,
      y: 0,
      width: 960,
      height: 540,
      fills: true,
    });
    expect(
      thumbnailPlacement({ width: 1920, height: 1080 }, snapshot).fills,
    ).toBe(true);
  });

  it("fits a wide strip inside the snapshot, centered, without stretching", () => {
    const placement = thumbnailPlacement(
      { width: 1920, height: 200 },
      snapshot,
    );
    expect(placement.fills).toBe(false);
    expect(placement.width).toBe(960);
    expect(placement.height).toBe(100);
    expect(placement.x).toBe(0);
    expect(placement.y).toBe(220);
    expect(placement.width / placement.height).toBeCloseTo(9.6, 1);
  });

  it("fits a tall frame inside the snapshot, centered, without stretching", () => {
    const placement = thumbnailPlacement({ width: 360, height: 960 }, snapshot);
    expect(placement.fills).toBe(false);
    expect(placement.height).toBe(540);
    expect(placement.width).toBe(203);
    expect(placement.y).toBe(0);
    expect(placement.x).toBe(Math.round((960 - 203) / 2));
    expect(placement.width / placement.height).toBeCloseTo(360 / 960, 2);
  });

  it("never leaves the snapshot", () => {
    for (const frame of [
      { width: 3840, height: 32 },
      { width: 32, height: 3840 },
      { width: 1000, height: 1000 },
      { width: 960, height: 541 },
    ]) {
      const placement = thumbnailPlacement(frame, snapshot);
      expect(placement.x).toBeGreaterThanOrEqual(0);
      expect(placement.y).toBeGreaterThanOrEqual(0);
      expect(placement.x + placement.width).toBeLessThanOrEqual(960);
      expect(placement.y + placement.height).toBeLessThanOrEqual(540);
    }
  });

  describe("captureWidgetPreview", () => {
    type Probe = {
      canvas: { width: number; height: number };
      fills: string[];
      draw: number[];
      svg: string;
    };

    async function capture(
      measured: { width: number; height: number },
      renderFrame?: { width: number; height: number },
    ): Promise<Probe> {
      Object.defineProperty(document, "fonts", {
        configurable: true,
        value: { ready: Promise.resolve() },
      });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        ...measured,
        top: 0,
        left: 0,
        right: measured.width,
        bottom: measured.height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const probe: Probe = {
        canvas: { width: 0, height: 0 },
        fills: [],
        draw: [],
        svg: "",
      };
      const context = {
        set fillStyle(value: string) {
          probe.fills.push(value);
        },
        fillRect: vi.fn(),
        drawImage: (_image: unknown, ...rect: number[]) => {
          probe.draw = rect;
        },
      };
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
        function (this: HTMLCanvasElement) {
          probe.canvas = { width: this.width, height: this.height };
          return context as unknown as CanvasRenderingContext2D;
        },
      );
      vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
        (callback) => callback(new Blob(["jpeg"], { type: "image/jpeg" })),
      );
      vi.stubGlobal(
        "Image",
        class {
          onload: (() => void) | null = null;
          onerror: (() => void) | null = null;
          set src(value: string) {
            probe.svg = decodeURIComponent(value.split(",", 2)[1]!);
            queueMicrotask(() => this.onload?.());
          }
        },
      );
      await captureWidgetPreview(
        document.createElement("div"),
        undefined,
        renderFrame,
      );
      return probe;
    }

    it("keeps the canonical thumbnail size for a Widget without a recommendation", async () => {
      expect(WIDGET_THUMBNAIL_FRAME).toEqual(snapshot);
      const probe = await capture({ width: 960, height: 540 });
      expect(probe.canvas).toEqual(snapshot);
      expect(probe.draw).toEqual([0, 0, 960, 540]);
      expect(probe.fills).not.toContain(THUMBNAIL_STAGE_COLOR);
    });

    it("renders the strip at its own geometry but still outputs 960 x 540", async () => {
      const strip = { width: 1920, height: 200 };
      const probe = await capture(strip, strip);
      // The browser output is the canonical size...
      expect(probe.canvas).toEqual(snapshot);
      // ...the Widget rendered at its recommended geometry...
      expect(probe.svg).toContain('viewBox="0 0 1920 200"');
      expect(probe.svg).toContain('<foreignObject width="1920" height="200">');
      // ...and is fitted inside, centered on the neutral stage.
      expect(probe.draw).toEqual([0, 220, 960, 100]);
      expect(probe.fills).toContain(THUMBNAIL_STAGE_COLOR);
      expect(probe.draw[2]! / probe.draw[3]!).toBeCloseTo(9.6, 1);
    });

    it("treats a recommendation with the canonical shape as the canonical frame", async () => {
      const probe = await capture(
        { width: 1920, height: 1080 },
        { width: 1920, height: 1080 },
      );
      expect(probe.canvas).toEqual(snapshot);
      expect(probe.draw).toEqual([0, 0, 960, 540]);
      expect(probe.fills).not.toContain(THUMBNAIL_STAGE_COLOR);
    });
  });
});
