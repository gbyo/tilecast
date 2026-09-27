/**
 * Ticker V2: one scrolling line of short items from any compatible records
 * source. An RSS or Atom feed is one common source; a manual records
 * source, a Google Sheet, a plugin Data Source, or any other compatible
 * records source works the same way. The Widget never branches on the
 * source provider.
 *
 * The author maps a primary text field and an optional secondary field.
 * Persisted legacy tickers named a single field or up to three ordered
 * fields instead; those project through legacyFields and resolve to the
 * same slots. Speed is one bounded choice, never a free duration, and the
 * scroll freezes under reduced motion.
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
  boundText,
  formatWidgetValue,
  TilecastWidgetElement,
  emptyState,
} from "@tilecast/widget-kit";

export const TICKER_DIRECTIONS = ["left", "right"] as const;
export type TickerDirection = (typeof TICKER_DIRECTIONS)[number];

export const TICKER_SPEEDS = ["slow", "normal", "fast"] as const;
export type TickerSpeed = (typeof TICKER_SPEEDS)[number];

/** Seconds for one full loop of the longest supported line, by speed. */
const SPEED_SECONDS: Record<TickerSpeed, number> = {
  slow: 60,
  normal: 40,
  fast: 25,
};

export interface TickerConfig {
  readonly dataSourceId: string;
  readonly primaryField: string;
  readonly secondaryField: string;
  readonly legacyFields: readonly string[];
  readonly legacyContentMode: string;
  readonly leadingLabel: string;
  readonly separator: string;
  readonly fieldSeparator: string;
  readonly maxItems: number;
  readonly direction: TickerDirection;
  readonly speed: TickerSpeed;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface TickerItem {
  readonly id: string;
  readonly values: Readonly<Record<string, WidgetValue>>;
}

export interface TickerData {
  readonly items: readonly TickerItem[];
  readonly primaryKey: string;
  readonly secondaryKey: string;
  readonly fields: Readonly<Record<string, WidgetField>>;
  readonly total: number;
}

const MAX_FIELD_LENGTH = 120;

function fieldRef(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

function boundedText(
  value: unknown,
  fallback: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") return null;
  const text = value.slice(0, maxLength);
  return text === "" ? fallback : text;
}

export function parseTickerConfig(value: unknown): ConfigResult<TickerConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200)
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  const primaryField = fieldRef(raw["primaryField"]);
  const secondaryField = fieldRef(raw["secondaryField"]);
  if (primaryField === null || secondaryField === null) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  // Persisted legacy tickers carried an ordered field list of up to three.
  const legacyFields: string[] = [];
  if (Array.isArray(raw["legacyFields"])) {
    for (const entry of raw["legacyFields"].slice(0, 3)) {
      if (typeof entry !== "string") {
        return { ok: false, problem: "legacy fields must be field names" };
      }
      const name = entry.slice(0, MAX_FIELD_LENGTH);
      if (name !== "") legacyFields.push(name);
    }
  } else if (raw["legacyFields"] !== undefined) {
    return { ok: false, problem: "legacy fields must be field names" };
  }
  // Persisted RSS Tickers named a content mode instead of fields: title and
  // source, or title and publication time. Anything else scrolls titles.
  const legacyContentMode = fieldRef(raw["legacyContentMode"]);
  if (legacyContentMode === null) {
    return { ok: false, problem: "legacy content mode must be text" };
  }
  const leadingLabel = boundText(raw["leadingLabel"] ?? "", 24);
  const separator = boundedText(raw["separator"] ?? "", " • ", 12);
  const fieldSeparator = boundedText(raw["fieldSeparator"] ?? "", " — ", 12);
  if (separator === null || fieldSeparator === null) {
    return { ok: false, problem: "separators must be short text" };
  }
  const maxItems = raw["maxItems"] ?? 15;
  if (
    typeof maxItems !== "number" ||
    !Number.isInteger(maxItems) ||
    maxItems < 1 ||
    maxItems > 50
  ) {
    return {
      ok: false,
      problem: "maxItems must be an integer from 1 to 50",
    };
  }
  const direction = raw["direction"] ?? "left";
  if (!TICKER_DIRECTIONS.includes(direction as never)) {
    return { ok: false, problem: "direction must be left or right" };
  }
  const speed = raw["speed"] ?? "normal";
  if (!TICKER_SPEEDS.includes(speed as never)) {
    return { ok: false, problem: "speed must be slow, normal or fast" };
  }
  const emptyText = boundText(raw["emptyText"] ?? "", 240);
  return {
    ok: true,
    config: {
      dataSourceId: source,
      primaryField,
      secondaryField,
      legacyFields,
      legacyContentMode,
      leadingLabel,
      separator,
      fieldSeparator,
      maxItems,
      direction: direction as TickerDirection,
      speed: speed as TickerSpeed,
      emptyText,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveTickerData(
  config: TickerConfig,
  resources: WidgetResources,
): WidgetResolution<TickerData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  const contentModeSecondary =
    config.legacyContentMode === "title_source"
      ? "source"
      : config.legacyContentMode === "title_time"
        ? "date"
        : "";
  const primaryKey = config.primaryField || config.legacyFields[0] || "";
  const secondaryKey =
    config.secondaryField ||
    config.legacyFields[1] ||
    contentModeSecondary ||
    "";
  if (primaryKey === "") return failure("incompatible_source");
  // Values stay raw so rendering formats them in the screen locale; an item
  // without any primary text carries nothing to scroll.
  const items: TickerItem[] = [];
  for (const record of records.slice(0, config.maxItems)) {
    const primary = formatWidgetValue(
      record.values[primaryKey],
      fields[primaryKey],
      {
        locale: "en",
      },
    );
    if (primary === "") continue;
    items.push({ id: record.id, values: record.values });
  }
  if (items.length === 0) return empty("no_records");
  return ready({
    items,
    primaryKey,
    secondaryKey,
    fields,
    total: records.length,
  });
}

export class TilecastTickerWidget extends TilecastWidgetElement<
  TickerConfig,
  TickerData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .ticker {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        min-height: 0;
        padding: 0 var(--tc-gutter);
        overflow: hidden;
      }
      .label {
        flex: none;
        font-size: clamp(10px, min(4.5cqh, 3cqw), 72px);
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--tc-color-fg-subtle);
        border: var(--tc-stroke) solid var(--tc-color-separator);
        border-radius: 0.4em;
        padding: 0.3em 0.7em;
        margin-right: 1em;
      }
      .viewport {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        mask-image: linear-gradient(
          to right,
          transparent,
          black 3%,
          black 97%,
          transparent
        );
      }
      .track {
        display: inline-flex;
        align-items: center;
        white-space: nowrap;
        will-change: transform;
        animation: tc-ticker-scroll var(--tc-ticker-seconds, 40s) linear
          infinite;
      }
      .ticker[data-direction="right"] .track {
        animation-direction: reverse;
      }
      .item {
        font-size: clamp(12px, min(6cqh, 4cqw), 110px);
        font-weight: 600;
        line-height: 1.3;
      }
      .item .secondary {
        font-weight: 500;
        color: var(--tc-color-fg-muted);
      }
      .gap {
        padding: 0 0.75em;
        color: var(--tc-color-fg-subtle);
      }
      @keyframes tc-ticker-scroll {
        from {
          transform: translateX(0);
        }
        to {
          transform: translateX(-50%);
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .track {
          animation: none;
        }
      }
    `,
  ];

  protected override themeOverrides(config: TickerConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: TickerData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const cell = (item: TickerItem, key: string): string => {
      if (key === "") return "";
      return formatWidgetValue(item.values[key], data.fields[key], {
        locale,
      });
    };
    const entries: { primary: string; secondary: string }[] = [];
    for (const item of data.items) {
      const primary = cell(item, data.primaryKey);
      if (!primary) continue;
      entries.push({ primary, secondary: cell(item, data.secondaryKey) });
    }
    if (entries.length === 0) return html``;
    // One half ends with its separator, and the line renders twice, so the
    // -50% loop has no visible seam.
    const half = html`${entries.map(
      (entry) =>
        html`<span class="item"
            >${entry.primary}${
            entry.secondary
              ? html`<span class="secondary"
                  >${this.config.fieldSeparator}${entry.secondary}</span
                >`
              : nothing
          }</span
          ><span class="gap" aria-hidden="true"
            >${this.config.separator}</span
          >`,
    )}`;
    return html`<div
      class="ticker"
      data-direction=${this.config.direction}
      style="--tc-ticker-seconds:${SPEED_SECONDS[this.config.speed]}s"
    >
      ${
        this.config.leadingLabel
          ? html`<span class="label">${this.config.leadingLabel}</span>`
          : nothing
      }
      <div class="viewport">
        <div class="track">${half}${half}</div>
      </div>
    </div>`;
  }
}
