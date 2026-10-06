import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Blocks, Plus, SearchX } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import { api, ApiError } from "../api/client";
import type { Asset } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { contentKeys, contentQueries } from "../data/content";
import {
  WidgetLibrary,
  WidgetLibrarySkeleton,
} from "../components/content/widgets/WidgetLibrary";
import {
  defaultWidgetSort,
  widgetAssetParams,
  widgetTypeGroups,
  type WidgetSort,
  type WidgetView,
} from "../components/content/widgets/widgetLibraryModel";
import { WidgetsToolbar } from "../components/content/widgets/WidgetsToolbar";
import {
  WidgetProviderGallery,
  YouTubeSourceEditor,
} from "../content/SourceEditors";
import { GenericWidgetEditor } from "../content/GenericDefinitionEditors";
import { V2WidgetEditor } from "../content/V2WidgetEditor";
import { UsedByPanel } from "../content/UsedByPanel";
import { WidgetSnapshotBackfill } from "../content/WidgetSnapshotBackfill";
import { useCompactLayout } from "../hooks/use-compact-layout";
import { inAppPath, withParam } from "../navigation/returnPaths";
import { WebsiteEditor, canManageContent } from "./ContentPage";

export function WidgetsPage() {
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const compact = useCompactLayout();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = canManageContent(auth.status?.user);
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [sort, setSort] = useState<WidgetSort>(defaultWidgetSort);
  const [view, setView] = useState<WidgetView>("grid");
  // Search, type, and sort all restart paging. The view is presentation only,
  // so it stays out of the query.
  const widgets = useInfiniteQuery(
    contentQueries.assetPages(widgetAssetParams({ search, provider, sort }, 1)),
  );
  const items = useMemo(
    () => widgets.data?.pages.flatMap((page) => page.items) ?? [],
    [widgets.data],
  );
  // The server total, not the loaded count: paging may have fetched only part.
  const total = widgets.data?.pages.at(-1)?.total;
  // The catalog only names and groups types. The library must keep working
  // without it, so a failed catalog never hides saved Widgets.
  const definitions = useQuery(contentQueries.definitions());
  const definitionsById = useMemo(
    () =>
      new Map((definitions.data?.widgets ?? []).map((item) => [item.id, item])),
    [definitions.data],
  );
  const typeGroups = useMemo(
    () => widgetTypeGroups(definitions.data?.widgets ?? [], t, locale),
    [definitions.data, t, locale],
  );
  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateWidget(id, csrf),
    onSuccess: (widget) => {
      toast.add({ title: t("widgets.duplicateSuccess"), type: "success" });
      void queryClient.invalidateQueries({ queryKey: contentKeys.assets });
      void navigate(`/widgets/${widget.id}`);
    },
    onError: (error) => {
      toast.add({
        title: t("widgets.duplicateFailed"),
        description: apiErrorMessage(error),
        type: "error",
      });
    },
  });
  const filtered = search !== "" || provider !== "";
  const createLabel = t("widgets.list.create");

  return (
    <section className="w-full min-w-0 space-y-5">
      <h1 className="sr-only">{t("widgets.list.title")}</h1>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {typeof total === "number" ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {t("widgets.list.count", { count: total })}
            </p>
          ) : widgets.isLoading ? (
            <Skeleton className="h-5 w-24" />
          ) : null}
          {canManage && (
            <Link
              className={buttonVariants({
                variant: "default",
                className: "ml-auto",
              })}
              to="/widgets/new"
              aria-label={compact ? createLabel : undefined}
            >
              <Plus aria-hidden="true" />
              {compact ? t("widgets.list.createShort") : createLabel}
            </Link>
          )}
        </div>
        <Separator />
      </div>
      <WidgetsToolbar
        search={search}
        onSearchChange={setSearch}
        provider={provider}
        onProviderChange={setProvider}
        typeGroups={typeGroups}
        sort={sort}
        onSortChange={setSort}
        view={view}
        onViewChange={setView}
      />
      {widgets.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {widgets.error instanceof ApiError
                ? apiErrorMessage(widgets.error)
                : t("widgets.list.loadError")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={widgets.isFetching}
              onClick={() => void widgets.refetch()}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {widgets.isLoading ? (
        <WidgetLibrarySkeleton view={view} />
      ) : items.length > 0 ? (
        <>
          <WidgetLibrary
            items={items}
            definitions={definitionsById}
            view={view}
            canManage={canManage}
            duplicating={duplicate.isPending}
            onDuplicate={(asset: Asset) => duplicate.mutate(asset.id)}
          />
          {widgets.hasNextPage && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={widgets.isFetchingNextPage}
                onClick={() => void widgets.fetchNextPage()}
              >
                {widgets.isFetchingNextPage && <Spinner aria-hidden="true" />}
                {t("common:actions.loadMore")}
              </Button>
            </div>
          )}
        </>
      ) : widgets.isError ? null : filtered ? (
        // A search or type that matches nothing is not an empty library, so it
        // offers a way back instead of the create prompt. Sort and view are
        // preferences, not filters, and survive the reset.
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("widgets.list.filteredEmptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("widgets.list.filteredEmptyHint")}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSearch("");
                setProvider("");
              }}
            >
              {t("widgets.list.clearFilters")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Blocks aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("widgets.list.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("widgets.list.emptyHint")}</EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <Link
                className={buttonVariants({ variant: "default" })}
                to="/widgets/new"
              >
                {createLabel}
              </Link>
            </EmptyContent>
          )}
        </Empty>
      )}
      {/* Discovery runs independently of visible search and provider filters, including while the
          filtered library is empty or still loading. Only content managers can upload captures. */}
      <WidgetSnapshotBackfill enabled={canManage} />
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
      ) : definition?.component ? (
        // Migrated V2 Widgets author through the generic V2 editor and its
        // real shared preview. Component presence is the routing rule, so
        // the next migrated Widget needs no editor change to land here.
        <V2WidgetEditor
          {...common}
          definition={definition}
          catalog={definitions.data}
        />
      ) : definition ? (
        // Every remaining definition authors through the generic manifest
        // editor. There is intentionally no native-editor fallback here; see
        // WidgetEditorExperience.test.tsx.
        <GenericWidgetEditor {...common} definition={definition} />
      ) : null}
      {/* Rendered here rather than inside each provider editor so every Widget reports its
          consumers, and so editing a shared Widget shows what else it would change. */}
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
