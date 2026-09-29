import { afterEach, describe, expect, it } from "vitest";
import {
  createManualClock,
  createTestContext,
  fixtureResources,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  eventInstant,
  agendaClockGranularity,
  formatAgendaCountdown,
  formatAgendaCountdownLabel,
  groupAgendaEvents,
  isEnded,
  isNow,
  nowLabel,
  nextAgendaBoundary,
  parseAgendaConfig,
  resolveAgendaData,
  type AgendaConfig,
} from "./agenda.ts";

type AgendaElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";
// A fixed Monday morning in UTC; America/Chicago is still Sunday night,
// which the day-grouping tests rely on.
const NOW = Date.parse("2026-09-28T05:30:00Z");
const TIME_ZONE = "America/Chicago";

const base: AgendaConfig = {
  dataSourceId: SOURCE,
  titleField: "title",
  startField: "start",
  endField: "end",
  locationField: "location",
  descriptionField: "",
  categoryField: "",
  heading: "Coming up",
  style: "agenda",
  nowLabel: "Now",
  nextLabel: "Next",
  maximumItems: 20,
  upcomingCount: 4,
  showCountdown: true,
  showUpcomingTimeline: true,
  groupByDay: true,
  hideEnded: true,
  emptyText: "",
  background: null,
  foreground: null,
  accent: null,
};

function documentWith(
  records: WidgetDataDocument["datasets"][number]["records"],
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [
        {
          id: "events",
          kind: "records",
          fields: [
            { key: "title", label: "Title", type: "text" },
            { key: "start", label: "Start", type: "datetime" },
            { key: "end", label: "End", type: "datetime" },
            { key: "location", label: "Location", type: "text" },
          ],
          records: records as never,
        },
      ],
    },
  };
}

const records = [
  {
    id: "past",
    values: {
      title: { kind: "text", text: "Dawn setup" },
      start: { kind: "datetime", datetime: "2026-09-28T03:00:00Z" },
      end: { kind: "datetime", datetime: "2026-09-28T04:00:00Z" },
    },
  },
  {
    id: "now",
    values: {
      title: { kind: "text", text: "Morning standup" },
      start: { kind: "datetime", datetime: "2026-09-28T05:00:00Z" },
      end: { kind: "datetime", datetime: "2026-09-28T06:00:00Z" },
      location: { kind: "text", text: "Room A" },
    },
  },
  {
    id: "later",
    values: {
      title: { kind: "text", text: "Board meeting" },
      start: { kind: "datetime", datetime: "2026-09-28T16:00:00Z" },
      end: { kind: "datetime", datetime: "2026-09-28T17:00:00Z" },
    },
  },
  {
    id: "next-day",
    values: {
      title: { kind: "text", text: "Choir rehearsal" },
      start: { kind: "datetime", datetime: "2026-09-29T18:00:00Z" },
      end: { kind: "datetime", datetime: "2026-09-29T19:30:00Z" },
    },
  },
  {
    id: "dateless",
    values: {
      title: { kind: "text", text: "Someday gala" },
    },
  },
] as const;

async function render(
  config: Partial<AgendaConfig>,
  documents?: Record<string, WidgetDataDocument>,
  nowMs: number = NOW,
) {
  const clock = createManualClock(nowMs);
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
    context: createTestContext({ clock, timeZone: TIME_ZONE }),
  });
  const element = test.element as AgendaElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text, clock };
}

afterEach(() => document.body.replaceChildren());

describe("Agenda configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseAgendaConfig({ ...base })).toEqual({
      ok: true,
      config: base,
    });
  });

  it("treats missing slots and behavior flags as blank and grouping", () => {
    expect(parseAgendaConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        titleField: "",
        startField: "",
        maximumItems: 20,
        style: "agenda",
        upcomingCount: 4,
        groupByDay: true,
        hideEnded: true,
        showCountdown: true,
        showUpcomingTimeline: true,
        background: null,
        foreground: null,
      },
    });
  });

  it.each([
    [null],
    [[]],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, maximumItems: 0 }],
    [{ dataSourceId: SOURCE, maximumItems: 101 }],
    [{ dataSourceId: SOURCE, maximumItems: 2.5 }],
    [{ dataSourceId: SOURCE, groupByDay: "yes" }],
    [{ dataSourceId: SOURCE, hideEnded: 1 }],
    [{ dataSourceId: SOURCE, startField: "x".repeat(121) }],
    [{ dataSourceId: SOURCE, style: "unknown" }],
    [{ dataSourceId: SOURCE, upcomingCount: 9 }],
  ])("rejects %j", (value) => {
    expect(parseAgendaConfig(value).ok).toBe(false);
  });
});

