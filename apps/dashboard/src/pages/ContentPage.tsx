import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  Copy,
  EllipsisVertical,
  FileImage,
  FileUp,
  Folder,
  FolderPlus,
  Grid2X2,
  Library,
  List,
  Pencil,
  RotateCcw,
  SquarePen,
  Tags,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { signalColors } from "@tilecast/design-tokens/values";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api, ApiError } from "../api/client";
import { useFormatLocale } from "../i18n";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "../components/ui/attachment";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Progress } from "../components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
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
import { NativeAppEditor, YouTubeSourceEditor } from "../content/SourceEditors";
import { AssetPreview } from "../components/content/AssetPreview";
import { droppedFiles } from "../components/content/dragDrop";
import { UsedByPanel } from "../content/UsedByPanel";

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

export type ContentT = TFunction<"content", undefined>;

export function canManageContent(user?: User) {
  return Boolean(user && user.role !== "viewer");
}

const statusKeys = {
  uploading: "media.status.uploading",
  uploaded: "media.status.uploaded",
  queued: "media.status.waiting",
  inspecting: "media.status.inspecting",
  processing: "media.status.processing",
  ready: "media.status.ready",
  failed: "media.status.failed",
  deleting: "media.status.deleting",
  deleted: "media.status.deleted",
} as const satisfies Record<AssetStatus, string>;

export function statusLabel(status: AssetStatus, t: ContentT) {
  return t(statusKeys[status]);
}

const queueStateKeys = {
  waiting: "media.status.waiting",
  uploading: "media.status.uploading",
  finalizing: "media.queue.stateFinalizing",
  processing: "media.status.processing",
  failed: "media.status.failed",
} as const;

