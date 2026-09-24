import { useMemo, useState } from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Check, Clock3, Inbox, Send, Undo2 } from "lucide-react";
import { toast } from "../components/ui/toast";
import { api } from "../api/client";
import type { ContentSubmission, SubmissionStatus } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { DateTimeInput } from "../components/date-picker";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";

const filters: { value: "" | SubmissionStatus; label: string }[] = [
  { value: "in_review", label: "Needs review" },
  { value: "changes_requested", label: "Changes requested" },
  { value: "approved", label: "Approved" },
  { value: "scheduled", label: "Scheduled" },
  { value: "publication_failed", label: "Publication failed" },
  { value: "published", label: "Published" },
  { value: "", label: "All history" },
];

const features = tableFeatures({});
const columnHelper = createColumnHelper<typeof features, ContentSubmission>();

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ContentSubmission | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
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
    onSuccess: (_data, item) => {
      invalidate();
      setNotes((current) => ({ ...current, [item.id]: "" }));
      if (selectedId === item.id) setDetailsOpen(false);
      toast.add({ title: "Submission approved.", type: "success" });
    },
  });
  const requestChanges = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.requestContentChanges(item.id, rejectNote, csrf),
    onSuccess: (_data, item) => {
      invalidate();
      setNotes((current) => ({ ...current, [item.id]: "" }));
      setRejectId(null);
      setRejectNote("");
      if (selectedId === item.id) setDetailsOpen(false);
      toast.add({ title: "Changes requested.", type: "success" });
    },
  });
  const publish = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.publishContentSubmission(item.id, csrf),
    onSuccess: (_data, item) => {
      invalidate();
      if (selectedId === item.id) setDetailsOpen(false);
      toast.add({ title: "Submission published.", type: "success" });
    },
  });
  const schedulePublication = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.scheduleContentSubmission(
        item.id,
        new Date(schedule[item.id] ?? "").toISOString(),
        csrf,
      ),
    onSuccess: (_data, item) => {
      invalidate();
      setSchedule((current) => ({ ...current, [item.id]: "" }));
      if (selectedId === item.id) setDetailsOpen(false);
      toast.add({ title: "Publication scheduled.", type: "success" });
    },
  });
  const cancelSchedule = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.cancelContentSchedule(item.id, csrf),
    onSuccess: () => {
      invalidate();
      toast.add({ title: "Schedule cancelled.", type: "success" });
    },
  });
  const error =
    approve.error ||
    requestChanges.error ||
    publish.error ||
    schedulePublication.error ||
    cancelSchedule.error;
  const items = query.data?.items ?? [];
  const rejectItem = items.find((item) => item.id === rejectId) ?? null;
  const busy =
    approve.isPending ||
    requestChanges.isPending ||
    publish.isPending ||
    schedulePublication.isPending ||
    cancelSchedule.isPending;

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "submission",
          header: "Submission",
          cell: ({ row }) => {
            const item = row.original;
            return (
              <div className="grid min-w-0 gap-0.5">
                <Link
                  to={contentHref(item)}
                  className="truncate font-medium text-primary hover:underline"
                >
                  {item.contentName || item.contentType} ·{" "}
                  {item.contentId.slice(0, 8)}
                </Link>
                <span className="text-xs text-muted-foreground">
                  Draft revision {item.workingRevision} · submitted{" "}
                  {new Date(item.submittedAt).toLocaleString()}{" "}
                  {item.submitterName ? `by ${item.submitterName}` : ""}
                </span>
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "status",
          header: "Status",
          cell: ({ row }) => <SubmissionBadge status={row.original.status} />,
        }),
        columnHelper.display({
          id: "impact",
          header: "Impact",
          cell: ({ row }) => {
            const item = row.original;
            return (
              <span className="text-muted-foreground">
                Published revision {item.currentPublishedRevision ?? "none"} ·{" "}
                {item.affectedScreenCount} screens across{" "}
                {item.affectedLocationCount} locations
              </span>
            );
          },
        }),
        columnHelper.display({
          id: "review",
          header: "",
          cell: ({ row }) => (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSelectedId(row.original.id);
                setSelected(row.original);
                setDetailsOpen(true);
              }}
            >
              Review
            </Button>
          ),
        }),
      ]),
    [],
  );
  const table = useTable({
    features,
    columns,
    data: items,
    getRowId: (row) => row.id,
  });

  return (
    <section className="grid gap-4">
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
      <ToggleGroup
        value={[filter || "all"]}
        onValueChange={(values) =>
          setFilter(
            values[0] && values[0] !== "all"
              ? (values[0] as SubmissionStatus)
              : "",
          )
        }
        variant="outline"
        size="sm"
        spacing={1}
        aria-label="Submission state filter"
      >
        {filters.map((item) => (
          <ToggleGroupItem
            key={item.value || "all"}
            value={item.value || "all"}
          >
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading submissions…</p>
      ) : query.error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load submissions</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : !items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No submissions match this view</EmptyTitle>
            <EmptyDescription>
              Submissions appear here once content is submitted for review.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table className="min-w-[48rem]">
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className="bg-muted/40 text-xs text-muted-foreground"
                    >
                      {header.isPlaceholder ? null : (
                        <table.FlexRender header={header} />
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className="px-2.5 py-2">
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
      <Sheet
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        onOpenChangeComplete={(open) => {
          if (!open) {
            setSelectedId(null);
            setSelected(null);
          }
        }}
      >
        {selected && (
          <SheetContent className="grid gap-4 overflow-y-auto">
            <SheetHeader>
              <SheetTitle>
                {selected.contentName || selected.contentType} ·{" "}
                {selected.contentId.slice(0, 8)}
              </SheetTitle>
              <SheetDescription>
                Draft revision {selected.workingRevision} · submitted{" "}
                {new Date(selected.submittedAt).toLocaleString()}{" "}
                {selected.submitterName ? `by ${selected.submitterName}` : ""}
              </SheetDescription>
            </SheetHeader>
            <dl className="grid gap-2 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <SubmissionBadge status={selected.status} />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">Published revision</dt>
                <dd>{selected.currentPublishedRevision ?? "none"}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">Impact</dt>
                <dd>
                  {selected.affectedScreenCount} screens across{" "}
                  {selected.affectedLocationCount} locations
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">Snapshot SHA-256</dt>
                <dd>
                  <code className="text-xs break-all">
                    {selected.snapshotSha256}
                  </code>
                </dd>
              </div>
              {selected.newerWorkingDraft && (
                <p className="text-sm text-muted-foreground">
                  A newer private draft exists.
                </p>
              )}
              {selected.reviewNote && (
                <p className="text-sm text-muted-foreground">
                  Review note: {selected.reviewNote}
                </p>
              )}
            </dl>
            <Collapsible className="grid gap-2">
              <CollapsibleTrigger className="w-fit cursor-pointer text-sm font-medium underline-offset-4 hover:underline">
                View exact submitted snapshot
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(selected.snapshot, null, 2)}
                </pre>
              </CollapsibleContent>
            </Collapsible>
            {canReview && selected.status === "in_review" && (
              <div className="grid gap-2">
                <Field>
                  <FieldLabel htmlFor="submission-review-note">
                    Review note
                  </FieldLabel>
                  <Textarea
                    id="submission-review-note"
                    rows={2}
                    value={notes[selected.id] ?? ""}
                    placeholder="Optional note recorded with approval"
                    onChange={(event) =>
                      setNotes({ ...notes, [selected.id]: event.target.value })
                    }
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={busy}
                    onClick={() => approve.mutate(selected)}
                  >
                    <Check size={15} aria-hidden="true" /> Approve
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setRejectNote(notes[selected.id] ?? "");
                      setRejectId(selected.id);
                    }}
                  >
                    <Undo2 size={15} aria-hidden="true" /> Request changes
                  </Button>
                </div>
              </div>
            )}
            {selected.contentType === "campaign"
              ? canPublishCampaign &&
                selected.status === "approved" && (
                  <PublishActions
                    item={selected}
                    schedule={schedule[selected.id] ?? ""}
                    onSchedule={(value) =>
                      setSchedule({ ...schedule, [selected.id]: value })
                    }
                    publish={() => publish.mutate(selected)}
                    schedulePublication={() =>
                      schedulePublication.mutate(selected)
                    }
                    disabled={busy}
                  />
                )
              : canPublish &&
                selected.status === "approved" && (
                  <PublishActions
                    item={selected}
                    schedule={schedule[selected.id] ?? ""}
                    onSchedule={(value) =>
                      setSchedule({ ...schedule, [selected.id]: value })
                    }
                    publish={() => publish.mutate(selected)}
                    schedulePublication={() =>
                      schedulePublication.mutate(selected)
                    }
                    disabled={busy}
                  />
                )}
            {(selected.contentType === "campaign"
              ? canPublishCampaign
              : canPublish) &&
              selected.status === "scheduled" && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => cancelSchedule.mutate(selected)}
                >
                  Cancel schedule
                </Button>
              )}
            <p className="text-sm">
              <Link
                to={contentHref(selected)}
                className="font-medium text-primary hover:underline"
              >
                Open content
              </Link>
            </p>
          </SheetContent>
        )}
      </Sheet>
      <Dialog
        open={rejectItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectId(null);
            setRejectNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request changes</DialogTitle>
            <DialogDescription>
              A reason is required so the author knows what to fix.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="submission-reject-note">
              Reason for sending back
            </FieldLabel>
            <Textarea
              id="submission-reject-note"
              rows={3}
              value={rejectNote}
              placeholder="What must change before this can be approved?"
              onChange={(event) => setRejectNote(event.target.value)}
            />
            <FieldDescription>
              Recorded with the decision and shown to the author.
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={requestChanges.isPending}
              onClick={() => {
                setRejectId(null);
                setRejectNote("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={requestChanges.isPending || !rejectNote.trim()}
              onClick={() => {
                if (rejectItem) requestChanges.mutate(rejectItem);
              }}
            >
              <Undo2 size={15} aria-hidden="true" /> Send back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function PublishActions({
  schedule,
  onSchedule,
  publish,
  schedulePublication,
  disabled,
}: {
  item: ContentSubmission;
  schedule: string;
  onSchedule: (value: string) => void;
  publish: () => void;
  schedulePublication: () => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={publish}>
          <Send size={15} aria-hidden="true" /> Publish now
        </Button>
      </div>
      <Field>
        <FieldLabel htmlFor="submission-publish-at">Publish at</FieldLabel>
        <DateTimeInput
          id="submission-publish-at"
          aria-label="Publish at"
          timeLabel="Publication time"
          value={schedule}
          onChange={onSchedule}
        />
        <FieldDescription>
          Schedule publication for a future date and time.
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={disabled || !schedule}
          onClick={schedulePublication}
        >
          <Clock3 size={15} aria-hidden="true" /> Schedule
        </Button>
      </div>
    </div>
  );
}

function contentHref(item: ContentSubmission) {
  return item.contentType === "playlist"
    ? `/playlists/${item.contentId}`
    : item.contentType === "layout"
      ? `/layouts/${item.contentId}`
      : `/campaigns/${item.contentId}`;
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
