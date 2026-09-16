import { useMutation, useQuery } from "@tanstack/react-query";
import { ListVideo, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  PageHeader,
} from "../components/ui";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
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
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"static" | "tag">("static");
  const query = useQuery({
    queryKey: ["playlists", search],
    queryFn: () => api.playlists(search),
  });
  const create = useMutation({
    mutationFn: () =>
      api.createPlaylist({ name, description: "", sourceType }, csrf),
    onSuccess: (playlist) => void navigate(`/playlists/${playlist.id}`),
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
    <section className="playlists-page">
      <WorkspaceTabs label="Presentations" tabs={presentationTabs} />
      <PageHeader
        title="Playlists"
        description="Ordered fullscreen playback for assigned screens."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />
              Create playlist
            </Button>
          ) : undefined
        }
      />
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search playlists"
          placeholder="Search playlists"
        />
      </DashboardListToolbar>
      {query.isLoading ? (
        <div className="table-loading">Loading playlists…</div>
      ) : query.data?.items?.length === 0 ? (
        <EmptyState
          className="content-empty"
          icon={<ListVideo size={24} aria-hidden="true" />}
          title="No playlists yet"
          message={
            canManage
              ? "Create a playlist, then add ready images and videos."
              : "An Owner, Administrator, or Editor can create playlists."
          }
        />
      ) : (
        <div className="playlist-list">
          {query.data?.items?.map((playlist) => (
            <Link key={playlist.id} to={`/playlists/${playlist.id}`}>
              <span>
                <strong>{playlist.name}</strong>
                <small>{playlist.description || "No description"}</small>
              </span>
              <span>Revision {playlist.revision}</span>
              <span>{playlist.itemCount} items</span>
            </Link>
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