export function queueStateLabel(state: QueueItem["state"], t: ContentT) {
  return t(queueStateKeys[state]);
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

function SingleToggleGroup<Value extends string>({
  label,
  value,
  onChange,
  options,
  variant,
  spacing,
}: {
  label: string;
  value: Value;
  onChange: (value: Value) => void;
  options: readonly { value: Value; label: ReactNode; text: string }[];
  variant?: "default" | "outline";
  spacing?: number;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      variant={variant}
      spacing={spacing}
      multiple={false}
      value={[value]}
      onValueChange={(next) => {
        const first = next[0];
        if (first !== undefined) onChange(first as Value);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          aria-label={option.text}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  id,
  disabled,
  className,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  const resolved = value ?? "";
  return (
    <Select
      items={options}
      value={resolved}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={id ? undefined : label}
        className={className}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ContentPage() {
  const { t } = useTranslation(["content", "common"]);
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
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [confirmArchiveAsset, setConfirmArchiveAsset] = useState<Asset | null>(
    null,
  );
  const [confirmDeleteAsset, setConfirmDeleteAsset] = useState<Asset | null>(
    null,
  );
  const deleteCheckedAssets = async () => {
    const ids = [...checkedAssetIds];
    await Promise.all(ids.map((id) => api.deleteAsset(id, csrf)));
    setCheckedAssetIds(new Set());
    refreshOrganization();
  };
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
        error: t("media.queue.resumePrompt"),
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
        error: t("media.queue.fileMismatch"),
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
          error:
            error instanceof Error
              ? error.message
              : t("media.queue.uploadFailed"),
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
      className="w-full min-w-0 space-y-5"
      onDragOver={(event) => event.preventDefault()}
      onDrop={libraryView === "active" ? dropFiles : undefined}
    >
      <header className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{t("media.header.title")}</h1>
          {canManage && libraryView === "active" && (
            <Button type="button" onClick={() => fileInput.current?.click()}>
              <Upload size={16} aria-hidden="true" />{" "}
              {t("media.header.uploadAssets")}
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {libraryView === "active"
            ? t("media.header.descriptionActive")
            : t("media.header.descriptionArchive")}
          {typeof assets.data?.total === "number" && (
            <> {t("media.header.total", { total: assets.data.total })}</>
          )}
        </p>
      </header>
      <SingleToggleGroup
        label={t("media.libraryView.label")}
        value={libraryView}
        onChange={setLibraryView}
        options={[
          {
            value: "active",
            label: t("media.libraryView.library"),
            text: t("media.libraryView.library"),
          },
          {
            value: "archive",
            label: t("media.libraryView.archive"),
            text: t("media.libraryView.archive"),
          },
        ]}
      />
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,video/x-matroska"
        onChange={pickFiles}
        aria-label={t("media.upload.chooseFilesAria")}
      />

      {libraryView === "active" && queue.length > 0 && (
        <section className="space-y-2" aria-label={t("media.queue.label")}>
          <p className="text-sm font-medium">
            {t("media.queue.title")}{" "}
            <span className="font-normal text-muted-foreground">
              {t("media.queue.activeCount", { count: queue.length })}
            </span>
          </p>
          {queue.map((item) => {
            const percent = Math.round(
              (item.uploadedBytes / item.sizeBytes) * 100,
            );
            return (
              <Attachment
                key={item.localId}
                state={
                  item.state === "failed"
                    ? "error"
                    : item.state === "uploading"
                      ? "uploading"
                      : item.state === "waiting"
                        ? "idle"
                        : "processing"
                }
              >
                <AttachmentMedia>
                  <FileUp aria-hidden="true" />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{item.filename}</AttachmentTitle>
                  <AttachmentDescription>
                    {t("media.queue.progress", {
                      uploaded: formatBytes(item.uploadedBytes),
                      size: formatBytes(item.sizeBytes),
                      percent,
                      state: queueStateLabel(item.state, t),
                    })}
                  </AttachmentDescription>
                  {item.error && (
                    <p className="text-sm text-destructive">{item.error}</p>
                  )}
                  <Progress
                    aria-label={t("media.queue.progressAria", {
                      filename: item.filename,
                    })}
                    value={percent}
                  />
                </AttachmentContent>
                <AttachmentActions>
                  {item.state === "failed" && (
                    <AttachmentAction
                      aria-label={t("media.queue.retryAria", {
                        filename: item.filename,
                      })}
                      onClick={() => resume(item)}
                    >
                      <RotateCcw aria-hidden="true" />
                    </AttachmentAction>
                  )}
                  <AttachmentAction
                    aria-label={t("media.queue.cancelAria", {
                      filename: item.filename,
                    })}
                    onClick={() => void cancel(item)}
                  >
                    <X aria-hidden="true" />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            );
          })}
        </section>
      )}

      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label={t("media.filters.searchLabel")}
          placeholder={t("media.filters.searchLabel")}
        />
        <SingleToggleGroup
          label={t("media.filters.typeLabel")}
          value={contentFilter}
          onChange={setContentFilter}
          options={[
            {
              value: "media",
              label: t("media.filters.typeMedia"),
              text: t("media.filters.typeMedia"),
            },
            {
              value: "image",
              label: t("media.filters.typeImages"),
              text: t("media.filters.typeImages"),
            },
            {
              value: "video",
              label: t("media.filters.typeVideos"),
              text: t("media.filters.typeVideos"),
            },
          ]}
        />
        <FilterSelect
          label={t("media.filters.statusLabel")}
          className="w-40 max-sm:flex-1"
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: t("media.filters.statusAll") },
            { value: "ready", label: t("media.status.ready") },
            { value: "queued", label: t("media.status.waiting") },
            { value: "inspecting", label: t("media.status.inspecting") },
            { value: "processing", label: t("media.status.processing") },
            { value: "failed", label: t("media.status.failed") },
          ]}
        />
        {libraryView === "active" && (
          <>
            <FilterSelect
              label={t("media.filters.folderLabel")}
              className="w-44 max-sm:flex-1"
              value={folderFilter}
              onChange={setFolderFilter}
              options={[
                { value: "", label: t("media.filters.folderAll") },
                ...(folders.data?.map((folder) => ({
                  value: folder.id,
                  label: `${folder.name} (${folder.assetCount})`,
                })) ?? []),
              ]}
            />
            <FilterSelect
              label={t("media.filters.collectionLabel")}
              className="w-44 max-sm:flex-1"
              value={collectionFilter}
              onChange={setCollectionFilter}
              options={[
                { value: "", label: t("media.filters.collectionAll") },
                ...(collections.data?.map((collection) => ({
                  value: collection.id,
                  label: `${collection.name} (${collection.assetCount})`,
                })) ?? []),
              ]}
            />
            <FilterSelect
              label={t("media.filters.tagLabel")}
              className="w-44 max-sm:flex-1"
              value={tagFilter}
              onChange={setTagFilter}
              options={[
                { value: "", label: t("media.filters.tagAll") },
                ...(tags.data?.map((tag) => ({
                  value: tag.id,
                  label: `${tag.name} (${tag.assetCount ?? 0})`,
                })) ?? []),
              ]}
            />
          </>
        )}
        <FilterSelect
          label={t("media.sort.label")}
          className="w-44 max-sm:flex-1"
          value={sort}
          onChange={setSort}
          options={[
            { value: "updated", label: t("media.sort.recentlyUpdated") },
            { value: "newest", label: t("media.sort.newest") },
            { value: "oldest", label: t("media.sort.oldest") },
            { value: "name", label: t("media.sort.name") },
          ]}
        />
        {(search ||
          contentFilter !== "media" ||
          status ||
          folderFilter ||
          collectionFilter ||
          tagFilter) && (
          <Button
            variant="ghost"
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
            {t("media.filters.reset")}
          </Button>
        )}
        <SingleToggleGroup
          label={t("media.cardView.label")}
          variant="outline"
          spacing={0}
          value={view}
          onChange={setView}
          options={[
            {
              value: "grid",
              label: <Grid2X2 size={16} aria-hidden="true" />,
              text: t("media.cardView.grid"),
            },
            {
              value: "list",
              label: <List size={16} aria-hidden="true" />,
              text: t("media.cardView.list"),
            },
          ]}
        />
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
          onDelete={() => setConfirmBulkDelete(true)}
        />
      )}
      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("media.bulkDelete.title", { count: checkedAssetIds.size })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("media.dialogs.cannotUndo")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("media.bulkDelete.keep")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteCheckedAssets()}>
              {t("media.dialogs.deletePermanently")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {assets.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t("media.list.loadError")}</AlertTitle>
          <AlertDescription>
            {assets.error instanceof ApiError ? assets.error.message : ""}
          </AlertDescription>
        </Alert>
      )}
      {assets.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <p className="text-sm text-muted-foreground">
            {t("media.list.loading")}
          </p>
        </div>
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
          onArchive={(asset) => setConfirmArchiveAsset(asset)}
          onRestore={(asset) => {
            void api.restoreAssets([asset.id], csrf).then(refreshOrganization);
          }}
          onDelete={(asset) => setConfirmDeleteAsset(asset)}
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
      <AlertDialog
        open={confirmArchiveAsset !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmArchiveAsset(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("media.archiveDialog.title", {
                name: confirmArchiveAsset?.name,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("media.archiveDialog.body")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("media.archiveDialog.keep")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const asset = confirmArchiveAsset;
                setConfirmArchiveAsset(null);
                if (asset)
                  void api
                    .archiveAssets([asset.id], csrf)
                    .then(refreshOrganization);
              }}
            >
              {t("media.archiveDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmDeleteAsset !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteAsset(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("media.deleteDialog.title", {
                name: confirmDeleteAsset?.name,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("media.dialogs.cannotUndo")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("media.deleteDialog.keep")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const asset = confirmDeleteAsset;
                setConfirmDeleteAsset(null);
                if (asset)
                  void api
                    .deleteAsset(asset.id, csrf)
                    .then(refreshOrganization);
              }}
            >
              {t("media.dialogs.deletePermanently")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const { t } = useTranslation("content");
  return (
    <Empty
      onDragOver={(event) => event.preventDefault()}
      onDrop={archived ? undefined : onDrop}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {archived ? (
            <Archive aria-hidden="true" />
          ) : (
            <FileImage aria-hidden="true" />
          )}
        </EmptyMedia>
        <EmptyTitle>
          {archived ? t("media.empty.archiveTitle") : t("media.empty.title")}
        </EmptyTitle>
        <EmptyDescription>
          {archived
            ? t("media.empty.archiveDescription")
            : canManage
              ? t("media.empty.manageDescription")
              : t("media.empty.viewerDescription")}
        </EmptyDescription>
      </EmptyHeader>
      {canManage && !archived && (
        <EmptyContent>
          <Button variant="outline" onClick={onChoose}>
            {t("media.empty.chooseFiles")}
          </Button>
        </EmptyContent>
      )}
    </Empty>
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
}) {
  const { t } = useTranslation(["content", "common"]);
  // Every action is also reachable from a visible control, so the menus stay a
  // shortcut rather than the only route to duplication or deletion.
  const actionsFor = (asset: Asset): AssetMenuAction[] => {
    const actions: AssetMenuAction[] = archived
      ? []
      : [
          {
            label: canManage
              ? t("common:actions.edit")
              : t("media.actions.open"),
            icon: <SquarePen size={14} aria-hidden="true" />,
            onSelect: () => onSelect(asset),
          },
        ];
    if (canManage && onToggle)
      actions.push({
        label: selectedIds.has(asset.id)
          ? t("media.actions.clearSelection")
          : t("media.actions.select"),
        onSelect: () => onToggle(asset.id),
      });
    // Only Widgets have a duplicate endpoint; uploaded media has no server-side copy.
    if (canManage && onDuplicate && asset.type === "widget")
      actions.push({
        label: t("media.actions.duplicate"),
        icon: <Copy size={14} aria-hidden="true" />,
        onSelect: () => onDuplicate(asset),
      });
    if (canManage && !archived && onArchive)
      actions.push({
        label: t("media.actions.archive"),
        icon: <Archive size={14} aria-hidden="true" />,
        separated: actions.length > 0,
        onSelect: () => onArchive(asset),
      });
    if (canManage && archived && onRestore)
      actions.push({
        label: t("media.actions.restore"),
        icon: <ArchiveRestore size={14} aria-hidden="true" />,
        onSelect: () => onRestore(asset),
      });
    if (canManage && archived && onDelete)
      actions.push({
        label: t("media.dialogs.deletePermanently"),
        icon: <Trash2 size={14} aria-hidden="true" />,
        danger: true,
        separated: actions.length > 0,
        onSelect: () => onDelete(asset),
      });
    return actions;
  };
  const toggleFor =
    canManage && onToggle ? (id: string) => onToggle(id) : undefined;
  if (view === "list") {
    return (
      <ItemGroup>
        {items.map((asset) => (
          <ContextMenu key={asset.id}>
            <ContextMenuTrigger className="contents">
              <MediaAssetListRow
                asset={asset}
                archived={archived}
                selected={selectedIds.has(asset.id)}
                onSelect={() => onSelect(asset)}
                onToggle={toggleFor ? () => toggleFor(asset.id) : undefined}
                actions={actionsFor(asset)}
              />
            </ContextMenuTrigger>
            <AssetContextMenu asset={asset} actions={actionsFor(asset)} />
          </ContextMenu>
        ))}
      </ItemGroup>
    );
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {items.map((asset) => (
        <MediaAssetCard
          key={asset.id}
          asset={asset}
          archived={archived}
          canManage={canManage}
          folderNames={folderNames}
          selected={selectedIds.has(asset.id)}
          showMenu={archived || !(asset.type === "widget" && canManage)}
          onSelect={() => onSelect(asset)}
          onToggle={toggleFor ? () => toggleFor(asset.id) : undefined}
          onDuplicate={
            onDuplicate && asset.type === "widget"
              ? () => onDuplicate(asset)
              : undefined
          }
          onArchive={onArchive ? () => onArchive(asset) : undefined}
          actions={actionsFor(asset)}
        />
      ))}
    </div>
  );
}

type AssetMenuAction = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  separated?: boolean;
};

function AssetMenuContents({ actions }: { actions: AssetMenuAction[] }) {
  return (
    <>
      {actions.map((action, index) => (
        <Fragment key={`${action.label}-${index}`}>
          {action.separated && <DropdownMenuSeparator />}
          <DropdownMenuItem
            variant={action.danger ? "destructive" : "default"}
            onClick={action.onSelect}
          >
            {action.icon}
            {action.label}
          </DropdownMenuItem>
        </Fragment>
      ))}
    </>
  );
}

function AssetContextMenu({
  asset,
  actions,
}: {
  asset: Asset;
  actions: AssetMenuAction[];
}) {
  const { t } = useTranslation("content");
  if (actions.length === 0) return null;
  return (
    <ContextMenuContent
      aria-label={t("media.card.actionsFor", { name: asset.name })}
    >
      {actions.map((action, index) => (
        <Fragment key={`${action.label}-${index}`}>
          {action.separated && <ContextMenuSeparator />}
          <ContextMenuItem
            variant={action.danger ? "destructive" : "default"}
            onClick={action.onSelect}
          >
            {action.icon}
            {action.label}
          </ContextMenuItem>
        </Fragment>
      ))}
    </ContextMenuContent>
  );
}

function assetStatusBadge(
  asset: Asset,
  archived: boolean,
  t: ContentT,
): {
  label: string;
  variant: "secondary" | "destructive" | "outline";
} {
  if (archived && isExpiredAsset(asset))
    return { label: t("media.badges.expired"), variant: "outline" };
  if (archived)
    return { label: t("media.badges.archived"), variant: "outline" };
  if (asset.processingStatus === "failed")
    return { label: t("media.status.failed"), variant: "destructive" };
  return {
    label: statusLabel(asset.processingStatus, t),
    variant: "secondary",
  };
}

function AssetSummary({ asset }: { asset: Asset }) {
  return (
    <>
      {asset.type === "video" && formatDuration(asset.durationSeconds)}
      {asset.type === "widget" &&
        (asset.widget?.provider === "youtube"
          ? // i18n-ignore: YouTube is a brand name and stays in Latin script
            "YouTube"
          : asset.widget?.provider
            ? asset.widget.provider.toUpperCase()
            : asset.website?.displayUrl)}
      {asset.width && asset.height
        ? `${asset.type === "video" ? " · " : ""}${asset.width} × ${asset.height}`
        : ""}
    </>
  );
}

function AssetOrganizationChips({
  asset,
  folderNames,
}: {
  asset: Asset;
  folderNames?: Map<string, string>;
}) {
  const folderLabel = asset.folderId
    ? folderNames?.get(asset.folderId)
    : undefined;
  if (!folderLabel && !asset.tags?.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {folderLabel && (
        <Badge variant="outline">
          <Folder size={11} aria-hidden="true" />
          {folderLabel}
        </Badge>
      )}
      {asset.tags?.map((tag) => (
        <Badge key={tag.id} variant="outline">
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: tag.color }}
            aria-hidden="true"
          />
          {tag.name}
        </Badge>
      ))}
    </span>
  );
}

function MediaAssetCard({
  asset,
  archived,
  canManage,
  folderNames,
  selected,
  showMenu,
  onSelect,
  onToggle,
  onDuplicate,
  onArchive,
  actions,
}: {
  asset: Asset;
  archived: boolean;
  canManage: boolean;
  folderNames?: Map<string, string>;
  selected: boolean;
  showMenu: boolean;
  onSelect: () => void;
  onToggle?: () => void;
  onDuplicate?: () => void;
  onArchive?: () => void;
  actions: AssetMenuAction[];
}) {
  const { t } = useTranslation(["content", "common"]);
  const status = assetStatusBadge(asset, archived, t);
  const openLabel = archived
    ? t("media.card.viewLabel", { name: asset.name })
    : t("media.card.editLabel", { name: asset.name });
  // The card root is the right-click target itself, so assisted-technology and
  // test hooks keep working: `asset-card` stays a stable structural hook.
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <article
            className={`asset-card group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20 ${selected ? "border-primary ring-2 ring-ring/30" : "border-border"}`}
          />
        }
      >
        {onToggle && (
          <Checkbox
            aria-label={t("media.card.selectLabel", { name: asset.name })}
            checked={selected}
            onCheckedChange={() => onToggle()}
            className="absolute top-2 left-2 z-10 bg-background/90"
          />
        )}
        {showMenu && actions.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" />}
              aria-label={t("media.card.actionsFor", { name: asset.name })}
              className="absolute top-2 right-2 z-10 bg-background/90"
            >
              <EllipsisVertical aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <AssetMenuContents actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <button
          type="button"
          onClick={onSelect}
          aria-label={openLabel}
          className="grid gap-2 p-3 pt-10 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className="grid aspect-video w-full place-items-center overflow-hidden rounded-xl bg-muted">
            <AssetPreview asset={asset} />
          </span>
          <span className="grid min-w-0 gap-0.5">
            <span className="truncate text-sm font-medium">{asset.name}</span>
            <span className="text-xs text-muted-foreground">
              <AssetSummary asset={asset} />
            </span>
            <span className="text-xs text-muted-foreground">
              {formatBytes(asset.originalSize)}
            </span>
            <AssetOrganizationChips asset={asset} folderNames={folderNames} />
          </span>
          <Badge variant={status.variant} className="w-fit">
            {status.label}
          </Badge>
        </button>
        {asset.type === "widget" && !archived && (
          <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {t("media.card.playlists", {
                count: asset.playlistUsage ?? 0,
              })}{" "}
              ·{" "}
              {t("media.card.layouts", {
                count: asset.layoutUsage?.length ?? 0,
              })}
            </span>
            {canManage && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onSelect}
                >
                  {t("common:actions.edit")}
                </Button>
                {onDuplicate && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onDuplicate}
                    aria-label={t("media.card.duplicateLabel", {
                      name: asset.name,
                    })}
                  >
                    <Copy size={14} aria-hidden="true" />{" "}
                    {t("media.actions.duplicate")}
                  </Button>
                )}
                {onArchive && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onArchive}
                    aria-label={t("media.card.archiveLabel", {
                      name: asset.name,
                    })}
                  >
                    <Archive size={14} aria-hidden="true" />{" "}
                    {t("media.actions.archive")}
                  </Button>
                )}
              </>
            )}
          </footer>
        )}
      </ContextMenuTrigger>
      <AssetContextMenu asset={asset} actions={actions} />
    </ContextMenu>
  );
}

