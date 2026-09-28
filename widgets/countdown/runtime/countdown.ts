/**
 * Countdown V2: the time left until, or since, a moment.
 *
 * The author gives a local date and time and its zone, and chooses to
 * count down or up, whether a count down repeats, and what happens when a
 * one-time count down ends: show a completion message, hide the Widget's
 * content, or keep counting up. The visible units are chosen too; a
 * hidden larger unit folds into the next visible one, so hiding days
 * shows "52 hours" rather than dropping two days.
 *
 * Three styles follow the saved Countdown layouts:
 * - stacked: the title over large unit segments;
 * - horizontal: the title beside the segments;
 * - countdown_only: the segments alone.
 *
 * This is the Countdown Widget, a content item. It is unrelated to the
 * Countdown Bar plugin, which draws an overlay strip.
 *
 * Time comes only from the corrected Widget clock, once a second when
 * seconds show and once a minute otherwise.
 */
import { css, html, nothing, type TemplateResult } from "lit";
import {
  empty,
  parseHexColor,
  ready,
  validTimeZone,
  type ConfigResult,
  type WidgetResolution,
} from "@tilecast/widget-sdk";
import {
  boundText,
  ClockController,
  TilecastWidgetElement,
} from "@tilecast/widget-kit";
import {
  resolveCountdownTarget,
  type CountdownRecurrence,
} from "./schedule.ts";

export const COUNTDOWN_MODES = ["countdown", "count_up"] as const;
export type CountdownMode = (typeof COUNTDOWN_MODES)[number];

