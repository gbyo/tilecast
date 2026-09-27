/**
 * Table V2: generic record comparison as the focal point of the Widget.
 *
 * The author picks a records source and a bounded set of columns; each
 * column names a field, an optional label, and an alignment. Values format
 * from their typed metadata in the screen locale, so columns never need
 * manual format strings. A column with no usable field is skipped, never
 * rendered blank.
 *
 * Layout is container queries only. A small Layout zone keeps the first
 * two columns, without measuring anything.
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
} from "@tilecast/widget-sdk";
import {
  boundText,
  formatWidgetValue,
  TilecastWidgetElement,
  emptyState,
} from "@tilecast/widget-kit";

export const TABLE_DENSITIES = ["comfortable", "compact"] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];

export const TABLE_ALIGNMENTS = ["auto", "left", "center", "right"] as const;
export type TableAlignment = (typeof TABLE_ALIGNMENTS)[number];

export interface TableColumn {
  readonly field: string;
  readonly label: string;
  readonly align: TableAlignment;
}

export interface TableConfig {
  readonly dataSourceId: string;
  readonly columns: readonly TableColumn[];
  readonly heading: string;
  readonly maximumRows: number;
  readonly emptyText: string;
  readonly showHeader: boolean;
  readonly density: TableDensity;
  readonly alternatingRows: boolean;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface TableData {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly WidgetRecord[];
  readonly fields: Readonly<Record<string, WidgetField>>;
  readonly total: number;
}

function columnAlign(value: unknown, legacy: unknown): TableAlignment | null {
  for (const candidate of [value, legacy]) {
    if (candidate === undefined || candidate === null || candidate === "")
      continue;
    // Superseded per-column presentations named alignment `alignment`.
    if (
      candidate === "auto" ||
      candidate === "left" ||
      candidate === "center" ||
      candidate === "right"
    ) {
      return candidate;
    }
  }
  return null;
}

function parseColumn(value: unknown): TableColumn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const field = raw["field"];
  if (typeof field !== "string" || field === "" || field.length > 120) {
    return null;
  }
  const label = raw["label"];
  const align = columnAlign(raw["align"], raw["alignment"]);
  if (
    (label !== undefined && (typeof label !== "string" || label.length > 60)) ||
    align === null
  ) {
    return null;
  }
  return { field, label: label ?? "", align: align ?? "auto" };
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

export function parseTableConfig(value: unknown): ConfigResult<TableConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = raw["dataSourceId"];
  if (
    (source !== undefined && source !== null && typeof source !== "string") ||
    (typeof source === "string" && source.length > 200)
  ) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  const items = raw["columns"];
  if (items !== undefined && !Array.isArray(items)) {
    return { ok: false, problem: "columns must be a list of columns" };
  }
  const columns: TableColumn[] = [];
  for (const item of items ?? []) {
    const column = parseColumn(item);
    if (column === null) {
      return { ok: false, problem: "every column must name a field" };
    }
    columns.push(column);
  }
  if (columns.length === 0 && Array.isArray(raw["legacyFields"])) {
    // Superseded configurations selected fields without per-column
    // presentation; those fields become plain left-aligned columns.
    for (const key of raw["legacyFields"]) {
      if (typeof key === "string" && key !== "" && key.length <= 120) {
        columns.push({ field: key, label: "", align: "auto" });
      }
    }
  }
  const heading = boundText(raw["heading"] ?? "", 120);
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  const maximumRows = raw["maximumRows"] ?? 10;
  if (
    typeof maximumRows !== "number" ||
    !Number.isInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > 100
  ) {
    return {
      ok: false,
      problem: "maximumRows must be an integer from 1 to 100",
    };
  }
  const density = raw["density"] ?? "comfortable";
  if (!TABLE_DENSITIES.includes(density as never)) {
    return { ok: false, problem: "density is not a Table density" };
  }
  const showHeader = optionalBoolean(raw["showHeader"], false);
  const alternatingRows = optionalBoolean(raw["alternatingRows"], false);
  if (showHeader === null || alternatingRows === null) {
    return {
      ok: false,
      problem: "header and striping options must be booleans",
    };
  }
  return {
    ok: true,
    config: {
      dataSourceId: typeof source === "string" ? source : "",
      columns,
      heading,
      maximumRows,
      emptyText,
      showHeader,
      density: density as TableDensity,
      alternatingRows,
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveTableData(
  config: TableConfig,
  resources: WidgetResources,
): WidgetResolution<TableData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records: readonly WidgetRecord[] = dataset.records ?? [];
  if (records.length === 0 || config.columns.length === 0) {
    return empty("no_records");
  }
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  return ready({
    columns: config.columns,
    rows: records.slice(0, config.maximumRows),
    fields,
    total: records.length,
  });
}

/** Semantic alignment: numbers right, everything else left. */
function effectiveAlign(
  column: TableColumn,
  field: WidgetField | undefined,
): "left" | "center" | "right" {
  if (column.align !== "auto") return column.align;
  const type = field?.type;
  return type === "number" || type === "integer" || type === "currency"
    ? "right"
    : "left";
}

