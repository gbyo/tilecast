import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { ClipboardCheck } from "lucide-react";
import { api } from "../api/client";
import {
  EmptyState,
  Notice,
  PageHeader,
  Pagination,
  Spinner,
  StatusBadge,
  TableContainer,
} from "../components/legacy-ui";

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
    <div className="approvals-page">
      <PageHeader
        eyebrow="Forms"
        title="Approvals"
        description="Submissions awaiting a review decision across your forms."
      />

      {approvals.isError && (
        <Notice variant="danger" title="Could not load approvals">
          {approvals.error instanceof Error
            ? approvals.error.message
            : "Please try again."}
        </Notice>
      )}

      {approvals.isLoading ? (
        <Spinner label="Loading approvals…" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck size={28} aria-hidden="true" />}
          title="Nothing to review"
          message="There are no submissions awaiting your decision right now."
        />
      ) : (
        <>
          <TableContainer>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Form</th>
                  <th scope="col">Submission</th>
                  <th scope="col">Submitter</th>
                  <th scope="col">State</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Display window</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.recordId}
                    className="data-table__row--clickable"
                    tabIndex={0}
                    role="button"
                    onClick={() => openRecord(item.dataSourceId, item.recordId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openRecord(item.dataSourceId, item.recordId);
                      }
                    }}
                  >
                    <td>{item.formName}</td>
                    <td>{item.title || "Untitled submission"}</td>
                    <td>{item.submitterName || "Unknown"}</td>
                    <td>
                      <StatusBadge label={item.stateLabel} tone="info" />
                    </td>
                    <td>{new Date(item.submittedAt).toLocaleString()}</td>
                    <td>{displayWindow(item.displayAt, item.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
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
