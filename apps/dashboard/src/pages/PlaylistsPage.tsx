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
import { Button } from "../components/ui/button";
import {
  Empty,
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
  ItemTitle,
} from "../components/ui/item";
import { PlaylistCreateDialog } from "../components/playlist-editor/PlaylistCreateDialog";
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Playlists</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ordered fullscreen playback for assigned screens.
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
        <ItemGroup className="gap-2">
          {query.data?.items?.map((playlist) => (
            <Item
              key={playlist.id}
              variant="outline"
              render={<Link to={`/playlists/${playlist.id}`} />}
            >
              <ItemContent className="min-w-0">
                <ItemTitle>{playlist.name}</ItemTitle>
                <ItemDescription className="truncate">
                  {playlist.description || "No description"}
                </ItemDescription>
              </ItemContent>
              <ItemActions className="text-xs text-muted-foreground">
                <span>Revision {playlist.revision}</span>
                <span>{playlist.itemCount} items</span>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
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
