import { Button } from "../ui/button";
import {
  AppPlacementPreview,
  AssetPlaybackPreview,
  isPlaylistZoneMediaItem,
  PlaylistZonePreview,
  WidgetLivePreview,
  assetPreviewStyle,
} from "./WidgetLivePreview";
import type { LayoutCaptureCoordinator } from "./layoutCaptureReadiness";
import { Group, Image as ImageIcon, ListVideo } from "lucide-react";
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  Asset,
  LayoutDocument,
  LayoutPlacement,
  Playlist,
} from "../../api/types";
import { layoutFontStack } from "../../layoutFonts";

export function LayoutPlacementView({
  item,
  canvas,
  content,
  playlist,
  assetsById,
  previewValues,
  playbackPreview = false,
  previewDate,
  captureCoordinator,
  selected = false,
  onPointerDown,
  onResize,
  onContextMenu,
}: {
  item: LayoutPlacement;
  canvas: LayoutDocument["canvas"];
  content?: Asset;
  playlist?: Playlist;
  assetsById?: Map<string, Asset>;
  previewValues?: Record<string, Record<string, string>>;
  playbackPreview?: boolean;
  /** Layout-selected preview date (YYYY-MM-DD) for V2 Widget zones. */
  previewDate?: string;
  /**
   * Capture coordinator owned by the editor canvas. Only the canvas passes it:
   * popup and playlist previews are never rasterized into thumbnails.
   */
  captureCoordinator?: LayoutCaptureCoordinator;
  selected?: boolean;
  onPointerDown?: (event: ReactPointerEvent) => void;
  onResize?: (event: ReactPointerEvent) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation("layouts");
  if (!item.visible) return null;
  const primitive = item.primitive;
  const style: CSSProperties = {
    left: String((item.x / canvas.width) * 100) + "%",
    top: String((item.y / canvas.height) * 100) + "%",
    width: String((item.width / canvas.width) * 100) + "%",
    height: String((item.height / canvas.height) * 100) + "%",
    zIndex: item.layer,
    opacity: item.opacity,
  };
  const playlistPreviewItem = playlist?.items.find(
    (playlistItem) =>
      playlistItem.assetStatus === "ready" &&
      isPlaylistZoneMediaItem(playlistItem),
  );
  return (
    <div
      className={
        "layout-placement " +
        (selected ? "is-selected" : "") +
        " " +
        (item.locked ? "is-locked" : "")
      }
      style={style}
      onPointerDown={onPointerDown}
      // Capture phase so the menu target is set before the Base UI trigger opens.
      onContextMenuCapture={onContextMenu}
    >
      {item.type === "playlistZone" ? (
        playbackPreview && playlist?.items?.length ? (
          <PlaylistZonePreview
            placement={item}
            playlist={playlist}
            assetsById={assetsById ?? new Map()}
          />
        ) : playlistPreviewItem?.thumbnailUrl ? (
          <img
            className="layout-asset-placement"
            src={playlistPreviewItem.thumbnailUrl}
            alt=""
            draggable={false}
            style={assetPreviewStyle(
              item.playback?.fit,
              item.playback?.cornerRadius,
            )}
          />
        ) : (
          <div className="layout-playlist-zone">
            <ListVideo size={22} />
            <strong>{playlist?.name ?? item.name}</strong>
            <span>
              {t("editor.zoneBadge", {
                count: playlist?.itemCount ?? 0,
              })}
            </span>
          </div>
        )
      ) : item.type === "asset" ? (
        playbackPreview && content ? (
          <AssetPlaybackPreview asset={content} placement={item} />
        ) : content?.thumbnailUrl ? (
          <img
            className="layout-asset-placement"
            src={content.thumbnailUrl}
            alt=""
            draggable={false}
            style={assetPreviewStyle(
              item.playback?.fit,
              item.playback?.cornerRadius,
            )}
          />
        ) : (
          <div className="layout-placement-placeholder">
            <ImageIcon size={22} />
            <span>{content?.name ?? item.name}</span>
          </div>
        )
      ) : item.type === "widget" ? (
        content?.widget ? (
          <WidgetLivePreview
            asset={content}
            item={item}
            previewDate={previewDate}
            captureTracking={
              captureCoordinator
                ? { coordinator: captureCoordinator, zoneId: item.id }
                : undefined
            }
          />
        ) : (
          <AppPlacementPreview asset={content} item={item} />
        )
      ) : primitive?.kind === "text" ? (
        <div
          className="layout-text-primitive"
          style={{
            fontFamily: layoutFontStack(primitive.fontFamily),
            fontSize:
              String(((primitive.fontSize ?? 48) / canvas.width) * 100) + "cqw",
            fontWeight: primitive.fontWeight,
            textAlign: primitive.textAlign,
            color: primitive.color,
            backgroundColor: primitive.backgroundColor,
            lineHeight: primitive.lineHeight,
            letterSpacing: primitive.letterSpacing,
            padding:
              String(((primitive.padding ?? 0) / canvas.width) * 100) + "cqw",
            border:
              String(primitive.borderWidth ?? 0) +
              "px solid " +
              (primitive.borderColor ?? "transparent"),
            borderRadius: String(primitive.cornerRadius ?? 0) + "px",
            justifyContent:
              primitive.verticalAlign === "top"
                ? "flex-start"
                : primitive.verticalAlign === "bottom"
                  ? "flex-end"
                  : "center",
            WebkitLineClamp: primitive.maximumLines,
            overflow: "hidden",
          }}
        >
          {primitive.binding
            ? (() => {
                const binding = primitive.binding;
                const value =
                  previewValues?.[binding.dataSourceId]?.[binding.field];
                return value
                  ? (binding.prefix ?? "") + value + (binding.suffix ?? "")
                  : binding.fallbackText ||
                      (binding.prefix ?? "") +
                        "{{" +
                        binding.field +
                        "}}" +
                        (binding.suffix ?? "");
              })()
            : primitive.text}
        </div>
      ) : primitive?.kind === "circle" ? (
        <div
          className="layout-shape layout-shape--circle"
          style={{
            background: primitive.fillColor,
            border:
              String(primitive.strokeWidth ?? 0) +
              "px solid " +
              (primitive.strokeColor ?? "transparent"),
          }}
        />
      ) : primitive?.kind === "line" ? (
        <div
          className="layout-line"
          style={{
            height: String(Math.max(1, primitive.strokeWidth ?? 4)) + "px",
            background: primitive.strokeColor,
          }}
        />
      ) : primitive?.kind === "group" ? (
        <div className="layout-group-outline">
          <Group size={18} />
          <span>{item.name}</span>
        </div>
      ) : (
        <div
          className="layout-shape"
          style={{
            background: primitive?.fillColor,
            border:
              String(primitive?.strokeWidth ?? 0) +
              "px solid " +
              (primitive?.strokeColor ?? "transparent"),
            borderRadius: String(primitive?.cornerRadius ?? 0) + "px",
          }}
        />
      )}
      {selected && !item.locked && onResize && (
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          className="layout-resize-handle"
          aria-label={t("editor.resizeLabel")}
          onPointerDown={onResize}
        />
      )}
    </div>
  );
}
