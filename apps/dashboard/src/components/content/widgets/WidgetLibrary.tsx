import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { Asset, WidgetDefinition } from "../../../api/types";
import { useCompactLayout } from "../../../hooks/use-compact-layout";
import { useFormatLocale } from "../../../i18n";
import type { StudioActionGroup } from "../../studio/ActionMenu";
import { WidgetCard, WidgetCardSkeleton } from "./WidgetCard";
import {
  WidgetItems,
  WidgetItemsSkeleton,
  WidgetTable,
  WidgetTableSkeleton,
} from "./WidgetList";
import {
  widgetPath,
  widgetRows,
  type WidgetRow,
  type WidgetView,
} from "./widgetLibraryModel";

// Container queries follow the space the library actually gets, which shrinks
// with the sidebar, rather than the viewport.
const gridClassName =
  "grid grid-cols-1 gap-4 @md:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4";

/**
 * The loaded Widgets in the chosen view. Desktop list mode is a table; phones
 * get a native list instead of a horizontally scrolling table.
 */
export function WidgetLibrary({
  items,
  definitions,
  view,
  canManage,
  duplicating,
  onDuplicate,
}: {
  items: readonly Asset[];
  definitions: ReadonlyMap<string, WidgetDefinition>;
  view: WidgetView;
  canManage: boolean;
  duplicating: boolean;
  onDuplicate: (asset: Asset) => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const navigate = useNavigate();
  const compact = useCompactLayout();
  const rows = useMemo(
    () => widgetRows(items, definitions, t, locale),
    [items, definitions, t, locale],
  );
  // Opening is always offered so the menu is never the only way in: viewers get
  // a single entry, managers get Edit and Duplicate.
  const actionsFor = ({ asset }: WidgetRow): StudioActionGroup[] => [
    {
      actions: [
        {
          id: "open",
          label: canManage
            ? t("widgets.list.actions.edit")
            : t("widgets.list.actions.open"),
          icon: canManage ? "edit" : "open",
          onSelect: () => void navigate(widgetPath(asset)),
        },
        ...(canManage
          ? [
              {
                id: "duplicate",
                label: t("widgets.list.actions.duplicate"),
                icon: "duplicate",
                disabled: duplicating,
                onSelect: () => onDuplicate(asset),
              },
            ]
          : []),
      ],
    },
  ];

  if (view === "list")
    return compact ? (
      <WidgetItems rows={rows} actionsFor={actionsFor} />
    ) : (
      <WidgetTable rows={rows} actionsFor={actionsFor} />
    );
  return (
    <div className="@container">
      <div className={gridClassName}>
        {rows.map((row) => (
          <WidgetCard key={row.asset.id} row={row} actions={actionsFor(row)} />
        ))}
      </div>
    </div>
  );
}

/** A placeholder shaped like the selected view, so loading does not reflow. */
export function WidgetLibrarySkeleton({ view }: { view: WidgetView }) {
  const { t } = useTranslation("content");
  const compact = useCompactLayout();
  return (
    <div role="status" aria-label={t("widgets.list.loading")}>
      {view === "grid" ? (
        <div className="@container" aria-hidden="true">
          <div className={gridClassName}>
            {Array.from({ length: 8 }, (_, index) => (
              <WidgetCardSkeleton key={index} />
            ))}
          </div>
        </div>
      ) : compact ? (
        <WidgetItemsSkeleton />
      ) : (
        <WidgetTableSkeleton />
      )}
    </div>
  );
}
