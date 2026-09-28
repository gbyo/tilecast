/**
 * News V2: normalized feed and news records as the focal point of the Widget.
 *
 * The author connects one compatible source; the Widget resolves its story
 * slots from the normalized feed roles first (headline, summary,
 * published_at, source_name, author) and falls back to the long-standing
 * feed field names, so any records source with title-like columns works.
 * The Widget never branches on the source provider.
 *
 * Typography-first: no article images until managed remote feed images are
 * safe and cached by Tilecast. Layout is container queries only: a large
 * landscape zone leads with the first story, a portrait or narrow zone
 * stacks headlines, and a small Layout zone keeps a concise list.
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

export const NEWS_STYLES = ["lead", "headlines", "compact"] as const;
export type NewsStyle = (typeof NEWS_STYLES)[number];

export interface NewsConfig {
  readonly dataSourceId: string;
  readonly heading: string;
  readonly maxStories: number;
  readonly showSummary: boolean;
  readonly showTime: boolean;
  readonly showSource: boolean;
  readonly emptyText: string;
  readonly displayStyle: NewsStyle;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface NewsStory {
  readonly id: string;
  readonly values: Readonly<Record<string, WidgetValue>>;
}

export interface NewsSlotKeys {
  readonly headline: string;
  readonly summary: string;
  readonly published: string;
  readonly sourceName: string;
  readonly author: string;
}

export interface NewsData {
  readonly stories: readonly NewsStory[];
  readonly keys: NewsSlotKeys;
  readonly fields: Readonly<Record<string, WidgetField>>;
  readonly total: number;
}

/** One story slot: the roles it prefers, then the feed field names it accepts. */
interface StorySlot {
  readonly roles: readonly string[];
  readonly keys: readonly string[];
}

const SLOTS: Record<
  "headline" | "summary" | "published" | "sourceName" | "author",
  StorySlot
