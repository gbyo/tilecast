import { afterEach, describe, expect, it } from "vitest";
import {
  createManualClock,
  createTestContext,
  fixtureResources,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument, WidgetValue } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  parseStatusConfig,
  resolveStatusData,
  severityTone,
  statusInstant,
  statusActive,
  type StatusConfig,
  type StatusData,
} from "./status.ts";

type StatusElement = HTMLElement & { updateComplete: Promise<unknown> };
const SOURCE = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-28T14:25:36Z");

const base: StatusConfig = {
  dataSourceId: SOURCE,
  style: "panel",
  heading: "Building status",
  statusField: "status",
  messageField: "message",
  severityField: "severity",
  updatedAtField: "updatedAt",
  effectiveAtField: "effectiveAt",
  expiresAtField: "expiresAt",
  showSeverity: true,
  showUpdatedTime: true,
  speed: "normal",
  emptyText: "Status is unavailable",
  background: null,
  foreground: null,
  accent: null,
};

function documentWith(
  values: Readonly<Record<string, WidgetValue>>,
  fields = [
    { key: "status", label: "Status", type: "text" as const },
    { key: "message", label: "Message", type: "text" as const },
    { key: "severity", label: "Severity", type: "text" as const },
    { key: "updatedAt", label: "Updated time", type: "datetime" as const },
    { key: "effectiveAt", label: "Effective time", type: "datetime" as const },
    { key: "expiresAt", label: "Expiration time", type: "datetime" as const },
  ],
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [
        {
          id: "object",
          kind: "object",
          cache: { usingCachedData: false, unavailable: false },
          fields,
          value: { kind: "object", object: values },
        },
      ],
    },
  };
}

function config(overrides: Partial<StatusConfig> = {}): StatusConfig {
  return { ...base, ...overrides };
}

async function render(
  input: Partial<StatusConfig>,
  values: Readonly<Record<string, WidgetValue>>,
  nowMs = NOW,
  reducedMotion = true,
) {
  const clock = createManualClock(nowMs);
  const test = mountForTest(widget, {
    config: config(input),
    resources: fixtureResources({ documents: documentWith(values) }),
    context: createTestContext({
      clock,
      timeZone: "America/Chicago",
      reducedMotion,
    }),
  });
  const element = test.element as StatusElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text, clock };
}

afterEach(() => document.body.replaceChildren());

describe("Status configuration", () => {
  it.each(["panel", "banner"] as const)("accepts %s style", (style) => {
    // "banner" is runtime-only compatibility for stale cached manifests.
    expect(parseStatusConfig({ dataSourceId: SOURCE, style })).toMatchObject({
      ok: true,
      config: { style },
    });
  });

  it("uses bounded defaults and rejects unknown styles and speeds", () => {
    expect(parseStatusConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: { style: "panel", speed: "normal", showUpdatedTime: false },
    });
    expect(parseStatusConfig({ dataSourceId: SOURCE, style: "alert" }).ok).toBe(
      false,
    );
    expect(
      parseStatusConfig({ dataSourceId: SOURCE, speed: "instant" }).ok,
    ).toBe(false);
  });
});

