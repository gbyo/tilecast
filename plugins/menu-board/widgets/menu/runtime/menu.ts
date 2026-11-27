/**
 * Square Menu: menu items by category with prices, pictures, and sold-out
 * items, from the Square Menu Board feed.
 *
 * Operator choices from the feed page arrive as ordinary values: a sign
 * label replaces the name, the sign order sorts the items, and an item
 * with "Show on signs" off is left out. Prices and availability are always
 * Square's. A dataset past its staleAt shows a quiet notice, so a screen
 * that lost its connection does not present old prices as current.
 */
import { css, html, nothing, type TemplateResult } from "lit";
import {
  empty,
  failure,
  firstRecordsDataset,
  parseHexColor,
  ready,
  type ConfigResult,
  type WidgetRecord,
  type WidgetResources,
  type WidgetResolution,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import {
  boundText,
  TilecastWidgetElement,
  emptyState,
} from "@tilecast/widget-kit";

export interface MenuConfig {
  readonly dataSourceId: string;
  readonly nameField: string;
  readonly labelField: string;
  readonly descriptionField: string;
  readonly categoryField: string;
  readonly priceField: string;
  readonly currencyField: string;
  readonly availableField: string;
  readonly visibleField: string;
  readonly orderField: string;
  readonly imageField: string;
  readonly heading: string;
  readonly unavailableLabel: string;
  readonly showDescriptions: boolean;
  readonly showImages: boolean;
  readonly maximumItems: number;
  readonly accent: string | null;
}

export interface MenuItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly price: number | null;
  readonly currency: string;
  readonly available: boolean;
  readonly image: string | null;
}

export interface MenuSection {
  readonly title: string;
  readonly items: readonly MenuItem[];
}

export interface MenuData {
  readonly sections: readonly MenuSection[];
  readonly staleAtMs: number | null;
  readonly usingCachedData: boolean;
}

const text = (value: unknown, fallback: string, maximum: number) =>
  typeof value === "string" ? boundText(value, maximum) : fallback;

export function parseMenuConfig(value: unknown): ConfigResult<MenuConfig> {
  if (value === null || typeof value !== "object") {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const maximum =
    typeof raw.maximumItems === "number" ? Math.trunc(raw.maximumItems) : 60;
  return {
    ok: true,
    config: {
      dataSourceId: text(raw.dataSourceId, "", 80),
      nameField: text(raw.nameField, "name", 80),
      labelField: text(raw.labelField, "shortLabel", 80),
      descriptionField: text(raw.descriptionField, "description", 80),
      categoryField: text(raw.categoryField, "category", 80),
      priceField: text(raw.priceField, "price", 80),
      currencyField: text(raw.currencyField, "currency", 80),
      availableField: text(raw.availableField, "available", 80),
      visibleField: text(raw.visibleField, "visible", 80),
      orderField: text(raw.orderField, "order", 80),
      imageField: text(raw.imageField, "photo", 80),
      heading: text(raw.heading, "", 80),
      unavailableLabel:
        text(raw.unavailableLabel, "Sold out", 40) || "Sold out",
      showDescriptions: raw.showDescriptions === true,
      showImages: raw.showImages !== false,
      maximumItems: Math.min(
        100,
        Math.max(1, Number.isFinite(maximum) ? maximum : 60),
      ),
      accent:
        typeof raw.accent === "string" && raw.accent !== ""
          ? parseHexColor(raw.accent)
          : null,
    },
  };
}

const textOf = (value: WidgetValue | undefined) =>
  typeof value?.text === "string" ? value.text : "";
const numberOf = (value: WidgetValue | undefined): number | null =>
  typeof value?.number === "number"
    ? value.number
    : typeof value?.integer === "number"
      ? value.integer
      : null;

function item(
  config: MenuConfig,
  record: WidgetRecord,
  resources: WidgetResources,
): MenuItem {
  const values = record.values;
  const asset = values[config.imageField]?.assetId;
  return {
    id: record.id,
    name: boundText(
      textOf(values[config.labelField]) || textOf(values[config.nameField]),
      80,
    ),
    description: boundText(textOf(values[config.descriptionField]), 160),
    price: numberOf(values[config.priceField]),
    currency: textOf(values[config.currencyField]).toUpperCase(),
    available: values[config.availableField]?.boolean !== false,
    image:
      config.showImages && typeof asset === "string"
        ? resources.mediaForAsset(asset)
        : null,
  };
}

export function resolveMenuData(
  config: MenuConfig,
  resources: WidgetResources,
): WidgetResolution<MenuData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records = (dataset.records ?? [])
    .filter(
      (record) =>
        record.values[config.visibleField]?.boolean !== false &&
        textOf(record.values[config.nameField]) !== "",
    )
    .map((record, index) => ({
      record,
      order: numberOf(record.values[config.orderField]) ?? index,
    }))
    .sort((a, b) => a.order - b.order)
    .slice(0, config.maximumItems);
  if (records.length === 0) return empty("no_records");
  const sections: { title: string; items: MenuItem[] }[] = [];
  for (const { record } of records) {
    const title = boundText(textOf(record.values[config.categoryField]), 60);
    let section = sections.find((candidate) => candidate.title === title);
    if (!section) {
      section = { title, items: [] };
      sections.push(section);
    }
    section.items.push(item(config, record, resources));
  }
  const staleAt = dataset.cache.staleAt
    ? Date.parse(dataset.cache.staleAt)
    : Number.NaN;
  return ready({
    sections,
    staleAtMs: Number.isFinite(staleAt) ? staleAt : null,
    usingCachedData: dataset.cache.usingCachedData || dataset.cache.unavailable,
  });
}

