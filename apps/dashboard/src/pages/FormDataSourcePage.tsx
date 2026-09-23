import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useSearchParams } from "react-router";
import type {
  DataSourceDetail,
  FormDataSource,
  FormRecordListParams,
} from "../api/types";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import {
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  PageHeader,
  Pagination,
  Select,
  Spinner,
  StatusBadge,
  TableContainer,
  Textarea,
  ViewTabs,
} from "../components/legacy-ui";
import { FormBuilder } from "../forms/FormBuilder";
import { FormRenderer } from "../forms/FormRenderer";
import { RecordReview } from "../forms/RecordReview";
import { WorkflowEditor } from "../forms/WorkflowEditor";
import { ViewsEditor } from "../forms/ViewsEditor";
import { OutputsPanel } from "../forms/OutputsPanel";
import { AccessPanel } from "../forms/AccessPanel";
import { canManageForm, canViewResponses } from "../forms/capabilities";
import { stateLabel, stateTone } from "../forms/formStatus";

type TabValue =
  "responses" | "form" | "workflow" | "views" | "outputs" | "access";

export function FormDataSourcePage({
  dataSource,
}: {
  dataSource?: DataSourceDetail;
}) {
  const { id } = useParams();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const [searchParams, setSearchParams] = useSearchParams();

  const form = useQuery({
    queryKey: ["form-data-source", id],
    queryFn: () => api.getForm(id!),
    enabled: Boolean(id),
  });

  const detail = form.data;
  const canManage = canManageForm(detail?.grantedCapabilities ?? []);
  const canViewAll = canViewResponses(detail?.grantedCapabilities ?? []);

  // Order is also used to choose the closest permitted fallback for an unauthorized tab.
  const tabDefs: { value: TabValue; label: string; permitted: boolean }[] = [
    { value: "responses", label: "Responses", permitted: canViewAll },
    { value: "form", label: "Form", permitted: true },
    { value: "workflow", label: "Workflow", permitted: canManage },
    { value: "views", label: "Views", permitted: canManage },
    { value: "outputs", label: "Outputs", permitted: canViewAll || canManage },
    { value: "access", label: "Access", permitted: canManage },
  ];
  const permittedTabs = tabDefs.filter((tab) => tab.permitted);
  const recordParam = searchParams.get("record");
  const tabParam = searchParams.get("tab");
  const requestedTab = recordParam && canViewAll ? "responses" : tabParam;
  const matchedIndex = tabDefs.findIndex((tab) => tab.value === requestedTab);
  const requestedIndex =
    matchedIndex >= 0
      ? matchedIndex
      : tabDefs.findIndex((tab) => tab.value === "form");
  const activeTab = permittedTabs.reduce<{
    value: TabValue;
    distance: number;
  }>(
    (closest, tab) => {
      const distance = Math.abs(
        tabDefs.findIndex((candidate) => candidate.value === tab.value) -
          requestedIndex,
      );
      return distance < closest.distance
        ? { value: tab.value, distance }
        : closest;
    },
    { value: "form", distance: Number.POSITIVE_INFINITY },
  ).value;

  // Render and URL must agree: replace invalid/unauthorized tabs and drop record deep links when
  // Responses is unavailable. This also prevents stale parameters from surviving copied URLs.
  useEffect(() => {
    if (!detail) return;
    const staleRecord = Boolean(recordParam) && !canViewAll;
    const staleTab = tabParam !== null && tabParam !== activeTab;
    const recordForcesResponses =
      Boolean(recordParam) && canViewAll && tabParam !== "responses";
    if (!staleRecord && !staleTab && !recordForcesResponses) return;
    const next = new URLSearchParams(searchParams);
    next.set("tab", activeTab);
    if (staleRecord) next.delete("record");
    setSearchParams(next, { replace: true });
  }, [
    activeTab,
    canViewAll,
    detail,
    recordParam,
    searchParams,
    setSearchParams,
    tabParam,
  ]);

  if (form.isLoading) {
    return <div className="table-loading">Loading form…</div>;
  }
  if (!detail || !id) {
    return (
      <Notice variant="danger" title="Form unavailable">
        This form could not be loaded.
      </Notice>
    );
  }

  // Permitted tabs by capability (grantedCapabilities, never global role). Form is always available
  // (read-only for non-managers); Workflow/Views/Access require manage; Outputs needs view_all or
  // manage; Responses needs view_all. Order defines display and the normalization fallback.
  const setTab = (tab: TabValue) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    if (tab !== "responses") next.delete("record");
    setSearchParams(next, { replace: true });
  };

  return (
    <section className="app-editor-route form-page">
      <PageHeader
        eyebrow="Forms plugin"
        title={dataSource?.name ?? detail.name}
        description={dataSource?.description ?? detail.description}
      />

      <ViewTabs<TabValue>
        label="Form sections"
        value={activeTab}
        items={permittedTabs.map((tab) => ({
          value: tab.value,
          label: tab.label,
        }))}
        onValueChange={setTab}
      />

      {activeTab === "responses" ? (
        <ResponsesTab
          form={detail}
          csrf={csrf}
          selectedRecordId={recordParam}
          onSelectRecord={(recordId) => {
            const next = new URLSearchParams(searchParams);
            next.set("tab", "responses");
            if (recordId) next.set("record", recordId);
            else next.delete("record");
            setSearchParams(next, { replace: true });
          }}
        />
      ) : activeTab === "workflow" ? (
        <WorkflowEditor form={detail} csrf={csrf} />
      ) : activeTab === "views" ? (
        <ViewsEditor form={detail} csrf={csrf} />
      ) : activeTab === "outputs" ? (
        <OutputsPanel form={detail} csrf={csrf} canManage={canManage} />
      ) : activeTab === "access" ? (
        <AccessPanel form={detail} csrf={csrf} />
      ) : canManage ? (
        <ManageView form={detail} csrf={csrf} />
      ) : (
        <ReadOnlyView form={detail} />
      )}
    </section>
  );
}

