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
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import { api, ApiError } from "../api/client";
import type { DataSource, DataSourceDefinition } from "../api/types";
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
import { CreateFormDataSourcePage } from "./CreateFormDataSourcePage";
import { FormDataSourcePage } from "./FormDataSourcePage";

type SourceAction = {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  separated?: boolean;
};

export function DataSourcesPage() {
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
  const providerOptions = [
    { value: "", label: "All Data Source types" },
    ...(definitions.data?.dataSources ?? [])
      .filter((item) => item.id !== "form")
      .map((item) => ({ value: item.id, label: item.name })),
  ];
  const definitionsByProvider = new Map<string, DataSourceDefinition>(
    (definitions.data?.dataSources ?? [])
      .filter((item) => item.id !== "form")
      .map((item) => [item.id, item]),
  );
  const visibleDataSources =
    dataSources.data?.items?.filter((source) => source.provider !== "form") ??
    [];
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
        label: canManage ? "Edit" : "Open",
        icon: <SquarePen size={14} aria-hidden="true" />,
        onSelect: () => void navigate(`/data-sources/${source.id}`),
      },
    ];
    if (canManage)
      actions.push(
        {
          label: "Duplicate",
          icon: <Copy size={14} aria-hidden="true" />,
          disabled: duplicate.isPending,
          onSelect: () => duplicate.mutate(source.id),
        },
        {
          label: "Delete",
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
          <h1 className="text-xl font-semibold">Data Sources</h1>
          {canManage && (
            <Button
              type="button"
              onClick={() => void navigate("/data-sources/new")}
            >
              <Plus size={16} aria-hidden="true" /> Create Data Source
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Reusable connections that fetch, parse, and cache data.
        </p>
      </header>
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search Data Sources"
          placeholder="Search Data Sources"
        />
        <Select
          items={providerOptions}
          value={provider}
          onValueChange={(next) => {
            if (typeof next === "string") setProvider(next);
          }}
        >
          <SelectTrigger
            aria-label="Filter by Data Source provider"
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
          aria-label="Sort by updated"
          aria-pressed={!sortAscending}
          onClick={() => setSortAscending((current) => !current)}
        >
          {sortAscending ? (
            <ArrowUp size={16} aria-hidden="true" />
          ) : (
            <ArrowDown size={16} aria-hidden="true" />
          )}
          Updated
        </Button>
      </DashboardListToolbar>
      {dataSources.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {dataSources.error instanceof ApiError
              ? dataSources.error.message
              : "Data Sources could not be loaded."}
          </AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>
            {actionError instanceof ApiError
              ? actionError.message
              : "The Data Source action could not be completed."}
          </AlertDescription>
        </Alert>
      )}
      {dataSources.isLoading ? (
        <div className="grid gap-2" aria-label="Loading Data Sources">
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
            <EmptyTitle>No Data Sources yet</EmptyTitle>
            <EmptyDescription>
              Create a reusable connection to feed your Widgets.
            </EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <Button
                type="button"
                onClick={() => void navigate("/data-sources/new")}
              >
                Create Data Source
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Cached records</TableHead>
                <TableHead
                  aria-sort={sortAscending ? "ascending" : "descending"}
                >
                  Updated
                </TableHead>
                <TableHead>Used by</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
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
                    providerLabel(source.provider)
                  }
                  actions={actionsFor(source)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
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
              Delete {pendingDelete?.name ?? "Data Source"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Widgets reading this Data Source will show their empty state. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => {
                if (pendingDelete) {
                  remove.mutate(pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
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
  const menuLabel = `Actions for ${source.name}`;
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
            : updated.toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
        </TableCell>
        <TableCell>
          <Link
            to={`/data-sources/${source.id}`}
            className="underline-offset-4 hover:underline"
          >
            View
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

export function DataSourceEditorPage({
  redirectForms = false,
}: {
  redirectForms?: boolean;
} = {}) {
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
  const dataSource = detail.data;
  const provider = providerParam ?? dataSource?.provider;
  const close = () => void navigate("/data-sources");
  const saved = (value: { id: string }) => {
    void navigate(`/data-sources/${value.id}`, { replace: true });
  };
  const definition = definitions.data?.dataSources?.find(
    (candidate) => candidate.id === provider,
  );

  if (providerParam === "form" && redirectForms) {
    return <Navigate to="/plugins/forms/new" replace />;
  }
  if (!id && !providerParam) {
    return (
      <section className="app-editor-route">
        <DataSourceProviderGallery
          exclude={["form"]}
          page
          onClose={close}
          onChoose={(choice) => void navigate(`/data-sources/new/${choice}`)}
        />
      </section>
    );
  }
  if (id && detail.isLoading)
    return <Skeleton className="h-24" aria-label="Loading Data Source" />;
  // Form Data Sources use a dedicated, full-width management page rather than the compact generic
  // editor shell, and enforce per-form capabilities instead of only global roles.
  if (provider === "form") {
    return redirectForms ? (
      <Navigate to={`/plugins/forms/${id}${location.search}`} replace />
    ) : dataSource ? (
      <FormDataSourcePage dataSource={dataSource} />
    ) : (
      <CreateFormDataSourcePage />
    );
  }
  if (definitions.isLoading)
    return (
      <Skeleton className="h-24" aria-label="Loading Data Source definition" />
    );
  if ((id && !dataSource) || !provider || !definition) {
    return (
      <section className="w-full min-w-0 space-y-5">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Data Source unavailable</EmptyTitle>
            <EmptyDescription>
              This Data Source could not be loaded.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={close}>
              Back to Data Sources
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
            <EmptyTitle>
              You do not have permission to create Data Sources
            </EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={close}>
              Back to Data Sources
            </Button>
          </EmptyContent>
        </Empty>
      )}
      {dataSource && (
        <UsedByPanel
          emptyMessage="No Widget or Layout binding reads this Data Source yet."
          groups={[
            {
              label: "Widgets",
              items: dataSource.widgetUsage,
              to: (id) => `/widgets/${id}`,
            },
            {
              label: "Layout text bindings",
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
