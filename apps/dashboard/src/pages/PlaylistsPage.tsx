import { useQuery } from "@tanstack/react-query";
import { ListVideo, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import { Button as RheaButton } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { PlaylistCreateDialog } from "../components/playlist-editor/PlaylistCreateDialog";
import { WorkspaceTabs, presentationTabs } from "../navigation/WorkspaceTabs";
import { PlaylistEditorPage } from "../components/playlist-editor/PlaylistEditor";
import {
  canManagePlaylists,
  formatDuration,
  openPlaylistPreview,
  playlistDuration,
  playlistItemUsesFixedDuration,
} from "../components/playlist-editor/playlistEditorModel";

// Keep these helpers available from the page module for existing callers and tests.
export {
  canManagePlaylists,
  formatDuration,
  openPlaylistPreview,
  playlistDuration,
  playlistItemUsesFixedDuration,
};

export { PlaylistEditorPage };

export function PlaylistsPage() {
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = canManagePlaylists(auth.status?.user?.role);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ["playlists", search],
    queryFn: () => api.playlists(search),
  });
  useEffect(() => {
    if (searchParams.get("create") === "1") setCreating(true);
  }, [searchParams]);
  const closeCreate = () => {
    setCreating(false);
    if (searchParams.has("create")) {
      const next = new URLSearchParams(searchParams);
      next.delete("create");
      setSearchParams(next, { replace: true });
    }
  };
  return (
    <section className="grid gap-4">
      <WorkspaceTabs label="Presentations" tabs={presentationTabs} />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Playlists</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ordered fullscreen playback for assigned screens.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <RheaButton type="button" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />
              Create playlist
            </RheaButton>
          </div>
        )}
      </header>
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search playlists"
          placeholder="Search playlists"
        />
      </DashboardListToolbar>
      {query.isLoading ? (
        <div className="grid gap-2">
          <div className="h-12 animate-pulse rounded-xl bg-muted" />
          <div className="h-12 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : query.data?.items?.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ListVideo size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No playlists yet</EmptyTitle>
            <EmptyDescription>
              {canManage
                ? "Create a playlist, then add ready images and videos."
                : "An Owner, Administrator, or Editor can create playlists."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-2">
          {query.data?.items?.map((playlist) => (
            <Link
              key={playlist.id}
              to={`/playlists/${playlist.id}`}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-border p-3 hover:bg-muted"
            >
              <span className="grid min-w-0 gap-0.5">
                <strong className="truncate text-sm">{playlist.name}</strong>
                <small className="truncate text-xs text-muted-foreground">
                  {playlist.description || "No description"}
                </small>
              </span>
              <span className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>Revision {playlist.revision}</span>
                <span>{playlist.itemCount} items</span>
              </span>
            </Link>
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
