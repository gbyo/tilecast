import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  FileImage,
  Globe2,
  GripVertical,
  MoreHorizontal,
  PanelRight,
  PanelsTopLeft,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  Fragment,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { PlaylistItem } from "../../api/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "../ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../ui/item";
import {
  assetStatusLabel,
  formatItemDuration,
  itemHasTransitionOverride,
  playlistDurationLabel,
  playlistItemSummary,
  type PlaylistTransition,
} from "./playlistEditorModel";
import {
  playlistItemActions,
  type PlaylistItemAction,
  type PlaylistItemActionId,
} from "./playlistItemActions";

export type TimelineEdge = "top" | "bottom";

const actionIcons: Record<PlaylistItemActionId, LucideIcon> = {
  inspect: PanelRight,
  "move-up": ArrowUp,
  "move-down": ArrowDown,
  "move-top": ArrowUpToLine,
  "move-bottom": ArrowDownToLine,
  remove: Trash2,
};

export function PlaylistTimeline({
  items,
  sourceType,
  canManage,
  selectedItemId,
  playlistTransition,
  draggedItemId,
  emptyAction,
  onSelect,
  onMove,
  onMoveToEdge,
  onRemove,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  items: PlaylistItem[];
  sourceType: "static" | "tag";
  canManage: boolean;
  selectedItemId?: string;
  playlistTransition: PlaylistTransition;
  draggedItemId?: string;
  /** The add action shown inside the empty state, owned by the authoring bar. */
  emptyAction?: ReactNode;
  onSelect: (itemId: string) => void;
  onMove: (itemId: string, offset: -1 | 1) => void;
  onMoveToEdge: (itemId: string, edge: TimelineEdge) => void;
  onRemove: (itemId: string) => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent, targetId: string) => void;
}) {
  const { t } = useTranslation("playlists");
  const tagDriven = sourceType === "tag";
  const runAction = (itemId: string, action: PlaylistItemActionId) => {
    if (action === "inspect") onSelect(itemId);
    else if (action === "move-up") onMove(itemId, -1);
    else if (action === "move-down") onMove(itemId, 1);
    else if (action === "move-top") onMoveToEdge(itemId, "top");
    else if (action === "move-bottom") onMoveToEdge(itemId, "bottom");
    else onRemove(itemId);
  };

  return (
    <section
      aria-labelledby="playlist-timeline-title"
      className="grid grid-cols-[minmax(0,1fr)] gap-2"
    >
      <div className="sticky top-0 z-20 flex items-baseline justify-between gap-3 border-b bg-background pt-1 pb-2">
        <h2
          id="playlist-timeline-title"
          className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          {t("timeline.heading")}
        </h2>
        {items.length > 0 && (
          <p className="text-xs text-muted-foreground tabular-nums">
            {t("count.items", { count: items.length })} ·{" "}
            <span aria-label={t("timeline.totalDuration")}>
              {playlistDurationLabel(items, t)}
            </span>
          </p>
        )}
      </div>

      {items.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileImage aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {tagDriven
                ? t("timeline.emptyTagTitle")
                : t("timeline.emptyPlaylistTitle")}
            </EmptyTitle>
            <EmptyDescription>
              {tagDriven
                ? t("timeline.emptyTagDescription")
                : t("timeline.emptyManualDescription")}
            </EmptyDescription>
          </EmptyHeader>
          {emptyAction && <EmptyContent>{emptyAction}</EmptyContent>}
        </Empty>
      ) : (
        <ItemGroup aria-label={t("timeline.listLabel")} className="gap-1">
          {items.map((item, index) => (
            <PlaylistTimelineItem
              key={item.id}
              item={item}
              index={index}
              actions={playlistItemActions({
                index,
                itemCount: items.length,
                canManage,
                t,
              })}
              canManage={canManage}
              selected={selectedItemId === item.id}
              playlistTransition={playlistTransition}
              dragged={draggedItemId === item.id}
              onAction={(action) => runAction(item.id, action)}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDrop={onDrop}
            />
          ))}
        </ItemGroup>
      )}
    </section>
  );
}

