import { X } from "lucide-react";
import type { Asset } from "../../api/types";
import { Button } from "../ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "../ui/item";

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
      <ItemGroup className="flex-row flex-nowrap gap-2 overflow-x-auto pb-1">
        {items.map((asset) => (
          <Item
            key={asset.id}
            variant="outline"
            size="xs"
            className="max-w-[240px] shrink-0 bg-background"
          >
            <ItemContent className="min-w-0">
              <ItemTitle className="truncate">{asset.name}</ItemTitle>
            </ItemContent>
            <ItemActions>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${asset.name} from selection`}
                onClick={() => onRemove(asset.id)}
              >
                <X size={14} />
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}
