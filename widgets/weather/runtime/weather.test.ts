import { afterEach, describe, expect, it } from "vitest";
import { fixtureResources, mountForTest } from "@tilecast/widget-sdk/testing";
import type { WidgetDataDocument } from "@tilecast/widget-sdk";
import widget from "./index.ts";
import {
  conditionKind,
  parseWeatherConfig,
  resolveWeatherData,
  type WeatherConfig,
} from "./weather.ts";

type WeatherElement = HTMLElement & { updateComplete: Promise<unknown> };

const SOURCE = "11111111-1111-4111-8111-111111111111";

const base: WeatherConfig = {
  dataSourceId: SOURCE,
  showLocation: true,
  showCurrent: true,
  forecastDays: 3,
  showHumidity: true,
  showWind: true,
  showPrecipitation: true,
  emptyText: "",
  background: null,
  foreground: null,
};

function documentWith(
  records: WidgetDataDocument["datasets"][number]["records"],
): Record<string, WidgetDataDocument> {
  return {
    [SOURCE]: {
      schemaVersion: 1,
      datasets: [
        {
          id: "records",
          kind: "records",
          cache: { usingCachedData: false, unavailable: false },
          fields: [
            { key: "kind", label: "Kind", type: "text" },
            { key: "location", label: "Location", type: "text" },
            { key: "date", label: "Date", type: "date" },
            { key: "condition", label: "Condition", type: "text" },
            { key: "temperature", label: "Temperature", type: "number" },
            { key: "temperatureUnit", label: "Unit", type: "text" },
            { key: "high", label: "High", type: "number" },
            { key: "low", label: "Low", type: "number" },
            { key: "humidity", label: "Humidity", type: "percent" },
            { key: "windSpeed", label: "Wind", type: "number" },
            { key: "windUnit", label: "Wind unit", type: "text" },
            { key: "precipitation", label: "Rain", type: "number" },
            { key: "precipitationUnit", label: "Rain unit", type: "text" },
          ],
          records,
        },
      ],
    },
  };
}

const current = {
  id: "current",
  values: {
    kind: { kind: "text", text: "current" },
    location: { kind: "text", text: "Riverside" },
    date: { kind: "date", date: "2026-09-28" },
    condition: { kind: "text", text: "Partly Cloudy" },
    temperature: { kind: "number", number: 21.5 },
    temperatureUnit: { kind: "text", text: "°C" },
    humidity: { kind: "percent", number: 62 },
    windSpeed: { kind: "number", number: 3.2 },
    windUnit: { kind: "text", text: "m/s" },
    precipitation: { kind: "number", number: 0 },
    precipitationUnit: { kind: "text", text: "mm" },
  },
};

const forecastDay = {
  id: "day-2026-09-28",
  values: {
    kind: { kind: "text", text: "forecast" },
    location: { kind: "text", text: "Riverside" },
    date: { kind: "date", date: "2026-09-28" },
    condition: { kind: "text", text: "Clear Sky" },
    high: { kind: "number", number: 24 },
    low: { kind: "number", number: 15 },
    temperatureUnit: { kind: "text", text: "°C" },
  },
};

async function render(
  config: Partial<WeatherConfig>,
  documents?: Record<string, WidgetDataDocument>,
) {
  const test = mountForTest(widget, {
    config: { ...base, ...config },
    resources: fixtureResources({ documents }),
  });
  const element = test.element as WeatherElement;
  await element.updateComplete;
  const root = element.shadowRoot!;
  const text = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ??
    null;
  return { test, element, root, text };
}

afterEach(() => document.body.replaceChildren());

describe("Weather configuration", () => {
  it("accepts a complete configuration", () => {
    expect(parseWeatherConfig({ ...base })).toEqual({
      ok: true,
      config: base,
    });
  });

  it("treats missing toggles as visible with a five-day forecast", () => {
    expect(parseWeatherConfig({ dataSourceId: SOURCE })).toMatchObject({
      ok: true,
      config: {
        showLocation: true,
        showCurrent: true,
        forecastDays: 5,
        showHumidity: true,
        showWind: true,
        showPrecipitation: true,
        background: null,
        foreground: null,
      },
    });
  });

  it.each([
    [null],
    [[]],
    [{ dataSourceId: 42 }],
    [{ dataSourceId: SOURCE, forecastDays: -1 }],
    [{ dataSourceId: SOURCE, forecastDays: 8 }],
    [{ dataSourceId: SOURCE, forecastDays: 2.5 }],
    [{ dataSourceId: SOURCE, showCurrent: "yes" }],
    [{ dataSourceId: SOURCE, showWind: 1 }],
  ])("rejects %j", (value) => {
    expect(parseWeatherConfig(value).ok).toBe(false);
  });
});

