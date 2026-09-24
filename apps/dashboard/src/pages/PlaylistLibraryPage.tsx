import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  LayoutGrid,
  List,
  ListVideo,
  Plus,
  Tags,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { Playlist, PlaylistPreviewItem } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import { PlaylistPreview } from "../components/PresentationPreview";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { PlaylistCreateDialog } from "../components/playlist-editor/PlaylistCreateDialog";

export type { PlaylistPreviewItem } from "../api/types";

export type PlaylistLibraryItem = Pick<
  Playlist,
  | "id"
  | "name"
  | "description"
  | "revision"
  | "createdAt"
  | "updatedAt"
  | "itemCount"
  | "sourceType"
> & {
  previewItems?: PlaylistPreviewItem[];
};

export type PlaylistLibraryFilter = "all" | "standard" | "tag" | "empty";
export type PlaylistLibrarySort = "updated" | "name" | "items" | "created";

const playlistFilterOptions = [
  { value: "all", label: "All playlists" },
  { value: "standard", label: "Standard playlists" },
  { value: "tag", label: "Tag-driven playlists" },
  { value: "empty", label: "Empty playlists" },
];

const playlistSortOptions = [
  { value: "updated", label: "Recently updated" },
  { value: "name", label: "Name" },
  { value: "items", label: "Most items" },
  { value: "created", label: "Recently created" },
];

const playlistViewStorageKey = "tilecast.playlist-library.view";
const playlistNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function storedPlaylistView(): "grid" | "list" {
  if (typeof window === "undefined") return "grid";
  try {
    return window.localStorage.getItem(playlistViewStorageKey) === "list"
      ? "list"
      : "grid";
  } catch {
    return "grid";
  }
}

