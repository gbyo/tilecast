import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useParams, useSearchParams } from "react-router";
import type {
  DataSourceDetail,
  FormDataSource,
  FormRecordListParams,
} from "../api/types";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Pagination } from "../components/Pagination";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select,
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
import { useFormatLocale } from "../i18n";
import type { FormsT } from "../forms/formSchema";
import { useDesktopLayout } from "../hooks/use-desktop-layout";

type TabValue =
  "responses" | "form" | "workflow" | "views" | "outputs" | "access";

export function FormDataSourcePage({
  dataSource,
}: {
  dataSource?: DataSourceDetail;
}) {
  const { t } = useTranslation("forms");
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
  const tabDefs: {
    value: TabValue;
    labelKey:
      | "detail.tabs.responses"
      | "detail.tabs.form"
      | "detail.tabs.workflow"
      | "detail.tabs.views"
      | "detail.tabs.outputs"
      | "detail.tabs.access";
    permitted: boolean;
  }[] = [
    {
      value: "responses",
      labelKey: "detail.tabs.responses",
      permitted: canViewAll,
    },
    { value: "form", labelKey: "detail.tabs.form", permitted: true },
    {
      value: "workflow",
      labelKey: "detail.tabs.workflow",
      permitted: canManage,
    },
    { value: "views", labelKey: "detail.tabs.views", permitted: canManage },
    {
      value: "outputs",
      labelKey: "detail.tabs.outputs",
      permitted: canViewAll || canManage,
    },
    { value: "access", labelKey: "detail.tabs.access", permitted: canManage },
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
        {t("detail.loading")}
      </p>
    );
  }
  if (!detail || !id) {
    return (
      <Alert variant="destructive" className="m-4 sm:m-6">
        <AlertTitle>{t("detail.unavailable")}</AlertTitle>
        <AlertDescription>{t("detail.unavailableBody")}</AlertDescription>
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
          {t("detail.pluginEyebrow")}
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

      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as TabValue)}
        className="grid gap-4"
      >
        <TabsList variant="line" aria-label={t("detail.sectionsLabel")}>
          {permittedTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {t(tab.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={activeTab} className="grid gap-4">
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
        </TabsContent>
      </Tabs>
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
  const { t } = useTranslation("forms");
  const locale = useFormatLocale();
  const desktop = useDesktopLayout();
  const [detailsOpen, setDetailsOpen] = useState(Boolean(selectedRecordId));
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

  const stateOptions: { value: string; label: string }[] = [
    { value: "needs_review", label: t("detail.filters.needsReview") },
    { value: "all", label: t("detail.filters.allStates") },
    ...form.workflow.states.map((state) => ({
      value: state.key,
      label: state.label,
    })),
  ];
  const sortOptions = [
    { value: "updated", label: t("detail.sort.updated") },
    { value: "newest", label: t("detail.sort.newest") },
    { value: "oldest", label: t("detail.sort.oldest") },
    { value: "priority", label: t("detail.sort.priority") },
  ];

  useEffect(() => {
    if (selectedRecordId) setDetailsOpen(true);
  }, [selectedRecordId]);

  return (
    <div className="grid content-start gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field className="min-w-44">
          <FieldLabel htmlFor="responses-state">
            {t("detail.filters.state")}
          </FieldLabel>
          <Select
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
          </Select>
        </Field>
        <Field className="min-w-44">
          <FieldLabel htmlFor="responses-search">
            {t("detail.filters.search")}
          </FieldLabel>
          <Input
            id="responses-search"
            value={search}
            placeholder={t("detail.filters.searchPlaceholder")}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field className="min-w-44">
          <FieldLabel htmlFor="responses-sort">
            {t("detail.filters.sort")}
          </FieldLabel>
          <Select
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
          </Select>
        </Field>
      </div>

      {records.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t("detail.loadResponsesError")}</AlertTitle>
          <AlertDescription>
            {records.error instanceof Error
              ? records.error.message
              : t("detail.retry")}
          </AlertDescription>
        </Alert>
      )}

      {records.isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" /> {t("detail.loadingResponses")}
        </p>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("detail.noResponses")}</EmptyTitle>
            <EmptyDescription>
              {stateFilter === "needs_review"
                ? t("detail.emptyNeedsReview")
                : t("detail.emptyFiltered")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table className="min-w-[48rem]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">
                    {t("detail.table.submission")}
                  </TableHead>
                  <TableHead scope="col">
                    {t("detail.table.submitter")}
                  </TableHead>
                  <TableHead scope="col">{t("detail.table.state")}</TableHead>
                  <TableHead scope="col">
                    {t("detail.table.priority")}
                  </TableHead>
                  <TableHead scope="col">{t("detail.table.updated")}</TableHead>
                  <TableHead scope="col">{t("detail.table.window")}</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">
                      {t("detail.table.reviewAction")}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((record) => (
                  <TableRow key={record.id} className="hover:bg-muted">
                    <TableCell>
                      <Link
                        to={recordHref(record.id)}
                        className="font-medium text-primary hover:underline"
                      >
                        {record.displayTitle || t("detail.untitled")}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {record.submitterName || t("detail.unknown")}
                    </TableCell>
                    <TableCell>
                      <Badge
                        {...formToneBadgeProps(
                          stateTone(form.workflow, record.state),
                        )}
                      >
                        {stateLabel(form.workflow, record.state)}
                      </Badge>
                    </TableCell>
                    <TableCell>{record.priority}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {new Date(record.updatedAt).toLocaleString(locale)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {displayWindow(
                        record.displayAt,
                        record.expiresAt,
                        t,
                        locale,
                      )}
                    </TableCell>
                    <TableCell>
                      <Link
                        to={recordHref(record.id)}
                        aria-label={t("detail.reviewLink", {
                          title:
                            record.displayTitle || t("detail.untitledLink"),
                        })}
                        className="font-medium text-primary hover:underline"
                      >
                        {t("detail.table.reviewAction")}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination
            label={t("detail.pagesLabel")}
            status={t("detail.pagination", { page, totalPages, total })}
            previous={() => setPage((current) => Math.max(1, current - 1))}
            next={() => setPage((current) => Math.min(totalPages, current + 1))}
            previousDisabled={page <= 1}
            nextDisabled={page >= totalPages}
          />
        </>
      )}
      {selectedRecordId &&
        (desktop ? (
          <Sheet
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
            onOpenChangeComplete={(open) => {
              if (!open) onSelectRecord(null);
            }}
          >
            <SheetContent
              side="right"
              className="overflow-y-auto sm:max-w-xl"
              aria-label={t("detail.sheetLabel")}
            >
              <SheetHeader>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {t("detail.sheetEyebrow")}
                </p>
                <SheetTitle>{t("detail.sheetTitle")}</SheetTitle>
                <SheetDescription>{t("detail.sheetBody")}</SheetDescription>
              </SheetHeader>
              <div className="grid content-start gap-4 px-4 pb-4">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDetailsOpen(false)}
                >
                  {t("detail.backToResponses")}
                </Button>
                <RecordReview
                  form={form}
                  recordId={selectedRecordId}
                  csrf={csrf}
                  onAfterTransition={() => void records.refetch()}
                />
              </div>
            </SheetContent>
          </Sheet>
        ) : (
          <Drawer
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
            onOpenChangeComplete={(open) => {
              if (!open) onSelectRecord(null);
            }}
            showSwipeHandle
          >
            <DrawerContent
              aria-label={t("detail.sheetLabel")}
              className="max-h-[calc(100dvh-2rem)]"
            >
              <DrawerHeader>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {t("detail.sheetEyebrow")}
                </p>
                <DrawerTitle>{t("detail.sheetTitle")}</DrawerTitle>
                <DrawerDescription>{t("detail.sheetBody")}</DrawerDescription>
              </DrawerHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <div className="grid content-start gap-4">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDetailsOpen(false)}
                  >
                    {t("detail.backToResponses")}
                  </Button>
                  <RecordReview
                    form={form}
                    recordId={selectedRecordId}
                    csrf={csrf}
                    onAfterTransition={() => void records.refetch()}
                  />
                </div>
              </div>
            </DrawerContent>
          </Drawer>
        ))}
    </div>
  );
}

