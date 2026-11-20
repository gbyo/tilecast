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
 * Three arrangements follow the saved Countdown layouts:
 * - stacked: the title over the units;
 * - horizontal: the title beside the units;
 * - countdown_only: the units alone.
 *
 * Each unit is drawn on a tile, or as plain numbers. Type is sized from
 * the Widget's box and then fitted by measurement, so the numbers are as
 * large as the box allows with any font, and unit labels scale with them
 * instead of shrinking to a fixed caption size. A very small box shows
 * compact labels ("5d 04h") instead of none.
 *
 * The author may choose an organization library font and lower the
 * background opacity so a Layout shows through.
 *
 * This is the Countdown Widget, a content item. It is unrelated to the
 * Countdown Bar plugin, which draws an overlay strip.
 *
 * Time comes only from the corrected Widget clock, once a second when
 * seconds show and once a minute otherwise.
 */
import {
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import {
  empty,
  parseHexColor,
  ready,
  validTimeZone,
  type ConfigResult,
  type WidgetResolution,
  type WidgetResources,
} from "@tilecast/widget-sdk";
import {
  boundText,
  ClockController,
  FitController,
  mixColors,
  TilecastWidgetElement,
  withAlpha,
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

export const SEGMENT_STYLES = ["tiles", "plain"] as const;
export type SegmentStyle = (typeof SEGMENT_STYLES)[number];

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

const FONT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  readonly segmentStyle: SegmentStyle;
  readonly label: string;
  readonly completionText: string;
  readonly completionAction: CompletionAction;
  readonly units: Readonly<Record<CountdownUnit, boolean>>;
  readonly background: string | null;
  readonly foreground: string | null;
  /** Background paint opacity, from 0 (transparent) to 1. */
  readonly backgroundOpacity: number;
  /** An organization library font ID, or null for the bundled face. */
  readonly fontId: string | null;
}

/** What resolution hands the element: the registered library family. */
export interface CountdownData {
  readonly font: string | null;
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
  const segmentStyle = oneOf(raw["segmentStyle"], SEGMENT_STYLES, "tiles");
  const completionAction = oneOf(
    raw["completionAction"],
    COMPLETION_ACTIONS,
    "completed_text",
  );
  if (!mode || !recurrence || !style || !segmentStyle || !completionAction) {
    return {
      ok: false,
      problem: "mode, recurrence, style and completion must be known values",
    };
  }
  const opacity = raw["backgroundOpacity"] ?? 100;
  if (
    typeof opacity !== "number" ||
    !Number.isInteger(opacity) ||
    opacity < 0 ||
    opacity > 100
  ) {
    return {
      ok: false,
      problem: "background opacity must be a whole number from 0 to 100",
    };
  }
  const fontId = raw["fontId"] ?? "";
  if (typeof fontId !== "string" || (fontId !== "" && !FONT_ID.test(fontId))) {
    return { ok: false, problem: "fontId must identify a library font" };
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
      segmentStyle,
      label: boundText(label.trim(), 120),
      completionText: boundText(completionText.trim(), 240),
      completionAction,
      units: visible,
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
      backgroundOpacity: opacity / 100,
      fontId: fontId === "" ? null : fontId.toLowerCase(),
    },
  };
}

/**
 * Without a target there is nothing to count: an expected empty state.
 * Otherwise the only resource is the chosen library font, when the
 * presentation declares it and the host registered its faces.
 */
