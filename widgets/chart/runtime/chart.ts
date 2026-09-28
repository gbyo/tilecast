/**
 * Chart V2: up to four numeric series as bars, lines, or areas in
 * deterministic SVG.
 *
 * The author picks a records or time-series source, up to four numeric
 * series, and a style. Records read x labels from a category or time
 * field; time-series datasets use their prepared point timestamps and
 * values. Missing values leave gaps; a saved legacy donut renders as
 * bars. Geometry lives in chart-model.ts; this module parses, resolves,
 * labels, and draws.
 *
 * Layout is container queries only. Legends hide first on strips and
 * small zones, then axis ticks simplify; data marks are never the thing
 * that gives.
 */
import { css, html, nothing, svg, type TemplateResult } from "lit";
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
  formatWidgetValue,
  TilecastWidgetElement,
  emptyState,
  toFiniteNumber,
} from "@tilecast/widget-kit";
import {
  barRects,
  CHART_HEIGHT,
  CHART_WIDTH,
  computeDomain,
  niceTicks,
  PLOT_BOTTOM,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
  scaleX,
  scaleY,
  seriesPaths,
  type ChartDomain,
} from "./chart-model.ts";

export const CHART_STYLES = ["bar", "line", "area"] as const;
export type ChartStyle = (typeof CHART_STYLES)[number];

const LEGACY_STYLE: Record<string, ChartStyle> = {
  bar: "bar",
  line: "line",
  area: "line",
  donut: "bar",
};

export const MAX_SERIES = 4;

/** The built-in palette. Series colors override per series. */
export const DEFAULT_PALETTE = [
  "#4f9dff",
  "#3fa66a",
  "#f5b83d",
  "#e05d5d",
  "#9a7bff",
  "#38bdd0",
];

export interface ChartSeriesConfig {
  readonly field: string;
  readonly label: string;
  readonly color: string | null;
}

