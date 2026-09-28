/**
 * List V2: generic repeated rows as the focal point of the Widget.
 *
 * The author picks a records source and maps its fields onto primary,
 * secondary, leading and trailing slots. Values format from their typed
 * metadata in the screen locale; the Widget never branches on the source
 * provider.
 *
 * Layout is container queries only. A wide strip sets rows side by side, a
 * small Layout zone keeps the primary value alone, without measuring
 * anything.
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
  formatWidgetValue,
  TilecastWidgetElement,
  emptyState,
} from "@tilecast/widget-kit";

export const LIST_DENSITIES = ["comfortable", "compact"] as const;
export type ListDensity = (typeof LIST_DENSITIES)[number];

export interface ListConfig {
  readonly dataSourceId: string;
  readonly primaryField: string;
  readonly secondaryField: string;
  readonly leadingField: string;
  readonly trailingField: string;
  readonly heading: string;
  readonly maximumItems: number;
  readonly emptyText: string;
  readonly density: ListDensity;
  readonly showDividers: boolean;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface ListRow {
  readonly id: string;
  readonly values: Readonly<Record<string, WidgetValue>>;
}

export interface ListData {
  readonly rows: readonly ListRow[];
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

export function parseListConfig(value: unknown): ConfigResult<ListConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200)
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  const primaryField = fieldRef(raw["primaryField"]);
  const secondaryField = fieldRef(raw["secondaryField"]);
  const leadingField = fieldRef(raw["leadingField"]);
  const trailingField = fieldRef(raw["trailingField"]);
  if (
    primaryField === null ||
    secondaryField === null ||
    leadingField === null ||
    trailingField === null
  ) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const heading = boundText(raw["heading"] ?? "", 120);
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  const maximumItems = raw["maximumItems"] ?? 8;
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
  const density = raw["density"] ?? "comfortable";
  if (!LIST_DENSITIES.includes(density as never)) {
    return { ok: false, problem: "density is not a List density" };
  }
  const showDividers = optionalBoolean(raw["showDividers"], true);
  if (showDividers === null) {
    return { ok: false, problem: "showDividers must be a boolean" };
  }
  return {
    ok: true,
    config: {
      dataSourceId: source,
      primaryField,
      secondaryField,
      leadingField,
      trailingField,
      heading,
      maximumItems,
      emptyText,
      density: density as ListDensity,
      showDividers,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveListData(
  config: ListConfig,
  resources: WidgetResources,
): WidgetResolution<ListData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records: readonly WidgetRecord[] = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  return ready({
    rows: records
      .slice(0, config.maximumItems)
      .map((record) => ({ id: record.id, values: record.values })),
    fields,
    total: records.length,
  });
}

export class TilecastListWidget extends TilecastWidgetElement<
  ListConfig,
  ListData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .list {
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
      .rows {
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .row {
        display: flex;
        align-items: center;
        gap: min(2.4cqh, 2.4cqw);
        min-width: 0;
        padding: min(1.8cqh, 1.8cqw) 0;
      }
      .rows[data-dividers] .row + .row {
        border-top: var(--tc-stroke) solid var(--tc-color-separator);
      }
      .leading {
        flex: none;
        font-size: clamp(10px, min(4cqh, 2.8cqw), 64px);
        font-weight: 600;
        color: var(--tc-color-fg-subtle);
        max-width: 30%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .main {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.15em;
      }
      .primary {
        font-size: clamp(12px, min(5.4cqh, 3.6cqw), 96px);
        font-weight: 600;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .secondary {
        font-size: clamp(10px, min(4cqh, 2.8cqw), 64px);
        font-weight: 500;
        color: var(--tc-color-fg-muted);
        line-height: 1.3;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .trailing {
        flex: none;
        font-size: clamp(11px, min(4.6cqh, 3cqw), 72px);
        font-weight: 600;
        color: var(--tc-color-fg-muted);
        max-width: 35%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .list[data-density="compact"] .row {
        padding: min(0.9cqh, 0.9cqw) 0;
        gap: min(1.6cqh, 1.6cqw);
      }
      .list[data-density="compact"] .secondary {
        display: none;
      }

      /* Wide strip: rows side by side, sized by height. */
      @container tc-widget (aspect-ratio > 2.4) {
        .rows {
          flex-direction: row;
          align-items: stretch;
          gap: 4cqh;
          overflow: hidden;
        }
        .rows[data-dividers] .row + .row {
          border-top: 0;
          border-left: var(--tc-stroke) solid var(--tc-color-separator);
          padding-left: 4cqh;
        }
        .row {
          flex: 1 1 0;
          min-width: 0;
        }
        .heading {
          font-size: clamp(12px, 7cqh, 110px);
        }
      }

      /* Small Layout zone: the primary value alone, first rows only. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .secondary,
        .leading,
        .trailing {
          display: none;
        }
        .row:nth-child(n + 5) {
          display: none;
        }
        .row {
          padding: min(1cqh, 1cqw) 0;
        }
      }
    `,
  ];

  protected override themeOverrides(config: ListConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: ListData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const cell = (record: ListRow, key: string): string => {
      if (key === "") return "";
      return formatWidgetValue(record.values[key], data.fields[key], {
        locale,
      });
    };
    return html`<div class="list" data-density=${this.config.density}>
      ${
        this.config.heading
          ? html`<div class="heading">${this.config.heading}</div>`
          : nothing
      }
      <div class="rows" ?data-dividers=${this.config.showDividers}>
        ${data.rows.map((record) => {
          const primary = cell(record, this.config.primaryField);
          const secondary = cell(record, this.config.secondaryField);
          const leading = cell(record, this.config.leadingField);
          const trailing = cell(record, this.config.trailingField);
          if (!primary && !secondary && !leading && !trailing) return nothing;
          return html`<div class="row">
            ${leading ? html`<div class="leading">${leading}</div>` : nothing}
            <div class="main">
              ${primary ? html`<div class="primary">${primary}</div>` : nothing}
              ${
                secondary
                  ? html`<div class="secondary">${secondary}</div>`
                  : nothing
              }
            </div>
            ${
              trailing ? html`<div class="trailing">${trailing}</div>` : nothing
            }
          </div>`;
        })}
      </div>
    </div>`;
  }
}
