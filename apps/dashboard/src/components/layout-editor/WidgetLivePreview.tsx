import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import QRCode from "qrcode";
import { Image as ImageIcon, ListVideo } from "lucide-react";
import { api } from "../../api/client";
import type {
  Asset,
  CalendarEvent,
  ClockWidgetConfig,
  DataSourceProvider,
  DateWidgetConfig,
  DisplayWidgetConfig,
  LayoutPlacement,
  Playlist,
  PlaylistItem,
  QRCodeWidgetConfig,
  StructuredRecord,
  TickerWidgetConfig,
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
        <span>No ready items</span>
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
    const timezone =
      typeof config.timezone === "string" ? config.timezone : "UTC";
    value = new Intl.DateTimeFormat(undefined, {
      timeStyle: config.showSeconds ? "medium" : "short",
      timeZone: timezone,
    }).format(new Date());
  } else if (provider === "date") {
    const timezone =
      typeof config.timezone === "string" ? config.timezone : "UTC";
    value = new Intl.DateTimeFormat(undefined, {
      dateStyle:
        (config.format as "full" | "long" | "medium" | "short") ?? "full",
      timeZone: timezone,
    }).format(new Date());
  } else if (provider === "qrcode")
    value =
      typeof config.label === "string" && config.label
        ? config.label
        : "QR Code";
  else if (provider === "ticker")
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
        {provider ?? "Widget"}
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

export function menuFieldLabel(field: string): string {
  const key = field.toLowerCase();
  if (
    ["option_2", "alternative", "secondary", "secondary_option"].includes(key)
  )
    return "Alternative";
  if (
    ["option_1", "primary", "primary_option", "entree", "entrée"].includes(key)
  )
    return "Entrée";
  return field.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function clockText(cfg: ClockWidgetConfig): string {
  const is24 = cfg.format === "24";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: cfg.timezone || "UTC",
    hour12: !is24,
    hour: is24 ? "2-digit" : "numeric",
    minute: "2-digit",
    ...(cfg.showSeconds ? { second: "2-digit" as const } : {}),
  }).format(new Date());
}

export function dateText(cfg: DateWidgetConfig): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: cfg.format || "full",
    timeZone: cfg.timezone || "UTC",
  }).format(new Date());
}

