/**
 * Metrics V2: one numeric KPI or a responsive grid of up to six values.
 *
 * The author picks a records or single-object source and maps each metric
 * onto a numeric field, with an optional literal or mapped label and a
 * small detail value. Values format from their typed metadata in the
 * screen locale with an author-chosen style; the Widget never branches on
 * the source provider.
 *
 * A records source reads its first record, matching the legacy Metric and
 * Stat Grid behavior; an object source reads its single value object. No
 * aggregation is ever performed.
 *
 * Layout is container queries only. One KPI is a large focal value; two
 * to six form a responsive grid. Narrow strips and small Layout zones
 * drop details first, never clipping or scrolling.
 */
import { css, html, nothing, type TemplateResult } from "lit";
import {
  empty,
  failure,
  firstRecordsDataset,
  parseHexColor,
  ready,
  type ConfigResult,
  type WidgetDataDocument,
  type WidgetDataset,
  type WidgetField,
  type WidgetResources,
  type WidgetResolution,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import {
  boundText,
  formatDisplayNumber,
  formatWidgetValue,
  TilecastWidgetElement,
  emptyState,
  toFiniteNumber,
  type NumericDisplayStyle,
} from "@tilecast/widget-kit";

export const METRIC_FORMATS = [
  "number",
  "integer",
  "percent",
  "currency",
] as const;
export type MetricFormat = (typeof METRIC_FORMATS)[number];

export const MAX_METRICS = 6;

export interface MetricItem {
  readonly valueField: string;
  readonly label: string;
  readonly labelField: string;
  readonly detailField: string;
  readonly format: MetricFormat;
  readonly precision: number;
  readonly prefix: string;
  readonly suffix: string;
}

export interface MetricsConfig {
  readonly dataSourceId: string;
  readonly metrics: readonly MetricItem[];
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface MetricEntry {
  readonly item: MetricItem;
  readonly raw: number;
  readonly field: WidgetField | undefined;
  /** Mapped label value, or null when the literal label applies. */
  readonly labelValue: WidgetValue | null;
  readonly labelField: WidgetField | undefined;
  readonly detailValue: WidgetValue | null;
  readonly detailField: WidgetField | undefined;
}

export interface MetricsData {
  readonly metrics: readonly MetricEntry[];
  readonly single: boolean;
}

const MAX_FIELD_LENGTH = 120;

function fieldRef(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

function parseMetricItem(value: unknown): MetricItem | "skip" | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const valueField = fieldRef(raw["valueField"]);
  // An empty value field carries no metric: the component template builds
  // this shape from legacy singular keys, and a row without a value maps
  // to an empty item rather than failing the whole Widget.
  if (valueField === "") return "skip";
  const labelField = fieldRef(raw["labelField"]);
  const detailField = fieldRef(raw["detailField"]);
  if (valueField === null || labelField === null || detailField === null) {
    return null;
  }
  const format = raw["format"] ?? "number";
  if (!METRIC_FORMATS.includes(format as never)) return null;
  const precision = raw["precision"] ?? 1;
  if (
    typeof precision !== "number" ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 6
  ) {
    return null;
  }
  const label = boundText(raw["label"] ?? "", 80);
  const prefix = boundText(raw["prefix"] ?? "", 20);
  const suffix = boundText(raw["suffix"] ?? "", 20);
  return {
    valueField,
    label,
    labelField,
    detailField,
    format: format as MetricFormat,
    precision,
    prefix,
    suffix,
  };
}

export function parseMetricsConfig(
  value: unknown,
): ConfigResult<MetricsConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  const items = raw["metrics"] ?? [];
  if (!Array.isArray(items) || items.length > MAX_METRICS) {
    return { ok: false, problem: "metrics must list up to six metrics" };
  }
  const metrics: MetricItem[] = [];
  for (const item of items) {
    const parsed = parseMetricItem(item);
    if (parsed === null) {
      return { ok: false, problem: "a metric is invalid" };
    }
    if (parsed !== "skip") metrics.push(parsed);
  }
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  return {
    ok: true,
    config: {
      dataSourceId: source,
      metrics,
      emptyText,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

function fieldsByKey(
  dataset: Pick<WidgetDataset, "fields">,
): Readonly<Record<string, WidgetField>> {
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  return fields;
}

function firstObjectValues(document: WidgetDataDocument): {
  values: Readonly<Record<string, WidgetValue>>;
  fields: Readonly<Record<string, WidgetField>>;
} | null {
  for (const dataset of document.datasets) {
    if (dataset.kind !== "object") continue;
    const object = dataset.value?.object;
    if (!object) return null;
    return { values: object, fields: fieldsByKey(dataset) };
  }
  return null;
}

export function formatMetricValue(
  item: MetricItem,
  raw: number,
  field: WidgetField | undefined,
  locale: string,
): string {
  const style: NumericDisplayStyle = item.format;
  return `${item.prefix}${formatDisplayNumber(raw, {
    locale,
    style,
    currency: field?.currency,
    precision: item.precision,
  })}${item.suffix}`;
}

export function resolveMetricsData(
  config: MetricsConfig,
  resources: WidgetResources,
): WidgetResolution<MetricsData> {
  if (config.dataSourceId === "") return empty("no_source");
  if (config.metrics.length === 0) return empty("no_metrics");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const records = firstRecordsDataset(document);
  const object = records ? null : firstObjectValues(document);
  if (!records && !object) return failure("incompatible_source");
  const usable = records
    ? (records.records ?? []).length > 0
      ? {
          values: records.records![0]!.values,
          fields: fieldsByKey(records),
        }
      : null
    : object;
  if (!usable) return empty("no_records");
  const entries: MetricEntry[] = [];
  for (const item of config.metrics) {
    const raw = toFiniteNumber(usable.values[item.valueField]);
    if (raw === null) continue;
    entries.push({
      item,
      raw,
      field: usable.fields[item.valueField],
      labelValue: item.labelField
        ? (usable.values[item.labelField] ?? null)
        : null,
      labelField: item.labelField ? usable.fields[item.labelField] : undefined,
      detailValue: item.detailField
        ? (usable.values[item.detailField] ?? null)
        : null,
      detailField: item.detailField
        ? usable.fields[item.detailField]
        : undefined,
    });
  }
  if (entries.length === 0) return empty("no_usable_values");
  return ready({ metrics: entries, single: entries.length === 1 });
}

export class TilecastMetricsWidget extends TilecastWidgetElement<
  MetricsConfig,
  MetricsData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .metrics-wrap {
        position: absolute;
        inset: 0;
        display: flex;
        min-height: 0;
        min-width: 0;
        padding: var(--tc-gutter);
      }
      .metrics-grid {
        display: grid;
        gap: min(3cqh, 3cqw);
        width: 100%;
        margin: auto;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
      }
      .metrics-grid[data-single] {
        grid-template-columns: minmax(0, 1fr);
        max-width: 900px;
      }
      .metric {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-width: 0;
        min-height: 0;
        text-align: center;
        overflow: hidden;
      }
      .metric-label {
        font-size: clamp(11px, min(4.2cqh, 3.4cqw), 44px);
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .metric-value {
        font-size: clamp(18px, min(11cqh, 9cqw), 200px);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.1;
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .metrics-grid[data-single] .metric-value {
        font-size: clamp(28px, min(22cqh, 16cqw), 320px);
      }
      .metric-detail {
        font-size: clamp(10px, min(3.6cqh, 2.8cqw), 32px);
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* Wide strip: metrics flow in one compact row, details drop first. */
      @container tc-widget (max-height: 160px) {
        .metric-detail {
          display: none;
        }
        .metrics-grid {
          grid-template-columns: repeat(
            auto-fit,
            minmax(min(100%, 160px), 1fr)
          );
        }
        .metric-value {
          font-size: clamp(16px, 12cqh, 96px);
        }
      }
      /* Small zone: the value carries the Widget; the label shortens. */
      @container tc-widget (max-width: 220px) {
        .metric-detail {
          display: none;
        }
        .metrics-grid {
          grid-template-columns: minmax(0, 1fr);
        }
      }
    `,
  ];

  protected override themeOverrides(config: MetricsConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  private renderMetric(entry: MetricEntry, locale: string): TemplateResult {
    let label = entry.item.label;
    if (entry.labelValue) {
      const mapped = formatWidgetValue(entry.labelValue, entry.labelField, {
        locale,
      }).trim();
      if (mapped !== "") label = mapped;
    }
    if (label === "") label = entry.field?.label || entry.item.valueField;
    const detail = entry.detailValue
      ? formatWidgetValue(entry.detailValue, entry.detailField, {
          locale,
        }).trim()
      : "";
    return html`<div class="metric">
      <div class="metric-label">${label}</div>
      <div class="metric-value">
        ${formatMetricValue(entry.item, entry.raw, entry.field, locale)}
      </div>
      ${detail ? html`<div class="metric-detail">${detail}</div>` : nothing}
    </div>`;
  }

  protected override renderContent(data: MetricsData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    return html`<div class="metrics-wrap">
      <div class="metrics-grid" ?data-single=${data.single}>
        ${data.metrics.map((entry) => this.renderMetric(entry, locale))}
      </div>
    </div>`;
  }
}
