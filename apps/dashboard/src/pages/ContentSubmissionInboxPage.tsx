import { useMemo, useState } from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link } from "react-router";
import { Check, Clock3, Inbox, Send, Undo2 } from "lucide-react";
import { toast } from "../components/ui/toast";
import { api } from "../api/client";
import type { ContentSubmission, SubmissionStatus } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { ViewTabs } from "../components/ViewTabs";
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

const filterDefs = [
  { value: "in_review", labelKey: "submissions.filters.needsReview" },
  {
    value: "changes_requested",
    labelKey: "submissions.filters.changesRequested",
  },
  { value: "approved", labelKey: "submissions.filters.approved" },
  { value: "scheduled", labelKey: "submissions.filters.scheduled" },
  {
    value: "publication_failed",
    labelKey: "submissions.filters.publicationFailed",
  },
  { value: "published", labelKey: "submissions.filters.published" },
  { value: "", labelKey: "submissions.filters.allHistory" },
] as const;

const statusKeys = {
  in_review: "submissions.status.inReview",
  changes_requested: "submissions.status.changesRequested",
  approved: "submissions.status.approved",
  scheduled: "submissions.status.scheduled",
  published: "submissions.status.published",
  superseded: "submissions.status.superseded",
  cancelled: "submissions.status.cancelled",
  publication_failed: "submissions.status.publicationFailed",
} as const satisfies Record<SubmissionStatus, string>;

const features = tableFeatures({});
const columnHelper = createColumnHelper<typeof features, ContentSubmission>();

