import type { FormField, FormFieldControl } from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
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
  const meta = controlMeta(field.control);
  const disabled = readOnly;
  const keyError = validateKey(field.key, allKeys, field.key);

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
        { value: "option_1", label: "Option 1" },
        { value: "option_2", label: "Option 2" },
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
          <AlertTitle>Published field</AlertTitle>
          <AlertDescription>
            This field is part of the published form, so its key
            {lock.controlLocked ? " and output type" : ""} are locked to keep
            Widgets and saved views working. You can still edit its label, help
            text, validation, and order.
          </AlertDescription>
        </Alert>
      )}

      <Field>
        <FieldLabel htmlFor="form-field-label">Label</FieldLabel>
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
          <FieldLabel htmlFor="form-field-key">Field key</FieldLabel>
          <Input
            id="form-field-key"
            value={field.key}
            disabled={disabled || lock.keyLocked}
            onChange={(event) => update({ key: event.target.value })}
          />
          <FieldDescription>
            Stable identifier used by Widgets and views.
          </FieldDescription>
          {keyError && <FieldError>{keyError}</FieldError>}
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="form-field-type">Field type</FieldLabel>
        <Select
          items={controlOptions.map((control) => ({
            value: control,
            label: controlMeta(control).label,
          }))}
          value={field.control}
          disabled={
            disabled || (lock.controlLocked && controlOptions.length <= 1)
          }
          onValueChange={(value) => {
            if (value) changeControl(value);
          }}
        >
          <SelectTrigger id="form-field-type" aria-label="Field type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {controlOptions.map((control) => (
              <SelectItem key={control} value={control}>
                {controlMeta(control).label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <FieldLabel htmlFor="form-field-help">Help text</FieldLabel>
        <Textarea
          id="form-field-help"
          rows={2}
          value={field.description ?? ""}
          disabled={disabled}
          onChange={(event) => update({ description: event.target.value })}
        />
        <FieldDescription>Shown under the field.</FieldDescription>
      </Field>

      {!meta.presentation && (
        <Field orientation="horizontal" className="items-center">
          <Checkbox
            id="form-field-required"
            checked={Boolean(field.required)}
            disabled={disabled}
            onCheckedChange={(checked) =>
              update({ required: checked === true })
            }
          />
          <FieldLabel htmlFor="form-field-required" className="font-normal">
            Required
          </FieldLabel>
        </Field>
      )}

      {!meta.presentation && field.control !== "image" && (
        <Field>
          <FieldLabel htmlFor="form-field-default">Default value</FieldLabel>
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
            <FieldLabel htmlFor="form-field-minimum">Minimum</FieldLabel>
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
            <FieldLabel htmlFor="form-field-maximum">Maximum</FieldLabel>
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
              Minimum length
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
              Maximum length
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
  const options = field.options ?? [];
  const setOptions = (next: typeof options) => onChange({ options: next });
  return (
    <fieldset className="grid gap-2 rounded-xl border border-border p-3">
      <legend className="text-sm font-medium">Options</legend>
      {options.map((option, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Option ${index + 1} label`}
            value={option.label}
            disabled={disabled}
            onChange={(event) => {
              const next = [...options];
              next[index] = { ...option, label: event.target.value };
              setOptions(next);
            }}
          />
          <Input
            aria-label={`Option ${index + 1} value`}
            value={option.value}
            disabled={disabled}
            onChange={(event) => {
              const next = [...options];
              next[index] = { ...option, value: event.target.value };
              setOptions(next);
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || options.length <= 1}
            onClick={() => setOptions(options.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
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
            { value: `option_${index}`, label: `Option ${index}` },
          ]);
        }}
      >
        Add option
      </Button>
    </fieldset>
  );
}