export class TilecastTableWidget extends TilecastWidgetElement<
  TableConfig,
  TableData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .table-wrap {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        min-height: 0;
        padding: var(--tc-gutter);
      }
      .heading {
        font-size: clamp(12px, min(6.5cqh, 4.2cqw), 110px);
        font-weight: 600;
        letter-spacing: -0.01em;
        line-height: 1.2;
        margin-bottom: min(2cqh, 2cqw);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      table.grid {
        border-collapse: collapse;
        width: 100%;
        font-size: clamp(11px, min(4.6cqh, 3.2cqw), 80px);
        line-height: 1.35;
      }
      .grid th,
      .grid td {
        padding: min(1.4cqh, 1.4cqw) min(2cqh, 2cqw);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 40cqw;
      }
      .grid thead th {
        font-weight: 600;
        color: var(--tc-color-fg-muted);
        border-bottom: var(--tc-stroke) solid var(--tc-color-separator);
      }
      .grid tbody td {
        border-bottom: 1px solid var(--tc-color-separator);
      }
      .grid tbody tr:last-child td {
        border-bottom: 0;
      }
      .grid[data-stripes] tbody tr:nth-child(even) td {
        background: var(--tc-color-surface);
      }
      .grid .numeric {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .grid .center {
        text-align: center;
      }
      .table-wrap[data-density="compact"] .grid th,
      .table-wrap[data-density="compact"] .grid td {
        padding: min(0.7cqh, 0.7cqw) min(1.4cqh, 1.4cqw);
      }

      /* Small Layout zone: the first two columns carry the comparison. */
      @container tc-widget (max-width: 200px) {
        .grid th:nth-child(n + 3),
        .grid td:nth-child(n + 3) {
          display: none;
        }
      }
      @container tc-widget (max-height: 150px) {
        .grid tbody tr:nth-child(n + 4) {
          display: none;
        }
      }
    `,
  ];

  protected override themeOverrides(config: TableConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: TableData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const visible = data.columns.filter((column) =>
      data.rows.some(
        (record) =>
          formatWidgetValue(
            record.values[column.field],
            data.fields[column.field],
            {
              locale,
            },
          ).trim() !== "",
      ),
    );
    if (visible.length === 0) return html``;
    const cell = (record: TableData["rows"][number], column: TableColumn) =>
      formatWidgetValue(
        record.values[column.field],
        data.fields[column.field],
        {
          locale,
        },
      );
    return html`<div class="table-wrap" data-density=${this.config.density}>
      ${
        this.config.heading
          ? html`<div class="heading">${this.config.heading}</div>`
          : nothing
      }
      <table class="grid" ?data-stripes=${this.config.alternatingRows}>
        ${
          this.config.showHeader
            ? html`<thead>
                <tr>
                  ${visible.map((column) => {
                    const field = data.fields[column.field];
                    const align = effectiveAlign(column, field);
                    return html`<th
                      class=${
                        align === "right"
                          ? "numeric"
                          : align === "center"
                            ? "center"
                            : nothing
                      }
                      scope="col"
                    >
                      ${column.label || field?.label || column.field}
                    </th>`;
                  })}
                </tr>
              </thead>`
            : nothing
        }
        <tbody>
          ${data.rows.map(
            (record) =>
              html`<tr>
                ${visible.map((column) => {
                  const align = effectiveAlign(
                    column,
                    data.fields[column.field],
                  );
                  return html`<td
                    class=${
                      align === "right"
                        ? "numeric"
                        : align === "center"
                          ? "center"
                          : nothing
                    }
                  >
                    ${cell(record, column)}
                  </td>`;
                })}
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
  }
}
