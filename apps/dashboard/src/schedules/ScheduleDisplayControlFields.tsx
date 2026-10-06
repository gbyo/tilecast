import { useTranslation } from "react-i18next";
import type { DisplayControlAction } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { displayActionOptions } from "./scheduleBuilderModel";
import { DISPLAY_INPUT_MAX, problemMessage } from "./scheduleEditorModel";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

type ActionProps = {
  action: DisplayControlAction;
  onChange: (action: DisplayControlAction) => void;
  readOnly: boolean;
  problem: string | null;
};

/** The command to send, and only the value that command needs. */
export function ScheduleDisplayControlFields({
  session,
}: {
  session: ScheduleEditorSession;
}) {
  const { t } = useTranslation("schedules");
  const { draft, update, errors, readOnly } = session;
  const problem = errors.displayAction
    ? problemMessage(errors.displayAction, t)
    : null;
  const props: ActionProps = {
    action: draft.displayAction,
    onChange: (displayAction) => update({ displayAction }),
    readOnly,
    problem,
  };
  return (
    <div className="grid gap-4">
      <ActionSelect {...props} />
      {props.action.type === "display_set_input" && <InputValue {...props} />}
      {(props.action.type === "display_set_volume" ||
        props.action.type === "display_set_brightness") && (
        <LevelValue {...props} />
      )}
      {problem && (
        <FieldError id="schedule-display-error">{problem}</FieldError>
      )}
      <Alert>
        <AlertDescription>{t("displayAction.note")}</AlertDescription>
      </Alert>
    </div>
  );
}

function ActionSelect({ action, onChange, readOnly }: ActionProps) {
  const { t } = useTranslation("schedules");
  const options = displayActionOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  return (
    <Field>
      <FieldLabel htmlFor="schedule-display-action">
        {t("displayAction.actionLabel")}
      </FieldLabel>
      <Select
        items={options}
        value={action.type}
        disabled={readOnly}
        onValueChange={(next) => {
          if (next) onChange({ type: next });
        }}
      >
        <SelectTrigger id="schedule-display-action" className="w-full sm:w-64">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function InputValue({ action, onChange, readOnly, problem }: ActionProps) {
  const { t } = useTranslation("schedules");
  return (
    <Field data-invalid={problem ? true : undefined}>
      <FieldLabel htmlFor="schedule-display-value">
        {t("displayAction.inputLabel")}
      </FieldLabel>
      <Input
        id="schedule-display-value"
        value={action.input ?? ""}
        maxLength={DISPLAY_INPUT_MAX}
        required
        readOnly={readOnly}
        className="sm:w-64"
        aria-invalid={problem ? true : undefined}
        aria-describedby={
          problem ? "schedule-display-error" : "schedule-display-hint"
        }
        onChange={(event) => onChange({ ...action, input: event.target.value })}
      />
      <FieldDescription id="schedule-display-hint">
        {t("displayAction.inputHint")}
      </FieldDescription>
    </Field>
  );
}

function LevelValue({ action, onChange, readOnly, problem }: ActionProps) {
  const { t } = useTranslation("schedules");
  const volume = action.type === "display_set_volume";
  const level = volume ? action.volume : action.brightness;
  return (
    <Field data-invalid={problem ? true : undefined}>
      <FieldLabel htmlFor="schedule-display-value">
        {volume
          ? t("displayAction.volumeLabel")
          : t("displayAction.brightnessLabel")}
      </FieldLabel>
      <Input
        id="schedule-display-value"
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        step={1}
        value={level ?? ""}
        required
        readOnly={readOnly}
        className="sm:w-32"
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? "schedule-display-error" : undefined}
        onChange={(event) => {
          const value =
            event.target.value === "" ? undefined : Number(event.target.value);
          onChange(
            volume
              ? { type: "display_set_volume", volume: value }
              : { type: "display_set_brightness", brightness: value },
          );
        }}
      />
    </Field>
  );
}
