/**
 * Agenda V2: upcoming events grouped by local day.
 *
 * The author connects a calendar or records source and maps its fields
 * onto title, start, end, location, description and category slots
 * (suggested automatically from semantic roles). The component owns all
 * local display-time behavior: the now treatment, day grouping, relative
 * status, removal of ended items, midnight rollover and DST correctness.
 * The Data Source owns fetching; Agenda only ever reads the corrected
 * Widget clock, so a disconnected Player reevaluates from the same time
 * as a connected one.
 *
 * A ClockController wakes the element once a minute for Agenda and once a
 * second only when Schedule Board shows a live countdown.
 */
import { css, html, nothing, type TemplateResult } from "lit";
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
  ClockController,
  formatDate,
  formatTime,
  formatWidgetValue,
  localDayKey,
  TilecastWidgetElement,
  emptyState,
  type HourCycle,
} from "@tilecast/widget-kit";

export const AGENDA_STYLES = ["agenda", "now-next", "schedule-board"] as const;
export type AgendaStyle = (typeof AGENDA_STYLES)[number];

export interface AgendaConfig {
  readonly dataSourceId: string;
  readonly titleField: string;
  readonly startField: string;
  readonly endField: string;
  readonly locationField: string;
  readonly descriptionField: string;
  readonly categoryField: string;
  readonly heading: string;
  readonly style: AgendaStyle;
  readonly nowLabel: string;
  readonly nextLabel: string;
  readonly maximumItems: number;
  readonly upcomingCount: number;
  readonly showCountdown: boolean;
  readonly showUpcomingTimeline: boolean;
  readonly groupByDay: boolean;
  readonly hideEnded: boolean;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
  readonly accent: string | null;
}

export interface AgendaEvent {
  readonly id: string;
  readonly values: Readonly<Record<string, WidgetValue>>;
  /** Start instant, Unix milliseconds. Events without one never resolve. */
  readonly startMs: number;
  /** End instant, or null when the source gives none. */
  readonly endMs: number | null;
}

export interface AgendaData {
  readonly events: readonly AgendaEvent[];
  readonly fields: Readonly<Record<string, WidgetField>>;
  readonly total: number;
  /** Legacy now-and-next records with no usable time mapping retain source order. */
  readonly sourceOrderFallback: boolean;
}

const MAX_FIELD_LENGTH = 120;

function fieldRef(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

/** Read one event instant from a date or datetime value. */
export function eventInstant(
  value: WidgetValue | null | undefined,
): number | null {
  if (!value) return null;
  const raw =
    typeof value.datetime === "string"
      ? value.datetime
      : typeof value.date === "string"
        ? value.date
        : null;
  if (raw === null) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

export function parseAgendaConfig(value: unknown): ConfigResult<AgendaConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200)
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  const titleField = fieldRef(raw["titleField"]);
  const startField = fieldRef(raw["startField"]);
  const endField = fieldRef(raw["endField"]);
  const locationField = fieldRef(raw["locationField"]);
  const descriptionField = fieldRef(raw["descriptionField"]);
  const categoryField = fieldRef(raw["categoryField"]);
  if (
    titleField === null ||
    startField === null ||
    endField === null ||
    locationField === null ||
    descriptionField === null ||
    categoryField === null
  ) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const heading = boundText(raw["heading"] ?? "", 120);
  const style = raw["style"] ?? "agenda";
  if (!AGENDA_STYLES.includes(style as AgendaStyle)) {
    return {
      ok: false,
      problem: "style must be agenda, now-next, or schedule-board",
    };
  }
  const nowLabel = boundText(raw["nowLabel"] ?? "Now", 80);
  const nextLabel = boundText(raw["nextLabel"] ?? "Next", 80);
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  const maximumItems = raw["maximumItems"] ?? 20;
  if (
    typeof maximumItems !== "number" ||
    !Number.isInteger(maximumItems) ||
    maximumItems < 1 ||
    maximumItems > 100
  ) {
    return {
      ok: false,
      problem: "maximumItems must be an integer from 1 to 100",
    };
  }
  const groupByDay = optionalBoolean(raw["groupByDay"], true);
  if (groupByDay === null) {
    return { ok: false, problem: "groupByDay must be a boolean" };
  }
  const hideEnded = optionalBoolean(raw["hideEnded"], true);
  if (hideEnded === null) {
    return { ok: false, problem: "hideEnded must be a boolean" };
  }
  const upcomingCount = raw["upcomingCount"] ?? 4;
  if (
    typeof upcomingCount !== "number" ||
    !Number.isInteger(upcomingCount) ||
    upcomingCount < 1 ||
    upcomingCount > 8
  ) {
    return {
      ok: false,
      problem: "upcomingCount must be an integer from 1 to 8",
    };
  }
  const showCountdown = optionalBoolean(raw["showCountdown"], true);
  const showUpcomingTimeline = optionalBoolean(
    raw["showUpcomingTimeline"],
    true,
  );
  if (showCountdown === null || showUpcomingTimeline === null) {
    return { ok: false, problem: "schedule options must be booleans" };
  }
  return {
    ok: true,
    config: {
      dataSourceId: source,
      titleField,
      startField,
      endField,
      locationField,
      descriptionField,
      categoryField,
      heading,
      style: style as AgendaStyle,
      nowLabel,
      nextLabel,
      maximumItems,
      upcomingCount,
      showCountdown,
      showUpcomingTimeline,
      groupByDay,
      hideEnded,
      emptyText,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
      accent: parseHexColor(raw["accent"]),
    },
  };
}

