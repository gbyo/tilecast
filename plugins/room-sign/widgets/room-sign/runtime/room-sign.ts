/**
 * Room Sign: is the room free, what is on now, and what is next.
 *
 * The Room Sign plugin publishes one room's meetings as an ordinary feed
 * Data Source. This Widget reads that dataset, and decides "now" only from
 * the corrected Widget clock, so a Player that lost its connection keeps
 * changing from busy to free at the right minute. A dataset past its
 * staleAt, or one the Player serves from cache, shows a quiet notice.
 */
import { css, html, nothing, type TemplateResult } from "lit";
import {
  empty,
  failure,
  firstRecordsDataset,
  parseHexColor,
  ready,
  type ConfigResult,
  type WidgetResources,
  type WidgetResolution,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import {
  boundText,
  ClockController,
  formatTime,
  TilecastWidgetElement,
  emptyState,
  type HourCycle,
} from "@tilecast/widget-kit";

export interface RoomSignConfig {
  readonly dataSourceId: string;
  readonly titleField: string;
  readonly startField: string;
  readonly endField: string;
  readonly roomName: string;
  readonly freeLabel: string;
  readonly busyLabel: string;
  readonly accent: string | null;
}

export interface RoomMeeting {
  readonly id: string;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface RoomSignData {
  readonly meetings: readonly RoomMeeting[];
  /** Corrected-clock milliseconds after which the data is stale, or null. */
  readonly staleAtMs: number | null;
  readonly usingCachedData: boolean;
}

const text = (value: unknown, fallback: string, maximum: number): string =>
  typeof value === "string" ? boundText(value, maximum) : fallback;

export function parseRoomSignConfig(
  value: unknown,
): ConfigResult<RoomSignConfig> {
  if (value === null || typeof value !== "object") {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const accent =
    typeof raw.accent === "string" && raw.accent !== ""
      ? parseHexColor(raw.accent)
      : null;
  return {
    ok: true,
    config: {
      dataSourceId: text(raw.dataSourceId, "", 80),
      titleField: text(raw.titleField, "title", 80),
      startField: text(raw.startField, "start", 80),
      endField: text(raw.endField, "end", 80),
      roomName: text(raw.roomName, "", 80),
      freeLabel: text(raw.freeLabel, "Available", 40) || "Available",
      busyLabel: text(raw.busyLabel, "In use", 40) || "In use",
      accent,
    },
  };
}

function instant(value: WidgetValue | undefined): number | null {
  if (!value || typeof value.datetime !== "string") return null;
  const ms = Date.parse(value.datetime);
  return Number.isFinite(ms) ? ms : null;
}

export function resolveRoomSignData(
  config: RoomSignConfig,
  resources: WidgetResources,
): WidgetResolution<RoomSignData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const meetings: RoomMeeting[] = [];
  for (const record of dataset.records ?? []) {
    const startMs = instant(record.values[config.startField]);
    const endMs = instant(record.values[config.endField]);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const title = record.values[config.titleField]?.text;
    meetings.push({
      id: record.id,
      title: typeof title === "string" ? boundText(title, 120) : "",
      startMs,
      endMs,
    });
  }
  meetings.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const staleAt = dataset.cache.staleAt
    ? Date.parse(dataset.cache.staleAt)
    : Number.NaN;
  return ready({
    meetings,
    staleAtMs: Number.isFinite(staleAt) ? staleAt : null,
    usingCachedData: dataset.cache.usingCachedData || dataset.cache.unavailable,
  });
}

export interface RoomState {
  readonly current: RoomMeeting | null;
  readonly next: RoomMeeting | null;
}

/** The meeting on now (the one that started last) and the next one. */
export function roomState(
  meetings: readonly RoomMeeting[],
  nowMs: number,
): RoomState {
  let current: RoomMeeting | null = null;
  let next: RoomMeeting | null = null;
  for (const meeting of meetings) {
    if (meeting.startMs <= nowMs && nowMs < meeting.endMs) current = meeting;
    else if (meeting.startMs > nowMs && next === null) next = meeting;
  }
  return { current, next };
}

/** The next start or end after `nowMs`, when the sign changes. */
export function nextRoomBoundary(
  meetings: readonly RoomMeeting[],
  nowMs: number,
): number | null {
  let boundary: number | null = null;
  for (const meeting of meetings) {
    for (const at of [meeting.startMs, meeting.endMs]) {
      if (at > nowMs && (boundary === null || at < boundary)) boundary = at;
    }
  }
  return boundary;
}

export class TilecastRoomSignWidget extends TilecastWidgetElement<
  RoomSignConfig,
  RoomSignData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .sign {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-rows: auto 1fr auto;
        gap: var(--tc-gap);
        padding: var(--tc-gutter);
      }
      .top {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: var(--tc-gap);
      }
      .status {
        display: grid;
        align-self: center;
        align-content: center;
        gap: calc(var(--tc-gap) / 2);
        border-inline-start: 0.4em solid var(--accent);
        padding-inline-start: var(--tc-gutter);
      }
      .busy {
        --accent: var(--tc-accent, #c2410c);
      }
      .free {
        --accent: var(--tc-accent, #15803d);
      }
      .state {
        font-weight: 700;
        font-size: 1.6em;
      }
      .next {
        opacity: 0.85;
      }
      .stale {
        font-size: 0.75em;
        opacity: 0.75;
      }
      .muted {
        opacity: 0.7;
      }
    `,
  ];

  private readonly ticks = new ClockController(this, {
    granularity: () => "minute",
    nextBoundary: (now) =>
      this.data ? nextRoomBoundary(this.data.meetings, now) : null,
  });

  protected override themeOverrides(config: RoomSignConfig) {
    return { background: null, foreground: null, accent: config.accent };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (reason === "no_source")
      return emptyState({ title: this.config?.roomName || "Room Sign" });
    return super.renderEmpty(reason);
  }

  private time(ms: number): string {
    const hourCycle: HourCycle =
      this.context.hourCycle === "h12" || this.context.hourCycle === "h23"
        ? this.context.hourCycle
        : "locale";
    return formatTime(ms, {
      locale: this.context.locale,
      timeZone: this.context.timeZone,
      hourCycle,
    });
  }

  protected override renderContent(data: RoomSignData | null): TemplateResult {
    if (!data) return html``;
    void this.ticks;
    const nowMs = this.context.clock.now();
    const { current, next } = roomState(data.meetings, nowMs);
    const stale =
      data.usingCachedData ||
      (data.staleAtMs !== null && nowMs >= data.staleAtMs);
    return html`<div class="sign">
      <div class="top">
        <div class="tc-title">${this.config.roomName}</div>
        <div class="tc-body muted" aria-label="Current time">
          ${this.time(nowMs)}
        </div>
      </div>
      <div class="status ${current ? "busy" : "free"}" role="status">
        <div class="state tc-headline">
          ${current ? this.config.busyLabel : this.config.freeLabel}
        </div>
        ${
          current
            ? html`<div class="tc-title">${current.title}</div>
                <div class="tc-body muted">
                  ${this.time(current.startMs)}–${this.time(current.endMs)}
                </div>`
            : html`<div class="tc-body muted">
                ${next ? html`Until ${this.time(next.startMs)}` : "For the rest of the schedule"}
              </div>`
        }
      </div>
      <div class="next tc-body">
        ${
          next
            ? html`<span class="muted">Next</span> ${this.time(next.startMs)}
                ${next.title}`
            : html`<span class="muted">No more meetings</span>`
        }
        ${stale ? html`<div class="stale" role="note">The schedule may be out of date.</div>` : nothing}
      </div>
    </div>`;
  }
}
