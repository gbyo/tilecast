import type { TFunction } from "i18next";
import type { Asset, WidgetDefinition } from "../../../api/types";
import {
  widgetCategories,
  widgetCategoryLabel,
  widgetCategoryOf,
} from "../../../content/widgetCategories";
import { formatDateTime } from "../../../lib/dateTime";

type ContentT = TFunction<["content", "common"], undefined>;

export type WidgetView = "grid" | "list";

/** The exact `sort` values the assets endpoint accepts. */
export const widgetSortOptions = [
  { value: "updated", labelKey: "widgets.list.sort.updated" },
  { value: "newest", labelKey: "widgets.list.sort.newest" },
  { value: "oldest", labelKey: "widgets.list.sort.oldest" },
  { value: "name", labelKey: "widgets.list.sort.name" },
] as const;

export type WidgetSort = (typeof widgetSortOptions)[number]["value"];

export const defaultWidgetSort: WidgetSort = "updated";

export const widgetPageSize = 100;

export function isWidgetSort(value: string): value is WidgetSort {
  return widgetSortOptions.some((option) => option.value === value);
}

export type WidgetQuery = {
  search: string;
  provider: string;
  sort: WidgetSort;
};

/** Search, type, and sort are all applied by the server so paging stays correct. */
export function widgetAssetParams(query: WidgetQuery, page: number) {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(widgetPageSize),
    type: "widget",
    sort: query.sort,
  });
  if (query.search) params.set("search", query.search);
  if (query.provider) params.set("provider", query.provider);
  return params;
}

export type WidgetTypeOption = { value: string; label: string };
export type WidgetTypeGroup = { value: string; items: WidgetTypeOption[] };

/**
 * The type filter lists every catalog definition, deprecated ones included.
 * The library shows saved Widgets, and a superseded provider stays resolvable
 * for them even after it leaves new creation, so creation availability rules
 * must not apply here.
 */
export function widgetTypeGroups(
  definitions: readonly WidgetDefinition[],
  t: ContentT,
  locale: string,
): WidgetTypeGroup[] {
  const byName = (a: WidgetTypeOption, b: WidgetTypeOption) =>
    a.label.localeCompare(b.label, locale);
  return widgetCategories
    .map((category) => ({
      value: widgetCategoryLabel(t, category),
      items: definitions
        .filter((definition) => widgetCategoryOf(definition) === category)
        .map((definition) => ({ value: definition.id, label: definition.name }))
        .sort(byName),
    }))
    .filter((group) => group.items.length > 0);
}

/** Provider IDs are implementation names; this keeps an unknown one readable. */
export function humanizeProvider(provider: string): string {
  return provider
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function assetProvider(asset: Asset): string | undefined {
  return asset.widget?.provider ?? (asset.website ? "website" : undefined);
}

export function widgetTypeName(
  asset: Asset,
  definitions: ReadonlyMap<string, WidgetDefinition>,
  t: ContentT,
): string {
  const provider = assetProvider(asset);
  if (!provider) return t("widgets.list.typeUnknown");
  return definitions.get(provider)?.name ?? humanizeProvider(provider);
}

export function widgetUsageText(asset: Asset, t: ContentT): string {
  const playlists = asset.playlistUsage ?? 0;
  const layouts = asset.layoutUsage?.length ?? 0;
  const playlistText = t("widgets.list.playlistUsage", { count: playlists });
  const layoutText = t("widgets.list.layoutUsage", { count: layouts });
  if (playlists > 0 && layouts > 0)
    return t("widgets.list.usageBoth", {
      playlists: playlistText,
      layouts: layoutText,
    });
  if (playlists > 0) return playlistText;
  if (layouts > 0) return layoutText;
  return t("widgets.list.unused");
}

export type WidgetRow = {
  asset: Asset;
  typeName: string;
  usage: string;
  updated: string;
};

export function widgetRows(
  items: readonly Asset[],
  definitions: ReadonlyMap<string, WidgetDefinition>,
  t: ContentT,
  locale: string,
): WidgetRow[] {
  return items.map((asset) => ({
    asset,
    typeName: widgetTypeName(asset, definitions, t),
    usage: widgetUsageText(asset, t),
    updated: formatDateTime(asset.updatedAt, locale),
  }));
}

export function widgetPath(asset: Asset) {
  return `/widgets/${asset.id}`;
}