describe("Agenda time model", () => {
  it("reads instants from datetime and bare-date values", () => {
    expect(
      eventInstant({ kind: "datetime", datetime: "2026-09-28T16:00:00Z" }),
    ).toBe(Date.parse("2026-09-28T16:00:00Z"));
    expect(eventInstant({ kind: "date", date: "2026-09-28" })).toBe(
      Date.parse("2026-09-28"),
    );
    expect(eventInstant({ kind: "text", text: "soon" })).toBeNull();
    expect(
      eventInstant({ kind: "datetime", datetime: "not a date" }),
    ).toBeNull();
    expect(eventInstant(null)).toBeNull();
  });

  it("ends events at their end, or when their local day passes", () => {
    const timed = {
      startMs: Date.parse("2026-09-28T05:00:00Z"),
      endMs: Date.parse("2026-09-28T06:00:00Z"),
    };
    expect(isEnded(timed, NOW, TIME_ZONE)).toBe(false);
    expect(isEnded(timed, Date.parse("2026-09-28T06:00:00Z"), TIME_ZONE)).toBe(
      true,
    );
    const openEnded = { startMs: timed.startMs, endMs: null };
    // Sunday night in Chicago: the same instant is still today there.
    expect(isEnded(openEnded, NOW, TIME_ZONE)).toBe(false);
    expect(isEnded(openEnded, NOW, "UTC")).toBe(false);
    expect(
      isEnded(openEnded, Date.parse("2026-09-29T05:00:00Z"), TIME_ZONE),
    ).toBe(true);
  });

  it("marks started, unfinished events as now", () => {
    expect(
      isNow(
        {
          startMs: Date.parse("2026-09-28T05:00:00Z"),
          endMs: Date.parse("2026-09-28T06:00:00Z"),
        },
        NOW,
        TIME_ZONE,
      ),
    ).toBe(true);
    expect(
      isNow(
        {
          startMs: Date.parse("2026-09-28T16:00:00Z"),
          endMs: Date.parse("2026-09-28T17:00:00Z"),
        },
        NOW,
        TIME_ZONE,
      ),
    ).toBe(false);
  });

  it("labels now in the screen locale, never hard-coded English", () => {
    expect(nowLabel("en-US")).toBe("now");
    expect(nowLabel("es")).not.toBe("now");
    expect(nowLabel("es")).not.toBe("");
    expect(nowLabel("ru")).not.toBe("now");
  });

  it("selects exact start and end boundaries and formats a bounded countdown", () => {
    const start = NOW + 90_000;
    const end = NOW + 3_660_000;
    expect(
      nextAgendaBoundary([{ startMs: start, endMs: end } as never], NOW),
    ).toBe(start);
    expect(
      nextAgendaBoundary([{ startMs: start, endMs: end } as never], start),
    ).toBe(end);
    expect(formatAgendaCountdown(end, NOW)).toBe("1h 1m");
    expect(formatAgendaCountdown(NOW - 1, NOW)).toBe("0s");
  });

  it("uses second cadence only for visible Schedule Board countdowns", () => {
    expect(
      agendaClockGranularity({ style: "schedule-board", showCountdown: true }),
    ).toBe("second");
    expect(
      agendaClockGranularity({ style: "schedule-board", showCountdown: false }),
    ).toBe("minute");
    expect(
      agendaClockGranularity({ style: "now-next", showCountdown: true }),
    ).toBe("minute");
  });

  it("localizes Schedule Board countdown labels for supported screen locales", () => {
    expect(formatAgendaCountdownLabel("start", "en-US")).toBe("Starts in");
    expect(formatAgendaCountdownLabel("end", "es-MX")).toBe("Termina en");
    expect(formatAgendaCountdownLabel("start", "ru-RU")).toBe("Начнётся через");
    expect(formatAgendaCountdownLabel("end", "fr-FR")).toBe("Ends in");
  });
});

