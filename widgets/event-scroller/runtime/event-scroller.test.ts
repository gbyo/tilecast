import { afterEach, describe, expect, it } from "vitest";
import {
  type WidgetDataDocument,
  type WidgetRecord,
} from "@tilecast/widget-sdk";
import { compileComponentConfig } from "@tilecast/widget-sdk/manifest";
import {
  createManualClock,
  createTestContext,
  fixtureResources,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import { suggestFieldMapping } from "@tilecast/widget-kit";
import widget from "./index.ts";
import manifest from "../tilecast.widget.json";
import fixture from "../fixtures/default.json";
import dateFixture from "../fixtures/date-only.json";
import {
  parseEventScrollerConfig,
  resolveEventScrollerData,
  scrollerDate,
  scrollDurationSeconds,
  visibleScrollerEvents,
  type EventScrollerConfig,
} from "./events.ts";
import { TilecastEventScrollerWidget } from "./event-scroller.ts";

const SOURCE = fixture.configuration.dataSourceId;
const NOW = Date.parse(fixture.context.now);
const parsed = parseEventScrollerConfig(
  compileComponentConfig(
    manifest.component.configTemplate,
    fixture.configuration,
  ),
);
if (!parsed.ok) throw new Error(parsed.problem);
const base = parsed.config;
const original = fixture.documents[SOURCE as keyof typeof fixture.documents];
function docs(
  records: readonly WidgetRecord[],
  kind = "records",
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      ...original,
      datasets: [{ ...original.datasets[0], kind, records }],
    },
  } as Record<string, WidgetDataDocument>;
}
function event(id: string, start: string, end?: string): WidgetRecord {
  return {
    id,
    values: {
      title: { kind: "text", text: id },
      start: { kind: "datetime", datetime: start },
      ...(end ? { end: { kind: "datetime" as const, datetime: end } } : {}),
    },
  };
}
function resolve(records: readonly WidgetRecord[], config = base) {
  const resolution = resolveEventScrollerData(
    config,
    fixtureResources({ documents: docs(records) }),
  );
  if (resolution.state !== "ready") throw new Error("expected ready");
  return resolution.data;
}
async function render(
  records = original.datasets[0]!.records as readonly WidgetRecord[],
  config: Partial<EventScrollerConfig> = {},
  reducedMotion = false,
) {
  const clock = createManualClock(NOW);
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents: docs(records) }),
    context: createTestContext({
      clock,
      timeZone: "America/New_York",
      reducedMotion,
    }),
  });
  const element = test.element as TilecastEventScrollerWidget;
  await element.updateComplete;
  return { test, element, root: element.shadowRoot!, clock };
}
afterEach(() => document.body.replaceChildren());

describe("configuration and authoring", () => {
  it("accepts defaults, bounded numbers and optional colors", () => {
    expect(parseEventScrollerConfig({})).toMatchObject({
      ok: true,
      config: {
        flow: "auto",
        scrolling: true,
        scrollSpeed: 3,
        hideEnded: true,
      },
    });
    expect(
      parseEventScrollerConfig({ scrollSpeed: 4.5, background: "invalid" }),
    ).toMatchObject({
      ok: true,
      config: { scrollSpeed: 4.5, background: null },
    });
  });
  it.each([
    null,
    [],
    { flow: "diagonal" },
    { verticalDirection: "left" },
    { horizontalDirection: "up" },
    { scrollSpeed: 0 },
    { scrollSpeed: 11 },
    { scrollSpeed: NaN },
    { maximumItems: 0 },
    { maximumItems: 101 },
    { maximumItems: 1.5 },
    { startField: 42 },
    { titleField: "x".repeat(121) },
    { scrolling: "yes" },
    { density: "huge" },
    { dateStyle: "raw" },
  ])("rejects %j", (value) => {
    expect(parseEventScrollerConfig(value).ok).toBe(false);
  });
  it("suggests calendar and common record mappings without guessing optional text fields", () => {
    const slots = Object.fromEntries(
      manifest.configurationSchema.fields
        .filter((field) => field.control === "data_source_field")
        .map((field) => [
          field.key,
          {
            roles:
              "semanticRole" in field.ui
                ? [field.ui.semanticRole as string]
                : [],
            legacyKeys:
              "legacyKeys" in field.ui ? (field.ui.legacyKeys as string[]) : [],
            types: [],
          },
        ]),
    );
    expect(
      suggestFieldMapping(
        [
          { key: "headline", type: "text" },
          { key: "startTime", type: "datetime" },
          { key: "endTime", type: "datetime" },
          { key: "notes", type: "text" },
          { key: "place", type: "text", role: "location" },
          { key: "group", type: "text", role: "category" },
        ],
        slots,
      ),
    ).toEqual({
      titleField: "headline",
      startField: "startTime",
      endField: "endTime",
      locationField: "place",
      categoryField: "group",
    });
    expect(
      suggestFieldMapping(
        [
          { key: "title", type: "text" },
          { key: "start", type: "date" },
          { key: "unrelated", type: "text" },
        ],
        slots,
      ).locationField,
    ).toBe("");
    expect(manifest.compatibility.fallback).toBe("none");
    expect(manifest.component.empty).toBe("skip-eligible");
  });
});

