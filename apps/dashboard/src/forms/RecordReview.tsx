import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  FormAvailableTransition,
  FormDataSource,
  FormRecordDetail,
} from "../api/types";
import { api, ApiError } from "../api/client";
import {
  Button,
  Field,
  Input,
  Notice,
  Spinner,
  StatusBadge,
  Textarea,
} from "../components/legacy-ui";
import {
  FormRenderer,
  type FormValues,
  type ImageFieldState,
} from "./FormRenderer";
import {
  coerceScalar,
  formValuesToPayload,
  localDateTimeToRfc3339,
  recordValuesToForm,
  rfc3339ToLocalDateTime,
} from "./formValues";
import { stateLabel, stateTone } from "./formStatus";

// RecordReview is the single record-detail component shared by the Responses tab and the central
// Approvals inbox. It renders a record's values against its immutable revision schema, its image
// attachments, submitter/status/metadata, comments and event history, and the exact transition
// controls the server authorized (availableTransitions) — never hardcoding which capabilities the
// viewer has. When the server marks the record editable it also allows editing values and display
// metadata. All actions include the current version and handle 409 by refreshing while preserving
// an unsent note.
export function RecordReview({
  form,
  recordId,
  csrf,
  onAfterTransition,
}: {
  form: FormDataSource;
  recordId: string;
  csrf: string;
  onAfterTransition?: () => void;
}) {
  const queryClient = useQueryClient();
  const detailQuery = useQuery({
    queryKey: ["form-record", form.id, recordId],
    queryFn: () => api.getFormRecord(form.id, recordId),
  });

  if (detailQuery.isLoading) return <Spinner label="Loading submission…" />;
  if (detailQuery.isError || !detailQuery.data) {
    return (
      <Notice variant="danger" title="Submission unavailable">
        This submission could not be loaded or you no longer have access to it.
      </Notice>
    );
  }
  return (
    <RecordReviewBody
      key={detailQuery.data.id}
      form={form}
      detail={detailQuery.data}
      csrf={csrf}
      onChanged={() => {
        void queryClient.invalidateQueries({
          queryKey: ["form-record", form.id, recordId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["form-records", form.id],
        });
        void queryClient.invalidateQueries({
          queryKey: ["data-source", form.id],
        });
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        void queryClient.invalidateQueries({ queryKey: ["forms"] });
        onAfterTransition?.();
      }}
    />
  );
}

function RecordReviewBody({
  form,
  detail,
  csrf,
  onChanged,
}: {
  form: FormDataSource;
  detail: FormRecordDetail;
  csrf: string;
  onChanged: () => void;
}) {
  const schema = detail.revision?.schema ??
    form.publishedRevision?.schema ?? { fields: [] };
  const [version, setVersion] = useState(detail.version);
  const [values, setValues] = useState<FormValues>(() =>
    recordValuesToForm(schema, detail.values),
  );
  const [images, setImages] = useState<Record<string, ImageFieldState>>(() =>
    imagesFromDetail(form.id, detail),
  );
  const [displayTitle, setDisplayTitle] = useState(detail.displayTitle);
  const [priority, setPriority] = useState(String(detail.priority));
  const [displayAt, setDisplayAt] = useState(
    rfc3339ToLocalDateTime(detail.displayAt ?? ""),
  );
  const [expiresAt, setExpiresAt] = useState(
    rfc3339ToLocalDateTime(detail.expiresAt ?? ""),
  );
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const baseline = useRef(
    JSON.stringify({ values, displayTitle, priority, displayAt, expiresAt }),
  );

  // resyncFrom replaces all local edit state with a freshly fetched server record and resets the
  // dirty baseline. Used for 409 recovery so stale local values are never paired with a newer
  // server version; the caller preserves only the unsent transition note.
  function resyncFrom(fresh: FormRecordDetail) {
    const nextValues = recordValuesToForm(schema, fresh.values);
    const nextDisplayTitle = fresh.displayTitle;
    const nextPriority = String(fresh.priority);
    const nextDisplayAt = rfc3339ToLocalDateTime(fresh.displayAt ?? "");
    const nextExpiresAt = rfc3339ToLocalDateTime(fresh.expiresAt ?? "");
    setValues(nextValues);
    setDisplayTitle(nextDisplayTitle);
    setPriority(nextPriority);
    setDisplayAt(nextDisplayAt);
    setExpiresAt(nextExpiresAt);
    setImages(imagesFromDetail(form.id, fresh));
    setVersion(fresh.version);
    baseline.current = JSON.stringify({
      values: nextValues,
      displayTitle: nextDisplayTitle,
      priority: nextPriority,
      displayAt: nextDisplayAt,
      expiresAt: nextExpiresAt,
    });
  }

  async function recover() {
    try {
      const fresh = await api.getFormRecord(form.id, detail.id);
      resyncFrom(fresh);
    } catch {
      // If the refetch also fails, the surrounding query invalidation will retry.
    }
    onChanged();
  }

  const canEdit = detail.canEdit;
  const canComment = detail.canComment;
  const dirty =
    JSON.stringify({ values, displayTitle, priority, displayAt, expiresAt }) !==
    baseline.current;

  async function saveEdits(): Promise<number> {
    const payload = formValuesToPayload(schema, values);
    const updated = await api.updateFormRecord(
      form.id,
      detail.id,
      {
        values: payload,
        displayTitle,
        priority: priority === "" ? 0 : Number(priority),
        displayAt: displayAt ? localDateTimeToRfc3339(displayAt) : null,
        expiresAt: expiresAt ? localDateTimeToRfc3339(expiresAt) : null,
        version,
      },
      csrf,
    );
    setVersion(updated.version);
    baseline.current = JSON.stringify({
      values,
      displayTitle,
      priority,
      displayAt,
      expiresAt,
    });
    onChanged();
    return updated.version;
  }

  async function handleSave() {
    setError("");
    setBusy(true);
    try {
      await saveEdits();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await recover();
      }
      setError(conflictMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTransition(transition: FormAvailableTransition) {
    setError("");
    if (transition.requiresNote && note.trim() === "") {
      setError(`A note is required to ${transition.label.toLowerCase()}.`);
      return;
    }
    setBusy(true);
    try {
      // Persist any unsaved value/metadata edits first so the transition acts on the latest data.
      let currentVersion = version;
      if (canEdit && dirty) currentVersion = await saveEdits();
      const record = await api.transitionFormRecord(
        form.id,
        detail.id,
        {
          toState: transition.to,
          note: note.trim() || undefined,
          version: currentVersion,
        },
        csrf,
      );
      setVersion(record.version);
      setNote("");
      onChanged();
    } catch (err) {
      // On a conflict, fully refresh from the server (values, metadata, images, state, version) and
      // reset the edit baseline, preserving only the unsent note, so stale local state is never
      // paired with a newer server version.
      if (err instanceof ApiError && err.status === 409) {
        await recover();
        setError(
          "This submission changed since you opened it. It has been refreshed — review the latest version and try again.",
        );
      } else {
        setError(
          err instanceof Error ? err.message : "Could not apply the change.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function addComment() {
    if (comment.trim() === "") return;
    setBusy(true);
    setError("");
    try {
      await api.addFormRecordComment(form.id, detail.id, comment.trim(), csrf);
      setComment("");
      onChanged();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not add the comment.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleImageSelect(fieldKey: string, file: File) {
    setImages((current) => ({ ...current, [fieldKey]: { uploading: true } }));
    try {
      const updated = await api.uploadFormRecordAttachment(
        form.id,
        detail.id,
        file,
        fieldKey,
        version,
        csrf,
      );
      setImages(imagesFromDetail(form.id, updated));
      setValues((current) => ({
        ...current,
        [fieldKey]: coerceScalar(updated.values[fieldKey]),
      }));
      setVersion(updated.version);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await recover();
      setImages((current) => ({
        ...current,
        [fieldKey]: { error: conflictMessage(err) },
      }));
    }
  }

  async function handleImageRemove(fieldKey: string) {
    const attachmentId = images[fieldKey]?.attachmentId;
    if (!attachmentId) return;
    try {
      const updated = await api.removeFormRecordAttachment(
        form.id,
        detail.id,
        attachmentId,
        version,
        csrf,
      );
      setImages(imagesFromDetail(form.id, updated));
      setValues((current) => ({ ...current, [fieldKey]: "" }));
      setVersion(updated.version);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await recover();
      setImages((current) => ({
        ...current,
        [fieldKey]: { ...current[fieldKey], error: conflictMessage(err) },
      }));
    }
  }

  const requiresNoteTransition = detail.availableTransitions.some(
    (t) => t.requiresNote,
  );

  return (
    <div className="record-review">
      <header className="record-review__header">
        <div>
          <h2>{detail.displayTitle || "Untitled submission"}</h2>
          <p className="record-review__meta">
            Submitted by {detail.submitterName || "Unknown"} ·{" "}
            {new Date(detail.createdAt).toLocaleString()}
            {detail.revision && (
              <> · Revision {detail.revision.revisionNumber}</>
            )}
          </p>
        </div>
        <StatusBadge
          label={stateLabel(form.workflow, detail.state)}
          tone={stateTone(form.workflow, detail.state)}
        />
      </header>

      {error && (
        <Notice variant="danger" title="Action failed">
          {error}
        </Notice>
      )}

      <FormRenderer
        schema={schema}
        values={values}
        readOnly={!canEdit}
        onChange={
          canEdit
            ? (key, value) =>
                setValues((current) => ({ ...current, [key]: value }))
            : undefined
        }
        imageHandlers={{
          state: (fieldKey) => images[fieldKey],
          onSelect: (fieldKey, file) => void handleImageSelect(fieldKey, file),
          onRemove: (fieldKey) => void handleImageRemove(fieldKey),
        }}
      />

      <section
        className="record-review__metadata"
        aria-label="Display metadata"
      >
        <h3>Display settings</h3>
        <div className="record-review__metadata-grid">
          <Field label="Display title">
            <Input
              value={displayTitle}
              disabled={!canEdit}
              onChange={(event) => setDisplayTitle(event.target.value)}
            />
          </Field>
          <Field label="Priority">
            <Input
              type="number"
              value={priority}
              disabled={!canEdit}
              onChange={(event) => setPriority(event.target.value)}
            />
          </Field>
          <Field label="Display from">
            <Input
              type="datetime-local"
              value={displayAt}
              disabled={!canEdit}
              onChange={(event) => setDisplayAt(event.target.value)}
            />
          </Field>
          <Field label="Expires at">
            <Input
              type="datetime-local"
              value={expiresAt}
              disabled={!canEdit}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
        </div>
        {canEdit && (
          <Button
            variant="secondary"
            loading={busy}
            disabled={busy || !dirty}
            onClick={() => void handleSave()}
          >
            Save changes
          </Button>
        )}
      </section>

      {detail.availableTransitions.length > 0 && (
        <section className="record-review__actions" aria-label="Decision">
          <h3>Decision</h3>
          {requiresNoteTransition && (
            <Field label="Note" description="Required when requesting changes.">
              <Textarea
                rows={2}
                value={note}
                aria-label="Note"
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
          )}
          <div className="record-review__transition-buttons">
            {detail.availableTransitions.map((transition) => (
              <Button
                key={`${transition.to}`}
                variant={transition.requiresNote ? "secondary" : "primary"}
                disabled={busy}
                onClick={() => void runTransition(transition)}
              >
                {transition.label}
              </Button>
            ))}
          </div>
        </section>
      )}

      <section className="record-review__comments" aria-label="Comments">
        <h3>Comments</h3>
        {detail.comments.length === 0 ? (
          <p className="record-review__empty">No comments yet.</p>
        ) : (
          <ul>
            {detail.comments.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.authorName}</strong>
                <span className="record-review__comment-time">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
                <p>{entry.body}</p>
              </li>
            ))}
          </ul>
        )}
        {canComment && (
          <div className="record-review__add-comment">
            <Textarea
              rows={2}
              value={comment}
              placeholder="Add a comment"
              aria-label="Add a comment"
              onChange={(event) => setComment(event.target.value)}
            />
            <Button
              variant="secondary"
              disabled={busy || comment.trim() === ""}
              onClick={() => void addComment()}
            >
              Comment
            </Button>
          </div>
        )}
      </section>

      <section className="record-review__history" aria-label="History">
        <h3>History</h3>
        <ul>
          {detail.events.map((event) => (
            <li key={event.id}>
              <span className="record-review__event-type">
                {describeEvent(event)}
              </span>
              <span className="record-review__event-time">
                {new Date(event.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function describeEvent(event: FormRecordDetail["events"][number]): string {
  const actor = event.actorName ? ` by ${event.actorName}` : "";
  switch (event.eventType) {
    case "created":
      return `Created${actor}`;
    case "edited":
      return `Edited${actor}`;
    case "transition":
      return `Moved ${event.fromState ?? "?"} → ${event.toState ?? "?"}${actor}`;
    case "comment":
      return `Commented${actor}`;
    case "attachment_added":
      return `Added an attachment${actor}`;
    case "attachment_removed":
      return `Removed an attachment${actor}`;
    default:
      return `${event.eventType}${actor}`;
  }
}

function imagesFromDetail(
  formId: string,
  detail: FormRecordDetail,
): Record<string, ImageFieldState> {
  const result: Record<string, ImageFieldState> = {};
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

function conflictMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "This submission changed elsewhere. Reload to see the latest version, then try again.";
  }
  return messageOf(error);
}
