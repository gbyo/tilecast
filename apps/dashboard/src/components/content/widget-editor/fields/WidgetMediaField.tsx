/**
 * A selected media asset as a compact resource row. Changing it opens the
 * searchable, paginated Media picker, so any eligible asset is reachable
 * however large the library is; the selection resolves by ID for display.
 */
import { useQuery } from "@tanstack/react-query";
import { ImageIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { Asset } from "@/api/types";
import { ContentPicker } from "@/components/content-picker";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { InspectorFieldFrame } from "./InspectorFieldFrame";
import {
  fieldDomId,
  fieldText,
  type InspectorFieldProps,
} from "./fieldContext";

const pickerTypes = ["image", "video", "widget"] as const;
type PickerType = (typeof pickerTypes)[number];

export function WidgetMediaField({
  field,
  path,
  value,
  onChange,
  readOnly,
  csrf,
  errorFor,
}: InspectorFieldProps) {
  const { t } = useTranslation(["content", "common"]);
  const error = errorFor(path);
  const id = fieldDomId(path);
  const assetId = fieldText(value);
  const [picking, setPicking] = useState(false);
  const current = useQuery({
    queryKey: ["asset", assetId],
    queryFn: () => api.asset(assetId),
    enabled: Boolean(assetId),
  });
  const allowedTypes = field.mediaTypes?.length
    ? field.mediaTypes.filter((type): type is PickerType =>
        (pickerTypes as readonly string[]).includes(type),
      )
    : undefined;
  const name =
    current.data?.name ??
    (current.isError ? t("widgets.editor.media.unavailable") : undefined);
  const describedBy =
    [field.description ? `${id}-description` : "", error ? `${id}-error` : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <InspectorFieldFrame path={path} field={field} error={error}>
      <Item variant={assetId ? "outline" : "muted"} size="sm">
        <ItemMedia variant={current.data ? "image" : "icon"}>
          {current.data && current.data.type === "image" ? (
            <img src={api.assetPreviewUrl(current.data.id)} alt="" />
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
          {current.data && (
            <ItemDescription>
              {t(`widgets.editor.media.types.${current.data.type}`)}
            </ItemDescription>
          )}
        </ItemContent>
        {!readOnly && (
          <ItemActions>
            <Button
              id={id}
              type="button"
              variant="outline"
              size="sm"
              aria-label={
                assetId
                  ? t("widgets.editor.media.changeLabel", {
                      label: field.label,
                    })
                  : t("widgets.editor.media.chooseLabel", {
                      label: field.label,
                    })
              }
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              onClick={() => setPicking(true)}
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
                aria-label={t("widgets.editor.media.removeLabel", {
                  label: field.label,
                })}
                // Absent, not "", so optional media leaves the
                // configuration the same way it was before one was chosen.
                onClick={() => onChange(undefined)}
              >
                {t("common:actions.remove")}
              </Button>
            )}
          </ItemActions>
        )}
      </Item>
      <ContentPicker
        open={picking}
        mode="single"
        csrf={csrf}
        allowedTypes={allowedTypes}
        selectedIds={assetId ? [assetId] : []}
        title={t("widgets.editor.media.pickerTitle", { label: field.label })}
        description={t("widgets.editor.media.pickerDescription")}
        confirmLabel={t("widgets.editor.media.pickerConfirm")}
        onConfirm={(items: Asset[]) => {
          onChange(items[0]?.id);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </InspectorFieldFrame>
  );
}
