import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Asset } from "../../api/types";
import { AssetPreview } from "../content/AssetPreview";

const statusKeys = {
  ready: "picker.grid.status.ready",
  uploading: "picker.grid.status.uploading",
  uploaded: "picker.grid.status.uploaded",
  queued: "picker.grid.status.queued",
  inspecting: "picker.grid.status.inspecting",
  processing: "picker.grid.status.processing",
  failed: "picker.grid.status.failed",
  deleting: "picker.grid.status.deleting",
  deleted: "picker.grid.status.deleted",
} as const;

export function ContentLibraryGrid({
  items,
  view,
  selectedIds,
  disabledIds,
  highlightedIds,
  onToggle,
}: {
  items: Asset[];
  view: "grid" | "list";
  selectedIds: Set<string>;
  disabledIds: Set<string>;
  highlightedIds: Set<string>;
  onToggle: (asset: Asset) => void;
}) {
  const { t } = useTranslation("content");
  return (
    <div className={`picker-library picker-library--${view}`}>
      {items.map((asset) => {
        const selected = selectedIds.has(asset.id);
        const disabled =
          disabledIds.has(asset.id) || asset.processingStatus !== "ready";
        return (
          <button
            type="button"
            key={asset.id}
            className={`picker-content-card${selected ? " is-selected" : ""}${highlightedIds.has(asset.id) ? " is-new" : ""}`}
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onToggle(asset)}
          >
            <span className="picker-content-card__preview">
              <AssetPreview asset={asset} />
              {selected && (
                <span className="picker-selection-mark" aria-hidden="true">
                  <Check size={16} />
                </span>
              )}
            </span>
            <span className="picker-content-card__details">
              <strong>{asset.name}</strong>
              <small>
                {asset.type === "widget"
                  ? asset.widget?.provider === "youtube"
                    ? t("picker.grid.typeYouTube")
                    : t("picker.grid.typeWebsite")
                  : asset.type === "image"
                    ? t("picker.grid.typeImage")
                    : t("picker.grid.typeVideo")}
              </small>
            </span>
            <span
              className={`media-status media-status--${asset.processingStatus}`}
            >
              {t(statusKeys[asset.processingStatus])}
            </span>
          </button>
        );
      })}
    </div>
  );
}
