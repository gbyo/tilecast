import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Check, Undo2 } from "lucide-react";
import { api } from "../api/client";
import type { ContentReviewItem, ContentReviewState } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/legacy-ui";

const stateLabels: Record<ContentReviewState, string> = {
  pending: "Waiting for review",
  approved: "Approved",
  rejected: "Sent back",
};

// Review has no submit step. Content is pending whenever its current revision
// has no decision, so editing approved content puts it back in this queue by
// itself. That is worth stating on the page: a reviewer who does not know it
// will wonder why something they approved is here again.
export function ContentReviewPage() {
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const role = auth.status?.user?.role ?? "viewer";
  const canDecide = ["owner", "administrator", "editor"].includes(role);

  const [filter, setFilter] = useState<ContentReviewState | "">("pending");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const queue = useQuery({
    queryKey: ["content-reviews", filter],
    queryFn: () => api.contentReviews(filter),
  });

  const decide = useMutation({
    mutationFn: (input: { item: ContentReviewItem; approve: boolean }) =>
      api.decideContentReview(
        input.item.contentType,
        input.item.contentId,
        {
          approve: input.approve,
          note: notes[key(input.item)] ?? "",
          revision: input.item.revision,
        },
        csrf,
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["content-reviews"] });
    },
  });

  const items = queue.data?.items ?? [];

  return (
    <section>
      <PageHeader
        title="Content review"
        description="A playlist or Layout must be approved at its current revision before it can go on a screen. Editing approved content sends it back here."
        actions={
          <Link className="button" to="/content-review/submissions">
            Open submission inbox
          </Link>
        }
      />

      {queue.data && !queue.data.required && (
        <div className="notice">
          Approval is not required on this installation, so nothing here blocks
          assignment. An Owner or Administrator can turn it on under{" "}
          <Link to="/settings/content-review">Settings, Content review</Link>.
        </div>
      )}

      <nav className="view-tabs" aria-label="Review state">
        {(["pending", "approved", "rejected", ""] as const).map((value) => (
          <button
            key={value || "all"}
            className="button button--quiet"
            aria-current={filter === value ? "page" : undefined}
            onClick={() => setFilter(value)}
          >
            {value === "" ? "All" : stateLabels[value]}
          </button>
        ))}
      </nav>

      {queue.isLoading ? (
        <div className="table-loading">Loading the review queue…</div>
      ) : queue.error ? (
        <div className="notice notice--error" role="alert">
          {queue.error.message}
        </div>
      ) : !items.length ? (
        <div className="empty-card">
          {filter === "pending"
            ? "Nothing is waiting for review."
            : "Nothing to show."}
        </div>
      ) : (
        <div className="backup-list">
          {items.map((item) => (
            <article className="backup-row" key={key(item)}>
              <div className="backup-row__details">
                <strong>
                  <Link
                    to={
                      item.contentType === "playlist"
                        ? `/playlists/${item.contentId}`
                        : `/layouts/${item.contentId}`
                    }
                  >
                    {item.name}
                  </Link>
                </strong>
                <span>
                  {item.contentType === "playlist" ? "Playlist" : "Layout"} ·
                  revision {item.revision}
                  {item.authorName ? ` · ${item.authorName}` : ""} · updated{" "}
                  {new Date(item.updatedAt).toLocaleString()}
                </span>
                <span>
                  <span
                    className={`status-badge status-badge--${badge(item.state)}`}
                  >
                    {stateLabels[item.state]}
                  </span>
                  {item.assignedScreens > 0 && (
                    <>
                      {" · "}
                      <strong>
                        Already on {item.assignedScreens} screen
                        {item.assignedScreens === 1 ? "" : "s"}
                      </strong>
                    </>
                  )}
                </span>
                {item.lastNote && (
                  <span className="setting-dependency">
                    Last note: {item.lastNote}
                  </span>
                )}
              </div>
              {canDecide && (
                <div className="backup-row__actions review-actions">
                  <label className="review-note">
                    <span className="field__label">Note</span>
                    <input
                      value={notes[key(item)] ?? ""}
                      placeholder="Required when sending back"
                      onChange={(event) =>
                        setNotes({
                          ...notes,
                          [key(item)]: event.target.value,
                        })
                      }
                    />
                  </label>
                  <button
                    className="button button--primary"
                    disabled={decide.isPending || item.state === "approved"}
                    onClick={() => decide.mutate({ item, approve: true })}
                  >
                    <Check size={15} /> Approve
                  </button>
                  <button
                    className="button"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ item, approve: false })}
                  >
                    <Undo2 size={15} /> Send back
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {decide.error && (
        <div className="notice notice--error" role="alert">
          {decide.error.message}
        </div>
      )}
    </section>
  );
}

function key(item: ContentReviewItem) {
  return `${item.contentType}:${item.contentId}`;
}

function badge(state: ContentReviewState) {
  if (state === "approved") return "online";
  if (state === "rejected") return "offline";
  return "recent";
}
