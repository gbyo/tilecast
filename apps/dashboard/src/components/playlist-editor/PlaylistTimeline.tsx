import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronRight,
  FileImage,
  Globe2,
  GripVertical,
  PanelsTopLeft,
  Plus,
  Volume2,
} from "lucide-react";
import type { DragEvent, KeyboardEvent } from "react";
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  formatItemDuration,
  itemHasTransitionOverride,
  playlistDurationLabel,
  type PlaylistTransition,
  transitionLabel,
} from "./playlistEditorModel";

export type TimelineEdge = "top" | "bottom";

export function PlaylistTimeline({
  items,
  sourceType,
  canManage,
  selectedItemId,
  playlistTransition,
  draggedItemId,
  onSelect,
  onMove,
  onMoveToEdge,
  onDragStart,
  onDragEnd,
  onDrop,
  onAddContent,
  onAddLayout,
}: {
  items: PlaylistItem[];
  sourceType: "static" | "tag";
  canManage: boolean;
  selectedItemId?: string;
  playlistTransition: PlaylistTransition;
  draggedItemId?: string;
  onSelect: (itemId: string) => void;
  onMove: (itemId: string, offset: -1 | 1) => void;
  onMoveToEdge: (itemId: string, edge: TimelineEdge) => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent, targetId: string) => void;
  onAddContent: () => void;
  onAddLayout: () => void;
}) {
  const { t } = useTranslation("playlists");
  const tagDriven = sourceType === "tag";
  return (
    <section aria-labelledby="playlist-timeline-title" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("timeline.eyebrow")}
          </p>
          <div className="flex items-center gap-2">
            <h2
              id="playlist-timeline-title"
              className="text-lg font-semibold tracking-tight"
            >
              {t("timeline.heading")}
            </h2>
            <span className="text-sm text-muted-foreground">
              {t("count.items", { count: items.length })}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {tagDriven ? t("timeline.hintTag") : t("timeline.hintManual")}
          </p>
        </div>
        {!tagDriven && canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={onAddLayout}>
              <PanelsTopLeft size={15} aria-hidden="true" />
              {t("timeline.addLayout")}
            </Button>
            <Button type="button" onClick={onAddContent}>
              <Plus size={15} aria-hidden="true" />
              {t("timeline.addContent")}
            </Button>
          </div>
        )}
      </div>

      {tagDriven && (
        <div
          className="rounded-lg bg-muted p-3 text-sm text-muted-foreground"
          role="note"
        >
          {t("timeline.tagRuleNote")}
        </div>
      )}

      {items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileImage size={22} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {tagDriven
                ? t("timeline.emptyTagTitle")
                : t("timeline.emptyManualTitle")}
            </EmptyTitle>
            <EmptyDescription>
              {tagDriven
                ? t("timeline.emptyTagDescription")
                : t("timeline.emptyManualDescription")}
            </EmptyDescription>
          </EmptyHeader>
          {!tagDriven && canManage && (
            <EmptyContent>
              <Button type="button" onClick={onAddContent}>
                <Plus size={15} aria-hidden="true" />
                {t("timeline.addContent")}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <ScrollArea className="**:data-[slot=scroll-area-viewport]:max-h-[32rem]">
            <div
              className="grid gap-2 pr-3"
              role="list"
              aria-label={t("timeline.listLabel")}
            >
              {items.map((item, index) => (
                <PlaylistTimelineItem
                  key={item.id}
                  item={item}
                  index={index}
                  itemCount={items.length}
                  canManage={canManage}
                  selected={selectedItemId === item.id}
                  playlistTransition={playlistTransition}
                  dragged={draggedItemId === item.id}
                  onSelect={onSelect}
                  onMove={onMove}
                  onMoveToEdge={onMoveToEdge}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onDrop={onDrop}
                />
              ))}
            </div>
          </ScrollArea>
          <footer className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>{t("count.items", { count: items.length })}</span>
            <span aria-label={t("timeline.totalDuration")}>
              {playlistDurationLabel(items, t)}
            </span>
          </footer>
        </>
      )}
    </section>
  );
}

