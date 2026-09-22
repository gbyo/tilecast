import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { ActionMenu, MenuItem } from "@react-spectrum/s2/ActionMenu";
import { Button } from "@react-spectrum/s2/Button";
import { Cell, Column, Row, TableBody, TableHeader, TableView } from "@react-spectrum/s2/TableView";
import { SearchField } from "@react-spectrum/s2/SearchField";
import { Picker, PickerItem } from "@react-spectrum/s2/Picker";
import { IllustratedMessage } from "@react-spectrum/s2/IllustratedMessage";
import { InlineAlert } from "@react-spectrum/s2/InlineAlert";
import { Heading } from "@react-spectrum/s2/Heading";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { Text } from "@react-spectrum/s2/Text";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import AddIcon from "@react-spectrum/s2/icons/Add";
import { api, ApiError } from "../api/client";
import type { DataSourceDefinition } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  DataSourceCreateShell,
  DataSourceProviderGallery,
} from "../content/DataSourceCreateFlow";
import { DataSourceEditor } from "../content/DataSourceEditors";
import { providerLabel } from "../content/dataSourceProviderMeta";
import { UsedByPanel } from "../content/UsedByPanel";
import { WorkspaceTabs, contentTabs } from "../navigation/WorkspaceTabs";
import { canManageContent } from "./ContentPage";
import { CreateFormDataSourcePage } from "./CreateFormDataSourcePage";
import { FormDataSourcePage } from "./FormDataSourcePage";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";

const tableStyles = style({ height: 560, minHeight: 360, width: "full" });
const pageHeaderStyles = style({
  display: "flex",
  alignItems: "start",
  justifyContent: "space-between",
  gap: 16,
  marginBottom: 24,
});
const filterStyles = style({
  display: "flex",
  alignItems: "end",
  flexWrap: "wrap",
  gap: 12,
  marginBottom: 16,
});

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

export function DataSourcesPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = canManageContent(auth.status?.user);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
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
  const { confirm } = useSpectrumDialogs();
  const actionError = duplicate.error ?? remove.error;

  return (
    <section className="content-page apps-page">
      <WorkspaceTabs label="Content library" tabs={contentTabs} />
      <header className={pageHeaderStyles}>
        <div>
          <Heading level={1}>Data sources</Heading>
          <Text>Connections that fetch, parse, and cache operational data.</Text>
        </div>
        {canManage && (
          <Button variant="accent" onPress={() => void navigate("/data-sources/new")}>
            <AddIcon aria-hidden="true" /> Create data source
          </Button>
        )}
      </header>
      <div className={filterStyles}>
        <SearchField
          value={search}
          onChange={setSearch}
          aria-label="Search data sources"
          placeholder="Search data sources"
        />
        <Picker
          label="Provider"
          selectedKey={provider || "all"}
          onSelectionChange={(key) => setProvider(key === "all" ? "" : String(key))}
        >
          <PickerItem id="all">All providers</PickerItem>
          {(definitions.data?.dataSources ?? [])
            .filter((item) => item.id !== "form")
            .map((item) => (
              <PickerItem key={item.id} id={item.id}>{item.name}</PickerItem>
            ))}
        </Picker>
      </div>
      {dataSources.isError && (
        <InlineAlert variant="negative" fillStyle="subtleFill">
          <Heading level={2}>Data sources could not be loaded</Heading>
          {dataSources.error instanceof ApiError
            ? dataSources.error.message
            : "Data Sources could not be loaded."}
        </InlineAlert>
      )}
      {actionError && (
        <InlineAlert variant="negative" fillStyle="subtleFill">
          <Heading level={2}>The action could not be completed</Heading>
          {actionError instanceof ApiError
            ? actionError.message
            : "The Data Source action could not be completed."}
        </InlineAlert>
      )}
      <TableView
        aria-label="Data sources"
        density={document.documentElement.dataset.density === "compact" ? "compact" : "regular"}
        styles={tableStyles}
        loadingState={dataSources.isLoading ? "loading" : undefined}
      >
        <TableHeader>
          <Column isRowHeader>Name</Column>
          <Column>Provider</Column>
          <Column>Status</Column>
          <Column>Cached records</Column>
          <Column>Last updated</Column>
          <Column>Created by</Column>
          <Column>Actions</Column>
        </TableHeader>
        <TableBody
          items={visibleDataSources}
          renderEmptyState={() => (
            <IllustratedMessage>
              <AddIcon aria-hidden="true" />
              <Heading level={2}>{search || provider ? "No matching data sources" : "No data sources yet"}</Heading>
              <Text>{search || provider ? "Adjust your search or provider filter." : "Create a reusable connection to feed your widgets."}</Text>
              {canManage && !search && !provider && (
                <Button variant="accent" onPress={() => void navigate("/data-sources/new")}>
                  Create data source
                </Button>
              )}
            </IllustratedMessage>
          )}
        >
          {(source) => (
            <Row id={source.id} href={`/data-sources/${source.id}`}>
              <Cell>{source.name}</Cell>
              <Cell>{definitionsByProvider.get(source.provider)?.name ?? providerLabel(source.provider)}</Cell>
              <Cell>
                <StatusLight variant={source.status === "ready" ? "positive" : source.status === "error" ? "negative" : "informative"}>
                  {source.status}
                </StatusLight>
              </Cell>
              <Cell>{source.cachedRecordCount.toLocaleString()}</Cell>
              <Cell>{formatUpdatedAt(source.updatedAt)}</Cell>
              <Cell>{source.creator?.name ?? "—"}</Cell>
              <Cell>
                <ActionMenu
                  aria-label={`Actions for ${source.name}`}
                  onAction={async (key) => {
                    if (key === "open") void navigate(`/data-sources/${source.id}`);
                    if (key === "duplicate") duplicate.mutate(source.id);
                    if (
                      key === "delete" &&
                      await confirm({
                        title: `Delete ${source.name}?`,
                        confirmLabel: "Delete data source",
                        tone: "negative",
                      })
                    ) remove.mutate(source.id);
                  }}
                >
                  <MenuItem id="open">{canManage ? "Edit" : "Open"}</MenuItem>
                  {canManage && <MenuItem id="duplicate" isDisabled={duplicate.isPending}>Duplicate</MenuItem>}
                  {canManage && <MenuItem id="delete" isDisabled={remove.isPending}>Delete</MenuItem>}
                </ActionMenu>
              </Cell>
            </Row>
          )}
        </TableBody>
      </TableView>
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