export function resolveCountdownData(
  config: CountdownConfig,
  resources?: WidgetResources,
): WidgetResolution<CountdownData> {
  if (config.target === "") return empty("no_target");
  const font = config.fontId
    ? (resources?.font?.(config.fontId) ?? null)
    : null;
  return ready({ font });
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

function unitParts(
  unit: CountdownUnit,
  value: number,
  locale: string,
  display: "long" | "narrow",
): string {
  const key = `${locale}|${unit}|${display}`;
  let format = unitFormats.get(key);
  if (!format) {
    if (unitFormats.size >= 64) unitFormats.clear();
    const options = { style: "unit", unit, unitDisplay: display } as const;
    try {
      format = new Intl.NumberFormat(locale, options);
    } catch {
      format = new Intl.NumberFormat("en-US", options);
    }
    unitFormats.set(key, format);
  }
  return format
    .formatToParts(value)
    .filter((part) => part.type === "unit")
    .map((part) => part.value)
    .join(" ")
    .trim();
}

/** The plural unit word for a value in the screen locale ("days", "días"). */
export function unitLabel(
  unit: CountdownUnit,
  value: number,
  locale: string,
): string {
  return unitParts(unit, value, locale, "long");
}

/** The compact unit for a small box in the screen locale ("d", "ч"). */
export function shortUnitLabel(
  unit: CountdownUnit,
  value: number,
  locale: string,
): string {
  return unitParts(unit, value, locale, "narrow");
}

/*
 * Sizing. A tile is about 1.8 em wide for two digits and 1.6 em tall with
 * its label, so the value size is the smaller of what the width allows for
 * `--n` tiles and what the height allows. FitController then scales
 * everything down by --tc-fit only when a wide font or a long title would
 * still overflow.
 */
const styles = css`
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
    --fit: var(--tc-fit, 1);
    --value: min(calc(90cqw / (var(--n) * 1.8)), 44cqh);
    --title: clamp(16px, min(10cqh, 6.4cqw), 200px);
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: calc(var(--fit) * clamp(6px, 4.5cqh, 80px));
    overflow: hidden;
    text-align: center;
  }
  .frame[data-count="1"] {
    --n: 1.3;
  }
  .frame[data-count="2"] {
    --n: 2;
  }
  .frame[data-count="4"] {
    --n: 4;
  }
  [data-style="countdown_only"] .frame {
    --value: min(calc(94cqw / (var(--n) * 1.8)), 58cqh);
  }

  .title {
    max-width: 100%;
    font-size: calc(var(--fit) * var(--title));
    font-weight: 650;
    line-height: 1.1;
    letter-spacing: -0.015em;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }

  .segments {
    display: grid;
    grid-auto-flow: column;
    /* Never narrower than its digits, so an overflow reaches the fit. */
    grid-auto-columns: auto;
    justify-content: center;
    align-items: stretch;
    gap: 0.12em;
    font-size: calc(var(--fit) * var(--value));
    line-height: 1;
  }
  .segment {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 1.6em;
    padding: 0.14em 0.2em 0.16em;
    border-radius: 0.16em;
    background: var(--countdown-tile);
    box-shadow: inset 0 0 0 max(1px, 0.008em) var(--countdown-tile-edge);
  }
  .value {
    font-size: 1em;
    font-weight: 700;
    line-height: 0.95;
    letter-spacing: -0.03em;
    white-space: nowrap;
  }
  .unit {
    margin-top: 0.42em;
    font-size: max(12px, 0.2em);
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--tc-color-fg-muted);
  }
  .unit-short {
    display: none;
    font-size: 0.5em;
    font-weight: 600;
    margin-inline-start: 0.06em;
    color: var(--tc-color-fg-muted);
  }

  /* Plain numbers: no tiles, a little more room for each digit. */
  [data-segments="plain"] .frame {
    --value: min(calc(90cqw / (var(--n) * 1.75)), 46cqh);
  }
  [data-segments="plain"][data-style="countdown_only"] .frame {
    --value: min(calc(94cqw / (var(--n) * 1.75)), 60cqh);
  }
  [data-segments="plain"] .segments {
    gap: 0.5em;
  }
  [data-segments="plain"] .segment {
    min-width: 0;
    padding: 0;
    background: none;
    box-shadow: none;
  }
  [data-segments="plain"] .unit {
    margin-top: 0.3em;
    font-size: max(12px, 0.22em);
  }
  /* Over a Layout, plain numbers keep a soft edge for photographs. */
  [data-segments="plain"][data-translucent] .segments,
  [data-segments="plain"][data-translucent] .title,
  [data-translucent] .complete {
    text-shadow: 0 0.02em 0.12em var(--countdown-shadow);
  }

  .complete {
    max-width: 100%;
    font-size: calc(var(--fit) * clamp(20px, min(22cqh, 10cqw), 440px));
    font-weight: 700;
    line-height: 1.05;
    letter-spacing: -0.03em;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .complete-title {
    font-size: calc(var(--fit) * clamp(14px, min(7cqh, 4cqw), 120px));
    font-weight: 650;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--tc-color-accent);
  }

  /* Side by side: the title beside the units. */
  [data-style="horizontal"] .frame {
    --value: min(calc(56cqw / (var(--n) * 1.8)), 52cqh);
    --title: clamp(16px, min(13cqh, 4.6cqw), 200px);
    flex-direction: row;
    gap: calc(var(--fit) * clamp(10px, 4cqw, 96px));
  }
  [data-segments="plain"][data-style="horizontal"] .frame {
    --value: min(calc(56cqw / (var(--n) * 1.75)), 56cqh);
  }
  [data-style="horizontal"] .title {
    flex: 0 1 auto;
    max-width: 40%;
    text-align: start;
  }

  /* Wide strip: one line, title first. */
  @container tc-widget (aspect-ratio > 3.2) {
    .frame,
    [data-style="horizontal"] .frame {
      --value: min(calc(66cqw / (var(--n) * 1.8)), 56cqh);
      --title: clamp(14px, min(30cqh, 3.6cqw), 140px);
      flex-direction: row;
      gap: calc(var(--fit) * clamp(10px, 3cqw, 80px));
    }
    [data-style="countdown_only"] .frame {
      --value: min(calc(90cqw / (var(--n) * 1.8)), 60cqh);
    }
    [data-segments="plain"] .frame {
      --value: min(calc(66cqw / (var(--n) * 1.75)), 58cqh);
    }
    .title {
      flex: 0 1 auto;
      max-width: 36%;
      text-align: start;
    }
  }

  /* Portrait or tall sidebar: units in two columns. */
  @container tc-widget (aspect-ratio < 0.75) {
    .frame,
    [data-style="horizontal"] .frame,
    [data-style="countdown_only"] .frame {
      --value: min(calc(88cqw / 3.7), 24cqh);
      --title: clamp(16px, 9cqw, 180px);
      flex-direction: column;
    }
    .frame[data-count="1"],
    [data-style] .frame[data-count="1"] {
      --value: min(calc(88cqw / 2.4), 34cqh);
    }
    [data-segments="plain"] .frame {
      --value: min(calc(88cqw / 3.4), 26cqh);
    }
    [data-style="horizontal"] .title {
      max-width: 100%;
      text-align: center;
    }
    .segments {
      grid-auto-flow: row;
      grid-template-columns: repeat(2, auto);
      gap: 0.16em;
    }
    .frame[data-count="1"] .segments {
      grid-template-columns: auto;
    }
    .frame[data-count="3"] .segment:first-child {
      grid-column: 1 / -1;
    }
  }

  /* A small Layout zone: numbers with compact units, no title. */
  @container tc-widget (max-height: 150px) or (max-width: 220px) {
    .frame {
      --value: min(calc(92cqw / (var(--n) * 1.9)), 62cqh);
    }
    .title,
    .complete-title,
    .unit {
      display: none;
    }
    .unit-short {
      display: inline;
    }
    .segment {
      flex-direction: row;
      align-items: baseline;
      padding: 0.08em 0.14em;
      min-width: 0;
    }
    .frame {
      gap: 0;
    }
  }
`;

export class TilecastCountdownWidget extends TilecastWidgetElement<
  CountdownConfig,
  CountdownData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    styles,
  ];

  private readonly ticks = new ClockController(this, {
    granularity: () => (this.config?.units.second ? "second" : "minute"),
  });

  // Fits the whole arrangement so a long title or a wide library font
  // never overflows; legibility floor is 35 % of the box-derived size.
  private readonly fitter = new FitController(this, {
    target: () => this.renderRoot?.querySelector<HTMLElement>(".frame"),
    minimum: 0.35,
  });

  private reading: CountdownReading | null = null;
  private appliedTile = "";

  protected override themeOverrides(config: CountdownConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override backgroundOpacity(config: CountdownConfig): number {
    return config.backgroundOpacity;
  }

  protected override libraryFont(): string | null {
    return this.data?.font ?? null;
  }

  private get zone(): string {
    return this.config.timeZone ?? this.context.timeZone;
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has("config") || changed.has("context")) this.applyTile();
  }

  /*
   * A tile keeps its own surface when the background is translucent, so
   * numbers over a photograph stay readable: at full opacity it is the
   * raised surface, and it never drops below 60 % opacity.
   */
  private applyTile(): void {
    if (!this.config || !this.context) return;
    const { background, foreground } = this.theme;
    const opacity = this.config.backgroundOpacity;
    const key = `${background}${foreground}${opacity}`;
    if (key === this.appliedTile) return;
    this.appliedTile = key;
    const surface = mixColors(background, foreground, 0.1);
    this.style.setProperty(
      "--countdown-tile",
      withAlpha(surface, 0.6 + 0.4 * opacity),
    );
    this.style.setProperty(
      "--countdown-tile-edge",
      withAlpha(foreground, 0.08),
    );
    this.style.setProperty("--countdown-shadow", withAlpha(background, 0.55));
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
    const { style, label, segmentStyle } = this.config;
    const translucent = this.config.backgroundOpacity < 1;
    const showTitle = style !== "countdown_only" && label !== "";
    if (reading.phase !== "counting") {
      return html`<div
        class="countdown"
        data-style=${style}
        data-segments=${segmentStyle}
        ?data-translucent=${translucent}
      >
        <div class="frame" data-phase="complete">
          ${
            showTitle
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
    return html`<div
      class="countdown"
      data-style=${style}
      data-segments=${segmentStyle}
      ?data-translucent=${translucent}
    >
      <div
        class="frame"
        data-phase="counting"
        data-direction=${reading.direction}
        data-count=${String(reading.segments.length)}
      >
        ${showTitle ? html`<div class="title">${label}</div>` : nothing}
        <div class="segments" role="timer" aria-label=${spoken}>
          ${reading.segments.map(
            (segment, index) =>
              html`<div class="segment" data-unit=${segment.unit}>
                <span class="value tc-numeric"
                  >${
                    index === 0
                      ? String(segment.value)
                      : String(segment.value).padStart(2, "0")
                  }</span
                ><span class="unit-short" aria-hidden="true"
                  >${shortUnitLabel(segment.unit, segment.value, locale)}</span
                ><span class="unit" aria-hidden="true"
                  >${unitLabel(segment.unit, segment.value, locale)}</span
                >
              </div>`,
          )}
        </div>
      </div>
    </div>`;
  }
}
