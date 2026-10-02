// ScreenContentChain walks the dependency graph downward from a screen so the operator can see
// which assigned presentation, widgets, and data sources contribute to its current content.
import { useQuery } from "@tanstack/react-query";
import { layoutQueries } from "../data/layouts";

import { playlistQueries } from "../data/playlists";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ReactNode } from "react";
import { AlertTriangle, Database, Layers3, ListVideo } from "lucide-react";
import { ApiError, api } from "../api/client";
import type { DataSourceDetail } from "../api/types";
import type { PlaylistAssignment } from "../api/types";
import { apiErrorMessage } from "../i18n";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { AspectRatio } from "../components/ui/aspect-ratio";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Skeleton } from "../components/ui/skeleton";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../components/ui/hover-card";

type WidgetsT = TFunction<["content", "common"], undefined>;

function sourceStatus(status: string, recordCount: number, t: WidgetsT) {
  if (status === "error") {
    return {
      label: t("widgets.chain.sourceFailed"),
      variant: "destructive" as const,
    };
  }
  if (status !== "ready") {
    // Server data-source status values render as-is; only "error" and "ready" above are Studio states.
    return {
      label: status.replaceAll("_", " "), // i18n-ignore: server status value
      variant: "outline" as const,
    };
  }
  return {
    label: t("widgets.chain.records", { count: recordCount }),
    variant: "secondary" as const,
  };
}

