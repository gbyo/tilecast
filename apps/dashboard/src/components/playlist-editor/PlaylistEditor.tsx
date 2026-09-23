import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelsTopLeft } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
  AlertDialog as RheaAlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { Button as RheaButton } from "../ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui/resizable";
import { Separator } from "../ui/separator";
import {
  Dialog as RheaDialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Sheet as RheaSheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../ui/drawer";
import { Skeleton } from "../ui/skeleton";
import type {
  Asset,
  Playlist,
  PlaylistItemInput,
  PlaylistBulkItemUpdateInput,
} from "../../api/types";
import { api } from "../../api/client";
import { toast } from "../ui/toast";
import { useAuth } from "../../auth/AuthProvider";
import { ContentPicker, type ContentPickerResult } from "../content-picker";
import { UsedByPanel } from "../../content/UsedByPanel";
import { PlaylistRevisionsPanel } from "../PlaylistRevisionsPanel";
import { useDesktopLayout } from "../../hooks/use-desktop-layout";
import { PlaylistDetailsDrawer } from "./PlaylistDetailsDrawer";
import { PlaylistEditorHeader } from "./PlaylistEditorHeader";
import {
  PlaylistItemInspector,
  PlaylistItemInspectorBody,
} from "./PlaylistItemInspector";
import { PlaylistPlaybackDefaults } from "./PlaylistPlaybackDefaults";
import { PlaylistTimeline } from "./PlaylistTimeline";
import {
  canManagePlaylists,
  movePlaylistItem,
  movePlaylistItemToEdge,
  openPlaylistPreview,
  playlistAuthoringDefaults,
  playlistImageDuration,
  playlistTransition,
  reorderPlaylistItems,
  transitionLabel,
} from "./playlistEditorModel";

export function PlaylistEditorPage() {
  const { id = "" } = useParams();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = canManagePlaylists(auth.status?.user?.role);
  const canPublish = ["owner", "administrator", "editor"].includes(
    auth.status?.user?.role ?? "",
  );
  const canSubmit = canPublish || auth.status?.user?.role === "contributor";
  const navigate = useNavigate();
  const client = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useQuery({
    queryKey: ["playlists", id],
    queryFn: () => api.playlist(id),
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [tagRuleDirty, setTagRuleDirty] = useState(false);
  const [picker, setPicker] = useState(false);
  const [layoutPicker, setLayoutPicker] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [itemInspectorOpen, setItemInspectorOpen] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [draggedItemId, setDraggedItemId] = useState<string>();
  const [sourceType, setSourceType] = useState<"static" | "tag">("static");
  const [tagMatch, setTagMatch] = useState<"any" | "all">("any");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagImageSeconds, setTagImageSeconds] = useState(10);
  const desktop = useDesktopLayout();
  const [addFailure, setAddFailure] = useState("");
  const [editorError, setEditorError] = useState("");
  const [playbackMessage, setPlaybackMessage] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const layouts = useQuery({
    queryKey: ["layouts", "playlist-items"],
    queryFn: () => api.layouts(""),
  });
  const tags = useQuery({
    queryKey: ["content-tags"],
    queryFn: api.contentTags,
  });

  useEffect(() => {
    if (!query.data) return;
    if (!metadataDirty) {
      setName(query.data.name);
      setDescription(query.data.description);
    }
    if (!tagRuleDirty) {
      setSourceType(query.data.sourceType ?? "static");
      setTagMatch(query.data.tagRule?.match ?? "any");
      setTagIds(query.data.tagRule?.tags.map((tag) => tag.id) ?? []);
      setTagImageSeconds((query.data.tagRule?.imageDurationMs ?? 10000) / 1000);
    }
  }, [metadataDirty, query.data, tagRuleDirty]);

  const dirty = metadataDirty || tagRuleDirty;
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const update = (playlist: Playlist) =>
    client.setQueryData(["playlists", id], playlist);

  const save = useMutation({
    mutationFn: () => api.updatePlaylist(id, { name, description }, csrf),
    onSuccess: (playlist) => {
      toast.add({ title: "Playlist details saved.", type: "success" });
      update(playlist);
      setMetadataDirty(false);
      setEditorError("");
    },
    onError: (error) => setEditorError(error.message),
  });

  const saveTagRule = useMutation({
    mutationFn: () =>
      api.setPlaylistTagRule(
        id,
        {
          enabled: sourceType === "tag",
          match: tagMatch,
          imageDurationMs: Math.round(tagImageSeconds * 1000),
          tagIds,
        },
        csrf,
      ),
    onSuccess: (playlist) => {
      toast.add({ title: "Playlist content source saved.", type: "success" });
      update(playlist);
      setTagRuleDirty(false);
      setEditorError("");
    },
    onError: (error) => setEditorError(error.message),
  });

  const publish = useMutation({
    mutationFn: () => {
      const expectedRevision = query.data?.draftRevision ?? 0;
      return canPublish
        ? api.publishPlaylist(id, expectedRevision, csrf)
        : api.submitContent("playlist", id, csrf, undefined, expectedRevision);
    },
    onSuccess: () => {
      toast.add({
        title: canPublish
          ? "Playlist published."
          : "Playlist submitted for review.",
        type: "success",
      });
      void client.invalidateQueries({ queryKey: ["playlists", id] });
      void client.invalidateQueries({ queryKey: ["playlists"] });
      void client.invalidateQueries({ queryKey: ["content-submissions"] });
      void client.invalidateQueries({
        queryKey: ["content-history", "playlist", id],
      });
    },
  });

  const duplicate = useMutation({
    mutationFn: () => api.duplicatePlaylist(id, csrf),
    onSuccess: (playlist) => {
      toast.add({ title: "Playlist duplicated.", type: "success" });
      void navigate(`/playlists/${playlist.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deletePlaylist(id, csrf),
    onSuccess: () => {
      toast.add({ title: "Playlist deleted.", type: "success" });
      void navigate("/playlists");
    },
  });

  const updateItem = useMutation({
    mutationFn: ({
      itemId,
      input,
    }: {
      itemId: string;
      input: PlaylistItemInput;
    }) => api.updatePlaylistItem(id, itemId, input, csrf),
    onSuccess: (playlist) => {
      update(playlist);
      setEditorError("");
    },
    onError: (error) => setEditorError(error.message),
  });

  const deleteItem = useMutation({
    mutationFn: (itemId: string) => api.deletePlaylistItem(id, itemId, csrf),
    onSuccess: (playlist) => {
      toast.add({ title: "Playlist item removed.", type: "success" });
      update(playlist);
      setItemInspectorOpen(false);
      setEditorError("");
    },
    onError: (error) => setEditorError(error.message),
  });

  const reorder = useMutation({
    mutationFn: (itemIds: string[]) => api.reorderPlaylist(id, itemIds, csrf),
    onSuccess: (playlist) => {
      update(playlist);
      setEditorError("");
    },
    onError: (error) => setEditorError(error.message),
  });

  const bulkUpdate = useMutation({
    mutationFn: (input: PlaylistBulkItemUpdateInput) =>
      api.bulkUpdatePlaylistItems(id, input, csrf),
    onSuccess: (playlist, input) => {
      update(playlist);
      setEditorError("");
      setPlaybackMessage(
        input.transition
          ? `Set ${transitionLabel(input.transition)} for all playlist items.`
          : `Updated fixed image durations to ${input.durationMs / 1000} seconds.`,
      );
    },
    onError: (error) => setEditorError(error.message),
  });

  const add = async (selected: Asset[]): Promise<ContentPickerResult> => {
    if (!query.data) return { failures: [] };
    const failures: ContentPickerResult["failures"] = [];
    const items = query.data.items ?? [];
    for (const asset of selected) {
      try {
        const authoring = playlistAuthoringDefaults(items, asset.type);
        const next = await api.addPlaylistItem(
          id,
          {
            assetId: asset.id,
            durationMs:
              asset.type === "image" && authoring.durationMs != null
                ? authoring.durationMs
                : asset.type === "widget" &&
                    asset.widget?.provider !== "youtube"
                  ? 30000
                  : undefined,
            fitMode: "contain",
            transition: authoring.transition,
            audioEnabled: asset.type !== "widget",
            volume: asset.type === "widget" ? 0 : 1,
            deliveryPolicy: asset.type === "widget" ? "stream" : "download",
            usePlayerDefaults: authoring.usePlayerDefaults,
          },
          csrf,
        );
        update(next);
      } catch (error) {
        failures.push({
          id: asset.id,
          name: asset.name,
          message:
            error instanceof Error ? error.message : "Could not add item.",
        });
      }
    }
    if (failures.length === 0) setPicker(false);
    return { failures };
  };

  useEffect(() => {
    const created = searchParams.get("newWidget");
    if (!created || !canManage) return;
    const next = new URLSearchParams(searchParams);
    next.delete("newWidget");
    setSearchParams(next, { replace: true });
    void (async () => {
      try {
        const asset = await api.asset(created);
        const result = await add([asset]);
        setAddFailure(result.failures[0]?.message ?? "");
      } catch (error) {
        setAddFailure(
          error instanceof Error
            ? error.message
            : "The new Widget could not be added to this playlist.",
        );
      }
    })();
    // The query parameter is the only trigger that should re-run this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, searchParams]);

  const addLayout = async (layoutId: string) => {
    try {
      const items = query.data?.items ?? [];
      const authoring = playlistAuthoringDefaults(items, "layout");
      const next = await api.addPlaylistItem(
        id,
        {
          layoutId,
          durationMs: 30000,
          fitMode: "contain",
          transition: authoring.transition,
          audioEnabled: false,
          volume: 0,
          deliveryPolicy: "stream",
        },
        csrf,
      );
      update(next);
      setLayoutPicker(false);
      setAddFailure("");
    } catch (error) {
      setAddFailure(
        error instanceof Error ? error.message : "Could not add the Layout.",
      );
    }
  };

  const commitOrder = (itemIds: string[]) => {
    if (
      itemIds.join(",") ===
      (query.data?.items ?? []).map((item) => item.id).join(",")
    ) {
      return;
    }
    reorder.mutate(itemIds);
  };

  const handleDrop = (event: DragEvent, targetId: string) => {
    event.preventDefault();
    if (!query.data || !draggedItemId || !canManage) return;
    commitOrder(
      reorderPlaylistItems(query.data.items, draggedItemId, targetId),
    );
    setDraggedItemId(undefined);
  };

  if (query.isLoading) {
    return (
      <div className="grid gap-2">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    );
  }
  if (!query.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Playlist could not be loaded.</AlertDescription>
      </Alert>
    );
  }

  const playlist = query.data;
  const items = playlist.items ?? [];
  const commonTransition = playlistTransition(items);
  const imageDuration = playlistImageDuration(items);
  const editableTimeline = canManage && sourceType === "static";
  const selectedItem = items.find((item) => item.id === selectedItemId);

  const openHistory = () => {
    setHistoryOpen(true);
    setDetailsOpen(false);
    setItemInspectorOpen(false);
  };
  const openDetails = () => {
    setDetailsOpen(true);
    setHistoryOpen(false);
    setItemInspectorOpen(false);
  };
  const selectItem = (itemId: string) => {
    setSelectedItemId(itemId);
    setItemInspectorOpen(true);
    setHistoryOpen(false);
    setDetailsOpen(false);
    setEditorError("");
  };

  const sequence = (
    <>
      <PlaylistPlaybackDefaults
        items={items}
        sourceType={sourceType}
        canManage={canManage}
        transition={commonTransition}
        imageDuration={imageDuration}
        transitionPending={bulkUpdate.isPending}
        imageDurationPending={bulkUpdate.isPending}
        onTransitionChange={(transition) => {
          setPlaybackMessage("");
          bulkUpdate.mutate({ transition });
        }}
        onImageDurationChange={(seconds) => {
          setPlaybackMessage("");
          bulkUpdate.mutate({ durationMs: Math.round(seconds * 1000) });
        }}
        onOpenDetails={openDetails}
      />
      <PlaylistTimeline
        items={items}
        sourceType={sourceType}
        canManage={editableTimeline}
        selectedItemId={selectedItemId}
        playlistTransition={commonTransition}
        draggedItemId={draggedItemId}
        onSelect={selectItem}
        onMove={(itemId, offset) => {
          if (!editableTimeline) return;
          commitOrder(movePlaylistItem(items, itemId, offset));
        }}
        onMoveToEdge={(itemId, edge) => {
          if (!editableTimeline) return;
          commitOrder(movePlaylistItemToEdge(items, itemId, edge));
        }}
        onDragStart={setDraggedItemId}
        onDragEnd={() => setDraggedItemId(undefined)}
        onDrop={handleDrop}
        onAddContent={() => {
          setAddFailure("");
          setPicker(true);
        }}
        onAddLayout={() => {
          setAddFailure("");
          setLayoutPicker(true);
        }}
      />
      <div className="grid min-w-0 gap-4">
        <UsedByPanel
          compact
          emptyMessage="No Layout, campaign, screen, or schedule plays this playlist yet."
          groups={[
            {
              label: "Layouts",
              items: (playlist.layoutUsage ?? []).map((layout) => ({
                id: layout.id,
                name: layout.name,
                hint: layout.published ? "Published" : "Draft",
              })),
              to: (layoutId) => `/layouts/${layoutId}`,
            },
            {
              label: "Screens",
              items: playlist.usage?.screens ?? [],
              to: (screenId) => `/screens/${screenId}`,
            },
            {
              label: "Schedules",
              items: playlist.usage?.schedules ?? [],
              to: (scheduleId) => `/schedules/${scheduleId}`,
            },
            {
              label: "Campaigns",
              items: playlist.usage?.campaigns ?? [],
              to: (campaignId) => `/campaigns/${campaignId}`,
            },
          ]}
        />
      </div>
    </>
  );

  return (
    <section className="grid gap-4">
      <PlaylistEditorHeader
        playlist={playlist}
        sourceType={sourceType}
        canManage={canManage}
        canDelete={canPublish}
        canSubmit={canSubmit}
        canPublish={canPublish}
        publishPending={publish.isPending}
        onPreview={() => openPlaylistPreview(playlist.id)}
        onPublish={() => publish.mutate()}
        onOpenHistory={openHistory}
        onOpenDetails={openDetails}
        onDuplicate={() => duplicate.mutate()}
        onDelete={() => setConfirmingDelete(true)}
      />

      <div className="grid gap-2" aria-live="polite">
        {playlist.warnings.map((warning) => (
          <Alert key={warning} variant="destructive">
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        ))}
        {publish.error && (
          <Alert variant="destructive">
            <AlertDescription>{publish.error.message}</AlertDescription>
          </Alert>
        )}
        {publish.isSuccess && (
          <Alert>
            <AlertDescription>
              The playlist was submitted or published. Check Content review for
              its immutable submission.
            </AlertDescription>
          </Alert>
        )}
        {editorError && (
          <Alert variant="destructive">
            <AlertDescription>{editorError}</AlertDescription>
          </Alert>
        )}
        {playbackMessage && (
          <Alert>
            <AlertDescription>{playbackMessage}</AlertDescription>
          </Alert>
        )}
        {addFailure && (
          <Alert variant="destructive">
            <AlertDescription>{addFailure}</AlertDescription>
          </Alert>
        )}
      </div>

      {desktop ? (
        <ResizablePanelGroup
          orientation="horizontal"
          role="group"
          aria-label="Playlist sequence and inspector"
        >
          <ResizablePanel
            defaultSize="62%"
            minSize="35%"
            id="playlist-sequence"
            aria-label="Playlist sequence"
          >
            <div className="grid min-w-0 content-start gap-6 pr-4">
              {sequence}
            </div>
          </ResizablePanel>
          <ResizableHandle
            withHandle
            aria-label="Resize sequence and inspector panes"
          />
          <ResizablePanel
            defaultSize="38%"
            minSize="25%"
            id="playlist-inspector"
            aria-label="Inspector"
          >
            <div className="grid min-w-0 content-start gap-4 pl-4">
              {selectedItem ? (
                <aside aria-label="Item inspector" className="grid gap-4">
                  <div className="grid gap-1">
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {`Item ${items.findIndex((item) => item.id === selectedItem.id) + 1} · ${selectedItem.assetType}`}
                    </p>
                    <h2 className="text-lg font-semibold tracking-tight">
                      {selectedItem.assetName}
                    </h2>
                  </div>
                  <Separator />
                  <PlaylistItemInspectorBody
                    item={selectedItem}
                    index={items.findIndex(
                      (item) => item.id === selectedItem.id,
                    )}
                    canManage={editableTimeline}
                    playlistTransition={commonTransition}
                    saving={updateItem.isPending || deleteItem.isPending}
                    error={
                      updateItem.error?.message || deleteItem.error?.message
                    }
                    onClose={() => setSelectedItemId(undefined)}
                    onChange={(input) => {
                      setEditorError("");
                      updateItem.mutate({ itemId: selectedItem.id, input });
                    }}
                    onDelete={() => deleteItem.mutate(selectedItem.id)}
                  />
                </aside>
              ) : (
                <aside aria-label="Inspector" className="grid gap-4">
                  <div className="grid gap-1">
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      Inspector
                    </p>
                    <h2 className="text-lg font-semibold tracking-tight">
                      Playlist settings
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      Select a timeline row to edit that item. Nothing is
                      selected.
                    </p>
                  </div>
                  <Separator />
                  <dl className="grid gap-2 text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-muted-foreground">Name</dt>
                      <dd className="min-w-0 truncate font-medium">{name}</dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-muted-foreground">Source</dt>
                      <dd className="font-medium">
                        {sourceType === "tag" ? "Tag-driven" : "Static"}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-muted-foreground">Items</dt>
                      <dd className="font-medium tabular-nums">
                        {items.length}
                      </dd>
                    </div>
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-muted-foreground">Transition</dt>
                      <dd className="font-medium">
                        {transitionLabel(commonTransition)}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <RheaButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={openDetails}
                    >
                      Playlist details
                    </RheaButton>
                    <RheaButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={openHistory}
                    >
                      History
                    </RheaButton>
                  </div>
                </aside>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        sequence
      )}

      {!desktop && selectedItem && (
        <PlaylistItemInspector
          item={selectedItem}
          index={items.findIndex((item) => item.id === selectedItem.id)}
          canManage={editableTimeline}
          playlistTransition={commonTransition}
          saving={updateItem.isPending || deleteItem.isPending}
          error={updateItem.error?.message || deleteItem.error?.message}
          open={itemInspectorOpen}
          onClose={() => setItemInspectorOpen(false)}
          onOpenChangeComplete={(open) => {
            if (!open) {
              setSelectedItemId((current) =>
                current === selectedItem.id ? undefined : current,
              );
            }
          }}
          onChange={(input) => {
            setEditorError("");
            updateItem.mutate({ itemId: selectedItem.id, input });
          }}
          onDelete={() => deleteItem.mutate(selectedItem.id)}
        />
      )}

      {desktop ? (
        <RheaSheet
          open={historyOpen}
          onOpenChange={(open) => {
            if (!open) setHistoryOpen(false);
          }}
        >
          <SheetContent side="right" className="overflow-y-auto">
            <SheetHeader>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Playlist revisions
              </p>
              <SheetTitle>History</SheetTitle>
              <SheetDescription>
                Every published revision is kept for review and restore.
              </SheetDescription>
            </SheetHeader>
            <div className="px-4">
              <PlaylistRevisionsPanel
                playlistId={id}
                canRestore={canPublish}
                embedded
              />
            </div>
          </SheetContent>
        </RheaSheet>
      ) : (
        <Drawer
          open={historyOpen}
          onOpenChange={(open) => {
            if (!open) setHistoryOpen(false);
          }}
          showSwipeHandle
        >
          <DrawerContent className="max-h-[calc(100dvh-2rem)]">
            <DrawerHeader>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Playlist revisions
              </p>
              <DrawerTitle>History</DrawerTitle>
              <DrawerDescription>
                Every published revision is kept for review and restore.
              </DrawerDescription>
            </DrawerHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              <PlaylistRevisionsPanel
                playlistId={id}
                canRestore={canPublish}
                embedded
              />
            </div>
          </DrawerContent>
        </Drawer>
      )}

      <PlaylistDetailsDrawer
        desktop={desktop}
        open={detailsOpen}
        canManage={canManage}
        sourceType={sourceType}
        name={name}
        description={description}
        tagMatch={tagMatch}
        tagIds={tagIds}
        tagImageSeconds={tagImageSeconds}
        tags={tags.data ?? []}
        metadataDirty={metadataDirty}
        tagRuleDirty={tagRuleDirty}
        metadataSaving={save.isPending}
        tagRuleSaving={saveTagRule.isPending}
        metadataError={save.error?.message}
        tagRuleError={saveTagRule.error?.message}
        onClose={() => setDetailsOpen(false)}
        onNameChange={(value) => {
          setName(value);
          setMetadataDirty(true);
        }}
        onDescriptionChange={(value) => {
          setDescription(value);
          setMetadataDirty(true);
        }}
        onSourceTypeChange={(value) => {
          setSourceType(value);
          setTagRuleDirty(true);
        }}
        onTagMatchChange={(value) => {
          setTagMatch(value);
          setTagRuleDirty(true);
        }}
        onTagToggle={(tagId) => {
          setTagIds((current) =>
            current.includes(tagId)
              ? current.filter((id) => id !== tagId)
              : [...current, tagId],
          );
          setTagRuleDirty(true);
        }}
        onTagImageSecondsChange={(value) => {
          setTagImageSeconds(value);
          setTagRuleDirty(true);
        }}
        onSaveMetadata={() => save.mutate()}
        onSaveTagRule={() => saveTagRule.mutate()}
      />

      {picker && (
        <ContentPicker
          open
          mode="multiple"
          csrf={csrf}
          allowedTypes={["image", "video", "widget"]}
          confirmLabel="Add to playlist"
          onConfirm={add}
          onClose={() => setPicker(false)}
          onCreateWidget={() =>
            void navigate(
              `/widgets/new?returnTo=${encodeURIComponent(`/playlists/${id}`)}`,
            )
          }
        />
      )}

      <RheaDialog
        open={layoutPicker}
        onOpenChange={(open) => {
          if (!open) setLayoutPicker(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add published Layout</DialogTitle>
            <DialogDescription>
              A Layout plays fullscreen for 30 seconds by default.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {(layouts.data?.items ?? [])
              .filter((layout) => layout.publishedRevision)
              .map((layout) => (
                <RheaButton
                  type="button"
                  variant="outline"
                  className="justify-start"
                  key={layout.id}
                  onClick={() => void addLayout(layout.id)}
                >
                  <PanelsTopLeft size={16} aria-hidden="true" />
                  {layout.name}
                </RheaButton>
              ))}
            {(layouts.data?.items ?? []).filter(
              (layout) => layout.publishedRevision,
            ).length === 0 && (
              <p className="text-sm text-muted-foreground">
                Publish a Layout before adding it to a playlist.
              </p>
            )}
          </div>
          <DialogFooter>
            <RheaButton
              type="button"
              variant="outline"
              onClick={() => setLayoutPicker(false)}
            >
              Cancel
            </RheaButton>
          </DialogFooter>
        </DialogContent>
      </RheaDialog>
      <RheaAlertDialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {playlist.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Screens assigned to this playlist will fall back to their default
              content. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => {
                setConfirmingDelete(false);
                remove.mutate();
              }}
            >
              Delete playlist
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </RheaAlertDialog>
    </section>
  );
}
