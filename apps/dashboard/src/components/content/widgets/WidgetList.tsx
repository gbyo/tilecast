import { EllipsisVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ActionContextMenu, ActionMenuButton } from "../../studio/ActionMenu";
import type { StudioActionGroup } from "../../studio/ActionMenu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../../ui/item";
import { Skeleton } from "../../ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/table";
import { widgetPath, type WidgetRow } from "./widgetLibraryModel";

type ListProps = {
  rows: WidgetRow[];
  actionsFor: (row: WidgetRow) => StudioActionGroup[];
};

function WidgetTableHeader() {
  const { t } = useTranslation("content");
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>{t("widgets.list.columns.widget")}</TableHead>
        <TableHead>{t("widgets.list.columns.type")}</TableHead>
        <TableHead>{t("widgets.list.columns.usedBy")}</TableHead>
        <TableHead>{t("widgets.list.columns.updated")}</TableHead>
        <TableHead className="w-12">
          <span className="sr-only">{t("widgets.list.columns.actions")}</span>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

/** Desktop list mode: Widget-specific columns, not the Media asset row. */
export function WidgetTable({ rows, actionsFor }: ListProps) {
  const { t } = useTranslation("content");
  return (
    <Table>
      <WidgetTableHeader />
      <TableBody>
        {rows.map((row) => {
          const { asset } = row;
          const actions = actionsFor(row);
          const label = t("widgets.list.actionsFor", { name: asset.name });
          return (
            // Every Widget has at least the open action, so the context menu
            // always renders this row element.
            <ActionContextMenu
              key={asset.id}
              label={label}
              actions={actions}
              render={<TableRow />}
            >
              <TableCell className="max-w-72 min-w-40 whitespace-normal">
                <Link
                  to={widgetPath(asset)}
                  className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  title={asset.name}
                >
                  {asset.name}
                </Link>
                {asset.description && (
                  <p className="truncate text-xs text-muted-foreground">
                    {asset.description}
                  </p>
                )}
              </TableCell>
              <TableCell>{row.typeName}</TableCell>
              <TableCell className="text-muted-foreground">
                {row.usage}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {row.updated}
              </TableCell>
              <TableCell className="text-end">
                <ActionMenuButton
                  label={label}
                  actions={actions}
                  variant="ghost"
                  size="icon-sm"
                  triggerIcon={<EllipsisVertical aria-hidden="true" />}
                />
              </TableCell>
            </ActionContextMenu>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Compact list mode: the same facts as a native list, with no horizontal scroll. */
export function WidgetItems({ rows, actionsFor }: ListProps) {
  const { t } = useTranslation("content");
  return (
    <ItemGroup render={<ul />} className="gap-1">
      {rows.map((row) => {
        const { asset } = row;
        const actions = actionsFor(row);
        const label = t("widgets.list.actionsFor", { name: asset.name });
        return (
          <li key={asset.id}>
            <ActionContextMenu
              label={label}
              actions={actions}
              className="contents"
            >
              <Item size="sm" variant="outline">
                <ItemContent>
                  <ItemTitle className="max-w-full">
                    <Link
                      to={widgetPath(asset)}
                      className="truncate rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    >
                      {asset.name}
                    </Link>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-1">
                    {row.typeName}
                  </ItemDescription>
                  <ItemDescription className="text-xs">
                    {t("widgets.list.itemMeta", {
                      usage: row.usage,
                      updated: row.updated,
                    })}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <ActionMenuButton
                    label={label}
                    actions={actions}
                    variant="ghost"
                    size="icon-sm"
                    triggerIcon={<EllipsisVertical aria-hidden="true" />}
                  />
                </ItemActions>
              </Item>
            </ActionContextMenu>
          </li>
        );
      })}
    </ItemGroup>
  );
}

export function WidgetTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    // The real header stays so the table does not shift when rows arrive.
    <Table>
      <WidgetTableHeader />
      <TableBody aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <TableRow key={index} className="hover:bg-transparent">
            <TableCell className="w-1/3">
              <Skeleton className="h-4 w-40" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-24" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-36" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-32" />
            </TableCell>
            <TableCell className="w-12">
              <Skeleton className="size-8" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function WidgetItemsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-1">
      {Array.from({ length: rows }, (_, index) => (
        <Item key={index} size="sm" variant="outline">
          <ItemContent>
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3.5 w-1/4" />
            <Skeleton className="h-3 w-3/5" />
          </ItemContent>
          <Skeleton className="size-8" />
        </Item>
      ))}
    </div>
  );
}
