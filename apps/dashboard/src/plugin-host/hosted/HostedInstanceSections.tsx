import {
  groupAuthoringFields,
  visibleAuthoringFields,
  type ConfigField,
} from "@tilecast/config-schema";
import { Controller, type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { FormField } from "@/components/FormField";
import { WidgetInspectorField } from "@/components/content/widget-editor/fields/WidgetInspectorField";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { TargetFields, useTargetSource } from "../../plugins/shared";
import { HostedSecretField } from "./HostedSecretField";
import {
  scheduleFields,
  type HostedDocument,
  type HostedFormState,
  type HostedKind,
} from "./model";

type SectionProps = {
  form: UseFormReturn<HostedFormState>;
  readOnly: boolean;
};

type InspectorProps = SectionProps & {
  csrf: string;
  problemFor: (path: string) => string | undefined;
};

const dirty = { shouldDirty: true };

export function HostedInstanceGeneral({
  kind,
  form,
  readOnly,
  nameError,
}: SectionProps & { kind: HostedKind; nameError?: string }) {
  const { t } = useTranslation("plugins");
  return (
    <section className="grid gap-4" aria-labelledby="hosted-general">
      <h2 id="hosted-general" className="text-base font-semibold">
        {t("hosted.general")}
      </h2>
      <FormField
        id="hosted-name"
        label={t("hosted.name")}
        maxLength={180}
        disabled={readOnly}
        error={nameError}
        {...form.register("name")}
      />
      <Controller
        control={form.control}
        name="enabled"
        render={({ field }) => (
          <Field orientation="horizontal">
            <div className="grid gap-1">
              <FieldLabel htmlFor="hosted-enabled">
                {t("hosted.enabled")}
              </FieldLabel>
              <FieldDescription>{t("hosted.enabledHint")}</FieldDescription>
            </div>
            <Switch
              id="hosted-enabled"
              checked={field.value}
              disabled={readOnly}
              onCheckedChange={(checked) => field.onChange(checked === true)}
            />
          </Field>
        )}
      />
      {kind.priority && (
        <FormField
          id="hosted-priority"
          label={t("hosted.priority")}
          hint={t("hosted.priorityHint", {
            min: kind.priority.minimum,
            max: kind.priority.maximum,
          })}
          type="number"
          min={kind.priority.minimum}
          max={kind.priority.maximum}
          disabled={readOnly}
          {...form.register("priority", { valueAsNumber: true })}
        />
      )}
    </section>
  );
}

export function HostedInstanceConfig({
  fields,
  form,
  state,
  secretStates,
  readOnly,
  csrf,
  problemFor,
}: InspectorProps & {
  fields: ConfigField[];
  state: HostedFormState;
  secretStates?: HostedDocument["secrets"];
}) {
  const { t } = useTranslation("content");
  const sections = groupAuthoringFields(
    visibleAuthoringFields(fields, state.config),
  );
  const clearedSecrets = new Set(state.clearSecrets);
  return (
    <>
      {sections.map((group) => (
        <section
          key={group.section}
          className="grid gap-4"
          aria-labelledby={`hosted-section-${group.section}`}
        >
          <h2
            id={`hosted-section-${group.section}`}
            className="text-base font-semibold"
          >
            {t(`widgets.editor.sections.${group.section}`)}
          </h2>
          {group.fields.map((field) =>
            field.control === "secret" ? (
              <HostedSecretField
                key={field.key}
                field={field}
                label={field.label}
                description={field.description}
                state={secretStates?.[field.key] ?? "not_set"}
                value={state.secrets[field.key] ?? ""}
                cleared={clearedSecrets.has(field.key)}
                readOnly={readOnly}
                error={problemFor(field.key)}
                onValue={(value) =>
                  form.setValue(
                    "secrets",
                    { ...state.secrets, [field.key]: value },
                    dirty,
                  )
                }
                onClear={(cleared) => {
                  if (cleared) clearedSecrets.add(field.key);
                  else clearedSecrets.delete(field.key);
                  form.setValue(
                    "clearSecrets",
                    Array.from(clearedSecrets),
                    dirty,
                  );
                }}
              />
            ) : (
              <HostedInspectorField
                key={field.key}
                field={field}
                fields={fields}
                values={state.config}
                readOnly={readOnly}
                csrf={csrf}
                errorFor={problemFor}
                onChange={(next) => form.setValue("config", next, dirty)}
              />
            ),
          )}
        </section>
      ))}
    </>
  );
}

export function HostedInstanceSchedule({
  kind,
  form,
  values,
  readOnly,
  csrf,
  problemFor,
}: InspectorProps & { kind: HostedKind; values: HostedFormState["schedule"] }) {
  const { t } = useTranslation("plugins");
  if (kind.schedule === "none") return null;
  const labels = {
    startsAt: t("hosted.schedule.startsAt"),
    endsAt: t("hosted.schedule.endsAt"),
    timezone: t("hosted.schedule.timezone"),
    days: t("hosted.schedule.days"),
    startTime: t("hosted.schedule.startTime"),
    endTime: t("hosted.schedule.endTime"),
  };
  const fields = scheduleFields(kind, (key) => labels[key]);
  return (
    <section className="grid gap-4" aria-labelledby="hosted-schedule">
      <h2 id="hosted-schedule" className="text-base font-semibold">
        {t("hosted.scheduleHeading")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t(
          kind.schedule === "window"
            ? "hosted.windowHint"
            : "hosted.weeklyHint",
        )}
      </p>
      {fields.map((field) => (
        <HostedInspectorField
          key={field.key}
          field={field}
          fields={fields}
          values={values as Record<string, unknown>}
          readOnly={readOnly}
          csrf={csrf}
          errorFor={(path) => problemFor(`schedule.${path}`)}
          onChange={(next) => form.setValue("schedule", next, dirty)}
        />
      ))}
    </section>
  );
}

function HostedInspectorField({
  field,
  fields,
  values,
  readOnly,
  csrf,
  errorFor,
  onChange,
}: {
  field: ConfigField;
  fields: ConfigField[];
  values: Record<string, unknown>;
  readOnly: boolean;
  csrf: string;
  errorFor: (path: string) => string | undefined;
  onChange: (values: Record<string, unknown>) => void;
}) {
  return (
    <WidgetInspectorField
      field={field}
      path={field.key}
      value={values[field.key]}
      values={values}
      fields={fields}
      rootValues={values}
      rootFields={fields}
      onChange={(next) => onChange({ ...values, [field.key]: next })}
      readOnly={readOnly}
      csrf={csrf}
      errorFor={errorFor}
      focusPath={null}
      focusNonce={0}
    />
  );
}

export function HostedInstanceTargets({
  form,
  scope,
  readOnly,
  error,
}: SectionProps & { scope: HostedFormState["targetScope"]; error?: string }) {
  const { t } = useTranslation("plugins");
  const source = useTargetSource(scope);
  return (
    <section className="grid gap-4" aria-labelledby="hosted-targets">
      <h2 id="hosted-targets" className="text-base font-semibold">
        {t("hosted.targets")}
      </h2>
      <fieldset className="contents" disabled={readOnly}>
        <TargetFields
          idPrefix="hosted"
          scope={scope}
          source={source}
          error={error}
          control={form.control}
          onScopeChange={(next) => {
            form.setValue("targetScope", next, dirty);
            form.setValue("targetIds", [], dirty);
          }}
        />
      </fieldset>
    </section>
  );
}
