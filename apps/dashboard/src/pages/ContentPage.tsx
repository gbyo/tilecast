import {
  Button,
  Dialog,
  Drawer,
  Notice,
  PageHeader,
  Select,
  ToggleGroup,
  ViewToggle,
} from "../components/ui";
import { ActionBar } from "@react-spectrum/s2/ActionBar";
import { ActionButton } from "@react-spectrum/s2/ActionButton";
import {
  ActionMenu,
  MenuItem,
} from "@react-spectrum/s2/ActionMenu";
import {
  AssetCard as SpectrumAssetCard,
  CardPreview,
  CardView,
  Footer,
} from "@react-spectrum/s2/CardView";
import type { Key, Selection } from "@react-spectrum/s2/CardView";
import { Button as SpectrumButton } from "@react-spectrum/s2/Button";
import { Content } from "@react-spectrum/s2/Content";
import { Heading } from "@react-spectrum/s2/Heading";
import { IllustratedMessage } from "@react-spectrum/s2/IllustratedMessage";
import { StatusLight } from "@react-spectrum/s2/StatusLight";
import { Text } from "@react-spectrum/s2/Text";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  FileImage,
  Folder,
  Upload,
  Copy,
  Pencil,
  Trash2,
  X,
  FolderPlus,
  Tags,
  Library,
} from "lucide-react";
import { signalColors } from "@tilecast/design-tokens/values";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { api, ApiError } from "../api/client";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import type {
  Asset,
  AssetStatus,
  BulkOrganizeInput,
  User,
  WebsiteInput,
  ContentFolder,
  ContentCollection,
  ContentTag,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
import { NativeAppEditor, YouTubeSourceEditor } from "../content/SourceEditors";
import { AssetPreview } from "../components/content/AssetPreview";
import { droppedFiles } from "../components/content/dragDrop";
import { UsedByPanel } from "../content/UsedByPanel";
import { WorkspaceTabs, contentTabs } from "../navigation/WorkspaceTabs";

type QueueItem = {
  localId: string;
  sessionId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBytes: number;
  state: "waiting" | "uploading" | "finalizing" | "processing" | "failed";
  error?: string;
};

type SavedUpload = Pick<
  QueueItem,
  "sessionId" | "filename" | "mimeType" | "sizeBytes" | "uploadedBytes"
>;

const resumeKey = "tilecast.resumable-uploads.v1";
const chunkSize = 5 * 1024 * 1024;

const assetCollectionStyles = style({
  minHeight: 320,
  width: "full",
});

const assetPreviewStyles = style({
  display: "grid",
  placeItems: "center",
  minHeight: 160,
  aspectRatio: "3/2",
  overflow: "clip",
  backgroundColor: "gray-100",
});

const assetMetadataStyles = style({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
});

export function canManageContent(user?: User) {
  return Boolean(user && user.role !== "viewer");
}

export function statusLabel(status: AssetStatus) {
  return (
    {
      uploading: "Uploading",
      uploaded: "Uploaded",
      queued: "Waiting",
      inspecting: "Inspecting",
      processing: "Processing",
      ready: "Ready",
      failed: "Failed",
      deleting: "Deleting",
      deleted: "Deleted",
    } satisfies Record<AssetStatus, string>
  )[status];
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds?: number) {
  if (seconds == null) return "";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

export function isExpiredAsset(asset: Asset, now = Date.now()) {
  return Boolean(
    asset.expiresAt &&
    Number.isFinite(Date.parse(asset.expiresAt)) &&
    Date.parse(asset.expiresAt) <= now,
  );
}

export function nextExpirationDelay(assets: Asset[], now = Date.now()) {
  const next = assets.reduce<number | undefined>((soonest, asset) => {
    if (!asset.expiresAt) return soonest;
    const expiresAt = Date.parse(asset.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return soonest;
    return soonest == null || expiresAt < soonest ? expiresAt : soonest;
  }, undefined);
  return next == null ? undefined : Math.max(0, next - now) + 100;
}

export function ContentPage() {
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const canManage = canManageContent(auth.status?.user);
  const csrf = auth.status?.csrfToken ?? "";
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [contentFilter, setContentFilter] = useState("media");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("updated");
  const [folderFilter, setFolderFilter] = useState("");
  const [collectionFilter, setCollectionFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [libraryView, setLibraryView] = useState<"active" | "archive">(
    "active",
  );
  const [checkedAssetIds, setCheckedAssetIds] = useState<Set<string>>(
    new Set(),
  );
  const [view, setView] = useState<"grid" | "list">("grid");
  const [queue, setQueue] = useState<QueueItem[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(resumeKey) ?? "[]",
      ) as SavedUpload[];
      return saved.map((item) => ({
        ...item,
        localId: item.sessionId ?? crypto.randomUUID(),
        state: "failed",
        error: "Select the same file to resume this upload.",
      }));
    } catch {
      return [];
    }
  });
  const [selected, setSelected] = useState<Asset>();
  const controllers = useRef(new Map<string, AbortController>());
  const fileInput = useRef<HTMLInputElement>(null);
  const params = new URLSearchParams({ page: "1", pageSize: "48", sort });
  if (libraryView === "archive") params.set("archived", "true");
  if (search) params.set("search", search);
  if (["media", "image", "video"].includes(contentFilter))
    params.set("type", contentFilter);
  if (status) params.set("status", status);
  if (folderFilter) params.set("folderId", folderFilter);
  if (collectionFilter) params.set("collectionId", collectionFilter);
  if (tagFilter) params.set("tagId", tagFilter);
  const assets = useQuery({
    queryKey: ["assets", params.toString()],
    queryFn: () => api.assets(params),
    refetchInterval: (query) =>
      query.state.data?.items?.some((item) =>
        ["queued", "inspecting", "processing"].includes(item.processingStatus),
      )
        ? 3000
        : false,
  });
  const folders = useQuery({
    queryKey: ["content-folders"],
    queryFn: api.contentFolders,
  });
  const collections = useQuery({
    queryKey: ["content-collections"],
    queryFn: api.contentCollections,
  });
  const tags = useQuery({
    queryKey: ["content-tags"],
    queryFn: api.contentTags,
  });
  useEffect(() => {
    const delay = nextExpirationDelay(assets.data?.items ?? []);
    if (delay == null) return;
    const timer = window.setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: ["assets"] }),
      Math.min(delay, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [assets.data?.items, queryClient]);
  useEffect(() => {
    setCheckedAssetIds(new Set());
    setSelected(undefined);
  }, [
    libraryView,
    search,
    contentFilter,
    status,
    sort,
    folderFilter,
    collectionFilter,
    tagFilter,
  ]);
  const refreshOrganization = () => {
    void queryClient.invalidateQueries({ queryKey: ["assets"] });
    void queryClient.invalidateQueries({ queryKey: ["content-folders"] });
    void queryClient.invalidateQueries({ queryKey: ["content-collections"] });
    void queryClient.invalidateQueries({ queryKey: ["content-tags"] });
  };

  useEffect(() => {
    const saved = queue
      .filter((item) => item.sessionId && item.state !== "processing")
      .map(({ sessionId, filename, mimeType, sizeBytes, uploadedBytes }) => ({
        sessionId,
        filename,
        mimeType,
        sizeBytes,
        uploadedBytes,
      }));
    localStorage.setItem(resumeKey, JSON.stringify(saved));
  }, [queue]);

  const updateQueue = (localId: string, update: Partial<QueueItem>) =>
    setQueue((current) =>
      current.map((item) =>
        item.localId === localId ? { ...item, ...update } : item,
      ),
    );

  const uploadFile = async (file: File, resume?: QueueItem) => {
    const localId = resume?.localId ?? crypto.randomUUID();
    if (
      resume &&
      (file.name !== resume.filename || file.size !== resume.sizeBytes)
    ) {
      updateQueue(localId, {
        error: "Choose the original file with the same name and size.",
      });
      return;
    }
    let sessionId = resume?.sessionId;
    let offset: number;
    const item: QueueItem = resume ?? {
      localId,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      uploadedBytes: 0,
      state: "waiting",
    };
    if (!resume) setQueue((current) => [...current, item]);
    const controller = new AbortController();
    controllers.current.set(localId, controller);
    try {
      if (sessionId) {
        const state = await api.inspectUpload(sessionId);
        offset = state.offset;
      } else {
        const created = await api.createUpload(
          {
            filename: file.name,
            mimeType: item.mimeType,
            sizeBytes: file.size,
          },
          csrf,
        );
        sessionId = created.id;
        offset = created.offset;
      }
      updateQueue(localId, {
        sessionId,
        uploadedBytes: offset,
        state: "uploading",
        error: undefined,
      });
      while (offset < file.size) {
        const next = Math.min(file.size, offset + chunkSize);
        offset = await api.uploadChunk(
          sessionId,
          offset,
          file.slice(offset, next),
          csrf,
          controller.signal,
        );
        updateQueue(localId, { uploadedBytes: offset });
      }
      updateQueue(localId, { state: "finalizing" });
      await api.completeUpload(sessionId, csrf);
      updateQueue(localId, { state: "processing", uploadedBytes: file.size });
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      window.setTimeout(
        () =>
          setQueue((current) =>
            current.filter((queued) => queued.localId !== localId),
          ),
        1500,
      );
    } catch (error) {
      if ((error as Error).name !== "AbortError")
        updateQueue(localId, {
          state: "failed",
          error: error instanceof Error ? error.message : "Upload failed.",
        });
    } finally {
      controllers.current.delete(localId);
    }
  };

  const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    for (const file of Array.from(event.target.files ?? []))
      void uploadFile(file);
    event.target.value = "";
  };
  const dropFiles = (event: DragEvent) => {
    event.preventDefault();
    if (canManage)
      for (const file of droppedFiles(event.dataTransfer))
        void uploadFile(file);
  };
  const cancel = async (item: QueueItem) => {
    controllers.current.get(item.localId)?.abort();
    if (item.sessionId)
      await api.cancelUpload(item.sessionId, csrf).catch(() => undefined);
    setQueue((current) =>
      current.filter((queued) => queued.localId !== item.localId),
    );
  };
  const resume = (item: QueueItem) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept =
      "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/x-matroska";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void uploadFile(file, item);
    };
    input.click();
  };

  return (
    <section
      className="content-page"
      onDragOver={(event) => event.preventDefault()}
      onDrop={libraryView === "active" ? dropFiles : undefined}
    >
      <WorkspaceTabs label="Content library" tabs={contentTabs} />
      <PageHeader
        title="Media"
        description={
          libraryView === "active"
            ? "Uploaded images and videos available to playlists and Layouts."
            : "Archived and expired content stays here until you restore or permanently delete it."
        }
        actions={
          canManage && libraryView === "active" ? (
            <Button
              variant="primary"
              type="button"
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={16} aria-hidden="true" /> Upload assets
            </Button>
          ) : undefined
        }
      />
      <ToggleGroup
        className="content-library-switch"
        label="Library view"
        value={libraryView}
        onValueChange={setLibraryView}
        items={[
          { value: "active", label: "Library" },
          { value: "archive", label: "Archive" },
        ]}
      />
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/x-matroska"
        onChange={pickFiles}
        aria-label="Choose media files"
      />

      {libraryView === "active" && queue.length > 0 && (
        <section className="upload-queue" aria-label="Upload queue">
          <header>
            <strong>Uploads</strong>
            <span>{queue.length} active</span>
          </header>
          {queue.map((item) => {
            const percent = Math.round(
              (item.uploadedBytes / item.sizeBytes) * 100,
            );
            return (
              <div className="upload-row" key={item.localId}>
                <span>
                  <strong>{item.filename}</strong>
                  <small>
                    {formatBytes(item.uploadedBytes)} of{" "}
                    {formatBytes(item.sizeBytes)} · {item.state}
                  </small>
                  {item.error && (
                    <small className="upload-error">{item.error}</small>
                  )}
                </span>
                <progress value={item.uploadedBytes} max={item.sizeBytes}>
                  {percent}%
                </progress>
                <b>{percent}%</b>
                {item.state === "failed" && (
                  <button
                    className="button button--quiet"
                    onClick={() => resume(item)}
                  >
                    Retry or resume
                  </button>
                )}
                <button
                  className="icon-button"
                  aria-label={`Cancel ${item.filename}`}
                  onClick={() => void cancel(item)}
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
        </section>
      )}

      <DashboardListToolbar className="content-toolbar dashboard-list-toolbar--dense">
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search media"
          placeholder="Search media"
        />
        <ToggleGroup
          className="content-type-filters"
          label="Content type filters"
          value={contentFilter}
          onValueChange={setContentFilter}
          items={[
            { value: "media", label: "Media" },
            { value: "image", label: "Images" },
            { value: "video", label: "Videos" },
          ]}
        />
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="">All statuses</option>
          <option value="ready">Ready</option>
          <option value="queued">Waiting</option>
          <option value="inspecting">Inspecting</option>
          <option value="processing">Processing</option>
          <option value="failed">Failed</option>
        </Select>
        {libraryView === "active" && (
          <>
            <Select
              className="dashboard-list-toolbar__filter"
              aria-label="Filter by folder"
              value={folderFilter}
              onChange={(event) => setFolderFilter(event.target.value)}
            >
              <option value="">All folders</option>
              {folders.data?.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.name} ({folder.assetCount})
                </option>
              ))}
            </Select>
            <Select
              className="dashboard-list-toolbar__filter"
              aria-label="Filter by collection"
              value={collectionFilter}
              onChange={(event) => setCollectionFilter(event.target.value)}
            >
              <option value="">All collections</option>
              {collections.data?.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name} ({collection.assetCount})
                </option>
              ))}
            </Select>
            <Select
              className="dashboard-list-toolbar__filter"
              aria-label="Filter by tag"
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
            >
              <option value="">All tags</option>
              {tags.data?.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name} ({tag.assetCount ?? 0})
                </option>
              ))}
            </Select>
          </>
        )}
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Sort media"
          value={sort}
          onChange={(event) => setSort(event.target.value)}
        >
          <option value="updated">Recently updated</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="name">Name</option>
        </Select>
        {(search ||
          contentFilter !== "media" ||
          status ||
          folderFilter ||
          collectionFilter ||
          tagFilter) && (
          <Button
            variant="quiet"
            type="button"
            onClick={() => {
              setSearch("");
              setContentFilter("media");
              setStatus("");
              setFolderFilter("");
              setCollectionFilter("");
              setTagFilter("");
            }}
          >
            Reset filters
          </Button>
        )}
        <ViewToggle value={view} onValueChange={setView} />
      </DashboardListToolbar>

      {canManage && (libraryView === "active" || checkedAssetIds.size > 0) && (
        <ContentOrganizer
          csrf={csrf}
          folders={folders.data ?? []}
          collections={collections.data ?? []}
          tags={tags.data ?? []}
          assetIds={[...checkedAssetIds]}
          onApplied={() => {
            setCheckedAssetIds(new Set());
            refreshOrganization();
          }}
          onCatalogChanged={refreshOrganization}
          onSelectAll={() =>
            setCheckedAssetIds(
              new Set((assets.data?.items ?? []).map((asset) => asset.id)),
            )
          }
          onClear={() => setCheckedAssetIds(new Set())}
          archiveMode={libraryView === "archive"}
          onArchive={async () => {
            await api.archiveAssets([...checkedAssetIds], csrf);
            setCheckedAssetIds(new Set());
            refreshOrganization();
          }}
          onRestore={async () => {
            await api.restoreAssets([...checkedAssetIds], csrf);
            setCheckedAssetIds(new Set());
            refreshOrganization();
          }}
          onDelete={async () => {
            const ids = [...checkedAssetIds];
            if (!(await confirm({
              title: `Permanently delete ${ids.length} archived item${ids.length === 1 ? "" : "s"}?`,
              description: "This cannot be undone.",
              confirmLabel: "Delete permanently",
              tone: "negative",
            })))
              return;
            await Promise.all(ids.map((id) => api.deleteAsset(id, csrf)));
            setCheckedAssetIds(new Set());
            refreshOrganization();
          }}
        />
      )}

      {assets.isError && (
        <div className="notice notice--error">
          {assets.error instanceof ApiError
            ? assets.error.message
            : "The media library could not be loaded."}
        </div>
      )}
      {assets.isLoading ? (
        <div className="table-loading">Loading media…</div>
      ) : assets.data?.items?.length === 0 ? (
        <ContentEmpty
          canManage={canManage && libraryView === "active"}
          onChoose={() => fileInput.current?.click()}
          onDrop={dropFiles}
          archived={libraryView === "archive"}
        />
      ) : (
        <AssetCollection
          items={assets.data?.items ?? []}
          view={view}
          folderNames={
            new Map(
              (folders.data ?? []).map((folder) => [folder.id, folder.name]),
            )
          }
          onSelect={(asset) =>
            libraryView === "archive"
              ? setSelected(asset)
              : void api.asset(asset.id).then(setSelected)
          }
          canManage={canManage}
          archived={libraryView === "archive"}
          onDuplicate={(asset) =>
            void api
              .duplicateWidget(asset.id, csrf)
              .then(() =>
                queryClient.invalidateQueries({ queryKey: ["assets"] }),
              )
          }
          onArchive={async (asset) => {
            if (await confirm({
              title: `Move ${asset.name} to the archive?`,
              description:
                "The item will leave the active library and can be restored later.",
              confirmLabel: "Archive item",
            }))
              void api
                .archiveAssets([asset.id], csrf)
                .then(refreshOrganization);
          }}
          onRestore={(asset) => {
            void api.restoreAssets([asset.id], csrf).then(refreshOrganization);
          }}
          onDelete={async (asset) => {
            if (await confirm({
              title: `Permanently delete ${asset.name}?`,
              description: "This cannot be undone.",
              confirmLabel: "Delete permanently",
              tone: "negative",
            }))
              void api.deleteAsset(asset.id, csrf).then(refreshOrganization);
          }}
          selectedIds={checkedAssetIds}
          onToggle={(id) =>
            setCheckedAssetIds((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        />
      )}
      {selected && (
        <AssetDetails
          asset={selected}
          canManage={canManage && libraryView === "active"}
          csrf={csrf}
          onClose={() => setSelected(undefined)}
          onChanged={(asset) => {
            setSelected(asset);
            void queryClient.invalidateQueries({ queryKey: ["assets"] });
          }}
        />
      )}
    </section>
  );
}

export function ContentEmpty({
  canManage,
  onChoose,
  onDrop,
  archived = false,
}: {
  canManage: boolean;
  onChoose: () => void;
  onDrop?: (event: DragEvent) => void;
  archived?: boolean;
}) {
  return (
    <div
      className={assetCollectionStyles}
      onDragOver={(event) => event.preventDefault()}
      onDrop={archived ? undefined : onDrop}
    >
      <IllustratedMessage>
        {archived ? <Archive aria-hidden="true" /> : <FileImage aria-hidden="true" />}
        <Heading level={2}>{archived ? "Archive is empty" : "No media yet"}</Heading>
        <Content>
          <Text>
            {archived
              ? "Items you archive—or that reach their expiration—appear here and can be restored later."
              : canManage
                ? "Drag images or videos here, or choose files to begin your library."
                : "An Owner, Administrator, or Editor can upload media."}
          </Text>
        </Content>
        {canManage && !archived && (
          <SpectrumButton variant="accent" onPress={onChoose}>
            Choose files
          </SpectrumButton>
        )}
      </IllustratedMessage>
    </div>
  );
}

export function AssetCollection({
  items,
  view,
  onSelect,
  canManage = false,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
  selectedIds = new Set(),
  onToggle,
  folderNames,
  archived = false,
  onBulkArchive,
  onBulkRestore,
  onBulkDelete,
}: {
  items: Asset[];
  view: "grid" | "list";
  onSelect: (asset: Asset) => void;
  canManage?: boolean;
  onDuplicate?: (asset: Asset) => void;
  onArchive?: (asset: Asset) => void;
  onRestore?: (asset: Asset) => void;
  onDelete?: (asset: Asset) => void;
  selectedIds?: Set<string>;
  onToggle?: (id: string) => void;
  folderNames?: Map<string, string>;
  archived?: boolean;
  onBulkArchive?: (ids: string[]) => void | Promise<void>;
  onBulkRestore?: (ids: string[]) => void | Promise<void>;
  onBulkDelete?: (ids: string[]) => void | Promise<void>;
}) {
  const toggleToSelection = (keys: Selection) => {
    if (!onToggle) return;
    const next =
      keys === "all"
        ? new Set(items.map((asset) => asset.id))
        : new Set([...keys].map(String));
    for (const asset of items) {
      if (selectedIds.has(asset.id) !== next.has(asset.id)) onToggle(asset.id);
    }
  };

  const clearVisibleSelection = () => {
    if (!onToggle) return;
    for (const asset of items) if (selectedIds.has(asset.id)) onToggle(asset.id);
  };

  const statusVariant = (
    asset: Asset,
  ): "positive" | "negative" | "notice" | "informative" | "neutral" => {
    if (archived) return isExpiredAsset(asset) ? "notice" : "neutral";
    if (asset.processingStatus === "ready") return "positive";
    if (asset.processingStatus === "failed") return "negative";
    if (["queued", "inspecting", "processing", "uploading"].includes(asset.processingStatus))
      return "informative";
    return "neutral";
  };

  const openAsset = (key: Key) => {
    const asset = items.find((item) => item.id === String(key));
    if (asset) onSelect(asset);
  };

  return (
    <CardView
      aria-label={archived ? "Archived media" : "Media library"}
      items={items}
      layout={view === "grid" ? "grid" : "waterfall"}
      density={document.documentElement.dataset.density === "compact" ? "compact" : "regular"}
      size="M"
      selectionMode={canManage && onToggle ? "multiple" : "none"}
      selectedKeys={selectedIds}
      onSelectionChange={toggleToSelection}
      onAction={openAsset}
      styles={assetCollectionStyles}
      renderEmptyState={() => (
        <IllustratedMessage>
          <FileImage aria-hidden="true" />
          <Heading level={2}>No matching media</Heading>
          <Content><Text>Try a different search or filter.</Text></Content>
        </IllustratedMessage>
      )}
      renderActionBar={(keys) => {
        const ids =
          keys === "all"
            ? items.map((asset) => asset.id)
            : [...keys].map(String);
        return (
          <ActionBar
            selectedItemCount={keys === "all" ? "all" : keys.size}
            onClearSelection={clearVisibleSelection}
          >
            {!archived && onBulkArchive && (
              <ActionButton onPress={() => void onBulkArchive(ids)}>
                Archive selected
              </ActionButton>
            )}
            {archived && onBulkRestore && (
              <ActionButton onPress={() => void onBulkRestore(ids)}>
                Restore selected
              </ActionButton>
            )}
            {archived && onBulkDelete && (
              <ActionButton onPress={() => void onBulkDelete(ids)}>
                Delete permanently
              </ActionButton>
            )}
          </ActionBar>
        );
      }}
    >
      {(asset) => {
        const folderLabel = asset.folderId
          ? folderNames?.get(asset.folderId)
          : undefined;
        const providerLabel =
          asset.widget?.provider === "youtube"
            ? "YouTube"
            : asset.widget?.provider?.toUpperCase() ?? asset.website?.displayUrl;
        const dimensions =
          asset.width && asset.height ? `${asset.width} × ${asset.height}` : "";
        const detail = [
          asset.type === "video" ? formatDuration(asset.durationSeconds) : "",
          asset.type === "widget" ? providerLabel ?? "Widget" : "",
          dimensions,
          formatBytes(asset.originalSize),
        ]
          .filter(Boolean)
          .join(" · ");
        const label = archived
          ? isExpiredAsset(asset)
            ? "Expired"
            : "Archived"
          : statusLabel(asset.processingStatus);

        return (
          <SpectrumAssetCard id={asset.id} key={asset.id}>
            <CardPreview>
              <div className={assetPreviewStyles}>
                <AssetPreview asset={asset} />
              </div>
            </CardPreview>
            <Content>
              <ActionMenu
                aria-label={`Actions for ${asset.name}`}
                onAction={(key) => {
                  if (key === "open") onSelect(asset);
                  if (key === "duplicate") onDuplicate?.(asset);
                  if (key === "archive") onArchive?.(asset);
                  if (key === "restore") onRestore?.(asset);
                  if (key === "delete") onDelete?.(asset);
                }}
              >
                <MenuItem id="open">{archived ? "View details" : "Open"}</MenuItem>
                {canManage && asset.type === "widget" && onDuplicate && !archived && (
                  <MenuItem id="duplicate">Duplicate</MenuItem>
                )}
                {canManage && !archived && onArchive && (
                  <MenuItem id="archive">Archive</MenuItem>
                )}
                {canManage && archived && onRestore && (
                  <MenuItem id="restore">Restore to library</MenuItem>
                )}
                {canManage && archived && onDelete && (
                  <MenuItem id="delete">Delete permanently</MenuItem>
                )}
              </ActionMenu>
              <Heading slot="title" level={3}>{asset.name}</Heading>
              <Text slot="description">{detail || "Media asset"}</Text>
            </Content>
            <Footer>
              <StatusLight variant={statusVariant(asset)}>{label}</StatusLight>
              <div className={assetMetadataStyles}>
                {folderLabel && <Text>{folderLabel}</Text>}
                {asset.tags?.map((tag) => <Text key={tag.id}>{tag.name}</Text>)}
                {asset.type === "widget" && (
                  <Text>
                    {asset.playlistUsage ?? 0} playlists · {asset.layoutUsage?.length ?? 0} layouts
                  </Text>
                )}
              </div>
            </Footer>
          </SpectrumAssetCard>
        );
      }}
    </CardView>
  );
}

type OrganizerKind = "folder" | "collection" | "tag";

const organizerCopy: Record<
  OrganizerKind,
  { title: string; label: string; hint: string }
> = {
  folder: {
    title: "Create folder",
    label: "Folder name",
    hint: "Each asset lives in one folder. Use folders for broad areas like buildings or departments.",
  },
  collection: {
    title: "Create collection",
    label: "Collection name",
    hint: "Collections group related assets for reuse. An asset can belong to several collections.",
  },
  tag: {
    title: "Create tag",
    label: "Tag name",
    hint: "Tags are colored labels for quick filtering. An asset can have several tags.",
  },
};

export function CreateOrganizerDialog({
  kind,
  csrf,
  onClose,
  onCreated,
}: {
  kind: OrganizerKind;
  csrf: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState("#64748b");
  const create = useMutation({
    mutationFn: (): Promise<unknown> =>
      kind === "folder"
        ? api.createContentFolder({ name, description: "" }, csrf)
        : kind === "collection"
          ? api.createContentCollection({ name, description: "" }, csrf)
          : api.createContentTag({ name, color }, csrf),
    onSuccess: () => {
      onCreated();
      onClose();
    },
  });
  const copy = organizerCopy[kind];
  return (
    <Dialog open title={copy.title} onClose={onClose}>
      <form
        className="organizer-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <p className="organizer-dialog__hint">{copy.hint}</p>
        <label className="field">
          <span className="field__label">{copy.label}</span>
          <input
            autoFocus
            required
            value={name}
            maxLength={kind === "tag" ? 60 : 120}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {kind === "tag" && (
          <label className="field organizer-dialog__color">
            <span className="field__label">Color</span>
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
          </label>
        )}
        {create.isError && (
          <Notice variant="danger">
            {create.error instanceof ApiError
              ? create.error.message
              : `The ${kind} could not be created.`}
          </Notice>
        )}
        <div className="form-actions">
          <Button variant="quiet" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={create.isPending}>
            {copy.title}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ManageOrganizerRow({
  name,
  count,
  onRename,
  onDelete,
}: {
  name: string;
  count: number;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setEditing(false);
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "The change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="organizer-manage__row">
      {editing ? (
        <form
          className="organizer-manage__edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) void run(() => onRename(value));
          }}
        >
          <input
            autoFocus
            required
            aria-label={`New name for ${name}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button
            type="submit"
            className="button button--primary"
            disabled={busy}
          >
            Save
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              setEditing(false);
              setValue(name);
              setError("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <span className="organizer-manage__name">
            {name} <small>({count})</small>
          </span>
          <span className="organizer-manage__actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setEditing(true)}
            >
              <Pencil size={13} aria-hidden /> Rename
            </button>
            <button
              type="button"
              className="button button--danger-quiet"
              disabled={busy}
              onClick={() => void run(onDelete)}
            >
              <Trash2 size={13} aria-hidden /> Delete
            </button>
          </span>
        </>
      )}
      {error && <span className="field__error">{error}</span>}
    </li>
  );
}

function ManageOrganizationDialog({
  folders,
  collections,
  tags,
  csrf,
  onChanged,
  onClose,
}: {
  folders: ContentFolder[];
  collections: ContentCollection[];
  tags: ContentTag[];
  csrf: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { confirm } = useSpectrumDialogs();
  const sections: {
    title: string;
    empty: string;
    rows: {
      id: string;
      name: string;
      count: number;
      rename: (name: string) => Promise<unknown>;
      remove: () => Promise<unknown>;
      confirmText: string;
    }[];
  }[] = [
    {
      title: "Folders",
      empty: "No folders yet.",
      rows: folders.map((folder) => ({
        id: folder.id,
        name: folder.name,
        count: folder.assetCount,
        rename: (name) =>
          api.updateContentFolder(
            folder.id,
            {
              name,
              description: folder.description,
              parentId: folder.parentId,
            },
            csrf,
          ),
        remove: () => api.deleteContentFolder(folder.id, csrf),
        confirmText: `Delete the folder "${folder.name}"? Its assets stay in the library and become unfiled.`,
      })),
    },
    {
      title: "Collections",
      empty: "No collections yet.",
      rows: collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        count: collection.assetCount,
        rename: (name) =>
          api.updateContentCollection(
            collection.id,
            { name, description: collection.description },
            csrf,
          ),
        remove: () => api.deleteContentCollection(collection.id, csrf),
        confirmText: `Delete the collection "${collection.name}"? Its assets stay in the library.`,
      })),
    },
    {
      title: "Tags",
      empty: "No tags yet.",
      rows: tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        count: tag.assetCount ?? 0,
        rename: (name) =>
          api.updateContentTag(tag.id, { name, color: tag.color }, csrf),
        remove: () => api.deleteContentTag(tag.id, csrf),
        confirmText: `Delete the tag "${tag.name}"? It is removed from all assets.`,
      })),
    },
  ];
  return (
    <Dialog
      open
      title="Manage organization"
      onClose={onClose}
      className="organizer-manage"
    >
      {sections.map((section) => (
        <section key={section.title} className="organizer-manage__section">
          <h3>{section.title}</h3>
          {section.rows.length === 0 ? (
            <p className="organizer-manage__empty">{section.empty}</p>
          ) : (
            <ul>
              {section.rows.map((row) => (
                <ManageOrganizerRow
                  key={row.id}
                  name={row.name}
                  count={row.count}
                  onRename={async (name) => {
                    await row.rename(name);
                    onChanged();
                  }}
                  onDelete={async () => {
                    if (!(await confirm({
                      title: `Delete ${row.name}?`,
                      description: row.confirmText,
                      confirmLabel: "Delete",
                      tone: "negative",
                    }))) return;
                    await row.remove();
                    onChanged();
                  }}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
    </Dialog>
  );
}

function ContentOrganizer({
  csrf,
  folders,
  collections,
  tags,
  assetIds,
  onApplied,
  onCatalogChanged,
  onSelectAll,
  onClear,
  archiveMode,
  onArchive,
  onRestore,
  onDelete,
}: {
  csrf: string;
  folders: ContentFolder[];
  collections: ContentCollection[];
  tags: ContentTag[];
  assetIds: string[];
  onApplied: () => void;
  onCatalogChanged: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  archiveMode: boolean;
  onArchive: () => Promise<void>;
  onRestore: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [folderId, setFolderId] = useState("");
  const [tagId, setTagId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<OrganizerKind>();
  const [managing, setManaging] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "The selected content could not be updated.",
      );
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!assetIds.length) return;
    setError("");
    try {
      const [tagAction, selectedTagId] = tagId.split(":");
      const [collectionAction, selectedCollectionId] = collectionId.split(":");
      await api.bulkOrganize(
        {
          assetIds,
          ...(folderId
            ? {
                setFolder: true,
                ...(folderId === "unfiled" ? {} : { folderId }),
              }
            : {}),
          ...(selectedTagId
            ? tagAction === "remove"
              ? { removeTagIds: [selectedTagId] }
              : { addTagIds: [selectedTagId] }
            : {}),
          ...(selectedCollectionId
            ? collectionAction === "remove"
              ? { removeCollectionIds: [selectedCollectionId] }
              : { addCollectionIds: [selectedCollectionId] }
            : {}),
        },
        csrf,
      );
      setFolderId("");
      setTagId("");
      setCollectionId("");
      setOrganizing(false);
      onApplied();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Content could not be organized.",
      );
    }
  };
  return (
    <div className="content-organizer" aria-label="Content organization">
      {!archiveMode && assetIds.length === 0 && (
        <div className="content-organizer__create">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setCreating("folder")}
          >
            <FolderPlus size={15} /> Create folder
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setCreating("collection")}
          >
            <Library size={15} /> Create collection
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setCreating("tag")}
          >
            <Tags size={15} /> Create tag
          </button>
          {(folders.length > 0 ||
            collections.length > 0 ||
            tags.length > 0) && (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setManaging(true)}
            >
              <Pencil size={15} /> Manage
            </button>
          )}
        </div>
      )}
      {assetIds.length > 0 && (
        <div className="content-organizer__bulk">
          <strong>{assetIds.length} selected</strong>
          <span className="content-organizer__selection-actions">
            <button
              type="button"
              className="button button--quiet"
              onClick={onSelectAll}
            >
              Select page
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={onClear}
            >
              Clear
            </button>
          </span>
          <span className="content-organizer__primary-actions">
            {!archiveMode && (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => setOrganizing(true)}
              >
                <Folder size={15} /> Organize
              </button>
            )}
            <button
              type="button"
              className="button button--quiet"
              disabled={busy}
              onClick={() => void run(archiveMode ? onRestore : onArchive)}
            >
              {archiveMode ? (
                <ArchiveRestore size={15} />
              ) : (
                <Archive size={15} />
              )}
              {archiveMode ? "Restore" : "Archive"}
            </button>
            {archiveMode && (
              <button
                type="button"
                className="button button--danger-quiet"
                disabled={busy}
                onClick={() => void run(onDelete)}
              >
                <Trash2 size={15} /> Delete permanently
              </button>
            )}
          </span>
        </div>
      )}
      {error && <span className="notice notice--error">{error}</span>}
      {creating && (
        <CreateOrganizerDialog
          kind={creating}
          csrf={csrf}
          onClose={() => setCreating(undefined)}
          onCreated={onCatalogChanged}
        />
      )}
      {managing && (
        <ManageOrganizationDialog
          folders={folders}
          collections={collections}
          tags={tags}
          csrf={csrf}
          onChanged={onCatalogChanged}
          onClose={() => setManaging(false)}
        />
      )}
      {organizing && (
        <Dialog
          open
          title={`Organize ${assetIds.length} selected item${assetIds.length === 1 ? "" : "s"}`}
          onClose={() => setOrganizing(false)}
        >
          <div className="bulk-organize-dialog">
            <p>
              Choose one or more changes. Existing tags and collections stay
              unless you explicitly remove them.
            </p>
            <label className="field">
              <span className="field__label">Move to folder</span>
              <Select
                value={folderId}
                onChange={(event) => setFolderId(event.target.value)}
              >
                <option value="">Leave folder unchanged</option>
                <option value="unfiled">Move to Unfiled</option>
                {folders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Tag change</span>
              <Select
                value={tagId}
                onChange={(event) => setTagId(event.target.value)}
              >
                <option value="">Leave tags unchanged</option>
                {tags.map((tag) => (
                  <option key={`add-${tag.id}`} value={`add:${tag.id}`}>
                    Add {tag.name}
                  </option>
                ))}
                {tags.map((tag) => (
                  <option key={`remove-${tag.id}`} value={`remove:${tag.id}`}>
                    Remove {tag.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Collection change</span>
              <Select
                value={collectionId}
                onChange={(event) => setCollectionId(event.target.value)}
              >
                <option value="">Leave collections unchanged</option>
                {collections.map((collection) => (
                  <option
                    key={`add-${collection.id}`}
                    value={`add:${collection.id}`}
                  >
                    Add to {collection.name}
                  </option>
                ))}
                {collections.map((collection) => (
                  <option
                    key={`remove-${collection.id}`}
                    value={`remove:${collection.id}`}
                  >
                    Remove from {collection.name}
                  </option>
                ))}
              </Select>
            </label>
            <div className="form-actions">
              <Button
                variant="quiet"
                type="button"
                onClick={() => setOrganizing(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type="button"
                disabled={!folderId && !tagId && !collectionId}
                onClick={() => void apply()}
              >
                Apply changes
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function AssetDetails(props: {
  asset: Asset;
  canManage: boolean;
  csrf: string;
  onClose: () => void;
  onChanged: (asset: Asset) => void;
}) {
  return props.asset.type === "widget" &&
    props.asset.widget?.provider === "website" ? (
    <WebsiteEditor
      asset={props.asset}
      csrf={props.csrf}
      readOnly={!props.canManage}
      onClose={props.onClose}
      onSaved={props.onChanged}
    />
  ) : props.asset.type === "widget" &&
    props.asset.widget?.provider === "youtube" ? (
    <YouTubeSourceEditor
      asset={props.asset}
      csrf={props.csrf}
      readOnly={!props.canManage}
      onClose={props.onClose}
      onSaved={props.onChanged}
    />
  ) : props.asset.type === "widget" &&
    props.asset.widget &&
    [
      "clock",
      "date",
      "qrcode",
      "ticker",
      "menu",
      "list",
      "table",
      "agenda",
    ].includes(props.asset.widget.provider) ? (
    <NativeAppEditor
      provider={
        props.asset.widget.provider as
          | "clock"
          | "date"
          | "qrcode"
          | "ticker"
          | "menu"
          | "list"
          | "table"
          | "agenda"
      }
      asset={props.asset}
      csrf={props.csrf}
      readOnly={!props.canManage}
      onClose={props.onClose}
      onSaved={props.onChanged}
    />
  ) : (
    <MediaAssetDetails {...props} />
  );
}
export function AssetOrganization({
  asset,
  canManage,
  csrf,
  onChanged,
}: {
  asset: Asset;
  canManage: boolean;
  csrf: string;
  onChanged: (asset: Asset) => void;
}) {
  const queryClient = useQueryClient();
  const folders = useQuery({
    queryKey: ["content-folders"],
    queryFn: api.contentFolders,
  });
  const collections = useQuery({
    queryKey: ["content-collections"],
    queryFn: api.contentCollections,
  });
  const tags = useQuery({
    queryKey: ["content-tags"],
    queryFn: api.contentTags,
  });
  const organize = useMutation({
    mutationFn: async (input: Omit<BulkOrganizeInput, "assetIds">) => {
      await api.bulkOrganize({ assetIds: [asset.id], ...input }, csrf);
      return api.asset(asset.id);
    },
    onSuccess: (latest) => {
      onChanged(latest);
      void queryClient.invalidateQueries({ queryKey: ["content-folders"] });
      void queryClient.invalidateQueries({
        queryKey: ["content-collections"],
      });
      void queryClient.invalidateQueries({ queryKey: ["content-tags"] });
    },
  });
  const assetTagIds = new Set((asset.tags ?? []).map((tag) => tag.id));
  const assetCollectionIds = new Set(asset.collectionIds ?? []);
  if (
    !canManage &&
    !asset.folderId &&
    assetTagIds.size === 0 &&
    assetCollectionIds.size === 0
  )
    return null;
  return (
    <section className="asset-organization" aria-label="Organization">
      <h3>Organization</h3>
      <label className="field">
        <span className="field__label">Folder</span>
        <Select
          aria-label="Folder"
          value={asset.folderId ?? ""}
          disabled={!canManage || organize.isPending}
          onChange={(event) =>
            organize.mutate({
              setFolder: true,
              ...(event.target.value ? { folderId: event.target.value } : {}),
            })
          }
        >
          <option value="">Unfiled</option>
          {folders.data?.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </Select>
      </label>
      <div className="asset-organization__group">
        <span className="field__label">Tags</span>
        {(tags.data?.length ?? 0) === 0 ? (
          <p className="asset-organization__empty">
            No tags yet. Create tags from the media library toolbar.
          </p>
        ) : (
          <div className="asset-organization__chips">
            {tags.data?.map((tag) => {
              const active = assetTagIds.has(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`organizer-chip${active ? " organizer-chip--active" : ""}`}
                  aria-pressed={active}
                  disabled={!canManage || organize.isPending}
                  onClick={() =>
                    organize.mutate(
                      active
                        ? { removeTagIds: [tag.id] }
                        : { addTagIds: [tag.id] },
                    )
                  }
                >
                  <span
                    className="organizer-chip__dot"
                    style={{ backgroundColor: tag.color }}
                    aria-hidden
                  />
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="asset-organization__group">
        <span className="field__label">Collections</span>
        {(collections.data?.length ?? 0) === 0 ? (
          <p className="asset-organization__empty">
            No collections yet. Create collections from the media library
            toolbar.
          </p>
        ) : (
          <div className="asset-organization__chips">
            {collections.data?.map((collection) => {
              const active = assetCollectionIds.has(collection.id);
              return (
                <button
                  key={collection.id}
                  type="button"
                  className={`organizer-chip${active ? " organizer-chip--active" : ""}`}
                  aria-pressed={active}
                  disabled={!canManage || organize.isPending}
                  onClick={() =>
                    organize.mutate(
                      active
                        ? { removeCollectionIds: [collection.id] }
                        : { addCollectionIds: [collection.id] },
                    )
                  }
                >
                  {collection.name}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {organize.isError && (
        <Notice variant="danger">
          {organize.error instanceof ApiError
            ? organize.error.message
            : "Organization could not be updated."}
        </Notice>
      )}
    </section>
  );
}

function MediaAssetDetails({
  asset,
  canManage,
  csrf,
  onClose,
  onChanged,
}: {
  asset: Asset;
  canManage: boolean;
  csrf: string;
  onClose: () => void;
  onChanged: (asset: Asset) => void;
}) {
  const { confirm } = useSpectrumDialogs();
  const queryClient = useQueryClient();
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description);
  const [availableFrom, setAvailableFrom] = useState(
    dateTimeLocalValue(asset.availableFrom),
  );
  const [expiresAt, setExpiresAt] = useState(
    dateTimeLocalValue(asset.expiresAt),
  );
  const mutation = useMutation({
    mutationFn: () =>
      api.updateAsset(
        asset.id,
        {
          name,
          description,
          availabilitySet: true,
          ...(availableFrom
            ? { availableFrom: new Date(availableFrom).toISOString() }
            : {}),
          ...(expiresAt
            ? { expiresAt: new Date(expiresAt).toISOString() }
            : {}),
        },
        csrf,
      ),
    onSuccess: onChanged,
  });
  return (
    <Drawer
      className="asset-details-drawer"
      eyebrow="Media asset"
      title={asset.name}
      closeLabel="Close asset details"
      onClose={onClose}
      footer={
        canManage ? (
          <>
            <Button
              variant="primary"
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              Save changes
            </Button>
            {asset.processingStatus === "failed" && (
              <Button
                variant="quiet"
                onClick={() =>
                  void api.retryAsset(asset.id, csrf).then(onChanged)
                }
              >
                Retry processing
              </Button>
            )}
            <Button
              variant="quiet"
              onClick={async () => {
                if (await confirm({
                  title: `Move ${asset.name} to the archive?`,
                  description:
                    "The item will leave the active library and can be restored later.",
                  confirmLabel: "Archive item",
                }))
                  void api.archiveAssets([asset.id], csrf).then(() => {
                    void queryClient.invalidateQueries({
                      queryKey: ["assets"],
                    });
                    onClose();
                  });
              }}
            >
              <Archive size={15} /> Archive asset
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="asset-details">
        {asset.thumbnailUrl && (
          <img
            className="details-preview"
            src={asset.thumbnailUrl}
            alt=""
            draggable={false}
          />
        )}
        <label className="field">
          <span className="field__label">Name</span>
          <input
            value={name}
            disabled={!canManage}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <div className="form-grid form-grid--two">
          <label className="field">
            <span className="field__label">Available from</span>
            <input
              type="datetime-local"
              value={availableFrom}
              disabled={!canManage}
              onChange={(event) => setAvailableFrom(event.target.value)}
            />
            <span className="field__hint">
              Leave blank to make this content available immediately.
            </span>
          </label>
          <label className="field">
            <span className="field__label">Expires at</span>
            <input
              type="datetime-local"
              value={expiresAt}
              disabled={!canManage}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <span className="field__hint">
              The Player stops using it at this local date and time, even
              offline.
            </span>
          </label>
        </div>
        <label className="field">
          <span className="field__label">Description</span>
          <textarea
            value={description}
            disabled={!canManage}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <AssetOrganization
          asset={asset}
          canManage={canManage}
          csrf={csrf}
          onChanged={onChanged}
        />
        <dl>
          <div>
            <dt>Status</dt>
            <dd>{statusLabel(asset.processingStatus)}</dd>
          </div>
          <div>
            <dt>Original file</dt>
            <dd>{asset.originalFilename}</dd>
          </div>
          <div>
            <dt>Detected type</dt>
            <dd>{asset.detectedMimeType}</dd>
          </div>
          <div>
            <dt>SHA-256</dt>
            <dd className="hash">{asset.sha256}</dd>
          </div>
        </dl>
        <UsedByPanel
          emptyMessage="No playlist or Layout uses this media yet."
          groups={[
            {
              label: "Playlists",
              items: asset.playlistsUsing ?? [],
              to: (playlistId) => `/playlists/${playlistId}`,
            },
            {
              label: "Layouts",
              items: (asset.layoutUsage ?? []).map((usage) => ({
                id: usage.id,
                name: usage.name,
                hint: usage.published ? "Published" : "Draft",
              })),
              to: (layoutId) => `/layouts/${layoutId}`,
            },
          ]}
        />
        {asset.errorMessage && (
          <div className="notice notice--error">{asset.errorMessage}</div>
        )}
      </div>
    </Drawer>
  );
}

function dateTimeLocalValue(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const defaultWebsite: WebsiteInput = {
  name: "",
  description: "",
  url: "https://",
  allowedHosts: [],
  javascriptEnabled: true,
  domStorageEnabled: true,
  cookiePolicy: "first_party",
  reloadPolicy: "on_each_activation",
  loadTimeoutSeconds: 20,
  zoomPercent: 100,
  scrollX: 0,
  scrollY: 0,
  customUserAgent: "",
  backgroundColor: signalColors.playerBackground,
  failureBehavior: "placeholder",
};
export function WebsiteEditor({
  asset,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page = false,
}: {
  asset?: Asset;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (asset: Asset) => void;
  page?: boolean;
}) {
  const { confirm } = useSpectrumDialogs();
  const closeConfirmationOpen = useRef(false);
  const initial: WebsiteInput = asset?.website
    ? {
        name: asset.name,
        description: asset.description,
        url: asset.website.url,
        allowedHosts: asset.website.allowedHosts,
        javascriptEnabled: asset.website.javascriptEnabled,
        domStorageEnabled: asset.website.domStorageEnabled,
        cookiePolicy: asset.website.cookiePolicy,
        reloadPolicy: asset.website.reloadPolicy,
        refreshIntervalSeconds: asset.website.refreshIntervalSeconds,
        loadTimeoutSeconds: asset.website.loadTimeoutSeconds,
        zoomPercent: asset.website.zoomPercent,
        scrollX: asset.website.scrollX,
        scrollY: asset.website.scrollY,
        customUserAgent: asset.website.customUserAgent,
        backgroundColor: asset.website.backgroundColor,
        failureBehavior: asset.website.failureBehavior,
        fallbackImageAssetId: asset.website.fallbackImageAssetId,
      }
    : defaultWebsite;
  const [input, setInput] = useState(initial),
    [dirty, setDirty] = useState(false);
  const set = <K extends keyof WebsiteInput>(
    key: K,
    value: WebsiteInput[K],
  ) => {
    setInput((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    addEventListener("beforeunload", handler);
    return () => removeEventListener("beforeunload", handler);
  }, [dirty]);
  const images = useQuery({
    queryKey: ["assets", "website-fallbacks"],
    queryFn: () =>
      api.assets(
        new URLSearchParams({
          page: "1",
          pageSize: "100",
          type: "image",
          status: "ready",
        }),
      ),
  });
  const diagnostics = useQuery({
    queryKey: ["assets", asset?.id, "website-diagnostics"],
    queryFn: () => api.websiteDiagnostics(asset!.id),
    enabled: !!asset,
  });
  const save = useMutation({
    mutationFn: () => {
      const { name, description, ...configuration } = input;
      const sourceInput = {
        provider: "website" as const,
        name,
        description,
        configuration,
      };
      return asset
        ? api.updateWidget(asset.id, sourceInput, csrf)
        : api.createWidget(sourceInput, csrf);
    },
    onSuccess: (value) => {
      setDirty(false);
      onSaved(value);
    },
  });
  const close = async () => {
    if (closeConfirmationOpen.current) return;
    if (!dirty) {
      onClose();
      return;
    }
    closeConfirmationOpen.current = true;
    try {
      if (await confirm({
        title: "Discard unsaved website changes?",
        description: "Your edits to this Website App will be lost.",
        confirmLabel: "Discard changes",
        tone: "negative",
      })) onClose();
    } finally {
      closeConfirmationOpen.current = false;
    }
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        void close();
      }
    };
    addEventListener("keydown", escape);
    return () => removeEventListener("keydown", escape);
  }, [close]);
  return (
    <div
      className="details-backdrop"
      role={page ? undefined : "presentation"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) void close();
      }}
    >
      <section
        className="asset-details website-editor"
        role={page ? undefined : "dialog"}
        aria-modal={page ? undefined : true}
      >
        <header>
          <div>
            <h2>{asset ? "Edit Website App" : "Create Website App"}</h2>
            <p>
              Fullscreen public website content. Duration is configured in the
              playlist.
            </p>
          </div>
          <button className="icon-button" aria-label="Close" onClick={close}>
            <X size={18} />
          </button>
        </header>
        <label className="field">
          <span className="field__label">Name</span>
          <input
            disabled={readOnly}
            value={input.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Description</span>
          <textarea
            disabled={readOnly}
            value={input.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">HTTPS URL</span>
          <input
            disabled={readOnly}
            value={input.url}
            onChange={(e) => set("url", e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Reload policy</span>
          <Select
            disabled={readOnly}
            value={input.reloadPolicy}
            onChange={(e) =>
              set(
                "reloadPolicy",
                e.target.value as WebsiteInput["reloadPolicy"],
              )
            }
          >
            <option value="load_once">Load once while active</option>
            <option value="on_each_activation">
              Reload on each activation
            </option>
            <option value="interval">Reload on interval</option>
          </Select>
        </label>
        {input.reloadPolicy === "interval" && (
          <label className="field">
            <span className="field__label">Refresh interval (seconds)</span>
            <input
              disabled={readOnly}
              type="number"
              min={30}
              value={input.refreshIntervalSeconds ?? 30}
              onChange={(e) =>
                set("refreshIntervalSeconds", Number(e.target.value))
              }
            />
          </label>
        )}
        <label className="field">
          <span className="field__label">Failure behavior</span>
          <Select
            disabled={readOnly}
            value={input.failureBehavior}
            onChange={(e) =>
              set(
                "failureBehavior",
                e.target.value as WebsiteInput["failureBehavior"],
              )
            }
          >
            <option value="placeholder">Show Tilecast placeholder</option>
            <option value="last_success">Keep last rendered page</option>
            <option value="fallback_image">Show fallback image</option>
            <option value="skip">Skip item</option>
          </Select>
        </label>
        <label className="field">
          <span className="field__label">Fallback image</span>
          <Select
            disabled={readOnly}
            value={input.fallbackImageAssetId ?? ""}
            onChange={(e) =>
              set("fallbackImageAssetId", e.target.value || undefined)
            }
          >
            <option value="">None</option>
            {images.data?.items?.map((image) => (
              <option key={image.id} value={image.id}>
                {image.name}
              </option>
            ))}
          </Select>
        </label>
        <details>
          <summary>Advanced website settings</summary>
          <label className="field">
            <span className="field__label">
              Allowed top-level hosts (comma separated)
            </span>
            <input
              disabled={readOnly}
              value={input.allowedHosts.join(", ")}
              onChange={(e) =>
                set(
                  "allowedHosts",
                  e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                )
              }
            />
            <small>
              The URL host is always added. This restricts top-level navigation,
              not all third-party subresources.
            </small>
          </label>
          <label>
            <input
              disabled={readOnly}
              type="checkbox"
              checked={input.javascriptEnabled}
              onChange={(e) => set("javascriptEnabled", e.target.checked)}
            />{" "}
            JavaScript enabled
          </label>
          <label>
            <input
              disabled={readOnly}
              type="checkbox"
              checked={input.domStorageEnabled}
              onChange={(e) => set("domStorageEnabled", e.target.checked)}
            />{" "}
            DOM storage enabled
          </label>
          <label className="field">
            <span className="field__label">Cookies</span>
            <Select
              disabled={readOnly}
              value={input.cookiePolicy}
              onChange={(e) =>
                set(
                  "cookiePolicy",
                  e.target.value as WebsiteInput["cookiePolicy"],
                )
              }
            >
              <option value="disabled">Disabled</option>
              <option value="first_party">First-party only</option>
              <option value="first_and_third_party">
                First- and third-party
              </option>
            </Select>
          </label>
          <label className="field">
            <span className="field__label">Load timeout (seconds)</span>
            <input
              disabled={readOnly}
              type="number"
              min={1}
              max={120}
              value={input.loadTimeoutSeconds}
              onChange={(e) =>
                set("loadTimeoutSeconds", Number(e.target.value))
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Zoom percentage</span>
            <input
              disabled={readOnly}
              type="number"
              min={50}
              max={200}
              value={input.zoomPercent}
              onChange={(e) => set("zoomPercent", Number(e.target.value))}
            />
          </label>
          <div className="website-position">
            <label className="field">
              <span className="field__label">Horizontal scroll</span>
              <input
                disabled={readOnly}
                type="number"
                min={0}
                value={input.scrollX}
                onChange={(e) => set("scrollX", Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">Vertical scroll</span>
              <input
                disabled={readOnly}
                type="number"
                min={0}
                value={input.scrollY}
                onChange={(e) => set("scrollY", Number(e.target.value))}
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">Custom user agent</span>
            <input
              disabled={readOnly}
              maxLength={512}
              value={input.customUserAgent}
              onChange={(e) => set("customUserAgent", e.target.value)}
            />
            <small>
              Leave blank for Android WebView’s standard user agent. Overrides
              can break sites.
            </small>
          </label>
        </details>
        {diagnostics.data && (
          <section className="website-diagnostics">
            <h3>Player diagnostics</h3>
            <p>Allowed hosts: {diagnostics.data.allowedHosts.join(", ")}</p>
            <p>
              Last successful load:{" "}
              {diagnostics.data.lastSuccessfulLoad
                ? new Date(diagnostics.data.lastSuccessfulLoad).toLocaleString()
                : "Not reported"}
            </p>
            <p>
              Last failure:{" "}
              {diagnostics.data.lastFailureCategory ?? "Not reported"}
            </p>
            <p>
              Reporting screens:{" "}
              {diagnostics.data.reportingScreens
                .map((screen) => `${screen.name} (${screen.state})`)
                .join(", ") || "None"}
            </p>
          </section>
        )}
        {save.error && (
          <div className="notice notice--error">{save.error.message}</div>
        )}
        <footer>
          {!readOnly && (
            <button
              className="button button--primary"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              Save website
            </button>
          )}
          <button className="button button--quiet" onClick={close}>
            Cancel
          </button>
          {asset && !readOnly && (
            <button
              className="button button--danger"
              onClick={async () => {
                if (await confirm({
                  title: `Delete ${asset.name}?`,
                  description: "This Website App will be permanently removed.",
                  confirmLabel: "Delete Website App",
                  tone: "negative",
                }))
                  void api.deleteAsset(asset.id, csrf).then(onClose);
              }}
            >
              Delete website
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
