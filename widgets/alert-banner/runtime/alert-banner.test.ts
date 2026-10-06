import { afterEach, describe, expect, it } from "vitest";
import type { WidgetDataDocument, WidgetValue } from "@tilecast/widget-sdk";
import {
  createTestContext,
  fixtureResources,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import widget from "./index.ts";
import {
  alertSeverityTone,
  parseAlertBannerConfig,
  resolveAlertBannerData,
  type AlertBannerConfig,
} from "./alert-banner.ts";

type AlertElement = HTMLElement & { updateComplete: Promise<unknown> };
const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: AlertBannerConfig = {
  dataSourceId: SOURCE,
  messageField: "message",
  severityField: "severity",
  labelField: "status",
  showSeverity: true,
  speed: "normal",
  emptyText: "No active alerts",
  background: null,
  foreground: null,
};

function documentWith(
  values: Readonly<Record<string, WidgetValue>>,
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [
        {
          id: "object",
          kind: "object",
          cache: { usingCachedData: false, unavailable: false },
          fields: [
            { key: "message", label: "Message", type: "text" },
            { key: "severity", label: "Severity", type: "text" },
            { key: "status", label: "Status", type: "text" },
          ],
          value: { kind: "object", object: values },
        },
      ],
    },
  };
}

async function render(
  values: Readonly<Record<string, WidgetValue>>,
  overrides: Partial<AlertBannerConfig> = {},
  reducedMotion = true,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...overrides },
    resources: fixtureResources({ documents: documentWith(values) }),
    context: createTestContext({ reducedMotion }),
  });
  const element = test.element as AlertElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("Alert Banner configuration", () => {
  it("uses bounded defaults and rejects invalid settings", () => {
    expect(parseAlertBannerConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: { speed: "normal", showSeverity: true },
    });
    expect(
      parseAlertBannerConfig({ dataSourceId: SOURCE, speed: "instant" }).ok,
    ).toBe(false);
    expect(
      parseAlertBannerConfig({ dataSourceId: SOURCE, showSeverity: "yes" }).ok,
    ).toBe(false);
  });

  it("treats missing and incompatible sources distinctly", () => {
    expect(
      resolveAlertBannerData(
        { ...base, dataSourceId: "" },
        fixtureResources(),
      ),
    ).toMatchObject({ state: "empty" });
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
      resolveAlertBannerData(base, fixtureResources({ documents: records })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Alert Banner presentation", () => {
  it("renders a mapped urgent message, label, and CAP severity", async () => {
    const { root, text, test } = await render({
      message: { kind: "text", text: "Take shelter now." },
      severity: { kind: "text", text: "Extreme" },
      status: { kind: "text", text: "Tornado Warning" },
    });
    expect(text(".message-copy")).toBe("Take shelter now.");
    expect(text(".label")).toBe("Tornado Warning");
    expect(root.querySelector(".tc-badge")?.getAttribute("data-tone")).toBe(
      "critical",
    );
    expect(test.states.at(-1)).toEqual({ state: "ready" });
    test.dispose();
  });

  it("does not repeat a label that matches the severity", async () => {
    const { root, test } = await render({
      message: { kind: "text", text: "North entrance closed." },
      severity: { kind: "text", text: "Warning" },
      status: { kind: "text", text: "warning" },
    });
    expect(root.querySelector(".label")).toBeNull();
    test.dispose();
  });

  it.each([
    ["Minor", "accent"],
    ["Moderate", "warning"],
    ["Severe", "critical"],
    ["Extreme", "critical"],
    ["Unknown", "neutral"],
  ] as const)("maps severity %s to %s", (severity, tone) => {
    expect(alertSeverityTone(severity)).toBe(tone);
  });

  it("reports an empty state when there is no message or label", async () => {
    const { text, test } = await render({
      severity: { kind: "text", text: "Minor" },
    });
    expect(text(".empty-message")).toBe("No active alerts");
    expect(test.states.at(-1)).toMatchObject({
      state: "empty",
      reason: "no_message",
    });
    test.dispose();
  });

  it("keeps reduced-motion output readable and bounds long messages", async () => {
    const { element, root, text, test } = await render(
      {
        message: { kind: "text", text: "Alert ".repeat(400) },
        severity: { kind: "text", text: "Severe" },
      },
      { speed: "fast", labelField: "" },
      true,
    );
    expect(element.hasAttribute("data-reduced-motion")).toBe(true);
    const track = root.querySelector(".message-track");
    expect(track?.getAttribute("data-speed")).toBe("fast");
    expect(text(".message-copy")?.length).toBeLessThanOrEqual(1600);
    expect(root.querySelectorAll(".message-copy")).toHaveLength(2);
    expect(root.querySelectorAll(".message-copy")[1]).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    test.dispose();
  });
});
