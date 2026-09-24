// ScreenContentChain walks the dependency graph downward from a screen so the operator can see
// which assigned presentation, widgets, and data sources contribute to its current content.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertTriangle, Database, Layers3, ListVideo } from "lucide-react";
import { api } from "../api/client";
import { apiErrorMessage } from "../i18n";
import type { PlaylistAssignment } from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Skeleton } from "../components/ui/skeleton";

function sourceStatus(
  status: string,
  recordCount: number,
  t: TFunction<"content">,
) {
  if (status === "error") {
    return {
      label: t("preview.chain.statusError"),
      variant: "destructive" as const,
    };
  }
  if (status !== "ready") {
    return { label: status.replaceAll("_", " "), variant: "outline" as const };
  }
  return {
    label: t("preview.chain.statusRecords", { count: recordCount }),
    variant: "secondary" as const,
  };
}

export function ScreenContentChain({
  assignment,
}: {
  assignment?: PlaylistAssignment;
}) {
  const { t } = useTranslation("content");
  const layoutId = assignment?.layoutId;
  const playlistId = assignment?.playlistId;
  const layout = useQuery({
    queryKey: ["layouts", layoutId],
    queryFn: () => api.layout(layoutId!),
    enabled: Boolean(layoutId),
  });
  const playlist = useQuery({
    queryKey: ["playlists", playlistId],
    queryFn: () => api.playlist(playlistId!),
    enabled: Boolean(playlistId),
  });
  const sources = useQuery({
    queryKey: ["screen-chain-data-sources"],
    queryFn: () =>
      api.listDataSources(
        new URLSearchParams({ page: "1", pageSize: "100", sort: "name" }),
      ),
    enabled: Boolean(layoutId || playlistId),
  });

  if (!layoutId && !playlistId) {
    return (
      <p className="border-y border-border py-4 text-sm text-muted-foreground">
        {t("preview.chain.empty")}
      </p>
    );
  }

  const resolve = (ids: string[]) =>
    (sources.data?.items ?? []).filter((source) => ids.includes(source.id));
  const layoutSources = resolve(
    (layout.data?.dependencies ?? [])
      .filter((dependency) => dependency.type === "data_source")
      .map((dependency) => dependency.id),
  );
  const playlistSources = resolve(playlist.data?.dataSourceIds ?? []);
  const widgetItems = (playlist.data?.items ?? []).filter(
    (item) => item.assetType === "widget",
  );

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="screen-chain-title">
      <header>
        <h3 id="screen-chain-title" className="text-sm font-semibold">
          {t("preview.chain.title")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("preview.chain.subtitle")}
        </p>
      </header>

      {layoutId && (
        <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
          <Item
            size="xs"
            render={<Link to={`/layouts/${layoutId}`} />}
            className="rounded-none px-0"
          >
            <ItemContent>
              <ItemTitle>
                <Layers3
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                {assignment?.layoutName ?? t("preview.chain.layoutFallback")}
              </ItemTitle>
              <ItemDescription>
                {t("preview.chain.layoutDescription")}
              </ItemDescription>
            </ItemContent>
          </Item>
          {layout.isLoading ? (
            <Skeleton className="my-2 h-10 w-full" />
          ) : layout.error ? (
            <DependencyError
              label={t("preview.chain.layoutDeps")}
              message={apiErrorMessage(layout.error)}
            />
          ) : layoutSources.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              {t("preview.chain.layoutEmpty")}
            </p>
          ) : (
            layoutSources.map((source) => (
              <SourceItem key={source.id} source={source} />
            ))
          )}
        </ItemGroup>
      )}

      {playlistId && (
        <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
          <Item
            size="xs"
            render={<Link to={`/playlists/${playlistId}`} />}
            className="rounded-none px-0"
          >
            <ItemContent>
              <ItemTitle>
                <ListVideo
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                {assignment?.playlistName ??
                  t("preview.chain.playlistFallback")}
              </ItemTitle>
              <ItemDescription>
                {t("preview.chain.playlistItems", {
                  count: playlist.data?.itemCount ?? 0,
                })}
              </ItemDescription>
            </ItemContent>
          </Item>
          {playlist.isLoading ? (
            <Skeleton className="my-2 h-10 w-full" />
          ) : playlist.error ? (
            <DependencyError
              label={t("preview.chain.playlistDeps")}
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
                      {t("preview.chain.widgetDescription")}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
              {playlistSources.map((source) => (
                <SourceItem key={source.id} source={source} />
              ))}
              {!widgetItems.length && !playlistSources.length && (
                <p className="py-3 text-sm text-muted-foreground">
                  {t("preview.chain.playlistEmpty")}
                </p>
              )}
            </>
          )}
        </ItemGroup>
      )}

      {sources.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>{t("preview.chain.resolveError")}</AlertTitle>
          <AlertDescription>{apiErrorMessage(sources.error)}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function SourceItem({
  source,
}: {
  source: {
    id: string;
    name: string;
    status: string;
    cachedRecordCount: number;
  };
}) {
  const { t } = useTranslation("content");
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
        <ItemDescription>
          {t("preview.chain.sourceDescription")}
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Badge variant={status.variant}>{status.label}</Badge>
      </ItemActions>
    </Item>
  );
}

function DependencyError({
  label,
  message,
}: {
  label: string;
  message: string;
}) {
  const { t } = useTranslation("content");
  return (
    <Alert variant="destructive" className="my-2">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{t("preview.chain.depsErrorTitle", { label })}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
