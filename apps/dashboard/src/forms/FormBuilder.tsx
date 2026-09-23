import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  FormDataSource,
  FormField,
  FormFieldControl,
  FormSchema,
} from "../api/types";
import { api, ApiError } from "../api/client";
import {
  Button,
  Field,
  Input,
  Notice,
  Textarea,
} from "../components/legacy-ui";
import { FormFieldEditor, type FieldLock } from "./FormFieldEditor";
import { FormFieldPalette } from "./FormFieldPalette";
import { FormRenderer } from "./FormRenderer";
import { newField, publishedOutputKeys, schemasEquivalent } from "./formSchema";
import { RESERVED_FIELD_KEYS } from "./formKeys";

type SaveState = "saved" | "dirty" | "saving" | "error";

function cloneSchema(schema: FormSchema): FormSchema {
  return JSON.parse(JSON.stringify(schema)) as FormSchema;
}

export function FormBuilder({
  form,
  csrf,
  readOnly = false,
}: {
  form: FormDataSource;
  csrf: string;
  readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FormSchema>(() =>
    cloneSchema(form.draftSchema),
  );
  const [baseline, setBaseline] = useState<string>(() =>
    JSON.stringify(form.draftSchema),
  );
  const [selected, setSelected] = useState(0);
  const [saveError, setSaveError] = useState("");
  const [showPublish, setShowPublish] = useState(false);
  const [publishError, setPublishError] = useState("");

  const dirty = JSON.stringify(draft) !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const publishedKeys = useMemo(() => publishedOutputKeys(form), [form]);

  // Publishing is only meaningful when the current draft differs from the published revision.
  // A draft that matches the published schema is never publishable, even if it differs from the
  // last saved draft (e.g. the user edited and then reverted back to the published content).
  const publishedSchema = form.publishedRevision?.schema;
  const hasPublishableChanges =
    !publishedSchema || !schemasEquivalent(draft, publishedSchema);

  // Block in-app navigation while there are unsaved schema changes so edits are not lost. Any
  // change to the path, query string, or hash counts as leaving the current view.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  );

  // Warn on browser refresh/close while there are unsaved schema changes.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const saveDraft = useMutation({
    mutationFn: () => api.updateFormDraft(form.id, draft, csrf),
    onMutate: () => setSaveError(""),
    onSuccess: (updated) => {
      setBaseline(JSON.stringify(updated.draftSchema));
      setDraft(cloneSchema(updated.draftSchema));
      void queryClient.invalidateQueries({
        queryKey: ["form-data-source", form.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["data-source", form.id],
      });
    },
    onError: (error) =>
      setSaveError(
        error instanceof Error ? error.message : "Could not save the draft.",
      ),
  });

  const publish = useMutation({
    mutationFn: async () => {
      // Snapshot the schema being sent so baseline tracking reflects what was actually persisted,
      // not any edits the user makes while the request is in flight.
      const schema = draft;
      const snapshot = JSON.stringify(schema);
      if (dirtyRef.current) {
        await api.updateFormDraft(form.id, schema, csrf);
        // The draft is now saved server-side; mark it saved even if publishing then fails.
        setBaseline(snapshot);
      }
      await api.publishForm(form.id, csrf);
      return { snapshot };
    },
    onMutate: () => setPublishError(""),
    onSuccess: ({ snapshot }) => {
      setBaseline(snapshot);
      setShowPublish(false);
      void queryClient.invalidateQueries({
        queryKey: ["form-data-source", form.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["data-source", form.id],
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setPublishError("The form changed elsewhere. Reload and try again.");
      } else {
        setPublishError(
          error instanceof Error ? error.message : "Could not publish.",
        );
      }
    },
  });

  const saveState: SaveState = saveDraft.isPending
    ? "saving"
    : saveError
      ? "error"
      : dirty
        ? "dirty"
        : "saved";

  const keys = draft.fields.map((field) => field.key);
  const selectedField = draft.fields[selected];

  const mutateField = (index: number, next: FormField) => {
    setDraft((current) => {
      const fields = [...current.fields];
      fields[index] = next;
      return { ...current, fields };
    });
  };

  // Selection is updated outside the setDraft updater so the updater stays pure (React StrictMode
  // may invoke it more than once).
  const addField = (control: FormFieldControl) => {
    const field = newField(control, [
      ...draft.fields.map((f) => f.key),
      ...RESERVED_FIELD_KEYS,
    ]);
    setDraft((current) => ({ ...current, fields: [...current.fields, field] }));
    setSelected(draft.fields.length);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.fields.length) return;
    setDraft((current) => {
      const fields = [...current.fields];
      const moving = fields[index];
      const displaced = fields[target];
      if (!moving || !displaced) return current;
      fields[index] = displaced;
      fields[target] = moving;
      return { ...current, fields };
    });
    setSelected(target);
  };

  const removeField = (index: number) => {
    setDraft((current) => ({
      ...current,
      fields: current.fields.filter((_, i) => i !== index),
    }));
    setSelected((prev) => Math.max(0, Math.min(prev, draft.fields.length - 2)));
  };

  const lockFor = (field: FormField): FieldLock => {
    const published = publishedKeys.has(field.key);
    return {
      keyLocked: published,
      controlLocked: published,
      deleteLocked: published,
    };
  };

  return (
    <div className="form-builder">
      {!readOnly && (
        <div className="form-builder__statusbar">
          <span
            className={`form-builder__status form-builder__status--${saveState}`}
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "error"
                ? "Save failed"
                : saveState === "dirty"
                  ? "Unsaved changes"
                  : "Saved"}
          </span>
          <div className="form-builder__status-actions">
            <Button
              variant="secondary"
              disabled={!dirty || saveDraft.isPending}
              loading={saveDraft.isPending}
              onClick={() => saveDraft.mutate()}
            >
              Save draft
            </Button>
            <Button
              variant="primary"
              disabled={
                publish.isPending ||
                saveDraft.isPending ||
                !hasPublishableChanges
              }
              onClick={() => setShowPublish(true)}
            >
              Publish
            </Button>
          </div>
        </div>
      )}

      {blocker.state === "blocked" && (
        <Notice
          variant="warning"
          title="Leave without saving?"
          action={
            <div className="form-builder__confirm-actions">
              <Button variant="quiet" onClick={() => blocker.reset?.()}>
                Stay on page
              </Button>
              <Button variant="primary" onClick={() => blocker.proceed?.()}>
                Leave without saving
              </Button>
            </div>
          }
        >
          You have unsaved changes to this form. Leaving now will discard them.
        </Notice>
      )}

      {saveError && (
        <Notice variant="danger" title="Draft not saved">
          {saveError}
        </Notice>
      )}

      {showPublish && (
        <Notice
          variant="warning"
          title="Publish a new revision?"
          action={
            <div className="form-builder__confirm-actions">
              <Button
                variant="quiet"
                onClick={() => setShowPublish(false)}
                disabled={publish.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={publish.isPending}
                onClick={() => publish.mutate()}
              >
                Publish revision
              </Button>
            </div>
          }
        >
          Publishing creates a new immutable revision. Existing submissions stay
          tied to the revision they were created against.
          {publishError && (
            <span className="form-builder__confirm-error"> {publishError}</span>
          )}
        </Notice>
      )}

      <div className="form-builder__layout">
        <section className="form-builder__list" aria-label="Form fields">
          <ol className="form-builder__field-list">
            {draft.fields.map((field, index) => (
              <li key={index}>
                <div
                  className={`form-builder__field-item${index === selected ? " is-selected" : ""}`}
                >
                  <button
                    type="button"
                    className="form-builder__field-select"
                    onClick={() => setSelected(index)}
                    aria-current={index === selected}
                  >
                    <strong>{field.label || field.key}</strong>
                    <span>{field.control}</span>
                  </button>
                  {!readOnly && (
                    <div className="form-builder__field-controls">
                      <button
                        type="button"
                        aria-label={`Move ${field.label || field.key} up`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${field.label || field.key} down`}
                        disabled={index === draft.fields.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${field.label || field.key}`}
                        disabled={lockFor(field).deleteLocked}
                        onClick={() => removeField(index)}
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {!readOnly && <FormFieldPalette onAdd={addField} />}
        </section>

        <section className="form-builder__preview" aria-label="Form preview">
          {!readOnly && (
            <div className="form-builder__schema-meta">
              <Field label="Form title">
                <Input
                  value={draft.title ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field label="Form description">
                <Textarea
                  rows={2}
                  value={draft.description ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                />
              </Field>
            </div>
          )}
          <FormRenderer schema={draft} readOnly />
        </section>

        {!readOnly && (
          <aside
            className="form-builder__inspector"
            aria-label="Field settings"
          >
            <h3 className="form-builder__inspector-title">Field settings</h3>
            {selectedField ? (
              <FormFieldEditor
                field={selectedField}
                allKeys={keys}
                lock={lockFor(selectedField)}
                readOnly={readOnly}
                onChange={(next) => mutateField(selected, next)}
              />
            ) : (
              <p className="form-builder__inspector-empty">
                Select a field to edit its settings.
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
