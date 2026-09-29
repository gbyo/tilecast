// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureLayoutPreview,
  captureWidgetPreview,
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
