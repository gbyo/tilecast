import { useId } from "react";
import { useTranslation } from "react-i18next";
import { previewTimeInputValue, type PreviewTime } from "./previewTime";
import { Button } from "../components/ui/button";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";

/**
 * Sits under the Widget editor's "Live preview" heading and chooses the instant the preview renders
 * at: the live clock, or a date and time the author picks.
 */
export function PreviewTimeControl({
  value,
  onChange,
}: {
  value: PreviewTime;
  onChange: (time: PreviewTime) => void;
}) {
  const fixed = value.mode === "fixed";
  const inputId = useId();
  const { t } = useTranslation("content");
  return (
    <div
      className="grid gap-2"
      role="group"
      aria-label={t("preview.time.groupLabel")}
    >
      <ToggleGroup
        aria-label={t("preview.time.modeLabel")}
        variant="outline"
        size="sm"
        className="justify-self-start"
        multiple={false}
        value={[value.mode]}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "live") onChange({ ...value, mode: "live" });
          if (mode === "fixed")
            onChange({
              mode: "fixed",
              value: value.value || previewTimeInputValue(new Date()),
            });
        }}
      >
        <ToggleGroupItem value="live">{t("preview.time.live")}</ToggleGroupItem>
        <ToggleGroupItem value="fixed">
          {t("preview.time.fixed")}
        </ToggleGroupItem>
      </ToggleGroup>
      {fixed && (
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-0 flex-[1_1_12rem] gap-1">
            <FieldLabel htmlFor={inputId} className="text-xs">
              {t("preview.time.dateLabel")}
            </FieldLabel>
            <Input
              id={inputId}
              type="datetime-local"
              value={value.value}
              onChange={(event) =>
                onChange({ mode: "fixed", value: event.target.value })
              }
            />
          </Field>
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              onChange({
                mode: "fixed",
                value: previewTimeInputValue(new Date()),
              })
            }
          >
            {t("preview.time.reset")}
          </Button>
        </div>
      )}
      <FieldDescription className="text-xs">
        {fixed ? t("preview.time.fixedHint") : t("preview.time.liveHint")}
      </FieldDescription>
    </div>
  );
}
