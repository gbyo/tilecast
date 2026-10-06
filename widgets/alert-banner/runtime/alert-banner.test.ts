import { afterEach, describe, expect, it } from "vitest";
import {
  createTestContext,
  fixtureResources,
  mountForTest,
} from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument, WidgetValue } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  alertSeverityTone,
  parseAlertBannerConfig,
  resolveAlertBannerData,
  type AlertBannerConfig,
} from "./alert-banner.ts";

type BannerElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: AlertBannerConfig = {
  dataSourceId: SOURCE,
  messageField: "message",
  severityField: "severity",
  labelField: "label",
  showSeverity: true,
  speed: "normal",
  emptyText: "No active alerts",
  background: null,
  foreground: null,
};

const text = (value: string): WidgetValue => ({ kind: "text", text: value });

function documentWith(
  values: Readonly<Record<string, WidgetValue>>,
  keys: readonly string[] = Object.keys(values),
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [
        {
          id: "object",
          kind: "object",
          cache: { usingCachedData: false, unavailable: false },
          fields: keys.map((key) => ({
            key,
            label: key,
            type: "text" as const,
          })),
          value: { kind: "object", object: values },
        },
      ],
    },
  };
}

async function render(
  input: Partial<AlertBannerConfig>,
  values: Readonly<Record<string, WidgetValue>>,
  reducedMotion = true,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...input },
    resources: fixtureResources({ documents: documentWith(values) }),
    context: createTestContext({ reducedMotion }),
  });
  const element = test.element as BannerElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const read = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, read };
}

afterEach(() => document.body.replaceChildren());