describe("Agenda data resolution", () => {
  it("sorts placeable events and drops events without a start", () => {
    const resolved = resolveAgendaData(
      { ...base, maximumItems: 3 },
      fixtureResources({ documents: documentWith([...records]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { total: 5 },
    });
    if (resolved.state !== "ready") throw new Error("expected ready");
    expect(resolved.data.events.map((entry) => entry.id)).toEqual([
      "past",
      "now",
      "later",
    ]);
  });

  it("reports an empty source, missing start mapping and empty records as empty", () => {
    const resources = fixtureResources({
      documents: documentWith([...records]),
    });
    expect(
      resolveAgendaData({ ...base, dataSourceId: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(
      resolveAgendaData({ ...base, startField: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(resolveAgendaData(base, fixtureResources())).toMatchObject({
      state: "empty",
    });
    expect(
      resolveAgendaData(
        base,
        fixtureResources({ documents: documentWith([]) }),
      ),
    ).toMatchObject({ state: "empty" });
  });

  it("reports a record with no placeable event as empty", () => {
    expect(
      resolveAgendaData(
        base,
        fixtureResources({
          documents: documentWith([records[4]!] as never),
        }),
      ),
    ).toMatchObject({ state: "empty" });
  });

  it("reports a source without a records dataset as an error", () => {
    const documents: Record<string, WidgetDataDocument> = {
      [SOURCE]: {
        schemaVersion: 1,
        datasets: [
          {
            id: "total",
            kind: "scalar",
            scalar: { kind: "number", number: 5 },
          },
        ],
      },
    };
    expect(
      resolveAgendaData(base, fixtureResources({ documents })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });

  it("groups resolved events by local day in order", () => {
    const resolved = resolveAgendaData(
      base,
      fixtureResources({ documents: documentWith([...records]) }),
    );
    if (resolved.state !== "ready") throw new Error("expected ready");
    const groups = groupAgendaEvents(resolved.data.events, TIME_ZONE, true);
    // Chicago is behind UTC: 03:00Z is still Sunday the 27th there, while
    // 05:00Z is just past midnight Monday.
    expect(groups.map((group) => group.day)).toEqual([
      "2026-09-27",
      "2026-09-28",
      "2026-09-29",
    ]);
    expect(
      groupAgendaEvents(resolved.data.events, TIME_ZONE, false),
    ).toHaveLength(1);
  });
});

describe("Agenda element", () => {
  it("removes ended events, marks now and groups by day", async () => {
    const { text, root, test } = await render({}, documentWith([...records]));
    expect(text(".heading")).toBe("Coming up");
    const days = [...root.querySelectorAll(".day-name")].map((node) =>
      node.textContent?.trim(),
    );
    // The ended dawn event is gone; two days remain.
    expect(days).toHaveLength(2);
    const titles = [...root.querySelectorAll(".event .title")].map((node) =>
      node.textContent?.trim(),
    );
    expect(titles).toEqual([
      "Morning standup",
      "Board meeting",
      "Choir rehearsal",
    ]);
    expect(text(".event[data-now] .status")).toBe("now");
    expect(text(".event .meta")).toBe("Room A");
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("keeps ended events when the author turns hiding off", async () => {
    const { root, test } = await render(
      { hideEnded: false },
      documentWith([...records]),
    );
    const titles = [...root.querySelectorAll(".event .title")].map((node) =>
      node.textContent?.trim(),
    );
    expect(titles).toContain("Dawn setup");
    test.dispose();
  });

  it("renders one flat list without day grouping", async () => {
    const { root, test } = await render(
      { groupByDay: false },
      documentWith([...records]),
    );
    expect(root.querySelectorAll(".day-name")).toHaveLength(0);
    expect(root.querySelectorAll(".event")).toHaveLength(3);
    test.dispose();
  });

  it("renders its empty message when nothing upcoming remains", async () => {
    const { text, test } = await render(
      { emptyText: "Nothing upcoming." },
      documentWith([]),
    );
    expect(text(".tc-empty-title")).toBe("Nothing upcoming.");
    expect(test.states).toEqual([{ state: "empty", reason: "no_records" }]);
    test.dispose();
  });

  it("preserves source order for legacy Now and Next without usable time fields", async () => {
    const sourceRecords = [
      records[1]!,
      records[2]!,
      records[3]!,
      records[4]!,
    ] as never;
    const config = {
      ...base,
      style: "now-next" as const,
      startField: "",
      upcomingCount: 2,
    };
    const resolved = resolveAgendaData(
      config,
      fixtureResources({ documents: documentWith(sourceRecords) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { sourceOrderFallback: true },
    });
    const { root, test } = await render(
      { style: "now-next", startField: "", upcomingCount: 2 },
      documentWith(sourceRecords),
    );
    expect(root.querySelectorAll(".schedule-feature")).toHaveLength(1);
    expect(root.querySelector(".schedule-label")?.textContent?.trim()).toBe(
      "Now",
    );
    expect(root.querySelector(".schedule-title")?.textContent).toBe(
      "Morning standup",
    );
    expect(
      root.querySelector(".schedule-following-label")?.textContent?.trim(),
    ).toBe("Next");
    expect(
      Array.from(root.querySelectorAll(".schedule-following-title")).map(
        (node) => node.textContent?.trim(),
      ),
    ).toEqual(["Board meeting", "Choir rehearsal"]);
    test.dispose();
  });

  it("shows the current event and a bounded list of following temporal events", async () => {
    const { root, test } = await render(
      { style: "now-next", upcomingCount: 2 },
      documentWith([...records]),
    );
    expect(root.querySelectorAll(".schedule-feature")).toHaveLength(1);
    expect(root.querySelector(".schedule-title")?.textContent).toBe(
      "Morning standup",
    );
    expect(
      root.querySelector(".schedule-following-label")?.textContent?.trim(),
    ).toBe("Next");
    expect(
      Array.from(root.querySelectorAll(".schedule-following-title")).map(
        (node) => node.textContent?.trim(),
      ),
    ).toEqual(["Board meeting", "Choir rehearsal"]);
    test.dispose();
  });

  it("features the next temporal event before listing the following records", async () => {
    const upcomingOnly = [records[2]!, records[3]!] as never;
    const { root, test } = await render(
      { style: "now-next", upcomingCount: 1 },
      documentWith(upcomingOnly),
    );
    expect(root.querySelector(".schedule-label")?.textContent?.trim()).toBe(
      "Next",
    );
    expect(root.querySelector(".schedule-title")?.textContent).toBe(
      "Board meeting",
    );
    expect(
      Array.from(root.querySelectorAll(".schedule-following-title")).map(
        (node) => node.textContent?.trim(),
      ),
    ).toEqual(["Choir rehearsal"]);
    test.dispose();
  });

  it("refreshes sub-minute countdowns each second", async () => {
    const event = [
      {
        id: "ending-soon",
        values: {
          title: { kind: "text", text: "Closing soon" },
          start: {
            kind: "datetime",
            datetime: new Date(NOW - 60_000).toISOString(),
          },
          end: {
            kind: "datetime",
            datetime: new Date(NOW + 42_000).toISOString(),
          },
        },
      },
    ] as never;
    const { root, test, element, clock } = await render(
      { style: "schedule-board" },
      documentWith(event),
    );
    expect(root.querySelector(".schedule-countdown")?.textContent).toBe(
      "Ends in 42s",
    );
    clock.advance(1_008);
    await element.updateComplete;
    expect(root.querySelector(".schedule-countdown")?.textContent).toBe(
      "Ends in 41s",
    );
    test.dispose();
  });

  it("moves the Schedule Board at an event end boundary and empties after the last event", async () => {
    const end = Date.parse("2026-09-28T06:00:00Z");
    const { root, test, element, clock } = await render(
      { style: "schedule-board" },
      documentWith([...records]),
    );
    expect(root.querySelector(".schedule-label")?.textContent?.trim()).toBe(
      "Now",
    );
    expect(root.querySelector(".schedule-countdown")?.textContent).toContain(
      "Ends in 30m",
    );
    clock.advance(end - NOW + 8);
    await element.updateComplete;
    expect(root.querySelector(".schedule-label")?.textContent?.trim()).toBe(
      "Next",
    );
    expect(root.querySelector(".schedule-title")?.textContent).toBe(
      "Board meeting",
    );
    test.dispose();

    const lastEnd = NOW + 5_000;
    const finalRecords = [
      {
        id: "final",
        values: {
          title: { kind: "text", text: "Last event" },
          start: {
            kind: "datetime",
            datetime: new Date(NOW - 60_000).toISOString(),
          },
          end: { kind: "datetime", datetime: new Date(lastEnd).toISOString() },
        },
      },
    ] as never;
    const expires = await render(
      { style: "schedule-board", emptyText: "Schedule finished" },
      documentWith(finalRecords),
    );
    expires.clock.advance(lastEnd - NOW + 8);
    await expires.element.updateComplete;
    expect(expires.text(".tc-empty-title")).toBe("Schedule finished");
    expect(expires.test.states.at(-1)).toMatchObject({
      state: "empty",
      reason: "no_records",
    });
    expires.test.dispose();
  });
});
