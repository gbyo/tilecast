import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Asset } from "../../api/types";
import { Button } from "../ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "../ui/item";

// SelectedContentTray is the footer's selection summary: the count, a way to
// clear it, and each chosen resource with its own remove control.
export function SelectedContentTray({
  items,
  preparing,
  onRemove,
  onClear,
}: {
  items: Asset[];
  preparing: boolean;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <p className="shrink-0 text-sm font-medium tabular-nums" role="status">
        {t("picker.tray.selectedCount", { count: items.length })}
        {preparing && (
          <span className="font-normal text-muted-foreground">
            {t("picker.footer.waitingSuffix")}
          </span>
        )}
      </p>
      {items.length > 0 && (
        <>
          <ItemGroup
            aria-label={t("picker.tray.selectedContent")}
            className="min-w-0 flex-1 flex-row flex-nowrap gap-1.5 overflow-x-auto py-0.5"
          >
            {items.map((asset) => (
              <Item
                key={asset.id}
                role="listitem"
                variant="outline"
                size="xs"
                className="w-auto max-w-48 shrink-0 flex-nowrap gap-1 bg-background py-1 pr-1"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="block truncate text-xs">
                    {asset.name}
                  </ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("picker.tray.removeFromSelection", {
                      name: asset.name,
                    })}
                    onClick={() => onRemove(asset.id)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={onClear}
          >
            {t("picker.tray.clear")}
          </Button>
        </>
      )}
    </div>
  );
}
