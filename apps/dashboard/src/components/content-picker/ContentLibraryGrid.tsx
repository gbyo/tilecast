import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Asset } from "../../api/types";
import { Button } from "../ui/button";
import { AssetPreview } from "../content/AssetPreview";

function statusLabel(
  status: Asset["processingStatus"],
  t: TFunction<["content", "common"]>,
) {
  return (
    {
      ready: t("media.status.ready"),
      uploading: t("media.status.uploading"),
      uploaded: t("media.status.uploaded"),
      queued: t("media.status.waiting"),
      inspecting: t("media.status.inspecting"),
      processing: t("media.status.processing"),
      failed: t("media.status.failed"),
      deleting: t("media.status.deleting"),
      deleted: t("media.status.deleted"),
    }[status] ?? status
  );
}

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
  const { t } = useTranslation(["content", "common"]);
  return (
    <div className={`picker-library picker-library--${view}`}>
      {items.map((asset) => {
        const selected = selectedIds.has(asset.id);
        const disabled =
          disabledIds.has(asset.id) || asset.processingStatus !== "ready";
        return (
          <Button
            type="button"
            key={asset.id}
            variant="ghost"
            className={`picker-content-card h-auto w-full grid-cols-1 whitespace-normal${selected ? " is-selected" : ""}${highlightedIds.has(asset.id) ? " is-new" : ""}`}
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
                    ? t("media.type.youtubeWidget")
                    : t("media.type.websiteWidget")
                  : asset.type === "image"
                    ? t("media.type.image")
                    : t("media.type.video")}
              </small>
            </span>
            <span
              className={`media-status media-status--${asset.processingStatus}`}
            >
              {statusLabel(asset.processingStatus, t)}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