function PlaylistTimelineItem({
  item,
  index,
  itemCount,
  canManage,
  selected,
  playlistTransition,
  dragged,
  onSelect,
  onMove,
  onMoveToEdge,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  item: PlaylistItem;
  index: number;
  itemCount: number;
  canManage: boolean;
  selected: boolean;
  playlistTransition: PlaylistTransition;
  dragged: boolean;
  onSelect: (itemId: string) => void;
  onMove: (itemId: string, offset: -1 | 1) => void;
  onMoveToEdge: (itemId: string, edge: TimelineEdge) => void;
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent, targetId: string) => void;
}) {
  const { t } = useTranslation("playlists");
  const override = itemHasTransitionOverride(item, playlistTransition);
  const showAudio = item.assetType === "video" && item.audioEnabled;

  // Alt+Arrow reorders without leaving the row; Alt+Home/End jumps to an edge.
  // Plain arrows keep their native scroll behavior.
  const onRowKeyDown = (event: KeyboardEvent) => {
    if (!canManage || !event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMove(item.id, -1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onMove(item.id, 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      onMoveToEdge(item.id, "top");
    } else if (event.key === "End") {
      event.preventDefault();
      onMoveToEdge(item.id, "bottom");
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <article
            className={`flex items-center gap-2 rounded-xl border border-border p-2 ${selected ? "border-primary bg-muted" : ""} ${dragged ? "opacity-50" : ""}`}
            onDragOver={(event) => {
              if (canManage) event.preventDefault();
            }}
            onDrop={(event) => onDrop(event, item.id)}
            onKeyDown={onRowKeyDown}
          />
        }
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto shrink-0 cursor-grab gap-1 rounded-lg p-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed"
          draggable={canManage}
          disabled={!canManage}
          aria-label={t("timeline.reorder", { name: item.assetName })}
          title={canManage ? t("timeline.dragHint") : undefined}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.id);
            onDragStart(item.id);
          }}
          onDragEnd={onDragEnd}
        >
          <GripVertical size={18} aria-hidden="true" />
          <span className="tabular-nums">
            {String(index + 1).padStart(2, "0")}
          </span>
        </Button>

        <Button
          type="button"
          variant="ghost"
          className="h-auto min-w-0 flex-1 justify-start gap-3 rounded-lg p-1 text-left whitespace-normal"
          aria-label={t("timeline.inspectAction", { name: item.assetName })}
          aria-pressed={selected}
          onClick={() => onSelect(item.id)}
        >
          <TimelineThumbnail item={item} />
          <span className="grid min-w-0 gap-0.5">
            <strong className="truncate text-sm">{item.assetName}</strong>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
              <span>{item.assetType}</span>
              <span>{formatItemDuration(item, t)}</span>
              <span>
                {item.usePlayerDefaults
                  ? t("model.duration.playerDefaultsValue")
                  : transitionLabel(item.transition, t)}
              </span>
              {item.assetType === "video" && (
                <span className="flex items-center gap-1">
                  <Volume2 size={13} aria-hidden="true" />{" "}
                  {showAudio ? t("timeline.audioOn") : t("timeline.audioOff")}
                </span>
              )}
            </span>
          </span>
        </Button>

        <div className="flex shrink-0 flex-wrap items-center gap-1">
          {item.usePlayerDefaults ? (
            <Badge variant="secondary">
              {t("model.duration.playerDefaultsValue")}
            </Badge>
          ) : (
            override && (
              <Badge variant="outline">{t("timeline.overrideBadge")}</Badge>
            )
          )}
          {item.assetStatus !== "ready" && (
            <Badge variant="destructive">{item.assetStatus}</Badge>
          )}
        </div>

        {canManage && (
          <div className="flex shrink-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("timeline.moveUpFor", {
                      name: item.assetName,
                    })}
                    disabled={index === 0}
                    onClick={() => onMove(item.id, -1)}
                  >
                    <ArrowUp size={15} aria-hidden="true" />
                  </Button>
                }
              />
              <TooltipContent>
                {t("timeline.moveUp")}{" "}
                {/* i18n-ignore: keyboard shortcut name stays English */}
                <Kbd>Alt+↑</Kbd>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("timeline.moveDownFor", {
                      name: item.assetName,
                    })}
                    disabled={index === itemCount - 1}
                    onClick={() => onMove(item.id, 1)}
                  >
                    <ArrowDown size={15} aria-hidden="true" />
                  </Button>
                }
              />
              <TooltipContent>
                {t("timeline.moveDown")}{" "}
                {/* i18n-ignore: keyboard shortcut name stays English */}
                <Kbd>Alt+↓</Kbd>
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
          <ChevronRight size={18} />
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent
        aria-label={t("timeline.actionsFor", { name: item.assetName })}
      >
        <ContextMenuItem onClick={() => onSelect(item.id)}>
          {t("timeline.inspectItem")}
        </ContextMenuItem>
        {canManage && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={index === 0}
              onClick={() => onMove(item.id, -1)}
            >
              {t("timeline.moveUp")}
              {/* i18n-ignore: keyboard shortcut name stays English */}
              <ContextMenuShortcut>Alt+↑</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={index === itemCount - 1}
              onClick={() => onMove(item.id, 1)}
            >
              {t("timeline.moveDown")}
              {/* i18n-ignore: keyboard shortcut name stays English */}
              <ContextMenuShortcut>Alt+↓</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={index === 0}
              onClick={() => onMoveToEdge(item.id, "top")}
            >
              <ArrowUpToLine size={14} aria-hidden="true" />
              {t("timeline.moveTop")}
              {/* i18n-ignore: keyboard shortcut name stays English */}
              <ContextMenuShortcut>Alt+Home</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem
              disabled={index === itemCount - 1}
              onClick={() => onMoveToEdge(item.id, "bottom")}
            >
              <ArrowDownToLine size={14} aria-hidden="true" />
              {t("timeline.moveBottom")}
              {/* i18n-ignore: keyboard shortcut name stays English */}
              <ContextMenuShortcut>Alt+End</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TimelineThumbnail({ item }: { item: PlaylistItem }) {
  if (item.assetType === "layout") {
    return (
      <span className="grid size-12 shrink-0 place-content-center rounded-lg bg-muted text-muted-foreground">
        <PanelsTopLeft size={24} aria-hidden="true" />
      </span>
    );
  }
  if (item.assetType === "widget") {
    return (
      <span className="grid size-12 shrink-0 place-content-center rounded-lg bg-muted text-muted-foreground">
        <Globe2 size={24} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="grid size-12 shrink-0 place-content-center overflow-hidden rounded-lg bg-muted">
      <img src={item.thumbnailUrl} alt="" className="size-full object-cover" />
    </span>
  );
}
