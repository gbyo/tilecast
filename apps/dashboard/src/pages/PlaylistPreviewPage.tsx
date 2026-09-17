import { useQuery } from "@tanstack/react-query";
import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { api } from "../api/client";
import type { PlaylistItem } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { DeclarativePresentationPreview } from "../content/SourceEditors";

export function nextPlaylistPreviewItem(
  index: number,
  length: number,
  direction = 1,
) {
  if (length <= 0) return 0;
  return (index + direction + length) % length;
}

export function playlistPreviewItemDuration(item: PlaylistItem) {
  if (item.assetType === "video") return undefined;
  return item.durationMs && item.durationMs > 0 ? item.durationMs : 10_000;
}

export const PLAYLIST_PREVIEW_FADE_MS = 300;

export function playlistPreviewShortcutTargetIsInteractive(
  target: EventTarget | null,
) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button, a[href], input, select, textarea, [contenteditable='true'], [role='button'], [role='link'], [role='slider'], [role='textbox'], [role='combobox']",
    ),
  );
}

function mediaStyle(item: PlaylistItem) {
  return {
    objectFit: item.fitMode === "stretch" ? ("fill" as const) : item.fitMode,
  };
}

function PreviewMedia({
  item,
  active,
  paused,
  muted,
  csrfToken,
  className,
  onReady,
  onDone,
  onError,
}: {
  item: PlaylistItem;
  active: boolean;
  paused: boolean;
  muted: boolean;
  csrfToken: string;
  className: string;
  onReady: () => void;
  onDone: () => void;
  onError: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const widgetItem = item.assetType === "widget";
  const widgetQuery = useQuery({
    queryKey: ["assets", item.assetId, "playlist-preview"],
    queryFn: () => api.asset(item.assetId),
    enabled: widgetItem,
    retry: false,
  });
  const savedWidget = widgetQuery.data?.widget;
  const presentationQuery = useQuery({
    queryKey: [
      "compiled-widget-preview",
      savedWidget?.provider,
      savedWidget?.configuration,
    ],
    queryFn: () =>
      api.compileWidgetPreview(
        savedWidget!.provider,
        savedWidget!.configuration,
        csrfToken,
      ),
    enabled: widgetItem && Boolean(savedWidget),
    retry: false,
  });
  const dataSourceId =
    savedWidget?.configuration &&
    "dataSourceId" in savedWidget.configuration &&
    typeof savedWidget.configuration.dataSourceId === "string"
      ? savedWidget.configuration.dataSourceId
      : "";
  const imageAssetId =
    savedWidget?.configuration &&
    "imageAssetId" in savedWidget.configuration &&
    typeof savedWidget.configuration.imageAssetId === "string"
      ? savedWidget.configuration.imageAssetId
      : "";
  const sourceQuery = useQuery({
    queryKey: ["widget-data-source-preview", dataSourceId],
    queryFn: () => api.previewSavedDataSource(dataSourceId),
    enabled: Boolean(dataSourceId),
    retry: false,
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (paused) video.pause();
    else void video.play().catch(() => undefined);
  }, [paused]);
  useEffect(() => {
    if (!widgetItem) return;
    if (
      presentationQuery.data?.kind === "native" &&
      (!dataSourceId || !sourceQuery.isLoading)
    )
      onReady();
    else if ((widgetQuery.isError || presentationQuery.isError) && active)
      onError();
  }, [
    active,
    dataSourceId,
    widgetItem,
    onError,
    onReady,
    presentationQuery.data,
    presentationQuery.isError,
    sourceQuery.isLoading,
    widgetQuery.data,
    widgetQuery.isError,
  ]);
  if (item.assetType === "video") {
    return (
      <video
        ref={videoRef}
        className={className}
        src={api.assetPreviewUrl(item.assetId)}
        style={mediaStyle(item)}
        autoPlay={!paused}
        playsInline
        muted={!active || muted || !item.audioEnabled}
        preload="auto"
        onLoadedMetadata={(event) => {
          event.currentTarget.volume = item.volume;
          if (item.videoStartOffsetMs)
            event.currentTarget.currentTime = item.videoStartOffsetMs / 1000;
        }}
        onLoadedData={onReady}
        onTimeUpdate={(event) => {
          if (
            active &&
            item.videoEndOffsetMs &&
            event.currentTarget.currentTime >= item.videoEndOffsetMs / 1000
          )
            onDone();
        }}
        onEnded={() => active && onDone()}
        onError={() => active && onError()}
      />
    );
  }

  if (widgetItem) {
    return (
      <div
        className={`${className} playlist-preview-page__widget declarative-widget-preview`}
      >
        {presentationQuery.data ? (
          <DeclarativePresentationPreview
            presentation={presentationQuery.data}
            source={sourceQuery.data}
            assetImageUrl={
              imageAssetId ? api.assetPreviewUrl(imageAssetId) : undefined
            }
            onWebReady={onReady}
          />
        ) : (
          <span>Preparing Widget…</span>
        )}
      </div>
    );
  }

  return (
    <img
      className={className}
      src={
        item.assetType === "image"
          ? api.assetPreviewUrl(item.assetId)
          : item.thumbnailUrl
      }
      style={mediaStyle(item)}
      alt=""
      onLoad={onReady}
      onError={() => active && onError()}
    />
  );
}

export function PlaylistPreviewPage() {
  const { id = "" } = useParams();
  const location = useLocation();
  const auth = useAuth();
  const query = useQuery({
    queryKey: ["playlists", id, "popup-preview"],
    queryFn: () => api.playlist(id),
    enabled: Boolean(id && auth.status?.authenticated),
  });
  const items = useMemo(
    () =>
      (query.data?.items ?? []).filter((item) =>
        playlistPreviewItemAvailable(item),
      ),
    [query.data?.items],
  );
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [crossfade, setCrossfade] = useState<{
    outgoing: PlaylistItem;
    incomingId: string;
    ready: boolean;
  }>();
  const indexRef = useRef(0);
  const current = items[index % Math.max(items.length, 1)];

  const move = useCallback(
    (direction: number) => {
      const previousIndex = indexRef.current;
      const nextIndex = nextPlaylistPreviewItem(
        previousIndex,
        items.length,
        direction,
      );
      const outgoing = items[previousIndex];
      const incoming = items[nextIndex];
      if (
        outgoing &&
        incoming &&
        outgoing.id !== incoming.id &&
        incoming.transition === "crossfade"
      ) {
        setCrossfade({ outgoing, incomingId: incoming.id, ready: false });
      } else {
        setCrossfade(undefined);
      }
      setFailed(false);
      indexRef.current = nextIndex;
      setIndex(nextIndex);
    },
    [items],
  );
  const advance = useCallback(() => move(1), [move]);

  useEffect(() => {
    indexRef.current = 0;
    setIndex(0);
    setCrossfade(undefined);
  }, [query.data?.id, query.data?.revision]);
  useEffect(() => {
    if (index >= items.length) {
      indexRef.current = 0;
      setIndex(0);
      setCrossfade(undefined);
    }
  }, [index, items.length]);
  useEffect(() => setFailed(false), [current?.id]);
  useEffect(() => {
    if (!crossfade?.ready) return;
    const timer = window.setTimeout(
      () => setCrossfade(undefined),
      PLAYLIST_PREVIEW_FADE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [crossfade?.incomingId, crossfade?.ready]);
  useEffect(() => {
    if (!query.data) return;
    const previous = document.title;
    document.title = `${query.data.name} preview · Tilecast`;
    return () => {
      document.title = previous;
    };
  }, [query.data]);
  useEffect(() => {
    if (!current || paused || current.assetType === "video") return;
    const timer = window.setTimeout(
      advance,
      playlistPreviewItemDuration(current),
    );
    return () => window.clearTimeout(timer);
  }, [advance, current, paused]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        playlistPreviewShortcutTargetIsInteractive(event.target)
      )
        return;
      if (event.key === "ArrowRight") move(1);
      else if (event.key === "ArrowLeft") move(-1);
      else if (event.key === " ") {
        event.preventDefault();
        setPaused((value) => !value);
      } else return;
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [move]);

  if (auth.isLoading)
    return <main className="playlist-preview-page">Loading preview…</main>;
  if (!auth.status?.authenticated) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return (
      <Navigate
        to={
          auth.status?.setupRequired
            ? "/setup"
            : `/login?returnTo=${encodeURIComponent(returnTo)}`
        }
        replace
      />
    );
  }
  if (query.isLoading)
    return <main className="playlist-preview-page">Loading preview…</main>;
  if (query.isError || !query.data)
    return (
      <main className="playlist-preview-page playlist-preview-page--message">
        <strong>Playlist preview unavailable</strong>
        <span>
          {query.error instanceof Error
            ? query.error.message
            : "The playlist could not be loaded."}
        </span>
      </main>
    );

  return (
    <main className="playlist-preview-page">
      <header className="playlist-preview-page__header">
        <div>
          <strong>{query.data.name}</strong>
          <span aria-live="polite">
            {current
              ? `${index + 1} of ${items.length} · ${current.assetName}`
              : "No ready items"}
          </span>
        </div>
        <button
          type="button"
          className="playlist-preview-page__control"
          onClick={() => window.close()}
          aria-label="Close preview"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>

      <section
        className="playlist-preview-page__stage"
        aria-label="Playlist preview"
      >
        {!current ? (
          <div className="playlist-preview-page__empty">
            <strong>No ready items</strong>
            <span>Add ready content to preview this playlist.</span>
          </div>
        ) : failed ? (
          <div className="playlist-preview-page__empty">
            <strong>{current.assetName}</strong>
            <span>This item could not be previewed in Studio.</span>
          </div>
        ) : (
          <>
            <PreviewMedia
              key={current.id}
              item={current}
              active
              paused={paused}
              muted={muted}
              csrfToken={auth.status.csrfToken ?? ""}
              className={`playlist-preview-page__media ${crossfade ? "playlist-preview-page__media--incoming" : `playlist-preview-page__media--${current.transition}`}`}
              onReady={() =>
                setCrossfade((value) =>
                  value?.incomingId === current.id
                    ? value.ready
                      ? value
                      : { ...value, ready: true }
                    : value,
                )
              }
              onDone={advance}
              onError={() => {
                setCrossfade(undefined);
                setFailed(true);
              }}
            />
            {crossfade && (
              <PreviewMedia
                key={crossfade.outgoing.id}
                item={crossfade.outgoing}
                active={false}
                paused={paused}
                muted
                csrfToken={auth.status.csrfToken ?? ""}
                className={`playlist-preview-page__media playlist-preview-page__media--outgoing${crossfade.ready ? " playlist-preview-page__media--outgoing-active" : ""}`}
                onReady={() => undefined}
                onDone={() => undefined}
                onError={() => undefined}
              />
            )}
          </>
        )}
      </section>

      <footer className="playlist-preview-page__footer">
        <button
          type="button"
          className="playlist-preview-page__control"
          onClick={() => move(-1)}
          disabled={!current}
          aria-label="Previous item"
        >
          <SkipBack size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="playlist-preview-page__control"
          onClick={() => setPaused((value) => !value)}
          disabled={!current}
          aria-label={paused ? "Resume preview" : "Pause preview"}
        >
          {paused ? (
            <Play size={22} aria-hidden="true" />
          ) : (
            <Pause size={22} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="playlist-preview-page__control"
          onClick={() => move(1)}
          disabled={!current}
          aria-label="Next item"
        >
          <SkipForward size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="playlist-preview-page__control playlist-preview-page__control--mute"
          onClick={() => setMuted((value) => !value)}
          disabled={!current}
          aria-label={muted ? "Unmute preview" : "Mute preview"}
        >
          {muted ? (
            <VolumeX size={20} aria-hidden="true" />
          ) : (
            <Volume2 size={20} aria-hidden="true" />
          )}
        </button>
      </footer>
    </main>
  );
}

export function playlistPreviewItemAvailable(
  item: PlaylistItem,
  now = Date.now(),
) {
  return (
    item.assetStatus === "ready" &&
    (!item.availableFrom || Date.parse(item.availableFrom) <= now) &&
    (!item.expiresAt || now < Date.parse(item.expiresAt))
  );
}
