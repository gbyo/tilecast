import type { FormField, FormFieldControl } from "../api/types";
import {
  Button,
  Checkbox,
  Field,
  Input,
  Notice,
  Select,
  Textarea,
} from "../components/legacy-ui";
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
    <div className="form-builder__inspector-body">
      {(lock.keyLocked || lock.controlLocked) && (
        <Notice variant="info" title="Published field">
          This field is part of the published form, so its key
          {lock.controlLocked ? " and output type" : ""} are locked to keep
          Widgets and saved views working. You can still edit its label, help
          text, validation, and order.
        </Notice>
      )}

      <Field label="Label" required>
        <Input
          value={field.label}
          disabled={disabled}
          onChange={(event) => update({ label: event.target.value })}
        />
      </Field>

      {!meta.presentation && (
        <Field
          label="Field key"
          description="Stable identifier used by Widgets and views."
          error={keyError ?? undefined}
        >
          <Input
            value={field.key}
            disabled={disabled || lock.keyLocked}
            onChange={(event) => update({ key: event.target.value })}
          />
        </Field>
      )}

      <Field label="Field type">
        <Select
          value={field.control}
          disabled={
            disabled || (lock.controlLocked && controlOptions.length <= 1)
          }
          onChange={(event) =>
            changeControl(event.target.value as FormFieldControl)
          }
        >
          {controlOptions.map((control) => (
            <option key={control} value={control}>
              {controlMeta(control).label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Help text" description="Shown under the field.">
        <Textarea
          rows={2}
          value={field.description ?? ""}
          disabled={disabled}
          onChange={(event) => update({ description: event.target.value })}
        />
      </Field>

      {!meta.presentation && (
        <Checkbox
          label="Required"
          checked={Boolean(field.required)}
          disabled={disabled}
          onChange={(event) => update({ required: event.target.checked })}
        />
      )}

      {!meta.presentation && field.control !== "image" && (
        <Field label="Default value">
          <Input
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
        <div className="form-builder__bounds">
          <Field label="Minimum">
            <Input
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
          <Field label="Maximum">
            <Input
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
        <div className="form-builder__bounds">
          <Field label="Minimum length">
            <Input
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
          <Field label="Maximum length">
            <Input
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
    <fieldset className="form-builder__options">
      <legend>Options</legend>
      {options.map((option, index) => (
        <div key={index} className="form-builder__option-row">
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
            variant="quiet"
            compact
            disabled={disabled || options.length <= 1}
            onClick={() => setOptions(options.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        compact
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
