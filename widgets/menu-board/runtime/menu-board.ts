/**
 * Menu Board V2: item/description/price presentation with optional sections.
 *
 * The author connects a records source and maps its fields onto title,
 * description, price and category slots (suggested automatically from
 * semantic roles). The component owns section grouping, price alignment
 * and the responsive column layout; any records source with mappable
 * fields can feed it, never only one blessed source.
 *
 * Layout is container queries only: one section column by default, two on
 * wide frames, compact rows in short strips. Prices align on a tabular
 * baseline and format from their typed metadata in the screen locale.
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

export const MENU_BOARD_DENSITIES = ["comfortable", "compact"] as const;
export type MenuBoardDensity = (typeof MENU_BOARD_DENSITIES)[number];

export interface MenuBoardConfig {
  readonly dataSourceId: string;
  readonly titleField: string;
  readonly descriptionField: string;
  readonly priceField: string;
  readonly categoryField: string;
  readonly heading: string;
  readonly maximumItems: number;
  readonly emptyText: string;
  readonly density: MenuBoardDensity;
  readonly showDividers: boolean;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface MenuBoardItem {
  readonly id: string;
  readonly values: Readonly<Record<string, WidgetValue>>;
}

export interface MenuBoardData {
  readonly items: readonly MenuBoardItem[];
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

export function parseMenuBoardConfig(
  value: unknown,
): ConfigResult<MenuBoardConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200)
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  const titleField = fieldRef(raw["titleField"]);
  const descriptionField = fieldRef(raw["descriptionField"]);
  const priceField = fieldRef(raw["priceField"]);
  const categoryField = fieldRef(raw["categoryField"]);
  if (
    titleField === null ||
    descriptionField === null ||
    priceField === null ||
    categoryField === null
  ) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const heading = boundText(raw["heading"] ?? "", 120);
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  const maximumItems = raw["maximumItems"] ?? 12;
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
  if (!MENU_BOARD_DENSITIES.includes(density as never)) {
    return { ok: false, problem: "density is not a Menu Board density" };
  }
  const showDividers = optionalBoolean(raw["showDividers"], true);
  if (showDividers === null) {
    return { ok: false, problem: "showDividers must be a boolean" };
  }
  return {
    ok: true,
    config: {
      dataSourceId: source,
      titleField,
      descriptionField,
      priceField,
      categoryField,
      heading,
      maximumItems,
      emptyText,
      density: density as MenuBoardDensity,
      showDividers,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveMenuBoardData(
  config: MenuBoardConfig,
  resources: WidgetResources,
): WidgetResolution<MenuBoardData> {
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
    items: records
      .slice(0, config.maximumItems)
      .map((record) => ({ id: record.id, values: record.values })),
    fields,
    total: records.length,
  });
}

/**
 * Group items into sections by their formatted category text. Sections keep
 * first-appearance order; uncategorized items gather last under no heading.
 * Grouping formats here, in the element, because the category display text
 * depends on the screen locale.
 */
export function groupMenuSections(
  items: readonly MenuBoardItem[],
  fields: Readonly<Record<string, WidgetField>>,
  categoryField: string,
  locale: string,
): MenuBoardSection[] {
  const order: string[] = [];
  const byCategory = new Map<string, MenuBoardItem[]>();
  for (const item of items) {
    const category =
      categoryField === ""
        ? ""
        : formatWidgetValue(item.values[categoryField], fields[categoryField], {
            locale,
          });
    if (!byCategory.has(category)) {
      byCategory.set(category, []);
      order.push(category);
    }
    byCategory.get(category)?.push(item);
  }
  // Uncategorized items read last even when they appear first.
  const named = order.filter((category) => category !== "");
  if (byCategory.has("")) named.push("");
  return named.map((category) => ({
    category,
    items: byCategory.get(category) ?? [],
  }));
}

export interface MenuBoardSection {
  /** Display text of the section, or "" for uncategorized items. */
  readonly category: string;
  readonly items: readonly MenuBoardItem[];
}

export class TilecastMenuBoardWidget extends TilecastWidgetElement<
  MenuBoardConfig,
  MenuBoardData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .menu {
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
      .sections {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: min(3.2cqh, 3.2cqw);
        min-height: 0;
        overflow: hidden;
      }
      .section-name {
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
      .item {
        display: flex;
        align-items: baseline;
        gap: min(2cqh, 2cqw);
        min-width: 0;
        padding: min(1.4cqh, 1.4cqw) 0;
      }
      .menu[data-dividers] .item + .item {
        border-top: var(--tc-stroke) solid var(--tc-color-separator);
      }
      .dish {
        flex: 1 1 auto;
        min-width: 0;
      }
      .title {
        font-size: clamp(12px, min(5.6cqh, 3.8cqw), 96px);
        font-weight: 600;
        line-height: 1.25;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .description {
        font-size: clamp(10px, min(4.2cqh, 2.9cqw), 68px);
        font-weight: 500;
        color: var(--tc-color-fg-muted);
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .price {
        flex: none;
        font-size: clamp(12px, min(5.2cqh, 3.4cqw), 88px);
        font-weight: 650;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .menu[data-density="compact"] .item {
        padding: min(0.7cqh, 0.7cqw) 0;
      }
      .menu[data-density="compact"] .description {
        display: none;
      }

      /* Wide frame: sections flow into two columns. */
      @container tc-widget (min-width: 900px) {
        .sections {
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          column-gap: 5cqw;
          align-items: start;
        }
      }

      /* Small Layout zone: titles and prices only, first items. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .description,
        .section-name {
          display: none;
        }
        .item:nth-child(n + 5) {
          display: none;
        }
        .item {
          padding: min(1cqh, 1cqw) 0;
        }
      }
    `,
  ];

  protected override themeOverrides(config: MenuBoardConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: MenuBoardData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const cell = (item: MenuBoardItem, key: string): string => {
      if (key === "") return "";
      return formatWidgetValue(item.values[key], data.fields[key], {
        locale,
      });
    };
    const sections = groupMenuSections(
      data.items,
      data.fields,
      this.config.categoryField,
      locale,
    );
    return html`<div
      class="menu"
      data-density=${this.config.density}
      ?data-dividers=${this.config.showDividers}
    >
      ${
        this.config.heading
          ? html`<div class="heading">${this.config.heading}</div>`
          : nothing
      }
      <div class="sections">
        ${sections.map(
          (section) =>
            html`<section>
              ${
                section.category
                  ? html`<div class="section-name">${section.category}</div>`
                  : nothing
              }
              ${section.items.map((item) => {
                const title = cell(item, this.config.titleField);
                const description = cell(item, this.config.descriptionField);
                const price = cell(item, this.config.priceField);
                if (!title && !description && !price) return nothing;
                return html`<div class="item">
                  <div class="dish">
                    ${title ? html`<div class="title">${title}</div>` : nothing}
                    ${
                      description
                        ? html`<div class="description">${description}</div>`
                        : nothing
                    }
                  </div>
                  ${price ? html`<div class="price">${price}</div>` : nothing}
                </div>`;
              })}
            </section>`,
        )}
      </div>
    </div>`;
  }
}
