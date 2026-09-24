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
import { Check, Inbox, Undo2 } from "lucide-react";
import { toast } from "../components/ui/toast";
import { api } from "../api/client";
import type { ContentReviewItem, ContentReviewState } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ViewTabs } from "../components/ViewTabs";
import { Alert, AlertDescription } from "../components/ui/alert";
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
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";

const stateLabelKeys = {
  pending: "contentReview.state.pending",
  approved: "contentReview.state.approved",
  rejected: "contentReview.state.rejected",
} as const;

const features = tableFeatures({});
const columnHelper = createColumnHelper<typeof features, ContentReviewItem>();

// Review has no submit step. Content is pending whenever its current revision
// has no decision, so editing approved content puts it back in this queue by
// itself. That is worth stating on the page: a reviewer who does not know it
// will wonder why something they approved is here again.
export function ContentReviewPage() {
  const { t } = useTranslation(["review", "common"]);
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const role = auth.status?.user?.role ?? "viewer";
  const canDecide = ["owner", "administrator", "editor"].includes(role);

  const [filter, setFilter] = useState<ContentReviewState | "">("pending");
  const [selected, setSelected] = useState<ContentReviewItem | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [rejectKey, setRejectKey] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const queue = useQuery({
    queryKey: ["content-reviews", filter],
    queryFn: () => api.contentReviews(filter),
  });

  const decide = useMutation({
    mutationFn: (input: {
      item: ContentReviewItem;
      approve: boolean;
      note?: string;
    }) =>
      api.decideContentReview(
        input.item.contentType,
        input.item.contentId,
        {
          approve: input.approve,
          note: input.note ?? "",
          revision: input.item.revision,
        },
        csrf,
      ),
    onSuccess: (_data, input) => {
      void client.invalidateQueries({ queryKey: ["content-reviews"] });
      if (selected && key(selected) === key(input.item)) setDetailsOpen(false);
      if (rejectKey === key(input.item)) {
        setRejectKey(null);
        setRejectNote("");
      }
      toast.add({
        title: input.approve
          ? t("contentReview.toast.approved")
          : t("contentReview.toast.sentBack"),
        type: "success",
      });
    },
    onError: (err) =>
      toast.add({
        title:
          err instanceof Error
            ? err.message
            : t("contentReview.toast.decisionFailed"),
        type: "error",
      }),
  });

  const items = queue.data?.items ?? [];
  const rejectItem = items.find((item) => key(item) === rejectKey) ?? null;

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "content",
          header: t("contentReview.table.content"),
          cell: ({ row }) => {
            const item = row.original;
            return (
              <div className="grid min-w-0 gap-0.5">
                <Link
                  to={
                    item.contentType === "playlist"
                      ? `/playlists/${item.contentId}`
                      : `/layouts/${item.contentId}`
                  }
                  className="truncate font-medium text-primary hover:underline"
                >
                  {item.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {itemMeta(t, item, new Date(item.updatedAt).toLocaleString())}
                </span>
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "state",
          header: t("contentReview.table.state"),
          cell: ({ row }) => (
            <Badge variant={badgeVariant(row.original.state)}>
              {t(stateLabelKeys[row.original.state])}
            </Badge>
          ),
        }),
        columnHelper.display({
          id: "screens",
          header: t("contentReview.table.screens"),
          cell: ({ row }) =>
            row.original.assignedScreens > 0 ? (
              <strong>
                {t("contentReview.assignedScreens", {
                  count: row.original.assignedScreens,
                })}
              </strong>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
        }),
        ...(canDecide
          ? [
              columnHelper.display({
                id: "review",
                header: "",
                cell: ({ row }) => (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSelected(row.original);
                      setDetailsOpen(true);
                    }}
                  >
                    {t("contentReview.table.reviewAction")}
                  </Button>
                ),
              }),
            ]
          : []),
      ]),
    [canDecide, t],
  );
  const table = useTable({
    features,
    columns,
    data: items,
    getRowId: (row) => key(row),
  });

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("contentReview.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("contentReview.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            className={buttonVariants({ variant: "outline" })}
            to="/content-review/submissions"
          >
            {t("contentReview.openInbox")}
          </Link>
        </div>
      </header>

      {queue.data && !queue.data.required && (
        <Alert>
          <AlertDescription>
            <Trans
              i18nKey="contentReview.notRequiredNotice"
              ns="review"
              components={{
                settingsLink: (
                  <Link
                    to="/settings/content-review"
                    className="font-medium text-primary hover:underline"
                  />
                ),
              }}
            />
          </AlertDescription>
        </Alert>
      )}

      <ViewTabs
        label={t("contentReview.filterLabel")}
        value={filter}
        items={[
          { value: "pending", label: t(stateLabelKeys.pending) },
          { value: "approved", label: t(stateLabelKeys.approved) },
          { value: "rejected", label: t(stateLabelKeys.rejected) },
          { value: "", label: t("contentReview.filterAll") },
        ]}
        onValueChange={setFilter}
      />

      {queue.isLoading ? (
        <div className="grid gap-2" aria-label={t("contentReview.loading")}>
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
                ? t("contentReview.emptyPending")
                : t("contentReview.emptyOther")}
            </EmptyTitle>
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

      {decide.error && (
        <Alert variant="destructive">
          <AlertDescription>{decide.error.message}</AlertDescription>
        </Alert>
      )}

      <Sheet
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        onOpenChangeComplete={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <SheetContent className="grid gap-4 overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{selected.name}</SheetTitle>
              <SheetDescription>
                {itemMeta(
                  t,
                  selected,
                  new Date(selected.updatedAt).toLocaleString(),
                )}
              </SheetDescription>
            </SheetHeader>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={badgeVariant(selected.state)}>
                {t(stateLabelKeys[selected.state])}
              </Badge>
              {selected.assignedScreens > 0 && (
                <strong>
                  {t("contentReview.assignedScreens", {
                    count: selected.assignedScreens,
                  })}
                </strong>
              )}
            </p>
            {selected.lastNote && (
              <p className="text-sm text-muted-foreground">
                {t("contentReview.sheet.lastNote", {
                  note: selected.lastNote,
                })}
              </p>
            )}
            <p className="text-sm">
              <Link
                to={
                  selected.contentType === "playlist"
                    ? `/playlists/${selected.contentId}`
                    : `/layouts/${selected.contentId}`
                }
                className="font-medium text-primary hover:underline"
              >
                {t("contentReview.sheet.openContent", {
                  type: t(
                    selected.contentType === "playlist"
                      ? "contentReview.contentTypeName.playlist"
                      : "contentReview.contentTypeName.layout",
                  ),
                })}
              </Link>
            </p>
            {canDecide && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={decide.isPending || selected.state === "approved"}
                  onClick={() =>
                    decide.mutate({ item: selected, approve: true })
                  }
                >
                  <Check size={15} aria-hidden="true" />{" "}
                  {t("contentReview.actions.approve")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={decide.isPending}
                  onClick={() => {
                    setRejectKey(key(selected));
                    setRejectNote("");
                  }}
                >
                  <Undo2 size={15} aria-hidden="true" />{" "}
                  {t("contentReview.actions.sendBack")}
                </Button>
              </div>
            )}
          </SheetContent>
        )}
      </Sheet>

      <Dialog
        open={rejectItem !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRejectKey(null);
            setRejectNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("contentReview.rejectDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("contentReview.rejectDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="content-review-reject-note">
              {t("contentReview.rejectDialog.noteLabel")}
            </FieldLabel>
            <Textarea
              id="content-review-reject-note"
              rows={3}
              value={rejectNote}
              placeholder={t("contentReview.rejectDialog.notePlaceholder")}
              onChange={(event) => setRejectNote(event.target.value)}
            />
            <FieldDescription>
              {t("contentReview.rejectDialog.noteHint")}
            </FieldDescription>
          </Field>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={decide.isPending}
              onClick={() => {
                setRejectKey(null);
                setRejectNote("");
              }}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              disabled={decide.isPending}
              onClick={() => {
                if (rejectItem)
                  decide.mutate({
                    item: rejectItem,
                    approve: false,
                    note: rejectNote,
                  });
              }}
            >
              <Undo2 size={15} aria-hidden="true" />{" "}
              {t("contentReview.actions.sendBack")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

function itemMeta(
  t: TFunction<"review">,
  item: ContentReviewItem,
  updatedAt: string,
): string {
  const type = t(
    item.contentType === "playlist"
      ? "contentReview.contentType.playlist"
      : "contentReview.contentType.layout",
  );
  if (item.authorName) {
    return t("contentReview.itemMetaWithAuthor", {
      type,
      revision: item.revision,
      author: item.authorName,
      updatedAt,
    });
  }
  return t("contentReview.itemMeta", {
    type,
    revision: item.revision,
    updatedAt,
  });
}
