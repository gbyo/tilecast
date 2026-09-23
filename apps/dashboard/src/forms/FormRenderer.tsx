import { useId } from "react";
import { Image as ImageIcon } from "lucide-react";
import type { FormField, FormSchema } from "../api/types";
import { Button } from "../components/ui/button";
import { DateInput, DateTimeInput } from "../components/date-picker";
import { Checkbox as RheaCheckbox } from "../components/ui/checkbox";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "../components/ui/attachment";
import {
  Field as RheaField,
  FieldDescription as RheaFieldDescription,
  FieldError as RheaFieldError,
  FieldLegend as RheaFieldLegend,
  FieldLabel as RheaFieldLabel,
  FieldSet as RheaFieldSet,
  FieldTitle as RheaFieldTitle,
} from "../components/ui/field";
import { Input as RheaInput } from "../components/ui/input";
import {
  RadioGroup as RheaRadioGroup,
  RadioGroupItem as RheaRadioGroupItem,
} from "../components/ui/radio-group";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea as RheaTextarea } from "../components/ui/textarea";
import { isPresentationControl } from "./formSchema";

// A single-select with this many options or fewer renders as a radio group so
// every choice stays visible; longer lists collapse into a dropdown Select.
// The stored value is a single option string either way.
const RADIO_OPTION_LIMIT = 3;

// FormValues maps a field key to its current value. Multi-select uses string[]; others use string
// or boolean. The renderer is deliberately the single place that interprets controls so builder
// preview, submission, and review pages render identically.
export type FormValues = Record<
  string,
  string | string[] | boolean | undefined
>;

// ImageFieldState describes the current image for one image field: a committed server attachment
// (contentUrl + attachmentId), a locally-selected file not yet uploaded (pendingUrl + pendingName),
// an in-flight upload, or an error. Absent means the field has no image.
export type ImageFieldState = {
  attachmentId?: string;
  contentUrl?: string;
  pendingName?: string;
  pendingUrl?: string;
  uploading?: boolean;
  error?: string;
};

// ImageHandlers wires the renderer's image fields to the owning editor, which performs the actual
// uploads/removals against a record. When provided, image fields become interactive; without it the
// renderer shows a passive placeholder (builder preview) or the committed image (read-only review).
export type ImageHandlers = {
  state: (fieldKey: string) => ImageFieldState | undefined;
  onSelect: (fieldKey: string, file: File) => void;
  onRemove: (fieldKey: string) => void;
};

// fieldControlId derives the DOM id of one field's focusable control from the renderer's id prefix.
// An owning editor passes an explicit idPrefix and uses this to move focus to a specific field (for
// example the first invalid one) without reaching into renderer internals.
export function fieldControlId(prefix: string, fieldKey: string): string {
  return `${prefix}-${fieldKey}`;
}

export type FormRendererProps = {
  schema: FormSchema;
  values?: FormValues;
  readOnly?: boolean;
  onChange?: (key: string, value: string | string[] | boolean) => void;
  errors?: Record<string, string>;
  imageHandlers?: ImageHandlers;
  // idPrefix makes control ids predictable for the owning editor. Omitted (builder preview, review)
  // the renderer generates its own so multiple renderers on a page still get unique ids.
  idPrefix?: string;
};

export function FormRenderer({
  schema,
  values = {},
  readOnly = false,
  onChange,
  errors = {},
  imageHandlers,
  idPrefix,
}: FormRendererProps) {
  const generated = useId();
  const scope = idPrefix ?? generated;
  return (
    <div className="form-renderer">
      {(schema.title || schema.description) && (
        <header className="form-renderer__header">
          {schema.title && (
            <h2 className="form-renderer__title">{schema.title}</h2>
          )}
          {schema.description && (
            <p className="form-renderer__description">{schema.description}</p>
          )}
        </header>
      )}
      <div className="form-renderer__fields">
        {schema.fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            scope={scope}
            value={values[field.key]}
            readOnly={readOnly}
            onChange={onChange}
            error={errors[field.key]}
            imageHandlers={imageHandlers}
          />
        ))}
        {schema.fields.length === 0 && (
          <p className="form-renderer__empty">This form has no fields yet.</p>
        )}
      </div>
    </div>
  );
}

