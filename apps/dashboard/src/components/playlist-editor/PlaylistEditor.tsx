import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelsTopLeft } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui/resizable";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "../ui/item";
import { ScrollArea } from "../ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  Sheet,
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
import {
  PlaylistAddButton,
  PlaylistAuthoringBar,
} from "./PlaylistAuthoringBar";
import {
  PlaylistDetailsDrawer,
  type PlaylistDetailsTab,
} from "./PlaylistDetailsDrawer";
import { PlaylistEditorHeader } from "./PlaylistEditorHeader";
import {
  PlaylistItemInspector,
  PlaylistItemInspectorPane,
} from "./PlaylistItemInspector";
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
  const { t } = useTranslation(["playlists", "common"]);
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
  const [detailsTab, setDetailsTab] = useState<PlaylistDetailsTab>("general");
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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [removingItemId, setRemovingItemId] = useState<string>();
  // The last inspector width a user chose, restored when the pane reopens.
  const inspectorSize = useRef(32);
  const [chrome, setChrome] = useState<HTMLDivElement | null>(null);
  const editorHeight = useViewportFillHeight(desktop ? chrome : null);

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
      toast.add({ title: t("editor.toasts.detailsSaved"), type: "success" });
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
      toast.add({ title: t("editor.toasts.sourceSaved"), type: "success" });
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
          ? t("editor.toasts.published")
          : t("editor.toasts.submitted"),
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
      toast.add({ title: t("editor.toasts.duplicated"), type: "success" });
      void navigate(`/playlists/${playlist.id}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deletePlaylist(id, csrf),
    onSuccess: () => {
      toast.add({ title: t("editor.toasts.deleted"), type: "success" });
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
      toast.add({ title: t("editor.toasts.itemRemoved"), type: "success" });
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
      toast.add({
        title: input.transition
          ? t("editor.toasts.transitionSet", {
              transition: transitionLabel(input.transition, t),
            })
          : t("editor.toasts.imageDurationsSet", {
              seconds: input.durationMs / 1000,
            }),
        type: "success",
      });
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
            error instanceof Error ? error.message : t("editor.addItemError"),
        });
      }
    }
    const added = selected.length - failures.length;
    if (added > 0) {
      toast.add({
        title: t("editor.toasts.itemsAdded", { count: added }),
        type: "success",
      });
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
          error instanceof Error ? error.message : t("editor.widgetAddError"),
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
      toast.add({ title: t("editor.toasts.layoutAdded"), type: "success" });
    } catch (error) {
      setAddFailure(
        error instanceof Error ? error.message : t("editor.layoutAddError"),
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
      <div
        className="grid gap-4"
        aria-busy="true"
        aria-label={t("editor.loadingLabel")}
      >
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 w-full max-w-xl" />
        <div className="grid gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      </div>
    );
  }
  if (!query.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("editor.loadError")}</AlertDescription>
      </Alert>
    );
  }

  const playlist = query.data;
  const items = playlist.items ?? [];
  const commonTransition = playlistTransition(items);
  const imageDuration = playlistImageDuration(items);
  const editableTimeline = canManage && sourceType === "static";
  const selectedItem = items.find((item) => item.id === selectedItemId);
  const selectedIndex = selectedItem ? items.indexOf(selectedItem) : -1;
  const removingItem = items.find((item) => item.id === removingItemId);
  const publishedLayouts = (layouts.data?.items ?? []).filter(
    (layout) => layout.publishedRevision,
  );

  const openHistory = () => {
    setHistoryOpen(true);
    setDetailsOpen(false);
    setItemInspectorOpen(false);
  };
  const openDetails = (tab: PlaylistDetailsTab = "general") => {
    setDetailsTab(tab);
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
  // Closing the inline inspector returns focus to the row it described.
  const closeInlineInspector = () => {
    const closing = selectedItemId;
    setSelectedItemId(undefined);
    if (closing) {
      window.requestAnimationFrame(() =>
        document
          .querySelector<HTMLButtonElement>(
            `[data-playlist-item="${closing}"] [data-slot=playlist-item-inspect]`,
          )
          ?.focus(),
      );
    }
  };
  const openPicker = () => {
    setAddFailure("");
    setPicker(true);
  };
  const openLayoutPicker = () => {
    setAddFailure("");
    setLayoutPicker(true);
  };
  const inspectorProps = selectedItem && {
    item: selectedItem,
    index: selectedIndex,
    canManage: editableTimeline,
    playlistTransition: commonTransition,
    saving: updateItem.isPending || deleteItem.isPending,
    error: updateItem.error?.message || deleteItem.error?.message,
    onChange: (input: PlaylistItemInput) => {
      setEditorError("");
      updateItem.mutate({ itemId: selectedItem.id, input });
    },
    onDelete: () => deleteItem.mutate(selectedItem.id),
  };

  const timeline = (
    <PlaylistTimeline
      items={items}
      sourceType={sourceType}
      canManage={editableTimeline}
      selectedItemId={selectedItemId}
      playlistTransition={commonTransition}
      draggedItemId={draggedItemId}
      emptyAction={
        editableTimeline ? (
          <PlaylistAddButton
            onAddContent={openPicker}
            onAddLayout={openLayoutPicker}
          />
        ) : undefined
      }
      onSelect={selectItem}
      onMove={(itemId, offset) => {
        if (!editableTimeline) return;
        commitOrder(movePlaylistItem(items, itemId, offset));
      }}
      onMoveToEdge={(itemId, edge) => {
        if (!editableTimeline) return;
        commitOrder(movePlaylistItemToEdge(items, itemId, edge));
      }}
      onRemove={(itemId) => {
        if (editableTimeline) setRemovingItemId(itemId);
      }}
      onDragStart={setDraggedItemId}
      onDragEnd={() => setDraggedItemId(undefined)}
      onDrop={handleDrop}
    />
  );

  const usage = (
    <UsedByPanel
      emptyMessage={t("editor.usage.empty")}
      groups={[
        {
          label: t("editor.usage.groups.layouts"),
          items: (playlist.layoutUsage ?? []).map((layout) => ({
            id: layout.id,
            name: layout.name,
            hint: layout.published
              ? t("editor.usage.publishedHint")
              : t("editor.usage.draftHint"),
          })),
          to: (layoutId) => `/layouts/${layoutId}`,
        },
        {
          label: t("editor.usage.groups.screens"),
          items: playlist.usage?.screens ?? [],
          to: (screenId) => `/screens/${screenId}`,
        },
        {
          label: t("editor.usage.groups.schedules"),
          items: playlist.usage?.schedules ?? [],
          to: (scheduleId) => `/schedules/${scheduleId}`,
        },
        {
          label: t("editor.usage.groups.campaigns"),
          items: playlist.usage?.campaigns ?? [],
          to: (campaignId) => `/campaigns/${campaignId}`,
        },
      ]}
    />
  );

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-5">
      <div ref={setChrome} className="grid grid-cols-[minmax(0,1fr)] gap-5">
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
          onOpenDetails={() => openDetails()}
          onDuplicate={() => duplicate.mutate()}
          onDelete={() => setConfirmingDelete(true)}
        />

        {(playlist.warnings.length > 0 ||
          publish.error ||
          editorError ||
          addFailure) && (
          <div className="grid gap-2" role="alert">
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
            {editorError && (
              <Alert variant="destructive">
                <AlertDescription>{editorError}</AlertDescription>
              </Alert>
            )}
            {addFailure && (
              <Alert variant="destructive">
                <AlertDescription>{addFailure}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <PlaylistAuthoringBar
          items={items}
          sourceType={sourceType}
          canManage={canManage}
          transition={commonTransition}
          imageDuration={imageDuration}
          pending={bulkUpdate.isPending}
          onTransitionChange={(transition) => bulkUpdate.mutate({ transition })}
          onImageDurationChange={(seconds) =>
            bulkUpdate.mutate({ durationMs: Math.round(seconds * 1000) })
          }
          onAddContent={openPicker}
          onAddLayout={openLayoutPicker}
          onEditSource={() => openDetails("source")}
        />
      </div>

      {desktop ? (
        // The desktop editor fills the viewport so the sequence and the
        // inspector scroll independently: selecting item 40 keeps its
        // inspector in view. The inspector exists only while an item is
        // selected, so the timeline otherwise takes the full width.
        <div style={{ height: editorHeight }} className="min-h-80">
          <ResizablePanelGroup
            orientation="horizontal"
            role="group"
            aria-label={t("editor.sequenceLabel")}
            onLayoutChanged={(layout) => {
              const size = layout["playlist-inspector"];
              if (size) inspectorSize.current = size;
            }}
          >
            <ResizablePanel
              id="playlist-sequence"
              minSize="50%"
              aria-label={t("editor.sequencePanelLabel")}
            >
              <ScrollArea className="h-full">
                <div className="p-1 pr-4">{timeline}</div>
              </ScrollArea>
            </ResizablePanel>
            {inspectorProps && (
              <>
                <ResizableHandle
                  withHandle
                  aria-label={t("editor.resizeLabel")}
                />
                <ResizablePanel
                  id="playlist-inspector"
                  defaultSize={`${inspectorSize.current}%`}
                  minSize="26%"
                  maxSize="45%"
                  aria-label={t("editor.inspectorPanelLabel")}
                >
                  <ScrollArea className="h-full">
                    <div className="p-1 pl-5">
                      <PlaylistItemInspectorPane
                        {...inspectorProps}
                        onClose={closeInlineInspector}
                      />
                    </div>
                  </ScrollArea>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      ) : (
        timeline
      )}

      {!desktop && inspectorProps && selectedItem && (
        <PlaylistItemInspector
          {...inspectorProps}
          open={itemInspectorOpen}
          onClose={() => setItemInspectorOpen(false)}
          onOpenChangeComplete={(open) => {
            if (!open) {
              setSelectedItemId((current) =>
                current === selectedItem.id ? undefined : current,
              );
            }
          }}
        />
      )}

      {desktop ? (
        <Sheet
          open={historyOpen}
          onOpenChange={(open) => {
            if (!open) setHistoryOpen(false);
          }}
        >
          <SheetContent side="right" className="overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{t("editor.historyTitle")}</SheetTitle>
              <SheetDescription>
                {t("editor.historyDescription")}
              </SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-4">
              <PlaylistRevisionsPanel
                playlistId={id}
                canRestore={canPublish}
                embedded
              />
            </div>
          </SheetContent>
        </Sheet>
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
              <DrawerTitle>{t("editor.historyTitle")}</DrawerTitle>
              <DrawerDescription>
                {t("editor.historyDescription")}
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
        tab={detailsTab}
        canManage={canManage}
        sourceType={sourceType}
        name={name}
        description={description}
        tagMatch={tagMatch}
        tagIds={tagIds}
        tagImageSeconds={tagImageSeconds}
        tags={tags.data ?? []}
        usage={usage}
        metadataDirty={metadataDirty}
        tagRuleDirty={tagRuleDirty}
        metadataSaving={save.isPending}
        tagRuleSaving={saveTagRule.isPending}
        metadataError={save.error?.message}
        tagRuleError={saveTagRule.error?.message}
        onTabChange={setDetailsTab}
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

      <ContentPicker
        open={picker}
        mode="multiple"
        csrf={csrf}
        allowedTypes={["image", "video", "widget"]}
        confirmLabel={t("editor.pickerConfirm")}
        onConfirm={add}
        onClose={() => setPicker(false)}
        onCreateWidget={() =>
          void navigate(
            `/widgets/new?returnTo=${encodeURIComponent(`/playlists/${id}`)}`,
          )
        }
      />

      <Dialog
        open={layoutPicker}
        onOpenChange={(open) => {
          if (!open) setLayoutPicker(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("editor.addLayoutTitle")}</DialogTitle>
            <DialogDescription>
              {t("editor.addLayoutDescription")}
            </DialogDescription>
          </DialogHeader>
          {publishedLayouts.length > 0 ? (
            <ItemGroup className="gap-1">
              {publishedLayouts.map((layout) => (
                <Item
                  key={layout.id}
                  role="listitem"
                  size="sm"
                  variant="outline"
                  render={
                    <button
                      type="button"
                      onClick={() => void addLayout(layout.id)}
                    />
                  }
                  className="text-left hover:bg-muted"
                >
                  <ItemMedia variant="icon">
                    <PanelsTopLeft aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{layout.name}</ItemTitle>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <Empty className="border border-dashed py-8">
              <EmptyHeader>
                <EmptyTitle>{t("editor.noPublishedLayoutsTitle")}</EmptyTitle>
                <EmptyDescription>
                  {t("editor.noPublishedLayouts")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setLayoutPicker(false)}
            >
              {t("common:actions.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={removingItem != null}
        onOpenChange={(open) => {
          if (!open) setRemovingItemId(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("inspector.removeTitle", { name: removingItem?.assetName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("inspector.removeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removingItemId) deleteItem.mutate(removingItemId);
                setRemovingItemId(undefined);
              }}
            >
              {t("inspector.removeItem")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmingDelete(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("editor.deleteTitle", { name: playlist.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("editor.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                setConfirmingDelete(false);
                remove.mutate();
              }}
            >
              {t("editor.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

// useViewportFillHeight sizes the desktop editor region to the space left
// below the page chrome, so the region never pushes the document into a
// second, outer scroll. It re-measures when the chrome above it changes
// height (a warning appears, the header wraps) or the window resizes.
function useViewportFillHeight(chrome: HTMLElement | null) {
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!chrome) return;
    const measure = () => {
      const bottom = chrome.getBoundingClientRect().bottom;
      // 20px separates the chrome from the region; 24px matches the Studio
      // content area's bottom padding.
      setHeight(Math.max(320, Math.floor(window.innerHeight - bottom - 44)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chrome);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [chrome]);
  return height;
}
