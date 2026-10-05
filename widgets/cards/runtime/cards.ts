/**
 * Cards V2: generic record cards as the focal point of the Widget.
 *
 * The author picks a records source and maps its fields onto title,
 * subtitle, body, image, badge and metadata slots. Values format from
 * their typed metadata in the screen locale; the Widget never branches on
 * the source provider.
 *
 * Each card owns a second container query, so cards reflow inside the
 * grid as the zone changes shape. Images render only when the mapped
 * value resolves through the Widget's own media grant; anything else
 * stays hidden, and no column counts or breakpoints are authored.
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

export const CARDS_DENSITIES = ["comfortable", "compact"] as const;
export type CardsDensity = (typeof CARDS_DENSITIES)[number];

export interface CardsConfig {
  readonly dataSourceId: string;
  readonly titleField: string;
  readonly subtitleField: string;
  readonly bodyField: string;
  readonly imageField: string;
  readonly badgeField: string;
  readonly metadataField: string;
  readonly heading: string;
  readonly maximumItems: number;
  readonly emptyText: string;
  readonly density: CardsDensity;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface CardsCard {
  readonly id: string;
  readonly values: Readonly<Record<string, WidgetValue>>;
  /**
   * A host-authorized image URI resolved through the Widget's own media
   * grant, or "". Text slots format at render time in the screen locale.
   */
  readonly imageUri: string;
}

export type CardSlot =
  "title" | "subtitle" | "body" | "image" | "badge" | "metadata";

export interface CardsData {
  readonly cards: readonly CardsCard[];
  readonly fields: Readonly<Record<string, WidgetField>>;
  readonly total: number;
}

/** The CardsConfig keys that name mapped source fields. */
type CardFieldKey =
  | "titleField"
  | "subtitleField"
  | "bodyField"
  | "imageField"
  | "badgeField"
  | "metadataField";

const SLOT_KEYS: Readonly<Record<CardSlot, CardFieldKey>> = {
  title: "titleField",
  subtitle: "subtitleField",
  body: "bodyField",
  image: "imageField",
  badge: "badgeField",
  metadata: "metadataField",
};

function fieldRef(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 120) return null;
  return value;
}