describe("Alert Banner configuration", () => {
  it("applies bounded defaults to a source-only configuration", () => {
    expect(parseAlertBannerConfig({ dataSourceId: SOURCE })).toEqual({
      ok: true,
      config: {
        dataSourceId: SOURCE,
        messageField: "",
        severityField: "",
        labelField: "",
        showSeverity: true,
        speed: "normal",
        emptyText: "No active alerts",
        background: null,
        foreground: null,
      },
    });
  });

  it("accepts a complete configuration", () => {
    expect(
      parseAlertBannerConfig({
        ...base,
        speed: "fast",
        showSeverity: false,
        emptyText: "All clear",
        background: "#112233",
        foreground: "#ffffff",
      }),
    ).toMatchObject({
      ok: true,
      config: {
        speed: "fast",
        showSeverity: false,
        emptyText: "All clear",
        background: "#112233",
        foreground: "#ffffff",
      },
    });
  });

  it.each([
    ["a non-object", "alert"],
    ["an array", []],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(parseAlertBannerConfig(value).ok).toBe(false);
  });

  it.each([
    ["an unknown speed", { speed: "instant" }],
    ["a non-boolean showSeverity", { showSeverity: "yes" }],
    ["a non-text Data Source", { dataSourceId: 7 }],
    ["a non-text message field", { messageField: ["message"] }],
    ["a non-text severity field", { severityField: 3 }],
    ["a non-text label field", { labelField: {} }],
    ["an over-long field name", { messageField: "m".repeat(121) }],
  ])("rejects %s", (_name, overrides) => {
    expect(parseAlertBannerConfig({ ...base, ...overrides }).ok).toBe(false);
  });

  it("bounds the empty message and ignores unusable colors", () => {
    const parsed = parseAlertBannerConfig({
      ...base,
      emptyText: "x".repeat(900),
      background: "not-a-color",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.emptyText.length).toBeLessThanOrEqual(300);
    expect(parsed.config.background).toBeNull();
  });
});

describe("Alert Banner data", () => {
  it("is empty without a Data Source", () => {
    expect(
      resolveAlertBannerData({ ...base, dataSourceId: "" }, fixtureResources()),
    ).toMatchObject({ state: "empty", reason: "no_source" });
  });

  it("is empty when the selected source has no document yet", () => {
    expect(resolveAlertBannerData(base, fixtureResources())).toMatchObject({
      state: "empty",
      reason: "no_source",
    });
  });

  it("is incompatible with a source that is not an object", () => {
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

  it("is empty for an object source without values", () => {
    expect(
      resolveAlertBannerData(
        base,
        fixtureResources({ documents: documentWith({}, ["message"]) }),
      ),
    ).toMatchObject({ state: "empty", reason: "no_values" });
  });

  it("is ready for a message-only object source", () => {
    expect(
      resolveAlertBannerData(
        base,
        fixtureResources({
          documents: documentWith({ message: text("Gym closed.") }),
        }),
      ),
    ).toMatchObject({ state: "ready" });
  });
});

describe("Alert Banner severity tone", () => {
  it.each([
    ["normal", "positive"],
    ["Minor", "accent"],
    ["notice", "accent"],
    ["informational", "accent"],
    ["Moderate", "warning"],
    ["warning", "warning"],
    ["Severe", "critical"],
    ["Extreme", "critical"],
    ["critical", "critical"],
    ["  SEVERE  ", "critical"],
    ["unfamiliar", "neutral"],
    ["", "neutral"],
  ] as const)("maps %j to %s", (severity, tone) => {
    expect(alertSeverityTone(severity)).toBe(tone);
  });
});

describe("Alert Banner rendering", () => {
  it("renders a message-only source without a severity badge or label", async () => {
    const { test, root, read } = await render(
      { severityField: "", labelField: "" },
      { message: text("Parking lot B is closed today.") },
    );
    expect(read(".message-copy")).toBe("Parking lot B is closed today.");
    expect(root.querySelector(".severity")).toBeNull();
    expect(root.querySelector(".label")).toBeNull();
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("treats a mapped severity the source does not contain as absent", async () => {
    // The default configuration maps "severity"; a message-only source must
    // still render, without inventing a badge.
    const { test, root, read } = await render(
      {},
      { message: text("Early dismissal at noon.") },
    );
    expect(read(".message-copy")).toBe("Early dismissal at noon.");
    expect(root.querySelector(".severity")).toBeNull();
    expect(root.querySelector(".tc-badge")).toBeNull();
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("renders message, severity, and label from a richer source", async () => {
    const { test, root, read } = await render(
      {},
      {
        message: text("Tornado warning until 9:15 PM."),
        severity: text("severe"),
        label: text("Weather alert"),
      },
    );
    expect(read(".message-copy")).toBe("Tornado warning until 9:15 PM.");
    expect(read(".severity")).toBe("severe");
    expect(root.querySelector(".tc-badge")?.getAttribute("data-tone")).toBe(
      "critical",
    );
    expect(read(".label")).toBe("Weather alert");
    test.dispose();
  });

  it.each([
    ["Minor", "accent"],
    ["Moderate", "warning"],
    ["Extreme", "critical"],
    ["unfamiliar", "neutral"],
  ] as const)(
    "tones the severity badge for %s as %s",
    async (severity, tone) => {
      const { test, root } = await render(
        {},
        { message: text("Message."), severity: text(severity) },
      );
      expect(root.querySelector(".tc-badge")?.getAttribute("data-tone")).toBe(
        tone,
      );
      test.dispose();
    },
  );

  it("hides the severity badge when showSeverity is off", async () => {
    const { test, root, read } = await render(
      { showSeverity: false },
      { message: text("Message."), severity: text("severe") },
    );
    expect(root.querySelector(".severity")).toBeNull();
    expect(read(".message-copy")).toBe("Message.");
    test.dispose();
  });

  it("shows no badge for an empty severity value even when showSeverity is on", async () => {
    const { test, root } = await render(
      { showSeverity: true },
      { message: text("Message."), severity: text("") },
    );
    expect(root.querySelector(".severity")).toBeNull();
    test.dispose();
  });

  it("omits the label chrome when no label field is mapped", async () => {
    const { test, root } = await render(
      { labelField: "" },
      { message: text("Message."), label: text("Weather alert") },
    );
    expect(root.querySelector(".label")).toBeNull();
    test.dispose();
  });

  it("omits the label when the mapped value is empty", async () => {
    const { test, root } = await render(
      {},
      { message: text("Message."), label: text("   ") },
    );
    expect(root.querySelector(".label")).toBeNull();
    test.dispose();
  });

  it("suppresses a label that repeats the severity, ignoring case", async () => {
    const { test, root, read } = await render(
      {},
      {
        message: text("Message."),
        severity: text("Warning"),
        label: text("WARNING"),
      },
    );
    expect(read(".severity")).toBe("Warning");
    expect(root.querySelector(".label")).toBeNull();
    test.dispose();
  });

  it("keeps a label that differs from the severity", async () => {
    const { test, read } = await render(
      {},
      {
        message: text("Message."),
        severity: text("warning"),
        label: text("North entrance"),
      },
    );
    expect(read(".label")).toBe("North entrance");
    test.dispose();
  });

  it("suppresses a duplicate label even when the severity badge is hidden", async () => {
    const { test, root, read } = await render(
      { showSeverity: false },
      {
        message: text("Message."),
        severity: text("warning"),
        label: text("warning"),
      },
    );
    // Duplicate suppression compares against the source's severity value,
    // not whether the badge is on screen, so turning the badge back on never
    // shows the same word twice.
    expect(root.querySelector(".severity")).toBeNull();
    expect(root.querySelector(".label")).toBeNull();
    expect(read(".message-copy")).toBe("Message.");
    test.dispose();
  });

  it("shows the configured empty message when the source has no values", async () => {
    const test = mountForTest(widget, {
      config: { ...base, emptyText: "All clear" },
      resources: fixtureResources({
        documents: documentWith({}, ["message"]),
      }),
      context: createTestContext({ reducedMotion: true }),
    });
    const element = test.element as BannerElement;
    await element.updateComplete;
    expect(
      element.shadowRoot?.querySelector(".empty-message")?.textContent,
    ).toBe("All clear");
    expect(element.shadowRoot?.querySelector(".message-track")).toBeNull();
    test.dispose();
  });

  it("shows the configured empty message when no Data Source is selected", async () => {
    const test = mountForTest(widget, {
      config: { ...base, dataSourceId: "", emptyText: "No alerts" },
      resources: fixtureResources(),
      context: createTestContext({ reducedMotion: true }),
    });
    const element = test.element as BannerElement;
    await element.updateComplete;
    expect(
      element.shadowRoot?.querySelector(".empty-message")?.textContent,
    ).toBe("No alerts");
    test.dispose();
  });

  it("falls back to the empty message when the mapped message is blank", async () => {
    const { test, root, read } = await render(
      { labelField: "" },
      { message: text("   "), severity: text("severe") },
    );
    expect(read(".empty-message")).toBe("No active alerts");
    expect(root.querySelector(".message-track")).toBeNull();
    expect(root.querySelector(".severity")).toBeNull();
    expect(test.states).toEqual([{ state: "empty", reason: "no_message" }]);
    test.dispose();
  });

  it("falls back to the empty message when the message field is unmapped", async () => {
    const { test, read } = await render(
      { messageField: "", labelField: "" },
      { message: text("Present but unmapped.") },
    );
    expect(read(".empty-message")).toBe("No active alerts");
    test.dispose();
  });

  it("uses the label as the message, once, when the message is blank", async () => {
    const { test, root, read } = await render(
      {},
      { message: text(""), label: text("Weather alert") },
    );
    expect(read(".message-copy")).toBe("Weather alert");
    expect(root.querySelector(".label")).toBeNull();
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("applies the configured colors and ignores invalid ones", async () => {
    const plain = await render({}, { message: text("Message.") });
    const themed = await render(
      { background: "#112233", foreground: "#fafafa" },
      { message: text("Message.") },
    );
    const invalid = await render(
      { background: "javascript:red", foreground: "nope" },
      { message: text("Message.") },
    );
    const bg = (element: HTMLElement) =>
      element.style.getPropertyValue("--tc-color-bg");
    expect(bg(themed.element)).not.toBe("");
    expect(bg(themed.element)).not.toBe(bg(plain.element));
    expect(bg(invalid.element)).toBe(bg(plain.element));
    for (const run of [plain, themed, invalid]) run.test.dispose();
  });
});

describe("Alert Banner motion", () => {
  it("renders a static, single-line message under reduced motion", async () => {
    const { test, element, root } = await render(
      { speed: "fast" },
      {
        message: text(
          "A long notice that would scroll when motion is allowed.",
        ),
      },
      true,
    );
    expect(element.hasAttribute("data-reduced-motion")).toBe(true);
    expect(
      root.querySelector(".message-track")?.getAttribute("data-speed"),
    ).toBe("fast");
    // The second copy exists only for the seamless marquee loop; it is
    // hidden from assistive technology and, under reduced motion, from view.
    const copies = root.querySelectorAll(".message-copy");
    expect(copies).toHaveLength(2);
    expect(copies[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(copies[0]?.getAttribute("aria-hidden")).toBeNull();
    test.dispose();
  });

  it("keeps the marquee track when motion is allowed", async () => {
    const { test, element, root } = await render(
      { speed: "slow" },
      { message: text("Message.") },
      false,
    );
    expect(element.hasAttribute("data-reduced-motion")).toBe(false);
    expect(
      root.querySelector(".message-track")?.getAttribute("data-speed"),
    ).toBe("slow");
    test.dispose();
  });
});
