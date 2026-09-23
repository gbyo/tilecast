import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ClipboardCheck } from "lucide-react";
import { api } from "../api/client";
import { Pagination } from "../components/legacy-ui";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";

const PAGE_SIZE = 25;

// ApprovalsPage is the central inbox of submissions awaiting a decision across every form the user
// may review, approve, or manage. Opening an item routes to the shared record review in the form's
// Responses tab. Items leave the inbox automatically once they are no longer pending.
export function ApprovalsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const approvals = useQuery({
    queryKey: ["approvals", page],
    queryFn: () => api.listApprovals({ page, pageSize: PAGE_SIZE }),
  });

  const openRecord = (formId: string, recordId: string) => {
    void navigate(`/data-sources/${formId}?tab=responses&record=${recordId}`);
  };

  const total = approvals.data?.total ?? 0;
  const items = approvals.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="grid gap-4">
      <header className="grid gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Forms
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-muted-foreground">
          Submissions awaiting a review decision across your forms.
        </p>
      </header>

      {approvals.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load approvals</AlertTitle>
          <AlertDescription>
            {approvals.error instanceof Error
              ? approvals.error.message
              : "Please try again."}
          </AlertDescription>
        </Alert>
      )}

      {approvals.isLoading ? (
        <div className="grid gap-2" aria-label="Loading approvals">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardCheck size={28} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Nothing to review</EmptyTitle>
            <EmptyDescription>
              There are no submissions awaiting your decision right now.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Form
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Submission
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Submitter
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    State
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Submitted
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Display window
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.recordId}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-muted"
                    tabIndex={0}
                    role="button"
                    aria-label={`Review ${item.title || "untitled submission"} from ${item.formName}`}
                    onClick={() => openRecord(item.dataSourceId, item.recordId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openRecord(item.dataSourceId, item.recordId);
                      }
                    }}
                  >
                    <td className="px-3 py-2">{item.formName}</td>
                    <td className="px-3 py-2">
                      {item.title || "Untitled submission"}
                    </td>
                    <td className="px-3 py-2">
                      {item.submitterName || "Unknown"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary">{item.stateLabel}</Badge>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {new Date(item.submittedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {displayWindow(item.displayAt, item.expiresAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            label="Approvals pages"
            status={`Page ${page} of ${totalPages} · ${total} pending`}
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

function displayWindow(
  displayAt: string | null | undefined,
  expiresAt: string | null | undefined,
): string {
  const start = displayAt ? new Date(displayAt).toLocaleDateString() : null;
  const end = expiresAt ? new Date(expiresAt).toLocaleDateString() : null;
  if (!start && !end) return "—";
  return `${start ?? "now"} → ${end ?? "∞"}`;
}