function PlaylistTimelineItem({
  item,
  index,
  actions,
  canManage,
  selected,
  playlistTransition,
  dragged,
  onAction,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  item: PlaylistItem;
  index: number;
  actions: PlaylistItemAction[];
  canManage: boolean;
  selected: boolean;
  playlistTransition: PlaylistTransition;
  dragged: boolean;
  onAction: (action: PlaylistItemActionId) => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent, targetId: string) => void;
}) {
  const { t } = useTranslation("playlists");
  const override =
    !item.usePlayerDefaults &&
    itemHasTransitionOverride(item, playlistTransition);
  const unavailable = item.assetStatus !== "ready";

  // Alt+Arrow reorders without leaving the row; Alt+Home/End jumps to an edge.
  // Plain arrows keep their native scroll behavior.
  const onRowKeyDown = (event: KeyboardEvent) => {
    if (!canManage || !event.altKey) return;
    const action = (
      {
        ArrowUp: "move-up",
        ArrowDown: "move-down",
        Home: "move-top",
        End: "move-bottom",
      } as Record<string, PlaylistItemActionId | undefined>
    )[event.key];
    if (!action) return;
    event.preventDefault();
    onAction(action);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <Item
            role="listitem"
            size="sm"
            variant={selected ? "muted" : "default"}
            data-selected={selected || undefined}
            data-playlist-item={item.id}
            className={`relative flex-nowrap py-2 hover:bg-muted/50 has-[[data-slot=playlist-item-inspect]:focus-visible]:border-ring has-[[data-slot=playlist-item-inspect]:focus-visible]:ring-[3px] has-[[data-slot=playlist-item-inspect]:focus-visible]:ring-ring/50 data-selected:border-border ${dragged ? "opacity-50" : ""}`}
            onDragOver={(event) => {
              if (canManage) event.preventDefault();
            }}
            onDrop={(event) => onDrop(event, item.id)}
            onKeyDown={onRowKeyDown}
          />
        }
      >
        <div className="relative z-10 flex w-12 shrink-0 items-center gap-0.5 text-muted-foreground">
          {canManage ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="cursor-grab active:cursor-grabbing"
              draggable
              aria-label={t("timeline.reorder", { name: item.assetName })}
              title={t("timeline.dragHint")}
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", item.id);
                onDragStart(item.id);
              }}
              onDragEnd={onDragEnd}
            >
              <GripVertical aria-hidden="true" />
            </Button>
          ) : (
            <span className="size-6" aria-hidden="true" />
          )}
          <span className="text-xs tabular-nums" aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
        </div>

        <TimelineMedia item={item} />

        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="w-full min-w-0">
            {/* The inspect control stretches over the whole row, so any click on
                the row selects it while the handle and menu stay above it. */}
            <button
              type="button"
              data-slot="playlist-item-inspect"
              className="truncate text-left outline-none after:absolute after:inset-0 after:rounded-md"
              aria-label={t("timeline.inspectAction", { name: item.assetName })}
              aria-pressed={selected}
              onClick={() => onAction("inspect")}
            >
              {item.assetName}
            </button>
          </ItemTitle>
          <ItemDescription className="truncate text-xs">
            {playlistItemSummary(item, t)}
          </ItemDescription>
        </ItemContent>

        <ItemActions className="relative z-10 gap-1.5">
          {override && (
            <Badge variant="outline">{t("timeline.overrideBadge")}</Badge>
          )}
          {unavailable && (
            <Badge variant="destructive">
              {assetStatusLabel(item.assetStatus, t)}
            </Badge>
          )}
          <span className="min-w-12 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
            {formatItemDuration(item, t)}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("timeline.actionsFor", {
                    name: item.assetName,
                  })}
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-52"
              aria-label={t("timeline.actionsFor", { name: item.assetName })}
            >
              <PlaylistItemMenuEntries
                actions={actions}
                onAction={onAction}
                Item={DropdownMenuItem}
                Separator={DropdownMenuSeparator}
                Shortcut={DropdownMenuShortcut}
              />
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-52"
        aria-label={t("timeline.actionsFor", { name: item.assetName })}
      >
        <PlaylistItemMenuEntries
          actions={actions}
          onAction={onAction}
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
          Shortcut={ContextMenuShortcut}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

type MenuItemComponent = (props: {
  disabled?: boolean;
  variant?: "default" | "destructive";
  onClick?: () => void;
  children?: ReactNode;
}) => ReactNode;

function PlaylistItemMenuEntries({
  actions,
  onAction,
  Item: MenuItem,
  Separator,
  Shortcut,
}: {
  actions: PlaylistItemAction[];
  onAction: (action: PlaylistItemActionId) => void;
  Item: MenuItemComponent;
  Separator: (props: Record<never, never>) => ReactNode;
  Shortcut: (props: { children?: ReactNode }) => ReactNode;
}) {
  return actions.map((action, index) => {
    const Icon = actionIcons[action.id];
    return (
      <Fragment key={action.id}>
        {index > 0 && actions[index - 1]?.group !== action.group && (
          <Separator />
        )}
        <MenuItem
          disabled={action.disabled}
          variant={action.destructive ? "destructive" : "default"}
          onClick={() => onAction(action.id)}
        >
          <Icon aria-hidden="true" />
          {action.label}
          {action.shortcut && <Shortcut>{action.shortcut}</Shortcut>}
        </MenuItem>
      </Fragment>
    );
  });
}

function TimelineMedia({ item }: { item: PlaylistItem }) {
  if (item.assetType === "layout" || item.assetType === "widget") {
    const Icon = item.assetType === "layout" ? PanelsTopLeft : Globe2;
    return (
      <ItemMedia
        variant="icon"
        className="size-9 rounded-sm bg-muted text-muted-foreground"
      >
        <Icon aria-hidden="true" />
      </ItemMedia>
    );
  }
  return (
    <ItemMedia
      variant="image"
      className="size-9 bg-muted group-data-[size=sm]/item:size-9"
    >
      {item.thumbnailUrl ? (
        <img src={item.thumbnailUrl} alt="" draggable={false} />
      ) : (
        <FileImage aria-hidden="true" className="m-auto size-4" />
      )}
    </ItemMedia>
  );
}