export function tickerText(
  cfg: TickerWidgetConfig,
  source?: LivePreviewSource,
): string {
  const parts = (source?.records ?? [])
    .map((record) => structuredFieldValue(record, cfg.field || "title"))
    .filter((value) => value.trim().length > 0);
  return parts.length
    ? parts.join(cfg.separator || " • ")
    : source?.emptyState || "No items available";
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

export function QrWidget({
  cfg,
  item,
  scale,
}: {
  cfg: QRCodeWidgetConfig;
  item: LayoutPlacement;
  scale: number;
}) {
  const [dataUrl, setDataUrl] = useState("");
  useEffect(() => {
    if (!cfg.value) {
      setDataUrl("");
      return;
    }
    void QRCode.toDataURL(cfg.value, {
      margin: 2,
      errorCorrectionLevel: { low: "L", medium: "M", quartile: "Q", high: "H" }[
        cfg.errorCorrection
      ] as "L" | "M" | "Q" | "H",
      color: {
        dark: hex6(cfg.foregroundColor, "#000000"),
        light: hex6(cfg.backgroundColor, "#ffffff"),
      },
      width: 480,
    })
      .then(setDataUrl)
      .catch(() => setDataUrl(""));
  }, [
    cfg.value,
    cfg.errorCorrection,
    cfg.foregroundColor,
    cfg.backgroundColor,
  ]);
  const area = widgetContentArea(item, cfg);
  const label = cfg.label?.trim();
  return (
    <div
      className="wpv-root wpv-qr"
      style={{
        background: colorToCss(cfg.backgroundColor, "#FFFFFF"),
        padding: `${area.verticalPadding * scale}px ${area.horizontalPadding * scale}px`,
        gap: area.height * scale * 0.025,
      }}
    >
      {dataUrl && <img className="wpv-qr__image" src={dataUrl} alt="" />}
      {label && (
        <div style={{ width: "100%", height: "18%" }}>
          <FittedText
            text={label}
            color={colorToCss(cfg.foregroundColor, "#000000")}
            fontPx={Math.max(area.width, area.height) * scale}
            weight={400}
            maxLines={2}
            textScale={cfg.textScale}
          />
        </div>
      )}
    </div>
  );
}

export function MenuWidget({
  name,
  cfg,
  source,
  fg,
  bg,
  scale,
  item,
}: {
  name: string;
  cfg: DisplayWidgetConfig;
  source?: LivePreviewSource;
  fg: string;
  bg: string;
  scale: number;
  item: LayoutPlacement;
}) {
  const record = source?.records?.[0];
  const values = record
    ? (cfg.fields ?? [])
        .map((field) => ({ field, value: structuredFieldValue(record, field) }))
        .filter((entry) => entry.value.trim().length > 0)
        .slice(0, Math.min(cfg.maximumItems ?? 8, 8))
    : [];
  const area = widgetContentArea(item, cfg);
  const padding = `${area.verticalPadding * scale}px ${area.horizontalPadding * scale}px`;
  if (!values.length)
    return (
      <div
        className="wpv-root wpv-centered"
        style={{ background: bg, padding }}
      >
        <FittedText
          text={source?.emptyState || "No items available"}
          color={fg}
          fontPx={Math.max(area.width, area.height) * scale}
          weight={500}
          maxLines={3}
          textScale={cfg.textScale}
        />
      </div>
    );
  const authorScale = Math.max(25, Math.min(500, cfg.textScale ?? 100)) / 100;
  const contentFactor = Math.max(
    0.05,
    Math.min(
      area.height / (50 + values.length * 150),
      (area.height / (50 + values.length * 150)) * authorScale,
    ),
  );
  return (
    <div className="wpv-root wpv-menu" style={{ background: bg, padding }}>
      <div
        className="wpv-menu__header"
        style={{ color: fg, fontSize: 24 * scale * contentFactor }}
      >
        {name.toUpperCase()}
      </div>
      {record?.date && (
        <div
          className="wpv-menu__date"
          style={{ color: fg, fontSize: 18 * scale * contentFactor }}
        >
          {record.date}
        </div>
      )}
      {values.map((entry, index) => (
        <div key={entry.field} className="wpv-menu__item">
          <div
            className="wpv-menu__label"
            style={{
              color: fg,
              fontSize: (index === 0 ? 20 : 16) * scale * contentFactor,
              paddingTop: (index === 0 ? 28 : 22) * scale * contentFactor,
            }}
          >
            {index === 0
              ? "TODAY'S LUNCH"
              : menuFieldLabel(entry.field).toUpperCase()}
          </div>
          <div
            className="wpv-menu__value"
            style={{
              color: fg,
              fontSize: (index === 0 ? 52 : 34) * scale * contentFactor,
              fontWeight: index === 0 ? 700 : 500,
            }}
          >
            {entry.value}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DisplayWidget({
  cfg,
  source,
  fg,
  bg,
  scale,
  item,
}: {
  cfg: DisplayWidgetConfig;
  source?: LivePreviewSource;
  fg: string;
  bg: string;
  scale: number;
  item: LayoutPlacement;
}) {
  const max = cfg.maximumItems ?? 20;
  let rows: string[];
  if (source?.provider === "calendar") {
    rows = (source.events ?? [])
      .slice(0, max)
      .map((event) =>
        [event.start, event.title, event.location]
          .filter((value) => value && String(value).trim().length > 0)
          .join("  "),
      );
  } else {
    const fields = cfg.fields ?? [];
    rows = (source?.records ?? [])
      .slice(0, max)
      .map((record) =>
        fields
          .map((field) => structuredFieldValue(record, field))
          .filter((value) => value.trim().length > 0)
          .join("  "),
      )
      .filter((row) => row.trim().length > 0);
  }
  const area = widgetContentArea(item, cfg);
  const padding = `${area.verticalPadding * scale}px ${area.horizontalPadding * scale}px`;
  if (!rows.length)
    return (
      <div
        className="wpv-root wpv-centered"
        style={{ background: bg, padding }}
      >
        <FittedText
          text={source?.emptyState || "No items available"}
          color={fg}
          fontPx={Math.max(area.width, area.height) * scale}
          weight={400}
          maxLines={3}
          textScale={cfg.textScale}
        />
      </div>
    );
  const gap = Math.max(2, area.height * scale * 0.025);
  const availableHeight = Math.max(1, area.height * scale);
  const maximumRows = Math.max(
    1,
    Math.floor((availableHeight + gap) / (4 * 1.15 + gap)),
  );
  const visibleRows = rows.slice(0, maximumRows);
  return (
    <div
      className="wpv-root wpv-display"
      style={{
        background: bg,
        padding,
        gap,
      }}
    >
      {visibleRows.map((row, index) => (
        <div
          key={index}
          className="wpv-display__row"
          style={{
            color: fg,
            fontSize:
              Math.min(
                (area.width * scale) / Math.max(1, row.length * 0.62),
                Math.max(4, availableHeight / visibleRows.length / 1.15),
              ) * Math.min(1, Math.max(25, cfg.textScale ?? 100) / 100),
          }}
        >
          {row}
        </div>
      ))}
    </div>
  );
}

export function WidgetLivePreview({
  asset,
  item,
  live,
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
  const bg = colorToCss(
    cfg.backgroundColor as string,
    provider === "qrcode" ? "#FFFFFF" : "#0E141B",
  );
  const sourceId = cfg.dataSourceId as string | undefined;
  const source = sourceId ? live[sourceId] : undefined;
  switch (provider) {
    case "clock":
      return (
        <CenteredWidget
          background={bg}
          item={item}
          scale={scale}
          contentPadding={(cfg as unknown as ClockWidgetConfig).contentPadding}
        >
          <FittedText
            text={clockText(cfg as unknown as ClockWidgetConfig)}
            color={fg}
            fontPx={Math.max(item.width, item.height) * scale}
            weight={600}
            textScale={(cfg as unknown as ClockWidgetConfig).textScale}
          />
        </CenteredWidget>
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
            text={dateText(cfg as unknown as DateWidgetConfig)}
            color={fg}
            fontPx={Math.max(item.width, item.height) * scale}
            weight={500}
            textScale={(cfg as unknown as DateWidgetConfig).textScale}
          />
        </CenteredWidget>
      );
    case "qrcode":
      return (
        <QrWidget
          cfg={cfg as unknown as QRCodeWidgetConfig}
          item={item}
          scale={scale}
        />
      );
    case "ticker":
      return (
        <CenteredWidget
          background={bg}
          item={item}
          scale={scale}
          contentPadding={(cfg as unknown as TickerWidgetConfig).contentPadding}
        >
          <FittedText
            text={tickerText(cfg as unknown as TickerWidgetConfig, source)}
            color={fg}
            fontPx={Math.max(item.width, item.height) * scale}
            weight={400}
            maxLines={2}
            textScale={(cfg as unknown as TickerWidgetConfig).textScale}
          />
        </CenteredWidget>
      );
    case "menu":
      return (
        <MenuWidget
          name={asset.name}
          cfg={cfg as unknown as DisplayWidgetConfig}
          source={source}
          fg={fg}
          bg={bg}
          scale={scale}
          item={item}
        />
      );
    case "list":
    case "table":
    case "agenda":
      return (
        <DisplayWidget
          cfg={cfg as unknown as DisplayWidgetConfig}
          source={source}
          fg={fg}
          bg={bg}
          scale={scale}
          item={item}
        />
      );
    default:
      return <AppPlacementPreview asset={asset} item={item} />;
  }
}