export function filterAndSortPlaylists(
  playlists: PlaylistLibraryItem[],
  search: string,
  filter: PlaylistLibraryFilter,
  sort: PlaylistLibrarySort,
): PlaylistLibraryItem[] {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filtered = playlists.filter((playlist) => {
    if (filter === "standard" && playlist.sourceType === "tag") return false;
    if (filter === "tag" && playlist.sourceType !== "tag") return false;
    if (filter === "empty" && playlist.itemCount !== 0) return false;
    if (!normalizedSearch) return true;
    const searchable = [
      playlist.name,
      playlist.description,
      ...(playlist.previewItems ?? []).map((item) => item.name),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(normalizedSearch);
  });

  return [...filtered].sort((left, right) => {
    if (sort === "name")
      return playlistNameCollator.compare(left.name, right.name);
    if (sort === "items") {
      return (
        right.itemCount - left.itemCount ||
        playlistNameCollator.compare(left.name, right.name)
      );
    }
    if (sort === "created") {
      return (
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        playlistNameCollator.compare(left.name, right.name)
      );
    }
    return (
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      playlistNameCollator.compare(left.name, right.name)
    );
  });
}

export function formatPlaylistUpdatedAt(
  value: string,
  now = Date.now(),
): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Update time unavailable";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "Updated just now";
  if (elapsed < 3_600_000) {
    const minutes = Math.max(1, Math.floor(elapsed / 60_000));
    return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (elapsed < 86_400_000) {
    const hours = Math.max(1, Math.floor(elapsed / 3_600_000));
    return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (elapsed < 604_800_000) {
    const days = Math.max(1, Math.floor(elapsed / 86_400_000));
    return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (new Date(timestamp).getFullYear() !== new Date(now).getFullYear()) {
    options.year = "numeric";
  }
  return `Updated ${new Intl.DateTimeFormat(undefined, options).format(timestamp)}`;
}

function playlistStatus(playlist: PlaylistLibraryItem): string {
  if (playlist.itemCount === 0) return "Empty";
  return playlist.sourceType === "tag" ? "Tag-driven" : "Standard";
}

function itemCountLabel(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

export function PlaylistLibraryPage() {
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = auth.status?.user?.role !== "viewer";
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<PlaylistLibraryFilter>("all");
  const [sort, setSort] = useState<PlaylistLibrarySort>("updated");
  const [view, setView] = useState<"grid" | "list">(storedPlaylistView);
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["playlists", "library"],
    queryFn: () => api.playlists(""),
  });

  useEffect(() => {
    if (searchParams.get("create") === "1") setCreating(true);
  }, [searchParams]);

  useEffect(() => {
    try {
      window.localStorage.setItem(playlistViewStorageKey, view);
    } catch {
      // Storage is a convenience only; the page remains usable without it.
    }
  }, [view]);

  const allPlaylists = useMemo(
    () => (query.data?.items ?? []) as PlaylistLibraryItem[],
    [query.data?.items],
  );
  const visiblePlaylists = useMemo(
    () => filterAndSortPlaylists(allPlaylists, search, filter, sort),
    [allPlaylists, filter, search, sort],
  );

  const closeCreate = () => {
    setCreating(false);
    if (searchParams.has("create")) {
      const next = new URLSearchParams(searchParams);
      next.delete("create");
      setSearchParams(next, { replace: true });
    }
  };
  const clearLibraryFilters = () => {
    setSearch("");
    setFilter("all");
  };

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Playlists</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Find, preview, and organize fullscreen playback for your screens.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />
              Create playlist
            </Button>
          </div>
        )}
      </header>
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search playlists"
          placeholder="Search names, descriptions, or previewed content"
        />
        <Select
          items={playlistFilterOptions}
          value={filter}
          onValueChange={(next) => setFilter(next as PlaylistLibraryFilter)}
        >
          <SelectTrigger
            aria-label="Filter playlists"
            className="w-48 max-sm:flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {playlistFilterOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={playlistSortOptions}
          value={sort}
          onValueChange={(next) => setSort(next as PlaylistLibrarySort)}
        >
          <SelectTrigger
            aria-label="Sort playlists"
            className="w-44 max-sm:flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {playlistSortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup
          aria-label="Playlist view"
          variant="outline"
          spacing={0}
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "grid" || next === "list") setView(next);
          }}
        >
          <ToggleGroupItem value="grid" aria-label="Grid view">
            <LayoutGrid size={16} aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List view">
            <List size={16} aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </DashboardListToolbar>

      {!query.isLoading && allPlaylists.length > 0 && (
        <div className="text-sm text-muted-foreground" aria-live="polite">
          Showing {visiblePlaylists.length} of {allPlaylists.length} playlists
        </div>
      )}

      {query.isLoading ? (
        <div className="grid gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : allPlaylists.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListVideo size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No playlists yet</EmptyTitle>
            <EmptyDescription>
              {canManage
                ? "Create a playlist, then add ready images, videos, Widgets, or Layouts."
                : "An Owner, Administrator, or Editor can create playlists."}
            </EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <Button type="button" onClick={() => setCreating(true)}>
                Create playlist
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : visiblePlaylists.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListVideo size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No matching playlists</EmptyTitle>
            <EmptyDescription>
              Try a different search or clear the playlist filter.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              onClick={clearLibraryFilters}
            >
              Clear filters
            </Button>
          </EmptyContent>
        </Empty>
      ) : view === "list" ? (
        <ItemGroup className="gap-2">
          {visiblePlaylists.map((playlist) => (
            <Item
              key={playlist.id}
              variant="outline"
              render={
                <Link
                  to={`/playlists/${playlist.id}`}
                  title={`Open ${playlist.name}`}
                />
              }
            >
              <ItemMedia
                variant="image"
                className="size-16 rounded-md bg-muted sm:size-20"
              >
                <div className="size-full" aria-hidden="true">
                  <PlaylistPreview playlist={playlist} />
                </div>
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>
                  {playlist.sourceType === "tag" && (
                    <Tags size={15} aria-hidden="true" className="shrink-0" />
                  )}
                  {playlist.name}
                </ItemTitle>
                <ItemDescription>
                  {playlist.description || "No description"}
                </ItemDescription>
                <ItemDescription className="flex flex-wrap items-center gap-x-2">
                  <span>{itemCountLabel(playlist.itemCount)}</span>
                  <span>Revision {playlist.revision}</span>
                  <span>{formatPlaylistUpdatedAt(playlist.updatedAt)}</span>
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge variant="outline">{playlistStatus(playlist)}</Badge>
                <ChevronRight
                  size={17}
                  aria-hidden="true"
                  className="text-muted-foreground"
                />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visiblePlaylists.map((playlist) => (
            <article
              key={playlist.id}
              className="min-w-0 overflow-hidden rounded-xl border border-border"
            >
              <Link
                to={`/playlists/${playlist.id}`}
                title={`Open ${playlist.name}`}
                className="grid gap-3 p-3 hover:bg-muted"
              >
                <div className="relative">
                  <PlaylistPreview playlist={playlist} />
                  <span className="absolute top-2 left-2 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium">
                    {playlistStatus(playlist)}
                  </span>
                </div>
                <div className="grid gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5">
                      {playlist.sourceType === "tag" && (
                        <Tags
                          size={15}
                          role="img"
                          aria-label="Tag-driven playlist"
                          className="shrink-0"
                        />
                      )}
                      <strong className="truncate text-sm">
                        {playlist.name}
                      </strong>
                    </span>
                    <ChevronRight
                      size={17}
                      aria-hidden="true"
                      className="shrink-0 text-muted-foreground"
                    />
                  </div>
                  {playlist.description && (
                    <p className="truncate text-xs text-muted-foreground">
                      {playlist.description}
                    </p>
                  )}
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{itemCountLabel(playlist.itemCount)}</span>
                    <span>Revision {playlist.revision}</span>
                  </div>
                  <small className="text-xs text-muted-foreground">
                    {formatPlaylistUpdatedAt(playlist.updatedAt)}
                  </small>
                </div>
              </Link>
            </article>
          ))}
        </div>
      )}

      <PlaylistCreateDialog
        open={creating}
        csrf={csrf}
        onClose={closeCreate}
        onCreated={(id) => void navigate(`/playlists/${id}`)}
      />
    </section>
  );
}