// RequiredMark renders the visual asterisk only. The required state is conveyed to assistive
// technology by the control's own required/aria-required attribute, so the mark stays hidden to
// avoid reading "star" after every label.
function RequiredMark({ required }: { required?: boolean }) {
  if (!required) return null;
  return (
    <span className="form-renderer__required" aria-hidden="true">
      {" *"}
    </span>
  );
}

function FieldRow({
  field,
  scope,
  value,
  readOnly,
  onChange,
  error,
  imageHandlers,
}: {
  field: FormField;
  scope: string;
  value: string | string[] | boolean | undefined;
  readOnly: boolean;
  onChange?: (key: string, value: string | string[] | boolean) => void;
  error?: string;
  imageHandlers?: ImageHandlers;
}) {
  const controlId = fieldControlId(scope, field.key);
  const hintId = field.description ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const disabled = readOnly || !onChange;
  const counted = countsCharacters(field) && !disabled;
  const counterId = counted ? `${controlId}-counter` : undefined;
  // Every piece of supporting text is announced with the control: the hint, the remaining-character
  // budget, and — critically — the validation error, which is otherwise invisible to a screen reader.
  const describedBy =
    [hintId, counterId, errorId].filter(Boolean).join(" ") || undefined;

  if (field.control === "section") {
    return <h3 className="form-renderer__section">{field.label}</h3>;
  }
  if (field.control === "help_text") {
    return (
      <p className="form-renderer__help">{field.description || field.label}</p>
    );
  }

  const hint = hintId ? (
    <RheaFieldDescription id={hintId} className="form-renderer__hint">
      {field.description}
    </RheaFieldDescription>
  ) : null;

  const support = (
    <>
      {counterId && (
        <CharacterCount
          id={counterId}
          value={typeof value === "string" ? value : ""}
          maxLength={field.maxLength ?? 0}
        />
      )}
      {errorId && (
        <RheaFieldError id={errorId} className="form-renderer__error">
          {error}
        </RheaFieldError>
      )}
    </>
  );

  // A checkbox reads as "label, checkbox" only when the box sits next to its own text, so boolean
  // fields use an inline label instead of the stacked label-above-control layout.
  // Boolean is a Checkbox, not a Switch: it is a form input with label
  // semantics (consent-style on/off answers), while Switch is reserved for
  // settings that take effect immediately, like the editor inspectors.
  if (field.control === "boolean") {
    return (
      <div className="form-renderer__field form-renderer__field--inline">
        <RheaField orientation="horizontal">
          <RheaCheckbox
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            aria-required={field.required ? true : undefined}
            disabled={disabled}
            checked={value === true || value === "true"}
            onCheckedChange={(checked) =>
              onChange?.(field.key, checked === true)
            }
          />
          <RheaFieldLabel htmlFor={controlId}>
            {field.label}
            <RequiredMark required={field.required} />
          </RheaFieldLabel>
        </RheaField>
        {hint}
        {support}
      </div>
    );
  }

  // A multi-select is a set of checkboxes, not a single control: a <label for> pointing at the
  // wrapper would name nothing. fieldset/legend is the native grouping that assistive technology
  // announces when focus enters any option.
  if (field.control === "multi_select") {
    return (
      <RheaFieldSet
        id={controlId}
        tabIndex={-1}
        className="form-renderer__field form-renderer__group gap-3"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-required={field.required ? true : undefined}
      >
        <RheaFieldLegend variant="label" className="mb-0 form-renderer__label">
          {field.label}
          <RequiredMark required={field.required} />
        </RheaFieldLegend>
        {hint}
        <div className="form-renderer__multi">
          {(field.options ?? []).map((option) => {
            const selected =
              Array.isArray(value) && value.includes(option.value);
            const optionId = `${controlId}-${option.value}`;
            return (
              <RheaField key={option.value} orientation="horizontal">
                <RheaCheckbox
                  id={optionId}
                  disabled={disabled}
                  checked={selected}
                  onCheckedChange={(checked) => {
                    const current = Array.isArray(value) ? [...value] : [];
                    if (checked === true) {
                      current.push(option.value);
                    } else {
                      const index = current.indexOf(option.value);
                      if (index >= 0) current.splice(index, 1);
                    }
                    onChange?.(field.key, current);
                  }}
                />
                <RheaFieldLabel htmlFor={optionId} className="font-normal">
                  {option.label}
                </RheaFieldLabel>
              </RheaField>
            );
          })}
        </div>
        {support}
      </RheaFieldSet>
    );
  }

  // A short option list renders as radios (no single control id to point a
  // label at), so the group carries its own accessible name and the visible
  // title is presentation. Longer lists use the dropdown Select below, which
  // the row label points at normally.
  const options = field.control === "select" ? (field.options ?? []) : [];
  if (field.control === "select" && options.length <= RADIO_OPTION_LIMIT) {
    return (
      <RheaField className="form-renderer__field">
        <RheaFieldTitle>
          <span className="form-renderer__label">
            {field.label}
            <RequiredMark required={field.required} />
          </span>
        </RheaFieldTitle>
        {hint}
        <RheaRadioGroup
          aria-label={field.label}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          aria-required={field.required ? true : undefined}
          required={field.required}
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          onValueChange={(next) => {
            if (typeof next === "string" && next) onChange?.(field.key, next);
          }}
        >
          <div className="form-renderer__multi">
            {options.map((option) => {
              const radioId = `${controlId}-${option.value}`;
              return (
                <RheaField key={option.value} orientation="horizontal">
                  <RheaRadioGroupItem
                    value={option.value}
                    id={radioId}
                    disabled={disabled}
                  />
                  <RheaFieldLabel htmlFor={radioId} className="font-normal">
                    {option.label}
                  </RheaFieldLabel>
                </RheaField>
              );
            })}
          </div>
        </RheaRadioGroup>
        {support}
      </RheaField>
    );
  }

  return (
    <RheaField className="form-renderer__field">
      <RheaFieldLabel htmlFor={controlId}>
        <span className="form-renderer__label">
          {field.label}
          <RequiredMark required={field.required} />
        </span>
      </RheaFieldLabel>
      {hint}
      <FieldControl
        field={field}
        id={controlId}
        describedBy={describedBy}
        invalid={Boolean(error)}
        value={value}
        readOnly={readOnly}
        onChange={onChange}
        imageHandlers={imageHandlers}
      />
      {support}
    </RheaField>
  );
}