function MediaAssetListRow({
  asset,
  archived,
  selected,
  onSelect,
  onToggle,
  actions,
}: {
  asset: Asset;
  archived: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle?: () => void;
  actions: AssetMenuAction[];
}) {
  const { t } = useTranslation("content");
  const status = assetStatusBadge(asset, archived, t);
  return (
    <Item size="sm">
      {onToggle && (
        <Checkbox
          aria-label={t("media.card.selectLabel", { name: asset.name })}
          checked={selected}
          onCheckedChange={() => onToggle()}
        />
      )}
      <ItemContent>
        <ItemTitle>
          <button
            type="button"
            onClick={onSelect}
            aria-label={
              archived
                ? t("media.card.viewLabel", { name: asset.name })
                : t("media.card.editLabel", { name: asset.name })
            }
            className="truncate text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {asset.name}
          </button>
        </ItemTitle>
        <ItemDescription>
          <AssetSummary asset={asset} /> · {formatBytes(asset.originalSize)}
        </ItemDescription>
      </ItemContent>
      <Badge variant={status.variant}>{status.label}</Badge>
      {actions.length > 0 && (
        <ItemActions>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" />}
              aria-label={t("media.card.actionsFor", { name: asset.name })}
            >
              <EllipsisVertical aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <AssetMenuContents actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      )}
    </Item>
  );
}