export interface ChartConfig {
  readonly dataSourceId: string;
  readonly dataset: string;
  readonly series: readonly ChartSeriesConfig[];
  readonly categoryField: string;
  readonly timeField: string;
  readonly style: ChartStyle;
  readonly showLegend: boolean;
  readonly showAxes: boolean;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface ChartSeriesData {
  readonly label: string;
  readonly color: string;
  /** One entry per point; null leaves a gap. */
  readonly points: readonly (number | null)[];
}

export interface ChartData {
  readonly style: ChartStyle;
  /** Raw x labels: record values, ISO timestamps, or null for numbered points. */
  readonly rawLabels: readonly (WidgetValue | string | null)[];
  readonly rawLabelField: WidgetField | undefined;
  readonly series: readonly ChartSeriesData[];
  readonly domain: ChartDomain;
  readonly showLegend: boolean;
  readonly showAxes: boolean;
}

const MAX_FIELD_LENGTH = 120;
const MAX_LABEL_LENGTH = 80;

function fieldRef(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

function optionalFinite(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

/** A valid new style wins; otherwise the legacy chart type maps over. */
export function resolveChartStyle(
  style: unknown,
  chartType: unknown,
): ChartStyle {
  if (
    typeof style === "string" &&
    (CHART_STYLES as readonly string[]).includes(style)
  ) {
    return style as ChartStyle;
  }
  if (typeof chartType === "string" && chartType in LEGACY_STYLE) {
    return LEGACY_STYLE[chartType]!;
  }
  return "line";
}

function parseSeries(value: unknown): ChartSeriesConfig[] | null {
  if (!Array.isArray(value) || value.length > MAX_SERIES) return null;
  const series: ChartSeriesConfig[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const raw = item as Record<string, unknown>;
    const field = fieldRef(raw["field"]);
    // An empty field plots nothing from records but reads the unnamed
    // value of single-value time-series points.
    if (field === null) return null;
    const color = parseHexColor(raw["color"] ?? "");
    series.push({
      field,
      label: boundText(raw["label"] ?? "", MAX_LABEL_LENGTH),
      color,
    });
  }
  return series;
}

export function parseChartConfig(value: unknown): ConfigResult<ChartConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  const dataset = boundText(raw["dataset"] ?? "", MAX_FIELD_LENGTH);
  const series = parseSeries(raw["series"] ?? []);
  if (series === null) {
    return { ok: false, problem: "series must list up to four series" };
  }
  const categoryField = fieldRef(raw["categoryField"]);
  const timeField = fieldRef(raw["timeField"]);
  if (categoryField === null || timeField === null) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const showLegend = optionalBoolean(raw["showLegend"], true);
  const showAxes = optionalBoolean(raw["showAxes"], true);
  if (showLegend === null || showAxes === null) {
    return { ok: false, problem: "legend and axes must be booleans" };
  }
  const minimum = optionalFinite(raw["minimum"]);
  const maximum = optionalFinite(raw["maximum"]);
  if (minimum === undefined || maximum === undefined) {
    return { ok: false, problem: "bounds must be finite numbers" };
  }
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  return {
    ok: true,
    config: {
      dataSourceId: source,
      dataset,
      series,
      categoryField,
      timeField,
      style: resolveChartStyle(raw["style"], raw["chartType"]),
      showLegend,
      showAxes,
      minimum,
      maximum,
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

function pickDataset(
  document: WidgetDataDocument,
  name: string,
): WidgetDataset | null {
  if (name !== "") {
    const named = document.datasets.find(
      (dataset) =>
        dataset.id === name &&
        (dataset.kind === "records" || dataset.kind === "time_series"),
    );
    if (named) return named;
  }
  return (
    document.datasets.find((dataset) => dataset.kind === "records") ??
    document.datasets.find((dataset) => dataset.kind === "time_series") ??
    null
  );
}

/**
 * The raw x label for one record: the time value, then the category
 * value, else null for a numbered point. Formatting happens at render in
 * the Widget locale.
 */
function recordLabelRaw(
  values: Readonly<Record<string, WidgetValue>>,
  config: ChartConfig,
): WidgetValue | null {
  if (config.timeField !== "" && values[config.timeField] !== undefined) {
    return values[config.timeField] ?? null;
  }
  if (
    config.categoryField !== "" &&
    values[config.categoryField] !== undefined
  ) {
    return values[config.categoryField] ?? null;
  }
  return null;
}

function recordLabelField(
  fields: Readonly<Record<string, WidgetField>>,
  config: ChartConfig,
): WidgetField | undefined {
  if (config.timeField !== "" && fields[config.timeField] !== undefined) {
    return fields[config.timeField];
  }
  if (
    config.categoryField !== "" &&
    fields[config.categoryField] !== undefined
  ) {
    return fields[config.categoryField];
  }
  return undefined;
}

export function resolveChartData(
  config: ChartConfig,
  resources: WidgetResources,
): WidgetResolution<ChartData> {
  if (config.dataSourceId === "") return empty("no_source");
  if (config.series.length === 0) return empty("no_series");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  // Records carry their own datasets; fall back to the first usable one.
  const dataset =
    firstRecordsDataset(document) ?? pickDataset(document, config.dataset);
  if (!dataset) return failure("incompatible_source");
  const fields = fieldsByKey(dataset);
  if (dataset.kind === "time_series") {
    const points = dataset.points ?? [];
    if (points.length === 0) return empty("no_points");
    const series = config.series.map((item, index) => ({
      label:
        item.label ||
        fields[item.field]?.label ||
        (points[0]?.values ? item.field : `Series ${index + 1}`),
      color: item.color ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]!,
      points: points.map((point) => {
        if (point.values && item.field !== "") {
          return toFiniteNumber(point.values[item.field]);
        }
        return index === 0 ? toFiniteNumber(point.value) : null;
      }),
    }));
    const domain = computeDomain(
      series.flatMap((entry) =>
        entry.points.filter((point): point is number => point !== null),
      ),
      config.minimum,
      config.maximum,
    );
    return ready({
      style: config.style,
      rawLabels: points.map((point) => point.at),
      rawLabelField: undefined,
      series,
      domain,
      showLegend: config.showLegend,
      showAxes: config.showAxes,
    });
  }
  const records = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  // Labels format in the Widget locale at render; resolve keeps raw order.
  // Series without a mapped field plot nothing from records.
  const mapped = config.series.filter((item) => item.field !== "");
  if (mapped.length === 0) return empty("no_series");
  const series = mapped.map((item, index) => ({
    label: item.label || fields[item.field]?.label || item.field,
    color: item.color ?? DEFAULT_PALETTE[index % DEFAULT_PALETTE.length]!,
    points: records.map((record) => toFiniteNumber(record.values[item.field])),
  }));
  const domain = computeDomain(
    series.flatMap((entry) =>
      entry.points.filter((point): point is number => point !== null),
    ),
    config.minimum,
    config.maximum,
  );
  return ready({
    style: config.style,
    rawLabels: records.map((record) => recordLabelRaw(record.values, config)),
    rawLabelField: recordLabelField(fields, config),
    series,
    domain,
    showLegend: config.showLegend,
    showAxes: config.showAxes,
  });
}

/** Format one raw x label in the Widget locale, or number the point. */
export function formatChartLabel(
  raw: WidgetValue | string | null,
  field: WidgetField | undefined,
  locale: string,
  index: number,
): string {
  if (typeof raw === "string") {
    if (raw !== "" && !Number.isNaN(Date.parse(raw))) {
      const date = formatWidgetValue(
        { kind: "datetime", datetime: raw },
        undefined,
        { locale },
      ).trim();
      if (date !== "") return date;
    }
    return raw === "" ? String(index + 1) : raw;
  }
  if (raw) {
    const text = formatWidgetValue(raw, field, { locale }).trim();
    if (text !== "") return text;
  }
  return String(index + 1);
}

export class TilecastChartWidget extends TilecastWidgetElement<
  ChartConfig,
  ChartData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .chart-wrap {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
        padding: var(--tc-gutter);
      }
      .chart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35em 1em;
        justify-content: center;
        font-size: clamp(10px, min(3.4cqh, 2.6cqw), 28px);
        color: var(--tc-color-fg-muted);
        padding-bottom: 0.4em;
      }
      .chart-swatch {
        display: inline-block;
        width: 0.8em;
        height: 0.8em;
        border-radius: 2px;
        margin-right: 0.4em;
        vertical-align: baseline;
      }
      .chart-svg {
        flex: 1;
        min-height: 0;
        width: 100%;
      }
      .chart-tick {
        font-size: 11px;
        fill: var(--tc-color-fg-muted);
      }
      .chart-axis {
        stroke: var(--tc-color-fg-muted);
        stroke-width: 1;
        opacity: 0.5;
      }
      @container tc-widget (max-height: 170px) {
        .chart-legend {
          display: none;
        }
      }
      @container tc-widget (max-width: 260px) {
        .chart-legend {
          display: none;
        }
        .chart-tick-label {
          display: none;
        }
      }
    `,
  ];

  protected override themeOverrides(config: ChartConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: ChartData | null): TemplateResult {
    if (!data || !this.config) return html``;
    const locale = this.context.locale;
    const labels = data.rawLabels.map((raw, index) =>
      formatChartLabel(raw, data.rawLabelField, locale, index),
    );
    const described =
      `${data.style} chart with ${data.series.length} series and ` +
      `${labels.length} ${labels.length === 1 ? "point" : "points"}: ` +
      data.series.map((entry) => entry.label).join(", ");
    return html`<div class="chart-wrap">
      ${
        data.showLegend && data.series.length > 1
          ? html`<div class="chart-legend">
              ${data.series.map(
                (entry) =>
                  html`<span
                    ><span
                      class="chart-swatch"
                      style="background:${entry.color}"
                    ></span
                    >${entry.label}</span
                  >`,
              )}
            </div>`
          : nothing
      }
      <svg
        class="chart-svg"
        viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label=${described}
      >
        ${this.renderAxes(data, labels, locale)}${this.renderMarks(data)}
      </svg>
    </div>`;
  }

  private renderAxes(
    data: ChartData,
    labels: readonly string[],
    locale: string,
  ): TemplateResult {
    void locale;
    if (!data.showAxes) return svg``;
    const ticks = niceTicks(data.domain);
    const stride = Math.max(1, Math.ceil(labels.length / 6));
    return svg`<line
        class="chart-axis"
        x1=${PLOT_LEFT}
        y1=${PLOT_TOP}
        x2=${PLOT_LEFT}
        y2=${PLOT_BOTTOM}
      ></line>
      <line
        class="chart-axis"
        x1=${PLOT_LEFT}
        y1=${PLOT_BOTTOM}
        x2=${PLOT_RIGHT}
        y2=${PLOT_BOTTOM}
      ></line>
      ${ticks.map(
        (tick) =>
          svg`<text
            class="chart-tick chart-tick-label"
            x=${PLOT_LEFT - 4}
            y=${scaleY(tick, data.domain) + 4}
            text-anchor="end"
          >
            ${tick}
          </text>`,
      )}
      ${(() => {
        // Edge labels anchor inward so centered text never clips past the
        // plot frame; interior labels stay centered under their marks.
        const shown = labels
          .map((_, index) => index)
          .filter((index) => index % stride === 0);
        const first = shown[0] ?? -1;
        const last = shown[shown.length - 1] ?? -1;
        return labels.map((label, index) =>
          index % stride === 0
            ? svg`<text
                class="chart-tick chart-tick-label"
                x=${scaleX(index, labels.length)}
                y=${PLOT_BOTTOM + 14}
                text-anchor=${shown.length > 1 && index === first ? "start" : shown.length > 1 && index === last ? "end" : "middle"}
              >
                ${label.length > 10 ? `${label.slice(0, 9)}…` : label}
              </text>`
            : svg``,
        );
      })()}`;
  }

  private renderMarks(data: ChartData): TemplateResult {
    const count = data.rawLabels.length;
    if (data.style === "bar") {
      return svg`${data.series.map((entry) =>
        this.renderBarSeries(data, entry, count),
      )}`;
    }
    return svg`${data.series.map((entry) =>
      data.style === "area"
        ? svg`<path
            d=${seriesPaths(entry.points, data.domain, true).join(" ")}
            fill=${entry.color}
            fill-opacity="0.35"
            stroke="none"
          ></path>`
        : nothing,
    )}${data.series.map(
      (entry) =>
        svg`<path
          d=${seriesPaths(entry.points, data.domain, false).join(" ")}
          fill="none"
          stroke=${entry.color}
          stroke-width="2.5"
          stroke-linejoin="round"
          stroke-linecap="round"
        ></path>`,
    )}`;
  }

  private renderBarSeries(
    data: ChartData,
    entry: (typeof data.series)[number],
    count: number,
  ): TemplateResult {
    const self = data.series.indexOf(entry);
    const all = data.series.map((other) => other.points);
    return svg`${entry.points.map((_, pointIndex) => {
      const column = all.map((points) => points[pointIndex] ?? null);
      const rect =
        barRects(pointIndex, count, column, data.domain)[self] ?? null;
      if (!rect) return svg``;
      return svg`<rect
        x=${rect.x}
        y=${rect.y}
        width=${rect.width}
        height=${rect.height}
        fill=${entry.color}
      ></rect>`;
    })}`;
  }
}