export function resolveAgendaData(
  config: AgendaConfig,
  resources: WidgetResources,
): WidgetResolution<AgendaData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records: readonly WidgetRecord[] = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  // Most styles need a real start instant. Older Now and Next Widgets may
  // not have had a usable temporal mapping; retain their source order.
  const sorted = records
    .map((record) => ({
      record,
      startMs:
        config.startField === ""
          ? null
          : eventInstant(record.values[config.startField]),
    }))
    .filter(
      (entry): entry is { record: WidgetRecord; startMs: number } =>
        entry.startMs !== null,
    )
    .sort((a, b) => a.startMs - b.startMs)
    .map((entry) => ({
      id: entry.record.id,
      values: entry.record.values,
      startMs: entry.startMs,
      endMs:
        config.endField === ""
          ? null
          : eventInstant(entry.record.values[config.endField]),
    }));
  const sourceOrderFallback =
    config.style === "now-next" && sorted.length === 0;
  const events = sourceOrderFallback
    ? records.slice(0, config.maximumItems).map((record, index) => ({
        id: record.id,
        values: record.values,
        // The source-order presentation never formats or compares this value.
        startMs: index,
        endMs: null,
      }))
    : sorted.slice(0, config.maximumItems);
  if (events.length === 0) return empty("no_records");
  return ready({ events, fields, total: records.length, sourceOrderFallback });
}

/** The nearest event start or end that can change the current schedule view. */
export function nextAgendaBoundary(
  events: readonly AgendaEvent[],
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const event of events) {
    for (const boundary of [event.startMs, event.endMs]) {
      if (
        boundary !== null &&
        boundary > nowMs &&
        (next === null || boundary < next)
      ) {
        next = boundary;
      }
    }
  }
  return next;
}