export function ScreenContentChain({
  assignment,
}: {
  assignment?: PlaylistAssignment;
}) {
  const { t } = useTranslation(["content", "common"]);
  const layoutId = assignment?.layoutId;
  const playlistId = assignment?.playlistId;
  const layout = useQuery(layoutQueries.detail(layoutId ?? ""));
  const playlist = useQuery(playlistQueries.detail(playlistId ?? ""));
  // Dependency IDs are known up front, so resolve them directly instead of
  // intersecting against a catalog page. A 404 means the source is gone;
  // anything else fails the whole lookup like before.
  const layoutDepIds = (layout.data?.dependencies ?? [])
    .filter((dependency) => dependency.type === "data_source")
    .map((dependency) => dependency.id);
  const playlistDepIds = playlist.data?.dataSourceIds ?? [];
  const depIds = [...new Set([...layoutDepIds, ...playlistDepIds])];
  const sources = useQuery({
    queryKey: ["screen-chain-data-sources", [...depIds].sort().join(",")],
    queryFn: () =>
      Promise.all(
        depIds.map(async (id) => {
          try {
            return { id, detail: await api.getDataSource(id) };
          } catch (error) {
            if (error instanceof ApiError && error.status === 404)
              return { id, detail: null };
            throw error;
          }
        }),
      ),
    enabled:
      Boolean(layoutId || playlistId) &&
      (!layoutId || layout.data != null) &&
      (!playlistId || playlist.data != null) &&
      depIds.length > 0,
  });

  if (!layoutId && !playlistId) {
    return (
      <p className="border-y border-border py-4 text-sm text-muted-foreground">
        {t("widgets.chain.unassigned")}
      </p>
    );
  }

  const details = new Map(
    (sources.data ?? []).map((entry) => [entry.id, entry.detail] as const),
  );
  const pick = (ids: string[]): DataSourceDetail[] =>
    ids
      .map((id) => details.get(id))
      .filter((detail): detail is DataSourceDetail => detail != null);
  const missing = (ids: string[]) =>
    ids.filter((id) => details.get(id) === null);
  const layoutSources = pick(layoutDepIds);
  const layoutMissing = missing(layoutDepIds);
  const playlistSources = pick(playlistDepIds);
  const playlistMissing = missing(playlistDepIds);
  const widgetItems = (playlist.data?.items ?? []).filter(
    (item) => item.assetType === "widget",
  );
  const layoutDataSourceCount =
    layout.data?.dependencies.filter(
      (dependency) => dependency.type === "data_source",
    ).length ?? 0;

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="screen-chain-title">
      <header>
        <h3 id="screen-chain-title" className="text-sm font-semibold">
          {t("widgets.chain.title")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("widgets.chain.subtitle")}
        </p>
      </header>

      {layoutId && (
        <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
          <Item size="xs" className="rounded-none px-0">
            <ItemContent>
              <ItemTitle>
                <ResourcePreviewLink
                  to={`/layouts/${layoutId}`}
                  title={
                    assignment?.layoutName ?? t("widgets.chain.assignedLayout")
                  }
                  metadata={
                    layout.data
                      ? `${layout.data.canvasWidth} × ${layout.data.canvasHeight} px · ${t("widgets.chain.layoutDataSources", { count: layoutDataSourceCount })}`
                      : t("widgets.chain.layoutPreview")
                  }
                  imageUrl={layout.data?.previewImageUrl}
                  fallback={<Layers3 aria-hidden="true" />}
                />
              </ItemTitle>
              <ItemDescription>
                {t("widgets.chain.publishedLayout")}
              </ItemDescription>
            </ItemContent>
          </Item>
          {layout.isLoading || sources.isLoading ? (
            <Skeleton className="my-2 h-10 w-full" />
          ) : layout.error ? (
            <DependencyError
              title={t("widgets.chain.layoutDepsError")}
              message={apiErrorMessage(layout.error)}
            />
          ) : layoutDepIds.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              {t("widgets.chain.layoutNoSources")}
            </p>
          ) : (
            <>
              {layoutSources.map((source) => (
                <SourceItem key={source.id} source={source} t={t} />
              ))}
              {layoutMissing.map((id) => (
                <MissingSourceItem key={id} id={id} t={t} />
              ))}
            </>
          )}
        </ItemGroup>
      )}

      {playlistId && (
        <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
          <Item size="xs" className="rounded-none px-0">
            <ItemContent>
              <ItemTitle>
                <ResourcePreviewLink
                  to={`/playlists/${playlistId}`}
                  title={
                    assignment?.playlistName ??
                    t("widgets.chain.assignedPlaylist")
                  }
                  metadata={`${t("widgets.chain.playlistItemCount", { count: playlist.data?.itemCount ?? 0 })}${playlist.data?.revision ? ` · ${t("widgets.chain.playlistRevision", { revision: playlist.data.revision })}` : ""}`}
                  imageUrl={playlist.data?.items[0]?.thumbnailUrl}
                  fallback={<ListVideo aria-hidden="true" />}
                />
              </ItemTitle>
              <ItemDescription>
                {t("widgets.chain.playlistItemCount", {
                  count: playlist.data?.itemCount ?? 0,
                })}
              </ItemDescription>
            </ItemContent>
          </Item>
          {playlist.isLoading || sources.isLoading ? (
            <Skeleton className="my-2 h-10 w-full" />
          ) : playlist.error ? (
            <DependencyError
              title={t("widgets.chain.playlistDepsError")}
              message={apiErrorMessage(playlist.error)}
            />
          ) : (
            <>
              {widgetItems.map((item) => (
                <Item
                  key={item.id}
                  size="xs"
                  render={<Link to={`/widgets/${item.assetId}`} />}
                  className="rounded-none px-0"
                >
                  <ItemContent>
                    <ItemTitle>{item.assetName}</ItemTitle>
                    <ItemDescription>
                      {t("widgets.chain.widgetKind")}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
              {playlistSources.map((source) => (
                <SourceItem key={source.id} source={source} t={t} />
              ))}
              {playlistMissing.map((id) => (
                <MissingSourceItem key={id} id={id} t={t} />
              ))}
              {!widgetItems.length && playlistDepIds.length === 0 && (
                <p className="py-3 text-sm text-muted-foreground">
                  {t("widgets.chain.playlistNoSources")}
                </p>
              )}
            </>
          )}
        </ItemGroup>
      )}

      {sources.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>{t("widgets.chain.sourcesError")}</AlertTitle>
          <AlertDescription>{apiErrorMessage(sources.error)}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function ResourcePreviewLink({
  to,
  title,
  metadata,
  imageUrl,
  fallback,
}: {
  to: string;
  title: string;
  metadata: string;
  imageUrl?: string;
  fallback: ReactNode;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Link
            className="inline-flex min-w-0 items-center gap-2 text-inherit hover:underline"
            to={to}
          />
        }
      >
        {fallback}
        {title}
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="grid w-72 gap-3">
        {imageUrl ? (
          <AspectRatio
            ratio={16 / 9}
            className="overflow-hidden rounded-md bg-muted"
          >
            <img className="size-full object-cover" src={imageUrl} alt="" />
          </AspectRatio>
        ) : (
          <div className="grid aspect-video place-items-center rounded-md bg-muted text-muted-foreground">
            {fallback}
          </div>
        )}
        <div className="grid gap-1">
          <p className="font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{metadata}</p>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function SourceItem({
  source,
  t,
}: {
  source: {
    id: string;
    name: string;
    status: string;
    cachedRecordCount: number;
  };
  t: WidgetsT;
}) {
  const status = sourceStatus(source.status, source.cachedRecordCount, t);
  return (
    <Item
      size="xs"
      render={<Link to={`/data-sources/${source.id}`} />}
      className="rounded-none px-0"
    >
      <ItemContent>
        <ItemTitle>
          <Database
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {source.name}
        </ItemTitle>
        <ItemDescription>{t("widgets.chain.sourceKind")}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant={status.variant}>{status.label}</Badge>
      </ItemActions>
    </Item>
  );
}

function MissingSourceItem({ id, t }: { id: string; t: WidgetsT }) {
  return (
    <Item size="xs" className="rounded-none px-0">
      <ItemContent>
        <ItemTitle>
          <AlertTriangle
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          {t("widgets.chain.sourceMissing", { id })}
        </ItemTitle>
        <ItemDescription>{t("widgets.chain.sourceKind")}</ItemDescription>
      </ItemContent>
    </Item>
  );
}

function DependencyError({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <Alert variant="destructive" className="my-2">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
