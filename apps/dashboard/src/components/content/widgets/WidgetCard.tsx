import { EllipsisVertical } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ActionContextMenu, ActionMenuButton } from "../../studio/ActionMenu";
import type { StudioActionGroup } from "../../studio/ActionMenu";
import { AspectRatio } from "../../ui/aspect-ratio";
import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import { Skeleton } from "../../ui/skeleton";
import { AssetPreview } from "../AssetPreview";
import { widgetPath, type WidgetRow } from "./widgetLibraryModel";

/**
 * One saved Widget. The preview is the stored canonical 16:9 capture, shown
 * through the shared AssetPreview so a missing capture keeps its explicit
 * unavailable state. The preview and the title are separate links to the same
 * editor and the menu is a sibling of both, so nothing interactive nests.
 */
export function WidgetCard({
  row,
  actions,
}: {
  row: WidgetRow;
  actions: StudioActionGroup[];
}) {
  const { t } = useTranslation("content");
  const titleId = useId();
  const { asset } = row;
  const to = widgetPath(asset);
  const actionsLabel = t("widgets.list.actionsFor", { name: asset.name });
  return (
    <ActionContextMenu
      label={actionsLabel}
      actions={actions}
      render={
        <Card
          role="article"
          aria-labelledby={titleId}
          size="sm"
          className="min-w-0 gap-0 py-0 transition-shadow hover:ring-foreground/25 has-[[data-slot=widget-open]:focus-visible]:ring-2 has-[[data-slot=widget-open]:focus-visible]:ring-ring"
        />
      }
    >
      {/* Duplicates the title link for pointer users, so it stays out of the tab order. */}
      <Link to={to} tabIndex={-1} aria-hidden="true">
        <AspectRatio
          ratio={16 / 9}
          className="grid w-full place-items-center overflow-hidden bg-muted [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
        >
          <AssetPreview asset={asset} />
        </AspectRatio>
      </Link>
      <CardHeader className="border-t py-3">
        <CardTitle id={titleId} className="min-w-0 truncate">
          <Link
            to={to}
            data-slot="widget-open"
            title={asset.name}
            className="rounded-sm outline-none hover:underline"
          >
            {asset.name}
          </Link>
        </CardTitle>
        <CardDescription className="min-w-0 truncate">
          {row.typeName}
        </CardDescription>
        <CardDescription className="min-w-0 truncate text-xs">
          {row.usage}
        </CardDescription>
        <CardAction>
          <ActionMenuButton
            label={actionsLabel}
            actions={actions}
            variant="ghost"
            size="icon-sm"
            triggerIcon={<EllipsisVertical aria-hidden="true" />}
          />
        </CardAction>
      </CardHeader>
    </ActionContextMenu>
  );
}

export function WidgetCardSkeleton() {
  return (
    <Card size="sm" className="gap-0 py-0" aria-hidden="true">
      <AspectRatio ratio={16 / 9}>
        <Skeleton className="size-full rounded-none" />
      </AspectRatio>
      <CardHeader className="border-t py-3">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-1/2" />
      </CardHeader>
    </Card>
  );
}
