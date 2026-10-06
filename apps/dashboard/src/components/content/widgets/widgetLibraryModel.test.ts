import { describe, expect, it } from "vitest";
import type { WidgetDefinition } from "../../../api/types";
import {
  defaultWidgetSort,
  humanizeProvider,
  isWidgetSort,
  widgetAssetParams,
  widgetSortOptions,
  widgetTypeGroups,
} from "./widgetLibraryModel";

const definition = (
  id: string,
  name: string,
  extra: Partial<WidgetDefinition> = {},
) =>
  ({
    id,
    name,
    category: "Essentials",
    runtime: "native",
    ...extra,
  }) as WidgetDefinition;

// Category headings are translated by the caller; echoing the key keeps this
// test about grouping, not copy.
const t = ((key: string) => key) as never;

describe("widgetAssetParams", () => {
  it("always asks the server for Widgets, sorted, from the requested page", () => {
    const params = widgetAssetParams(
      { search: "", provider: "", sort: defaultWidgetSort },
      3,
    );
    expect(Object.fromEntries(params)).toEqual({
      page: "3",
      pageSize: "100",
      type: "widget",
      sort: "updated",
    });
  });

  it("adds search and provider only when set", () => {
    const params = widgetAssetParams(
      { search: "lunch", provider: "countdown", sort: "name" },
      1,
    );
    expect(params.get("search")).toBe("lunch");
    expect(params.get("provider")).toBe("countdown");
    expect(params.get("sort")).toBe("name");
  });

  it("offers exactly the sorts the assets endpoint accepts", () => {
    expect(widgetSortOptions.map((option) => option.value)).toEqual([
      "updated",
      "newest",
      "oldest",
      "name",
    ]);
    expect(isWidgetSort("oldest")).toBe(true);
    expect(isWidgetSort("size")).toBe(false);
  });
});

describe("widgetTypeGroups", () => {
  it("groups by the gallery categories and sorts each group by name", () => {
    const groups = widgetTypeGroups(
      [
        definition("weather", "Weather", { category: "Information" }),
        definition("qr", "QR Code"),
        definition("clock", "Clock"),
        definition("youtube", "YouTube", { runtime: "web", category: "Other" }),
        definition("rss", "RSS", { category: "Unlisted" }),
      ],
      t,
      "en",
    );
    expect(
      groups.map((group) => [group.value, group.items.map((i) => i.value)]),
    ).toEqual([
      ["widgets.gallery.categories.essentials", ["clock", "qr"]],
      ["widgets.gallery.categories.information", ["weather"]],
      // Unknown categories fall to Data display, as in the gallery.
      ["widgets.gallery.categories.dataDisplay", ["rss"]],
      ["widgets.gallery.categories.integrations", ["youtube"]],
    ]);
  });

  it("keeps deprecated definitions so saved Widgets stay filterable", () => {
    const groups = widgetTypeGroups(
      [definition("old", "Old", { deprecation: { deprecated: true } })],
      t,
      "en",
    );
    expect(groups[0]?.items).toEqual([{ value: "old", label: "Old" }]);
  });

  it("omits empty groups", () => {
    expect(widgetTypeGroups([], t, "en")).toEqual([]);
  });
});

describe("humanizeProvider", () => {
  it.each([
    ["menu-board", "Menu Board"],
    ["rss_feed", "Rss Feed"],
    ["clock", "Clock"],
  ])("turns %s into %s", (id, label) => {
    expect(humanizeProvider(id)).toBe(label);
  });
});
