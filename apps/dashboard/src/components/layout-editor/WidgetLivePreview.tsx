import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Image as ImageIcon, ListVideo } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { V2ZonePreview } from "./V2ZonePreview";
import { studioWidgetComponent } from "../../content/studioWidgets";
import { api } from "../../api/client";
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

export function PlaylistZonePreview({
  placement,
  playlist,
  assetsById,
  live,
  scale,
}: {
  placement: LayoutPlacement;
  playlist: Playlist;
  assetsById: Map<string, Asset>;
  live: LivePreviewData;
  scale: number;
}) {
  const { t } = useTranslation("layouts");
  const items = playlist.items.filter((item) => item.assetStatus === "ready");
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
            live={live}
            scale={scale}
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
  scale,
}: {
  asset: Asset;
  item: LayoutPlacement;
  live: LivePreviewData;
  scale: number;
}) {
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: () => api.contentDefinitions(),
  });
  const provider = asset.widget!.provider;
  if (studioWidgetComponent(definitions.data, provider))
    return (
      <V2ZonePreview
        provider={provider}
        asset={asset}
        width={item.width * scale}
        height={item.height * scale}
        overrides={item.overrides}
      />
    );
  return <AppPlacementPreview asset={asset} item={item} />;
}
