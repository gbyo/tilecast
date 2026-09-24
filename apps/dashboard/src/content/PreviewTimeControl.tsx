import { useId } from "react";
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
  const fixed = value.mode === "fixed";
  const inputId = useId();
  return (
    <div className="grid gap-2" role="group" aria-label="Preview time">
      <ToggleGroup
        aria-label="Preview time mode"
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
        <ToggleGroupItem value="live">Live</ToggleGroupItem>
        <ToggleGroupItem value="fixed">At a time</ToggleGroupItem>
      </ToggleGroup>
      {fixed && (
        <div className="flex flex-wrap items-end gap-2">
          <Field className="min-w-0 flex-[1_1_12rem] gap-1">
            <FieldLabel htmlFor={inputId} className="text-xs">
              Preview date and time
            </FieldLabel>
            <DateTimeInput
              id={inputId}
              aria-label="Preview date and time"
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
            Reset to now
          </Button>
        </div>
      )}
      <FieldDescription className="text-xs">
        {fixed
          ? "Clocks, dates, countdowns, and schedule selections render at this time, read in your own time zone. A thumbnail saved now captures this preview."
          : "The preview follows the current time."}
      </FieldDescription>
    </div>
  );
}