export function ContentSubmissionInboxPage() {
  const { t } = useTranslation(["review", "common"]);
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
      toast.add({ title: t("submissions.toast.approved"), type: "success" });
    },
    onError: (err) =>
      toast.add({
        title:
          err instanceof Error ? err.message : t("submissions.toast.approveFailed"),
        type: "error",
      }),
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
      toast.add({
        title: t("submissions.toast.changesRequested"),
        type: "success",
      });
    },
    onError: (err) =>
      toast.add({
        title:
          err instanceof Error
            ? err.message
            : t("submissions.toast.requestChangesFailed"),
        type: "error",
      }),
  });
  const publish = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.publishContentSubmission(item.id, csrf),
    onSuccess: (_data, item) => {
      invalidate();
      if (selectedId === item.id) setDetailsOpen(false);
      toast.add({ title: t("submissions.toast.published"), type: "success" });
    },
    onError: (err) =>
      toast.add({
        title:
          err instanceof Error
            ? err.message
            : t("submissions.toast.publishFailed"),
        type: "error",
      }),
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
      toast.add({ title: t("submissions.toast.scheduled"), type: "success" });
    },
    onError: (err) =>
      toast.add({
        title:
          err instanceof Error
            ? err.message
            : t("submissions.toast.scheduleFailed"),
        type: "error",
      }),
  });
  const cancelSchedule = useMutation({
    mutationFn: (item: ContentSubmission) =>
      api.cancelContentSchedule(item.id, csrf),
    onSuccess: () => {
      invalidate();
      toast.add({
        title: t("submissions.toast.scheduleCancelled"),
        type: "success",
      });
    },
    onError: (err) =>
      toast.add({
        title:
          err instanceof Error
            ? err.message
            : t("submissions.toast.cancelScheduleFailed"),
        type: "error",
      }),
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
          header: t("submissions.table.submission"),
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
                  {submissionMeta(
                    t,
                    item,
                    new Date(item.submittedAt).toLocaleString(),
                  )}
                </span>
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "status",
          header: t("submissions.table.status"),
          cell: ({ row }) => <SubmissionBadge status={row.original.status} />,
        }),
        columnHelper.display({
          id: "impact",
          header: t("submissions.table.impact"),
          cell: ({ row }) => {
            const item = row.original;
            return (
              <span className="text-muted-foreground">
                {t("submissions.itemImpact", {
                  published:
                    item.currentPublishedRevision ??
                    t("submissions.detail.noRevision"),
                  screens: item.affectedScreenCount,
                  locations: item.affectedLocationCount,
                })}
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
              {t("submissions.table.reviewAction")}
            </Button>
          ),
        }),
      ]),
    [t],
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
        title={t("submissions.title")}
        description={t("submissions.description")}
        actions={
          <Link
            className={buttonVariants({ variant: "secondary" })}
            to="/content-review"
          >
            {t("submissions.openLegacyQueue")}
          </Link>
        }
      />
      {query.data && (
        <Alert role="status">
          <AlertDescription>
            <Trans
              i18nKey="submissions.policyNotice"
              ns="review"
              values={{
                policy: query.data.policy,
                selfApproval: t(
                  query.data.allowSelfApproval
                    ? "submissions.policy.selfApprovalAllowed"
                    : "submissions.policy.selfApprovalDisabled",
                ),
                behavior: t(
                  query.data.autoPublishOnApproval
                    ? "submissions.policy.behaviorAuto"
                    : "submissions.policy.behaviorManual",
                ),
              }}
              components={{ strong: <strong /> }}
            />
          </AlertDescription>
        </Alert>
      )}
      <ViewTabs
        label={t("submissions.filterLabel")}
        value={filter}
        items={filterDefs.map((def) => ({
          value: def.value,
          label: t(def.labelKey),
        }))}
        onValueChange={setFilter}
      />
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">
          {t("submissions.loading")}
        </p>
      ) : query.error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("submissions.loadErrorTitle")}</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      ) : !items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("submissions.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("submissions.emptyDescription")}
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
                {submissionMeta(
                  t,
                  selected,
                  new Date(selected.submittedAt).toLocaleString(),
                )}
              </SheetDescription>
            </SheetHeader>
            <dl className="grid gap-2 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("submissions.detail.status")}
                </dt>
                <dd>
                  <SubmissionBadge status={selected.status} />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("submissions.detail.publishedRevision")}
                </dt>
                <dd>
                  {selected.currentPublishedRevision ??
                    t("submissions.detail.noRevision")}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("submissions.detail.impact")}
                </dt>
                <dd>
                  {t("submissions.detail.coverage", {
                    screens: selected.affectedScreenCount,
                    locations: selected.affectedLocationCount,
                  })}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted-foreground">
                  {t("submissions.detail.snapshotHash")}
                </dt>
                <dd>
                  <code className="text-xs break-all">
                    {selected.snapshotSha256}
                  </code>
                </dd>
              </div>
              {selected.newerWorkingDraft && (
                <p className="text-sm text-muted-foreground">
                  {t("submissions.detail.newerDraft")}
                </p>
              )}
              {selected.reviewNote && (
                <p className="text-sm text-muted-foreground">
                  {t("submissions.detail.reviewNote", {
                    note: selected.reviewNote,
                  })}
                </p>
              )}
            </dl>
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                {t("submissions.detail.viewSnapshot")}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                {JSON.stringify(selected.snapshot, null, 2)}
              </pre>
            </details>
            {canReview && selected.status === "in_review" && (
              <div className="grid gap-2">
                <Field>
                  <FieldLabel htmlFor="submission-review-note">
                    {t("submissions.reviewForm.noteLabel")}
                  </FieldLabel>
                  <Textarea
                    id="submission-review-note"
                    rows={2}
                    value={notes[selected.id] ?? ""}
                    placeholder={t("submissions.reviewForm.notePlaceholder")}
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
                    <Check size={15} aria-hidden="true" />{" "}
                    {t("submissions.reviewForm.approve")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setRejectNote(notes[selected.id] ?? "");
                      setRejectId(selected.id);
                    }}
                  >
                    <Undo2 size={15} aria-hidden="true" />{" "}
                    {t("submissions.reviewForm.requestChanges")}
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
                  {t("submissions.detail.cancelSchedule")}
                </Button>
              )}
            <p className="text-sm">
              <Link
                to={contentHref(selected)}
                className="font-medium text-primary hover:underline"
              >
                {t("submissions.detail.openContent")}
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
            <DialogTitle>{t("submissions.rejectDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("submissions.rejectDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="submission-reject-note">
              {t("submissions.rejectDialog.reasonLabel")}
            </FieldLabel>
            <Textarea
              id="submission-reject-note"
              rows={3}
              value={rejectNote}
              placeholder={t("submissions.rejectDialog.reasonPlaceholder")}
              onChange={(event) => setRejectNote(event.target.value)}
            />
            <FieldDescription>
              {t("submissions.rejectDialog.reasonHint")}
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
              {t("common:actions.cancel")}
            </Button>
            <Button
              disabled={requestChanges.isPending || !rejectNote.trim()}
              onClick={() => {
                if (rejectItem) requestChanges.mutate(rejectItem);
              }}
            >
              <Undo2 size={15} aria-hidden="true" />{" "}
              {t("submissions.rejectDialog.confirm")}
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
  const { t } = useTranslation("review");
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled} onClick={publish}>
          <Send size={15} aria-hidden="true" />{" "}
          {t("submissions.publish.publishNow")}
        </Button>
      </div>
      <Field>
        <FieldLabel htmlFor="submission-publish-at">
          {t("submissions.publish.publishAtLabel")}
        </FieldLabel>
        <DateTimeInput
          id="submission-publish-at"
          aria-label="Publish at"
          timeLabel="Publication time"
          value={schedule}
          onChange={onSchedule}
        />
        <FieldDescription>
          {t("submissions.publish.publishAtHint")}
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={disabled || !schedule}
          onClick={schedulePublication}
        >
          <Clock3 size={15} aria-hidden="true" />{" "}
          {t("submissions.publish.schedule")}
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

function submissionMeta(
  t: TFunction<"review">,
  item: ContentSubmission,
  submittedAt: string,
): string {
  if (item.submitterName) {
    return t("submissions.itemMetaWithSubmitter", {
      revision: item.workingRevision,
      submittedAt,
      submitter: item.submitterName,
    });
  }
  return t("submissions.itemMeta", {
    revision: item.workingRevision,
    submittedAt,
  });
}

function SubmissionBadge({ status }: { status: SubmissionStatus }) {
  const { t } = useTranslation("review");
  const variant =
    status === "published"
      ? "default"
      : status === "publication_failed" || status === "changes_requested"
        ? "destructive"
        : status === "approved" || status === "scheduled"
          ? "secondary"
          : "outline";
  return <Badge variant={variant}>{t(statusKeys[status])}</Badge>;
}
