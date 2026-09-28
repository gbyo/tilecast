/**
 * Weather V2: current conditions plus a multi-day forecast, provider-neutral.
 *
 * The Widget consumes the normalized Weather source contract (records with
 * a `kind` of `current` or `forecast` plus location, date, condition,
 * temperature, high, low, humidity, wind and precipitation fields) and
 * never knows which provider fetched them. Condition icons are
 * Tilecast-owned shapes mapped from normalized condition labels; no
 * provider icon asset is ever downloaded on the Player.
 *
 * Layout is container queries only: fullscreen landscape pairs current
 * conditions with the forecast strip, portrait stacks them, a wide strip
 * collapses to one compact line, and a small zone keeps temperature,
 * condition and high/low.
 */
import {
  css,
  html,
  nothing,
  svg,
  type SVGTemplateResult,
  type TemplateResult,
} from "lit";
import {
  empty,
  failure,
  firstRecordsDataset,
  parseHexColor,
  ready,
  type ConfigResult,
  type WidgetField,
  type WidgetRecord,
  type WidgetResources,
  type WidgetResolution,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import {
  boundText,
  formatDate,
  formatWidgetValue,
  TilecastWidgetElement,
  emptyState,
} from "@tilecast/widget-kit";

export interface WeatherConfig {
  readonly dataSourceId: string;
  readonly showLocation: boolean;
  readonly showCurrent: boolean;
  readonly forecastDays: number;
  readonly showHumidity: boolean;
  readonly showWind: boolean;
  readonly showPrecipitation: boolean;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface WeatherData {
  readonly current: Readonly<Record<string, WidgetValue>> | null;
  readonly forecast: readonly Readonly<Record<string, WidgetValue>>[];
  readonly fields: Readonly<Record<string, WidgetField>>;
  readonly total: number;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

export function parseWeatherConfig(
  value: unknown,
): ConfigResult<WeatherConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = raw["dataSourceId"];
  if (
    (source !== undefined && source !== null && typeof source !== "string") ||
    (typeof source === "string" && source.length > 200)
  ) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  const showLocation = optionalBoolean(raw["showLocation"], true);
  const showCurrent = optionalBoolean(raw["showCurrent"], true);
  const showHumidity = optionalBoolean(raw["showHumidity"], true);
  const showWind = optionalBoolean(raw["showWind"], true);
  const showPrecipitation = optionalBoolean(raw["showPrecipitation"], true);
  if (
    showLocation === null ||
    showCurrent === null ||
    showHumidity === null ||
    showWind === null ||
    showPrecipitation === null
  ) {
    return { ok: false, problem: "display toggles must be booleans" };
  }
  const forecastDays = raw["forecastDays"] ?? 5;
  if (
    typeof forecastDays !== "number" ||
    !Number.isInteger(forecastDays) ||
    forecastDays < 0 ||
    forecastDays > 7
  ) {
    return {
      ok: false,
      problem: "forecastDays must be an integer from 0 to 7",
    };
  }
  return {
    ok: true,
    config: {
      dataSourceId: typeof source === "string" ? source : "",
      showLocation,
      showCurrent,
      forecastDays,
      showHumidity,
      showWind,
      showPrecipitation,
      emptyText: boundText(raw["emptyText"] ?? "", 200),
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

function recordText(
  values: Readonly<Record<string, WidgetValue>>,
  key: string,
): string {
  const value = values[key];
  return typeof value?.text === "string" ? value.text : "";
}

/** Read a calendar day from a date, datetime or text value. */
function recordDay(
  values: Readonly<Record<string, WidgetValue>>,
  key: string,
): string {
  const value = values[key];
  if (typeof value?.date === "string") return value.date;
  if (typeof value?.datetime === "string") return value.datetime;
  return recordText(values, key);
}

export function resolveWeatherData(
  config: WeatherConfig,
  resources: WidgetResources,
): WidgetResolution<WeatherData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records: readonly WidgetRecord[] = dataset.records ?? [];
  const current =
    records.find((record) => recordText(record.values, "kind") === "current") ??
    null;
  const forecast = records
    .filter((record) => recordText(record.values, "kind") === "forecast")
    .slice(0, config.forecastDays);
  if (!current && forecast.length === 0) return empty("no_records");
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  return ready({
    current: current?.values ?? null,
    forecast: forecast.map((record) => record.values),
    fields,
    total: records.length,
  });
}

export type ConditionKind =
  "clear" | "partly" | "cloud" | "rain" | "storm" | "snow" | "fog";

/**
 * Map a normalized condition label onto one owned icon kind. Matching is
 * by keyword because providers word the same sky differently
 * ("Partly cloudy", "Scattered clouds"); anything unrecognized falls back
 * to cloud rather than rendering a blank frame.
 */
export function conditionKind(condition: string): ConditionKind {
  const label = condition.toLowerCase();
  if (
    label.includes("thunder") ||
    label.includes("lightning") ||
    label.includes("storm")
  )
    return "storm";
  if (
    label.includes("snow") ||
    label.includes("sleet") ||
    label.includes("hail") ||
    label.includes("blizzard")
  )
    return "snow";
  if (
    label.includes("rain") ||
    label.includes("drizzle") ||
    label.includes("shower")
  )
    return "rain";
  if (
    label.includes("fog") ||
    label.includes("mist") ||
    label.includes("haze") ||
    label.includes("smoke")
  )
    return "fog";
  if (
    label.includes("clear") ||
    label.includes("fair") ||
    label.includes("sunny")
  )
    return "clear";
  if (
    label.includes("partly") ||
    label.includes("few") ||
    label.includes("scattered")
  )
    return "partly";
  return "cloud";
}

function conditionIcon(kind: ConditionKind): SVGTemplateResult {
  const cloudPath =
    "M7 19a4.5 4.5 0 1 1 .7-8.94A6 6 0 0 1 19.3 12.5H20a3.5 3.5 0 0 1 0 7H7Z";
  switch (kind) {
    case "clear":
      return svg`<svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4.4" />
        <path
          d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"
         
        />
      </svg>`;
    case "partly":
      return svg`<svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="3.4" />
        <path d="M8.5 1.8v1.8M2 8.5h1.8M4 4l1.2 1.2M13 4l-1.2 1.2" />
        <path d=${cloudPath} transform="translate(2.5 2.5) scale(0.86)" />
      </svg>`;
    case "rain":
      return svg`<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d=${cloudPath} transform="translate(0 -2)" />
        <path d="M8 17.5 7 20M12.5 17.5l-1 2.5M17 17.5l-1 2.5" />
      </svg>`;
    case "storm":
      return svg`<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d=${cloudPath} transform="translate(0 -2)" />
        <path d="M12.8 15.5 9.5 20.5h2.6l-1 3 4.6-6.5h-2.9l1-2.5" />
      </svg>`;
    case "snow":
      return svg`<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d=${cloudPath} transform="translate(0 -2.5)" />
        <path
          d="M8 18h.01M12 19.5h.01M16 18h.01M10 21h.01M14 21h.01"
         
          stroke-width="2.4"
        />
      </svg>`;
    case "fog":
      return svg`<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d=${cloudPath} transform="translate(0 -4) scale(0.9)" />
        <path d="M5 18h14M7 21h10" />
      </svg>`;
    case "cloud":
      return svg`<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d=${cloudPath} />
      </svg>`;
  }
}

export class TilecastWeatherWidget extends TilecastWidgetElement<
  WeatherConfig,
  WeatherData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .weather {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: stretch;
        justify-content: center;
        gap: min(6cqw, 6cqh);
        min-height: 0;
        overflow: hidden;
        padding: var(--tc-gutter);
      }
      .current {
        display: flex;
        align-items: center;
        gap: min(3cqw, 3cqh);
        min-width: 0;
      }
      .icon {
        flex: none;
        width: clamp(48px, min(22cqh, 16cqw), 260px);
        aspect-ratio: 1;
        color: var(--tc-color-fg-subtle);
      }
      .icon svg {
        width: 100%;
        height: 100%;
        display: block;
      }
      /* Icons are line drawings in the current color. The shapes carry
         no paint of their own, so one rule owns the stroke and a widget
         can never render a solid blob by missing an attribute. */
      .icon svg :is(circle, path) {
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .temp {
        font-size: clamp(28px, min(16cqh, 11cqw), 240px);
        font-weight: 650;
        letter-spacing: -0.02em;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .condition {
        font-size: clamp(12px, min(5.4cqh, 3.6cqw), 92px);
        font-weight: 600;
        line-height: 1.25;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .place {
        font-size: clamp(10px, min(4.2cqh, 2.9cqw), 68px);
        font-weight: 500;
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .details {
        display: flex;
        gap: min(3cqw, 3cqh);
        margin-top: min(1.6cqh, 1.6cqw);
      }
      .detail {
        font-size: clamp(10px, min(4.2cqh, 2.9cqw), 68px);
        font-weight: 500;
        color: var(--tc-color-fg-muted);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .forecast {
        display: flex;
        align-items: stretch;
        gap: min(3cqw, 3cqh);
        min-width: 0;
      }
      .day {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: min(1.2cqh, 1.2cqw);
        min-width: 0;
        padding: 0 min(1.6cqw, 1.6cqh);
      }
      .forecast .day + .day {
        border-left: var(--tc-stroke) solid var(--tc-color-separator);
      }
      .day-name {
        font-size: clamp(10px, min(4.2cqh, 2.9cqw), 68px);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--tc-color-fg-subtle);
        white-space: nowrap;
      }
      .day .icon {
        width: clamp(28px, min(11cqh, 8cqw), 120px);
      }
      .high-low {
        font-size: clamp(11px, min(4.6cqh, 3.2cqw), 76px);
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .high-low .low {
        color: var(--tc-color-fg-muted);
        font-weight: 500;
      }

      /* Portrait: strong current conditions over a stacked forecast. */
      @container tc-widget (orientation: portrait) {
        .weather {
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: min(3cqh, 3cqw);
        }
        .forecast {
          width: 100%;
          justify-content: space-evenly;
        }
      }

      /* Wide strip: one compact line of conditions. */
      @container tc-widget (aspect-ratio > 2.4) {
        .details,
        .place,
        .forecast {
          display: none;
        }
        .weather {
          align-items: center;
        }
        .current {
          gap: min(2cqw, 2cqh);
        }
        .icon {
          width: clamp(32px, 12cqh, 120px);
        }
      }

      /* Small zone: temperature, condition and high/low. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .details,
        .place,
        .forecast {
          display: none;
        }
      }
    `,
  ];

  protected override themeOverrides(config: WeatherConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: WeatherData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const timeZone = this.context.timeZone;
    const number = (
      values: Readonly<Record<string, WidgetValue>>,
      key: string,
    ): string => formatWidgetValue(values[key], data.fields[key], { locale });
    const unit = (
      values: Readonly<Record<string, WidgetValue>>,
      key: string,
    ): string => {
      const value = values[key];
      return typeof value?.text === "string" ? value.text : "";
    };
    const withUnit = (
      values: Readonly<Record<string, WidgetValue>>,
      key: string,
      unitKey: string,
    ): string => {
      const amount = number(values, key);
      if (amount === "") return "";
      const suffix = unit(values, unitKey);
      return suffix === "" ? amount : `${amount} ${suffix}`;
    };
    const currentBlock =
      data.current && this.config.showCurrent
        ? html`<div class="current">
            <div class="icon">
              ${conditionIcon(
                conditionKind(recordText(data.current, "condition")),
              )}
            </div>
            <div>
              <div class="temp">
                ${withUnit(data.current, "temperature", "temperatureUnit")}
              </div>
              <div class="condition">
                ${recordText(data.current, "condition")}
              </div>
              ${
                this.config.showLocation &&
                recordText(data.current, "location") !== ""
                  ? html`<div class="place">
                      ${recordText(data.current, "location")}
                    </div>`
                  : nothing
              }
              <div class="details">
                ${
                  this.config.showHumidity &&
                  number(data.current, "humidity") !== ""
                    ? html`<div class="detail">
                        ${number(data.current, "humidity")}
                      </div>`
                    : nothing
                }
                ${
                  this.config.showWind &&
                  withUnit(data.current, "windSpeed", "windUnit") !== ""
                    ? html`<div class="detail">
                        ${withUnit(data.current, "windSpeed", "windUnit")}
                      </div>`
                    : nothing
                }
                ${
                  this.config.showPrecipitation &&
                  withUnit(
                    data.current,
                    "precipitation",
                    "precipitationUnit",
                  ) !== ""
                    ? html`<div class="detail">
                        ${withUnit(
                          data.current,
                          "precipitation",
                          "precipitationUnit",
                        )}
                      </div>`
                    : nothing
                }
              </div>
            </div>
          </div>`
        : nothing;
    return html`<div class="weather">
      ${currentBlock}
      ${
        data.forecast.length > 0
          ? html`<div class="forecast">
              ${data.forecast.map((day) => {
                const dayMs = Date.parse(recordDay(day, "date"));
                return html`<div class="day">
                  <div class="day-name">
                    ${
                      Number.isNaN(dayMs)
                        ? ""
                        : formatDate(dayMs, {
                            locale,
                            timeZone,
                            style: "weekday",
                          })
                    }
                  </div>
                  <div class="icon">
                    ${conditionIcon(conditionKind(recordText(day, "condition")))}
                  </div>
                  <div class="high-low">
                    ${withUnit(day, "high", "temperatureUnit")}
                    <span class="low">
                      ${withUnit(day, "low", "temperatureUnit")}
                    </span>
                  </div>
                </div>`;
              })}
            </div>`
          : nothing
      }
    </div>`;
  }
}
