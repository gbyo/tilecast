import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Check, Inbox, Undo2 } from "lucide-react";
import { api } from "../api/client";
import type { ContentReviewItem, ContentReviewState } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";

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
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            Content review
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A playlist or Layout must be approved at its current revision before
            it can go on a screen. Editing approved content sends it back here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            className="inline-flex h-9 items-center justify-center gap-2 rounded-2xl border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
            to="/content-review/submissions"
          >
            Open submission inbox
          </Link>
        </div>
      </header>

      {queue.data && !queue.data.required && (
        <Alert>
          <AlertDescription>
            Approval is not required on this installation, so nothing here
            blocks assignment. An Owner or Administrator can turn it on under{" "}
            <Link
              to="/settings/content-review"
              className="font-medium text-primary hover:underline"
            >
              Settings, Content review
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}

      <nav
        className="flex flex-wrap gap-1 border-b border-border"
        aria-label="Review state"
      >
        {(["pending", "approved", "rejected", ""] as const).map((value) => (
          <button
            key={value || "all"}
            type="button"
            aria-current={filter === value ? "page" : undefined}
            onClick={() => setFilter(value)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              filter === value
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {value === "" ? "All" : stateLabels[value]}
          </button>
        ))}
      </nav>

      {queue.isLoading ? (
        <div className="grid gap-2" aria-label="Loading the review queue">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : queue.error ? (
        <Alert variant="destructive">
          <AlertDescription>{queue.error.message}</AlertDescription>
        </Alert>
      ) : !items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {filter === "pending"
                ? "Nothing is waiting for review"
                : "Nothing to show"}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-2">
          {items.map((item) => (
            <article
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4"
              key={key(item)}
            >
              <div className="grid min-w-0 flex-1 gap-1">
                <strong className="text-sm">
                  <Link
                    to={
                      item.contentType === "playlist"
                        ? `/playlists/${item.contentId}`
                        : `/layouts/${item.contentId}`
                    }
                    className="font-medium text-primary hover:underline"
                  >
                    {item.name}
                  </Link>
                </strong>
                <span className="text-xs text-muted-foreground">
                  {item.contentType === "playlist" ? "Playlist" : "Layout"} ·
                  revision {item.revision}
                  {item.authorName ? ` · ${item.authorName}` : ""} · updated{" "}
                  {new Date(item.updatedAt).toLocaleString()}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={badgeVariant(item.state)}>
                    {stateLabels[item.state]}
                  </Badge>
                  {item.assignedScreens > 0 && (
                    <strong>
                      Already on {item.assignedScreens} screen
                      {item.assignedScreens === 1 ? "" : "s"}
                    </strong>
                  )}
                </span>
                {item.lastNote && (
                  <span className="text-xs text-muted-foreground">
                    Last note: {item.lastNote}
                  </span>
                )}
              </div>
              {canDecide && (
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid gap-1 text-xs font-medium">
                    <span>Note</span>
                    <Input
                      value={notes[key(item)] ?? ""}
                      placeholder="Required when sending back"
                      onChange={(event) =>
                        setNotes({
                          ...notes,
                          [key(item)]: event.target.value,
                        })
                      }
                      className="w-52"
                    />
                  </label>
                  <RheaButton
                    type="button"
                    disabled={decide.isPending || item.state === "approved"}
                    onClick={() => decide.mutate({ item, approve: true })}
                  >
                    <Check size={15} aria-hidden="true" /> Approve
                  </RheaButton>
                  <RheaButton
                    type="button"
                    variant="secondary"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ item, approve: false })}
                  >
                    <Undo2 size={15} aria-hidden="true" /> Send back
                  </RheaButton>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {decide.error && (
        <Alert variant="destructive">
          <AlertDescription>{decide.error.message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function key(item: ContentReviewItem) {
  return `${item.contentType}:${item.contentId}`;
}

function badgeVariant(state: ContentReviewState) {
  if (state === "approved") return "default";
  if (state === "rejected") return "destructive";
  return "secondary";
}
