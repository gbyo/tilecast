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
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button as RheaButton } from "../components/ui/button";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
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
    <div className="grid gap-4">
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "error"
                ? "Save failed"
                : saveState === "dirty"
                  ? "Unsaved changes"
                  : "Saved"}
          </span>
          <div className="flex flex-wrap gap-2">
            <RheaButton
              variant="secondary"
              disabled={!dirty || saveDraft.isPending}
              aria-busy={saveDraft.isPending || undefined}
              onClick={() => saveDraft.mutate()}
            >
              {saveDraft.isPending && <Spinner aria-hidden="true" />}
              Save draft
            </RheaButton>
            <RheaButton
              variant="default"
              disabled={
                publish.isPending ||
                saveDraft.isPending ||
                !hasPublishableChanges
              }
              onClick={() => setShowPublish(true)}
            >
              Publish
            </RheaButton>
          </div>
        </div>
      )}

      {blocker.state === "blocked" && (
        <Alert>
          <AlertTitle>Leave without saving?</AlertTitle>
          <AlertDescription>
            You have unsaved changes to this form. Leaving now will discard
            them.
          </AlertDescription>
          <div className="flex flex-wrap gap-2">
            <RheaButton variant="ghost" onClick={() => blocker.reset?.()}>
              Stay on page
            </RheaButton>
            <RheaButton variant="default" onClick={() => blocker.proceed?.()}>
              Leave without saving
            </RheaButton>
          </div>
        </Alert>
      )}

      {saveError && (
        <Alert variant="destructive">
          <AlertTitle>Draft not saved</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {showPublish && (
        <Alert>
          <AlertTitle>Publish a new revision?</AlertTitle>
          <AlertDescription>
            Publishing creates a new immutable revision. Existing submissions
            stay tied to the revision they were created against.
            {publishError && (
              <span className="font-medium text-destructive">
                {" "}
                {publishError}
              </span>
            )}
          </AlertDescription>
          <div className="flex flex-wrap gap-2">
            <RheaButton
              variant="ghost"
              onClick={() => setShowPublish(false)}
              disabled={publish.isPending}
            >
              Cancel
            </RheaButton>
            <RheaButton
              variant="default"
              disabled={publish.isPending}
              aria-busy={publish.isPending || undefined}
              onClick={() => publish.mutate()}
            >
              {publish.isPending && <Spinner aria-hidden="true" />}
              Publish revision
            </RheaButton>
          </div>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,17rem)]">
        <section className="grid content-start gap-3" aria-label="Form fields">
          <ol className="grid gap-2">
            {draft.fields.map((field, index) => (
              <li key={index}>
                <div
                  className={`rounded-xl border px-3 py-2 ${index === selected ? "border-primary" : "border-border"}`}
                >
                  <button
                    type="button"
                    className="flex w-full flex-col gap-0.5 text-left"
                    onClick={() => setSelected(index)}
                    aria-current={index === selected}
                  >
                    <strong className="text-sm">
                      {field.label || field.key}
                    </strong>
                    <span className="text-xs text-muted-foreground">
                      {field.control}
                    </span>
                  </button>
                  {!readOnly && (
                    <div className="mt-1 flex gap-1">
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                        aria-label={`Move ${field.label || field.key} up`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                        aria-label={`Move ${field.label || field.key} down`}
                        disabled={index === draft.fields.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
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

        <section className="grid content-start gap-3" aria-label="Form preview">
          {!readOnly && (
            <div className="grid gap-3">
              <Field>
                <FieldLabel htmlFor="form-builder-title">Form title</FieldLabel>
                <Input
                  id="form-builder-title"
                  value={draft.title ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="form-builder-description">
                  Form description
                </FieldLabel>
                <Textarea
                  id="form-builder-description"
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
            className="grid content-start gap-3 rounded-xl border border-border p-4"
            aria-label="Field settings"
          >
            <h3 className="text-base font-semibold">Field settings</h3>
            {selectedField ? (
              <FormFieldEditor
                field={selectedField}
                allKeys={keys}
                lock={lockFor(selectedField)}
                readOnly={readOnly}
                onChange={(next) => mutateField(selected, next)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                Select a field to edit its settings.
              </p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
