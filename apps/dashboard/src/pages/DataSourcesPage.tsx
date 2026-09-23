import {
  Button,
  ContextMenu,
  EmptyState,
  Notice,
  PageHeader,
  Select,
  ViewToggle,
  useContextMenu,
  type ContextMenuItem,
} from "../components/legacy-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, EllipsisVertical, SquarePen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api/client";
import type { DataSource, DataSourceDefinition } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import {
  DataSourceCreateShell,
  DataSourceProviderGallery,
} from "../content/DataSourceCreateFlow";
import { DataSourceEditor } from "../content/DataSourceEditors";
import { providerLabel, sourceIcon } from "../content/dataSourceProviderMeta";
import { UsedByPanel } from "../content/UsedByPanel";
import { WorkspaceTabs, contentTabs } from "../navigation/WorkspaceTabs";
import { canManageContent } from "./ContentPage";
import { CreateFormDataSourcePage } from "./CreateFormDataSourcePage";
import { FormDataSourcePage } from "./FormDataSourcePage";

export function DataSourcesPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = canManageContent(auth.status?.user);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
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
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      void navigate(`/data-sources/${created.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteDataSource(id, csrf),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] }),
  });
  const menu = useContextMenu<DataSource>();
  const actionsFor = (source: DataSource): ContextMenuItem[] => {
    const actions: ContextMenuItem[] = [
      {
        label: canManage ? "Edit" : "Open",
        icon: <SquarePen size={14} />,
        onSelect: () => void navigate(`/data-sources/${source.id}`),
      },
    ];
    if (canManage)
      actions.push(
        {
          label: "Duplicate",
          icon: <Copy size={14} />,
          disabled: duplicate.isPending,
          onSelect: () => duplicate.mutate(source.id),
        },
        {
          label: "Delete",
          icon: <Trash2 size={14} />,
          danger: true,
          separated: true,
          disabled: remove.isPending,
          onSelect: () => {
            if (confirm(`Delete ${source.name}?`)) remove.mutate(source.id);
          },
        },
      );
    return actions;
  };
  const actionError = duplicate.error ?? remove.error;

  return (
    <section className="content-page apps-page">
      <WorkspaceTabs label="Content library" tabs={contentTabs} />
      <PageHeader
        title="Data Sources"
        description="Reusable connections that fetch, parse, and cache data."
        actions={
          canManage ? (
            <Button
              variant="primary"
              onClick={() => void navigate("/data-sources/new")}
            >
              <Plus size={16} aria-hidden="true" /> Create Data Source
            </Button>
          ) : undefined
        }
      />
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search Data Sources"
          placeholder="Search Data Sources"
        />
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Filter by Data Source provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          <option value="">All Data Source types</option>
          {(definitions.data?.dataSources ?? [])
            .filter((item) => item.id !== "form")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </Select>
        <ViewToggle value={view} onValueChange={setView} />
      </DashboardListToolbar>
      {dataSources.isError && (
        <Notice variant="danger">
          {dataSources.error instanceof ApiError
            ? dataSources.error.message
            : "Data Sources could not be loaded."}
        </Notice>
      )}
      {actionError && (
        <Notice variant="danger">
          {actionError instanceof ApiError
            ? actionError.message
            : "The Data Source action could not be completed."}
        </Notice>
      )}
      {dataSources.isLoading ? (
        <div className="table-loading">Loading Data Sources...</div>
      ) : visibleDataSources.length === 0 ? (
        <EmptyState
          className="content-empty"
          icon={<Plus size={24} aria-hidden="true" />}
          title="No Data Sources yet"
          message="Create a reusable connection to feed your Widgets."
          action={
            canManage ? (
              <Button
                variant="primary"
                onClick={() => void navigate("/data-sources/new")}
              >
                Create Data Source
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className={`asset-collection asset-collection--${view}`}>
          {visibleDataSources.map((source) => (
            <article
              className="asset-card asset-card--has-menu"
              key={source.id}
              onContextMenu={(event) => menu.open(event, source)}
            >
              <button
                type="button"
                className="asset-card__menu"
                aria-haspopup="menu"
                aria-expanded={menu.anchor?.target.id === source.id}
                aria-label={`Actions for ${source.name}`}
                onClick={(event) => menu.open(event, source)}
              >
                <EllipsisVertical size={15} aria-hidden="true" />
              </button>
              <button
                className="asset-card__open"
                onClick={() => void navigate(`/data-sources/${source.id}`)}
                aria-label={`Edit ${source.name}`}
              >
                <span className="asset-preview">
                  {sourceIcon(
                    source.provider,
                    definitionsByProvider.get(source.provider),
                  )}
                </span>
                <span className="asset-card__body">
                  <strong>{source.name}</strong>
                  <small>
                    {definitionsByProvider.get(source.provider)?.name ??
                      providerLabel(source.provider)}{" "}
                    · {source.cachedRecordCount} cached records
                  </small>
                </span>
                <span
                  className={`media-status media-status--${source.status === "ready" ? "ready" : source.status === "error" ? "failed" : "processing"}`}
                >
                  {source.status}
                </span>
              </button>
            </article>
          ))}
          {menu.anchor && (
            <ContextMenu
              x={menu.anchor.x}
              y={menu.anchor.y}
              label={`Actions for ${menu.anchor.target.name}`}
              items={actionsFor(menu.anchor.target)}
              onClose={menu.close}
            />
          )}
        </div>
      )}
    </section>
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
    return <div className="table-loading">Loading Data Source...</div>;
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
      <div className="table-loading">Loading Data Source definition...</div>
    );
  if ((id && !dataSource) || !provider || !definition) {
    return (
      <section className="empty-state">
        <h2>Data Source unavailable</h2>
        <button className="button" onClick={close}>
          Back to Data Sources
        </button>
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
        <section className="empty-state">
          <h2>You do not have permission to create Data Sources</h2>
          <button className="button" onClick={close}>
            Back to Data Sources
          </button>
        </section>
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
