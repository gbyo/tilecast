import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import { Image as ImageIcon, ListVideo } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { V2ZonePreview } from "./V2ZonePreview";
import { api } from "../../api/client";
import type {
  Asset,
  CalendarEvent,
  ClockWidgetConfig,
  DataSourceProvider,
  DateWidgetConfig,
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
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const regional = settings.data?.values ?? {};
  const regionalLocale = regionalSetting(
    regional,
    "organization.locale",
    "en-US",
  );
  const regionalTimezone = regionalSetting(
    regional,
    "organization.timezone",
    "UTC",
  );
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
  let value = asset?.name ?? item.name;
  if (provider === "clock") {
    value = clockText(
      config as unknown as ClockWidgetConfig,
      regionalLocale,
      regionalTimezone,
      regionalSetting(regional, "organization.time_format", "locale"),
    );
  } else if (provider === "date") {
    value = dateText(
      config as unknown as DateWidgetConfig,
      regionalLocale,
      regionalTimezone,
      regionalSetting(regional, "organization.date_format", "locale"),
    );
  } else if (provider === "ticker")
    value = `${asset?.name ?? "Ticker"} · live data`;
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
      <strong>{value}</strong>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Faithful native-widget preview. Mirrors the Android Player's Compose renderers
// (apps/player-android/.../content/NativeWidgetPlayback.kt + CalendarPlayback.kt)
// so the Layout preview shows real live data laid out like the Player. Canvas
// pixel sizes are multiplied by `scale` (renderedFrameWidth / canvasWidth) to
// match how the Player scales the whole canvas onto the screen.
// ---------------------------------------------------------------------------

// The Player parses colors with android.graphics.Color.parseColor, which uses
// #AARRGGBB order and falls back to black on any failure.
export function colorToCss(
  value: string | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  const v = value.trim();
  const argb = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{6})$/.exec(v);
  if (argb) {
    const alpha = argb[1] ?? "ff";
    const rgb = argb[2] ?? "000000";
    const a = parseInt(alpha, 16) / 255;
    const r = parseInt(rgb.slice(0, 2), 16);
    const g = parseInt(rgb.slice(2, 4), 16);
    const b = parseInt(rgb.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v)) return v;
  return fallback;
}

// The QR encoder needs solid #RRGGBB colors; drop any leading ARGB alpha.
export function hex6(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return `#${v.slice(3)}`;
  return fallback;
}

export function structuredFieldValue(
  record: StructuredRecord,
  field: string,
): string {
  if (field === "title") return record.title ?? "";
  if (field === "subtitle") return record.subtitle ?? "";
  if (field === "date") return record.date ?? "";
  if (field === "author") return record.author ?? "";
  if (field === "description") return record.description ?? "";
  return record.values?.[field] ?? "";
}

function regionalSetting(
  values: Record<string, unknown> | undefined,
  key: string,
  fallback: string,
): string {
  const value = values?.[key];
  return typeof value === "string" ? value : fallback;
}

export function clockText(
  cfg: ClockWidgetConfig,
  locale: string,
  organizationTimezone: string,
  organizationTimeFormat: string,
  now = new Date(),
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: cfg.timezone || organizationTimezone,
    hour: "numeric",
    minute: "2-digit",
    ...(cfg.showSeconds ? { second: "2-digit" as const } : {}),
  };
  const choice = cfg.format === "locale" ? organizationTimeFormat : cfg.format;
  if (choice === "12" || choice === "12-hour") options.hour12 = true;
  if (choice === "24" || choice === "24-hour") options.hour12 = false;
  if (choice === "24" || choice === "24-hour") options.hour = "2-digit";
  return new Intl.DateTimeFormat(locale, options).format(now);
}

export function dateText(
  cfg: DateWidgetConfig,
  locale: string,
  organizationTimezone: string,
  organizationDateFormat: string,
  now = new Date(),
): string {
  const timezone = cfg.timezone || organizationTimezone;
  const dateFormat =
    cfg.format === "locale" ? organizationDateFormat : "locale";
  if (
    dateFormat === "yyyy-MM-dd" ||
    dateFormat === "MM/dd/yyyy" ||
    dateFormat === "dd/MM/yyyy"
  ) {
    const parts = new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    if (dateFormat === "yyyy-MM-dd")
      return [part("year"), part("month"), part("day")].join("-");
    const order =
      dateFormat === "MM/dd/yyyy"
        ? ["month", "day", "year"]
        : ["day", "month", "year"];
    return order
      .map((type) => part(type as Intl.DateTimeFormatPartTypes))
      .join("/");
  }
  return new Intl.DateTimeFormat(locale, {
    dateStyle: cfg.format === "locale" ? "short" : cfg.format,
    timeZone: timezone,
  }).format(now);
}

