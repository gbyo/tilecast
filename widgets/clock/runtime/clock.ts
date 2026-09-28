/**
 * Clock V2: live time or date as the focal point of the Widget.
 *
 * Three modes, one component:
 * - time: the local time. Three faces:
 *   - standard: large hours and minutes, the day period and seconds set
 *     as a quiet column beside them, optional zone caption and date below;
 *   - minimal: the time alone, as large as the box allows;
 *   - analog: a restrained dial with the date and digital time beside it;
 * - date: the local date alone, as large as the box allows;
 * - world: the time in up to eight zones, each with its city and whether
 *   that zone is already on another day.
 *
 * The retired Date and World Clock Widgets are these modes
 * (docs/widgets-v2-catalog.md). Component version 2 added the modes; a
 * version 1 configuration has no mode and is the time mode.
 *
 * Layout is container queries only. The same element becomes a single row
 * in a wide strip, stacks hours over minutes in a tall sidebar, and drops
 * supporting text in a small Layout zone, without measuring anything.
 */
import { css, html, nothing, svg, type TemplateResult } from "lit";
import {
  parseHexColor,
  validTimeZone,
  type ConfigResult,
} from "@tilecast/widget-sdk";
import {
  boundText,
  ClockController,
  formatDate,
  localDayDifference,
  localDayKey,
  relativeDayLabel,
  TilecastWidgetElement,
  timeParts,
  zoneAbbreviation,
  zoneCity,
  type HourCycle,
} from "@tilecast/widget-kit";

export const CLOCK_STYLES = ["standard", "minimal", "analog"] as const;
export type ClockStyle = (typeof CLOCK_STYLES)[number];

export const CLOCK_MODES = ["time", "date", "world"] as const;
export type ClockMode = (typeof CLOCK_MODES)[number];

/** "locale" follows the organization: the full date with the weekday. */
export const DATE_FORMATS = [
  "locale",
  "full",
  "long",
  "medium",
  "short",
] as const;
export type ClockDateFormat = (typeof DATE_FORMATS)[number];

export const MAX_WORLD_ZONES = 8;

export interface WorldZone {
  /** The author label, or "" for the zone's city name. */
  readonly label: string;
  /** An explicit zone, or null for the screen's organization zone. */
  readonly timeZone: string | null;
}

export interface ClockConfig {
  readonly mode: ClockMode;
  /** An explicit zone, or null for the screen's organization zone. */
  readonly timeZone: string | null;
  /** "locale" follows the organization's regional time format. */
  readonly format: "locale" | "12" | "24";
  readonly showSeconds: boolean;
  readonly style: ClockStyle;
  readonly showDate: boolean;
  readonly dateFormat: ClockDateFormat;
  readonly zones: readonly WorldZone[];
  readonly background: string | null;
  readonly foreground: string | null;
}

const FORMATS = ["locale", "12", "24"] as const;

function optionalBoolean(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
}

function parseZones(value: unknown): WorldZone[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_WORLD_ZONES) return null;
  const zones: WorldZone[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    const label = raw["label"] ?? "";
    if (typeof label !== "string" || label.length > 80) return null;
    // Saved World Clock zones name the key "timezone".
    const zone = raw["timeZone"] ?? raw["timezone"] ?? "";
    let timeZone: string | null = null;
    if (zone !== "") {
      timeZone = validTimeZone(zone);
      if (!timeZone) return null;
    }
    zones.push({ label: boundText(label.trim(), 80), timeZone });
  }
  return zones;
}

