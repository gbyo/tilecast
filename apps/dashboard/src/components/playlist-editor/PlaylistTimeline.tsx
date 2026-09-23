import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  FileImage,
  Globe2,
  GripVertical,
  PanelsTopLeft,
  Plus,
  Volume2,
} from "lucide-react";
import type { DragEvent } from "react";
import type { PlaylistItem } from "../../api/types";
import { Badge } from "../ui/badge";
import { Button as RheaButton } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import {
  formatItemDuration,
  itemHasTransitionOverride,
  playlistDurationLabel,
  type PlaylistTransition,
  transitionLabel,
} from "./playlistEditorModel";

export function PlaylistTimeline({
  items,
  sourceType,
  canManage,
  selectedItemId,
  playlistTransition,
  draggedItemId,
  onSelect,
  onMove,
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
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent, targetId: string) => void;
  onAddContent: () => void;
  onAddLayout: () => void;
}) {
  const tagDriven = sourceType === "tag";
  return (
    <section aria-labelledby="playlist-timeline-title" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Timeline
          </p>
          <div className="flex items-center gap-2">
            <h2
              id="playlist-timeline-title"
              className="text-lg font-semibold tracking-tight"
            >
              Content
            </h2>
            <span className="text-sm text-muted-foreground">
              {items.length} item{items.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {tagDriven
              ? "Ready media matching the selected tags appears here automatically."
              : "Items play from top to bottom, then loop."}
          </p>
        </div>
        {!tagDriven && canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <RheaButton type="button" variant="outline" onClick={onAddLayout}>
              <PanelsTopLeft size={15} aria-hidden="true" />
              Add Layout
            </RheaButton>
            <RheaButton type="button" onClick={onAddContent}>
              <Plus size={15} aria-hidden="true" />
              Add content
            </RheaButton>
          </div>
        )}
      </div>

      {tagDriven && (
        <div
          className="rounded-lg bg-muted p-3 text-sm text-muted-foreground"
          role="note"
        >
          Edit the tag rule under Playlist details to change which content
          appears here.
        </div>
      )}

      {items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileImage size={22} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {tagDriven ? "No matching content" : "Your timeline is empty"}
            </EmptyTitle>
            <EmptyDescription>
              {tagDriven
                ? "No ready media currently matches this playlist’s tags."
                : "Add ready images, videos, Widgets, or Layouts to begin playback."}
            </EmptyDescription>
          </EmptyHeader>
          {!tagDriven && canManage && (
            <EmptyContent>
              <RheaButton type="button" onClick={onAddContent}>
                <Plus size={15} aria-hidden="true" />
                Add content
              </RheaButton>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <div
            className="grid gap-2"
            role="list"
            aria-label="Playlist content timeline"
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
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDrop={onDrop}
              />
            ))}
          </div>
          <footer className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {items.length} item{items.length === 1 ? "" : "s"}
            </span>
            <span aria-label="Total playlist duration">
              {playlistDurationLabel(items)}
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
  onDragStart: (itemId: string) => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent, targetId: string) => void;
}) {
  const override = itemHasTransitionOverride(item, playlistTransition);
  const showAudio = item.assetType === "video" && item.audioEnabled;

  return (
    <article
      className={`flex items-center gap-2 rounded-xl border border-border p-2 ${selected ? "border-primary bg-muted" : ""} ${dragged ? "opacity-50" : ""}`}
      onDragOver={(event) => {
        if (canManage) event.preventDefault();
      }}
      onDrop={(event) => onDrop(event, item.id)}
    >
      <button
        type="button"
        className="flex shrink-0 cursor-grab items-center gap-1 rounded-lg p-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        draggable={canManage}
        disabled={!canManage}
        aria-label={`Reorder ${item.assetName}`}
        title={canManage ? "Drag to reorder" : undefined}
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
      </button>

      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left hover:bg-muted"
        aria-label={`Inspect ${item.assetName}`}
        aria-pressed={selected}
        onClick={() => onSelect(item.id)}
      >
        <TimelineThumbnail item={item} />
        <span className="grid min-w-0 gap-0.5">
          <strong className="truncate text-sm">{item.assetName}</strong>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{item.assetType}</span>
            <span>{formatItemDuration(item)}</span>
            <span>
              {item.usePlayerDefaults
                ? "Player defaults"
                : transitionLabel(item.transition)}
            </span>
            {item.assetType === "video" && (
              <span className="flex items-center gap-1">
                <Volume2 size={13} aria-hidden="true" /> Audio
                {showAudio ? " on" : " off"}
              </span>
            )}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {item.usePlayerDefaults ? (
          <Badge variant="secondary">Player defaults</Badge>
        ) : (
          override && <Badge variant="outline">Override</Badge>
        )}
        {item.assetStatus !== "ready" && (
          <Badge variant="destructive">{item.assetStatus}</Badge>
        )}
      </div>

      {canManage && (
        <div className="flex shrink-0 items-center gap-1">
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Move ${item.assetName} up`}
            disabled={index === 0}
            onClick={() => onMove(item.id, -1)}
          >
            <ArrowUp size={15} aria-hidden="true" />
          </RheaButton>
          <RheaButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Move ${item.assetName} down`}
            disabled={index === itemCount - 1}
            onClick={() => onMove(item.id, 1)}
          >
            <ArrowDown size={15} aria-hidden="true" />
          </RheaButton>
        </div>
      )}

      <span className="shrink-0 text-muted-foreground" aria-hidden="true">
        <ChevronRight size={18} />
      </span>
    </article>
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
