import { useTranslation } from "react-i18next";
import type { FormField, FormFieldControl } from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button as RheaButton } from "../components/ui/button";
import { Checkbox as RheaCheckbox } from "../components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { validateKey } from "./formKeys";
import {
  CONTROLS,
  controlMeta,
  controlsWithOutputType,
  outputTypeFor,
} from "./formSchema";

export type FieldLock = {
  keyLocked: boolean;
  controlLocked: boolean;
  deleteLocked: boolean;
};

export function FormFieldEditor({
  field,
  allKeys,
  lock,
  readOnly,
  onChange,
}: {
  field: FormField;
  allKeys: string[];
  lock: FieldLock;
  readOnly: boolean;
  onChange: (next: FormField) => void;
}) {
  const { t } = useTranslation("forms");
  const meta = controlMeta(field.control);
  const disabled = readOnly;
  const keyError = validateKey(field.key, allKeys, field.key, t);

  const update = (patch: Partial<FormField>) =>
    onChange({ ...field, ...patch });

  // A published output field may only switch to controls with the same output type; a new field
  // may switch to any control.
  const controlOptions = lock.controlLocked
    ? controlsWithOutputType(outputTypeFor(field.control) ?? "")
    : CONTROLS.map((c) => c.control);

  const changeControl = (control: FormFieldControl) => {
    const nextMeta = controlMeta(control);
    const next: FormField = { ...field, control };
    if (!nextMeta.hasOptions) {
      delete next.options;
    } else if (!next.options || next.options.length === 0) {
      next.options = [
        {
          value: "option_1",
          label: t("fieldEditor.newOptionLabel", { index: 1 }),
        },
        {
          value: "option_2",
          label: t("fieldEditor.newOptionLabel", { index: 2 }),
        },
      ];
    }
    if (!nextMeta.numericBounds) {
      delete next.minimum;
      delete next.maximum;
    }
    if (!nextMeta.lengthBounds) {
      delete next.minLength;
      delete next.maxLength;
    }
    onChange(next);
  };

  return (
    <div className="grid gap-3">
      {(lock.keyLocked || lock.controlLocked) && (
        <Alert>
          <AlertTitle>{t("fieldEditor.publishedTitle")}</AlertTitle>
          <AlertDescription>
            {lock.controlLocked
              ? t("fieldEditor.publishedWithType")
              : t("fieldEditor.publishedBase")}
          </AlertDescription>
        </Alert>
      )}

      <Field>
        <FieldLabel htmlFor="form-field-label">
          {t("fieldEditor.label")}
        </FieldLabel>
        <Input
          id="form-field-label"
          required
          value={field.label}
          disabled={disabled}
          onChange={(event) => update({ label: event.target.value })}
        />
      </Field>

      {!meta.presentation && (
        <Field>
          <FieldLabel htmlFor="form-field-key">
            {t("fieldEditor.key")}
          </FieldLabel>
          <Input
            id="form-field-key"
            value={field.key}
            disabled={disabled || lock.keyLocked}
            onChange={(event) => update({ key: event.target.value })}
          />
          <FieldDescription>{t("fieldEditor.keyHint")}</FieldDescription>
          {keyError && <FieldError>{keyError}</FieldError>}
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="form-field-type">
          {t("fieldEditor.type")}
        </FieldLabel>
        <RheaSelect
          items={controlOptions.map((control) => ({
            value: control,
            label: t(controlMeta(control).labelKey),
          }))}
          value={field.control}
          disabled={
            disabled || (lock.controlLocked && controlOptions.length <= 1)
          }
          onValueChange={(value) => {
            if (value) changeControl(value);
          }}
        >
          <SelectTrigger
            id="form-field-type"
            aria-label={t("fieldEditor.type")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {controlOptions.map((control) => (
              <SelectItem key={control} value={control}>
                {t(controlMeta(control).labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </RheaSelect>
      </Field>

      <Field>
        <FieldLabel htmlFor="form-field-help">
          {t("fieldEditor.help")}
        </FieldLabel>
        <Textarea
          id="form-field-help"
          rows={2}
          value={field.description ?? ""}
          disabled={disabled}
          onChange={(event) => update({ description: event.target.value })}
        />
        <FieldDescription>{t("fieldEditor.helpHint")}</FieldDescription>
      </Field>

      {!meta.presentation && (
        /* Base UI names the span from the wrapping label. */
        <label className="flex items-center gap-2 text-sm">
          <RheaCheckbox
            checked={Boolean(field.required)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              update({ required: checked === true })
            }
          />
          <span>{t("fieldEditor.required")}</span>
        </label>
      )}

      {!meta.presentation && field.control !== "image" && (
        <Field>
          <FieldLabel htmlFor="form-field-default">
            {t("fieldEditor.defaultValue")}
          </FieldLabel>
          <Input
            id="form-field-default"
            value={field.default ?? ""}
            disabled={disabled}
            onChange={(event) => update({ default: event.target.value })}
          />
        </Field>
      )}

      {meta.hasOptions && (
        <OptionsEditor field={field} disabled={disabled} onChange={update} />
      )}

      {meta.numericBounds && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="form-field-minimum">
              {t("fieldEditor.minimum")}
            </FieldLabel>
            <Input
              id="form-field-minimum"
              type="number"
              value={field.minimum ?? ""}
              disabled={disabled}
              onChange={(event) =>
                update({
                  minimum:
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="form-field-maximum">
              {t("fieldEditor.maximum")}
            </FieldLabel>
            <Input
              id="form-field-maximum"
              type="number"
              value={field.maximum ?? ""}
              disabled={disabled}
              onChange={(event) =>
                update({
                  maximum:
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                })
              }
            />
          </Field>
        </div>
      )}

      {meta.lengthBounds && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="form-field-min-length">
              {t("fieldEditor.minLength")}
            </FieldLabel>
            <Input
              id="form-field-min-length"
              type="number"
              value={field.minLength ?? ""}
              disabled={disabled}
              onChange={(event) =>
                update({
                  minLength:
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="form-field-max-length">
              {t("fieldEditor.maxLength")}
            </FieldLabel>
            <Input
              id="form-field-max-length"
              type="number"
              value={field.maxLength ?? ""}
              disabled={disabled}
              onChange={(event) =>
                update({
                  maxLength:
                    event.target.value === ""
                      ? undefined
                      : Number(event.target.value),
                })
              }
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function OptionsEditor({
  field,
  disabled,
  onChange,
}: {
  field: FormField;
  disabled: boolean;
  onChange: (patch: Partial<FormField>) => void;
}) {
  const { t } = useTranslation("forms");
  const options = field.options ?? [];
  const setOptions = (next: typeof options) => onChange({ options: next });
  return (
    <fieldset className="grid gap-2 rounded-xl border border-border p-3">
      <legend className="text-sm font-medium">
        {t("fieldEditor.options")}
      </legend>
      {options.map((option, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={t("fieldEditor.optionLabel", { n: index + 1 })}
            value={option.label}
            disabled={disabled}
            onChange={(event) => {
              const next = [...options];
              next[index] = { ...option, label: event.target.value };
              setOptions(next);
            }}
          />
          <Input
            aria-label={t("fieldEditor.optionValue", { n: index + 1 })}
            value={option.value}
            disabled={disabled}
            onChange={(event) => {
              const next = [...options];
              next[index] = { ...option, value: event.target.value };
              setOptions(next);
            }}
          />
          <RheaButton
            variant="ghost"
            size="sm"
            disabled={disabled || options.length <= 1}
            onClick={() => setOptions(options.filter((_, i) => i !== index))}
          >
            {t("fieldEditor.remove")}
          </RheaButton>
        </div>
      ))}
      <RheaButton
        variant="secondary"
        size="sm"
        disabled={disabled}
        onClick={() => {
          // Derive a value that is unique against current options; options.length is not stable
          // across removals and could collide after a remove+add cycle.
          const existing = new Set(options.map((option) => option.value));
          let index = options.length + 1;
          while (existing.has(`option_${index}`)) {
            index += 1;
          }
          setOptions([
            ...options,
            {
              value: `option_${index}`,
              label: t("fieldEditor.newOptionLabel", { index }),
            },
          ]);
        }}
      >
        {t("fieldEditor.addOption")}
      </RheaButton>
    </fieldset>
  );
}
