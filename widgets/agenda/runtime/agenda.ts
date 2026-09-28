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
 * A ClockController wakes the element once a minute (and at no other
 * cadence): the cheapest boundary that stays correct across time zones
 * and DST while keeping relative labels fresh.
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

export interface AgendaConfig {
  readonly dataSourceId: string;
  readonly titleField: string;
  readonly startField: string;
  readonly endField: string;
  readonly locationField: string;
  readonly descriptionField: string;
  readonly categoryField: string;
  readonly heading: string;
  readonly maximumItems: number;
  readonly groupByDay: boolean;
  readonly hideEnded: boolean;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
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
      maximumItems,
      groupByDay,
      hideEnded,
      emptyText,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveAgendaData(
  config: AgendaConfig,
  resources: WidgetResources,
): WidgetResolution<AgendaData> {
  if (config.dataSourceId === "") return empty("no_source");
  if (config.startField === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records: readonly WidgetRecord[] = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  // Events without a start cannot be placed on a day, so they resolve
  // away; the element then filters ended events against the Widget clock.
  const events = records
    .map((record) => ({
      record,
      startMs: eventInstant(record.values[config.startField]),
    }))
    .filter(
      (entry): entry is { record: WidgetRecord; startMs: number } =>
        entry.startMs !== null,
    )
    .sort((a, b) => a.startMs - b.startMs)
    .slice(0, config.maximumItems)
    .map((entry) => ({
      id: entry.record.id,
      values: entry.record.values,
      startMs: entry.startMs,
      endMs:
        config.endField === ""
          ? null
          : eventInstant(entry.record.values[config.endField]),
    }));
  if (events.length === 0) return empty("no_records");
  return ready({ events, fields, total: records.length });
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
   * Agenda follows time at a one-minute cadence: relative labels stay
   * fresh and ended events leave without any host timer.
   */
  private readonly ticks = new ClockController(this, {
    granularity: () => "minute" as const,
  });

  protected override themeOverrides(config: AgendaConfig) {
    return { background: config.background, foreground: config.foreground };
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
    const visible = this.config.hideEnded
      ? data.events.filter((event) => !isEnded(event, nowMs, timeZone))
      : data.events;
    const groups = groupAgendaEvents(visible, timeZone, this.config.groupByDay);
    const cell = (event: AgendaEvent, key: string): string => {
      if (key === "") return "";
      return formatWidgetValue(event.values[key], data.fields[key], {
        locale,
      });
    };
    return html`<div class="agenda">
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
}
