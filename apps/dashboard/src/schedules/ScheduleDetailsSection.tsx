import { useTranslation } from "react-i18next";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { EditorSection } from "./scheduleEditorParts";
import {
  problemMessage,
  SCHEDULE_DESCRIPTION_MAX,
  SCHEDULE_NAME_MAX,
} from "./scheduleEditorModel";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

/** Identity and operational state: what the schedule is called and whether it can act. */
export function ScheduleDetailsSection({
  session,
}: {
  session: ScheduleEditorSession;
}) {
  const { t } = useTranslation("schedules");
  const { draft, update, errors, readOnly } = session;
  const nameProblem = errors.name ? problemMessage(errors.name, t) : null;
  return (
    <EditorSection id="schedule-details" title={t("editor.details.title")}>
      <Field data-invalid={nameProblem ? true : undefined}>
        <FieldLabel htmlFor="schedule-name">
          {t("editor.details.name")}
        </FieldLabel>
        <Input
          id="schedule-name"
          value={draft.name}
          maxLength={SCHEDULE_NAME_MAX}
          placeholder={t("editor.details.namePlaceholder")}
          required
          readOnly={readOnly}
          aria-invalid={nameProblem ? true : undefined}
          aria-describedby={nameProblem ? "schedule-name-error" : undefined}
          onChange={(event) => update({ name: event.target.value })}
        />
        {nameProblem && (
          <FieldError id="schedule-name-error">{nameProblem}</FieldError>
        )}
      </Field>
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="schedule-enabled">
            {t("editor.details.enabled")}
          </FieldLabel>
          <FieldDescription id="schedule-enabled-hint">
            {t("editor.details.enabledHint")}
          </FieldDescription>
        </FieldContent>
        <Switch
          id="schedule-enabled"
          checked={draft.enabled}
          disabled={readOnly}
          aria-label={t("editor.details.enabled")}
          aria-describedby="schedule-enabled-hint"
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="schedule-description">
          {t("editor.details.description")}
        </FieldLabel>
        <Textarea
          id="schedule-description"
          value={draft.description}
          maxLength={SCHEDULE_DESCRIPTION_MAX}
          rows={2}
          readOnly={readOnly}
          onChange={(event) => update({ description: event.target.value })}
        />
        <FieldDescription>
          {t("editor.details.descriptionHint")}
        </FieldDescription>
      </Field>
    </EditorSection>
  );
}
