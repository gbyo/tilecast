import { useQuery } from "@tanstack/react-query";
import { Check, LayoutTemplate, ListVideo, Tags } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { LayoutSummary, Playlist } from "../../api/types";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { DashboardSearch } from "../DashboardListToolbar";
import { LayoutPreview, PlaylistPreview } from "../PresentationPreview";

export type PlaylistPickerChoice =
  | { kind: "playlist"; playlist: Playlist }
  | { kind: "layout"; layout: LayoutSummary };

export type PlaylistPickerKind = PlaylistPickerChoice["kind"];

export type PlaylistPickerProps = {
  open: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  /**
   * Also offer published Layouts. Schedules can target either, while a playlist zone
   * inside a Layout can only hold a playlist.
   */
  includeLayouts?: boolean;
  /** Narrow the picker to one kind when a caller has separate content tabs. */
  allowedKinds?: readonly PlaylistPickerKind[];
  /** Highlighted on open, so reopening the picker shows the current choice. */
  selectedId?: string;
  onConfirm: (choice: PlaylistPickerChoice) => void;
  onClose: () => void;
};

/**
 * Browses the whole playlist library rather than a fixed shelf: search runs server-side
 * so entries past the first page are still reachable.
 */
export function PlaylistPicker({
  open,
  title,
  description,
  confirmLabel = "Add playlist",
  includeLayouts = false,
  allowedKinds,
  selectedId = "",
  onConfirm,
  onClose,
}: PlaylistPickerProps) {
  const kinds: readonly PlaylistPickerKind[] =
    allowedKinds ?? (includeLayouts ? ["playlist", "layout"] : ["playlist"]);
  const canChoosePlaylists = kinds.includes("playlist");
  const canChooseLayouts = kinds.includes("layout");
  const mixedKinds = canChoosePlaylists && canChooseLayouts;
  const noun = mixedKinds
    ? "presentations"
    : canChooseLayouts
      ? "layouts"
      : "playlists";
  const defaultTitle = mixedKinds
    ? "Choose presentation"
    : canChooseLayouts
      ? "Choose layout"
      : "Choose playlist";
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState(selectedId);
  const playlists = useQuery({
    queryKey: ["playlist-picker", "playlists", search],
    queryFn: () => api.playlists(search),
    enabled: open && canChoosePlaylists,
  });
  const layouts = useQuery({
    queryKey: ["playlist-picker", "layouts", search],
    queryFn: () => api.layouts(search),
    enabled: open && canChooseLayouts,
  });

  const playlistItems = canChoosePlaylists ? (playlists.data?.items ?? []) : [];
  // An unpublished Layout has nothing a player could show, so it is not offerable.
  const layoutItems = canChooseLayouts
    ? (layouts.data?.items ?? []).filter((layout) => layout.publishedRevision)
    : [];
  const choices: PlaylistPickerChoice[] = [
    ...playlistItems.map((playlist) => ({
      kind: "playlist" as const,
      playlist,
    })),
    ...layoutItems.map((layout) => ({ kind: "layout" as const, layout })),
  ];
  const idOf = (choice: PlaylistPickerChoice) =>
    choice.kind === "playlist" ? choice.playlist.id : choice.layout.id;
  const selected = choices.find((choice) => idOf(choice) === chosen);

  const loading =
    (canChoosePlaylists && playlists.isLoading) ||
    (canChooseLayouts && layouts.isLoading);
  const failed =
    (canChoosePlaylists && playlists.isError) ||
    (canChooseLayouts && layouts.isError);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="flex max-h-[min(90vh,45rem)] max-w-xl flex-col gap-3 overflow-hidden">
        <DialogHeader>
          <DialogTitle>{title ?? defaultTitle}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DashboardSearch
          autoFocus
          value={search}
          onValueChange={setSearch}
          label={`Search ${noun}`}
          placeholder={`Search ${noun}`}
        />
        <div className="playlist-picker__results">
          {loading ? (
            <div className="space-y-2" aria-label={`Loading ${noun}`}>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : failed ? (
            <Alert variant="destructive">
              <AlertTitle>
                {noun.charAt(0).toUpperCase() + noun.slice(1)} could not be
                loaded.
              </AlertTitle>
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>Retry the library request.</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (canChoosePlaylists) void playlists.refetch();
                    if (canChooseLayouts) void layouts.refetch();
                  }}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : !choices.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {search
                ? `No ${noun} match this search.`
                : `No ${noun} yet. Create one first.`}
            </p>
          ) : (
            choices.map((choice) => {
              const id = idOf(choice);
              const tagDriven =
                choice.kind === "playlist" &&
                choice.playlist.sourceType === "tag";
              return (
                <button
                  type="button"
                  key={`${choice.kind}-${id}`}
                  className={id === chosen ? "is-selected" : ""}
                  aria-pressed={id === chosen}
                  onClick={() => setChosen(id)}
                  onDoubleClick={() => onConfirm(choice)}
                >
                  <span
                    className="playlist-picker__preview"
                    data-orientation={
                      choice.kind === "layout"
                        ? choice.layout.orientation
                        : undefined
                    }
                    aria-hidden="true"
                  >
                    {choice.kind === "layout" ? (
                      <LayoutPreview layout={choice.layout} />
                    ) : (
                      <PlaylistPreview playlist={choice.playlist} />
                    )}
                  </span>
                  <span className="playlist-picker__icon" aria-hidden="true">
                    {choice.kind === "layout" ? (
                      <LayoutTemplate size={17} />
                    ) : tagDriven ? (
                      <Tags size={17} />
                    ) : (
                      <ListVideo size={17} />
                    )}
                  </span>
                  <span className="playlist-picker__label">
                    <strong>
                      {choice.kind === "playlist"
                        ? choice.playlist.name
                        : choice.layout.name}
                    </strong>
                    <small>
                      {choice.kind === "layout"
                        ? `Layout · revision ${choice.layout.publishedRevision}`
                        : `${choice.playlist.itemCount} item${
                            choice.playlist.itemCount === 1 ? "" : "s"
                          }${tagDriven ? " · tag-driven" : ""}`}
                    </small>
                  </span>
                  {id === chosen && <Check size={17} aria-hidden="true" />}
                </button>
              );
            })
          )}
        </div>
        <DialogFooter className="border-t border-border pt-3">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            disabled={!selected}
            onClick={() => selected && onConfirm(selected)}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
