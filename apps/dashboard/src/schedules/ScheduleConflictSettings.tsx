import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { RadioGroup } from "../components/ui/radio-group";
import {
  priorityLabel,
  priorityPreset,
  priorityPresetValues,
  type PriorityPreset,
} from "./scheduleBuilderModel";
import { problemMessage } from "./scheduleEditorModel";
import { ChoiceCard } from "./scheduleEditorParts";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

/**
 * How this schedule behaves when another one wants the same screen. Most
 * schedules keep normal priority, so this stays folded until it is not normal;
 * it never opens by itself while someone is typing.
 */
export function ScheduleConflictSettings({
  session,
  open,
  onOpenChange,
}: {
  session: ScheduleEditorSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("schedules");
  const { draft, update, errors, readOnly, preflight } = session;
  const problem = errors.priority ? problemMessage(errors.priority, t) : null;
  const preset = priorityPreset(draft.priority);
  // Custom is a choice, not a value: typing 100 into it must not jump to the
  // Important preset and take the field away.
  const [customChosen, setCustomChosen] = useState(preset === "custom");
  const choice: PriorityPreset =
    customChosen || preset === "custom" ? "custom" : preset;
  const overlaps =
    preflight.status !== "incomplete" && preflight.result
      ? preflight.result.competitors.length
      : 0;
  return (
    <section aria-labelledby="schedule-conflict-heading">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <h2 id="schedule-conflict-heading" className="text-base font-semibold">
          <CollapsibleTrigger className="group/conflict flex w-full items-center justify-between gap-3 rounded-md py-1 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <span className="grid gap-0.5">
              <span>{t("conflict.title")}</span>
              <span className="text-sm font-normal text-muted-foreground">
                {priorityLabel(draft.priority, t)}
                {Number.isFinite(draft.priority) && ` · ${draft.priority}`}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {overlaps > 0 && !open && (
                <Badge variant="secondary">
                  {t("conflict.overlapBadge", { count: overlaps })}
                </Badge>
              )}
              <ChevronRight
                aria-hidden="true"
                className="size-4 text-muted-foreground transition-transform in-data-panel-open:rotate-90"
              />
            </span>
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent>
          <div className="grid gap-4 pt-3">
            <p className="text-sm text-muted-foreground">
              {t("conflict.hint")}
            </p>
            <RadioGroup
              aria-label={t("conflict.groupLabel")}
              value={choice}
              disabled={readOnly}
              onValueChange={(next) => {
                const value = next as PriorityPreset;
                setCustomChosen(value === "custom");
                if (value !== "custom")
                  update({ priority: priorityPresetValues[value] });
              }}
            >
              {(["normal", "important", "special"] as const).map((value) => (
                <ChoiceCard
                  key={value}
                  id={`schedule-priority-${value}`}
                  value={value}
                  title={`${t(`priority.presets.${value}`)} · ${priorityPresetValues[value]}`}
                  description={t(`conflict.presets.${value}`)}
                  disabled={readOnly}
                />
              ))}
              <ChoiceCard
                id="schedule-priority-custom"
                value="custom"
                title={t("priority.presets.custom")}
                description={t("conflict.presets.custom")}
                disabled={readOnly}
              />
            </RadioGroup>
            {choice === "custom" && (
              <CustomPriority
                value={draft.priority}
                readOnly={readOnly}
                problem={problem}
                onChange={(priority) => update({ priority })}
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function CustomPriority({
  value,
  readOnly,
  problem,
  onChange,
}: {
  value: number;
  readOnly: boolean;
  problem: string | null;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation("schedules");
  // The field keeps what was typed, including a half-typed "-", and tells the
  // draft only when that is a number (or NaN, which fails validation).
  const [text, setText] = useState(Number.isNaN(value) ? "" : String(value));
  useEffect(() => {
    // Follow outside changes, such as discarding edits.
    if (!Number.isNaN(value))
      setText((current) =>
        Number(current) === value ? current : String(value),
      );
  }, [value]);
  return (
    <Field data-invalid={problem ? true : undefined}>
      <FieldContent>
        <FieldLabel htmlFor="schedule-custom-priority">
          {t("conflict.customLabel")}
        </FieldLabel>
        <FieldDescription id="schedule-custom-priority-hint">
          {t("conflict.customHint")}
        </FieldDescription>
      </FieldContent>
      <Input
        id="schedule-custom-priority"
        type="number"
        inputMode="numeric"
        min={-999}
        max={999}
        step={1}
        value={text}
        readOnly={readOnly}
        required
        className="w-32"
        aria-invalid={problem ? true : undefined}
        aria-describedby={
          problem
            ? "schedule-custom-priority-error"
            : "schedule-custom-priority-hint"
        }
        onChange={(event) => {
          setText(event.target.value);
          onChange(
            event.target.value.trim() === "" ? NaN : Number(event.target.value),
          );
        }}
      />
      {problem && (
        <FieldError id="schedule-custom-priority-error">{problem}</FieldError>
      )}
    </Field>
  );
}
