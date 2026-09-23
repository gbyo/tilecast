import { useMemo, useState } from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Check, Inbox, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api/client";
import type { ContentReviewItem, ContentReviewState } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ViewTabs } from "../components/ViewTabs";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
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

const stateLabels: Record<ContentReviewState, string> = {
  pending: "Waiting for review",
  approved: "Approved",
  rejected: "Sent back",
};

const features = tableFeatures({});
const columnHelper = createColumnHelper<typeof features, ContentReviewItem>();

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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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
      if (selectedKey === key(input.item)) setSelectedKey(null);
      if (rejectKey === key(input.item)) {
        setRejectKey(null);
        setRejectNote("");
      }
      toast.success(input.approve ? "Content approved." : "Content sent back.");
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Could not record the decision.",
      ),
  });

  const items = queue.data?.items ?? [];
  const selected = items.find((item) => key(item) === selectedKey) ?? null;
  const rejectItem = items.find((item) => key(item) === rejectKey) ?? null;

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "content",
          header: "Content",
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
                  {item.contentType === "playlist" ? "Playlist" : "Layout"} ·
                  revision {item.revision}
                  {item.authorName ? ` · ${item.authorName}` : ""} · updated{" "}
                  {new Date(item.updatedAt).toLocaleString()}
                </span>
              </div>
            );
          },
        }),
        columnHelper.display({
          id: "state",
          header: "State",
          cell: ({ row }) => (
            <Badge variant={badgeVariant(row.original.state)}>
              {stateLabels[row.original.state]}
            </Badge>
          ),
        }),
        columnHelper.display({
          id: "screens",
          header: "On screens",
          cell: ({ row }) =>
            row.original.assignedScreens > 0 ? (
              <strong>
                Already on {row.original.assignedScreens} screen
                {row.original.assignedScreens === 1 ? "" : "s"}
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
                  <RheaButton
                    variant="secondary"
                    size="sm"
                    onClick={() => setSelectedKey(key(row.original))}
                  >
                    Review
                  </RheaButton>
                ),
              }),
            ]
          : []),
      ]),
    [canDecide],
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

      <ViewTabs
        label="Review state"
        value={filter}
        items={[
          { value: "pending", label: stateLabels.pending },
          { value: "approved", label: stateLabels.approved },
          { value: "rejected", label: stateLabels.rejected },
          { value: "", label: "All" },
        ]}
        onValueChange={setFilter}
      />

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
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedKey(null);
        }}
      >
        {selected && (
          <SheetContent className="grid gap-4 overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{selected.name}</SheetTitle>
              <SheetDescription>
                {selected.contentType === "playlist" ? "Playlist" : "Layout"} ·
                revision {selected.revision}
                {selected.authorName ? ` · ${selected.authorName}` : ""} ·
                updated {new Date(selected.updatedAt).toLocaleString()}
              </SheetDescription>
            </SheetHeader>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={badgeVariant(selected.state)}>
                {stateLabels[selected.state]}
              </Badge>
              {selected.assignedScreens > 0 && (
                <strong>
                  Already on {selected.assignedScreens} screen
                  {selected.assignedScreens === 1 ? "" : "s"}
                </strong>
              )}
            </p>
            {selected.lastNote && (
              <p className="text-sm text-muted-foreground">
                Last note: {selected.lastNote}
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
                Open{" "}
                {selected.contentType === "playlist" ? "playlist" : "layout"}
              </Link>
            </p>
            {canDecide && (
              <div className="flex flex-wrap gap-2">
                <RheaButton
                  type="button"
                  disabled={decide.isPending || selected.state === "approved"}
                  onClick={() =>
                    decide.mutate({ item: selected, approve: true })
                  }
                >
                  <Check size={15} aria-hidden="true" /> Approve
                </RheaButton>
                <RheaButton
                  type="button"
                  variant="secondary"
                  disabled={decide.isPending}
                  onClick={() => {
                    setRejectKey(key(selected));
                    setRejectNote("");
                  }}
                >
                  <Undo2 size={15} aria-hidden="true" /> Send back
                </RheaButton>
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
            <DialogTitle>Send back for changes</DialogTitle>
            <DialogDescription>
              An optional note tells the author what to fix.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="content-review-reject-note">Note</FieldLabel>
            <Textarea
              id="content-review-reject-note"
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
            <RheaButton
              variant="ghost"
              disabled={decide.isPending}
              onClick={() => {
                setRejectKey(null);
                setRejectNote("");
              }}
            >
              Cancel
            </RheaButton>
            <RheaButton
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
              <Undo2 size={15} aria-hidden="true" /> Send back
            </RheaButton>
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