type OrganizerKind = "folder" | "collection" | "tag";

const organizerKeys: Record<
  OrganizerKind,
  {
    titleKey:
      | "media.createOrganizer.folder.title"
      | "media.createOrganizer.collection.title"
      | "media.createOrganizer.tag.title";
    labelKey:
      | "media.createOrganizer.folder.label"
      | "media.createOrganizer.collection.label"
      | "media.createOrganizer.tag.label";
    hintKey:
      | "media.createOrganizer.folder.hint"
      | "media.createOrganizer.collection.hint"
      | "media.createOrganizer.tag.hint";
    errorKey:
      | "media.createOrganizer.createErrorFolder"
      | "media.createOrganizer.createErrorCollection"
      | "media.createOrganizer.createErrorTag";
  }
> = {
  folder: {
    titleKey: "media.createOrganizer.folder.title",
    labelKey: "media.createOrganizer.folder.label",
    hintKey: "media.createOrganizer.folder.hint",
    errorKey: "media.createOrganizer.createErrorFolder",
  },
  collection: {
    titleKey: "media.createOrganizer.collection.title",
    labelKey: "media.createOrganizer.collection.label",
    hintKey: "media.createOrganizer.collection.hint",
    errorKey: "media.createOrganizer.createErrorCollection",
  },
  tag: {
    titleKey: "media.createOrganizer.tag.title",
    labelKey: "media.createOrganizer.tag.label",
    hintKey: "media.createOrganizer.tag.hint",
    errorKey: "media.createOrganizer.createErrorTag",
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
  const { t } = useTranslation(["content", "common"]);
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
  const copy = organizerKeys[kind];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(copy.titleKey)}</DialogTitle>
          <DialogDescription>{t(copy.hintKey)}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor={`organizer-${kind}-name`}>
              {t(copy.labelKey)}
            </FieldLabel>
            <Input
              id={`organizer-${kind}-name`}
              autoFocus
              required
              value={name}
              maxLength={kind === "tag" ? 60 : 120}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {kind === "tag" && (
            <Field>
              <FieldLabel htmlFor="organizer-tag-color">
                {t("media.createOrganizer.colorLabel")}
              </FieldLabel>
              <Input
                id="organizer-tag-color"
                type="color"
                className="h-8 w-16 cursor-pointer p-1"
                value={color}
                onChange={(event) => setColor(event.target.value)}
              />
            </Field>
          )}
          {create.isError && (
            <Alert variant="destructive">
              <AlertTitle>{t(copy.errorKey)}</AlertTitle>
              <AlertDescription>
                {create.error instanceof ApiError ? create.error.message : ""}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button variant="outline" type="button" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner aria-hidden="true" />}
              {t(copy.titleKey)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ManageOrganizerRow({
  name,
  count,
  confirmDescription,
  onRename,
  onDelete,
}: {
  name: string;
  count: number;
  confirmDescription: string;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const { t } = useTranslation(["content", "common"]);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => void | Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      setEditing(false);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : t("media.manage.saveError"),
      );
    } finally {
      setBusy(false);
    }
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
      {editing ? (
        <form
          className="flex flex-1 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) void run(() => onRename(value));
          }}
        >
          <Input
            autoFocus
            required
            aria-label={t("media.manage.renameAria", { name })}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="min-w-32 flex-1"
          />
          <Button type="submit" size="sm" disabled={busy}>
            {t("common:actions.save")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(false);
              setValue(name);
              setError("");
            }}
          >
            {t("common:actions.cancel")}
          </Button>
        </form>
      ) : (
        <>
          <span className="text-sm font-medium">
            {name}{" "}
            <span className="font-normal text-muted-foreground">({count})</span>
          </span>
          <span className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil size={13} aria-hidden="true" /> {t("media.manage.rename")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} aria-hidden="true" />{" "}
              {t("common:actions.delete")}
            </Button>
          </span>
          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("media.manage.deleteTitle", { name })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmDescription}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("media.manage.keep")}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={() => {
                    setConfirmDelete(false);
                    void run(onDelete);
                  }}
                >
                  {t("common:actions.delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
      {error && <FieldError>{error}</FieldError>}
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
  const { t } = useTranslation("content");
  const sections: {
    titleKey:
      | "media.manage.foldersTitle"
      | "media.manage.collectionsTitle"
      | "media.manage.tagsTitle";
    emptyKey:
      | "media.manage.emptyFolders"
      | "media.manage.emptyCollections"
      | "media.manage.emptyTags";
    rows: {
      id: string;
      name: string;
      count: number;
      rename: (name: string) => Promise<unknown>;
      remove: () => Promise<unknown>;
      confirmKey:
        | "media.manage.confirmDeleteFolder"
        | "media.manage.confirmDeleteCollection"
        | "media.manage.confirmDeleteTag";
    }[];
  }[] = [
    {
      titleKey: "media.manage.foldersTitle",
      emptyKey: "media.manage.emptyFolders",
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
        confirmKey: "media.manage.confirmDeleteFolder",
      })),
    },
    {
      titleKey: "media.manage.collectionsTitle",
      emptyKey: "media.manage.emptyCollections",
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
        confirmKey: "media.manage.confirmDeleteCollection",
      })),
    },
    {
      titleKey: "media.manage.tagsTitle",
      emptyKey: "media.manage.emptyTags",
      rows: tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        count: tag.assetCount ?? 0,
        rename: (name) =>
          api.updateContentTag(tag.id, { name, color: tag.color }, csrf),
        remove: () => api.deleteContentTag(tag.id, csrf),
        confirmKey: "media.manage.confirmDeleteTag",
      })),
    },
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("media.manage.title")}</DialogTitle>
          <DialogDescription>{t("media.manage.description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-5">
          {sections.map((section) => (
            <section key={section.titleKey} className="grid gap-2">
              <h3 className="text-sm font-medium">{t(section.titleKey)}</h3>
              {section.rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t(section.emptyKey)}
                </p>
              ) : (
                <ul className="grid gap-2">
                  {section.rows.map((row) => (
                    <ManageOrganizerRow
                      key={row.id}
                      name={row.name}
                      count={row.count}
                      confirmDescription={t(row.confirmKey, {
                        name: row.name,
                      })}
                      onRename={async (name) => {
                        await row.rename(name);
                        onChanged();
                      }}
                      onDelete={async () => {
                        await row.remove();
                        onChanged();
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </DialogContent>
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
  onArchive: () => void | Promise<void>;
  onRestore: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  const { t } = useTranslation(["content", "common"]);
  const [folderId, setFolderId] = useState("");
  const [tagId, setTagId] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<OrganizerKind>();
  const [managing, setManaging] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => void | Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : t("media.organizer.updateError"),
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
          : t("media.organizer.applyError"),
      );
    }
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      aria-label={t("media.organizer.label")}
    >
      {!archiveMode && assetIds.length === 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCreating("folder")}
          >
            <FolderPlus size={15} aria-hidden="true" />{" "}
            {t("media.organizer.createFolder")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCreating("collection")}
          >
            <Library size={15} aria-hidden="true" />{" "}
            {t("media.organizer.createCollection")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setCreating("tag")}
          >
            <Tags size={15} aria-hidden="true" />{" "}
            {t("media.organizer.createTag")}
          </Button>
          {(folders.length > 0 ||
            collections.length > 0 ||
            tags.length > 0) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setManaging(true)}
            >
              <Pencil size={15} aria-hidden="true" />{" "}
              {t("media.organizer.manage")}
            </Button>
          )}
        </div>
      )}
      {assetIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-muted/40 px-3 py-2">
          <strong className="text-sm font-medium">
            {t("media.organizer.selectedCount", { count: assetIds.length })}
          </strong>
          <span className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onSelectAll}
            >
              {t("media.organizer.selectPage")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onClear}>
              {t("media.organizer.clear")}
            </Button>
          </span>
          <span className="flex flex-wrap items-center gap-1">
            {!archiveMode && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setOrganizing(true)}
              >
                <Folder size={15} aria-hidden="true" />{" "}
                {t("media.organizer.organize")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void run(archiveMode ? onRestore : onArchive)}
            >
              {archiveMode ? (
                <ArchiveRestore size={15} aria-hidden="true" />
              ) : (
                <Archive size={15} aria-hidden="true" />
              )}
              {archiveMode
                ? t("media.organizer.restore")
                : t("media.actions.archive")}
            </Button>
            {archiveMode && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void run(onDelete)}
              >
                <Trash2 size={15} aria-hidden="true" />{" "}
                {t("media.dialogs.deletePermanently")}
              </Button>
            )}
          </span>
        </div>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
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
          onOpenChange={(open) => {
            if (!open) setOrganizing(false);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t("media.organizeDialog.title", { count: assetIds.length })}
              </DialogTitle>
              <DialogDescription>
                {t("media.organizeDialog.description")}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4">
              <Field>
                <FieldLabel htmlFor="bulk-folder">
                  {t("media.organizeDialog.folderLabel")}
                </FieldLabel>
                <FilterSelect
                  id="bulk-folder"
                  label={t("media.organizeDialog.folderLabel")}
                  value={folderId}
                  onChange={setFolderId}
                  options={[
                    {
                      value: "",
                      label: t("media.organizeDialog.folderUnchanged"),
                    },
                    {
                      value: "unfiled",
                      label: t("media.organizeDialog.folderUnfiled"),
                    },
                    ...folders.map((folder) => ({
                      value: folder.id,
                      label: folder.name,
                    })),
                  ]}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="bulk-tag">
                  {t("media.organizeDialog.tagLabel")}
                </FieldLabel>
                <FilterSelect
                  id="bulk-tag"
                  label={t("media.organizeDialog.tagLabel")}
                  value={tagId}
                  onChange={setTagId}
                  options={[
                    {
                      value: "",
                      label: t("media.organizeDialog.tagUnchanged"),
                    },
                    ...tags.flatMap((tag) => [
                      {
                        value: `add:${tag.id}`,
                        label: t("media.organizeDialog.tagAdd", {
                          name: tag.name,
                        }),
                      },
                      {
                        value: `remove:${tag.id}`,
                        label: t("media.organizeDialog.tagRemove", {
                          name: tag.name,
                        }),
                      },
                    ]),
                  ]}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="bulk-collection">
                  {t("media.organizeDialog.collectionLabel")}
                </FieldLabel>
                <FilterSelect
                  id="bulk-collection"
                  label={t("media.organizeDialog.collectionLabel")}
                  value={collectionId}
                  onChange={setCollectionId}
                  options={[
                    {
                      value: "",
                      label: t("media.organizeDialog.collectionUnchanged"),
                    },
                    ...collections.flatMap((collection) => [
                      {
                        value: `add:${collection.id}`,
                        label: t("media.organizeDialog.collectionAdd", {
                          name: collection.name,
                        }),
                      },
                      {
                        value: `remove:${collection.id}`,
                        label: t("media.organizeDialog.collectionRemove", {
                          name: collection.name,
                        }),
                      },
                    ]),
                  ]}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setOrganizing(false)}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="button"
                disabled={!folderId && !tagId && !collectionId}
                onClick={() => void apply()}
              >
                {t("media.organizeDialog.apply")}
              </Button>
            </DialogFooter>
          </DialogContent>
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
  const { t } = useTranslation("content");
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
    <section className="grid gap-4" aria-label={t("media.organization.title")}>
      <h3 className="text-sm font-medium">{t("media.organization.title")}</h3>
      <Field>
        <FieldLabel htmlFor="asset-folder">
          {t("media.organization.folderLabel")}
        </FieldLabel>
        <FilterSelect
          id="asset-folder"
          label={t("media.organization.folderLabel")}
          value={asset.folderId ?? ""}
          disabled={!canManage || organize.isPending}
          onChange={(value) =>
            organize.mutate({
              setFolder: true,
              ...(value ? { folderId: value } : {}),
            })
          }
          options={[
            { value: "", label: t("media.organization.unfiled") },
            ...(folders.data?.map((folder) => ({
              value: folder.id,
              label: folder.name,
            })) ?? []),
          ]}
        />
      </Field>
      <Field>
        <span className="text-sm leading-none font-medium">
          {t("media.organization.tagsLabel")}
        </span>
        {(tags.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("media.organization.tagsEmpty")}
          </p>
        ) : (
          <ToggleGroup
            multiple
            aria-label={t("media.organization.tagsLabel")}
            value={[...assetTagIds]}
            disabled={!canManage || organize.isPending}
            onValueChange={(next) => {
              const nextSet = new Set(next);
              const added = [...nextSet].find((id) => !assetTagIds.has(id));
              const removed = [...assetTagIds].find(
                (id) =>
                  tags.data?.some((tag) => tag.id === id) && !nextSet.has(id),
              );
              if (added) organize.mutate({ addTagIds: [added] });
              else if (removed) organize.mutate({ removeTagIds: [removed] });
            }}
          >
            {tags.data?.map((tag) => (
              <ToggleGroupItem
                key={tag.id}
                value={tag.id}
                aria-label={tag.name}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: tag.color }}
                  aria-hidden="true"
                />
                {tag.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </Field>
      <Field>
        <span className="text-sm leading-none font-medium">
          {t("media.organization.collectionsLabel")}
        </span>
        {(collections.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("media.organization.collectionsEmpty")}
          </p>
        ) : (
          <ToggleGroup
            multiple
            aria-label={t("media.organization.collectionsLabel")}
            value={[...assetCollectionIds]}
            disabled={!canManage || organize.isPending}
            onValueChange={(next) => {
              const nextSet = new Set(next);
              const added = [...nextSet].find(
                (id) => !assetCollectionIds.has(id),
              );
              const removed = [...assetCollectionIds].find(
                (id) =>
                  collections.data?.some(
                    (collection) => collection.id === id,
                  ) && !nextSet.has(id),
              );
              if (added) organize.mutate({ addCollectionIds: [added] });
              else if (removed)
                organize.mutate({ removeCollectionIds: [removed] });
            }}
          >
            {collections.data?.map((collection) => (
              <ToggleGroupItem
                key={collection.id}
                value={collection.id}
                aria-label={collection.name}
              >
                {collection.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </Field>
      {organize.isError && (
        <Alert variant="destructive">
          <AlertTitle>{t("media.organization.updateError")}</AlertTitle>
          <AlertDescription>
            {organize.error instanceof ApiError ? organize.error.message : ""}
          </AlertDescription>
        </Alert>
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
  const { t } = useTranslation(["content", "common"]);
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
  const [confirmArchive, setConfirmArchive] = useState(false);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        aria-label={t("media.details.label", { name: asset.name })}
        className="overflow-y-auto"
      >
        <SheetHeader>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("media.details.eyebrow")}
          </p>
          <SheetTitle>{asset.name}</SheetTitle>
        </SheetHeader>
        <div className="grid gap-4 px-4">
          {asset.thumbnailUrl && (
            <img
              className="aspect-video w-full rounded-xl border border-border object-cover"
              src={asset.thumbnailUrl}
              alt=""
              draggable={false}
            />
          )}
          <Field>
            <FieldLabel htmlFor="asset-name">
              {t("media.details.nameLabel")}
            </FieldLabel>
            <Input
              id="asset-name"
              value={name}
              disabled={!canManage}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="asset-available-from">
                {t("media.details.availableFromLabel")}
              </FieldLabel>
              <Input
                id="asset-available-from"
                type="datetime-local"
                value={availableFrom}
                disabled={!canManage}
                onChange={(event) => setAvailableFrom(event.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                {t("media.details.availableFromHint")}
              </p>
            </Field>
            <Field>
              <FieldLabel htmlFor="asset-expires-at">
                {t("media.details.expiresAtLabel")}
              </FieldLabel>
              <Input
                id="asset-expires-at"
                type="datetime-local"
                value={expiresAt}
                disabled={!canManage}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                {t("media.details.expiresAtHint")}
              </p>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="asset-description">
              {t("media.details.descriptionLabel")}
            </FieldLabel>
            <Textarea
              id="asset-description"
              value={description}
              disabled={!canManage}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <AssetOrganization
            asset={asset}
            canManage={canManage}
            csrf={csrf}
            onChanged={onChanged}
          />
          <dl className="grid gap-2 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">
                {t("media.details.statusLabel")}
              </dt>
              <dd className="font-medium">
                {statusLabel(asset.processingStatus, t)}
              </dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">
                {t("media.details.originalFileLabel")}
              </dt>
              <dd className="font-medium">{asset.originalFilename}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">
                {t("media.details.detectedTypeLabel")}
              </dt>
              <dd className="font-medium">{asset.detectedMimeType}</dd>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">
                {t("media.details.shaLabel")}
              </dt>
              <dd className="font-mono text-xs break-all">{asset.sha256}</dd>
            </div>
          </dl>
          <UsedByPanel
            emptyMessage={t("media.details.noUsage")}
            groups={[
              {
                label: t("media.details.playlistsLabel"),
                items: asset.playlistsUsing ?? [],
                to: (playlistId) => `/playlists/${playlistId}`,
              },
              {
                label: t("media.details.layoutsLabel"),
                items: (asset.layoutUsage ?? []).map((usage) => ({
                  id: usage.id,
                  name: usage.name,
                  hint: usage.published
                    ? t("media.details.publishedHint")
                    : t("media.details.draftHint"),
                })),
                to: (layoutId) => `/layouts/${layoutId}`,
              },
            ]}
          />
          {asset.errorMessage && (
            <Alert variant="destructive">
              <AlertDescription>{asset.errorMessage}</AlertDescription>
            </Alert>
          )}
        </div>
        {canManage && (
          <SheetFooter className="flex-col items-stretch gap-2">
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
            >
              {mutation.isPending && <Spinner aria-hidden="true" />}
              {t("common:actions.saveChanges")}
            </Button>
            {asset.processingStatus === "failed" && (
              <Button
                variant="outline"
                onClick={() =>
                  void api.retryAsset(asset.id, csrf).then(onChanged)
                }
              >
                {t("media.details.retryProcessing")}
              </Button>
            )}
            <Button variant="outline" onClick={() => setConfirmArchive(true)}>
              <Archive size={15} aria-hidden="true" />{" "}
              {t("media.details.archiveAsset")}
            </Button>
          </SheetFooter>
        )}
        <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("media.archiveDialog.title", { name: asset.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("media.archiveDialog.body")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("media.archiveDialog.keep")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void api.archiveAssets([asset.id], csrf).then(() => {
                    void queryClient.invalidateQueries({
                      queryKey: ["assets"],
                    });
                    onClose();
                  })
                }
              >
                {t("media.archiveDialog.confirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
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
  const { t } = useTranslation(["content", "common"]);
  const formatLocale = useFormatLocale();
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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDeleteWebsite, setConfirmDeleteWebsite] = useState(false);
  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const title = asset
    ? t("widgets.websiteEditor.editTitle")
    : t("widgets.websiteEditor.createTitle");
  const subtitle = t("widgets.websiteEditor.subtitle");
  const form = (
    <div className="grid gap-4">
      <Field>
        <FieldLabel htmlFor="website-name">
          {t("widgets.websiteEditor.nameLabel")}
        </FieldLabel>
        <Input
          id="website-name"
          disabled={readOnly}
          value={input.name}
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="website-description">
          {t("widgets.websiteEditor.descriptionLabel")}
        </FieldLabel>
        <Textarea
          id="website-description"
          disabled={readOnly}
          value={input.description}
          onChange={(event) => set("description", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="website-url">
          {t("widgets.websiteEditor.urlLabel")}
        </FieldLabel>
        <Input
          id="website-url"
          disabled={readOnly}
          value={input.url}
          onChange={(event) => set("url", event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="website-reload">
          {t("widgets.websiteEditor.reloadLabel")}
        </FieldLabel>
        <FilterSelect
          id="website-reload"
          label={t("widgets.websiteEditor.reloadLabel")}
          disabled={readOnly}
          value={input.reloadPolicy}
          onChange={(value) =>
            set("reloadPolicy", value as WebsiteInput["reloadPolicy"])
          }
          options={[
            {
              value: "load_once",
              label: t("widgets.websiteEditor.reloadOnce"),
            },
            {
              value: "on_each_activation",
              label: t("widgets.websiteEditor.reloadEach"),
            },
            {
              value: "interval",
              label: t("widgets.websiteEditor.reloadInterval"),
            },
          ]}
        />
      </Field>
      {input.reloadPolicy === "interval" && (
        <Field>
          <FieldLabel htmlFor="website-refresh">
            {t("widgets.websiteEditor.refreshLabel")}
          </FieldLabel>
          <Input
            id="website-refresh"
            disabled={readOnly}
            type="number"
            min={30}
            value={input.refreshIntervalSeconds ?? 30}
            onChange={(event) =>
              set("refreshIntervalSeconds", Number(event.target.value))
            }
          />
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="website-failure">
          {t("widgets.websiteEditor.failureLabel")}
        </FieldLabel>
        <FilterSelect
          id="website-failure"
          label={t("widgets.websiteEditor.failureLabel")}
          disabled={readOnly}
          value={input.failureBehavior}
          onChange={(value) =>
            set("failureBehavior", value as WebsiteInput["failureBehavior"])
          }
          options={[
            {
              value: "placeholder",
              label: t("widgets.websiteEditor.failurePlaceholder"),
            },
            {
              value: "last_success",
              label: t("widgets.websiteEditor.failureLastSuccess"),
            },
            {
              value: "fallback_image",
              label: t("widgets.websiteEditor.failureFallbackImage"),
            },
            {
              value: "skip",
              label: t("widgets.websiteEditor.failureSkip"),
            },
          ]}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="website-fallback">
          {t("widgets.websiteEditor.fallbackLabel")}
        </FieldLabel>
        <FilterSelect
          id="website-fallback"
          label={t("widgets.websiteEditor.fallbackLabel")}
          disabled={readOnly}
          value={input.fallbackImageAssetId ?? ""}
          onChange={(value) => set("fallbackImageAssetId", value || undefined)}
          options={[
            { value: "", label: t("widgets.websiteEditor.fallbackNone") },
            ...(images.data?.items?.map((image) => ({
              value: image.id,
              label: image.name,
            })) ?? []),
          ]}
        />
      </Field>
      <Collapsible>
        <CollapsibleTrigger className="flex cursor-pointer items-center gap-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t("widgets.websiteEditor.advancedTitle")}
          <ChevronDown size={16} aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-4 pt-3">
          <Field>
            <FieldLabel htmlFor="website-hosts">
              {t("widgets.websiteEditor.hostsLabel")}
            </FieldLabel>
            <Input
              id="website-hosts"
              disabled={readOnly}
              value={input.allowedHosts.join(", ")}
              onChange={(event) =>
                set(
                  "allowedHosts",
                  event.target.value
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter(Boolean),
                )
              }
            />
            <p className="text-sm text-muted-foreground">
              {t("widgets.websiteEditor.hostsHint")}
            </p>
          </Field>
          <Field orientation="horizontal">
            <Switch
              id="website-js"
              aria-label={t("widgets.websiteEditor.jsLabel")}
              disabled={readOnly}
              checked={input.javascriptEnabled}
              onCheckedChange={(checked) => set("javascriptEnabled", checked)}
            />
            <FieldLabel htmlFor="website-js">
              {t("widgets.websiteEditor.jsLabel")}
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Switch
              id="website-dom"
              aria-label={t("widgets.websiteEditor.domLabel")}
              disabled={readOnly}
              checked={input.domStorageEnabled}
              onCheckedChange={(checked) => set("domStorageEnabled", checked)}
            />
            <FieldLabel htmlFor="website-dom">
              {t("widgets.websiteEditor.domLabel")}
            </FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor="website-cookies">
              {t("widgets.websiteEditor.cookiesLabel")}
            </FieldLabel>
            <FilterSelect
              id="website-cookies"
              label={t("widgets.websiteEditor.cookiesLabel")}
              disabled={readOnly}
              value={input.cookiePolicy}
              onChange={(value) =>
                set("cookiePolicy", value as WebsiteInput["cookiePolicy"])
              }
              options={[
                {
                  value: "disabled",
                  label: t("widgets.websiteEditor.cookiesDisabled"),
                },
                {
                  value: "first_party",
                  label: t("widgets.websiteEditor.cookiesFirstParty"),
                },
                {
                  value: "first_and_third_party",
                  label: t("widgets.websiteEditor.cookiesFirstAndThird"),
                },
              ]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="website-timeout">
              {t("widgets.websiteEditor.timeoutLabel")}
            </FieldLabel>
            <Input
              id="website-timeout"
              disabled={readOnly}
              type="number"
              min={1}
              max={120}
              value={input.loadTimeoutSeconds}
              onChange={(event) =>
                set("loadTimeoutSeconds", Number(event.target.value))
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="website-zoom">
              {t("widgets.websiteEditor.zoomLabel")}
            </FieldLabel>
            <Input
              id="website-zoom"
              disabled={readOnly}
              type="number"
              min={50}
              max={200}
              value={input.zoomPercent}
              onChange={(event) =>
                set("zoomPercent", Number(event.target.value))
              }
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="website-scroll-x">
                {t("widgets.websiteEditor.scrollXLabel")}
              </FieldLabel>
              <Input
                id="website-scroll-x"
                disabled={readOnly}
                type="number"
                min={0}
                value={input.scrollX}
                onChange={(event) => set("scrollX", Number(event.target.value))}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="website-scroll-y">
                {t("widgets.websiteEditor.scrollYLabel")}
              </FieldLabel>
              <Input
                id="website-scroll-y"
                disabled={readOnly}
                type="number"
                min={0}
                value={input.scrollY}
                onChange={(event) => set("scrollY", Number(event.target.value))}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="website-agent">
              {t("widgets.websiteEditor.agentLabel")}
            </FieldLabel>
            <Input
              id="website-agent"
              disabled={readOnly}
              maxLength={512}
              value={input.customUserAgent}
              onChange={(event) => set("customUserAgent", event.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              {t("widgets.websiteEditor.agentHint")}
            </p>
          </Field>
        </CollapsibleContent>
      </Collapsible>
      {diagnostics.data && (
        <section
          className="grid gap-1 text-sm"
          aria-label={t("widgets.websiteEditor.diagnosticsTitle")}
        >
          <h3 className="text-sm font-medium">
            {t("widgets.websiteEditor.diagnosticsTitle")}
          </h3>
          <p className="text-muted-foreground">
            {t("widgets.websiteEditor.allowedHosts", {
              hosts: diagnostics.data.allowedHosts.join(", "),
            })}
          </p>
          <p className="text-muted-foreground">
            {t("widgets.websiteEditor.lastLoadLabel")}{" "}
            {diagnostics.data.lastSuccessfulLoad
              ? new Date(diagnostics.data.lastSuccessfulLoad).toLocaleString(
                  formatLocale,
                )
              : t("widgets.websiteEditor.notReported")}
          </p>
          <p className="text-muted-foreground">
            {t("widgets.websiteEditor.lastFailureLabel")}{" "}
            {diagnostics.data.lastFailureCategory ??
              t("widgets.websiteEditor.notReported")}
          </p>
          <p className="text-muted-foreground">
            {t("widgets.websiteEditor.reportingLabel")}{" "}
            {diagnostics.data.reportingScreens
              .map((screen) => `${screen.name} (${screen.state})`)
              .join(", ") || t("widgets.websiteEditor.noneValue")}
          </p>
        </section>
      )}
      {save.error && (
        <Alert variant="destructive">
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!readOnly && (
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending && <Spinner aria-hidden="true" />}
            {t("widgets.websiteEditor.save")}
          </Button>
        )}
        <Button variant="outline" onClick={requestClose}>
          {t("common:actions.cancel")}
        </Button>
        {asset && !readOnly && (
          <Button
            variant="destructive"
            onClick={() => setConfirmDeleteWebsite(true)}
          >
            {t("widgets.websiteEditor.delete")}
          </Button>
        )}
      </div>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("widgets.websiteEditor.discardTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("widgets.websiteEditor.discardBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("widgets.websiteEditor.discardKeep")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>
              {t("widgets.websiteEditor.discardConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmDeleteWebsite}
        onOpenChange={setConfirmDeleteWebsite}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("widgets.websiteEditor.deleteTitle", { name: asset?.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("media.dialogs.cannotUndo")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("widgets.websiteEditor.deleteKeep")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (asset) void api.deleteAsset(asset.id, csrf).then(onClose);
              }}
            >
              {t("widgets.websiteEditor.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
  if (page) {
    return (
      <section className="w-full min-w-0 space-y-5" aria-label={title}>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">{title}</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("common:actions.close")}
            onClick={requestClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        {form}
      </section>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
