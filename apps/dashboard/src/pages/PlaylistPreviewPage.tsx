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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useParams } from "react-router";
import { api } from "../api/client";
import type { PlaylistItem } from "../api/types";
import type { OrganizationRegionalProfile } from "../settings/regionalProfile";
import { useAuth } from "../auth/AuthProvider";
import { DeclarativePresentationPreview } from "../content/SourceEditors";
import { Button } from "../components/ui/button";
import { useOrganizationRegionalProfile } from "../settings/regionalProfile";

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

function mediaStyle(item: PlaylistItem) {
  return {
    objectFit: item.fitMode === "stretch" ? ("fill" as const) : item.fitMode,
  };
}

// Positions the media over the stage. The transition suffix classes stay in
// styles.css beside their keyframes; everything else on this page is Tailwind.
const MEDIA_BASE = "absolute inset-0 block h-full w-full";

function PreviewControl({
  label,
  onClick,
  disabled,
  className = "",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={`cursor-pointer rounded-lg border border-[#445668] bg-transparent p-0 text-[#f5f7fa] hover:bg-[#202c38] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6f94eb] disabled:cursor-default disabled:text-[#667582] disabled:hover:bg-transparent ${className}`}
    >
      {children}
    </Button>
  );
}

function PreviewMedia({
  item,
  active,
  paused,
  muted,
  csrfToken,
  regional,
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
  regional: OrganizationRegionalProfile;
  className: string;
  onReady: () => void;
  onDone: () => void;
  onError: () => void;
}) {
  const { t } = useTranslation("playlists");
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
        className={`${className} grid place-items-stretch overflow-hidden declarative-widget-preview`}
      >
        {presentationQuery.data ? (
          <DeclarativePresentationPreview
            presentation={presentationQuery.data}
            source={sourceQuery.data}
            regional={regional}
            assetImageUrl={
              imageAssetId ? api.assetPreviewUrl(imageAssetId) : undefined
            }
            onWebReady={onReady}
          />
        ) : (
          <span>{t("preview.preparingWidget")}</span>
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
  const { t } = useTranslation("playlists");
  const regional = useOrganizationRegionalProfile();
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
    document.title = t("preview.documentTitle", { name: query.data.name });
    return () => {
      document.title = previous;
    };
  }, [query.data, t]);
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
    return (
      <main className="fixed inset-0 z-[1000] grid min-h-screen min-w-[320px] grid-rows-[auto_minmax(0,1fr)_auto] bg-[#05070a] text-[#f5f7fa]">
        {t("preview.loading")}
      </main>
    );
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
    return (
      <main className="fixed inset-0 z-[1000] grid min-h-screen min-w-[320px] grid-rows-[auto_minmax(0,1fr)_auto] bg-[#05070a] text-[#f5f7fa]">
        {t("preview.loading")}
      </main>
    );
  if (query.isError || !query.data)
    return (
      <main className="fixed inset-0 z-[1000] grid min-h-screen min-w-[320px] grid-rows-[auto_minmax(0,1fr)_auto] place-content-center gap-2 bg-[#05070a] text-center text-[#f5f7fa]">
        <strong>{t("preview.unavailableTitle")}</strong>
        <span className="text-[#aab8c5]">
          {query.error instanceof Error
            ? query.error.message
            : t("preview.loadError")}
        </span>
      </main>
    );

  return (
    <main className="fixed inset-0 z-[1000] grid min-h-screen min-w-[320px] grid-rows-[auto_minmax(0,1fr)_auto] bg-[#05070a] text-[#f5f7fa]">
      <header className="relative z-[2] flex items-center justify-between gap-2.5 border-b border-[#283440] bg-[#0e141be8] px-4 py-3">
        <div className="grid min-w-0 gap-0.5">
          <strong className="truncate">{query.data.name}</strong>
          <span aria-live="polite" className="truncate text-[#aab8c5]">
            {current
              ? t("preview.position", {
                  index: index + 1,
                  total: items.length,
                  name: current.assetName,
                })
              : t("preview.noItems")}
          </span>
        </div>
        <PreviewControl
          label={t("preview.close")}
          onClick={() => window.close()}
        >
          <X size={20} aria-hidden="true" />
        </PreviewControl>
      </header>

      <section
        className="relative grid min-h-0 place-items-center overflow-hidden bg-black"
        aria-label={t("preview.regionLabel")}
      >
        {!current ? (
          <div className="grid gap-1.5 p-6 text-center">
            <strong>{t("preview.noItems")}</strong>
            <span className="text-[#aab8c5]">{t("preview.emptyHint")}</span>
          </div>
        ) : failed ? (
          <div className="grid gap-1.5 p-6 text-center">
            <strong>{current.assetName}</strong>
            <span className="text-[#aab8c5]">{t("preview.itemError")}</span>
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
              regional={regional}
              className={`${MEDIA_BASE} ${crossfade ? "playlist-preview-page__media--incoming" : `playlist-preview-page__media--${current.transition}`}`}
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
                regional={regional}
                className={`${MEDIA_BASE} playlist-preview-page__media--outgoing${crossfade.ready ? " playlist-preview-page__media--outgoing-active" : ""}`}
                onReady={() => undefined}
                onDone={() => undefined}
                onError={() => undefined}
              />
            )}
          </>
        )}
      </section>

      <footer className="relative z-[2] flex items-center justify-center gap-2.5 border-t border-[#283440] bg-[#0e141be8] px-4 py-3">
        <PreviewControl
          label={t("preview.previous")}
          onClick={() => move(-1)}
          disabled={!current}
        >
          <SkipBack size={20} aria-hidden="true" />
        </PreviewControl>
        <PreviewControl
          label={paused ? t("preview.resume") : t("preview.pause")}
          onClick={() => setPaused((value) => !value)}
          disabled={!current}
        >
          {paused ? (
            <Play size={22} aria-hidden="true" />
          ) : (
            <Pause size={22} aria-hidden="true" />
          )}
        </PreviewControl>
        <PreviewControl
          label={t("preview.next")}
          onClick={() => move(1)}
          disabled={!current}
        >
          <SkipForward size={20} aria-hidden="true" />
        </PreviewControl>
        <PreviewControl
          label={muted ? t("preview.unmute") : t("preview.mute")}
          onClick={() => setMuted((value) => !value)}
          disabled={!current}
          className="ml-4"
        >
          {muted ? (
            <VolumeX size={20} aria-hidden="true" />
          ) : (
            <Volume2 size={20} aria-hidden="true" />
          )}
        </PreviewControl>
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