/** Compact countdown text used by the schedule-board style. */
export function formatAgendaCountdown(targetMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Locale-aware action label for a Schedule Board countdown. */
export function formatAgendaCountdownLabel(
  direction: "start" | "end",
  locale: string,
): string {
  const language = locale.toLowerCase().split(/[-_]/u, 1)[0];
  const labels: Record<string, { start: string; end: string }> = {
    en: { start: "Starts in", end: "Ends in" },
    es: { start: "Empieza en", end: "Termina en" },
    ru: { start: "Начнётся через", end: "Закончится через" },
  };
  return (labels[language ?? ""] ?? labels.en)[direction];
}

/** Schedule Board countdowns change every second; other views change by minute. */
export function agendaClockGranularity(
  config: Pick<AgendaConfig, "style" | "showCountdown">,
): "second" | "minute" {
  return config.style === "schedule-board" && config.showCountdown
    ? "second"
    : "minute";
}

/** An event already finished at `nowMs`. Without an end, an event ends when its local day does. */
export function isEnded(
  event: Pick<AgendaEvent, "startMs" | "endMs">,
  nowMs: number,
  timeZone: string,
): boolean {
  if (event.endMs !== null) return nowMs >= event.endMs;
  return localDayKey(event.startMs, timeZone) < localDayKey(nowMs, timeZone);
}

/** An event happening at `nowMs`: started, and not yet ended. */
export function isNow(
  event: Pick<AgendaEvent, "startMs" | "endMs">,
  nowMs: number,
  timeZone: string,
): boolean {
  return event.startMs <= nowMs && !isEnded(event, nowMs, timeZone);
}

export interface AgendaGroup {
  /** Local day key (YYYY-MM-DD) when grouped, or "" for one flat list. */
  readonly day: string;
  readonly firstStartMs: number;
  readonly events: readonly AgendaEvent[];
}

/**
 * The happening-now marker in the screen locale ("now", "ahora",
 * "сейчас"). A hard-coded English word would mislabel every
 * non-English screen; the relative formatter already knows them all.
 */
export function nowLabel(locale: string): string {
  try {
    const text = new Intl.RelativeTimeFormat(locale, {
      numeric: "auto",
    }).format(0, "second");
    return text === "" ? "Now" : text;
  } catch {
    return "Now";
  }
}

/**
 * Collect events into local-day groups in chronological order, or one
 * flat group when the author turns grouping off.
 */
export function groupAgendaEvents(
  events: readonly AgendaEvent[],
  timeZone: string,
  groupByDay: boolean,
): AgendaGroup[] {
  if (!groupByDay || events.length === 0) {
    return events.length === 0
      ? []
      : [
          {
            day: "",
            firstStartMs: events[0]?.startMs ?? 0,
            events,
          },
        ];
  }
  const order: string[] = [];
  const byDay = new Map<string, AgendaEvent[]>();
  for (const event of events) {
    const day = localDayKey(event.startMs, timeZone);
    if (!byDay.has(day)) {
      byDay.set(day, []);
      order.push(day);
    }
    byDay.get(day)?.push(event);
  }
  return order.map((day) => ({
    day,
    firstStartMs: byDay.get(day)?.[0]?.startMs ?? 0,
    events: byDay.get(day) ?? [],
  }));
}

export class TilecastAgendaWidget extends TilecastWidgetElement<
  AgendaConfig,
  AgendaData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .agenda {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        padding: var(--tc-gutter);
      }
      .heading {
        font-size: clamp(14px, min(7cqh, 4.6cqw), 120px);
        font-weight: 650;
        letter-spacing: -0.01em;
        line-height: 1.2;
        margin-bottom: min(2.4cqh, 2.4cqw);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .days {
        display: flex;
        flex-direction: column;
        gap: min(3cqh, 3cqw);
        min-height: 0;
        overflow: hidden;
      }
      .day-name {
        font-size: clamp(11px, min(4.6cqh, 3.2cqw), 84px);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--tc-color-fg-subtle);
        margin-bottom: min(1.2cqh, 1.2cqw);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .event {
        display: flex;
        align-items: baseline;
        gap: min(2cqh, 2cqw);
        min-width: 0;
        padding: min(1.2cqh, 1.2cqw) 0;
      }
      .time {
        flex: none;
        min-width: 12cqi;
        font-size: clamp(11px, min(4.8cqh, 3.2cqw), 76px);
        font-weight: 650;
        font-variant-numeric: tabular-nums;
        color: var(--tc-color-fg-subtle);
      }
      .event[data-now] .time {
        color: var(--tc-color-accent-contrast, var(--tc-color-accent));
      }
      .body {
        flex: 1 1 auto;
        min-width: 0;
      }
      .title {
        font-size: clamp(12px, min(5.4cqh, 3.6cqw), 92px);
        font-weight: 600;
        line-height: 1.25;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .meta {
        font-size: clamp(10px, min(4.2cqh, 2.9cqw), 68px);
        font-weight: 500;
        color: var(--tc-color-fg-muted);
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status {
        flex: none;
        font-size: clamp(10px, min(4cqh, 2.8cqw), 64px);
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--tc-color-accent-contrast, var(--tc-color-accent));
        white-space: nowrap;
      }
      .tag {
        flex: none;
        font-size: clamp(9px, min(3.6cqh, 2.6cqw), 56px);
        font-weight: 600;
        color: var(--tc-color-fg-muted);
        border: var(--tc-stroke) solid var(--tc-color-separator);
        border-radius: 0.6em;
        padding: 0.15em 0.6em;
        white-space: nowrap;
      }

      .now-next,
      .schedule-board {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        overflow: hidden;
        padding: var(--tc-gutter);
      }
      .schedule-heading {
        color: var(--tc-color-fg-muted);
        font-size: clamp(12px, min(5cqh, 3.5cqw), 64px);
        font-weight: 650;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .schedule-feature {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        justify-content: center;
        gap: min(2.4cqh, 2.4cqw);
        min-height: 0;
      }
      .schedule-label {
        color: var(--tc-color-accent);
        font-size: clamp(12px, min(5cqh, 3.5cqw), 68px);
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .schedule-title {
        color: var(--tc-color-fg);
        font-size: clamp(22px, min(14cqh, 10cqw), 200px);
        font-weight: 650;
        line-height: 1.08;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
      }
      .schedule-detail,
      .schedule-countdown {
        color: var(--tc-color-fg-muted);
        font-size: clamp(12px, min(5cqh, 3.5cqw), 72px);
        line-height: 1.3;
      }
      .schedule-countdown {
        color: var(--tc-color-accent);
        font-variant-numeric: tabular-nums;
        font-weight: 650;
      }
      .schedule-timeline {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(12em, 100%), 1fr));
        gap: min(1.8cqh, 1.8cqw);
        max-height: 34%;
        overflow: hidden;
      }
      .schedule-card {
        min-width: 0;
        overflow: hidden;
        padding: min(1.6cqh, 1.6cqw);
        border: var(--tc-stroke) solid var(--tc-color-separator);
        border-radius: var(--tc-radius-m);
        background: var(--tc-color-surface);
      }
      .schedule-card-title,
      .schedule-card-time,
      .schedule-card-detail {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .schedule-card-title {
        color: var(--tc-color-fg);
        font-size: clamp(12px, min(4.4cqh, 3cqw), 56px);
        font-weight: 620;
      }
      .schedule-card-time,
      .schedule-card-detail {
        color: var(--tc-color-fg-muted);
        font-size: clamp(10px, min(3.5cqh, 2.4cqw), 40px);
      }
      .schedule-following {
        display: flex;
        flex: 0 1 38%;
        flex-direction: column;
        gap: min(1.2cqh, 1.2cqw);
        min-height: 0;
        max-height: 38%;
        overflow: hidden;
      }
      .schedule-following-label {
        flex: none;
        color: var(--tc-color-accent);
        font-size: clamp(10px, min(4cqh, 2.8cqw), 48px);
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .schedule-following-list {
        display: grid;
        gap: min(1cqh, 1cqw);
        min-height: 0;
        overflow: hidden;
      }
      .schedule-following-row {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr);
        column-gap: min(1.5cqh, 1.5cqw);
        row-gap: min(0.4cqh, 0.4cqw);
        min-width: 0;
        overflow: hidden;
      }
      .schedule-following-time {
        color: var(--tc-color-fg-muted);
        font-size: clamp(10px, min(3.5cqh, 2.4cqw), 40px);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .schedule-following-title {
        min-width: 0;
        overflow: hidden;
        color: var(--tc-color-fg);
        font-size: clamp(12px, min(4.6cqh, 3.2cqw), 56px);
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .schedule-following-detail {
        grid-column: 2;
        overflow: hidden;
        color: var(--tc-color-fg-muted);
        font-size: clamp(10px, min(3.5cqh, 2.4cqw), 40px);
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .schedule-heading,
        .schedule-detail,
        .schedule-timeline,
        .schedule-following {
          display: none;
        }
        .schedule-title {
          font-size: clamp(16px, min(12cqh, 9cqw), 80px);
        }
      }

      /* Wide frame: days flow side by side. */
      @container tc-widget (min-width: 900px) {
        .days {
          flex-direction: row;
          align-items: start;
          gap: 5cqw;
        }
        .day {
          flex: 1 1 0;
          min-width: 0;
        }
      }

      /* Small Layout zone: times and titles only. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .meta,
        .day-name,
        .status,
        .tag {
          display: none;
        }
        .event:nth-child(n + 4) {
          display: none;
        }
      }
    `,
  ];

  /**
   * The cadence follows the active presentation, with exact event
   * boundaries handled independently by ClockController.
   */
  private readonly ticks = new ClockController(this, {
    granularity: () => agendaClockGranularity(this.config),
    nextBoundary: (now) =>
      this.config.style === "schedule-board" && this.config.showCountdown
        ? null
        : this.data
          ? nextAgendaBoundary(this.data.events, now)
          : null,
  });

  protected override themeOverrides(config: AgendaConfig) {
    return {
      background: config.background,
      foreground: config.foreground,
      accent: config.accent,
    };
  }

  protected override presentationState():
    | { state: "ready" }
    | { state: "empty"; reason: string }
    | { state: "error"; code: string } {
    if (this.empty !== null) return { state: "empty", reason: this.empty };
    if (!this.data) return { state: "ready" };
    if (this.data.sourceOrderFallback) {
      return this.data.events.length > 0
        ? { state: "ready" }
        : { state: "empty", reason: "no_records" };
    }
    const now = this.context.clock.now();
    const available = this.data.sourceOrderFallback
      ? this.data.events
      : this.config.hideEnded
        ? this.data.events.filter(
            (event) => !isEnded(event, now, this.context.timeZone),
          )
        : this.data.events;
    return available.length > 0
      ? { state: "ready" }
      : { state: "empty", reason: "no_records" };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: AgendaData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const timeZone = this.context.timeZone;
    const hourCycle: HourCycle =
      this.context.hourCycle === "h12" || this.context.hourCycle === "h23"
        ? this.context.hourCycle
        : "locale";
    const nowMs = this.context.clock.now();
    const visible = data.sourceOrderFallback
      ? data.events
      : this.config.hideEnded
        ? data.events.filter((event) => !isEnded(event, nowMs, timeZone))
        : data.events;
    if (visible.length === 0) return this.renderEmpty("no_records");
    if (this.config.style === "now-next") {
      return this.renderNowNext(data, visible, nowMs, timeZone, hourCycle);
    }
    if (this.config.style === "schedule-board") {
      return this.renderScheduleBoard(
        data,
        visible,
        nowMs,
        timeZone,
        locale,
        hourCycle,
      );
    }
    const groups = groupAgendaEvents(visible, timeZone, this.config.groupByDay);
    const cell = (event: AgendaEvent, key: string): string => {
      if (key === "") return "";
      return formatWidgetValue(event.values[key], data.fields[key], {
        locale,
      });
    };
    return html`<div class="agenda" data-style=${this.config.style}>
      ${
        this.config.heading
          ? html`<div class="heading">${this.config.heading}</div>`
          : nothing
      }
      <div class="days">
        ${groups.map(
          (group) =>
            html`<section class="day">
              ${
                group.day
                  ? html`<div class="day-name">
                      ${formatDate(group.firstStartMs, {
                        locale,
                        timeZone,
                        style: "medium",
                      })}
                    </div>`
                  : nothing
              }
              ${group.events.map((event) => {
                const title = cell(event, this.config.titleField);
                const location = cell(event, this.config.locationField);
                const description = cell(event, this.config.descriptionField);
                const category = cell(event, this.config.categoryField);
                const meta = [location, description]
                  .filter((part) => part !== "")
                  .join(" · ");
                const now = isNow(event, nowMs, timeZone);
                if (!title && !meta) return nothing;
                return html`<div class="event" ?data-now=${now}>
                  <div class="time">
                    ${formatTime(event.startMs, {
                      locale,
                      timeZone,
                      hourCycle,
                    })}
                  </div>
                  <div class="body">
                    ${title ? html`<div class="title">${title}</div>` : nothing}
                    ${meta ? html`<div class="meta">${meta}</div>` : nothing}
                  </div>
                  ${
                    now
                      ? html`<div class="status">${nowLabel(locale)}</div>`
                      : nothing
                  }
                  ${category ? html`<div class="tag">${category}</div>` : nothing}
                </div>`;
              })}
            </section>`,
        )}
      </div>
    </div>`;
  }

  private titleFor(event: AgendaEvent, data: AgendaData): string {
    return this.config.titleField === ""
      ? ""
      : formatWidgetValue(
          event.values[this.config.titleField],
          data.fields[this.config.titleField],
          {
            locale: this.context.locale,
          },
        );
  }

  private detailFor(event: AgendaEvent, data: AgendaData): string {
    const key = this.config.locationField || this.config.descriptionField;
    return key === ""
      ? ""
      : formatWidgetValue(event.values[key], data.fields[key], {
          locale: this.context.locale,
        });
  }

  private renderNowNext(
    data: AgendaData,
    visible: readonly AgendaEvent[],
    nowMs: number,
    timeZone: string,
    hourCycle: HourCycle,
  ): TemplateResult {
    const current = data.sourceOrderFallback
      ? visible[0]
      : visible.find((event) => isNow(event, nowMs, timeZone));
    const future = data.sourceOrderFallback
      ? visible.slice(1)
      : visible.filter((event) => event.startMs > nowMs);
    const featured = current ?? future[0];
    const following = (
      data.sourceOrderFallback || current ? future : future.slice(1)
    ).slice(0, this.config.upcomingCount);
    return html`<div
      class="now-next"
      data-style="now-next"
      ?data-source-order=${data.sourceOrderFallback}
    >
      ${this.config.heading ? html`<div class="schedule-heading">${this.config.heading}</div>` : nothing}
      ${
        featured
          ? html`<section class="schedule-feature">
              <div class="schedule-label">
                ${current ? this.config.nowLabel : this.config.nextLabel}
              </div>
              <div class="schedule-title">${this.titleFor(featured, data)}</div>
              ${this.detailFor(featured, data) ? html`<div class="schedule-detail">${this.detailFor(featured, data)}</div>` : nothing}
            </section>`
          : nothing
      }
      ${
        following.length > 0
          ? html`<section class="schedule-following">
              ${
                current
                  ? html`<div class="schedule-following-label">
                      ${this.config.nextLabel}
                    </div>`
                  : nothing
              }
              <div class="schedule-following-list">
                ${following.map(
                  (event) =>
                    html`<article class="schedule-following-row">
                      ${!data.sourceOrderFallback ? html`<div class="schedule-following-time">${formatTime(event.startMs, { locale: this.context.locale, timeZone, hourCycle })}</div>` : nothing}
                      <div class="schedule-following-title">
                        ${this.titleFor(event, data)}
                      </div>
                      ${this.detailFor(event, data) ? html`<div class="schedule-following-detail">${this.detailFor(event, data)}</div>` : nothing}
                    </article>`,
                )}
              </div>
            </section>`
          : nothing
      }
    </div>`;
  }

  private renderScheduleBoard(
    data: AgendaData,
    visible: readonly AgendaEvent[],
    nowMs: number,
    timeZone: string,
    locale: string,
    hourCycle: HourCycle,
  ): TemplateResult {
    const current = visible.find((event) => isNow(event, nowMs, timeZone));
    const next = visible.find((event) => event.startMs > nowMs);
    const featured = current ?? next;
    const target = current?.endMs ?? next?.startMs ?? null;
    const upcoming = visible
      .filter((event) => event !== featured && event.startMs > nowMs)
      .slice(0, this.config.upcomingCount);
    return html`<div class="schedule-board" data-style="schedule-board">
      ${this.config.heading ? html`<div class="schedule-heading">${this.config.heading}</div>` : nothing}
      ${
        featured
          ? html`<section class="schedule-feature">
              <div class="schedule-label">
                ${current ? this.config.nowLabel : this.config.nextLabel}
              </div>
              <div class="schedule-title">${this.titleFor(featured, data)}</div>
              ${this.detailFor(featured, data) ? html`<div class="schedule-detail">${this.detailFor(featured, data)}</div>` : nothing}
              ${target !== null && this.config.showCountdown ? html`<div class="schedule-countdown">${formatAgendaCountdownLabel(current ? "end" : "start", locale)} ${formatAgendaCountdown(target, nowMs)}</div>` : nothing}
            </section>`
          : nothing
      }
      ${
        this.config.showUpcomingTimeline && upcoming.length > 0
          ? html`<div class="schedule-timeline">
              ${upcoming.map(
                (event) =>
                  html`<article class="schedule-card">
                    <div class="schedule-card-title">
                      ${this.titleFor(event, data)}
                    </div>
                    <div class="schedule-card-time">
                      ${formatTime(event.startMs, { locale, timeZone, hourCycle })}
                    </div>
                    ${this.detailFor(event, data) ? html`<div class="schedule-card-detail">${this.detailFor(event, data)}</div>` : nothing}
                  </article>`,
              )}
            </div>`
          : nothing
      }
    </div>`;
  }
}
