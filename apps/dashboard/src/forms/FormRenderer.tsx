import { useId } from "react";
import type { FormField, FormSchema } from "../api/types";
import { Button } from "../components/ui/button";
import { isPresentationControl } from "./formSchema";

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
    <span id={hintId} className="form-renderer__hint">
      {field.description}
    </span>
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
        <span id={errorId} className="form-renderer__error">
          {error}
        </span>
      )}
    </>
  );

  // A checkbox reads as "label, checkbox" only when the box sits next to its own text, so boolean
  // fields use an inline label instead of the stacked label-above-control layout.
  if (field.control === "boolean") {
    return (
      <div className="form-renderer__field form-renderer__field--inline">
        <label className="checkbox-control" htmlFor={controlId}>
          <input
            id={controlId}
            type="checkbox"
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            aria-required={field.required ? true : undefined}
            disabled={disabled}
            checked={value === true || value === "true"}
            onChange={(event) => onChange?.(field.key, event.target.checked)}
          />
          <span className="form-renderer__label">
            {field.label}
            <RequiredMark required={field.required} />
          </span>
        </label>
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
      <fieldset
        id={controlId}
        tabIndex={-1}
        className="form-renderer__field form-renderer__group"
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-required={field.required ? true : undefined}
      >
        <legend className="form-renderer__label">
          {field.label}
          <RequiredMark required={field.required} />
        </legend>
        {hint}
        <div className="form-renderer__multi">
          {(field.options ?? []).map((option) => {
            const selected =
              Array.isArray(value) && value.includes(option.value);
            return (
              <label key={option.value} className="checkbox-control">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={selected}
                  onChange={(event) => {
                    const current = Array.isArray(value) ? [...value] : [];
                    if (event.target.checked) {
                      current.push(option.value);
                    } else {
                      const index = current.indexOf(option.value);
                      if (index >= 0) current.splice(index, 1);
                    }
                    onChange?.(field.key, current);
                  }}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
        {support}
      </fieldset>
    );
  }

  return (
    <div className="form-renderer__field">
      <label htmlFor={controlId}>
        <span className="form-renderer__label">
          {field.label}
          <RequiredMark required={field.required} />
        </span>
      </label>
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
    </div>
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
    className: "input",
    required,
    disabled,
  };

  switch (field.control) {
    case "long_text":
      return (
        <textarea
          {...common}
          rows={3}
          value={stringValue}
          maxLength={field.maxLength || undefined}
          onChange={(event) => emit(event.target.value)}
        />
      );
    case "select":
      return (
        <select
          {...common}
          value={stringValue}
          onChange={(event) => emit(event.target.value)}
        >
          <option value="">Select…</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
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
          <input
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
        <input
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
      return (
        <input
          {...common}
          type="date"
          value={stringValue}
          onChange={(event) => emit(event.target.value)}
        />
      );
    case "datetime":
      return (
        <input
          {...common}
          type="datetime-local"
          value={stringValue}
          onChange={(event) => emit(event.target.value)}
        />
      );
    case "url":
      return (
        <input
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
        <input
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
  return (
    <div className="form-renderer__image">
      {hasImage && (
        <img
          className="form-renderer__image-preview"
          src={previewUrl}
          alt={`${label} attachment`}
        />
      )}
      {state?.pendingName && !state.uploading && (
        <span className="form-renderer__image-note">
          {state.pendingName} — uploads when you save.
        </span>
      )}
      {state?.uploading && (
        <span className="form-renderer__image-note">Uploading…</span>
      )}
      {state?.error && (
        <span className="form-renderer__error" role="alert">
          {state.error}
        </span>
      )}
      {!disabled && (
        <div className="form-renderer__image-actions">
          <Button variant="secondary" size="sm" render={<label />}>
            {hasImage ? "Replace image" : "Choose image"}
            <input
              id={id}
              type="file"
              accept="image/*"
              aria-describedby={describedBy}
              aria-invalid={invalid ? true : undefined}
              aria-label={hasImage ? `Replace ${label}` : `Choose ${label}`}
              className="visually-hidden"
              disabled={state?.uploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onSelect(fieldKey, file);
                event.target.value = "";
              }}
            />
          </Button>
          {hasImage && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={state?.uploading}
              onClick={() => onRemove(fieldKey)}
            >
              Remove
            </Button>
          )}
        </div>
      )}
      {!hasImage && disabled && (
        <span className="form-renderer__image-note">No image provided.</span>
      )}
    </div>
  );
}

export { isPresentationControl };
