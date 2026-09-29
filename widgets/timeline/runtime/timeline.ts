/**
 * Timeline V2: progression and history as milestone markers on a
 * connecting line.
 *
 * The author picks a records source and maps date, title, body, and
 * status slots. Records render in source order up to the configured
 * maximum: Timeline is not a query engine and never sorts, filters, or
 * drops the past. Dates format from their typed metadata in the Widget
 * locale at render.
 *
 * Layout is container queries only. Vertical draws the line beside the
 * milestones; horizontal flows them left to right. Small zones drop body
 * and status first and keep date and title legible.
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
  type WidgetResources,
  type WidgetResolution,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import {
  badge,
  boundText,
  fieldRef,
  formatWidgetValue,
  TilecastWidgetElement,
  emptyState,
} from "@tilecast/widget-kit";

export const TIMELINE_ORIENTATIONS = ["vertical", "horizontal"] as const;
export type TimelineOrientation = (typeof TIMELINE_ORIENTATIONS)[number];

export interface TimelineConfig {
  readonly dataSourceId: string;
  readonly dateField: string;
  readonly titleField: string;
  readonly bodyField: string;
  readonly statusField: string;
  readonly orientation: TimelineOrientation;
  readonly maximumItems: number;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface TimelineMilestone {
  readonly date: WidgetValue | null;
  readonly dateField: WidgetField | undefined;
  readonly title: WidgetValue | null;
  readonly titleField: WidgetField | undefined;
  readonly body: WidgetValue | null;
  readonly bodyField: WidgetField | undefined;
  readonly status: WidgetValue | null;
}

export interface TimelineData {
  readonly orientation: TimelineOrientation;
  readonly milestones: readonly TimelineMilestone[];
}

export function parseTimelineConfig(
  value: unknown,
): ConfigResult<TimelineConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  const dateField = fieldRef(raw["dateField"]);
  const titleField = fieldRef(raw["titleField"]);
  const bodyField = fieldRef(raw["bodyField"]);
  const statusField = fieldRef(raw["statusField"]);
  if (
    dateField === null ||
    titleField === null ||
    bodyField === null ||
    statusField === null
  ) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const orientation = raw["orientation"] ?? "vertical";
  if (!TIMELINE_ORIENTATIONS.includes(orientation as never)) {
    return { ok: false, problem: "orientation is not a Timeline orientation" };
  }
  const maximumItems = raw["maximumItems"] ?? 8;
  if (
    typeof maximumItems !== "number" ||
    !Number.isInteger(maximumItems) ||
    maximumItems < 1 ||
    maximumItems > 20
  ) {
    return {
      ok: false,
      problem: "maximumItems must be an integer from 1 to 20",
    };
  }
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  return {
    ok: true,
    config: {
      dataSourceId: source,
      dateField,
      titleField,
      bodyField,
      statusField,
      orientation: orientation as TimelineOrientation,
      maximumItems,
      emptyText,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveTimelineData(
  config: TimelineConfig,
  resources: WidgetResources,
): WidgetResolution<TimelineData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  // Source order, bounded: the author curates the progression.
  const slot = (
    values: Readonly<Record<string, WidgetValue>>,
    key: string,
  ): { value: WidgetValue | null; field: WidgetField | undefined } => ({
    value: key ? (values[key] ?? null) : null,
    field: key ? fields[key] : undefined,
  });
  const milestones: TimelineMilestone[] = records
    .slice(0, Math.max(1, config.maximumItems))
    .map((record) => {
      const date = slot(record.values, config.dateField);
      const title = slot(record.values, config.titleField);
      const body = slot(record.values, config.bodyField);
      const status = slot(record.values, config.statusField);
      return {
        date: date.value,
        dateField: date.field,
        title: title.value,
        titleField: title.field,
        body: body.value,
        bodyField: body.field,
        status: status.value,
      };
    });
  return ready({ orientation: config.orientation, milestones });
}

export class TilecastTimelineWidget extends TilecastWidgetElement<
  TimelineConfig,
  TimelineData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .timeline-wrap {
        position: absolute;
        inset: 0;
        min-height: 0;
        min-width: 0;
        padding: var(--tc-gutter);
        overflow: hidden;
      }
      .timeline {
        position: relative;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        padding-left: calc(min(4cqh, 4cqw) + 6px);
      }
      .timeline-flow {
        display: grid;
        grid-template-rows: repeat(var(--timeline-count), minmax(0, 1fr));
        height: 100%;
        min-height: 0;
      }
      .timeline::before {
        content: "";
        position: absolute;
        top: 6px;
        bottom: 6px;
        left: min(2cqh, 2cqw);
        width: 2px;
        background: currentColor;
        opacity: 0.3;
      }
      .milestone {
        position: relative;
        padding: 0 0 min(2.4cqh, 2.4cqw) 0;
        min-width: 0;
        min-height: 0;
        /* Clip crowded rows without clipping their marker or creating a scroll container. */
        overflow: visible;
        clip-path: inset(0 0 0 calc(0px - min(4cqh, 4cqw) - 1px));
      }
      .milestone::before {
        content: "";
        position: absolute;
        left: calc(-1 * min(4cqh, 4cqw) - 1px);
        top: 0.45em;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: var(--tc-color-bg);
        border: 2px solid currentColor;
      }
      .milestone-date {
        font-size: clamp(10px, min(3.4cqh, 2.6cqw), 28px);
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .milestone-title {
        font-size: clamp(13px, min(4.6cqh, 3.6cqw), 64px);
        font-weight: 700;
        line-height: 1.25;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .milestone-body {
        font-size: clamp(11px, min(3.8cqh, 3cqw), 40px);
        line-height: 1.4;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
      }
      .timeline[data-horizontal] {
        padding-left: 0;
        padding-top: calc(min(4cqh, 4cqw) + 6px);
      }
      .timeline[data-horizontal]::before {
        top: min(2cqh, 2cqw);
        bottom: auto;
        left: 6px;
        right: 6px;
        width: auto;
        height: 2px;
      }
      .timeline[data-horizontal] .timeline-flow {
        grid-template-rows: minmax(0, 1fr);
        grid-template-columns: repeat(var(--timeline-count), minmax(0, 1fr));
        gap: min(3cqh, 3cqw);
      }
      .timeline[data-horizontal] .milestone {
        min-width: 0;
        padding: min(2.4cqh, 2.4cqw) 0 0 0;
        clip-path: inset(calc(0px - min(4cqh, 4cqw) - 1px) 0 0 0);
      }
      .timeline[data-horizontal] .milestone::before {
        left: 0.2em;
        top: calc(-1 * min(4cqh, 4cqw) - 1px);
      }
      .timeline[data-dense] .milestone-body,
      .timeline[data-dense] .milestone-status {
        display: none;
      }
      .timeline[data-dense] .milestone {
        padding-bottom: min(1cqh, 1cqw);
      }
      .timeline[data-dense] .milestone-date {
        font-size: clamp(9px, min(2.8cqh, 2.2cqw), 20px);
      }
      .timeline[data-dense] .milestone-title {
        font-size: clamp(10px, min(3.4cqh, 2.8cqw), 32px);
        -webkit-line-clamp: 1;
      }
      @container tc-widget (max-width: 300px) {
        .milestone-body,
        .milestone-status {
          display: none;
        }
        .timeline[data-horizontal] .timeline-flow {
          grid-template-columns: minmax(0, 1fr);
          grid-template-rows: repeat(var(--timeline-count), minmax(0, 1fr));
        }
        .timeline[data-horizontal] {
          padding-left: calc(min(4cqh, 4cqw) + 6px);
          padding-top: 0;
        }
        .timeline[data-horizontal]::before {
          top: 6px;
          bottom: 6px;
          left: min(2cqh, 2cqw);
          width: 2px;
          height: auto;
          right: auto;
        }
        .timeline[data-horizontal] .milestone {
          padding: 0 0 min(2.4cqh, 2.4cqw) 0;
          clip-path: inset(0 0 0 calc(0px - min(4cqh, 4cqw) - 1px));
        }
        .timeline[data-horizontal] .milestone::before {
          left: calc(-1 * min(4cqh, 4cqw) - 1px);
          top: 0.45em;
        }
      }
    `,
  ];

  protected override themeOverrides(config: TimelineConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: TimelineData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const timeZone = this.context.timeZone;
    const text = (
      value: WidgetValue | null,
      field: WidgetField | undefined,
    ): string =>
      value ? formatWidgetValue(value, field, { locale, timeZone }).trim() : "";
    return html`<div class="timeline-wrap">
      <div
        class="timeline"
        ?data-horizontal=${data.orientation === "horizontal"}
        ?data-dense=${data.milestones.length > 8}
      >
        <div
          class="timeline-flow"
          style=${`--timeline-count:${Math.max(1, data.milestones.length)}`}
        >
          ${data.milestones.map((milestone) => {
            const date = text(milestone.date, milestone.dateField);
            const title = text(milestone.title, milestone.titleField);
            const body = text(milestone.body, milestone.bodyField);
            const status = text(milestone.status, undefined);
            return html`<div class="milestone">
              ${
                date ? html`<div class="milestone-date">${date}</div>` : nothing
              }
              <div class="milestone-title">${title}</div>
              ${
                status
                  ? html`<div class="milestone-status">${badge(status)}</div>`
                  : nothing
              }
              ${
                body ? html`<div class="milestone-body">${body}</div>` : nothing
              }
            </div>`;
          })}
        </div>
      </div>
    </div>`;
  }
}
