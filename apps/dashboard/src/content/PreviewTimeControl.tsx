import { previewTimeInputValue, type PreviewTime } from "./previewTime";
import { Button } from "../components/ui/button";

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
  return (
    <div className="preview-time" aria-label="Preview time">
      <div className="preview-time__modes" role="group">
        <button
          type="button"
          className={`preview-time__mode${fixed ? "" : " preview-time__mode--active"}`}
          aria-pressed={!fixed}
          onClick={() => onChange({ ...value, mode: "live" })}
        >
          Live
        </button>
        <button
          type="button"
          className={`preview-time__mode${fixed ? " preview-time__mode--active" : ""}`}
          aria-pressed={fixed}
          onClick={() =>
            onChange({
              mode: "fixed",
              value: value.value || previewTimeInputValue(new Date()),
            })
          }
        >
          At a time
        </button>
      </div>
      {fixed && (
        <div className="preview-time__picker">
          <label className="preview-time__field">
            <span className="text-xs font-medium">Preview date and time</span>
            <input
              type="datetime-local"
              value={value.value}
              onChange={(event) =>
                onChange({ mode: "fixed", value: event.target.value })
              }
            />
          </label>
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
      <small>
        {fixed
          ? "Clocks, dates, countdowns, and schedule selections render at this time, read in your own time zone. A thumbnail saved now captures this preview."
          : "The preview follows the current time."}
      </small>
    </div>
  );
}
