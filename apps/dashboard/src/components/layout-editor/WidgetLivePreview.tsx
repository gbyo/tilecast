import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Image as ImageIcon, ListVideo } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import type { WidgetMountState } from "@tilecast/widget-sdk/mount";
import { layoutPreviewDateToMs, V2ZonePreview } from "./V2ZonePreview";
import type { LayoutCaptureCoordinator } from "./layoutCaptureReadiness";
import { studioWidgetComponent } from "../../content/studioWidgets";
import { api } from "../../api/client";
import {
  isAvailableAt,
  nextAvailabilityTransition,
} from "@tilecast/player-runtime/content-availability";
import { useOrganizationRegionalProfile } from "../../settings/regionalProfile";
import type {
  Asset,
  CalendarEvent,
  DataSourceProvider,
  LayoutPlacement,
  Playlist,
  PlaylistItem,
  StructuredRecord,
} from "../../api/types";

// Resolved live data for one Data Source, keyed by its id, shared by every
// widget/binding that references it so the preview mirrors the Player.
export type LivePreviewSource = {
  provider: DataSourceProvider;
  records?: StructuredRecord[];
  events?: CalendarEvent[];
  emptyState: string;
};
export type LivePreviewData = Record<string, LivePreviewSource>;

export function assetPreviewStyle(
  fit: NonNullable<LayoutPlacement["playback"]>["fit"],
  cornerRadius?: number,
): CSSProperties {
  return {
    objectFit:
      fit === "cover" ? "cover" : fit === "stretch" ? "fill" : "contain",
    borderRadius: cornerRadius,
  };
}

export function AssetPlaybackPreview({
  asset,
  placement,
}: {
  asset: Asset;
  placement: LayoutPlacement;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id]);
  if (failed || (asset.type !== "image" && asset.type !== "video"))
    return (
      <div className="layout-placement-placeholder">
        <ImageIcon size={22} />
        <span>{asset.name}</span>
      </div>
    );
  const common = {
    className: "layout-asset-placement layout-asset-placement--playback",
    src: api.assetPreviewUrl(asset.id),
    style: assetPreviewStyle(
      placement.playback?.fit,
      placement.playback?.cornerRadius,
    ),
    onError: () => setFailed(true),
  };
  if (asset.type === "video")
    return (
      <video
        {...common}
        autoPlay
        playsInline
        loop={placement.playback?.loop ?? true}
        muted={placement.playback?.muted ?? true}
        preload="auto"
      />
    );
  return <img {...common} alt="" draggable={false} />;
}

export function playlistPreviewDuration(item: PlaylistItem) {
  if (item.durationMs && item.durationMs > 0) return item.durationMs;
  return item.assetType === "video" ? undefined : 10_000;
}

export function nextPlaylistPreviewIndex(
  index: number,
  length: number,
  loop: boolean,
) {
  if (!length) return 0;
  if (index + 1 >= length) return loop ? 0 : index;
  return index + 1;
}

export function availablePlaylistZoneItems(
  playlist: Playlist,
  assetsById: Map<string, Asset>,
  at: Date,
): PlaylistItem[] {
  return playlist.items.filter((item) => {
    const asset = assetsById.get(item.assetId);
    return (
      item.assetStatus === "ready" &&
      Boolean(asset) &&
      isAvailableAt(item, at) &&
      isAvailableAt(asset, at)
    );
  });
}

export interface ZoneCaptureTracking {
  /** Coordinator owned by the Layout editor canvas. */
  coordinator: LayoutCaptureCoordinator;
  /** Placement id the zone reports under. */
  zoneId: string;
}

