import type { TFunction } from "i18next";
import type { WidgetDefinition } from "../api/types";

/**
 * How the Widget catalog is grouped for people. The creation gallery and the
 * Widgets library filter share this so a Widget type sits under the same
 * heading in both places.
 *
 * The visual catalog comes first, grouped by purpose; every Web Integration
 * (runtime "web") shows remote content and sits apart from it
 * (docs/widgets-v2-catalog.md §7).
 */
export const widgetCategories = [
  "Essentials",
  "Information",
  "Data display",
  "Integrations",
] as const;

export type WidgetCategory = (typeof widgetCategories)[number];

export function widgetCategoryOf(
  definition: Pick<WidgetDefinition, "runtime" | "category">,
): WidgetCategory {
  if (definition.runtime === "web") return "Integrations";
  const known = widgetCategories.find((name) => name === definition.category);
  return known ?? "Data display";
}

export function widgetCategoryLabel(
  t: TFunction<["content", "common"], undefined>,
  name: string,
): string {
  switch (name) {
    case "All":
      return t("widgets.gallery.categories.all");
    case "Essentials":
      return t("widgets.gallery.categories.essentials");
    case "Information":
      return t("widgets.gallery.categories.information");
    case "Data display":
      return t("widgets.gallery.categories.dataDisplay");
    case "Integrations":
      return t("widgets.gallery.categories.integrations");
    default:
      return name;
  }
}
