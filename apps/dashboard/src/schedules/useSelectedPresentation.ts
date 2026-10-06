import { useQuery } from "@tanstack/react-query";
import type { PlaylistPickerChoice } from "../components/content-picker";
import { layoutQueries } from "../data/layouts";
import { playlistQueries } from "../data/playlists";
import type { PresentationChoice } from "./scheduleEditorModel";

/**
 * What the editor knows about the chosen presentation. The saved schedule
 * already names it; a richer preview comes from the picker's choice or one read
 * of that single resource, never from loading the library. The picker's rows
 * are list summaries, so a playlist's length needs its own read.
 */
export function useSelectedPresentation(
  content: PresentationChoice,
  picked: PlaylistPickerChoice | null,
) {
  const isPlaylist = content.kind === "playlist";
  const pickedPlaylist =
    picked?.kind === "playlist" && picked.playlist.id === content.id
      ? picked.playlist
      : undefined;
  const pickedLayout =
    picked?.kind === "layout" && picked.layout.id === content.id
      ? picked.layout
      : undefined;
  const playlist = useQuery({
    ...playlistQueries.detail(content.id),
    enabled: isPlaylist,
    placeholderData: pickedPlaylist,
  });
  const layout = useQuery({
    ...layoutQueries.detail(content.id),
    enabled: !isPlaylist && !pickedLayout,
  });
  const playlistData = isPlaylist ? playlist.data : undefined;
  const layoutData = !isPlaylist ? (pickedLayout ?? layout.data) : undefined;
  const loading = isPlaylist
    ? !playlistData && playlist.isLoading
    : !layoutData && layout.isLoading;
  const measuring = isPlaylist && playlist.isPlaceholderData;
  return {
    playlist: playlistData,
    layout: layoutData,
    pending: loading || measuring,
  };
}
