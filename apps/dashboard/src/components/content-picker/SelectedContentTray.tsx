import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Asset } from "../../api/types";
import { Button } from "../ui/button";
import { ItemGroup } from "../ui/item";

export function SelectedContentTray({
  items,
  onRemove,
  onClear,
}: {
  items: Asset[];
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  if (items.length === 0) return null;
  return (
    <div className="selected-content-tray">
      <div>
        <strong>
          {t("picker.tray.selectedCount", { count: items.length })}
        </strong>
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          {t("picker.tray.clearSelection")}
        </Button>
      </div>
      <ItemGroup className="flex-row flex-nowrap gap-2 overflow-x-auto pb-1">
        {items.map((asset) => (
          <li key={asset.id}>
            <span>{asset.name}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("picker.tray.removeFromSelection", {
                name: asset.name,
              })}
              onClick={() => onRemove(asset.id)}
            >
              <X size={14} />
            </Button>
          </li>
        ))}
      </ItemGroup>
    </div>
  );
}