// countsCharacters reports whether a field should show a remaining-character budget. The control
// also hard-caps input at maxLength, so without this the cap is silent: typing simply stops.
function countsCharacters(field: FormField): boolean {
  if (field.control !== "short_text" && field.control !== "long_text")
    return false;
  return Boolean(field.maxLength);
}

function CharacterCount({
  id,
  value,
  maxLength,
}: {
  id: string;
  value: string;
  maxLength: number;
}) {
  // Count code points, matching the length check in validateSubmission.
  const used = [...value].length;
  const remaining = maxLength - used;
  return (
    <span
      id={id}
      className={`form-renderer__counter${remaining <= 0 ? " is-full" : ""}`}
    >
      {remaining <= 0
        ? `Character limit reached (${maxLength})`
        : `${remaining} of ${maxLength} characters left`}
    </span>
  );
}

function FieldControl({
  field,
  id,
  describedBy,
  invalid,
  value,
  readOnly,
  onChange,
  imageHandlers,
}: {
  field: FormField;
  id: string;
  describedBy?: string;
  invalid?: boolean;
  value: string | string[] | boolean | undefined;
  readOnly: boolean;
  onChange?: (key: string, next: string | string[] | boolean) => void;
  imageHandlers?: ImageHandlers;
}) {
  const disabled = readOnly || !onChange;
  const emit = (next: string | string[] | boolean) =>
    onChange?.(field.key, next);
  const stringValue = typeof value === "string" ? value : "";
  const required = Boolean(field.required);
  // Shared wiring for every single-control field so no control can silently drop its error state.
  const common = {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": invalid ? (true as const) : undefined,
    required,
    disabled,
  };

  switch (field.control) {
    case "long_text":
      return (
        <RheaTextarea
          {...common}
          rows={3}
          value={stringValue}
          maxLength={field.maxLength || undefined}
          onChange={(event) => emit(event.target.value)}
        />
      );
    case "select":
      return (
        <RheaSelect
          items={field.options ?? []}
          value={stringValue}
          onValueChange={(next) => {
            if (typeof next === "string") emit(next);
          }}
          required={required}
          disabled={disabled}
        >
          <SelectTrigger
            id={id}
            aria-describedby={describedBy}
            aria-invalid={invalid ? true : undefined}
          >
            <SelectValue placeholder="Select…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </RheaSelect>
      );
    case "image":
      if (imageHandlers) {
        return (
          <ImageField
            id={id}
            describedBy={describedBy}
            invalid={invalid}
            fieldKey={field.key}
            label={field.label}
            disabled={disabled}
            state={imageHandlers.state(field.key)}
            onSelect={imageHandlers.onSelect}
            onRemove={imageHandlers.onRemove}
          />
        );
      }
      return (
        <div className="form-renderer__image">
          <RheaInput
            id={id}
            type="file"
            accept="image/*"
            aria-describedby={describedBy}
            disabled
          />
          <span className="form-renderer__image-note">
            Image uploads are available when submitting.
          </span>
        </div>
      );
    case "number":
    case "integer":
      return (
        <RheaInput
          {...common}
          type="number"
          inputMode={field.control === "integer" ? "numeric" : "decimal"}
          step={field.control === "integer" ? 1 : "any"}
          min={field.minimum}
          max={field.maximum}
          value={stringValue}
          onChange={(event) => emit(event.target.value)}
        />
      );
    case "date":
      return <DateInput {...common} value={stringValue} onChange={emit} />;
    case "datetime":
      return (
        <DateTimeInput
          {...common}
          aria-label={field.label}
          timeLabel={field.label + " time"}
          value={stringValue}
          onChange={emit}
        />
      );
    case "url":
      return (
        <RheaInput
          {...common}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={stringValue}
          onChange={(event) => emit(event.target.value)}
        />
      );
    default:
      return (
        <RheaInput
          {...common}
          type="text"
          maxLength={field.maxLength || undefined}
          value={stringValue}
          onChange={(event) => emit(event.target.value)}
        />
      );
  }
}

