import {
  Button,
  EmptyState,
  Notice,
  PageHeader,
  Select,
  ViewToggle,
} from "../components/legacy-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api/client";
import type { Asset } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import {
  NativeAppEditor,
  type NativeProvider,
  WidgetProviderGallery,
  YouTubeSourceEditor,
} from "../content/SourceEditors";
import { GenericWidgetEditor } from "../content/GenericDefinitionEditors";
import { UsedByPanel } from "../content/UsedByPanel";
import { WidgetSnapshotBackfill } from "../content/WidgetSnapshotBackfill";
import { inAppPath, withParam } from "../navigation/returnPaths";
import { WorkspaceTabs, contentTabs } from "../navigation/WorkspaceTabs";
import {
  AssetCollection,
  WebsiteEditor,
  canManageContent,
} from "./ContentPage";

export function WidgetsPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = canManageContent(auth.status?.user);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const params = new URLSearchParams({
    page: "1",
    pageSize: "100",
    type: "widget",
  });
  if (search) params.set("search", search);
  if (provider) params.set("provider", provider);
  const widgets = useQuery({
    queryKey: ["assets", "widgets", params.toString()],
    queryFn: () => api.assets(params),
  });
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const filterProviders = definitions.data?.widgets ?? [];
  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateWidget(id, csrf),
    onSuccess: (widget) => {
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      void navigate(`/widgets/${widget.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteAsset(id, csrf),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["assets"] }),
  });

  return (
    <section className="content-page apps-page">
      <WorkspaceTabs label="Content library" tabs={contentTabs} />
      <PageHeader
        title="Widgets"
        description="Reusable visual content for playlists and Layouts."
        actions={
          canManage ? (
            <Button
              variant="primary"
              onClick={() => void navigate("/widgets/new")}
            >
              <Plus size={16} aria-hidden="true" /> Create Widget
            </Button>
          ) : undefined
        }
      />
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search Widgets"
          placeholder="Search Widgets"
        />
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Filter by Widget provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          <option value="">All Widget types</option>
          {filterProviders.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <ViewToggle value={view} onValueChange={setView} />
      </DashboardListToolbar>
      {widgets.isError && (
        <Notice variant="danger">
          {widgets.error instanceof ApiError
            ? widgets.error.message
            : "Widgets could not be loaded."}
        </Notice>
      )}
      {widgets.isLoading ? (
        <div className="table-loading">Loading Widgets...</div>
      ) : widgets.data?.items?.length === 0 ? (
        <EmptyState
          className="content-empty"
          icon={<Plus size={24} aria-hidden="true" />}
          title="No Widgets yet"
          message="Create a reusable Widget for signage content."
          action={
            canManage ? (
              <Button
                variant="primary"
                onClick={() => void navigate("/widgets/new")}
              >
                Create Widget
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <AssetCollection
            items={widgets.data?.items ?? []}
            view={view}
            onSelect={(widget) => void navigate(`/widgets/${widget.id}`)}
            canManage={canManage}
            onDuplicate={(widget) => duplicate.mutate(widget.id)}
            onDelete={(widget) => {
              if (confirm(`Delete ${widget.name}?`)) remove.mutate(widget.id);
            }}
          />
          {/* Storing a capture is an editor-or-above action, so viewers browse the library without
              it and simply see the unavailable state until someone who can manage content visits. */}
          <WidgetSnapshotBackfill
            assets={widgets.data?.items ?? []}
            enabled={canManage}
          />
        </>
      )}
    </section>
  );
}

export function WidgetEditorPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { id, provider: providerParam } = useParams();
  const csrf = auth.status?.csrfToken ?? "";
  const widget = useQuery({
    queryKey: ["assets", id],
    queryFn: () => api.asset(id!),
    enabled: Boolean(id),
  });
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const asset = widget.data;
  const provider = providerParam ?? asset?.widget?.provider;
  const search = new URLSearchParams(location.search);
  const presetId = search.get("preset") as
    import("../api/types").WidgetPreset | null;
  // A Layout links here with returnTo so closing the Widget lands back on the Layout the author
  // was building, rather than on the Widget list.
  const returnTo = inAppPath(search.get("returnTo"));
  // Saving a new Widget replaces the route, so "was this Widget just created here?"
  // has to live in the URL rather than component state to survive the remount.
  const createdHere = search.get("created") === "1";
  const close = () =>
    void navigate(
      returnTo
        ? createdHere && id
          ? withParam(returnTo, "newWidget", id)
          : returnTo
        : "/widgets",
    );
  const saved = (value: Asset) => {
    // Preserve returnTo across the save so a Widget opened from a Layout still returns there.
    const query = new URLSearchParams();
    if (returnTo) query.set("returnTo", returnTo);
    // Editing an existing Widget must not report it as newly created on return.
    if (createdHere || !id) query.set("created", "1");
    const suffix = query.size ? `?${query.toString()}` : "";
    void navigate(`/widgets/${value.id}${suffix}`, { replace: true });
  };
  const definition = definitions.data?.widgets?.find(
    (candidate) => candidate.id === provider,
  );

  if (!id && !providerParam) {
    return (
      <section className="app-editor-route">
        <WidgetProviderGallery
          page
          onClose={close}
          onChoose={(choice, preset) => {
            // Picking a provider is a step inside the create flow, so returnTo has
            // to survive it or the author never gets back to what they came from.
            const query = new URLSearchParams();
            if (preset) query.set("preset", preset);
            if (returnTo) query.set("returnTo", returnTo);
            void navigate(
              `/widgets/new/${choice}${query.size ? `?${query.toString()}` : ""}`,
            );
          }}
        />
      </section>
    );
  }
  if (id && widget.isLoading)
    return <div className="table-loading">Loading Widget...</div>;
  if (definitions.isLoading)
    return <div className="table-loading">Loading Widget definition...</div>;
  if ((id && !asset) || !provider || !definition) {
    return (
      <section className="empty-state">
        <h2>Widget unavailable</h2>
        <button className="button" onClick={close}>
          Back to Widgets
        </button>
      </section>
    );
  }
  const common = {
    asset,
    csrf,
    page: true,
    readOnly: !canManageContent(auth.status?.user),
    onClose: close,
    onSaved: saved,
  };
  return (
    <section className="app-editor-route">
      {provider === "website" ? (
        <WebsiteEditor {...common} />
      ) : provider === "youtube" ? (
        <YouTubeSourceEditor {...common} />
      ) : definition && !definition.legacyEditor ? (
        <GenericWidgetEditor {...common} definition={definition} />
      ) : (
        <NativeAppEditor
          {...common}
          provider={provider as NativeProvider}
          presetId={asset?.widget?.presetId ?? presetId ?? undefined}
        />
      )}
      {/* Rendered here rather than inside each provider editor so every Widget reports its
          consumers, and so editing a shared Widget shows what else it would change. */}
      {asset && (
        <UsedByPanel
          emptyMessage="No playlist or Layout uses this Widget yet."
          groups={[
            {
              label: "Playlists",
              items: asset.playlistsUsing ?? [],
              to: (playlistId) => `/playlists/${playlistId}`,
            },
            {
              label: "Layouts",
              items: (asset.layoutUsage ?? []).map((usage) => ({
                id: usage.id,
                name: usage.name,
                hint: usage.published ? "Published" : "Draft",
              })),
              to: (layoutId) => `/layouts/${layoutId}`,
            },
          ]}
        />
      )}
    </section>
  );
}
