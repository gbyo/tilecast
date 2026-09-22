import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelsTopLeft } from "lucide-react";
import { useEffect, useState, type DragEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Button, Dialog, Drawer, Notice } from "../ui";
import type {
  Asset,
  Playlist,
  PlaylistItemInput,
  PlaylistBulkItemUpdateInput,
} from "../../api/types";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { useSpectrumDialogs } from "../../dialogs/SpectrumDialogs";
import { ContentPicker, type ContentPickerResult } from "../content-picker";
import { UsedByPanel } from "../../content/UsedByPanel";
import { PlaylistRevisionsPanel } from "../PlaylistRevisionsPanel";
import { PlaylistDetailsDrawer } from "./PlaylistDetailsDrawer";
import { PlaylistEditorHeader } from "./PlaylistEditorHeader";
import { PlaylistItemInspector } from "./PlaylistItemInspector";
import { PlaylistPlaybackDefaults } from "./PlaylistPlaybackDefaults";
import { PlaylistTimeline } from "./PlaylistTimeline";
import {
  canManagePlaylists,
  movePlaylistItem,
  openPlaylistPreview,
  playlistAuthoringDefaults,
  playlistImageDuration,
  playlistTransition,
  reorderPlaylistItems,
  transitionLabel,
} from "./playlistEditorModel";

export function PlaylistEditorPage() {
  const { confirm } = useSpectrumDialogs();
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
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [draggedItemId, setDraggedItemId] = useState<string>();
  const [sourceType, setSourceType] = useState<"static" | "tag">("static");
  const [tagMatch, setTagMatch] = useState<"any" | "all">("any");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagImageSeconds, setTagImageSeconds] = useState(10);
  const [addFailure, setAddFailure] = useState("");
  const [editorError, setEditorError] = useState("");
  const [playbackMessage, setPlaybackMessage] = useState("");

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
    onSuccess: (playlist) => void navigate(`/playlists/${playlist.id}`),
  });
  const remove = useMutation({
    mutationFn: () => api.deletePlaylist(id, csrf),
    onSuccess: () => void navigate("/playlists"),
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
      update(playlist);
      setSelectedItemId(undefined);
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
    return <div className="table-loading">Loading playlist…</div>;
  }
  if (!query.data) {
    return (
      <div className="notice notice--error">Playlist could not be loaded.</div>
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
    setSelectedItemId(undefined);
  };
  const openDetails = () => {
    setDetailsOpen(true);
    setHistoryOpen(false);
    setSelectedItemId(undefined);
  };
  const selectItem = (itemId: string) => {
    setSelectedItemId(itemId);
    setHistoryOpen(false);
    setDetailsOpen(false);
    setEditorError("");
  };

  return (
    <section className="playlist-editor-v2">
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
        onDelete={async () => {
          if (await confirm({
            title: `Delete ${playlist.name}?`,
            description: "This playlist will be permanently removed.",
            confirmLabel: "Delete playlist",
            tone: "negative",
          })) remove.mutate();
        }}
      />

      <div className="playlist-editor-v2__notices" aria-live="polite">
        {playlist.warnings.map((warning) => (
          <Notice key={warning} variant="danger">
            {warning}
          </Notice>
        ))}
        {publish.error && (
          <Notice variant="danger">{publish.error.message}</Notice>
        )}
        {publish.isSuccess && (
          <Notice variant="info">
            The playlist was submitted or published. Check Content review for
            its immutable submission.
          </Notice>
        )}
        {editorError && <Notice variant="danger">{editorError}</Notice>}
        {playbackMessage && (
          <Notice variant="success">{playbackMessage}</Notice>
        )}
        {addFailure && <Notice variant="danger">{addFailure}</Notice>}
      </div>

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

      <div className="playlist-editor-v2__secondary">
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

      {selectedItem && (
        <PlaylistItemInspector
          item={selectedItem}
          index={items.findIndex((item) => item.id === selectedItem.id)}
          canManage={editableTimeline}
          playlistTransition={commonTransition}
          saving={updateItem.isPending || deleteItem.isPending}
          error={updateItem.error?.message || deleteItem.error?.message}
          onClose={() => setSelectedItemId(undefined)}
          onChange={(input) => {
            setEditorError("");
            updateItem.mutate({ itemId: selectedItem.id, input });
          }}
          onDelete={() => deleteItem.mutate(selectedItem.id)}
        />
      )}

      {historyOpen && (
        <Drawer
          title="History"
          eyebrow="Playlist revisions"
          onClose={() => setHistoryOpen(false)}
          closeLabel="Close playlist history"
          className="playlist-history-drawer"
        >
          <PlaylistRevisionsPanel
            playlistId={id}
            canRestore={canPublish}
            embedded
          />
        </Drawer>
      )}

      {detailsOpen && (
        <PlaylistDetailsDrawer
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
      )}

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

      <Dialog
        open={layoutPicker}
        title="Add published Layout"
        onClose={() => setLayoutPicker(false)}
      >
        <p>A Layout plays fullscreen for 30 seconds by default.</p>
        <div className="playlist-editor-layout-picker">
          {(layouts.data?.items ?? [])
            .filter((layout) => layout.publishedRevision)
            .map((layout) => (
              <Button
                variant="quiet"
                key={layout.id}
                onClick={() => void addLayout(layout.id)}
              >
                <PanelsTopLeft size={16} aria-hidden="true" />
                {layout.name}
              </Button>
            ))}
        </div>
        {(layouts.data?.items ?? []).filter(
          (layout) => layout.publishedRevision,
        ).length === 0 && (
          <p className="status-copy">
            Publish a Layout before adding it to a playlist.
          </p>
        )}
        <div className="form-actions">
          <Button variant="quiet" onClick={() => setLayoutPicker(false)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