export const RECURRENCES = [
  "none",
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;

export const COUNTDOWN_STYLES = [
  "stacked",
  "horizontal",
  "countdown_only",
] as const;
export type CountdownStyle = (typeof COUNTDOWN_STYLES)[number];

export const COMPLETION_ACTIONS = [
  "completed_text",
  "hide",
  "count_up",
] as const;
export type CompletionAction = (typeof COMPLETION_ACTIONS)[number];

export const UNITS = ["day", "hour", "minute", "second"] as const;
export type CountdownUnit = (typeof UNITS)[number];

const UNIT_MS: Record<CountdownUnit, number> = {
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000,
};

const LOCAL_TARGET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const INSTANT_TARGET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export interface CountdownConfig {
  /** A local date and time, or an RFC 3339 instant; "" is not set yet. */
  readonly target: string;
  /** An explicit zone, or null for the screen's organization zone. */
  readonly timeZone: string | null;
  readonly mode: CountdownMode;
  readonly recurrence: CountdownRecurrence;
  readonly style: CountdownStyle;
  readonly label: string;
  readonly completionText: string;
  readonly completionAction: CompletionAction;
  readonly units: Readonly<Record<CountdownUnit, boolean>>;
  readonly background: string | null;
  readonly foreground: string | null;
}

function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
  fallback: T,
): T | null {
  if (value === undefined || value === null || value === "") return fallback;
  return options.includes(value as T) ? (value as T) : null;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

export function parseCountdownConfig(
  value: unknown,
): ConfigResult<CountdownConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const target = raw["target"] ?? "";
  if (
    typeof target !== "string" ||
    (target !== "" &&
      !LOCAL_TARGET.test(target) &&
      !INSTANT_TARGET.test(target))
  ) {
    return { ok: false, problem: "target must be a date and time" };
  }
  let timeZone: string | null = null;
  if (raw["timeZone"] !== undefined && raw["timeZone"] !== "") {
    timeZone = validTimeZone(raw["timeZone"]);
    if (!timeZone)
      return { ok: false, problem: "timeZone is not a known zone" };
  }
  const mode = oneOf(raw["mode"], COUNTDOWN_MODES, "countdown");
  const recurrence = oneOf(raw["recurrence"], RECURRENCES, "none");
  const style = oneOf(raw["style"], COUNTDOWN_STYLES, "stacked");
  const completionAction = oneOf(
    raw["completionAction"],
    COMPLETION_ACTIONS,
    "completed_text",
  );
  if (!mode || !recurrence || !style || !completionAction) {
    return {
      ok: false,
      problem: "mode, recurrence, style and completion must be known values",
    };
  }
  const units = {
    day: optionalBoolean(raw["showDays"], true),
    hour: optionalBoolean(raw["showHours"], true),
    minute: optionalBoolean(raw["showMinutes"], true),
    second: optionalBoolean(raw["showSeconds"], false),
  };
  if (Object.values(units).some((unit) => unit === null)) {
    return { ok: false, problem: "unit choices must be booleans" };
  }
  const label = raw["label"] ?? "";
  const completionText = raw["completionText"] ?? "";
  if (
    typeof label !== "string" ||
    typeof completionText !== "string" ||
    label.length > 120 ||
    completionText.length > 240
  ) {
    return {
      ok: false,
      problem: "title and completion text must fit their length limits",
    };
  }
  const visible = units as Record<CountdownUnit, boolean>;
  // A Countdown with no visible unit would show nothing; the saved
  // Countdown rule shows days, hours and minutes instead.
  if (!UNITS.some((unit) => visible[unit])) {
    visible.day = visible.hour = visible.minute = true;
  }
  return {
    ok: true,
    config: {
      target,
      timeZone,
      mode,
      // Only a count down repeats; the saved rule refused anything else.
      recurrence: mode === "countdown" ? recurrence : "none",
      style,
      label: boundText(label.trim(), 120),
      completionText: boundText(completionText.trim(), 240),
      completionAction,
      units: visible,
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

/** Without a target there is nothing to count: an expected empty state. */
export function resolveCountdownData(
  config: CountdownConfig,
): WidgetResolution<null> {
  if (config.target === "") return empty("no_target");
  return ready(null);
}

export interface CountdownSegment {
  readonly unit: CountdownUnit;
  readonly value: number;
}

export type CountdownReading =
  | {
      readonly phase: "counting";
      readonly direction: "down" | "up";
      readonly segments: readonly CountdownSegment[];
    }
  | { readonly phase: "complete" }
  | { readonly phase: "hidden" };

/**
 * Split a duration into the visible units. The first visible unit takes
 * every larger unit; values are floored, so a count down reads zero only
 * at its target. A leading zero-day segment is left out, as it always was.
 */
export function segmentsFor(
  durationMs: number,
  units: Readonly<Record<CountdownUnit, boolean>>,
): CountdownSegment[] {
  let rest = Math.max(0, durationMs);
  const visible = UNITS.filter((unit) => units[unit]);
  const segments = visible.map((unit) => {
    const value = Math.floor(rest / UNIT_MS[unit]);
    rest -= value * UNIT_MS[unit];
    return { unit, value };
  });
  if (segments.length > 1 && segments[0]!.unit === "day") {
    if (segments[0]!.value === 0) segments.shift();
  }
  return segments;
}

/** What a Countdown shows at `nowMs` in `timeZone`. */
export function readCountdown(
  config: CountdownConfig,
  nowMs: number,
  timeZone: string,
): CountdownReading {
  const target = resolveCountdownTarget(
    config.target,
    timeZone,
    config.recurrence,
    new Date(nowMs),
  );
  if (target === null) return { phase: "complete" };
  if (config.mode === "count_up") {
    return {
      phase: "counting",
      direction: "up",
      segments: segmentsFor(nowMs - target, config.units),
    };
  }
  const remaining = target - nowMs;
  if (remaining > 0) {
    // A count down shows the time left rounded up to its smallest visible
    // unit, so it reads 1 second until the target, never 0 before it.
    const smallest =
      UNIT_MS[UNITS.filter((unit) => config.units[unit]).at(-1)!];
    return {
      phase: "counting",
      direction: "down",
      segments: segmentsFor(
        Math.ceil(remaining / smallest) * smallest,
        config.units,
      ),
    };
  }
  if (config.completionAction === "hide") return { phase: "hidden" };
  if (config.completionAction === "count_up") {
    return {
      phase: "counting",
      direction: "up",
      segments: segmentsFor(-remaining, config.units),
    };
  }
  return { phase: "complete" };
}

const unitFormats = new Map<string, Intl.NumberFormat>();

/** The plural unit word for a value in the screen locale ("days", "días"). */
export function unitLabel(
  unit: CountdownUnit,
  value: number,
  locale: string,
): string {
  const key = `${locale}|${unit}`;
  let format = unitFormats.get(key);
  if (!format) {
    if (unitFormats.size >= 32) unitFormats.clear();
    try {
      format = new Intl.NumberFormat(locale, {
        style: "unit",
        unit,
        unitDisplay: "long",
      });
    } catch {
      format = new Intl.NumberFormat("en-US", {
        style: "unit",
        unit,
        unitDisplay: "long",
      });
    }
    unitFormats.set(key, format);
  }
  return format
    .formatToParts(value)
    .filter((part) => part.type === "unit")
    .map((part) => part.value)
    .join(" ");
}

export class TilecastCountdownWidget extends TilecastWidgetElement<
  CountdownConfig,
  null
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .countdown {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--tc-gutter);
      }
      .frame {
        --n: 3;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: min(5cqh, 3cqw);
        max-width: 100%;
        min-width: 0;
        text-align: center;
      }
      .frame[data-count="1"] {
        --n: 1.6;
      }
      .frame[data-count="2"] {
        --n: 2;
      }
      .frame[data-count="4"] {
        --n: 4;
      }
      .title {
        max-width: 100%;
        font-size: clamp(14px, min(8cqh, 5cqw), 180px);
        font-weight: 650;
        line-height: 1.12;
        letter-spacing: -0.015em;
        text-wrap: balance;
        overflow-wrap: anywhere;
      }
      .segments {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        gap: min(3cqh, calc(8cqw / var(--n)));
      }
      .segment {
        display: flex;
        flex-direction: column;
        align-items: center;
        min-width: 0;
      }
      .value {
        font-size: clamp(
          24px,
          min(38cqh, calc(62cqw / var(--n) / 1.25)),
          620px
        );
        font-weight: 650;
        line-height: 0.92;
        letter-spacing: -0.04em;
      }
      .unit {
        margin-top: 0.5em;
        font-size: clamp(11px, min(4.6cqh, calc(9cqw / var(--n))), 84px);
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--tc-color-fg-muted);
      }
      .separator {
        font-size: clamp(
          24px,
          min(38cqh, calc(62cqw / var(--n) / 1.25)),
          620px
        );
        line-height: 0.92;
        font-weight: 400;
        color: var(--tc-color-fg-subtle);
      }
      .complete {
        max-width: 100%;
        font-size: clamp(20px, min(20cqh, 10cqw), 420px);
        font-weight: 650;
        line-height: 1.05;
        letter-spacing: -0.03em;
        text-wrap: balance;
        overflow-wrap: anywhere;
      }
      .complete-title {
        font-size: clamp(12px, min(5cqh, 3cqw), 96px);
        font-weight: 650;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--tc-color-accent);
      }

      /* Horizontal: the title beside the segments. */
      [data-style="horizontal"] .frame {
        flex-direction: row;
        align-items: center;
        gap: min(6cqh, 4cqw);
        text-align: start;
      }
      [data-style="horizontal"] .title {
        max-width: 34%;
        font-size: clamp(14px, min(9cqh, 4.4cqw), 180px);
      }
      [data-style="horizontal"] .value,
      [data-style="horizontal"] .separator {
        font-size: clamp(
          22px,
          min(30cqh, calc(44cqw / var(--n) / 1.25)),
          520px
        );
      }

      /* Wide strip: one line, units read as small suffixes. */
      @container tc-widget (aspect-ratio > 3.2) {
        .frame,
        [data-style="horizontal"] .frame {
          flex-direction: row;
          align-items: center;
          gap: 5cqh;
        }
        .title,
        [data-style="horizontal"] .title {
          max-width: 36%;
          font-size: clamp(12px, 30cqh, 120px);
        }
        .segment {
          flex-direction: row;
          align-items: baseline;
          gap: 0.3em;
        }
        .value,
        .separator,
        [data-style="horizontal"] .value,
        [data-style="horizontal"] .separator {
          font-size: clamp(16px, min(62cqh, calc(40cqw / var(--n))), 260px);
        }
        .unit {
          margin-top: 0;
          font-size: clamp(10px, 16cqh, 64px);
        }
        .separator {
          display: none;
        }
      }

      /* Portrait or tall sidebar: segments in two columns. */
      @container tc-widget (aspect-ratio < 0.75) {
        [data-style="horizontal"] .frame {
          flex-direction: column;
          text-align: center;
        }
        [data-style="horizontal"] .title {
          max-width: 100%;
        }
        .segments {
          display: grid;
          grid-template-columns: repeat(2, auto);
          gap: 5cqh 8cqw;
        }
        .frame[data-count="1"] .segments {
          grid-template-columns: auto;
        }
        .frame[data-count="3"] .segments .segment:first-child {
          grid-column: 1 / -1;
        }
        .separator {
          display: none;
        }
        .value,
        [data-style="horizontal"] .value {
          font-size: clamp(24px, 30cqw, 420px);
        }
        .unit {
          font-size: clamp(11px, 5.4cqw, 84px);
        }
        .title {
          font-size: clamp(14px, 8cqw, 160px);
        }
      }

      /* Small Layout zone: the numbers only. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .title,
        .complete-title,
        .unit {
          display: none;
        }
        .frame {
          gap: 0;
        }
      }
    `,
  ];

  private readonly ticks = new ClockController(this, {
    granularity: () => (this.config?.units.second ? "second" : "minute"),
  });

  private reading: CountdownReading | null = null;

  protected override themeOverrides(config: CountdownConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  private get zone(): string {
    return this.config.timeZone ?? this.context.timeZone;
  }

  protected override presentationState() {
    if (this.empty === null && this.reading?.phase === "hidden") {
      return { state: "empty" as const, reason: "completed" };
    }
    return super.presentationState();
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (reason === "completed") return html``;
    return super.renderEmpty(reason);
  }

  protected override render(): TemplateResult {
    // The reading decides both what renders and the reported state, so it
    // is computed once for each render from the Widget clock.
    this.reading =
      this.empty === null
        ? readCountdown(this.config, this.ticks.now, this.zone)
        : null;
    if (this.reading?.phase === "hidden") {
      return html`<div class="tc-root" part="root"></div>`;
    }
    return super.render();
  }

  protected override renderContent(): TemplateResult {
    const reading =
      this.reading ?? readCountdown(this.config, this.ticks.now, this.zone);
    const { style, label } = this.config;
    const title =
      style !== "countdown_only" && label
        ? html`<div class="title">${label}</div>`
        : nothing;
    if (reading.phase !== "counting") {
      return html`<div class="countdown" data-style=${style}>
        <div class="frame" data-phase="complete">
          ${
            style !== "countdown_only" && label
              ? html`<div class="complete-title">${label}</div>`
              : nothing
          }
          <div class="complete">
            ${this.config.completionText || "Complete"}
          </div>
        </div>
      </div>`;
    }
    const locale = this.context.locale;
    const spoken = reading.segments
      .map(
        (segment) =>
          `${segment.value} ${unitLabel(segment.unit, segment.value, locale)}`,
      )
      .join(" ");
    return html`<div class="countdown" data-style=${style}>
      <div
        class="frame"
        data-phase="counting"
        data-direction=${reading.direction}
        data-count=${String(reading.segments.length)}
      >
        ${title}
        <div class="segments" role="timer" aria-label=${spoken}>
          ${reading.segments.map(
            (segment, index) =>
              html`${
                  index > 0
                    ? html`<span class="separator" aria-hidden="true">:</span>`
                    : nothing
                }
                <div class="segment">
                  <span class="value tc-numeric"
                    >${
                      index === 0
                        ? String(segment.value)
                        : String(segment.value).padStart(2, "0")
                    }</span
                  ><span class="unit"
                    >${unitLabel(segment.unit, segment.value, locale)}</span
                  >
                </div>`,
          )}
        </div>
      </div>
    </div>`;
  }
}
