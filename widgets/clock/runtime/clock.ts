/**
 * Clock V2: live time as the focal point of the Widget.
 *
 * Three styles:
 * - standard: large hours and minutes, the day period and seconds set as a
 *   quiet column beside them, optional zone caption and date below;
 * - minimal: the time alone, as large as the box allows;
 * - analog: a restrained dial with the date and digital time beside it.
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
  ClockController,
  formatDate,
  TilecastWidgetElement,
  timeParts,
  zoneCity,
  type HourCycle,
} from "@tilecast/widget-kit";

export const CLOCK_STYLES = ["standard", "minimal", "analog"] as const;
export type ClockStyle = (typeof CLOCK_STYLES)[number];

export interface ClockConfig {
  /** An explicit zone, or null for the screen's organization zone. */
  readonly timeZone: string | null;
  /** "locale" follows the organization's regional time format. */
  readonly format: "locale" | "12" | "24";
  readonly showSeconds: boolean;
  readonly style: ClockStyle;
  readonly showDate: boolean;
  readonly background: string | null;
  readonly foreground: string | null;
}

const FORMATS = ["locale", "12", "24"] as const;

function optionalBoolean(value: unknown): boolean | null {
  if (value === undefined) return false;
  return typeof value === "boolean" ? value : null;
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
  return {
    ok: true,
    config: {
      timeZone,
      format: format as ClockConfig["format"],
      showSeconds,
      style: style as ClockStyle,
      showDate,
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
  ];

  private readonly ticks = new ClockController(this, {
    granularity: () => (this.config?.showSeconds ? "second" : "minute"),
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
