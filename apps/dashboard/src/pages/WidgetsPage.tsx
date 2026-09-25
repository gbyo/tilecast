import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Grid2X2, List, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router";
import { apiErrorMessage } from "../i18n";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
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
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
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
import {
  AssetCollection,
  WebsiteEditor,
  canManageContent,
} from "./ContentPage";

export function WidgetsPage() {
  const { t } = useTranslation(["content", "common"]);
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
  const providerOptions = [
    { value: "", label: t("widgets.list.allTypes") },
    ...filterProviders.map((item) => ({ value: item.id, label: item.name })),
  ];
  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateWidget(id, csrf),
    onSuccess: (widget) => {
      toast.add({ title: "Widget duplicated.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      void navigate(`/widgets/${widget.id}`);
    },
  });
  return (
    <section className="w-full min-w-0 space-y-5">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{t("widgets.list.title")}</h1>
          {canManage && (
            <Button type="button" onClick={() => void navigate("/widgets/new")}>
              <Plus size={16} aria-hidden="true" /> {t("widgets.list.create")}
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("widgets.list.subtitle")}
        </p>
      </header>
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label={t("widgets.list.search")}
          placeholder={t("widgets.list.search")}
        />
        <Select
          items={providerOptions}
          value={provider}
          onValueChange={(next) => {
            if (typeof next === "string") setProvider(next);
          }}
        >
          <SelectTrigger
            aria-label={t("widgets.list.filterProvider")}
            className="w-56 max-sm:flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">{t("widgets.list.allTypes")}</SelectItem>
            {filterProviders.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup
          aria-label={t("widgets.list.view")}
          variant="outline"
          spacing={0}
          multiple={false}
          value={[view]}
          onValueChange={(next) => {
            const first = next[0];
            if (first === "grid" || first === "list") setView(first);
          }}
        >
          <ToggleGroupItem value="grid" aria-label={t("widgets.list.gridView")}>
            <Grid2X2 size={16} aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label={t("widgets.list.listView")}>
            <List size={16} aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </DashboardListToolbar>
      {widgets.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {widgets.error instanceof ApiError
              ? apiErrorMessage(widgets.error)
              : t("widgets.list.loadError")}
          </AlertDescription>
        </Alert>
      )}
      {widgets.isLoading ? (
        <div className="grid gap-2" aria-label={t("widgets.list.loading")}>
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : widgets.data?.items?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plus size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("widgets.list.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("widgets.list.emptyHint")}</EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <Button
                type="button"
                onClick={() => void navigate("/widgets/new")}
              >
                {t("widgets.list.create")}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <AssetCollection
            items={widgets.data?.items ?? []}
            view={view}
            onSelect={(widget) => void navigate(`/widgets/${widget.id}`)}
            canManage={canManage}
            onDuplicate={(widget) => duplicate.mutate(widget.id)}
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
  const { t } = useTranslation(["content", "common"]);
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
  const returnTo = inAppPath(search.get("returnTo"));
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
    const query = new URLSearchParams();
    if (returnTo) query.set("returnTo", returnTo);
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
    return (
      <Skeleton
        className="h-24"
        aria-label={t("widgets.detail.loadingWidget")}
      />
    );
  if (definitions.isLoading)
    return (
      <Skeleton
        className="h-24"
        aria-label={t("widgets.detail.loadingDefinition")}
      />
    );
  if ((id && widget.isError) || definitions.isError) {
    const error = id && widget.isError ? widget.error : definitions.error;
    return (
      <section className="w-full min-w-0 space-y-5">
        <Alert variant="destructive">
          <AlertDescription>
            {error instanceof ApiError
              ? apiErrorMessage(error)
              : t("widgets.list.loadError")}
          </AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={close}>
          {t("widgets.detail.backToWidgets")}
        </Button>
      </section>
    );
  }
  if ((id && !asset) || !provider || !definition) {
    return (
      <section className="w-full min-w-0 space-y-5">
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("widgets.detail.unavailableTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("widgets.detail.unavailableHint")}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" onClick={close}>
              {t("widgets.detail.backToWidgets")}
            </Button>
          </EmptyContent>
        </Empty>
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
      {asset && (
        <UsedByPanel
          emptyMessage={t("widgets.detail.noUsage")}
          groups={[
            {
              label: t("widgets.detail.usedInPlaylists"),
              items: asset.playlistsUsing ?? [],
              to: (playlistId) => `/playlists/${playlistId}`,
            },
            {
              label: t("widgets.detail.usedInLayouts"),
              items: (asset.layoutUsage ?? []).map((usage) => ({
                id: usage.id,
                name: usage.name,
                hint: usage.published
                  ? t("widgets.detail.published")
                  : t("widgets.detail.draft"),
              })),
              to: (layoutId) => `/layouts/${layoutId}`,
            },
          ]}
        />
      )}
    </section>
  );
}
