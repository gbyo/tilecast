import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import type {
  FormAvailableTransition,
  FormDataSource,
  FormRecordComment,
  FormRecordDetail,
  FormRecordEvent,
  FormSchema,
} from "../api/types";
import { api, ApiError } from "../api/client";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button as RheaButton } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import {
  FormRenderer,
  fieldControlId,
  type FormValues,
  type ImageFieldState,
} from "./FormRenderer";
import {
  applyDefaults,
  coerceScalar,
  fieldError,
  formValuesToPayload,
  recordValuesToForm,
  validateSubmission,
} from "./formValues";
import { hasCapability } from "./capabilities";
import { stateLabel } from "./formStatus";

// Control ids are predictable so a failed validation can move focus straight to the offending field.
const FIELD_ID_PREFIX = "submission-field";

// SubmissionEditor is the submitter-facing editable form for one submission. It handles a brand-new
// submission (no record yet) and editing an existing draft or changes-requested record, including
// image upload/preview/replacement/removal, client-side validation, schema defaults, save draft,
// submit/resubmit via the server-provided transition, optimistic-concurrency versions, and
// unsaved-navigation protection. Editing uses the record's immutable revision schema, and — for an
// existing record — its server-provided canEdit and availableTransitions rather than any workflow
// reasoning in React.
export function SubmissionEditor({
  form,
  initialDetail,
  csrf,
  onCompleted,
}: {
  form: FormDataSource;
  initialDetail?: FormRecordDetail;
  csrf: string;
  onCompleted: (recordId: string) => void;
}) {
  const queryClient = useQueryClient();

  // Editing uses the record's immutable revision; a new submission uses the current published one.
  const schema: FormSchema = useMemo(() => {
    if (initialDetail?.revision) return initialDetail.revision.schema;
    return form.publishedRevision?.schema ?? { fields: [] };
  }, [initialDetail, form.publishedRevision]);

  const [recordId, setRecordId] = useState<string | null>(
    initialDetail?.id ?? null,
  );
  const [version, setVersion] = useState<number>(initialDetail?.version ?? 0);
  const [state, setState] = useState<string>(initialDetail?.state ?? "draft");
  // For a new submission the submitter is always the editor; for an existing record the server
  // decides via canEdit. availableTransitions is likewise server-provided for existing records.
  const [canEdit, setCanEdit] = useState<boolean>(
    initialDetail?.canEdit ?? true,
  );
  const [availableTransitions, setAvailableTransitions] = useState<
    FormAvailableTransition[]
  >(initialDetail?.availableTransitions ?? []);
  const [events, setEvents] = useState<FormRecordEvent[]>(
    initialDetail?.events ?? [],
  );
  const [comments, setComments] = useState<FormRecordComment[]>(
    initialDetail?.comments ?? [],
  );
  const [values, setValues] = useState<FormValues>(() =>
    initialDetail
      ? recordValuesToForm(schema, initialDetail.values)
      : applyDefaults(schema),
  );
  const [baseline, setBaseline] = useState(() => JSON.stringify(values));
  const [images, setImages] = useState<Record<string, ImageFieldState>>(() =>
    imagesFromDetail(form.id, initialDetail),
  );
  const pendingFiles = useRef<Record<string, File>>({});
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState<"" | "draft" | "submit">("");

  const dirty = JSON.stringify(values) !== baseline || pendingKeys.length > 0;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // A completed submit navigates away on purpose. The dirty flag is derived during render, so a
  // navigation issued in the same tick as the final resync still sees the pre-save value and the
  // unsaved-changes guard would trap the submitter on a form they just successfully sent. This ref is
  // set immediately before the intentional departure and is visible to the predicate at once.
  const completing = useRef(false);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !completing.current &&
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );

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

  const canSubmitCapability = hasCapability(form.grantedCapabilities, "submit");
  const submitTransition = availableTransitions.find(
    (transition) => transition.requiredCapability === "submit",
  );
  // Submit is offered for a new record when the caller holds submit; for an existing record only
  // when the server lists a submit transition for the record's current state.
  const canSubmit =
    recordId === null ? canSubmitCapability : Boolean(submitTransition);
  const submitLabel = submitTransition?.label ?? "Submit";

  const editable = canEdit;

  // Reviewer feedback is the note attached to the transition that moved the record into its current
  // state (the "request changes" decision) — not the final comment or a hardcoded state key.
  const feedback = useMemo(() => {
    let latest: FormRecordEvent | undefined;
    for (const event of events) {
      if (
        event.eventType === "transition" &&
        event.toState === state &&
        event.note &&
        event.note.trim() !== ""
      ) {
        latest = event;
      }
    }
    return latest;
  }, [events, state]);

  function satisfiedImages(): Set<string> {
    const set = new Set<string>();
    for (const field of schema.fields) {
      if (field.control !== "image") continue;
      const image = images[field.key];
      if (
        image?.attachmentId ||
        image?.contentUrl ||
        pendingFiles.current[field.key]
      ) {
        set.add(field.key);
      }
    }
    return set;
  }

  function setPending(fieldKey: string, file: File | null) {
    if (file) pendingFiles.current[fieldKey] = file;
    else delete pendingFiles.current[fieldKey];
    setPendingKeys(Object.keys(pendingFiles.current));
  }

  // absorbImageDetail refreshes record metadata and image state after an attachment mutation while
  // preserving the submitter's unsaved text edits (only image-field values are re-read from server).
  function absorbImageDetail(detail: FormRecordDetail) {
    setRecordId(detail.id);
    setVersion(detail.version);
    setState(detail.state);
    setCanEdit(detail.canEdit);
    setAvailableTransitions(detail.availableTransitions);
    setEvents(detail.events);
    setComments(detail.comments);
    setImages(imagesFromDetail(form.id, detail));
    setValues((current) => {
      const next = { ...current };
      for (const field of schema.fields) {
        if (field.control === "image") {
          next[field.key] = coerceScalar(detail.values[field.key]);
        }
      }
      return next;
    });
  }

  // absorbSavedDetail fully resyncs from the server after a save/submit and resets the dirty
  // baseline to the returned record so the editor reflects exactly what was persisted.
  function absorbSavedDetail(detail: FormRecordDetail) {
    const nextValues = recordValuesToForm(schema, detail.values);
    setRecordId(detail.id);
    setVersion(detail.version);
    setState(detail.state);
    setCanEdit(detail.canEdit);
    setAvailableTransitions(detail.availableTransitions);
    setEvents(detail.events);
    setComments(detail.comments);
    setImages(imagesFromDetail(form.id, detail));
    setValues(nextValues);
    setBaseline(JSON.stringify(nextValues));
  }

  function invalidate(currentRecordId: string | null) {
    if (currentRecordId) {
      void queryClient.invalidateQueries({
        queryKey: ["form-record", form.id, currentRecordId],
      });
    }
    void queryClient.invalidateQueries({ queryKey: ["form-records", form.id] });
    void queryClient.invalidateQueries({ queryKey: ["forms"] });
  }

  async function handleImageSelect(fieldKey: string, file: File) {
    const objectUrl = URL.createObjectURL(file);
    setPending(fieldKey, file);
    setImages((current) => ({
      ...current,
      [fieldKey]: {
        pendingUrl: objectUrl,
        pendingName: file.name,
        uploading: recordId !== null,
      },
    }));
    if (recordId === null) return; // deferred until the draft is created
    try {
      const detail = await api.uploadFormRecordAttachment(
        form.id,
        recordId,
        file,
        fieldKey,
        version,
        csrf,
      );
      setPending(fieldKey, null);
      absorbImageDetail(detail);
      invalidate(recordId);
    } catch (error) {
      // Keep the pending file so the upload can be retried (via Save/Submit or re-selecting).
      setImages((current) => ({
        ...current,
        [fieldKey]: {
          pendingUrl: objectUrl,
          pendingName: file.name,
          uploading: false,
          error: conflictAwareMessage(error),
        },
      }));
    }
  }

  async function handleImageRemove(fieldKey: string) {
    const committed = images[fieldKey]?.attachmentId;
    if (committed && recordId) {
      try {
        const detail = await api.removeFormRecordAttachment(
          form.id,
          recordId,
          committed,
          version,
          csrf,
        );
        absorbImageDetail(detail);
        invalidate(recordId);
      } catch (error) {
        setImages((current) => ({
          ...current,
          [fieldKey]: {
            ...current[fieldKey],
            error: conflictAwareMessage(error),
          },
        }));
      }
      return;
    }
    setPending(fieldKey, null);
    setImages((current) => {
      const next = { ...current };
      delete next[fieldKey];
      return next;
    });
    setValues((current) => ({ ...current, [fieldKey]: "" }));
  }

  // persist saves the current values and uploads any pending images (for new and existing drafts),
  // then resyncs from the returned server record. Throws on failure, leaving the saved draft and any
  // still-pending images available to retry.
  async function persist(): Promise<FormRecordDetail> {
    const payload = formValuesToPayload(schema, values);
    let currentRecordId = recordId;
    let currentVersion = version;
    if (currentRecordId === null) {
      const created = await api.createFormRecord(
        form.id,
        { values: payload },
        csrf,
      );
      currentRecordId = created.id;
      currentVersion = created.version;
      setRecordId(created.id);
    } else {
      const updated = await api.updateFormRecord(
        form.id,
        currentRecordId,
        { values: payload, version: currentVersion },
        csrf,
      );
      currentVersion = updated.version;
    }
    setVersion(currentVersion);
    // Upload every pending image (initial uploads for a new draft, and retries for either), threading
    // the record version so each upload's optimistic-concurrency check sees the latest value.
    for (const [fieldKey, file] of Object.entries(pendingFiles.current)) {
      const detail = await api.uploadFormRecordAttachment(
        form.id,
        currentRecordId,
        file,
        fieldKey,
        currentVersion,
        csrf,
      );
      setPending(fieldKey, null);
      currentVersion = detail.version;
    }
    const detail = await api.getFormRecord(form.id, currentRecordId);
    absorbSavedDetail(detail);
    invalidate(currentRecordId);
    return detail;
  }

  // handleFieldChange records the edit and re-checks only fields that are already flagged, so a
  // corrected field stops showing red immediately instead of waiting for another submit attempt.
  // Clean fields are never validated mid-typing — nobody wants "must be a valid URL" after one
  // character.
  function handleFieldChange(key: string, value: string | string[] | boolean) {
    setValues((current) => ({ ...current, [key]: value }));
    const field = schema.fields.find((candidate) => candidate.key === key);
    if (!field) return;
    const satisfied = satisfiedImages();
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      const message = fieldError(field, value, true, satisfied);
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }

  // reportValidation stores the field errors and, when there are any, pulls focus to the first one in
  // form order. Without this a submit attempt on a long form looks like nothing happened: the button
  // does nothing visible and the offending field can be far below the fold.
  function reportValidation(validation: Record<string, string>): boolean {
    setErrors(validation);
    const firstInvalid = schema.fields.find((field) => validation[field.key]);
    if (!firstInvalid) return true;
    focusField(firstInvalid.key);
    return false;
  }

  async function saveDraft() {
    setFormError("");
    const validation = validateSubmission(
      schema,
      values,
      false,
      satisfiedImages(),
    );
    if (!reportValidation(validation)) return;
    setBusy("draft");
    try {
      await persist();
    } catch (error) {
      setFormError(conflictAwareMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function submit() {
    setFormError("");
    const validation = validateSubmission(
      schema,
      values,
      true,
      satisfiedImages(),
    );
    if (!reportValidation(validation)) return;
    setBusy("submit");
    try {
      const detail = await persist();
      const transition = detail.availableTransitions.find(
        (candidate) => candidate.requiredCapability === "submit",
      );
      if (!transition) {
        setFormError("This form cannot be submitted from its current state.");
        return;
      }
      await api.transitionFormRecord(
        form.id,
        detail.id,
        { toState: transition.to, version: detail.version },
        csrf,
      );
      invalidate(detail.id);
      // Everything is persisted; leaving is intentional from here.
      completing.current = true;
      onCompleted(detail.id);
    } catch (error) {
      // The draft (and any uploads) are saved server-side; keep the editor so the user can retry.
      setFormError(conflictAwareMessage(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-4">
      {blocker.state === "blocked" && (
        <Alert>
          <AlertTitle>Leave without saving?</AlertTitle>
          <AlertDescription>
            You have unsaved changes to this submission. Leaving now will
            discard them.
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

      {feedback && editable && (
        <Alert>
          <AlertTitle>Changes requested</AlertTitle>
          <AlertDescription>
            <strong>{feedback.actorName ?? "Reviewer"}:</strong> {feedback.note}
          </AlertDescription>
        </Alert>
      )}

      {formError && (
        <Alert variant="destructive">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <ErrorSummary schema={schema} errors={errors} onSelect={focusField} />

      {/* A real form element so Enter in a text field submits, and noValidate so our own validation
          (which produces the summary above) is the only thing that ever blocks a submit. */}
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!editable || busy !== "") return;
          if (canSubmit) void submit();
          else void saveDraft();
        }}
      >
        <FormRenderer
          schema={schema}
          idPrefix={FIELD_ID_PREFIX}
          values={values}
          readOnly={!editable}
          onChange={editable ? handleFieldChange : undefined}
          errors={errors}
          imageHandlers={{
            state: (fieldKey) => images[fieldKey],
            onSelect: (fieldKey, file) =>
              void handleImageSelect(fieldKey, file),
            onRemove: (fieldKey) => void handleImageRemove(fieldKey),
          }}
        />

        {editable ? (
          <div className="flex flex-wrap gap-2">
            <RheaButton
              type="button"
              variant="secondary"
              disabled={busy !== ""}
              aria-busy={busy === "draft" || undefined}
              onClick={() => void saveDraft()}
            >
              {busy === "draft" && <Spinner aria-hidden="true" />}
              Save draft
            </RheaButton>
            {canSubmit && (
              <RheaButton
                type="submit"
                variant="default"
                disabled={busy !== ""}
                aria-busy={busy === "submit" || undefined}
              >
                {busy === "submit" && <Spinner aria-hidden="true" />}
                {submitLabel}
              </RheaButton>
            )}
          </div>
        ) : (
          <Alert>
            <AlertTitle>
              {`This submission is ${stateLabel(form.workflow, state)}`}
            </AlertTitle>
            <AlertDescription>
              It can no longer be edited. A reviewer will follow up if changes
              are needed.
            </AlertDescription>
          </Alert>
        )}
      </form>

      {comments.length > 0 && (
        <section
          className="grid gap-3 rounded-xl border border-border p-4"
          aria-label="Comments"
        >
          <h3 className="text-base font-semibold">Comments</h3>
          <ul className="grid gap-2">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="grid gap-1 rounded-xl border border-border p-3 text-sm"
              >
                <strong>{comment.authorName}</strong>
                <p>{comment.body}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ErrorSummary lists every blocked field in form order with a jump link to each. It is an alert so
// the count is announced the moment a submit is rejected, and it gives a keyboard user a direct route
// to each problem rather than a hunt through the form.
function ErrorSummary({
  schema,
  errors,
  onSelect,
}: {
  schema: FormSchema;
  errors: Record<string, string>;
  onSelect: (fieldKey: string) => void;
}) {
  const invalid = schema.fields.filter((field) => errors[field.key]);
  if (invalid.length === 0) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle size={18} aria-hidden="true" />
      <AlertTitle>
        {invalid.length === 1
          ? "Fix 1 field before continuing"
          : `Fix ${invalid.length} fields before continuing`}
      </AlertTitle>
      <AlertDescription>
        <ul className="grid gap-1">
          {invalid.map((field) => (
            <li key={field.key}>
              <button
                type="button"
                className="underline underline-offset-4 hover:text-foreground"
                onClick={() => onSelect(field.key)}
              >
                {errors[field.key]}
              </button>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

// focusField moves keyboard focus and the viewport to one field's control, so an error is never
// reported for something the submitter cannot see.
function focusField(fieldKey: string) {
  const element = document.getElementById(
    fieldControlId(FIELD_ID_PREFIX, fieldKey),
  );
  if (!element) return;
  // jsdom has no layout engine, so scrollIntoView is absent under test.
  element.scrollIntoView?.({ block: "center" });
  element.focus({ preventScroll: true });
}

function imagesFromDetail(
  formId: string,
  detail: FormRecordDetail | undefined,
): Record<string, ImageFieldState> {
  const result: Record<string, ImageFieldState> = {};
  if (!detail) return result;
  for (const attachment of detail.attachments) {
    result[attachment.fieldKey] = {
      attachmentId: attachment.id,
      contentUrl: api.formAttachmentContentUrl(
        formId,
        detail.id,
        attachment.id,
      ),
    };
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function conflictAwareMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "This submission changed elsewhere. Reload to see the latest version, then try again.";
  }
  return messageOf(error);
}
