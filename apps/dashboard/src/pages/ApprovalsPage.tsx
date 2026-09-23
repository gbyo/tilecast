import { useMemo, useState } from "react";
import {
  createColumnHelper,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link } from "react-router";
import { ClipboardCheck } from "lucide-react";
import { api } from "../api/client";
import type { FormApprovalItem } from "../api/types";
import { Pagination } from "../components/Pagination";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { Skeleton } from "../components/ui/skeleton";

const PAGE_SIZE = 25;

const features = tableFeatures({});
const columnHelper = createColumnHelper<typeof features, FormApprovalItem>();

// ApprovalsPage is the central inbox of submissions awaiting a decision across every form the user
// may review, approve, or manage. Opening an item routes to the shared record review in the form's
// Responses tab. Items leave the inbox automatically once they are no longer pending.
export function ApprovalsPage() {
  const { t } = useTranslation(["review", "common"]);
  const [page, setPage] = useState(1);
  const approvals = useQuery({
    queryKey: ["approvals", page],
    queryFn: () => api.listApprovals({ page, pageSize: PAGE_SIZE }),
  });

  const total = approvals.data?.total ?? 0;
  const items = approvals.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.display({
          id: "form",
          header: t("approvals.table.form"),
          cell: ({ row }) => row.original.formName,
        }),
        columnHelper.display({
          id: "submission",
          header: t("approvals.table.submission"),
          cell: ({ row }) => {
            const item = row.original;
            return (
              <Link
                to={recordHref(item.dataSourceId, item.recordId)}
                className="font-medium text-primary hover:underline"
              >
                {item.title || t("approvals.untitledSubmission")}
              </Link>
            );
          },
        }),
        columnHelper.display({
          id: "submitter",
          header: t("approvals.table.submitter"),
          cell: ({ row }) =>
            row.original.submitterName || t("approvals.unknownSubmitter"),
        }),
        columnHelper.display({
          id: "state",
          header: t("approvals.table.state"),
          cell: ({ row }) => (
            <Badge variant="secondary">{row.original.stateLabel}</Badge>
          ),
        }),
        columnHelper.display({
          id: "submitted",
          header: t("approvals.table.submitted"),
          cell: ({ row }) => (
            <span className="whitespace-nowrap tabular-nums">
              {new Date(row.original.submittedAt).toLocaleString()}
            </span>
          ),
        }),
        columnHelper.display({
          id: "window",
          header: t("approvals.table.displayWindow"),
          cell: ({ row }) => (
            <span className="whitespace-nowrap">
              {displayWindow(t, row.original.displayAt, row.original.expiresAt)}
            </span>
          ),
        }),
        columnHelper.display({
          id: "review",
          header: "",
          cell: ({ row }) => {
            const item = row.original;
            return (
              <Link
                to={recordHref(item.dataSourceId, item.recordId)}
                aria-label={t("approvals.reviewActionLabel", {
                  title: item.title || t("approvals.untitledSubmissionInline"),
                  formName: item.formName,
                })}
                className="font-medium text-primary hover:underline"
              >
                {t("approvals.table.reviewAction")}
              </Link>
            );
          },
        }),
      ]),
    [t],
  );
  const table = useTable({
    features,
    columns,
    data: items,
    getRowId: (row) => row.recordId,
  });

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("approvals.eyebrow")}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("approvals.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("approvals.description")}
        </p>
      </header>

      {approvals.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t("approvals.loadErrorTitle")}</AlertTitle>
          <AlertDescription>
            {approvals.error instanceof Error
              ? approvals.error.message
              : t("approvals.loadErrorFallback")}
          </AlertDescription>
        </Alert>
      )}

      {approvals.isLoading ? (
        <div className="grid gap-2" aria-label={t("approvals.loading")}>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardCheck size={28} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("approvals.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("approvals.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
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
          <Pagination
            label={t("approvals.paginationLabel")}
            status={t("approvals.paginationStatus", {
              page,
              totalPages,
              total,
            })}
            previous={() => setPage((current) => Math.max(1, current - 1))}
            next={() => setPage((current) => Math.min(totalPages, current + 1))}
            previousDisabled={page <= 1}
            nextDisabled={page >= totalPages}
          />
        </>
      )}
    </div>
  );
}

function recordHref(formId: string, recordId: string) {
  return `/data-sources/${formId}?tab=responses&record=${recordId}`;
}

function displayWindow(
  t: TFunction<"review">,
  displayAt: string | null | undefined,
  expiresAt: string | null | undefined,
): string {
  const start = displayAt ? new Date(displayAt).toLocaleDateString() : null;
  const end = expiresAt ? new Date(expiresAt).toLocaleDateString() : null;
  if (!start && !end) return "—";
  return t("approvals.displayWindow.range", {
    start: start ?? t("approvals.displayWindow.now"),
    end: end ?? "∞",
  });
}
