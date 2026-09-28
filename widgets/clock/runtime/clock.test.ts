import { afterEach, describe, expect, it } from "vitest";
import {
  createManualClock,
  createTestContext,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import clock from "./index.ts";
import { parseClockConfig, type ClockConfig } from "./clock.ts";

type ClockElement = HTMLElement & { updateComplete: Promise<unknown> };

const at = Date.parse("2026-09-28T14:05:09Z");

async function render(
  config: Partial<ClockConfig> & Record<string, unknown>,
  options: Parameters<typeof createTestContext>[0] = {},
) {
  const manual = createManualClock(at);
  const test = mountForTest(clock, {
    config,
    context: createTestContext({ clock: manual, ...options }),
  });
  const element = test.element as ClockElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text, manual };
}

afterEach(() => document.body.replaceChildren());

describe("Clock configuration", () => {
  it("accepts the compiled legacy configuration", () => {
    expect(
      parseClockConfig({
        timeZone: "",
        format: "locale",
        showSeconds: false,
        style: "standard",
        showDate: false,
        background: "#0E141B",
        foreground: "",
      }),
    ).toEqual({
      ok: true,
      config: {
        mode: "time",
        timeZone: null,
        format: "locale",
        showSeconds: false,
        style: "standard",
        showDate: false,
        dateFormat: "locale",
        zones: [],
        background: "#0e141b",
        foreground: null,
      },
    });
  });

  it.each([
    [null],
    [[]],
    [{ timeZone: "Mars/Olympus" }],
    [{ timeZone: "UTC; rm -rf /" }],
    [{ format: "13" }],
    [{ style: "<svg onload=alert(1)>" }],
    [{ showSeconds: "yes" }],
    [{ timeZone: "x".repeat(10_000) }],
  ])("rejects %j", (value) => {
    expect(parseClockConfig(value).ok).toBe(false);
  });

  it("ignores hostile colors instead of injecting them", () => {
    const parsed = parseClockConfig({
      background: "red;}:host{display:none",
      foreground: "url(https://example.com/x)",
    });
    expect(parsed).toMatchObject({
      ok: true,
      config: { background: null, foreground: null },
    });
  });
});

describe("Clock element", () => {
  it("renders hours and minutes as the focal point with a quiet period", async () => {
    const { text, root, test } = await render({ style: "standard" });
    expect(text(".hm")).toBe("9:05");
    expect(text(".period")).toBe("AM");
    expect(root.querySelector(".seconds")).toBeNull();
    expect(root.querySelector(".date")).toBeNull();
    expect(root.querySelector(".zone")).toBeNull();
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("uses the organization hour cycle unless the Clock forces one", async () => {
    const organization = await render({}, { hourCycle: "h23" });
    expect(organization.text(".hm")).toBe("09:05");
    expect(organization.root.querySelector(".period")).toBeNull();
    organization.test.dispose();
    const forced = await render({ format: "12" }, { hourCycle: "h23" });
    expect(forced.text(".hm")).toBe("9:05");
    forced.test.dispose();
  });

  it("captions another zone and shows its date", async () => {
    const { text, test } = await render({
      timeZone: "Asia/Tokyo",
      showDate: true,
      format: "24",
    });
    expect(text(".zone")).toBe("Tokyo");
    expect(text(".hm")).toBe("23:05");
    expect(text(".date-long")).toBe("Monday, September 28");
    expect(text(".date-short")).toBe("Mon, Sep 28");
    test.dispose();
  });

  it("ticks seconds from the corrected clock and nothing else", async () => {
    const { text, test, element, manual } = await render({ showSeconds: true });
    expect(text(".seconds")).toBe("09");
    // Updates land just after each boundary.
    manual.advance(1_010);
    await element.updateComplete;
    expect(text(".seconds")).toBe("10");
    manual.setNow(at + 3_600_000);
    manual.advance(1_000);
    await element.updateComplete;
    expect(text(".hm")).toBe("10:05");
    test.dispose();
    expect(manual.pendingTimers).toBe(0);
  });

  it("wakes once a minute without seconds", async () => {
    const { test, element, manual } = await render({});
    let updates = 0;
    const original = (element as unknown as { update(c: unknown): void })
      .update;
    (element as unknown as { update(c: unknown): void }).update = function (
      this: unknown,
      changed: unknown,
    ) {
      updates += 1;
      original.call(this, changed);
    };
    for (let second = 0; second < 120; second += 1) {
      manual.advance(1_000);
      await element.updateComplete;
    }
    expect(updates).toBe(2);
    test.dispose();
  });

  it("draws the analog dial with hands at the right angles", async () => {
    const { root, test } = await render({ style: "analog", showSeconds: true });
    const rotation = (selector: string) =>
      root.querySelector(selector)?.getAttribute("transform");
    expect(root.querySelectorAll(".tick")).toHaveLength(60);
    expect(rotation(".hand.hour")).toBe("rotate(272.5 100 100)");
    expect(rotation(".hand.minute")).toBe("rotate(30.9 100 100)");
    expect(rotation(".hand.second")).toBe("rotate(54 100 100)");
    expect(root.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "9:05 AM",
    );
    test.dispose();
  });

  it("places the hands correctly late in the hour", async () => {
    const late = createManualClock(Date.parse("2026-09-28T14:47:38Z"));
    const test = mountForTest(clock, {
      config: { style: "analog", showSeconds: true },
      context: createTestContext({ clock: late }),
    });
    const element = test.element as ClockElement;
    await element.updateComplete;
    const rotation = (selector: string) =>
      element.shadowRoot!.querySelector(selector)?.getAttribute("transform");
    // 9:47:38 in Chicago.
    expect(rotation(".hand.hour")).toBe("rotate(293.5 100 100)");
    expect(rotation(".hand.minute")).toBe("rotate(285.8 100 100)");
    expect(rotation(".hand.second")).toBe("rotate(228 100 100)");
    test.dispose();
  });

  it("sets no style attribute in its shadow tree", async () => {
    const { root, element, test } = await render({
      style: "analog",
      showDate: true,
    });
    for (const node of root.querySelectorAll("*")) {
      expect(node.hasAttribute("style")).toBe(false);
    }
    // Colors reach the host only through the CSSOM.
    expect(element.style.getPropertyValue("--tc-color-fg")).toBe("#f5f7fa");
    test.dispose();
  });
});