describe("Weather conditions", () => {
  it("maps provider wordings onto owned icons with a cloud fallback", () => {
    expect(conditionKind("Clear Sky")).toBe("clear");
    expect(conditionKind("Fair")).toBe("clear");
    expect(conditionKind("Partly Cloudy")).toBe("partly");
    expect(conditionKind("Scattered Clouds")).toBe("partly");
    expect(conditionKind("Overcast")).toBe("cloud");
    expect(conditionKind("Light Rain")).toBe("rain");
    expect(conditionKind("Rain Showers")).toBe("rain");
    expect(conditionKind("Thunderstorm")).toBe("storm");
    expect(conditionKind("Light Snow")).toBe("snow");
    expect(conditionKind("Fog")).toBe("fog");
    expect(conditionKind("Something new aloft")).toBe("cloud");
    expect(conditionKind("")).toBe("cloud");
  });
});

describe("Weather data resolution", () => {
  it("splits the current record from the forecast bound", () => {
    const resolved = resolveWeatherData(
      { ...base, forecastDays: 1 },
      fixtureResources({ documents: documentWith([current, forecastDay]) }),
    );
    expect(resolved).toMatchObject({
      state: "ready",
      data: { total: 2 },
    });
    if (resolved.state !== "ready") throw new Error("expected ready");
    expect(resolved.data.current).toMatchObject({
      location: { kind: "text", text: "Riverside" },
    });
    expect(resolved.data.forecast).toHaveLength(1);
  });

  it("reports an empty source, missing document and empty records as empty", () => {
    const resources = fixtureResources({
      documents: documentWith([current]),
    });
    expect(
      resolveWeatherData({ ...base, dataSourceId: "" }, resources),
    ).toMatchObject({ state: "empty" });
    expect(resolveWeatherData(base, fixtureResources())).toMatchObject({
      state: "empty",
    });
    expect(
      resolveWeatherData(
        base,
        fixtureResources({ documents: documentWith([]) }),
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
            cache: { usingCachedData: false, unavailable: false },
            scalar: { kind: "number", number: 1 },
          },
        ],
      },
    };
    expect(
      resolveWeatherData(base, fixtureResources({ documents })),
    ).toMatchObject({ state: "error", code: "incompatible_source" });
  });
});

describe("Weather element", () => {
  it("renders current conditions with units and the forecast strip", async () => {
    const { text, root, test } = await render(
      {},
      documentWith([current, forecastDay]),
    );
    expect(text(".temp")).toBe("21.5 °C");
    expect(text(".condition")).toBe("Partly Cloudy");
    expect(text(".place")).toBe("Riverside");
    const details = [...root.querySelectorAll(".detail")].map((node) =>
      node.textContent?.trim(),
    );
    expect(details).toEqual(["62%", "3.2 m/s", "0 mm"]);
    expect(root.querySelector(".current .icon svg")).not.toBeNull();
    // Icon shapes carry no paint of their own: one CSS rule strokes
    // them in the current color, so a missing attribute can never
    // render a solid blob.
    const shapes = [
      ...root.querySelectorAll(".icon svg circle, .icon svg path"),
    ];
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape.getAttribute("fill")).toBeNull();
      expect(shape.getAttribute("stroke")).toBeNull();
    }
    const days = [...root.querySelectorAll(".forecast .day")];
    expect(days).toHaveLength(1);
    // The bare forecast date is midnight UTC, still Sunday in the Widget
    // zone (America/Chicago in tests).
    expect(text(".forecast .day-name")).toBe("Sunday");
    expect(text(".forecast .high-low")).toBe("24 °C 15 °C");
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("hides toggled-off sections and honors a zero-day forecast", async () => {
    const { root, test } = await render(
      {
        showLocation: false,
        showHumidity: false,
        showWind: false,
        showPrecipitation: false,
        forecastDays: 0,
      },
      documentWith([current, forecastDay]),
    );
    expect(root.querySelector(".place")).toBeNull();
    expect(root.querySelectorAll(".detail")).toHaveLength(0);
    expect(root.querySelectorAll(".forecast .day")).toHaveLength(0);
    expect(root.querySelector(".current")).not.toBeNull();
    test.dispose();
  });

  it("renders its empty message when the source has no records", async () => {
    const { text, test } = await render(
      { emptyText: "Forecast unavailable." },
      documentWith([]),
    );
    expect(text(".tc-empty-title")).toBe("Forecast unavailable.");
    expect(test.states).toEqual([{ state: "empty", reason: "no_records" }]);
    test.dispose();
  });
});