> = {
  headline: { roles: ["headline"], keys: ["title", "headline", "name"] },
  summary: { roles: ["summary"], keys: ["description", "summary", "subtitle"] },
  published: {
    roles: ["published_at"],
    keys: ["date", "published", "publishedAt", "updated"],
  },
  sourceName: {
    roles: ["source_name"],
    keys: ["source", "sourceName", "publisher"],
  },
  author: { roles: ["author"], keys: ["author", "creator", "byline"] },
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/** The field key a slot reads: declared role first, then known feed names. */
export function slotFieldKey(
  fields: Readonly<Record<string, WidgetField>>,
  slot: StorySlot,
): string {
  for (const role of slot.roles) {
    if (role === "") continue;
    for (const key of Object.keys(fields)) {
      if (fields[key]?.role === role) return key;
    }
  }
  const known = new Set(slot.keys.map(normalizeKey));
  for (const key of Object.keys(fields)) {
    if (known.has(normalizeKey(key))) return key;
  }
  return "";
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

export function parseNewsConfig(value: unknown): ConfigResult<NewsConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  if (source === null || source.length > 200)
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  const heading = boundText(raw["heading"] ?? "", 80);
  const emptyText = boundText(raw["emptyText"] ?? "", 160);
  const maxStories = raw["maxStories"] ?? 8;
  if (
    typeof maxStories !== "number" ||
    !Number.isInteger(maxStories) ||
    maxStories < 1 ||
    maxStories > 20
  ) {
    return {
      ok: false,
      problem: "maxStories must be an integer from 1 to 20",
    };
  }
  const showSummary = optionalBoolean(raw["showSummary"], true);
  const showTime = optionalBoolean(raw["showTime"], true);
  const showSource = optionalBoolean(raw["showSource"], true);
  if (showSummary === null || showTime === null || showSource === null) {
    return { ok: false, problem: "display toggles must be booleans" };
  }
  // The legacy News Feed style was named "featured"; it renders as the lead story.
  const style =
    raw["displayStyle"] === "featured"
      ? "lead"
      : (raw["displayStyle"] ?? "headlines");
  if (!NEWS_STYLES.includes(style as never)) {
    return { ok: false, problem: "displayStyle is not a News style" };
  }
  return {
    ok: true,
    config: {
      dataSourceId: source,
      heading,
      maxStories,
      showSummary,
      showTime,
      showSource,
      emptyText,
      displayStyle: style as NewsStyle,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveNewsData(
  config: NewsConfig,
  resources: WidgetResources,
): WidgetResolution<NewsData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const dataset = firstRecordsDataset(document);
  if (!dataset) return failure("incompatible_source");
  const records = dataset.records ?? [];
  if (records.length === 0) return empty("no_records");
  const fields: Record<string, WidgetField> = {};
  for (const field of dataset.fields ?? []) fields[field.key] = field;
  const headlineKey = slotFieldKey(fields, SLOTS.headline);
  const summaryKey = slotFieldKey(fields, SLOTS.summary);
  const publishedKey = slotFieldKey(fields, SLOTS.published);
  const sourceKey = slotFieldKey(fields, SLOTS.sourceName);
  const authorKey = slotFieldKey(fields, SLOTS.author);
  if (headlineKey === "") return failure("incompatible_source");
  // Values stay raw so rendering formats them in the screen locale; a story
  // without any headline text carries nothing to show.
  const stories: NewsStory[] = [];
  for (const record of records.slice(0, config.maxStories)) {
    const headline = formatWidgetValue(
      record.values[headlineKey],
      fields[headlineKey],
      { locale: "en" },
    );
    if (headline === "") continue;
    stories.push({ id: record.id, values: record.values });
  }
  if (stories.length === 0) return empty("no_records");
  return ready({
    stories,
    keys: {
      headline: headlineKey,
      summary: summaryKey,
      published: publishedKey,
      sourceName: sourceKey,
      author: authorKey,
    },
    fields,
    total: records.length,
  });
}

export class TilecastNewsWidget extends TilecastWidgetElement<
  NewsConfig,
  NewsData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .news {
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
      .stories {
        display: flex;
        flex-direction: column;
        min-height: 0;
        gap: min(2.4cqh, 2.4cqw);
      }
      .story {
        min-width: 0;
      }
      .headline {
        font-weight: 600;
        line-height: 1.25;
        font-size: clamp(12px, min(5.4cqh, 3.6cqw), 96px);
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
      }
      .summary {
        margin-top: 0.3em;
        font-size: clamp(10px, min(4cqh, 2.8cqw), 64px);
        font-weight: 500;
        color: var(--tc-color-fg-muted);
        line-height: 1.35;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .meta {
        margin-top: 0.3em;
        font-size: clamp(9px, min(3.4cqh, 2.4cqw), 56px);
        font-weight: 500;
        letter-spacing: 0.02em;
        color: var(--tc-color-fg-subtle);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .news[data-style="lead"] .lead-story .headline {
        font-size: clamp(14px, min(7.5cqh, 4.6cqw), 140px);
        letter-spacing: -0.01em;
      }
      .news[data-style="lead"] .lead-story .summary {
        -webkit-line-clamp: 3;
      }
      .news[data-style="lead"] .story + .story {
        border-top: var(--tc-stroke) solid var(--tc-color-separator);
        padding-top: min(2cqh, 2cqw);
      }
      .news[data-style="headlines"] .story + .story {
        border-top: var(--tc-stroke) solid var(--tc-color-separator);
        padding-top: min(1.8cqh, 1.8cqw);
      }
      .news[data-style="headlines"] .summary {
        -webkit-line-clamp: 1;
      }
      .news[data-style="compact"] .stories {
        gap: min(1.2cqh, 1.2cqw);
      }
      .news[data-style="compact"] .summary,
      .news[data-style="compact"] .meta {
        display: none;
      }

      /* Large landscape: lead story plus supporting stories side by side.
         Short strips stay stacked: a side-by-side lead needs height. */
      @container tc-widget (aspect-ratio > 1.2) and (min-height: 300px) {
        .news[data-style="lead"] .stories {
          flex-direction: row;
          gap: 4cqw;
          overflow: hidden;
        }
        .news[data-style="lead"] .lead-story {
          flex: 3 1 0;
          min-width: 0;
        }
        .news[data-style="lead"] .supporting {
          flex: 2 1 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: min(2cqh, 2cqw);
        }
        .news[data-style="lead"] .story + .story {
          border-top: 0;
          padding-top: 0;
        }
      }

      /* Portrait and narrow zones: stacked, with the lead kept in scale. */
      @container tc-widget (aspect-ratio <= 1.2) {
        .news[data-style="lead"] .lead-story .headline {
          font-size: clamp(12px, min(6cqh, 4cqw), 110px);
        }
        .news[data-style="lead"] .summary {
          -webkit-line-clamp: 2;
        }
      }

      /* Small Layout zone: concise headlines only, first stories. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .summary,
        .meta {
          display: none;
        }
        .story:nth-child(n + 5) {
          display: none;
        }
        .news[data-style="lead"] .supporting .story:nth-child(n + 3) {
          display: none;
        }
      }
    `,
  ];

  protected override themeOverrides(config: NewsConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: NewsData | null): TemplateResult {
    if (!data) return html``;
    const locale = this.context.locale;
    const cell = (story: NewsStory, key: string): string => {
      if (key === "") return "";
      return formatWidgetValue(story.values[key], data.fields[key], {
        locale,
      });
    };
    const meta = (story: NewsStory): string => {
      const parts: string[] = [];
      if (this.config.showSource) {
        const source = cell(story, data.keys.sourceName);
        const author = cell(story, data.keys.author);
        if (source && author) parts.push(`${source} · ${author}`);
        else if (source) parts.push(source);
        else if (author) parts.push(author);
      }
      if (this.config.showTime) {
        const published = cell(story, data.keys.published);
        if (published) parts.push(published);
      }
      return parts.join("  ·  ");
    };
    const story = (item: NewsStory, lead: boolean): TemplateResult => {
      const headline = cell(item, data.keys.headline);
      if (!headline) return html``;
      const summary = this.config.showSummary
        ? cell(item, data.keys.summary)
        : "";
      const metaLine = meta(item);
      return html`<article class="story${lead ? " lead-story" : ""}">
        <div class="headline">${headline}</div>
        ${summary ? html`<div class="summary">${summary}</div>` : nothing}
        ${metaLine ? html`<div class="meta">${metaLine}</div>` : nothing}
      </article>`;
    };
    const lead =
      this.config.displayStyle === "lead" ? data.stories[0] : undefined;
    const rest = lead ? data.stories.slice(1) : data.stories;
    return html`<div class="news" data-style=${this.config.displayStyle}>
      ${
        this.config.heading
          ? html`<div class="heading">${this.config.heading}</div>`
          : nothing
      }
      <div class="stories">
        ${
          lead
            ? html`${story(lead, true)}
                <div class="supporting">
                  ${rest.map((item) => story(item, false))}
                </div>`
            : rest.map((item) => story(item, false))
        }
      </div>
    </div>`;
  }
}
