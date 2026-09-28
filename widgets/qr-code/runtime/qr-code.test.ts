import { afterEach, describe, expect, it } from "vitest";
import { mountForTest } from "@tilecast/widget-sdk/testing";
import widget from "./index.ts";
import {
  encodeQrCode,
  parseQrCodeConfig,
  resolveQrCodeData,
  type QrCodeConfig,
} from "./qr-code.ts";

type QrElement = HTMLElement & { updateComplete: Promise<unknown> };

const base: QrCodeConfig = {
  payload: "https://example.org/visit",
  heading: "Scan to learn more",
  instruction: "Point your camera at the code.",
  shortLabel: "example.org",
  style: "standard",
  background: "#ffffff",
  foreground: "#101418",
};

async function render(config: Partial<QrCodeConfig>) {
  const test = mountForTest(widget, { config: { ...base, ...config } });
  const element = test.element as QrElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("QR Code configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseQrCodeConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("treats missing text as blank and missing colors as theme", () => {
    expect(parseQrCodeConfig({ payload: "https://example.org" })).toMatchObject(
      {
        ok: true,
        config: {
          payload: "https://example.org",
          heading: "",
          instruction: "",
          shortLabel: "",
          style: "standard",
          background: null,
          foreground: null,
        },
      },
    );
  });

  it.each([
    [null],
    [[]],
    [{ payload: 42 }],
    [{ payload: "x".repeat(2049) }],
    [{ payload: "ok", heading: "x".repeat(121) }],
    [{ payload: "ok", instruction: "x".repeat(301) }],
    [{ payload: "ok", shortLabel: "x".repeat(61) }],
    [{ payload: "ok", style: "poster" }],
    [{ payload: "ok", style: "<svg onload=alert(1)>" }],
  ])("rejects %j", (value) => {
    expect(parseQrCodeConfig(value).ok).toBe(false);
  });

  it("ignores hostile colors instead of injecting them", () => {
    expect(
      parseQrCodeConfig({
        payload: "https://example.org",
        background: "white;}:host{display:none",
        foreground: "url(https://example.com/x)",
      }),
    ).toMatchObject({
      ok: true,
      config: { background: null, foreground: null },
    });
  });

  it("drops matching colors so the code keeps its contrast", () => {
    expect(
      parseQrCodeConfig({
        payload: "https://example.org",
        background: "#101418",
        foreground: "#101418",
      }),
    ).toMatchObject({
      ok: true,
      config: { background: null, foreground: null },
    });
  });
});

describe("QR Code data resolution", () => {
  it("is ready with a payload and empty without one", () => {
    expect(resolveQrCodeData(base)).toEqual({ state: "ready", data: null });
    expect(resolveQrCodeData({ ...base, payload: "" })).toMatchObject({
      state: "empty",
    });
  });
});

describe("QR Code element", () => {
  it("renders an encoded code with its text and reports ready", async () => {
    const { text, root, test } = await render({});
    expect(text(".heading")).toBe("Scan to learn more");
    expect(text(".instruction")).toBe("Point your camera at the code.");
    expect(text(".label")).toBe("example.org");
    const svg = root.querySelector("svg.code");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Scan to learn more");
    // The matrix plus a four-module quiet zone on every side.
    const matrix = encodeQrCode(base.payload)!;
    const size = matrix.count + 8;
    expect(svg?.getAttribute("viewBox")).toBe(`0 0 ${size} ${size}`);
    expect(
      svg?.querySelector("path")?.getAttribute("d")?.length,
    ).toBeGreaterThan(0);
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("renders the code alone in the code-only style", async () => {
    const { root, text, test } = await render({ style: "code" });
    expect(root.querySelector("svg.code")).not.toBeNull();
    expect(root.querySelector(".words")).toBeNull();
    expect(text(".heading")).toBeNull();
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("reports empty instead of rendering a blank code", async () => {
    const { root, test } = await render({ payload: "" });
    expect(root.querySelector("svg.code")).toBeNull();
    expect(test.states).toEqual([{ state: "empty", reason: "no_payload" }]);
    test.dispose();
  });

  it("encodes the same payload deterministically", () => {
    const first = encodeQrCode("https://example.org/visit")!;
    const second = encodeQrCode("https://example.org/visit")!;
    expect(first.count).toBe(second.count);
    for (let row = 0; row < first.count; row++) {
      for (let col = 0; col < first.count; col++) {
        expect(first.dark(row, col)).toBe(second.dark(row, col));
      }
    }
  });
});
