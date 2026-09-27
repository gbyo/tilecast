import { afterEach, describe, expect, it } from "vitest";
import { html } from "lit";
import { defineWidget, ready, type WidgetContext } from "@tilecast/widget-sdk";
import {
  createManualClock,
  createTestContext,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import {
  boundText,
  ClockController,
  fieldForRole,
  formatDate,
  formatNumber,
  formatTime,
  formatWidgetValue,
  GeometryController,
  localDayKey,
  mixColors,
  MotionController,
  suggestFieldMapping,
  themeProperties,
  TilecastWidgetElement,
  timeParts,
  zoneCity,
} from "../src/index.ts";

let seq = 0;
const nextTag = () => `tc-widget-kit${++seq}`;

type TickConfig = { granularity: "second" | "minute"; background?: string };

function tickingDefinition(options: { dayKey?: boolean } = {}) {
  const tag = nextTag();
  class Ticking extends TilecastWidgetElement<TickConfig, { label: string }> {
    renders = 0;
    readonly ticks = new ClockController(this, {
      granularity: () => this.config.granularity,
      key: options.dayKey
        ? (now) => localDayKey(now, this.context.timeZone)
        : undefined,
    });
    protected override themeOverrides(config: TickConfig) {
      return { background: config.background };
    }
    protected override renderContent() {
      this.renders += 1;
      return html`<span class="tc-display">${this.ticks.now}</span>`;
    }
  }
  return defineWidget<TickConfig, { label: string }>({
    type: `tilecast.${tag.slice("tc-widget-".length)}`,
    version: 1,
    tagName: tag,
    parseConfig: (value) => ({ ok: true, config: value as TickConfig }),
    resolveData: () => ready({ label: "x" }),
    element: Ticking,
  });
}

type Ticking = HTMLElement & {
  renders: number;
  ticks: ClockController;
  updateComplete: Promise<boolean>;
  context: WidgetContext;
};

afterEach(() => document.body.replaceChildren());

describe("TilecastWidgetElement", () => {
  it("announces once per input change, not per clock tick", async () => {
    const clock = createManualClock(Date.parse("2026-09-28T14:25:36.500Z"));
    const test = mountForTest(tickingDefinition(), {
      config: { granularity: "second" },
      context: createTestContext({ clock }),
    });
    const element = test.element as Ticking;
    await element.updateComplete;
    expect(test.states).toEqual([{ state: "ready" }]);
    const readyEvents: Event[] = [];
    element.addEventListener("tilecast-widget-ready", (e) =>
      readyEvents.push(e),
    );
    const before = element.renders;
    for (let second = 0; second < 5; second += 1) {
      clock.advance(1_000);
      await element.updateComplete;
    }
    expect(element.renders - before).toBe(5);
    expect(readyEvents).toHaveLength(0);
    test.dispose();
  });

  it("applies the theme through the CSSOM with validated overrides", async () => {
    const test = mountForTest(tickingDefinition(), {
      config: { granularity: "minute", background: "#ffffff" },
    });
    const element = test.element as Ticking;
    await element.updateComplete;
    expect(element.style.getPropertyValue("--tc-color-bg")).toBe("#ffffff");
    expect(element.getAttribute("data-scheme")).toBe("light");
    expect(element.style.getPropertyValue("--tc-duration-standard")).toBe(
      "0ms",
    );
    test.mount.update({
      component: {
        type: test.mount["component"].type,
        version: 1,
        config: {
          granularity: "minute",
          background: "url(javascript:alert(1))",
        },
      },
    });
    await element.updateComplete;
    expect(element.style.getPropertyValue("--tc-color-bg")).toBe("#0e141b");
    test.dispose();
  });
});

describe("ClockController", () => {
  it("wakes at boundaries of the corrected clock and cleans up", async () => {
    const clock = createManualClock(Date.parse("2026-09-28T14:25:36.250Z"));
    const test = mountForTest(tickingDefinition(), {
      config: { granularity: "minute" },
      context: createTestContext({ clock }),
    });
    const element = test.element as Ticking;
    await element.updateComplete;
    expect(clock.pendingTimers).toBe(1);
    clock.advance(23_700);
    expect(element.ticks.wakeups).toBe(0);
    clock.advance(100);
    expect(element.ticks.wakeups).toBe(1);
    clock.advance(10 * 60_000);
    expect(element.ticks.wakeups).toBe(11);
    expect(clock.pendingTimers).toBe(1);
    test.dispose();
    expect(clock.pendingTimers).toBe(0);
  });

  it("rerenders a keyed presentation only when its key changes", async () => {
    const clock = createManualClock(Date.parse("2026-09-28T23:58:00Z"));
    const test = mountForTest(tickingDefinition({ dayKey: true }), {
      config: { granularity: "minute" },
      context: createTestContext({ clock, timeZone: "UTC" }),
    });
    const element = test.element as Ticking;
    await element.updateComplete;
    const before = element.renders;
    clock.advance(60_500);
    await element.updateComplete;
    expect(element.renders).toBe(before);
    clock.advance(60_000);
    await element.updateComplete;
    expect(element.renders).toBe(before + 1);
    test.dispose();
  });

  it("moves to a new clock when the context changes", async () => {
    const first = createManualClock();
    const second = createManualClock();
    const test = mountForTest(tickingDefinition(), {
      config: { granularity: "second" },
      context: createTestContext({ clock: first }),
    });
    const element = test.element as Ticking;
    await element.updateComplete;
    test.mount.update({ context: createTestContext({ clock: second }) });
    await element.updateComplete;
    expect(first.pendingTimers).toBe(0);
    expect(second.pendingTimers).toBe(1);
    test.dispose();
  });
});

describe("GeometryController and MotionController", () => {
  it("updates only for a real size change", () => {
    let requested = 0;
    const host = Object.assign(document.createElement("div"), {
      addController() {},
      removeController() {},
      requestUpdate() {
        requested += 1;
      },
      updateComplete: Promise.resolve(true),
    });
    const geometry = new GeometryController(host as never);
    geometry.measure(320.2, 180);
    geometry.measure(320.4, 180.3);
    geometry.measure(640, 360);
    expect(requested).toBe(2);
    expect(geometry.size).toEqual({ width: 640, height: 360 });
  });

  it("does not animate under reduced motion", () => {
    const host = Object.assign(document.createElement("div"), {
      addController() {},
      context: createTestContext({ reducedMotion: true }),
    });
    const motion = new MotionController(host as never);
    expect(motion.enter(document.createElement("span"))).toBeNull();
    expect(motion.active).toBe(0);
  });
});

describe("format", () => {
  const at = Date.parse("2026-09-28T14:05:09Z");

  it("formats percent values as whole units, like the legacy renderer", () => {
    // Records carry 62 for 62%; formatting must not print 6,200%.
    expect(formatNumber(62, { locale: "en-US", style: "percent" })).toBe("62%");
    expect(
      formatWidgetValue(
        { kind: "percent", number: 62 },
        { type: "percent" },
        { locale: "en-US" },
      ),
    ).toBe("62%");
  });

  it("formats wall time in the configured zone and hour cycle", () => {
    expect(
      formatTime(at, {
        locale: "en-US",
        timeZone: "America/Chicago",
        hourCycle: "locale",
      }),
    ).toBe("9:05 AM");
    expect(
      formatTime(at, {
        locale: "en-US",
        timeZone: "America/Chicago",
        hourCycle: "h23",
      }),
    ).toBe("09:05");
  });

  it("splits time in the configured zone and hour cycle", () => {
    expect(
      timeParts(at, {
        locale: "en-US",
        timeZone: "America/Chicago",
        hourCycle: "locale",
      }),
    ).toMatchObject({
      hour: "9",
      minute: "05",
      second: "09",
      dayPeriod: "AM",
      separator: ":",
      clock: { hours: 9, minutes: 5, seconds: 9 },
    });
    expect(
      timeParts(at, {
        locale: "en-US",
        timeZone: "Asia/Kathmandu",
        hourCycle: "h23",
      }),
    ).toMatchObject({ hour: "19", minute: "50", dayPeriod: "" });
    expect(
      timeParts(at, { locale: "de-DE", timeZone: "UTC", hourCycle: "h12" })
        .dayPeriod,
    ).not.toBe("");
  });

  it("keeps minutes and seconds above 23 for analog faces", () => {
    expect(
      timeParts(Date.parse("2026-09-28T23:59:47Z"), {
        locale: "en-US",
        timeZone: "UTC",
        hourCycle: "h23",
      }).clock,
    ).toEqual({ hours: 23, minutes: 59, seconds: 47 });
    expect(
      timeParts(Date.parse("2026-09-29T00:00:00Z"), {
        locale: "en-US",
        timeZone: "UTC",
        hourCycle: "h23",
      }).clock.hours,
    ).toBe(0);
  });

  it("formats dates, zones, numbers and bounded text", () => {
    expect(
      formatDate(at, { locale: "en-US", timeZone: "UTC", style: "long" }),
    ).toBe("Monday, September 28");
    expect(localDayKey(at, "Pacific/Kiritimati")).toBe("2026-09-29");
    expect(zoneCity("America/Port_of_Spain")).toBe("Port of Spain");
    expect(formatNumber(1234.56, { locale: "en-US" })).toBe("1,234.6");
    expect(formatNumber(Number.NaN, { locale: "en-US" })).toBe("—");
    expect(
      formatNumber(12, {
        locale: "en-US",
        style: "currency",
        currency: "evil",
      }),
    ).toBe("$12.00");
    expect(boundText("a\u0000b".padEnd(20, "c"), 8)).toBe("a bcccc…");
    expect(boundText({ toString: () => "x" }, 8)).toBe("");
  });

  it("formats prepared record values by typed metadata and locale", () => {
    const locale = "en-US";
    expect(
      formatWidgetValue({ kind: "text", text: "Hello" }, undefined, { locale }),
    ).toBe("Hello");
    expect(
      formatWidgetValue({ kind: "text", text: "x".repeat(300) }, undefined, {
        locale,
      }).length,
    ).toBeLessThanOrEqual(280);
    expect(
      formatWidgetValue({ kind: "number", number: 1234.56 }, undefined, {
        locale,
      }),
    ).toBe("1,234.6");
    expect(
      formatWidgetValue(
        { kind: "currency", number: 12 },
        { type: "currency", currency: "USD" },
        { locale },
      ),
    ).toBe("$12.00");
    expect(
      formatWidgetValue({ kind: "boolean", boolean: true }, undefined, {
        locale,
      }),
    ).toBe("Yes");
    expect(
      formatWidgetValue({ kind: "date", date: "2026-09-28" }, undefined, {
        locale,
        timeZone: "UTC",
      }),
    ).toBe("Sep 28, 2026");
    // A bare date names no zone, so it never shifts with the screen zone.
    expect(
      formatWidgetValue({ kind: "date", date: "2026-09-28" }, undefined, {
        locale,
      }),
    ).toBe("Sep 28, 2026");
    expect(
      formatWidgetValue(
        { kind: "duration", durationSeconds: 7540 },
        undefined,
        {
          locale,
        },
      ),
    ).toBe("2h 5m");
    expect(formatWidgetValue(null, undefined, { locale })).toBe("");
    expect(
      formatWidgetValue({ kind: "object", object: {} }, undefined, { locale }),
    ).toBe("");
  });
});

describe("tokens", () => {
  it("derives theme colors deterministically", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    const props = themeProperties({
      scheme: "dark",
      background: "#0e141b",
      foreground: "#f5f7fa",
      accent: "#4f9dff",
    });
    expect(props["--tc-color-fg-muted"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(props["--tc-color-on-accent"]).toBe("#0b0f14");
    expect(Object.values(props).every((v) => /^#[0-9a-f]{6}$/.test(v))).toBe(
      true,
    );
  });
});

describe("semantic field roles", () => {
  const fields = [
    { key: "dish", type: "text", role: "title" },
    { key: "notes", type: "text" },
    { key: "cost", type: "currency" },
    { key: "section", type: "text", role: "category" },
  ];
  const slots = {
    title: { roles: ["title"], legacyKeys: ["title", "name"], types: ["text"] },
    description: {
      roles: ["description"],
      legacyKeys: ["description", "notes"],
      types: ["text"],
    },
    price: {
      roles: ["price"],
      legacyKeys: ["price", "cost"],
      types: ["currency", "number"],
    },
    category: {
      roles: ["category"],
      legacyKeys: ["category", "section"],
      types: ["text"],
    },
  };

  it("prefers declared roles over legacy keys and types", () => {
    expect(fieldForRole(fields, "title")).toBe("dish");
    expect(fieldForRole(fields, "")).toBe("");
    expect(fieldForRole(fields, "end")).toBe("");
    expect(suggestFieldMapping(fields, slots)).toEqual({
      title: "dish",
      // No description role is declared; the legacy key "notes" wins over
      // any text column.
      description: "notes",
      // The price role is undeclared but "cost" is a known legacy key, so
      // it wins over a type-compatible fallback.
      price: "cost",
      category: "section",
    });
  });

  it("falls back to type-compatible fields and never shares one", () => {
    const undeclared = [
      { key: "name", type: "text" },
      { key: "blurb", type: "text" },
    ];
    expect(
      suggestFieldMapping(undeclared, {
        title: { roles: ["title"], legacyKeys: ["title"], types: ["text"] },
        description: {
          roles: ["description"],
          legacyKeys: ["description"],
          types: ["text"],
        },
        price: { roles: ["price"], legacyKeys: ["price"], types: ["currency"] },
      }),
    ).toEqual({ title: "name", description: "blurb", price: "" });
  });

  it("matches legacy keys case-insensitively", () => {
    expect(
      suggestFieldMapping([{ key: "Title", type: "text" }], {
        title: { roles: ["title"], legacyKeys: ["title"], types: ["text"] },
      }),
    ).toEqual({ title: "Title" });
  });
});
