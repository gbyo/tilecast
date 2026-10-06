/**
 * A selected media asset as a compact resource row. Changing it opens the
 * searchable, paginated Media picker, so any eligible asset is reachable
 * however large the library is; the selection resolves by ID for display.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { Asset } from "@/api/types";
import { ContentPicker } from "@/components/content-picker";
import { InspectorFieldFrame } from "./InspectorFieldFrame";
import { MediaSelection } from "./MediaSelection";
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
      <MediaSelection
        assetId={assetId}
        asset={current.data}
        name={name}
        label={field.label}
        buttonId={id}
        describedBy={describedBy}
        invalid={Boolean(error)}
        readOnly={readOnly}
        onChoose={() => setPicking(true)}
        // Absent, not "", so optional media leaves the configuration the
        // way it was before one was chosen.
        onRemove={() => onChange(undefined)}
      />
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
