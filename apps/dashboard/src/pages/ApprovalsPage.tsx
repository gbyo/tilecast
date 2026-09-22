import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { Button } from "@react-spectrum/s2/Button";
import { ButtonGroup } from "@react-spectrum/s2/ButtonGroup";
import { Cell, Column, Row, TableBody, TableHeader, TableView } from "@react-spectrum/s2/TableView";
import { Heading } from "@react-spectrum/s2/Heading";
import { IllustratedMessage } from "@react-spectrum/s2/IllustratedMessage";
import { InlineAlert } from "@react-spectrum/s2/InlineAlert";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { Text } from "@react-spectrum/s2/Text";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };

const PAGE_SIZE = 25;
const approvalsTableStyles = style({ height: 560, minHeight: 320, width: "full" });

// ApprovalsPage is the central inbox of submissions awaiting a decision across every form the user
// may review, approve, or manage. Opening an item routes to the shared record review in the form's
// Responses tab. Items leave the inbox automatically once they are no longer pending.
export function ApprovalsPage() {
  const [page, setPage] = useState(1);
  const approvals = useQuery({
    queryKey: ["approvals", page],
    queryFn: () => api.listApprovals({ page, pageSize: PAGE_SIZE }),
  });

  const total = approvals.data?.total ?? 0;
  const items = approvals.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="approvals-page">
      <header>
        <Heading level={1}>Approvals</Heading>
        <Text>Submissions awaiting a review decision across your forms.</Text>
      </header>

      {approvals.isError && (
        <InlineAlert variant="negative" fillStyle="subtleFill">
          <Heading level={2}>Could not load approvals</Heading>
          <Text>{approvals.error instanceof Error ? approvals.error.message : "Please try again."}</Text>
        </InlineAlert>
      )}

      <TableView
        aria-label="Submissions awaiting approval"
        density={document.documentElement.dataset.density === "compact" ? "compact" : "regular"}
        styles={approvalsTableStyles}
        loadingState={approvals.isLoading ? "loading" : undefined}
      >
        <TableHeader>
          <Column isRowHeader>Form</Column>
          <Column>Submission</Column>
          <Column>Submitter</Column>
          <Column>State</Column>
          <Column>Submitted</Column>
          <Column>Display window</Column>
        </TableHeader>
        <TableBody
          items={items}
          renderEmptyState={() => (
            <IllustratedMessage>
              <Heading level={2}>Nothing to review</Heading>
              <Text>There are no submissions awaiting your decision right now.</Text>
            </IllustratedMessage>
          )}
        >
          {(item) => (
            <Row
              id={item.recordId}
              href={`/data-sources/${item.dataSourceId}?tab=responses&record=${item.recordId}`}
            >
              <Cell>{item.formName}</Cell>
              <Cell>{item.title || "Untitled submission"}</Cell>
              <Cell>{item.submitterName || "Unknown"}</Cell>
              <Cell><StatusLight variant="informative">{item.stateLabel}</StatusLight></Cell>
              <Cell>{new Date(item.submittedAt).toLocaleString()}</Cell>
              <Cell>{displayWindow(item.displayAt, item.expiresAt)}</Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
      <footer>
        <Text>{`Page ${page} of ${totalPages} · ${total} pending`}</Text>
        <ButtonGroup>
          <Button
            variant="secondary"
            isDisabled={page <= 1}
            onPress={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            isDisabled={page >= totalPages}
            onPress={() => setPage((current) => Math.min(totalPages, current + 1))}
          >
            Next
          </Button>
        </ButtonGroup>
      </footer>
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
