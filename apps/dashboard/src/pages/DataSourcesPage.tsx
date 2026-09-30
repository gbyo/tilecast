import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  EllipsisVertical,
  SquarePen,
  Plus,
  Trash2,
} from "lucide-react";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { api, ApiError } from "../api/client";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import type { DataSource, DataSourceDefinition } from "../api/types";
import { galleryHiddenProviders } from "../content/dataSourceProviderMeta";
import { useAuth } from "../auth/AuthProvider";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { toast } from "../components/ui/toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  DataSourceCreateShell,
  DataSourceProviderGallery,
} from "../content/DataSourceCreateFlow";
import { DataSourceEditor } from "../content/data-sources/dispatcher";
import { providerLabel, sourceIcon } from "../content/dataSourceProviderMeta";
import { SourceStatus } from "../content/DataSourcePicker";
import { UsedByPanel } from "../content/UsedByPanel";
import { canManageContent } from "./ContentPage";

type SourceAction = {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  separated?: boolean;
};

export function DataSourcesPage() {
  const { t } = useTranslation(["content", "common"]);
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = canManageContent(auth.status?.user);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [sortAscending, setSortAscending] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DataSource | null>(null);
  const params = new URLSearchParams({ page: "1", pageSize: "100" });
  if (search) params.set("search", search);
  if (provider) params.set("provider", provider);
  const dataSources = useQuery({
    queryKey: ["data-sources", params.toString()],
    queryFn: () => api.listDataSources(params),
  });
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const catalog = useQuery({
    queryKey: ["provider-catalog"],
    queryFn: api.providerCatalog,
  });
  const hiddenProviders = new Set(galleryHiddenProviders(catalog.data));
  const providerOptions = [
    { value: "", label: t("dataSources.list.allTypes") },
    ...(definitions.data?.dataSources ?? [])
      .filter((item) => !hiddenProviders.has(item.id))
      .map((item) => ({ value: item.id, label: item.name })),
  ];
  const definitionsByProvider = new Map<string, DataSourceDefinition>(
    (definitions.data?.dataSources ?? [])
      .filter((item) => !hiddenProviders.has(item.id))
      .map((item) => [item.id, item]),
  );
  const visibleDataSources =
    dataSources.data?.items?.filter(
      (source) => !hiddenProviders.has(source.provider),
    ) ?? [];
  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateDataSource(id, csrf),
    onSuccess: (created) => {
      toast.add({ title: "Data Source duplicated.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      void navigate(`/data-sources/${created.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDataSource(id, csrf),
    onSuccess: () => {
      toast.add({ title: "Data Source deleted.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
    },
  });
  const actionsFor = (source: DataSource): SourceAction[] => {
    const actions: SourceAction[] = [
      {
        label: canManage
          ? t("common:actions.edit")
          : t("dataSources.list.openAction"),
        icon: <SquarePen size={14} aria-hidden="true" />,
        onSelect: () => void navigate(`/data-sources/${source.id}`),
      },
    ];
    if (canManage)
      actions.push(
        {
          label: t("dataSources.list.duplicateAction"),
          icon: <Copy size={14} aria-hidden="true" />,
          disabled: duplicate.isPending,
          onSelect: () => duplicate.mutate(source.id),
        },
        {
          label: t("common:actions.delete"),
          icon: <Trash2 size={14} aria-hidden="true" />,
          danger: true,
          separated: true,
          disabled: remove.isPending,
          onSelect: () => setPendingDelete(source),
        },
      );
    return actions;
  };
  const actionError = duplicate.error ?? remove.error;
  const sortedSources = [...visibleDataSources].sort((a, b) =>
    sortAscending
      ? a.updatedAt.localeCompare(b.updatedAt)
      : b.updatedAt.localeCompare(a.updatedAt),
  );

  return (
    <section className="w-full min-w-0 space-y-5">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">
            {t("dataSources.list.title")}
          </h1>
          {canManage && (
            <Button
              type="button"
              onClick={() => void navigate("/data-sources/new")}
            >
              <Plus size={16} aria-hidden="true" />{" "}
              {t("dataSources.list.createButton")}
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("dataSources.list.subtitle")}
        </p>
      </header>
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label={t("dataSources.list.searchLabel")}
          placeholder={t("dataSources.list.searchLabel")}
        />
        <Select
          items={providerOptions}
          value={provider}
          onValueChange={(next) => {
            if (typeof next === "string") setProvider(next);
          }}
        >
          <SelectTrigger
            aria-label={t("dataSources.list.providerFilter")}
            className="w-52 max-sm:flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {providerOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          aria-label={t("dataSources.list.sortLabel")}
          aria-pressed={!sortAscending}
          onClick={() => setSortAscending((current) => !current)}
        >
          {sortAscending ? (
            <ArrowUp size={16} aria-hidden="true" />
          ) : (
            <ArrowDown size={16} aria-hidden="true" />
          )}
          {t("dataSources.list.updatedButton")}
        </Button>
      </DashboardListToolbar>
      {dataSources.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {dataSources.error instanceof ApiError
              ? apiErrorMessage(dataSources.error)
              : t("dataSources.list.loadError")}
          </AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>
            {actionError instanceof ApiError
              ? apiErrorMessage(actionError)
              : t("dataSources.list.actionError")}
          </AlertDescription>
        </Alert>
      )}
      {dataSources.isLoading ? (
        <div className="grid gap-2" aria-label={t("dataSources.list.loading")}>
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : sortedSources.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plus size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("dataSources.list.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("dataSources.list.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <Button
                type="button"
                onClick={() => void navigate("/data-sources/new")}
              >
                {t("dataSources.list.createButton")}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <div className="grid gap-2 md:hidden">
            {sortedSources.map((source) => (
              <DataSourceMobileCard
                key={source.id}
                source={source}
                providerName={
                  definitionsByProvider.get(source.provider)?.name ??
                  providerLabel(source.provider, t)
                }
                actions={actionsFor(source)}
              />
            ))}
          </div>
        <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("dataSources.list.columns.name")}</TableHead>
                <TableHead>{t("dataSources.list.columns.provider")}</TableHead>
                <TableHead>{t("dataSources.list.columns.status")}</TableHead>
                <TableHead>
                  {t("dataSources.list.columns.cachedRecords")}
                </TableHead>
                <TableHead
                  aria-sort={sortAscending ? "ascending" : "descending"}
                >
                  {t("dataSources.list.columns.updated")}
                </TableHead>
                <TableHead>{t("dataSources.list.columns.usedBy")}</TableHead>
                <TableHead>
                  <span className="sr-only">
                    {t("dataSources.list.columns.actions")}
                  </span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedSources.map((source) => (
                <DataSourceRow
                  key={source.id}
                  source={source}
                  providerName={
                    definitionsByProvider.get(source.provider)?.name ??
                    providerLabel(source.provider, t)
                  }
                  actions={actionsFor(source)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
        </>
      )}
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("dataSources.list.deleteTitle", {
                name:
                  pendingDelete?.name ??
                  t("dataSources.providerNames.dataSource"),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("dataSources.list.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => {
                if (pendingDelete) {
                  remove.mutate(pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function DataSourceMobileCard({
  source,
  providerName,
  actions,
}: {
  source: DataSource;
  providerName: string;
  actions: SourceAction[];
}) {
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const menuLabel = t("dataSources.list.rowActions", { name: source.name });
  const updated = new Date(source.updatedAt);
  const updatedLabel = Number.isNaN(updated.getTime())
    ? "—"
    : updated.toLocaleString(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      });
  return (
    <article className="grid gap-3 rounded-xl border border-border p-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <Link
            to={`/data-sources/${source.id}`}
            className="block truncate font-medium underline-offset-4 hover:underline"
          >
            {source.name}
          </Link>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0" aria-hidden="true">
              {sourceIcon(source.provider, undefined, 16)}
            </span>
            <span className="truncate">{providerName}</span>
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
            aria-label={menuLabel}
          >
            <EllipsisVertical size={16} aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" aria-label={menuLabel}>
            {actions.map((action, index) => (
              <Fragment key={`${action.label}-mobile-${index}`}>
                {action.separated && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant={action.danger ? "destructive" : "default"}
                  disabled={action.disabled}
                  onClick={action.onSelect}
                >
                  {action.icon}
                  {action.label}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SourceStatus status={source.status} />
        <span className="text-xs text-muted-foreground">
          {t("dataSources.list.columns.cachedRecords")}:{" "}
          {source.cachedRecordCount}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("dataSources.list.columns.updated")}: {updatedLabel}
      </p>
    </article>
  );
}

function DataSourceRow({
  source,
  providerName,
  actions,
}: {
  source: DataSource;
  providerName: string;
  actions: SourceAction[];
}) {
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const menuLabel = t("dataSources.list.rowActions", { name: source.name });
  const updated = new Date(source.updatedAt);
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<TableRow data-slot="data-source-row" />}>
        <TableCell>
          <Link
            to={`/data-sources/${source.id}`}
            className="font-medium underline-offset-4 hover:underline"
          >
            {source.name}
          </Link>
        </TableCell>
        <TableCell>
          <span className="flex items-center gap-2">
            <span aria-hidden="true">
              {sourceIcon(source.provider, undefined, 18)}
            </span>
            {providerName}
          </span>
        </TableCell>
        <TableCell>
          <SourceStatus status={source.status} />
        </TableCell>
        <TableCell>{source.cachedRecordCount}</TableCell>
        <TableCell>
          {Number.isNaN(updated.getTime())
            ? "—"
            : updated.toLocaleString(locale, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
        </TableCell>
        <TableCell>
          <Link
            to={`/data-sources/${source.id}`}
            className="underline-offset-4 hover:underline"
          >
            {t("dataSources.list.viewLink")}
          </Link>
        </TableCell>
        <TableCell>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex size-7 items-center justify-center rounded-xl hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
              aria-label={menuLabel}
            >
              <EllipsisVertical size={15} aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label={menuLabel}>
              {actions.map((action, index) => (
                <Fragment key={`${action.label}-${index}`}>
                  {action.separated && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    variant={action.danger ? "destructive" : "default"}
                    disabled={action.disabled}
                    onClick={action.onSelect}
                  >
                    {action.icon}
                    {action.label}
                  </DropdownMenuItem>
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={menuLabel}>
        {actions.map((action, index) => (
          <Fragment key={`${action.label}-${index}`}>
            {action.separated && <ContextMenuSeparator />}
            <ContextMenuItem
              variant={action.danger ? "destructive" : "default"}
              disabled={action.disabled}
              onClick={action.onSelect}
            >
              {action.icon}
              {action.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function DataSourceEditorPage() {
  const { t } = useTranslation(["content", "common"]);
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { id, provider: providerParam } = useParams();
  const csrf = auth.status?.csrfToken ?? "";
  const detail = useQuery({
    queryKey: ["data-source", id],
    queryFn: () => api.getDataSource(id!),
    enabled: Boolean(id),
  });
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const catalog = useQuery({
    queryKey: ["provider-catalog"],
    queryFn: api.providerCatalog,
  });
  const dataSource = detail.data;
  const provider = providerParam ?? dataSource?.provider;
  const close = () => void navigate("/data-sources");
  const saved = (value: { id: string }) => {
    void navigate(`/data-sources/${value.id}`, { replace: true });
  };
  const definition = definitions.data?.dataSources?.find(
    (candidate) => candidate.id === provider,
  );
  // Providers authored through a canonical plugin surface (their contribution
  // names a canonical creator/editor and hides them from the gallery) redirect
  // to that surface, so legacy /data-sources/... links keep working without
  // the generic UI naming the provider.
  const canonical = (providerId: string | undefined) =>
    catalog.data?.providers?.find(
      (entry) => entry.role === "data_source" && entry.id === providerId,
    )?.uiHints;
  const creator = providerParam
    ? canonical(providerParam)?.canonicalCreator
    : undefined;
  if (creator) {
    return <Navigate to={creator} replace />;
  }
  if (!id && !providerParam) {
    if (catalog.isLoading)
      return (
        <Skeleton
          className="h-24"
          aria-label={t("dataSources.detail.loadingSource")}
        />
      );
    return (
      <section className="app-editor-route">
        <DataSourceProviderGallery
          exclude={galleryHiddenProviders(catalog.data)}
          page
          onClose={close}
          onChoose={(choice) => void navigate(`/data-sources/new/${choice}`)}
        />
      </section>
    );
  }
  if (id && detail.isLoading)
    return (
      <Skeleton
        className="h-24"
        aria-label={t("dataSources.detail.loadingSource")}
      />
    );
  const editor = provider ? canonical(provider)?.canonicalEditor : undefined;
  if (editor && id) {
    return (
      <Navigate to={`${editor.replace(":id", id)}${location.search}`} replace />
    );
  }
  if (definitions.isLoading)
    return (
      <Skeleton
        className="h-24"
        aria-label={t("dataSources.loading.definition")}
      />
    );
  if ((id && !dataSource) || !provider || !definition) {
    return (
      <section className="w-full min-w-0 space-y-5">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("dataSources.detail.unavailableTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("dataSources.detail.unavailableDescription")}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={close}>
              {t("dataSources.detail.backButton")}
            </Button>
          </EmptyContent>
        </Empty>
      </section>
    );
  }
  return (
    <section className="app-editor-route">
      {dataSource ? (
        <DataSourceEditor
          provider={provider}
          dataSource={dataSource}
          csrf={csrf}
          readOnly={!canManageContent(auth.status?.user)}
          onClose={close}
          onSaved={saved}
          page
        />
      ) : canManageContent(auth.status?.user) ? (
        <DataSourceCreateShell
          provider={provider}
          definition={definition}
          csrf={csrf}
          onClose={close}
          onSaved={saved}
        />
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("dataSources.detail.noPermissionTitle")}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={close}>
              {t("dataSources.detail.backButton")}
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {dataSource && (
        <UsedByPanel
          emptyMessage={t("dataSources.detail.usedByEmpty")}
          groups={[
            {
              label: t("dataSources.detail.usedByWidgets"),
              items: dataSource.widgetUsage,
              to: (id) => `/widgets/${id}`,
            },
            {
              label: t("dataSources.detail.usedByBindings"),
              // A Layout may bind several fields of one source, so the field is the hint and the
              // layout is what the entry links to.
              items: dataSource.bindingUsage.map((usage) => ({
                id: usage.layoutId,
                name: usage.layoutName,
                hint: usage.field,
              })),
              to: (id) => `/layouts/${id}`,
            },
          ]}
        />
      )}
    </section>
  );
}
