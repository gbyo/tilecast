import { afterEach, describe, expect, it } from "vitest";
import {
  createManualClock,
  createTestContext,
  fixtureResources,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import fixture from "../fixtures/default.json";
import emptyMenu from "../fixtures/empty.json";
import stale from "../fixtures/stale.json";
import widget from "./index.ts";
import { formatPrice, parseMenuConfig } from "./menu.ts";

afterEach(() => document.body.replaceChildren());

function mount(input: {
  configuration: unknown;
  documents?: unknown;
  media?: unknown;
}) {
  const clock = createManualClock();
  clock.setNow(Date.parse("2026-11-23T12:00:00Z"));
  return mountForTest(widget, {
    config: input.configuration,
    resources: fixtureResources({
      documents: input.documents as never,
      media: input.media as never,
    }),
    context: createTestContext({ clock, locale: "en-US" }),
  });
}

const settled = async (test: ReturnType<typeof mount>) =>
  (test.element as unknown as { updateComplete: Promise<unknown> })
    .updateComplete;

describe("menu", () => {
  it("groups by category, uses sign labels, prices, pictures, and hides hidden items", async () => {
    const test = mount(fixture);
    await settled(test);
    const root = test.element!.shadowRoot!;
    const text = root.textContent ?? "";
    expect([...root.querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Coffee",
      "Tea",
      "Bakery",
    ]);
    expect(text).toContain("$4.50");
    expect(text).toContain("Chai");
    expect(text).not.toContain("Chai latte");
    expect(text).not.toContain("Staff special");
    expect(root.querySelector("li.unavailable")?.textContent).toContain(
      "Sold out",
    );
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(text).not.toContain("out of date");
    expect(test.states.at(-1)).toEqual({ state: "ready" });
    test.dispose();
  });
  it("says stale prices may be out of date", async () => {
    const test = mount(stale);
    await settled(test);
    expect(test.element!.shadowRoot!.textContent).toContain(
      "Prices may be out of date.",
    );
    test.dispose();
  });
  it("reports an empty menu", async () => {
    const test = mount(emptyMenu);
    await settled(test);
    expect(test.states.at(-1)).toMatchObject({ state: "empty" });
    test.dispose();
  });
  it("formats prices and bounds the configuration", () => {
    expect(formatPrice(1200, "JPY", "en-US")).toBe("¥1,200");
    expect(formatPrice(3.5, "", "en-US")).toBe("3.50");
    const parsed = parseMenuConfig({ maximumItems: 900 });
    expect(parsed.ok && parsed.config.maximumItems).toBe(100);
  });
});
