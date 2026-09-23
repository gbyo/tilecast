import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import type {
  DataSourceDetail,
  FormDataSource,
  FormRecordListParams,
} from "../api/types";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Pagination } from "../components/Pagination";
import { ViewTabs } from "../components/ViewTabs";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { formToneBadgeProps } from "../forms/formBadge";
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
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground sm:px-6">
        Loading form…
      </p>
    );
  }
  if (!detail || !id) {
    return (
      <Alert variant="destructive" className="m-4 sm:m-6">
        <AlertTitle>Form unavailable</AlertTitle>
        <AlertDescription>This form could not be loaded.</AlertDescription>
      </Alert>
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
    <section className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 sm:px-6">
      <header className="grid gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Forms plugin
        </p>
        <h1 className="text-xl font-semibold tracking-tight">
          {dataSource?.name ?? detail.name}
        </h1>
        {(dataSource?.description ?? detail.description) && (
          <p className="text-sm text-muted-foreground">
            {dataSource?.description ?? detail.description}
          </p>
        )}
      </header>

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
  const [searchParams] = useSearchParams();

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
      <div className="grid content-start gap-4">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onSelectRecord(null)}
          >
            ← Back to responses
          </Button>
        </div>
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

  // Record rows are real links to the same responses URL the row click used,
  // so a submission can be opened in a new tab like any other destination.
  const recordHref = (recordId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "responses");
    next.set("record", recordId);
    return `?${next.toString()}`;
  };

  const stateOptions = [
    { value: "needs_review", label: "Needs review" },
    { value: "all", label: "All states" },
    ...form.workflow.states.map((state) => ({
      value: state.key,
      label: state.label,
    })),
  ];
  const sortOptions = [
    { value: "updated", label: "Recently updated" },
    { value: "newest", label: "Newest" },
    { value: "oldest", label: "Oldest" },
    { value: "priority", label: "Priority" },
  ];

  return (
    <div className="grid content-start gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field className="min-w-44">
          <FieldLabel htmlFor="responses-state">State</FieldLabel>
          <RheaSelect
            value={stateFilter}
            onValueChange={(value) => {
              setStateFilter(value ?? "needs_review");
              setPage(1);
            }}
          >
            <SelectTrigger id="responses-state">
              <SelectValue>
                {stateOptions.find((o) => o.value === stateFilter)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {stateOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
        <Field className="min-w-44">
          <FieldLabel htmlFor="responses-search">Search</FieldLabel>
          <Input
            id="responses-search"
            value={search}
            placeholder="Title or submitter"
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field className="min-w-44">
          <FieldLabel htmlFor="responses-sort">Sort</FieldLabel>
          <RheaSelect
            value={sort}
            onValueChange={(value) => setSort(value ?? "updated")}
          >
            <SelectTrigger id="responses-sort">
              <SelectValue>
                {sortOptions.find((o) => o.value === sort)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
      </div>

      {records.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load responses</AlertTitle>
          <AlertDescription>
            {records.error instanceof Error
              ? records.error.message
              : "Please try again."}
          </AlertDescription>
        </Alert>
      )}

      {records.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" /> Loading responses…
        </p>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No responses</EmptyTitle>
            <EmptyDescription>
              {stateFilter === "needs_review"
                ? "Nothing is waiting for review right now."
                : "No submissions match these filters yet."}
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
                    Submission
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Submitter
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    State
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Priority
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Updated
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Display window
                  </th>
                  <th scope="col" className="px-3 py-2 font-medium">
                    <span className="sr-only">Review</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((record) => (
                  <tr
                    key={record.id}
                    className="border-b border-border last:border-0 hover:bg-muted"
                  >
                    <td className="px-3 py-2">
                      <Link
                        to={recordHref(record.id)}
                        className="font-medium text-primary hover:underline"
                      >
                        {record.displayTitle || "Untitled submission"}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      {record.submitterName || "Unknown"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        {...formToneBadgeProps(
                          stateTone(form.workflow, record.state),
                        )}
                      >
                        {stateLabel(form.workflow, record.state)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2">{record.priority}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      {new Date(record.updatedAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {displayWindow(record.displayAt, record.expiresAt)}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        to={recordHref(record.id)}
                        aria-label={`Review ${record.displayTitle || "untitled submission"}`}
                        className="font-medium text-primary hover:underline"
                      >
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
    <div className="grid content-start gap-4">
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
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div className="grid min-w-0 gap-0.5">
          <h2 className="truncate text-sm font-semibold">{form.name}</h2>
          {form.description && (
            <p className="text-sm text-muted-foreground">{form.description}</p>
          )}
        </div>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit details
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-xl border border-border bg-card p-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Details not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor="form-metadata-name">Form name</FieldLabel>
        <Input
          id="form-metadata-name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="form-metadata-description">Description</FieldLabel>
        <Textarea
          id="form-metadata-description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            setName(form.name);
            setDescription(form.description);
            setEditing(false);
          }}
        >
          Cancel
        </Button>
        <Button
          variant="default"
          disabled={name.trim() === "" || save.isPending}
          onClick={() => {
            if (!save.isPending) {
              save.mutate();
            }
          }}
        >
          {save.isPending && <Spinner aria-hidden="true" />}
          Save details
        </Button>
      </div>
    </div>
  );
}

function ReadOnlyView({ form }: { form: FormDataSource }) {
  const revision = form.publishedRevision;
  return (
    <div className="grid content-start gap-4">
      <Alert>
        <AlertTitle>Read-only</AlertTitle>
        <AlertDescription>
          You can view this form but do not have permission to edit it.
        </AlertDescription>
      </Alert>
      {revision && (
        <p className="text-sm text-muted-foreground">
          Published revision {revision.revisionNumber} ·{" "}
          {new Date(revision.publishedAt).toLocaleString()}
        </p>
      )}
      <FormRenderer schema={form.draftSchema} readOnly />
    </div>
  );
}