export function widgetContentArea(
  item: Pick<LayoutPlacement, "width" | "height">,
  cfg: { contentPadding?: number },
) {
  const padding = Math.max(0, Math.min(40, cfg.contentPadding ?? 10)) / 100;
  return {
    width: item.width * (1 - padding * 2),
    height: item.height * (1 - padding * 2),
    horizontalPadding: item.width * padding,
    verticalPadding: item.height * padding,
  };
}

// Shrinks text to fit its box, matching the Player's FittedWidgetText.
export function FittedText({
  text,
  color,
  fontPx,
  weight,
  maxLines = 1,
  textScale = 100,
}: {
  text: string;
  color: string;
  fontPx: number;
  weight: number;
  maxLines?: number;
  textScale?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const span = spanRef.current;
    if (!box || !span) return;
    const shrinkToFit = (from: number) => {
      let size = from;
      span.style.fontSize = `${size}px`;
      let guard = 0;
      while (
        guard++ < 80 &&
        size > 4 &&
        (span.scrollWidth > box.clientWidth + 1 ||
          span.scrollHeight > box.clientHeight + 1)
      ) {
        size = Math.max(4, size * 0.9);
        span.style.fontSize = `${size}px`;
      }
      return size;
    };
    // Automatic sizing is the bounds-first fit. An author scale multiplies that
    // — previously it was capped at 1, which made every scale above 100 percent
    // a no-op — and a second fit pass is the final guard against overflow.
    const automatic = shrinkToFit(fontPx);
    const authorScale = Math.max(25, Math.min(500, textScale)) / 100;
    if (authorScale !== 1) shrinkToFit(automatic * authorScale);
  }, [text, fontPx, maxLines, textScale]);
  return (
    <div ref={boxRef} className="wpv-fit-box">
      <span
        ref={spanRef}
        className={`wpv-fit ${maxLines > 1 ? "wpv-fit--multi" : ""}`}
        style={{ color, fontWeight: weight }}
      >
        {text}
      </span>
    </div>
  );
}

// Full-bleed background with content centered inside an inset, like CenteredWidget.
export function CenteredWidget({
  background,
  item,
  scale,
  contentPadding,
  children,
}: {
  background: string;
  item: LayoutPlacement;
  scale: number;
  contentPadding?: number;
  children: ReactNode;
}) {
  const area = widgetContentArea(item, { contentPadding });
  return (
    <div
      className="wpv-root wpv-centered"
      style={{
        background,
        padding: `${area.verticalPadding * scale}px ${area.horizontalPadding * scale}px`,
      }}
    >
      {children}
    </div>
  );
}

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
  const widget = asset.widget!;
  const provider = widget.provider;
  const cfg = widget.configuration as Record<string, unknown>;
  const fg = colorToCss(cfg.foregroundColor as string, "#F5F7FA");
  const bg = colorToCss(cfg.backgroundColor as string, "#0E141B");
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const regional = settings.data?.values ?? {};
  const regionalLocale = regionalSetting(
    regional,
    "organization.locale",
    "en-US",
  );
  const regionalTimezone = regionalSetting(
    regional,
    "organization.timezone",
    "UTC",
  );
  switch (provider) {
    case "clock":
    case "qrcode":
    case "qr-call-to-action":
    case "qr-code":
    case "list":
    case "table":
    case "cards":
    case "menu":
    case "agenda":
    case "weather":
    case "news":
    case "news-feed":
    case "custom-rss":
    case "atom-feed":
    case "espn":
    case "bbc-news":
    case "sky-news":
    case "the-guardian":
    case "ticker":
    case "rss-ticker":
      // Migrated V2 Widgets render the real Web Component through the
      // shared preview host. Each migration deletes its hand-written branch
      // here; zone-specific renderers are never added.
      return (
        <V2ZonePreview
          provider={provider}
          asset={asset}
          width={item.width * scale}
          height={item.height * scale}
          overrides={item.overrides}
        />
      );
    case "date":
      return (
        <CenteredWidget
          background={bg}
          item={item}
          scale={scale}
          contentPadding={(cfg as unknown as DateWidgetConfig).contentPadding}
        >
          <FittedText
            text={dateText(
              cfg as unknown as DateWidgetConfig,
              regionalLocale,
              regionalTimezone,
              regionalSetting(regional, "organization.date_format", "locale"),
            )}
            color={fg}
            fontPx={Math.max(item.width, item.height) * scale}
            weight={500}
            textScale={(cfg as unknown as DateWidgetConfig).textScale}
          />
        </CenteredWidget>
      );
    default:
      return <AppPlacementPreview asset={asset} item={item} />;
  }
}