describe("event selection", () => {
  it("reports missing, unusable and incompatible sources correctly", () => {
    expect(resolveEventScrollerData(base, fixtureResources())).toMatchObject({
      state: "empty",
      reason: "no_source",
    });
    expect(
      resolveEventScrollerData(
        { ...base, dataSourceId: "" },
        fixtureResources(),
      ),
    ).toMatchObject({ state: "empty" });
    expect(
      resolveEventScrollerData(base, fixtureResources({ documents: docs([]) })),
    ).toMatchObject({ state: "empty", reason: "no_records" });
    expect(
      resolveEventScrollerData(
        base,
        fixtureResources({ documents: docs([], "object") }),
      ),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
    expect(
      resolveEventScrollerData(
        base,
        fixtureResources({
          documents: docs([
            {
              id: "blank",
              values: {
                title: { kind: "text", text: " " },
                start: { kind: "date", date: "2026-10-12" },
              },
            },
            {
              id: "bad-date",
              values: {
                title: { kind: "text", text: "Bad" },
                start: { kind: "date", date: "2026-02-30" },
              },
            },
            {
              id: "missing",
              values: { title: { kind: "text", text: "No date" } },
            },
          ]),
        }),
      ),
    ).toMatchObject({ state: "empty" });
  });
  it("sorts stably and filters ended events before applying the visible cap", () => {
    const records = [
      event("later", "2026-10-14T12:00:00Z"),
      event("past", "2026-10-10T12:00:00Z", "2026-10-10T13:00:00Z"),
      event("first-tie", "2026-10-13T12:00:00Z"),
      event("second-tie", "2026-10-13T12:00:00Z"),
    ];
    const data = resolve(records, { ...base, maximumItems: 2 });
    expect(data.events).toHaveLength(4);
    expect(
      visibleScrollerEvents(
        data,
        { ...base, maximumItems: 2 },
        NOW,
        "America/New_York",
      ).map((e) => e.id),
    ).toEqual(["first-tie", "second-tie"]);
    expect(
      visibleScrollerEvents(data, { ...base, hideEnded: false }, NOW, "UTC")[0]
        ?.id,
    ).toBe("past");
  });
  it("keeps open-ended events through their screen-local day", () => {
    const data = resolve([event("open", "2026-10-13T02:00:00Z")]);
    expect(
      visibleScrollerEvents(
        data,
        base,
        Date.parse("2026-10-13T03:59:00Z"),
        "America/New_York",
      ),
    ).toHaveLength(1);
    expect(
      visibleScrollerEvents(
        data,
        base,
        Date.parse("2026-10-13T04:00:00Z"),
        "America/New_York",
      ),
    ).toHaveLength(0);
  });
  it("preserves bare dates west/east of UTC, includes date-only ends, and sorts mixed values at local midnight", () => {
    const data = resolve([
      event("timed", "2026-10-12T03:00:00Z"),
      {
        id: "date",
        values: {
          title: { kind: "text", text: "Open house" },
          start: { kind: "date", date: "2026-10-12" },
        },
      },
      {
        id: "range",
        values: {
          title: { kind: "text", text: "Fair" },
          start: { kind: "date", date: "2026-10-10" },
          end: { kind: "date", date: "2026-10-12" },
        },
      },
    ]);
    const all = visibleScrollerEvents(
      data,
      { ...base, hideEnded: false },
      NOW,
      "America/New_York",
    );
    expect(all.map((e) => e.id)).toEqual(["range", "timed", "date"]);
    const bare = data.events.find((e) => e.id === "date")!;
    expect(
      scrollerDate(bare, base, {
        locale: "en-US",
        timeZone: "America/Los_Angeles",
      }),
    ).toContain("Oct 12");
    expect(
      scrollerDate(bare, base, { locale: "en-US", timeZone: "Asia/Tokyo" }),
    ).toContain("Oct 12");
    expect(
      visibleScrollerEvents(
        data,
        base,
        Date.parse("2026-10-13T03:59:00Z"),
        "America/New_York",
      ).map((e) => e.id),
    ).toEqual(["range", "date"]);
    expect(
      visibleScrollerEvents(
        data,
        base,
        Date.parse("2026-10-13T04:00:00Z"),
        "America/New_York",
      ),
    ).toHaveLength(0);
  });
  it("orders date-only events at local day boundaries across DST", () => {
    const data = resolve([
      event("before", "2026-11-01T03:59:00Z"),
      {
        id: "day",
        values: {
          title: { kind: "text", text: "Day" },
          start: { kind: "date", date: "2026-11-01" },
        },
      },
      event("after", "2026-11-01T04:01:00Z"),
    ]);
    expect(
      visibleScrollerEvents(
        data,
        { ...base, hideEnded: false },
        NOW,
        "America/New_York",
      ).map((e) => e.id),
    ).toEqual(["before", "day", "after"]);
  });
});

describe("reading pace", () => {
  it("is bounded, monotonic, and keeps per-event pace constant above six events", () => {
    for (let speed = 1; speed <= 10; speed += 0.5) {
      let previous = 0;
      for (let count = 0; count <= 100; count++) {
        const duration = scrollDurationSeconds(count, speed);
        expect(duration).toBeGreaterThanOrEqual(previous);
        expect(duration).toBeGreaterThanOrEqual(24);
        expect(duration).toBeLessThanOrEqual(1300);
        previous = duration;
      }
      expect(scrollDurationSeconds(30, speed) / 30).toBe(
        scrollDurationSeconds(10, speed) / 10,
      );
    }
    expect(scrollDurationSeconds(30, 10)).toBeLessThan(
      scrollDurationSeconds(30, 1),
    );
    for (const count of [NaN, Infinity, -1])
      expect(Number.isFinite(scrollDurationSeconds(count, NaN))).toBe(true);
  });
});

describe("element lifecycle", () => {
  it("renders a fixed optional header and exactly two identical logical groups with one accessible list", async () => {
    const { root, test } = await render();
    expect(root.querySelector(".heading")?.textContent).toBe(
      "WILDCAT ATHLETICS",
    );
    const groups = root.querySelectorAll(".group");
    expect(groups).toHaveLength(2);
    expect(groups[0]?.textContent).toBe(groups[1]?.textContent);
    expect(groups[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelectorAll('[role="list"]')).toHaveLength(1);
    expect(root.querySelector(".board")?.getAttribute("style")).toBeNull();
    expect(test.element?.style.getPropertyValue("--tc-event-seconds")).toBe(
      "66s",
    );
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });
  it.each([
    { reduced: true, scrolling: true },
    { reduced: false, scrolling: false },
  ])(
    "renders a deliberate static list for %j",
    async ({ reduced, scrolling }) => {
      const { root, test } = await render(
        undefined,
        { scrolling, heading: "" },
        reduced,
      );
      expect(root.querySelectorAll(".group")).toHaveLength(1);
      expect(root.querySelector(".board")?.hasAttribute("data-still")).toBe(
        true,
      );
      expect(root.querySelector(".heading")).toBeNull();
      test.dispose();
    },
  );
  it("replaces an expired capped event at its exact boundary from cached records, then announces empty", async () => {
    const records = [
      event("current", "2026-10-12T19:00:00Z", "2026-10-12T20:00:05Z"),
      event("next", "2026-10-12T20:01:00Z", "2026-10-12T20:02:00Z"),
    ];
    const { root, element, test, clock } = await render(records, {
      maximumItems: 1,
      emptyText: "No upcoming events",
    });
    expect(root.querySelector(".title")?.textContent).toBe("current");
    clock.advance(5008);
    await element.updateComplete;
    expect(root.querySelector(".title")?.textContent).toBe("next");
    expect(test.states).toEqual([{ state: "ready" }]);
    clock.advance(120000);
    await element.updateComplete;
    expect(root.querySelector(".tc-empty-title")?.textContent).toBe(
      "No upcoming events",
    );
    expect(test.states.at(-1)).toEqual({
      state: "empty",
      reason: "no_records",
    });
    test.dispose();
    expect(clock.pendingTimers).toBe(0);
  });
  it("updates open-ended events across local midnight and can return from empty when inputs change", async () => {
    const { element, test, clock } = await render([
      event("open", "2026-10-12T12:00:00Z"),
    ]);
    clock.advance(Date.parse("2026-10-13T04:00:00Z") - NOW + 8);
    await element.updateComplete;
    expect(test.states.at(-1)?.state).toBe("empty");
    element.data = resolve([event("new", "2026-10-14T12:00:00Z")]);
    await element.updateComplete;
    expect(test.states.at(-1)?.state).toBe("ready");
    test.dispose();
  });
  it("uses locale, time zone and hour cycle, and omits time for date-only values", async () => {
    const { element, root, test } = await render(undefined, {
      showCategory: true,
      showLocation: true,
    });
    element.context = createTestContext({
      clock: createManualClock(NOW),
      timeZone: "America/New_York",
      locale: "es",
      hourCycle: "h23",
    });
    await element.updateComplete;
    expect(root.querySelector(".time")?.textContent).toBe("17:30");
    expect(root.querySelector(".date")?.textContent).toContain("oct");
    expect(root.querySelector(".location")?.textContent).toBe("Main gym");
    expect(root.querySelector(".category")?.textContent).toBe("Athletics");
    element.data = resolve(
      dateFixture.documents[SOURCE as keyof typeof dateFixture.documents]
        .datasets[0]!.records as readonly WidgetRecord[],
    );
    await element.updateComplete;
    expect(root.querySelector(".time")).toBeNull();
    test.dispose();
  });
});
