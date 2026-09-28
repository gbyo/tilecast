/**
 * Spotlight V2: one featured record as the hero of the Widget.
 *
 * The author picks a records source and maps semantic slots onto its
 * fields: title, subtitle, body, badge, and metadata. The first usable
 * prepared record is shown; Spotlight never sorts, aggregates, or queries.
 * Managed artwork arrives only through the presentation's media grant, and
 * ready is reported after the image decodes, following Image Notice.
 *
 * Layout is container queries only. Wide space sets artwork beside copy;
 * portrait stacks them; strips and small zones keep the title and drop
 * body and image before shrinking text into uselessness.
 */
import {
  css,
  html,
  nothing,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import {
  announceEmpty,
  announceError,
  announceReady,
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

const IDENTIFIER = /^[A-Za-z0-9-]{0,64}$/;

function assetRef(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || !IDENTIFIER.test(value)) return null;
  return value;
}

export interface SpotlightConfig {
  readonly dataSourceId: string;
  readonly titleField: string;
  readonly subtitleField: string;
  readonly bodyField: string;
  readonly badgeField: string;
  readonly metadataField: string;
  readonly assetId: string;
  readonly variantId: string;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface SpotlightData {
  readonly values: Readonly<Record<string, WidgetValue>>;
  readonly fields: Readonly<Record<string, WidgetField>>;
  /** The host-authorized artwork URI, or null. */
  readonly src: string | null;
}

export function parseSpotlightConfig(
  value: unknown,
): ConfigResult<SpotlightConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  const titleField = fieldRef(raw["titleField"]);
  const subtitleField = fieldRef(raw["subtitleField"]);
  const bodyField = fieldRef(raw["bodyField"]);
  const badgeField = fieldRef(raw["badgeField"]);
  const metadataField = fieldRef(raw["metadataField"]);
  if (
    titleField === null ||
    subtitleField === null ||
    bodyField === null ||
    badgeField === null ||
    metadataField === null
  ) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const image = (raw["image"] ?? {}) as Record<string, unknown>;
  const assetId = assetRef(image["assetId"]);
  const variantId = assetRef(image["variantId"]);
  if (assetId === null || variantId === null) {
    return { ok: false, problem: "image must name a media variant" };
  }
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  return {
    ok: true,
    config: {
      dataSourceId: source,
      titleField,
      subtitleField,
      bodyField,
      badgeField,
      metadataField,
      assetId,
      variantId,
      emptyText,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

/** Whether a raw value can render as a non-blank title. */
function hasDisplayValue(value: WidgetValue | null | undefined): boolean {
  if (!value) return false;
  if (typeof value.text === "string") return value.text.trim() !== "";
  if (typeof value.url === "string") return value.url.trim() !== "";
  return (
    typeof value.number === "number" ||
    typeof value.integer === "number" ||
    typeof value.boolean === "boolean" ||
    typeof value.date === "string" ||
    typeof value.datetime === "string" ||
    typeof value.durationSeconds === "number" ||
    typeof value.assetId === "string"
  );
}

export function resolveSpotlightData(
  config: SpotlightConfig,
  resources: WidgetResources,
): WidgetResolution<SpotlightData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  // The first record with a usable title: a leading record without one
  // must not blank the Widget when a later record has one. Spotlight is
  // still not a query engine: no sorting or filtering beyond this.
  const featured =
    config.titleField !== ""
      ? (records.find((record) =>
          hasDisplayValue(record.values[config.titleField]),
        ) ?? records[0]!)
      : records[0]!;
  const values = featured.values;
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  if (config.assetId === "") return ready({ values, fields, src: null });
  // Managed artwork arrives only through the media grant; without one the
  // Widget waits instead of fetching a record URL or showing a broken frame.
  const src = resources.media(config.assetId, config.variantId);
  return src ? ready({ values, fields, src }) : empty("image_unavailable");
}

export class TilecastSpotlightWidget extends TilecastWidgetElement<
  SpotlightConfig,
  SpotlightData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .spotlight-wrap {
        position: absolute;
        inset: 0;
        display: flex;
        min-height: 0;
        min-width: 0;
        padding: var(--tc-gutter);
      }
      .spotlight {
        display: flex;
        gap: min(4cqh, 4cqw);
        margin: auto;
        width: 100%;
        max-width: 1100px;
        min-height: 0;
        min-width: 0;
        align-items: center;
      }
      .spotlight-art {
        flex: 0 1 46%;
        min-width: 0;
        align-self: stretch;
        border-radius: var(--tc-radius, 4px);
        object-fit: cover;
        min-height: 80px;
      }
      .spotlight-copy {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: min(1.2cqh, 1.2cqw);
      }
      .spotlight-badge-row {
        display: flex;
        gap: min(1.6cqh, 1.6cqw);
        align-items: center;
        min-width: 0;
      }
      .spotlight-meta {
        font-size: clamp(10px, min(3.4cqh, 2.6cqw), 28px);
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .spotlight-title {
        font-size: clamp(18px, min(8cqh, 6cqw), 150px);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.15;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
      }
      .spotlight-subtitle {
        font-size: clamp(12px, min(4.6cqh, 3.4cqw), 60px);
        font-weight: 600;
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .spotlight-body {
        font-size: clamp(11px, min(4cqh, 3cqw), 44px);
        line-height: 1.4;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 4;
        -webkit-box-orient: vertical;
      }
      @container tc-widget (max-width: 560px) {
        .spotlight {
          flex-direction: column;
          justify-content: center;
        }
        .spotlight-art {
          flex: none;
          width: 100%;
          max-height: 38cqh;
        }
      }
      @container tc-widget (max-height: 170px) {
        .spotlight-art,
        .spotlight-body {
          display: none;
        }
        .spotlight {
          flex-direction: row;
        }
      }
      @container tc-widget (max-width: 240px) {
        .spotlight-art,
        .spotlight-body,
        .spotlight-meta {
          display: none;
        }
      }
    `,
  ];

  private decoding = 0;

  protected override themeOverrides(config: SpotlightConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: SpotlightData | null): TemplateResult {
    if (!data || !this.config) return html``;
    const locale = this.context.locale;
    const timeZone = this.context.timeZone;
    const slot = (key: string) =>
      key
        ? formatWidgetValue(data.values[key], data.fields[key], {
            locale,
            timeZone,
          }).trim()
        : "";
    const title = slot(this.config.titleField);
    const subtitle = slot(this.config.subtitleField);
    const body = slot(this.config.bodyField);
    const badgeText = slot(this.config.badgeField);
    const metadata = slot(this.config.metadataField);
    return html`<div class="spotlight-wrap">
      <div class="spotlight">
        ${
          data.src
            ? html`<img class="spotlight-art" src=${data.src} alt="" />`
            : nothing
        }
        <div class="spotlight-copy">
          <div class="spotlight-badge-row">
            ${badgeText ? badge(badgeText) : nothing}
            ${
              metadata
                ? html`<span class="spotlight-meta">${metadata}</span>`
                : nothing
            }
          </div>
          <div class="spotlight-title">${title}</div>
          ${
            subtitle
              ? html`<div class="spotlight-subtitle">${subtitle}</div>`
              : nothing
          }
          ${body ? html`<div class="spotlight-body">${body}</div>` : nothing}
        </div>
      </div>
    </div>`;
  }

  protected override updated(changed: PropertyValues): void {
    // Like Image Notice, ready waits for artwork to decode: the base
    // class would announce on first render, before the image exists.
    if (!["config", "data", "empty", "context"].some((key) => changed.has(key)))
      return;
    if (this.empty !== null) {
      announceEmpty(this, this.empty);
      return;
    }
    const image =
      this.renderRoot.querySelector<HTMLImageElement>(".spotlight-art");
    // Without artwork the copy is complete as rendered.
    if (!image || typeof image.decode !== "function") {
      announceReady(this);
      return;
    }
    const attempt = ++this.decoding;
    image.decode().then(
      () => {
        if (attempt === this.decoding) announceReady(this);
      },
      () => {
        if (attempt === this.decoding) announceError(this, "image_unavailable");
      },
    );
  }
}
