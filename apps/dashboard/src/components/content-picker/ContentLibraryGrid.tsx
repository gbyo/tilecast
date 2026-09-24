import { Check } from "lucide-react";
import type { Asset } from "../../api/types";
import { Button } from "../ui/button";
import { AssetPreview } from "../content/AssetPreview";

function statusLabel(status: Asset["processingStatus"]) {
  return (
    {
      ready: "Ready",
      uploading: "Uploading",
      uploaded: "Uploaded",
      queued: "Waiting",
      inspecting: "Inspecting",
      processing: "Processing",
      failed: "Failed",
      deleting: "Deleting",
      deleted: "Deleted",
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
                    ? "YouTube Widget"
                    : "Website Widget"
                  : asset.type === "image"
                    ? "Image"
                    : "Video"}
              </small>
            </span>
            <span
              className={`media-status media-status--${asset.processingStatus}`}
            >
              {statusLabel(asset.processingStatus)}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