// --- Responses tab ---

const PAGE_SIZE = 25;

function ResponsesTab({
  form,
  csrf,
  selectedRecordId,
  onSelectRecord,
}: {
  form: FormDataSource;
  csrf: string;
  selectedRecordId: string | null;
  onSelectRecord: (recordId: string | null) => void;
}) {
  const [stateFilter, setStateFilter] = useState<string>("needs_review");
  const [search, setSearch] = useState("");
  const [sort, setSort] =
    useState<NonNullable<FormRecordListParams["sort"]>>("updated");
  const [page, setPage] = useState(1);

  // States that carry an outstanding review/approve decision, derived from the workflow.
  const needsReviewStates = useMemo(
    () =>
      Array.from(
        new Set(
          form.workflow.transitions
            .filter(
              (t) =>
                t.requiredCapability === "review" ||
                t.requiredCapability === "approve",
            )
            .map((t) => t.from),
        ),
      ),
    [form.workflow],
  );

  const states =
    stateFilter === "all"
      ? undefined
      : stateFilter === "needs_review"
        ? needsReviewStates
        : [stateFilter];

  const records = useQuery({
    queryKey: ["form-records", form.id, { stateFilter, search, sort, page }],
    queryFn: () =>
      api.listFormRecords(form.id, {
        states,
        search: search.trim() || undefined,
        sort,
        page,
        pageSize: PAGE_SIZE,
      }),
  });

  if (selectedRecordId) {
    return (
      <div className="responses-tab responses-tab--detail">
        <Button variant="quiet" compact onClick={() => onSelectRecord(null)}>
          ← Back to responses
        </Button>
        <RecordReview
          form={form}
          recordId={selectedRecordId}
          csrf={csrf}
          onAfterTransition={() => void records.refetch()}
        />
      </div>
    );
  }

  const total = records.data?.total ?? 0;
  const items = records.data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="responses-tab">
      <div className="responses-tab__filters">
        <Field label="State">
          <Select
            value={stateFilter}
            onChange={(event) => {
              setStateFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="needs_review">Needs review</option>
            <option value="all">All states</option>
            {form.workflow.states.map((state) => (
              <option key={state.key} value={state.key}>
                {state.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Search">
          <Input
            value={search}
            placeholder="Title or submitter"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label="Sort">
          <Select
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <option value="updated">Recently updated</option>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="priority">Priority</option>
          </Select>
        </Field>
      </div>

      {records.isError && (
        <Notice variant="danger" title="Could not load responses">
          {records.error instanceof Error
            ? records.error.message
            : "Please try again."}
        </Notice>
      )}

      {records.isLoading ? (
        <Spinner label="Loading responses…" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No responses"
          message={
            stateFilter === "needs_review"
              ? "Nothing is waiting for review right now."
              : "No submissions match these filters yet."
          }
        />
      ) : (
        <>
          <TableContainer>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Submission</th>
                  <th scope="col">Submitter</th>
                  <th scope="col">State</th>
                  <th scope="col">Priority</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Display window</th>
                </tr>
              </thead>
              <tbody>
                {items.map((record) => (
                  <tr
                    key={record.id}
                    className="data-table__row--clickable"
                    tabIndex={0}
                    role="button"
                    onClick={() => onSelectRecord(record.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectRecord(record.id);
                      }
                    }}
                  >
                    <td>{record.displayTitle || "Untitled submission"}</td>
                    <td>{record.submitterName || "Unknown"}</td>
                    <td>
                      <StatusBadge
                        label={stateLabel(form.workflow, record.state)}
                        tone={stateTone(form.workflow, record.state)}
                      />
                    </td>
                    <td>{record.priority}</td>
                    <td>{new Date(record.updatedAt).toLocaleString()}</td>
                    <td>{displayWindow(record.displayAt, record.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableContainer>
          <Pagination
            label="Responses pages"
            status={`Page ${page} of ${totalPages} · ${total} total`}
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

// --- Form tab (builder / read-only) ---

function ManageView({ form, csrf }: { form: FormDataSource; csrf: string }) {
  return (
    <div className="form-page__body">
      <MetadataEditor form={form} csrf={csrf} />
      <FormBuilder form={form} csrf={csrf} />
    </div>
  );
}

function MetadataEditor({
  form,
  csrf,
}: {
  form: FormDataSource;
  csrf: string;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(form.name);
  const [description, setDescription] = useState(form.description);
  const [error, setError] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.updateFormMetadata(
        form.id,
        { name: name.trim(), description: description.trim() },
        csrf,
      ),
    onMutate: () => setError(""),
    onSuccess: (updated) => {
      // Sync local editor state to the saved values so reopening Edit details shows the latest.
      setName(updated.name);
      setDescription(updated.description);
      void queryClient.invalidateQueries({
        queryKey: ["form-data-source", form.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["data-source", form.id],
      });
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      setEditing(false);
    },
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : "Could not update details.",
      ),
  });

  if (!editing) {
    return (
      <div className="form-page__details">
        <div>
          <h2 className="form-page__details-name">{form.name}</h2>
          {form.description && (
            <p className="form-page__details-description">{form.description}</p>
          )}
        </div>
        <Button variant="secondary" compact onClick={() => setEditing(true)}>
          Edit details
        </Button>
      </div>
    );
  }

  return (
    <div className="form-page__details form-page__details--editing">
      {error && (
        <Notice variant="danger" title="Details not saved">
          {error}
        </Notice>
      )}
      <Field label="Form name" required>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label="Description">
        <Textarea
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <div className="form-page__details-actions">
        <Button
          variant="quiet"
          onClick={() => {
            setName(form.name);
            setDescription(form.description);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={name.trim() === "" || save.isPending}
          onClick={() => {
            if (!save.isPending) {
              save.mutate();
            }
          }}
        >
          Save details
        </Button>
      </div>
    </div>
  );
}

function ReadOnlyView({ form }: { form: FormDataSource }) {
  const revision = form.publishedRevision;
  return (
    <div className="form-page__body form-page__body--readonly">
      <Notice variant="neutral" title="Read-only">
        You can view this form but do not have permission to edit it.
      </Notice>
      {revision && (
        <p className="form-page__revision">
          Published revision {revision.revisionNumber} ·{" "}
          {new Date(revision.publishedAt).toLocaleString()}
        </p>
      )}
      <FormRenderer schema={form.draftSchema} readOnly />
    </div>
  );
}