export function PlaylistZonePreview({
  placement,
  playlist,
  assetsById,
  previewDate,
  captureTracking,
}: {
  placement: LayoutPlacement;
  playlist: Playlist;
  assetsById: Map<string, Asset>;
  /** Layout-selected preview date, forwarded to V2 Widget zones. */
  previewDate?: string;
  /** Present only on the editor canvas, which Layout thumbnails capture. */
  captureTracking?: ZoneCaptureTracking;
}) {
  const { t } = useTranslation("layouts");
  const regional = useOrganizationRegionalProfile();
  const fixedAvailabilityAt = layoutPreviewDateToMs(
    previewDate,
    regional.timezone,
  );
  const [liveAvailabilityAt, setLiveAvailabilityAt] = useState(() =>
    Date.now(),
  );
  const availabilityAtMs = fixedAvailabilityAt ?? liveAvailabilityAt;
  const availabilityWindows = useMemo(
    () =>
      playlist.items.flatMap((item) => [item, assetsById.get(item.assetId)]),
    [playlist.items, assetsById],
  );
  const nextTransition = useMemo(
    () =>
      fixedAvailabilityAt === null
        ? nextAvailabilityTransition(
            availabilityWindows,
            new Date(availabilityAtMs),
          )
        : null,
    [availabilityAtMs, availabilityWindows, fixedAvailabilityAt],
  );
  useEffect(() => {
    if (fixedAvailabilityAt !== null || !nextTransition) return;
    const delayMs = Math.max(0, nextTransition.getTime() - Date.now());
    const timer = window.setTimeout(
      () => setLiveAvailabilityAt(Date.now()),
      delayMs + 1,
    );
    return () => window.clearTimeout(timer);
  }, [fixedAvailabilityAt, nextTransition]);
  const items = useMemo(
    () =>
      availablePlaylistZoneItems(
        playlist,
        assetsById,
        new Date(availabilityAtMs),
      ),
    [assetsById, availabilityAtMs, playlist],
  );
  const [index, setIndex] = useState(0);
  const current = items[index % Math.max(1, items.length)];
  const asset = current ? assetsById.get(current.assetId) : undefined;
  const advance = useCallback(
    () =>
      setIndex((value) => {
        return nextPlaylistPreviewIndex(
          value,
          items.length,
          placement.playback?.loop !== false,
        );
      }),
    [items.length, placement.playback?.loop],
  );
  useEffect(() => setIndex(0), [playlist.id, playlist.revision]);
  useEffect(() => {
    if (!current) return;
    const duration = playlistPreviewDuration(current);
    if (!duration) return;
    const timer = window.setTimeout(advance, duration);
    return () => window.clearTimeout(timer);
  }, [advance, current]);

  if (!current)
    return (
      <div className="layout-playlist-zone">
        <ListVideo size={22} />
        <strong>{playlist.name}</strong>
        <span>{t("preview.zoneEmpty")}</span>
      </div>
    );
  if (!asset)
    return (
      <div className="layout-placement-placeholder">
        <ListVideo size={22} />
        <span>{current.assetName}</span>
      </div>
    );
  const fit = placement.playback?.fit ?? current.fitMode;
  const radius = placement.playback?.cornerRadius;
  const className = `layout-playlist-preview${current.transition === "fade" || current.transition === "crossfade" ? " layout-playlist-preview--fade" : ""}`;
  if (asset.type === "widget")
    return (
      <div className={className} key={`${playlist.id}-${current.id}`}>
        {asset.widget ? (
          <WidgetLivePreview
            asset={asset}
            item={placement}
            previewDate={previewDate}
            captureTracking={captureTracking}
          />
        ) : (
          <AppPlacementPreview asset={asset} item={placement} />
        )}
      </div>
    );
  if (asset.type === "video")
    return (
      <video
        key={`${playlist.id}-${current.id}`}
        className={className}
        src={api.assetPreviewUrl(asset.id)}
        style={assetPreviewStyle(fit, radius)}
        autoPlay
        playsInline
        muted={(placement.playback?.muted ?? true) || !current.audioEnabled}
        preload="auto"
        onLoadedMetadata={(event) => {
          event.currentTarget.volume = current.volume;
          if (current.videoStartOffsetMs)
            event.currentTarget.currentTime = current.videoStartOffsetMs / 1000;
        }}
        onTimeUpdate={(event) => {
          if (
            current.videoEndOffsetMs &&
            event.currentTarget.currentTime >= current.videoEndOffsetMs / 1000
          )
            advance();
        }}
        onEnded={advance}
        onError={advance}
      />
    );
  return (
    <img
      key={`${playlist.id}-${current.id}`}
      className={className}
      src={api.assetPreviewUrl(asset.id)}
      style={assetPreviewStyle(fit, radius)}
      alt=""
      onError={advance}
    />
  );
}