/** A price in the item's currency, or the bare number without one. */
export function formatPrice(
  price: number,
  currency: string,
  locale: string,
): string {
  try {
    return new Intl.NumberFormat(
      locale,
      currency.length === 3
        ? { style: "currency", currency }
        : { minimumFractionDigits: 2 },
    ).format(price);
  } catch {
    return price.toFixed(2);
  }
}

export class TilecastMenuWidget extends TilecastWidgetElement<
  MenuConfig,
  MenuData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .menu {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-rows: auto 1fr auto;
        gap: var(--tc-gap);
        padding: var(--tc-gutter);
        overflow: hidden;
      }
      .sections {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(min(100%, 11em), 1fr));
        column-gap: 2.5em;
        row-gap: 1em;
        align-content: start;
        overflow: hidden;
      }
      .section h3 {
        margin: 0.3em 0 0.4em;
        border-bottom: 0.08em solid var(--tc-accent, currentColor);
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.35em;
      }
      li {
        display: grid;
        grid-template-columns: 1fr auto;
        align-items: center;
        gap: 0.5em;
      }
      ul.pictures li {
        grid-template-columns: auto 1fr auto;
      }
      li.unavailable .label,
      li.unavailable .price {
        opacity: 0.45;
        text-decoration: line-through;
      }
      img {
        width: 2.2em;
        height: 2.2em;
        object-fit: cover;
        border-radius: 0.3em;
      }
      .description {
        grid-column: -3 / -1;
        opacity: 0.7;
        font-size: 0.8em;
      }
      .tag {
        font-size: 0.7em;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--tc-accent, currentColor);
      }
      .stale {
        font-size: 0.75em;
        opacity: 0.75;
      }
    `,
  ];

  protected override themeOverrides(config: MenuConfig) {
    return { background: null, foreground: null, accent: config.accent };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (reason === "no_source")
      return emptyState({ title: this.config?.heading || "Menu" });
    return super.renderEmpty(reason);
  }

  private renderItem(item: MenuItem, pictures: boolean): TemplateResult {
    return html`<li class=${item.available ? "" : "unavailable"}>
      ${pictures ? (item.image ? html`<img src=${item.image} alt="" />` : html`<span></span>`) : nothing}
      <span class="name tc-body">
        <span class="label">${item.name}</span>
        ${item.available ? nothing : html`<span class="tag">${this.config.unavailableLabel}</span>`}
      </span>
      <span class="price tc-body"
        >${item.price === null ? "" : formatPrice(item.price, item.currency, this.context.locale)}</span
      >
      ${this.config.showDescriptions && item.description ? html`<span class="description">${item.description}</span>` : nothing}
    </li>`;
  }

  protected override renderContent(data: MenuData | null): TemplateResult {
    if (!data) return html``;
    const nowMs = this.context.clock.now();
    const stale =
      data.usingCachedData ||
      (data.staleAtMs !== null && nowMs >= data.staleAtMs);
    return html`<div class="menu">
      <div class="tc-title">${this.config.heading}</div>
      <div class="sections">
        ${data.sections.map((section) => {
          const pictures = section.items.some((item) => item.image !== null);
          return html`<section class="section">
            ${section.title ? html`<h3 class="tc-title">${section.title}</h3>` : nothing}
            <ul class=${pictures ? "pictures" : ""}>
              ${section.items.map((item) => this.renderItem(item, pictures))}
            </ul>
          </section>`;
        })}
      </div>
      <div>
        ${stale ? html`<div class="stale" role="note">Prices may be out of date.</div>` : nothing}
      </div>
    </div>`;
  }
}