// ImageField renders an interactive image control for submission and review: a preview of the
// committed or pending image with Remove/Replace, or a file picker when empty. Uploads themselves
// are performed by the owning editor through the supplied handlers.
function ImageField({
  id,
  describedBy,
  invalid,
  fieldKey,
  label,
  disabled,
  state,
  onSelect,
  onRemove,
}: {
  id: string;
  describedBy?: string;
  invalid?: boolean;
  fieldKey: string;
  label: string;
  disabled: boolean;
  state?: ImageFieldState;
  onSelect: (fieldKey: string, file: File) => void;
  onRemove: (fieldKey: string) => void;
}) {
  const previewUrl = state?.pendingUrl ?? state?.contentUrl;
  const hasImage = Boolean(previewUrl);
  const attachmentState = state?.error
    ? "error"
    : state?.uploading
      ? "uploading"
      : state?.pendingName
        ? "processing"
        : hasImage
          ? "done"
          : "idle";
  return (
    <div className="form-renderer__image grid justify-items-start gap-2">
      <Attachment state={attachmentState} className="w-full">
        <AttachmentMedia variant={hasImage ? "image" : "icon"}>
          {previewUrl ? (
            <img src={previewUrl} alt="" />
          ) : (
            <ImageIcon aria-hidden="true" />
          )}
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{state?.pendingName ?? label}</AttachmentTitle>
          <AttachmentDescription>
            {state?.error
              ? "Image needs attention."
              : state?.uploading
                ? "Uploading…"
                : state?.pendingName
                  ? "Uploads when you save."
                  : hasImage
                    ? "Image attached."
                    : "No image provided."}
          </AttachmentDescription>
        </AttachmentContent>
        {!disabled && (
          <AttachmentActions>
            {hasImage && (
              <AttachmentAction
                type="button"
                size="sm"
                disabled={state?.uploading}
                onClick={() => onRemove(fieldKey)}
              >
                Remove
              </AttachmentAction>
            )}
            <Button
              variant="secondary"
              size="sm"
              render={<label />}
              disabled={state?.uploading}
            >
              {hasImage ? "Replace" : "Choose"}
              <input
                id={id}
                type="file"
                accept="image/*"
                aria-describedby={describedBy}
                aria-invalid={invalid ? true : undefined}
                aria-label={hasImage ? "Replace " + label : "Choose " + label}
                className="visually-hidden"
                disabled={state?.uploading}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) onSelect(fieldKey, file);
                  event.target.value = "";
                }}
              />
            </Button>
          </AttachmentActions>
        )}
      </Attachment>
      {state?.error && (
        <span className="form-renderer__error" role="alert">
          {state.error}
        </span>
      )}
    </div>
  );
}

export { isPresentationControl };
