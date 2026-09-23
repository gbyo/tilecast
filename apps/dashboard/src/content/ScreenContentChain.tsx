// ScreenContentChain walks the dependency graph downward from a screen so the operator can see
// which assigned presentation, widgets, and data sources contribute to its current content.
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { AlertTriangle, Database, Layers3, ListVideo } from "lucide-react";
import { api } from "../api/client";
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

function sourceStatus(status: string, recordCount: number) {
  if (status === "error") {
    return { label: "Last refresh failed", variant: "destructive" as const };
  }
  if (status !== "ready") {
    return { label: status.replaceAll("_", " "), variant: "outline" as const };
  }
  return {
    label: `${recordCount} record${recordCount === 1 ? "" : "s"}`,
    variant: "secondary" as const,
  };
}

export function ScreenContentChain({
  assignment,
}: {
  assignment?: PlaylistAssignment;
}) {
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
        No content is assigned directly to this screen. Schedules and Display
        Group assignments can still select content for playback.
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
          Content and data on this screen
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Follow the assigned presentation to its reusable content and data.
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
                {assignment?.layoutName ?? "Assigned layout"}
              </ItemTitle>
              <ItemDescription>Published layout</ItemDescription>
            </ItemContent>
          </Item>
          {layout.isLoading ? (
            <Skeleton className="my-2 h-10 w-full" />
          ) : layout.error ? (
            <DependencyError
              label="Layout dependencies"
              message={layout.error.message}
            />
          ) : layoutSources.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              This layout reads no data sources.
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
                {assignment?.playlistName ?? "Assigned playlist"}
              </ItemTitle>
              <ItemDescription>
                {playlist.data?.itemCount ?? 0} item
                {playlist.data?.itemCount === 1 ? "" : "s"}
              </ItemDescription>
            </ItemContent>
          </Item>
          {playlist.isLoading ? (
            <Skeleton className="my-2 h-10 w-full" />
          ) : playlist.error ? (
            <DependencyError
              label="Playlist dependencies"
              message={playlist.error.message}
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
                    <ItemDescription>Widget</ItemDescription>
                  </ItemContent>
                </Item>
              ))}
              {playlistSources.map((source) => (
                <SourceItem key={source.id} source={source} />
              ))}
              {!widgetItems.length && !playlistSources.length && (
                <p className="py-3 text-sm text-muted-foreground">
                  Nothing in this playlist reads a data source.
                </p>
              )}
            </>
          )}
        </ItemGroup>
      )}

      {sources.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Data sources could not be resolved</AlertTitle>
          <AlertDescription>{sources.error.message}</AlertDescription>
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
  const status = sourceStatus(source.status, source.cachedRecordCount);
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
        <ItemDescription>Data source</ItemDescription>
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
  return (
    <Alert variant="destructive" className="my-2">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>{label} could not be loaded</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
