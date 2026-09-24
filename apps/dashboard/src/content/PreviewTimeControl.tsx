import { useId } from "react";
import { useTranslation } from "react-i18next";
import { previewTimeInputValue, type PreviewTime } from "./previewTime";
import { Button } from "../components/ui/button";
import { DateTimeInput } from "../components/date-picker";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
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
  const { t } = useTranslation(["content", "common", "schedules"]);
  const fixed = value.mode === "fixed";
  const inputId = useId();
  return (
    <div
      className="grid gap-2"
      role="group"
      aria-label={t("widgets.preview.time.groupLabel")}
    >
      <ToggleGroup
        aria-label={t("widgets.preview.time.modeLabel")}
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
        <ToggleGroupItem value="live">
          {t("widgets.preview.time.live")}
        </ToggleGroupItem>
        <ToggleGroupItem value="fixed">
          {t("widgets.preview.time.atTime")}
        </ToggleGroupItem>
      </ToggleGroup>
      {fixed && (
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-0 flex-[1_1_12rem] gap-1">
            <FieldLabel htmlFor={inputId} className="text-xs">
              {t("widgets.preview.time.dateTimeLabel")}
            </FieldLabel>
            <DateTimeInput
              id={inputId}
              aria-label={t("widgets.preview.time.dateTimeLabel")}
              timeLabel={t("datePicker.previewTime", { ns: "schedules" })}
              value={value.value}
              onChange={(next) => onChange({ mode: "fixed", value: next })}
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
            {t("widgets.preview.time.resetNow")}
          </Button>
        </div>
      )}
      <FieldDescription className="text-xs">
        {fixed
          ? t("widgets.preview.time.fixedHint")
          : t("widgets.preview.time.liveHint")}
      </FieldDescription>
    </div>
  );
}
