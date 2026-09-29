// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { captureWidgetPreview } from "./widgetPreviewCapture";

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