describe("Status data and time model", () => {
  it("treats a missing source as empty and a non-object source as incompatible", () => {
    expect(
      resolveStatusData(config({ dataSourceId: "" }), fixtureResources()),
    ).toMatchObject({
      state: "empty",
    });
    const records: Record<string, WidgetDataDocument> = {
      [SOURCE]: {
        schemaVersion: 1,
        datasets: [
          {
            id: "records",
            kind: "records",
            cache: { usingCachedData: false, unavailable: false },
            records: [],
          },
        ],
      },
    };
    expect(
      resolveStatusData(base, fixtureResources({ documents: records })),
    ).toMatchObject({
      state: "error",
      code: "incompatible_source",
    });
  });

  it("accepts status-only objects and objects with optional fields absent", async () => {
    const { root, text, test } = await render(
      {
        messageField: "",
        severityField: "",
        updatedAtField: "",
        effectiveAtField: "",
        expiresAtField: "",
      },
      { status: { kind: "text", text: "Open" } },
    );
    expect(text(".status-value")).toBe("Open");
    expect(root.querySelector(".message")).toBeNull();
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("renders the mapped message and severity without interpreting the provider", async () => {
    const { text, root, test } = await render(
      {},
      {
        status: { kind: "text", text: "Delayed" },
        message: { kind: "text", text: "Opening at ten." },
        severity: { kind: "text", text: "warning" },
      },
    );
    expect(text(".status-value")).toBe("Delayed");
    expect(text(".message")).toBe("Opening at ten.");
    expect(root.querySelector(".tc-badge")?.getAttribute("data-tone")).toBe(
      "warning",
    );
    test.dispose();
  });

  it("uses neutral presentation for unfamiliar severity text", async () => {
    expect(severityTone("unusual-level")).toBe("neutral");
    const { root, test } = await render(
      {},
      {
        status: { kind: "text", text: "Open" },
        severity: { kind: "text", text: "unusual-level" },
      },
    );
    expect(root.querySelector(".tc-badge")?.getAttribute("data-tone")).toBe(
      "neutral",
    );
    test.dispose();
  });

  it.each([
    ["Minor", "accent"],
    ["Moderate", "warning"],
    ["Severe", "critical"],
    ["Extreme", "critical"],
  ] as const)("maps CAP severity %s to %s", (severity, tone) => {
    expect(severityTone(severity)).toBe(tone);
  });

  it("renders the Emergency Alerts managed severity vocabulary", async () => {
    const { root, test } = await render(
      { style: "banner" },
      {
        status: { kind: "text", text: "Tornado Warning" },
        message: { kind: "text", text: "Take shelter now." },
        severity: { kind: "text", text: "Extreme" },
      },
    );
    expect(root.querySelector(".tc-badge")?.getAttribute("data-tone")).toBe(
      "critical",
    );
    test.dispose();
  });

  it("formats an updated datetime in the screen locale and time zone", async () => {
    const { text, test } = await render(
      {},
      {
        status: { kind: "text", text: "Open" },
        updatedAt: { kind: "datetime", datetime: "2026-09-28T14:20:00Z" },
      },
    );
    expect(text(".updated")).toContain("9:20 AM");
    test.dispose();
  });

  it("applies effective and expiration boundaries inclusively", () => {
    const data: StatusData = {
      fields: {},
      values: {
        effectiveAt: { kind: "datetime", datetime: "2026-09-28T14:30:00Z" },
        expiresAt: { kind: "datetime", datetime: "2026-09-28T15:00:00Z" },
      },
    };
    expect(
      statusActive(base, data, Date.parse("2026-09-28T14:29:59Z")),
    ).toEqual({
      active: false,
      reason: "not_yet_active",
    });
    expect(
      statusActive(base, data, Date.parse("2026-09-28T14:30:00Z")),
    ).toEqual({ active: true });
    expect(
      statusActive(base, data, Date.parse("2026-09-28T14:59:59Z")),
    ).toEqual({ active: true });
    expect(
      statusActive(base, data, Date.parse("2026-09-28T15:00:00Z")),
    ).toEqual({
      active: false,
      reason: "expired",
    });
    expect(
      statusActive(
        config({ effectiveAtField: "", expiresAtField: "" }),
        data,
        NOW,
      ),
    ).toEqual({
      active: true,
    });
  });

  it("uses screen-local midnights and includes a date-only expiration day", () => {
    const data: StatusData = {
      fields: {},
      values: {
        effectiveAt: { kind: "date", date: "2026-09-29" },
        expiresAt: { kind: "date", date: "2026-09-29" },
      },
    };
    const zone = "America/New_York";
    expect(statusInstant(data.values.effectiveAt, zone)).toBe(
      Date.parse("2026-09-29T04:00:00Z"),
    );
    expect(
      statusActive(base, data, Date.parse("2026-09-29T03:59:59Z"), zone),
    ).toEqual({ active: false, reason: "not_yet_active" });
    expect(
      statusActive(base, data, Date.parse("2026-09-29T04:00:00Z"), zone),
    ).toEqual({ active: true });
    expect(
      statusActive(base, data, Date.parse("2026-09-30T03:59:59Z"), zone),
    ).toEqual({ active: true });
    expect(
      statusActive(base, data, Date.parse("2026-09-30T04:00:00Z"), zone),
    ).toEqual({ active: false, reason: "expired" });
  });

  it("reevaluates an exact effective boundary from the Widget clock", async () => {
    const at = NOW + 10_000;
    const { test, element, text, clock } = await render(
      {},
      {
        status: { kind: "text", text: "Open" },
        effectiveAt: { kind: "datetime", datetime: new Date(at).toISOString() },
      },
    );
    expect(text(".tc-empty-title")).toBe("Status is unavailable");
    expect(test.states.at(-1)).toMatchObject({
      state: "empty",
      reason: "not_yet_active",
    });
    clock.advance(at - NOW + 8);
    await element.updateComplete;
    expect(text(".status-value")).toBe("Open");
    expect(test.states.at(-1)).toEqual({ state: "ready" });
    test.dispose();
  });

  it("switches to the empty state at expiry without host polling", async () => {
    const at = NOW + 10_000;
    const { test, element, text, clock } = await render(
      {},
      {
        status: { kind: "text", text: "Open" },
        expiresAt: { kind: "datetime", datetime: new Date(at).toISOString() },
      },
    );
    expect(text(".status-value")).toBe("Open");
    clock.advance(at - NOW + 8);
    await element.updateComplete;
    expect(text(".tc-empty-title")).toBe("Status is unavailable");
    expect(test.states.at(-1)).toMatchObject({
      state: "empty",
      reason: "expired",
    });
    test.dispose();
  });

  it("bounds long text and leaves the small-zone presentation compact", async () => {
    const longMessage = "Message ".repeat(500);
    const { root, text, test } = await render(
      {},
      {
        status: { kind: "text", text: "Open" },
        message: { kind: "text", text: longMessage },
      },
    );
    expect(text(".message")?.length).toBeLessThanOrEqual(1600);
    expect(
      root.querySelector(".status-panel")?.getAttribute("data-style"),
    ).toBe("panel");
    expect(root.querySelector(".message")?.textContent?.length).toBeGreaterThan(
      0,
    );
    test.dispose();
  });

  it("keeps a banner readable when reduced motion is enabled", async () => {
    const { element, root, test } = await render(
      { style: "banner", speed: "fast" },
      {
        message: {
          kind: "text",
          text: "A long notice scrolls when motion is allowed.",
        },
      },
      NOW,
      true,
    );
    expect(element.hasAttribute("data-reduced-motion")).toBe(true);
    expect(
      root.querySelector(".message-track")?.getAttribute("data-speed"),
    ).toBe("fast");
    expect(root.querySelector(".message-copy")?.textContent).toContain(
      "A long notice",
    );
    test.dispose();
  });

  it("does not repeat a status that matches the banner severity", async () => {
    const { root, text, test } = await render(
      { style: "banner" },
      {
        status: { kind: "text", text: "Warning" },
        message: { kind: "text", text: "The north entrance is closed." },
        severity: { kind: "text", text: "warning" },
      },
    );
    expect(root.querySelector(".banner-status")).toBeNull();
    expect(text(".message-copy")).toBe("The north entrance is closed.");
    test.dispose();
  });

  it("keeps a distinct status beside the banner message", async () => {
    const { text, test } = await render(
      { style: "banner" },
      {
        status: { kind: "text", text: "North entrance" },
        message: {
          kind: "text",
          text: "Closed while crews clear the walkway.",
        },
        severity: { kind: "text", text: "warning" },
      },
    );
    expect(text(".banner-status")).toBe("North entrance");
    expect(text(".message-copy")).toBe("Closed while crews clear the walkway.");
    test.dispose();
  });
});
