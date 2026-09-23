import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Check, Clock3, Send, Undo2 } from "lucide-react";
import { api } from "../api/client";
import type { ContentSubmission, SubmissionStatus } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { ViewTabs } from "../components/ViewTabs";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";

const filters: { value: "" | SubmissionStatus; label: string }[] = [
  { value: "in_review", label: "Needs review" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
  { value: "scheduled", label: "Scheduled" },
  { value: "publication_failed", label: "Publication failed" },
  { value: "published", label: "Published" },
  { value: "", label: "All history" },
];

export function ContentSubmissionInboxPage() {
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const role = auth.status?.user?.role ?? "viewer";
  const canReview = ["owner", "administrator", "editor"].includes(role);
  const canPublish = canReview;
  const canPublishCampaign = ["owner", "administrator"].includes(role);
  const client = useQueryClient();
  const [filter, setFilter] = useState<"" | SubmissionStatus>("in_review");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<Record<string, string>>({});
  const query = useQuery({
    queryKey: ["content-submissions", filter],
    queryFn: () => api.contentSubmissions(filter),
  });
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ["content-submissions"] });
    void client.invalidateQueries({ queryKey: ["content-reviews"] });
  };
  const approve = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.approveContentSubmission(item.id, notes[item.id] ?? "", csrf),
    onSuccess: invalidate,
  });
  const requestChanges = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.requestContentChanges(item.id, notes[item.id] ?? "", csrf),
    onSuccess: invalidate,
  });
  const publish = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.publishContentSubmission(item.id, csrf),
    onSuccess: invalidate,
  });
  const schedulePublication = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.scheduleContentSubmission(
        item.id,
        new Date(schedule[item.id] ?? "").toISOString(),
        csrf,
      ),
    onSuccess: invalidate,
  });
  const cancelSchedule = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.cancelContentSchedule(item.id, csrf),
    onSuccess: invalidate,
  });
  const error =
    approve.error ||
    requestChanges.error ||
    publish.error ||
    schedulePublication.error ||
    cancelSchedule.error;
  const items = query.data?.items ?? [];

  return (
    <section>
      <PageHeader
        title="Content review"
        description="Every submission freezes the exact draft a reviewer saw. Publishing creates a new immutable runtime revision; later edits stay private until submitted again."
        actions={
          <Link
            className={buttonVariants({ variant: "secondary" })}
            to="/content-review"
          >
            Open legacy revision queue
          </Link>
        }
      />
      {query.data && (
        <Alert role="status">
          <AlertDescription>
            Policy: <strong>{query.data.policy}</strong>. Self-approval is{" "}
            {query.data.allowSelfApproval ? "allowed" : "disabled"}; approved
            submissions{" "}
            {query.data.autoPublishOnApproval
              ? "publish automatically"
              : "wait for an explicit publish or schedule action"}
            .
          </AlertDescription>
        </Alert>
      )}
      <ViewTabs
        label="Submission state"
        value={filter}
        items={filters}
        onValueChange={setFilter}
      />
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading submissions…</p>
      ) : query.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load submissions</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : !items.length ? (
        <div className="empty-card">No submissions match this view.</div>
      ) : (
        <div className="backup-list">
          {items.map((item) => (
            <SubmissionRow
              key={item.id}
              item={item}
              canReview={canReview}
              canPublish={
                item.contentType === "campaign"
                  ? canPublishCampaign
                  : canPublish
              }
              note={notes[item.id] ?? ""}
              schedule={schedule[item.id] ?? ""}
              onNote={(value) => setNotes({ ...notes, [item.id]: value })}
              onSchedule={(value) =>
                setSchedule({ ...schedule, [item.id]: value })
              }
              approve={() => approve.mutate(item)}
              requestChanges={() => requestChanges.mutate(item)}
              publish={() => publish.mutate(item)}
              schedulePublication={() => schedulePublication.mutate(item)}
              cancelSchedule={() => cancelSchedule.mutate(item)}
              disabled={
                approve.isPending ||
                requestChanges.isPending ||
                publish.isPending ||
                schedulePublication.isPending ||
                cancelSchedule.isPending
              }
            />
          ))}
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function SubmissionRow({
  item,
  canReview,
  canPublish,
  note,
  schedule,
  onNote,
  onSchedule,
  approve,
  requestChanges,
  publish,
  schedulePublication,
  cancelSchedule,
  disabled,
}: {
  item: ContentSubmission;
  canReview: boolean;
  canPublish: boolean;
  note: string;
  schedule: string;
  onNote: (value: string) => void;
  onSchedule: (value: string) => void;
  approve: () => void;
  requestChanges: () => void;
  publish: () => void;
  schedulePublication: () => void;
  cancelSchedule: () => void;
  disabled: boolean;
}) {
  const href =
    item.contentType === "playlist"
      ? `/playlists/${item.contentId}`
      : item.contentType === "layout"
        ? `/layouts/${item.contentId}`
        : `/campaigns/${item.contentId}`;
  const requiresNote = item.status === "in_review";
  return (
    <article className="backup-row">
      <div className="backup-row__details">
        <strong>
          <Link to={href}>
            {item.contentName || item.contentType} ·{" "}
            {item.contentId.slice(0, 8)}
          </Link>
        </strong>
        <span>
          Draft revision {item.workingRevision} · submitted{" "}
          {new Date(item.submittedAt).toLocaleString()}{" "}
          {item.submitterName ? `by ${item.submitterName}` : ""}
        </span>
        <span>
          <SubmissionBadge status={item.status} />
          {item.newerWorkingDraft && " · A newer private draft exists"}
        </span>
        <span>
          Published revision {item.currentPublishedRevision ?? "none"} ·{" "}
          {item.affectedScreenCount} screens across {item.affectedLocationCount}{" "}
          locations
        </span>
        <span>
          Snapshot SHA-256 <code>{item.snapshotSha256}</code>
        </span>
        {item.reviewNote && (
          <span className="setting-dependency">
            Review note: {item.reviewNote}
          </span>
        )}
        <details>
          <summary>View exact submitted snapshot</summary>
          <pre className="submission-snapshot">
            {JSON.stringify(item.snapshot, null, 2)}
          </pre>
        </details>
      </div>
      <div className="backup-row__actions review-actions">
        {canReview && item.status === "in_review" && (
          <>
            <label className="review-note">
              <span className="text-xs font-medium">Review note</span>
              <input
                value={note}
                onChange={(event) => onNote(event.target.value)}
                placeholder={
                  requiresNote ? "Required when sending back" : "Optional note"
                }
              />
            </label>
            <Button disabled={disabled} onClick={approve}>
              <Check size={15} /> Approve
            </Button>
            <Button
              variant="secondary"
              disabled={disabled || !note.trim()}
              onClick={requestChanges}
            >
              <Undo2 size={15} /> Request changes
            </Button>
          </>
        )}
        {canPublish && item.status === "approved" && (
          <>
            <Button disabled={disabled} onClick={publish}>
              <Send size={15} /> Publish now
            </Button>
            <label className="review-note">
              <span className="text-xs font-medium">Publish at</span>
              <input
                type="datetime-local"
                value={schedule}
                onChange={(event) => onSchedule(event.target.value)}
              />
            </label>
            <Button
              variant="secondary"
              disabled={disabled || !schedule}
              onClick={schedulePublication}
            >
              <Clock3 size={15} /> Schedule
            </Button>
          </>
        )}
        {canPublish && item.status === "scheduled" && (
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={cancelSchedule}
          >
            Cancel schedule
          </Button>
        )}
      </div>
    </article>
  );
}

function statusLabel(status: SubmissionStatus) {
  return {
    in_review: "Needs review",
    changes_requested: "Changes requested",
    approved: "Approved",
    scheduled: "Scheduled",
    published: "Published",
    superseded: "Superseded",
    cancelled: "Cancelled",
    publication_failed: "Publication failed",
  }[status];
}

function SubmissionBadge({ status }: { status: SubmissionStatus }) {
  const variant =
    status === "published"
      ? "default"
      : status === "publication_failed" || status === "changes_requested"
        ? "destructive"
        : status === "approved" || status === "scheduled"
          ? "secondary"
          : "outline";
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}
