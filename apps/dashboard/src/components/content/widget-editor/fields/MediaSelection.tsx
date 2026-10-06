/**
 * The selected media asset as a compact resource row: what it is, and the
 * controls to change or remove it. The field owns the choice and the picker.
 */
import { ImageIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { Asset } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";

export function MediaSelection({
  assetId,
  asset,
  name,
  label,
  buttonId,
  describedBy,
  invalid,
  readOnly,
  onChoose,
  onRemove,
}: {
  assetId: string;
  asset: Asset | undefined;
  /** What to call the asset: its name, or why that is unknown. */
  name: string | undefined;
  label: string;
  buttonId: string;
  describedBy: string | undefined;
  invalid: boolean;
  readOnly: boolean;
  onChoose: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation(["content", "common"]);
  return (
    <Item variant={assetId ? "outline" : "muted"} size="sm">
      <ItemMedia variant={asset ? "image" : "icon"}>
        {asset && asset.type === "image" ? (
          <img src={api.assetPreviewUrl(asset.id)} alt="" />
        ) : (
          <ImageIcon aria-hidden="true" />
        )}
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="truncate">
          {assetId
            ? (name ?? t("widgets.editor.media.loading"))
            : t("widgets.editor.media.none")}
        </ItemTitle>
        {asset && (
          <ItemDescription>
            {t(`widgets.editor.media.types.${asset.type}`)}
          </ItemDescription>
        )}
      </ItemContent>
      {!readOnly && (
        <ItemActions>
          <Button
            id={buttonId}
            type="button"
            variant="outline"
            size="sm"
            aria-label={
              assetId
                ? t("widgets.editor.media.changeLabel", { label })
                : t("widgets.editor.media.chooseLabel", { label })
            }
            aria-describedby={describedBy}
            aria-invalid={invalid ? true : undefined}
            onClick={onChoose}
          >
            {assetId
              ? t("widgets.editor.media.change")
              : t("widgets.editor.media.choose")}
          </Button>
          {assetId && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t("widgets.editor.media.removeLabel", { label })}
              onClick={onRemove}
            >
              {t("common:actions.remove")}
            </Button>
          )}
        </ItemActions>
      )}
    </Item>
  );
}