export function AppPlacementPreview({
  asset,
  item,
}: {
  asset?: Asset;
  item: LayoutPlacement;
}) {
  const { t } = useTranslation("layouts");
  if (asset?.thumbnailUrl)
    return (
      <img
        className="layout-asset-placement"
        src={asset.thumbnailUrl}
        alt=""
        style={assetPreviewStyle(
          item.playback?.fit,
          item.playback?.cornerRadius,
        )}
      />
    );
  const provider = asset?.widget?.provider;
  const config = (asset?.widget?.configuration ?? {}) as Record<
    string,
    unknown
  >;
  const background =
    (item.overrides?.backgroundColor as string | undefined) ??
    (config.backgroundColor as string | undefined) ??
    "#18232D";
  const foreground =
    (item.overrides?.foregroundColor as string | undefined) ??
    (config.foregroundColor as string | undefined) ??
    "#F5F7FA";
  return (
    <div
      className={`layout-app-placement layout-app-placement--${provider ?? "unknown"}`}
      style={{
        background,
        color: foreground,
        alignItems:
          item.overrides?.alignment === "left"
            ? "flex-start"
            : item.overrides?.alignment === "right"
              ? "flex-end"
              : "center",
      }}
    >
      <span className="layout-app-placement__provider">
        {provider ?? t("preview.unknownProvider")}
      </span>
      <strong>{asset?.name ?? item.name}</strong>
    </div>
  );
}

/**
 * A Widget placed in a Layout zone. Every Widgets V2 Widget renders its real
 * element through the shared preview host, sized to the zone; there is no
 * provider switch and no zone-specific renderer. A Widget without a
 * component (a Web Integration, or a provider still to migrate) shows its
 * library snapshot or a labeled placeholder.
 */
export function WidgetLivePreview({
  asset,
  item,
  previewDate,
  captureTracking,
}: {
  asset: Asset;
  item: LayoutPlacement;
  /** Layout-selected preview date (YYYY-MM-DD); absent means live. */
  previewDate?: string;
  /** Present only on the editor canvas, which Layout thumbnails capture. */
  captureTracking?: ZoneCaptureTracking;
}) {
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: () => api.contentDefinitions(),
  });
  const provider = asset.widget!.provider;
  const v2 = studioWidgetComponent(definitions.data, provider);
  // Register capture-relevant zones while a V2 component is mounted. Static
  // content (snapshots, placeholders) has nothing asynchronous to wait for.
  // The asset id joins the deps so a swapped Widget re-registers as pending.
  const tracked = Boolean(captureTracking && v2);
  useEffect(() => {
    if (!captureTracking || !tracked) return;
    const { coordinator, zoneId } = captureTracking;
    coordinator.register(zoneId);
    return () => coordinator.unregister(zoneId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    captureTracking?.coordinator,
    captureTracking?.zoneId,
    asset.id,
    tracked,
  ]);
  if (v2)
    return (
      <V2ZonePreview
        provider={provider}
        asset={asset}
        // Keep the intrinsic Layout-zone geometry here. WidgetPreviewHost
        // scales the whole mounted surface to the Studio box, so responsive
        // Widget/container-query behavior matches playback instead of being
        // compiled against the already-shrunken preview pixels. Fill lets
        // the zone grow past 100% Studio zoom without underfilling.
        width={item.width}
        height={item.height}
        overrides={item.overrides}
        fit="fill"
        previewDate={previewDate}
        onState={
          captureTracking
            ? (state: WidgetMountState) =>
                captureTracking.coordinator.reportMountState(
                  captureTracking.zoneId,
                  state.state,
                )
            : undefined
        }
      />
    );
  return <AppPlacementPreview asset={asset} item={item} />;
}