export function parseClockConfig(value: unknown): ConfigResult<ClockConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  let timeZone: string | null = null;
  if (raw["timeZone"] !== undefined && raw["timeZone"] !== "") {
    timeZone = validTimeZone(raw["timeZone"]);
    if (!timeZone)
      return { ok: false, problem: "timeZone is not a known zone" };
  }
  const format = raw["format"] ?? "locale";
  if (!FORMATS.includes(format as never)) {
    return { ok: false, problem: "format must be locale, 12 or 24" };
  }
  const style = raw["style"] ?? "standard";
  if (!CLOCK_STYLES.includes(style as never)) {
    return { ok: false, problem: "style is not a Clock style" };
  }
  const showSeconds = optionalBoolean(raw["showSeconds"]);
  const showDate = optionalBoolean(raw["showDate"]);
  if (showSeconds === null || showDate === null) {
    return { ok: false, problem: "showSeconds and showDate must be booleans" };
  }
  const mode = raw["mode"] ?? "time";
  if (!CLOCK_MODES.includes(mode as never)) {
    return { ok: false, problem: "mode is not a Clock mode" };
  }
  const dateFormat = raw["dateFormat"] ?? "locale";
  if (!DATE_FORMATS.includes(dateFormat as never)) {
    return { ok: false, problem: "dateFormat is not a date format" };
  }
  const zones = parseZones(raw["zones"]);
  if (zones === null) {
    return { ok: false, problem: "zones must be up to eight labeled zones" };
  }
  return {
    ok: true,
    config: {
      mode: mode as ClockMode,
      timeZone,
      format: format as ClockConfig["format"],
      showSeconds,
      style: style as ClockStyle,
      showDate,
      dateFormat: dateFormat as ClockDateFormat,
      zones,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

/** Sixty dial ticks, built once: every fifth is an hour mark. */
const TICKS = Array.from({ length: 60 }, (_, index) => {
  const major = index % 5 === 0;
  return svg`<line
    class=${major ? "tick major" : "tick minor"}
    x1="100"
    y1=${major ? 11 : 12}
    x2="100"
    y2=${major ? 26 : 18}
    transform=${`rotate(${index * 6} 100 100)`}
  />`;
});

export class TilecastClockWidget extends TilecastWidgetElement<
  ClockConfig,
  null
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .clock {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--tc-gutter);
      }
      .stack {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: min(3.2cqh, 2.4cqw);
        min-width: 0;
        max-width: 100%;
        text-align: center;
      }
      .zone {
        font-size: clamp(11px, min(5cqh, 3cqw), 72px);
        font-weight: 600;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--tc-color-accent);
      }
      .time {
        display: flex;
        align-items: flex-start;
        font-weight: 600;
        line-height: 0.86;
        letter-spacing: -0.045em;
        white-space: nowrap;
        font-size: min(40cqh, 22cqw);
      }
      .time[data-meta] {
        font-size: min(38cqh, 18.5cqw);
      }
      [data-style="minimal"] .time {
        font-size: min(62cqh, 26cqw);
      }
      [data-style="minimal"] .time[data-meta] {
        font-size: min(58cqh, 21cqw);
      }
      .hm {
        display: flex;
        align-items: baseline;
      }
      .sep {
        color: var(--tc-color-fg-subtle);
        padding: 0 0.03em;
        transform: translateY(-0.04em);
      }
      .meta {
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-self: stretch;
        margin-left: 0.14em;
        padding: 0.06em 0 0.04em;
        font-size: 0.29em;
        line-height: 1;
        letter-spacing: 0;
      }
      .period {
        font-weight: 600;
        letter-spacing: 0.06em;
        color: var(--tc-color-fg-muted);
      }
      .seconds {
        margin-top: auto;
        font-weight: 500;
        color: var(--tc-color-fg-subtle);
      }
      .date-short {
        display: none;
      }
      .date {
        font-size: clamp(12px, min(8cqh, 4.6cqw), 140px);
        font-weight: 500;
        line-height: 1.15;
        letter-spacing: -0.01em;
        color: var(--tc-color-fg-muted);
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Analog: dial with supporting text below, or beside it when wide. */
      .analog {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: min(4cqh, 4cqw);
        width: 100%;
        height: 100%;
      }
      .dial {
        flex: none;
        width: min(70cqh, 86cqw);
        height: min(70cqh, 86cqw);
      }
      .face {
        fill: var(--tc-color-surface);
        stroke: var(--tc-color-separator);
        stroke-width: 1.2;
      }
      .tick {
        stroke: var(--tc-color-fg-subtle);
        stroke-width: 1;
        stroke-linecap: round;
      }
      .tick.major {
        stroke: var(--tc-color-fg-muted);
        stroke-width: 3;
      }
      .hand {
        stroke: var(--tc-color-fg);
        stroke-linecap: round;
      }
      .hand.hour {
        stroke-width: 7;
      }
      .hand.minute {
        stroke-width: 4.5;
      }
      .hand.second {
        stroke: var(--tc-color-accent);
        stroke-width: 1.6;
      }
      .cap {
        fill: var(--tc-color-accent);
      }
      .analog .stack {
        gap: min(1.6cqh, 1.6cqw);
      }
      .analog .digital {
        font-size: clamp(14px, min(9cqh, 6cqw), 160px);
        font-weight: 600;
        letter-spacing: -0.02em;
        line-height: 1;
      }
      .analog .date {
        font-size: clamp(12px, min(6cqh, 4cqw), 110px);
      }

      /* Wide strip: one row, sized by height. */
      @container tc-widget (aspect-ratio > 2.4) {
        .stack {
          flex-direction: row;
          align-items: center;
          gap: 5cqh;
        }
        .time {
          font-size: min(66cqh, 24cqw);
        }
        .time[data-meta] {
          font-size: min(62cqh, 20cqw);
        }
        .date,
        .zone {
          font-size: clamp(12px, min(24cqh, 4.4cqw), 140px);
          padding-left: 5cqh;
          border-left: var(--tc-stroke) solid var(--tc-color-separator);
          text-align: left;
        }
        .zone {
          order: -1;
          border-left: 0;
          padding-left: 0;
        }
        .analog {
          flex-direction: row;
          gap: 5cqh;
        }
        .dial {
          width: 84cqh;
          height: 84cqh;
        }
        .analog .stack {
          align-items: flex-start;
          flex-direction: column;
          text-align: left;
        }
        .analog .date,
        .analog .zone {
          border-left: 0;
          padding-left: 0;
        }
      }

      /* Landscape analog: dial left, text right. */
      @container tc-widget (aspect-ratio > 1.3) and (aspect-ratio <= 2.4) {
        .analog {
          flex-direction: row;
          gap: 6cqw;
        }
        .dial {
          width: min(80cqh, 50cqw);
          height: min(80cqh, 50cqw);
        }
        .analog .stack {
          align-items: flex-start;
          text-align: left;
        }
      }

      /* Tall sidebar or portrait screen: hours over minutes. */
      @container tc-widget (aspect-ratio < 0.75) {
        [data-style="standard"] .hm,
        [data-style="minimal"] .hm {
          flex-direction: column;
          align-items: center;
          line-height: 0.92;
        }
        [data-style="standard"] .sep,
        [data-style="minimal"] .sep {
          display: none;
        }
        [data-style="standard"] .time,
        [data-style="minimal"] .time {
          flex-direction: column;
          align-items: center;
          font-size: min(26cqh, 46cqw);
        }
        [data-style="standard"] .meta,
        [data-style="minimal"] .meta {
          flex-direction: row;
          justify-content: center;
          align-self: center;
          gap: 0.6em;
          margin: 0.3em 0 0;
          font-size: 0.2em;
        }
        [data-style="standard"] .seconds,
        [data-style="minimal"] .seconds {
          margin-top: 0;
        }
        .date {
          font-size: clamp(12px, 7cqw, 120px);
          white-space: normal;
        }
      }

      /* Narrow boxes and strips use the short date. */
      @container tc-widget (max-width: 560px) or (aspect-ratio > 2.4) {
        .date-long {
          display: none;
        }
        .date-short {
          display: inline;
        }
      }

      /* Small Layout zone: the time only. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .date,
        .zone,
        .analog .stack {
          display: none;
        }
        .time,
        .time[data-meta] {
          font-size: min(72cqh, 24cqw);
        }
        .dial {
          width: 92cqmin;
          height: 92cqmin;
        }
        .tick.minor {
          display: none;
        }
      }
    `,
    css`
      /* Date mode: the date as the focal point. */
      .date-face {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: min(2.4cqh, 1.8cqw);
        max-width: 100%;
        text-align: center;
      }
      .date-weekday {
        font-size: clamp(12px, min(9cqh, 5.4cqw), 170px);
        font-weight: 600;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--tc-color-accent);
      }
      .date-main {
        font-size: clamp(20px, min(26cqh, 12.5cqw), 520px);
        font-weight: 650;
        line-height: 0.98;
        letter-spacing: -0.035em;
        white-space: nowrap;
      }
      .date-year {
        font-size: clamp(12px, min(9cqh, 5cqw), 160px);
        font-weight: 500;
        color: var(--tc-color-fg-muted);
      }
      .date-face[data-single] .date-main {
        font-size: clamp(20px, min(24cqh, 10.5cqw), 480px);
      }

      /* World mode: one card for each zone. */
      .world {
        --cols: 1;
        --rows: 1;
        display: grid;
        grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
        gap: min(3cqh, 2cqw);
        width: 100%;
        height: 100%;
        align-content: stretch;
      }
      .world[data-count="2"] {
        --cols: 2;
      }
      .world[data-count="3"] {
        --cols: 3;
      }
      .world[data-count="4"] {
        --cols: 2;
        --rows: 2;
      }
      .world[data-count="5"],
      .world[data-count="6"] {
        --cols: 3;
        --rows: 2;
      }
      .world[data-count="7"],
      .world[data-count="8"] {
        --cols: 4;
        --rows: 2;
      }
      .zone-card {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        justify-content: center;
        gap: min(1.2cqh, 0.8cqw);
        min-width: 0;
        padding: min(3.6cqh, 2.4cqw);
        border-radius: var(--tc-radius-l);
        background: var(--tc-color-surface);
      }
      .zone-name {
        max-width: 100%;
        font-size: clamp(11px, calc(min(6.4cqh, 4cqw) / var(--rows)), 96px);
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--tc-color-accent);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .zone-time {
        display: flex;
        align-items: baseline;
        gap: 0.18em;
        font-size: clamp(
          16px,
          min(calc(40cqh / var(--rows)), calc(20cqw / var(--cols))),
          420px
        );
        font-weight: 600;
        line-height: 1;
        letter-spacing: -0.035em;
        white-space: nowrap;
      }
      .zone-time .period,
      .zone-time .zone-seconds {
        font-size: 0.34em;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: var(--tc-color-fg-muted);
      }
      .zone-meta {
        max-width: 100%;
        font-size: clamp(11px, calc(min(7cqh, 4cqw) / var(--rows)), 80px);
        font-weight: 500;
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .zone-meta .day {
        color: var(--tc-color-fg);
        font-weight: 600;
      }

      /* Wide strip: every zone on one line. */
      @container tc-widget (aspect-ratio > 2.4) {
        .world {
          grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
          grid-auto-flow: column;
          --rows: 1;
          --cols: 4;
        }
        .zone-card {
          flex-direction: row;
          align-items: baseline;
          justify-content: center;
          gap: 3cqh;
          padding: 4cqh 3cqh;
          background: transparent;
        }
        .zone-time {
          font-size: clamp(14px, min(46cqh, 7cqw), 200px);
        }
        .zone-name,
        .zone-meta {
          font-size: clamp(11px, min(18cqh, 2.2cqw), 72px);
        }
        .date-face {
          flex-direction: row;
          align-items: baseline;
          gap: 5cqh;
        }
        .date-main,
        .date-face[data-single] .date-main {
          font-size: clamp(16px, min(60cqh, 9cqw), 300px);
        }
        .date-weekday,
        .date-year {
          font-size: clamp(12px, min(26cqh, 3.6cqw), 120px);
        }
      }

      /* Tall sidebar or portrait screen: one zone per row. */
      @container tc-widget (aspect-ratio < 0.75) {
        .world {
          grid-template-columns: minmax(0, 1fr);
          --cols: 1;
          --rows: 4;
        }
        .world[data-count="1"] {
          --rows: 1.6;
        }
        .world[data-count="2"] {
          --rows: 2;
        }
        .world[data-count="3"] {
          --rows: 3;
        }
        .world[data-count="7"],
        .world[data-count="8"] {
          --rows: 6;
        }
        .date-main,
        .date-face[data-single] .date-main {
          font-size: clamp(20px, 17cqw, 400px);
          white-space: normal;
        }
        .date-weekday,
        .date-year {
          font-size: clamp(12px, 8cqw, 150px);
        }
      }

      /* Small Layout zone: the first two zones, time only. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .zone-card:nth-child(n + 3),
        .zone-meta {
          display: none;
        }
        .world {
          --cols: 2;
          --rows: 1;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .zone-card {
          padding: 4cqmin;
        }
        .date-weekday,
        .date-year {
          display: none;
        }
      }
    `,
  ];

  private readonly ticks = new ClockController(this, {
    granularity: () =>
      this.config?.mode !== "date" && this.config?.showSeconds
        ? "second"
        : "minute",
    // A date changes only at local midnight; everything else follows the
    // ticks it asked for.
    key: (now) =>
      this.config?.mode === "date" ? localDayKey(now, this.zone) : String(now),
  });

  protected override themeOverrides(config: ClockConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  private get zone(): string {
    return this.config.timeZone ?? this.context.timeZone;
  }

  private get hourCycle(): HourCycle {
    if (this.config.format === "12") return "h12";
    if (this.config.format === "24") return "h23";
    return this.context.hourCycle;
  }

  /** A caption only when the Clock shows another zone than the screen's. */
  private zoneCaption(): TemplateResult | typeof nothing {
    const zone = this.config.timeZone;
    return zone && zone !== this.context.timeZone
      ? html`<div class="zone">${zoneCity(zone)}</div>`
      : nothing;
  }

  /**
   * Both date lengths are rendered; a container query shows the one that
   * fits, so a strip or sidebar never truncates or orphans a word.
   */
  private dateLine(now: number): TemplateResult | typeof nothing {
    if (!this.config.showDate) return nothing;
    const options = { locale: this.context.locale, timeZone: this.zone };
    return html`<div class="date">
      <span class="date-long"
        >${formatDate(now, { ...options, style: "long" })}</span
      ><span class="date-short"
        >${formatDate(now, { ...options, style: "medium" })}</span
      >
    </div>`;
  }

  protected override renderContent(): TemplateResult {
    const now = this.ticks.now;
    if (this.config.mode === "date") return this.renderDateMode(now);
    if (this.config.mode === "world") return this.renderWorld(now);
    const parts = timeParts(now, {
      locale: this.context.locale,
      timeZone: this.zone,
      hourCycle: this.hourCycle,
    });
    const { style, showSeconds } = this.config;
    if (style === "analog") return this.renderAnalog(now, parts);
    const meta = parts.dayPeriod !== "" || showSeconds;
    return html`<div class="clock" data-style=${style}>
      <div class="stack">
        ${style === "standard" ? this.zoneCaption() : nothing}
        <div class="time tc-numeric" ?data-meta=${meta}>
          <span class="hm"
            ><span>${parts.hour}</span
            ><span class="sep">${parts.separator}</span
            ><span>${parts.minute}</span></span
          >${
            meta
              ? html`<span class="meta"
                  >${
                    parts.dayPeriod
                      ? html`<span class="period">${parts.dayPeriod}</span>`
                      : nothing
                  }${
                    showSeconds
                      ? html`<span class="seconds">${parts.second}</span>`
                      : nothing
                  }</span
                >`
              : nothing
          }
        </div>
        ${style === "standard" ? this.dateLine(now) : nothing}
      </div>
    </div>`;
  }

  private renderDateMode(now: number): TemplateResult {
    const options = { locale: this.context.locale, timeZone: this.zone };
    const format = this.config.dateFormat;
    if (format === "medium" || format === "short") {
      const text = formatDate(now, {
        ...options,
        style: format === "medium" ? "medium-year" : "numeric",
      });
      return html`<div class="clock" data-mode="date">
        <div class="date-face" data-single>
          <div class="date-main tc-numeric">${text}</div>
        </div>
      </div>`;
    }
    return html`<div class="clock" data-mode="date">
      <div class="date-face">
        ${
          format === "long"
            ? nothing
            : html`<div class="date-weekday">
                ${formatDate(now, { ...options, style: "weekday" })}
              </div>`
        }
        <div class="date-main">
          ${formatDate(now, { ...options, style: "day-month" })}
        </div>
        <div class="date-year tc-numeric">
          ${formatDate(now, { ...options, style: "year" })}
        </div>
      </div>
    </div>`;
  }

  private renderWorld(now: number): TemplateResult {
    const zones: readonly WorldZone[] =
      this.config.zones.length > 0
        ? this.config.zones
        : [{ label: "", timeZone: null }];
    const screen = this.context.timeZone;
    const { locale } = this.context;
    return html`<div class="clock" data-mode="world">
      <div class="world" data-count=${String(zones.length)}>
        ${zones.map((zone) => {
          const timeZone = zone.timeZone ?? screen;
          const parts = timeParts(now, {
            locale,
            timeZone,
            hourCycle: this.hourCycle,
          });
          const day = relativeDayLabel(
            localDayDifference(now, timeZone, screen),
            locale,
          );
          const meta = [
            this.config.showDate
              ? formatDate(now, { locale, timeZone, style: "medium" })
              : "",
            zoneAbbreviation(now, { locale, timeZone }),
          ].filter((part) => part !== "");
          return html`<section class="zone-card">
            <div class="zone-name">${zone.label || zoneCity(timeZone)}</div>
            <div class="zone-time tc-numeric">
              <span>${parts.hour}${parts.separator}${parts.minute}</span>${
                parts.dayPeriod
                  ? html`<span class="period">${parts.dayPeriod}</span>`
                  : nothing
              }${
                this.config.showSeconds
                  ? html`<span class="zone-seconds">${parts.second}</span>`
                  : nothing
              }
            </div>
            <div class="zone-meta">
              ${day ? html`<span class="day">${day}</span> · ` : nothing}${meta.join(
                " · ",
              )}
            </div>
          </section>`;
        })}
      </div>
    </div>`;
  }

  private renderAnalog(
    now: number,
    parts: ReturnType<typeof timeParts>,
  ): TemplateResult {
    const { hours, minutes, seconds } = parts.clock;
    const hourAngle = (hours % 12) * 30 + minutes * 0.5;
    const minuteAngle =
      minutes * 6 + (this.config.showSeconds ? seconds * 0.1 : 0);
    const secondAngle = seconds * 6;
    const digital = `${parts.hour}${parts.separator}${parts.minute}${
      parts.dayPeriod ? ` ${parts.dayPeriod}` : ""
    }`;
    return html`<div class="clock" data-style="analog">
      <div class="analog">
        <svg
          class="dial"
          viewBox="0 0 200 200"
          role="img"
          aria-label=${digital}
        >
          <circle class="face" cx="100" cy="100" r="97" />
          ${TICKS}
          <line
            class="hand hour"
            x1="100"
            y1="112"
            x2="100"
            y2="54"
            transform=${`rotate(${hourAngle} 100 100)`}
          />
          <line
            class="hand minute"
            x1="100"
            y1="114"
            x2="100"
            y2="28"
            transform=${`rotate(${minuteAngle} 100 100)`}
          />
          ${
            this.config.showSeconds
              ? svg`<line class="hand second" x1="100" y1="124" x2="100" y2="22"
                transform=${`rotate(${secondAngle} 100 100)`} />`
              : nothing
          }
          <circle class="cap" cx="100" cy="100" r="4.5" />
        </svg>
        <div class="stack">
          ${this.zoneCaption()}
          <div class="digital tc-numeric">${digital}</div>
          ${this.dateLine(now)}
        </div>
      </div>
    </div>`;
  }
}
