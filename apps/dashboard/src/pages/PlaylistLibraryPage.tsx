import {
  Button,
  Dialog,
  EmptyState,
  Field,
  PageHeader,
  Select,
  ViewToggle,
} from "../components/legacy-ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronRight, ListVideo, Plus, Tags } from "lucide-react";
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
import { WorkspaceTabs, presentationTabs } from "../navigation/WorkspaceTabs";
import "./PlaylistLibraryPage.css";

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
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"static" | "tag">("static");
  const query = useQuery({
    queryKey: ["playlists", "library"],
    queryFn: () => api.playlists(""),
  });
  const create = useMutation({
    mutationFn: () =>
      api.createPlaylist({ name, description: "", sourceType }, csrf),
    onSuccess: (playlist) => void navigate(`/playlists/${playlist.id}`),
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
    <section className="playlist-library-page">
      <WorkspaceTabs label="Presentations" tabs={presentationTabs} />
      <PageHeader
        title="Playlists"
        description="Find, preview, and organize fullscreen playback for your screens."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />
              Create playlist
            </Button>
          ) : undefined
        }
      />
      <DashboardListToolbar className="playlist-library-toolbar">
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search playlists"
          placeholder="Search names, descriptions, or previewed content"
        />
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Filter playlists"
          value={filter}
          onChange={(event) =>
            setFilter(event.target.value as PlaylistLibraryFilter)
          }
        >
          <option value="all">All playlists</option>
          <option value="standard">Standard playlists</option>
          <option value="tag">Tag-driven playlists</option>
          <option value="empty">Empty playlists</option>
        </Select>
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Sort playlists"
          value={sort}
          onChange={(event) =>
            setSort(event.target.value as PlaylistLibrarySort)
          }
        >
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
          <option value="items">Most items</option>
          <option value="created">Recently created</option>
        </Select>
        <ViewToggle
          value={view}
          onValueChange={setView}
          label="Playlist view"
        />
      </DashboardListToolbar>

      {!query.isLoading && allPlaylists.length > 0 && (
        <div className="playlist-library-summary" aria-live="polite">
          Showing {visiblePlaylists.length} of {allPlaylists.length} playlists
        </div>
      )}

      {query.isLoading ? (
        <div className="table-loading">Loading playlists…</div>
      ) : allPlaylists.length === 0 ? (
        <EmptyState
          className="content-empty"
          icon={<ListVideo size={24} aria-hidden="true" />}
          title="No playlists yet"
          message={
            canManage
              ? "Create a playlist, then add ready images, videos, Widgets, or Layouts."
              : "An Owner, Administrator, or Editor can create playlists."
          }
          action={
            canManage ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create playlist
              </Button>
            ) : undefined
          }
        />
      ) : visiblePlaylists.length === 0 ? (
        <EmptyState
          className="content-empty"
          icon={<ListVideo size={24} aria-hidden="true" />}
          title="No matching playlists"
          message="Try a different search or clear the playlist filter."
          action={
            <Button variant="secondary" onClick={clearLibraryFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className={`playlist-library playlist-library--${view}`}>
          {visiblePlaylists.map((playlist) => (
            <article
              className="playlist-library-card"
              data-empty={playlist.itemCount === 0 || undefined}
              key={playlist.id}
            >
              <Link
                to={`/playlists/${playlist.id}`}
                title={`Open ${playlist.name}`}
              >
                <div className="playlist-library-card__preview">
                  <PlaylistPreview playlist={playlist} />
                  <span className="playlist-library-card__status">
                    {playlistStatus(playlist)}
                  </span>
                </div>
                <div className="playlist-library-card__body">
                  <div className="playlist-library-card__heading">
                    <span className="playlist-library-card__title">
                      {playlist.sourceType === "tag" && (
                        <Tags
                          className="playlist-library-card__tag"
                          size={15}
                          role="img"
                          aria-label="Tag-driven playlist"
                        />
                      )}
                      <strong>{playlist.name}</strong>
                    </span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </div>
                  {playlist.description && (
                    <p className="playlist-library-card__description">
                      {playlist.description}
                    </p>
                  )}
                  <div className="playlist-library-card__metadata">
                    <span>{itemCountLabel(playlist.itemCount)}</span>
                    <span>Revision {playlist.revision}</span>
                  </div>
                  <small>{formatPlaylistUpdatedAt(playlist.updatedAt)}</small>
                </div>
              </Link>
            </article>
          ))}
        </div>
      )}

      <Dialog open={creating} title="Create playlist" onClose={closeCreate}>
        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <fieldset className="playlist-type-chooser">
          <legend>Playlist type</legend>
          <button
            type="button"
            aria-pressed={sourceType === "static"}
            onClick={() => setSourceType("static")}
          >
            <strong>Standard playlist</strong>
            <span>Manually arrange media and Layouts in a timeline.</span>
          </button>
          <button
            type="button"
            aria-pressed={sourceType === "tag"}
            onClick={() => setSourceType("tag")}
          >
            <strong>Tag-driven playlist</strong>
            <span>Automatically include ready media that matches tags.</span>
          </button>
        </fieldset>
        {create.error && (
          <div className="notice notice--error">{create.error.message}</div>
        )}
        <div className="form-actions">
          <Button variant="quiet" onClick={closeCreate}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create playlist
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