function displayWindow(
  displayAt: string | null | undefined,
  expiresAt: string | null | undefined,
  t: FormsT,
  locale: string,
): string {
  const start = displayAt
    ? new Date(displayAt).toLocaleDateString(locale)
    : null;
  const end = expiresAt ? new Date(expiresAt).toLocaleDateString(locale) : null;
  if (!start && !end) return t("detail.displayWindowEmpty");
  return t("detail.displayWindowRange", {
    start: start ?? t("detail.displayWindowNow"),
    end: end ?? "∞",
  });
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
  const { t } = useTranslation(["forms", "common"]);
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
        err instanceof Error ? err.message : t("detail.detailsFallback"),
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
          {t("detail.editDetails")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 rounded-xl border border-border bg-card p-4">
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t("detail.detailsError")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Field>
        <FieldLabel htmlFor="form-metadata-name">
          {t("detail.nameLabel")}
        </FieldLabel>
        <Input
          id="form-metadata-name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="form-metadata-description">
          {t("detail.descriptionLabel")}
        </FieldLabel>
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
          {t("common:actions.cancel")}
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
          {t("detail.saveDetails")}
        </Button>
      </div>
    </div>
  );
}

function ReadOnlyView({ form }: { form: FormDataSource }) {
  const { t } = useTranslation("forms");
  const locale = useFormatLocale();
  const revision = form.publishedRevision;
  return (
    <div className="grid content-start gap-4">
      <Alert>
        <AlertTitle>{t("detail.readOnlyTitle")}</AlertTitle>
        <AlertDescription>{t("detail.readOnlyBody")}</AlertDescription>
      </Alert>
      {revision && (
        <p className="text-sm text-muted-foreground">
          {t("detail.publishedMeta", {
            revision: revision.revisionNumber,
            date: new Date(revision.publishedAt).toLocaleString(locale),
          })}
        </p>
      )}
      <FormRenderer schema={form.draftSchema} readOnly />
    </div>
  );
}
