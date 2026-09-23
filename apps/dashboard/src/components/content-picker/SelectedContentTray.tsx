import { X } from "lucide-react";
import type { Asset } from "../../api/types";
import { Button } from "../ui/button";

export function SelectedContentTray({
  items,
  onRemove,
  onClear,
}: {
  items: Asset[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="selected-content-tray">
      <div>
        <strong>{items.length} selected</strong>
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          Clear selection
        </Button>
      </div>
      <ul>
        {items.map((asset) => (
          <li key={asset.id}>
            <span>{asset.name}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${asset.name} from selection`}
              onClick={() => onRemove(asset.id)}
            >
              <X size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
