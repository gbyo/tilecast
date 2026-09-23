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
import { Button, EmptyState, IconButton } from "../legacy-ui";
import type { PlaylistItem } from "../../api/types";
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
    <section
      className="playlist-timeline-section"
      aria-labelledby="playlist-timeline-title"
    >
      <header className="playlist-timeline__header">
        <div>
          <p className="playlist-editor-eyebrow">Timeline</p>
          <div className="playlist-timeline__title-row">
            <h2 id="playlist-timeline-title">Content</h2>
            <span className="playlist-timeline__count">
              {items.length} item{items.length === 1 ? "" : "s"}
            </span>
          </div>
          <p>
            {tagDriven
              ? "Ready media matching the selected tags appears here automatically."
              : "Items play from top to bottom, then loop."}
          </p>
        </div>
        {!tagDriven && canManage && (
          <div className="playlist-timeline__actions">
            <Button variant="quiet" onClick={onAddLayout}>
              <PanelsTopLeft size={15} aria-hidden="true" />
              Add Layout
            </Button>
            <Button variant="primary" onClick={onAddContent}>
              <Plus size={15} aria-hidden="true" />
              Add content
            </Button>
          </div>
        )}
      </header>

      {tagDriven && (
        <div className="playlist-timeline__tag-note" role="note">
          Edit the tag rule under Playlist details to change which content
          appears here.
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState
          className="playlist-timeline__empty"
          icon={<FileImage size={22} aria-hidden="true" />}
          title={tagDriven ? "No matching content" : "Your timeline is empty"}
          message={
            tagDriven
              ? "No ready media currently matches this playlist’s tags."
              : "Add ready images, videos, Widgets, or Layouts to begin playback."
          }
          action={
            !tagDriven && canManage ? (
              <Button variant="primary" onClick={onAddContent}>
                <Plus size={15} aria-hidden="true" />
                Add content
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div
            className="playlist-timeline__list"
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
          <footer className="playlist-timeline__footer">
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
      className={`playlist-timeline-item${selected ? " playlist-timeline-item--selected" : ""}${dragged ? " playlist-timeline-item--dragged" : ""}`}
      onDragOver={(event) => {
        if (canManage) event.preventDefault();
      }}
      onDrop={(event) => onDrop(event, item.id)}
    >
      <button
        type="button"
        className="playlist-timeline-item__drag-handle"
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
        <span>{String(index + 1).padStart(2, "0")}</span>
      </button>

      <button
        type="button"
        className="playlist-timeline-item__select"
        aria-label={`Inspect ${item.assetName}`}
        aria-pressed={selected}
        onClick={() => onSelect(item.id)}
      >
        <TimelineThumbnail item={item} />
        <span className="playlist-timeline-item__copy">
          <strong>{item.assetName}</strong>
          <span className="playlist-timeline-item__meta">
            <span>{item.assetType}</span>
            <span>{formatItemDuration(item)}</span>
            <span>
              {item.usePlayerDefaults
                ? "Player defaults"
                : transitionLabel(item.transition)}
            </span>
            {item.assetType === "video" && (
              <span>
                <Volume2 size={13} aria-hidden="true" /> Audio
                {showAudio ? " on" : " off"}
              </span>
            )}
          </span>
        </span>
      </button>

      <div className="playlist-timeline-item__badges">
        {item.usePlayerDefaults ? (
          <span className="playlist-editor-badge playlist-editor-badge--muted">
            Player defaults
          </span>
        ) : (
          override && (
            <span className="playlist-editor-badge playlist-editor-badge--override">
              Override
            </span>
          )
        )}
        {item.assetStatus !== "ready" && (
          <span className="playlist-editor-badge playlist-editor-badge--warning">
            {item.assetStatus}
          </span>
        )}
      </div>

      {canManage && (
        <div className="playlist-timeline-item__reorder-actions">
          <IconButton
            label={`Move ${item.assetName} up`}
            disabled={index === 0}
            onClick={() => onMove(item.id, -1)}
          >
            <ArrowUp size={15} aria-hidden="true" />
          </IconButton>
          <IconButton
            label={`Move ${item.assetName} down`}
            disabled={index === itemCount - 1}
            onClick={() => onMove(item.id, 1)}
          >
            <ArrowDown size={15} aria-hidden="true" />
          </IconButton>
        </div>
      )}

      <span className="playlist-timeline-item__disclosure" aria-hidden="true">
        <ChevronRight size={18} />
      </span>
    </article>
  );
}

function TimelineThumbnail({ item }: { item: PlaylistItem }) {
  if (item.assetType === "layout") {
    return (
      <span className="playlist-timeline-item__thumbnail playlist-timeline-item__thumbnail--icon">
        <PanelsTopLeft size={24} aria-hidden="true" />
      </span>
    );
  }
  if (item.assetType === "widget") {
    return (
      <span className="playlist-timeline-item__thumbnail playlist-timeline-item__thumbnail--icon">
        <Globe2 size={24} aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="playlist-timeline-item__thumbnail">
      <img src={item.thumbnailUrl} alt="" />
    </span>
  );
}
