import { afterEach, describe, expect, it } from "vitest";
import { mountForTest } from "@tilecast/widget-sdk/testing";
import widget from "./index.ts";
import {
  parseTextConfig,
  resolveTextData,
  TilecastTextWidget,
  type TextConfig,
} from "./text.ts";

type TextElement = TilecastTextWidget & { updateComplete: Promise<unknown> };

const base: TextConfig = {
  heading: "Library hours",
  body: "Closed Friday afternoon.",
  style: "standard",
  align: "center",
  background: "#0e141b",
  foreground: "#f5f7fa",
};

async function render(config: Partial<TextConfig>) {
  const test = mountForTest(widget, { config: { ...base, ...config } });
  const element = test.element as TextElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  return { test, element, root };
}

afterEach(() => document.body.replaceChildren());

describe("Text configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseTextConfig({ ...base })).toEqual({ ok: true, config: base });
  });

  it("defaults the style and alignment and trims the words", () => {
    expect(parseTextConfig({ heading: "  Hi ", body: " There\n" })).toEqual({
      ok: true,
      config: {
        heading: "Hi",
        body: "There",
        style: "standard",
        align: "center",
        background: null,
        foreground: null,
      },
    });
  });

  it.each([
    [null, "configuration must be an object"],
    [[], "configuration must be an object"],
    [
      { body: "x".repeat(1001) },
      "heading and message must fit their length limits",
    ],
    [{ heading: 3 }, "heading and message must fit their length limits"],
    [{ style: "banner" }, "style is not a Text style"],
    [{ align: "right" }, "align must be left or center"],
  ])("refuses %j", (value, problem) => {
    expect(parseTextConfig(value)).toEqual({ ok: false, problem });
  });

  it("ignores an invalid author color", () => {
    const parsed = parseTextConfig({ body: "Hi", background: "red" });
    expect(parsed.ok && parsed.config.background).toBeNull();
  });
});

describe("Text data", () => {
  it("is empty only without any words", () => {
    expect(resolveTextData({ ...base, heading: "", body: "" })).toEqual({
      state: "empty",
      reason: "no_text",
    });
    expect(resolveTextData({ ...base, body: "" }).state).toBe("ready");
  });
});

describe("Text element", () => {
  it("renders the heading over the message and reports ready", async () => {
    const { root, test } = await render({});
    expect(root.querySelector(".heading")?.textContent).toBe("Library hours");
    expect(root.querySelector(".body")?.textContent).toBe(
      "Closed Friday afternoon.",
    );
    expect(test.states.at(-1)).toEqual({ state: "ready" });
  });

  it("promotes a heading without a message to the message", async () => {
    const { root } = await render({ body: "" });
    expect(root.querySelector(".heading")).toBeNull();
    expect(root.querySelector(".body")?.textContent).toBe("Library hours");
  });

  it("keeps the style and alignment on the root for container styling", async () => {
    const { root } = await render({ style: "callout", align: "left" });
    const frame = root.querySelector(".text")!;
    expect(frame.getAttribute("data-style")).toBe("callout");
    expect(frame.getAttribute("data-align")).toBe("left");
  });

  it("keeps authored line breaks as text, never as markup", async () => {
    const { root } = await render({ body: "<b>One</b>\nTwo" });
    const body = root.querySelector(".body")!;
    expect(body.textContent).toBe("<b>One</b>\nTwo");
    expect(body.querySelector("b")).toBeNull();
  });

  it("applies the author colors through the CSSOM", async () => {
    const { element } = await render({ background: "#123b2c" });
    expect(element.style.getPropertyValue("--tc-color-bg")).toBe("#123b2c");
    expect(element.getAttribute("style")).not.toContain("<");
  });

  it("reports the empty state without words", async () => {
    const test = mountForTest(widget, {
      config: { ...base, heading: "", body: "" },
    });
    await (test.element as TextElement).updateComplete;
    expect(test.states.at(-1)).toEqual({ state: "empty", reason: "no_text" });
  });

  it("has no timer and does not fit without a layout box", async () => {
    const { element } = await render({});
    // jsdom has no layout, so the full size is kept and nothing is measured.
    expect(element.fitScale).toBe(1);
  });
});