export function parseCardsConfig(value: unknown): ConfigResult<CardsConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  const slots: Record<CardSlot, string | null> = {
    title: fieldRef(raw["titleField"]),
    subtitle: fieldRef(raw["subtitleField"]),
    body: fieldRef(raw["bodyField"]),
    image: fieldRef(raw["imageField"]),
    badge: fieldRef(raw["badgeField"]),
    metadata: fieldRef(raw["metadataField"]),
  };
  for (const [slot, key] of Object.entries(slots)) {
    if (key === null) {
      return { ok: false, problem: `${slot} must be a field name` };
    }
  }
  const heading = boundText(raw["heading"] ?? "", 120);
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  const maximumItems = raw["maximumItems"] ?? 6;
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
  if (!CARDS_DENSITIES.includes(density as never)) {
    return { ok: false, problem: "density is not a Cards density" };
  }
  return {
    ok: true,
    config: {
      dataSourceId: source,
      titleField: slots.title as string,
      subtitleField: slots.subtitle as string,
      bodyField: slots.body as string,
      imageField: slots.image as string,
      badgeField: slots.badge as string,
      metadataField: slots.metadata as string,
      heading,
      maximumItems,
      emptyText,
      density: density as CardsDensity,
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

function imageUri(
  value: WidgetValue | undefined,
  resources: WidgetResources,
): string {
  // Record asset values carry no variant. They resolve only when the host
  // granted exactly one verified variant for that asset.
  if (!value || value.kind !== "asset" || !value.assetId) return "";
  return resources.mediaForAsset(value.assetId) ?? "";
}

/** A record carries something worth showing when a mapped slot holds data. */
function hasDisplayableValue(
  record: WidgetRecord,
  config: CardsConfig,
): boolean {
  for (const slot of Object.keys(SLOT_KEYS) as CardSlot[]) {
    const key = config[SLOT_KEYS[slot]];
    if (key === "") continue;
    const value = record.values[key];
    if (!value) continue;
    if (
      typeof value.text === "string" ||
      typeof value.url === "string" ||
      typeof value.number === "number" ||
      typeof value.integer === "number" ||
      typeof value.boolean === "boolean" ||
      typeof value.date === "string" ||
      typeof value.datetime === "string" ||
      typeof value.durationSeconds === "number" ||
      (value.kind === "asset" && value.assetId)
    ) {
      return true;
    }
  }
  return false;
}

export function resolveCardsData(
  config: CardsConfig,
  resources: WidgetResources,
): WidgetResolution<CardsData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records: readonly WidgetRecord[] = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  const cards: CardsCard[] = [];
  for (const record of records.slice(0, config.maximumItems)) {
    if (!hasDisplayableValue(record, config)) continue;
    const imageKey = config[SLOT_KEYS.image];
    cards.push({
      id: record.id,
      values: record.values,
      imageUri:
        imageKey === "" ? "" : imageUri(record.values[imageKey], resources),
    });
  }
  if (cards.length === 0) return empty("no_records");
  return ready({ cards, fields, total: records.length });
}

export class TilecastCardsWidget extends TilecastWidgetElement<
  CardsConfig,
  CardsData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .cards-wrap {
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
      .grid {
        display: grid;
        grid-template-columns: 1fr;
        gap: min(2.4cqh, 2.4cqw);
        min-height: 0;
        overflow: hidden;
      }
      @container tc-widget (min-width: 340px) {
        .grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @container tc-widget (min-width: 720px) {
        .grid {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      .card {
        container-type: inline-size;
        display: flex;
        flex-direction: column;
        min-width: 0;
        background: var(--tc-color-surface);
        border-radius: min(1.4cqh, 1.4cqw);
        overflow: hidden;
      }
      .photo {
        width: 100%;
        height: 22cqw;
        max-height: 38%;
        object-fit: cover;
        flex: none;
      }
      .words {
        display: flex;
        flex-direction: column;
        gap: 0.3em;
        padding: min(2cqh, 2cqw);
        min-width: 0;
      }
      .title {
        font-size: clamp(12px, 7cqi, 72px);
        font-weight: 600;
        line-height: 1.2;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .subtitle {
        font-size: clamp(10px, 5.4cqi, 48px);
        font-weight: 600;
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .body {
        font-size: clamp(10px, 5cqi, 44px);
        line-height: 1.4;
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
      }
      .badge {
        align-self: flex-start;
        font-size: clamp(9px, 4.6cqi, 36px);
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--tc-color-accent);
      }
      .metadata {
        font-size: clamp(9px, 4.4cqi, 34px);
        color: var(--tc-color-fg-subtle);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cards-wrap[data-density="compact"] .body {
        display: none;
      }
      .cards-wrap[data-density="compact"] .words {
        gap: 0.15em;
        padding: min(1.4cqh, 1.4cqw);
      }

      /* Small Layout zone: titles carry the grid. */
      @container tc-widget (max-width: 200px) {
        .subtitle,
        .body,
        .metadata {
          display: none;
        }
      }
    `,
  ];

  protected override themeOverrides(config: CardsConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: CardsData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const slot = (
      card: CardsCard,
      name: Exclude<CardSlot, "image">,
    ): string => {
      const key = this.config[SLOT_KEYS[name]];
      if (key === "") return "";
      return formatWidgetValue(card.values[key], data.fields[key], { locale });
    };
    return html`<div class="cards-wrap" data-density=${this.config.density}>
      ${
        this.config.heading
          ? html`<div class="heading">${this.config.heading}</div>`
          : nothing
      }
      <div class="grid">
        ${data.cards.map((card) => {
          const title = slot(card, "title");
          const subtitle = slot(card, "subtitle");
          const body = slot(card, "body");
          const badge = slot(card, "badge");
          const metadata = slot(card, "metadata");
          return html`<article class="card">
            ${
              card.imageUri
                ? html`<img
                    class="photo"
                    src=${card.imageUri}
                    alt=""
                    loading="lazy"
                  />`
                : nothing
            }
            <div class="words">
              ${badge ? html`<div class="badge">${badge}</div>` : nothing}
              ${title ? html`<div class="title">${title}</div>` : nothing}
              ${
                subtitle
                  ? html`<div class="subtitle">${subtitle}</div>`
                  : nothing
              }
              ${body ? html`<div class="body">${body}</div>` : nothing}
              ${
                metadata
                  ? html`<div class="metadata">${metadata}</div>`
                  : nothing
              }
            </div>
          </article>`;
        })}
      </div>
    </div>`;
  }
}
