import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Globe2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { Asset, WidgetProvider } from "../../api/types";
import { ContentLibraryGrid } from "./ContentLibraryGrid";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  ContentPickerToolbar,
  type ContentPickerFilter,
} from "./ContentPickerToolbar";
import { SelectedContentTray } from "./SelectedContentTray";
import { UploadContentDialog } from "./UploadContentDialog";

export type ContentPickerResult = {
  failures: { id: string; name: string; message: string }[];
};

export type ContentPickerProps = {
  open: boolean;
  mode: "single" | "multiple";
  csrf: string;
  allowedTypes?: Array<"image" | "video" | "widget">;
  allowedProviders?: WidgetProvider[];
  disabledItemIds?: string[];
  selectedIds?: string[];
  confirmLabel?: string;
  /** Overrides the dialog heading so a scoped picker can say what it is scoped to. */
  title?: string;
  description?: string;
  onConfirm: (items: Asset[]) => Promise<void | ContentPickerResult> | void;
  onClose: () => void;
  onCloseComplete?: () => void;
  /**
   * Leaves the picker to build a new Widget. The caller owns the round trip,
   * because only it knows where the author should land afterwards; the create
   * action is hidden when no caller provides one.
   */
  onCreateWidget?: () => void;
};

export function ContentPicker({
  open,
  mode,
  csrf,
  allowedTypes = ["image", "video", "widget"],
  allowedProviders,
  disabledItemIds = [],
  selectedIds = [],
  confirmLabel = "Add content",
  title = "Choose content",
  description = "Select existing content or upload media. Apps are managed in their own library.",
  onConfirm,
  onClose,
  onCloseComplete,
  onCreateWidget,
}: ContentPickerProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ContentPickerFilter>("all");
  const [folderFilter, setFolderFilter] = useState("");
  const [collectionFilter, setCollectionFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sort, setSort] = useState("updated");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<Map<string, Asset>>(new Map());
  const [initialIds] = useState(() => new Set(selectedIds));
  const [created, setCreated] = useState<Map<string, Asset>>(new Map());
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [failures, setFailures] = useState<ContentPickerResult["failures"]>([]);
  const folders = useQuery({
    queryKey: ["content-folders"],
    queryFn: api.contentFolders,
    enabled: open,
  });
  const collections = useQuery({
    queryKey: ["content-collections"],
    queryFn: api.contentCollections,
    enabled: open,
  });
  const tags = useQuery({
    queryKey: ["content-tags"],
    queryFn: api.contentTags,
    enabled: open,
  });
  useEffect(() => {
    if (!open) setUploadOpen(false);
  }, [open]);
  // Narrow the request to what the caller accepts. Without this an "All" page of 48
  // mixed items can be filtered down to a handful client-side, so a widgets-only picker
  // looks nearly empty while the library scrolls on.
  const scopeType = [...allowedTypes].sort().join(",");
  const defaultType =
    scopeType === "widget"
      ? "widget"
      : scopeType === "image"
        ? "image"
        : scopeType === "video"
          ? "video"
          : scopeType === "image,video"
            ? "media"
            : "";
  const paramsKey = `${search}|${filter}|${folderFilter}|${collectionFilter}|${tagFilter}|${sort}|${scopeType}`;
  const library = useInfiniteQuery({
    queryKey: ["assets", "content-picker", paramsKey],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({
        page: String(pageParam),
        pageSize: "48",
        sort,
      });
      if (search) params.set("search", search);
      if (filter === "all" && defaultType) params.set("type", defaultType);
      if (["image", "video", "widget"].includes(filter))
        params.set("type", filter);
      if (filter === "website" || filter === "youtube") {
        params.set("type", "widget");
        params.set("provider", filter);
      }
      if (folderFilter) params.set("folderId", folderFilter);
      if (collectionFilter) params.set("collectionId", collectionFilter);
      if (tagFilter) params.set("tagId", tagFilter);
      return api.assets(params);
    },
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    refetchInterval: (query) =>
      query.state.data?.pages?.some((page) =>
        page.items.some((asset) =>
          ["queued", "inspecting", "processing"].includes(
            asset.processingStatus,
          ),
        ),
      )
        ? 3000
        : false,
  });
  const loaded = useMemo(
    () => library.data?.pages.flatMap((page) => page.items) ?? [],
    [library.data],
  );
  useEffect(() => {
    if (initialIds.size === 0) return;
    setSelected((current) => {
      const next = new Map(current);
      for (const asset of loaded) {
        if (initialIds.has(asset.id)) next.set(asset.id, asset);
        if (mode === "single" && next.size > 0) break;
      }
      return next;
    });
  }, [initialIds, loaded, mode]);
  const trackCreated = (asset: Asset) => {
    setCreated((current) => new Map(current).set(asset.id, asset));
    setHighlighted((current) => new Set(current).add(asset.id));
    setSelected((current) => {
      const next =
        mode === "single" ? new Map<string, Asset>() : new Map(current);
      next.set(asset.id, asset);
      return next;
    });
    void queryClient.invalidateQueries({ queryKey: ["assets"] });
    if (asset.processingStatus !== "ready") {
      void (async () => {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          const latest = await api.asset(asset.id).catch(() => undefined);
          if (!latest) return;
          setCreated((current) => new Map(current).set(latest.id, latest));
          setSelected((current) =>
            current.has(latest.id)
              ? new Map(current).set(latest.id, latest)
              : current,
          );
          if (
            latest.processingStatus === "ready" ||
            latest.processingStatus === "failed"
          )
            return;
        }
      })();
    }
  };
  const allowed = new Set(allowedTypes);
  const providers = allowedProviders ? new Set(allowedProviders) : undefined;
  const combined = [...created.values(), ...loaded].filter(
    (asset, index, values) =>
      values.findIndex((candidate) => candidate.id === asset.id) === index &&
      allowed.has(asset.type) &&
      (asset.type !== "widget" ||
        !providers ||
        (asset.widget != null && providers.has(asset.widget.provider))),
  );
  const disabled = new Set(disabledItemIds);
  const chosen = [...selected.values()];
  const selectionPreparing = chosen.some(
    (asset) => asset.processingStatus !== "ready",
  );
  const toggle = (asset: Asset) => {
    setFailures([]);
    setSelected((current) => {
      const next =
        mode === "single" ? new Map<string, Asset>() : new Map(current);
      if (current.has(asset.id)) next.delete(asset.id);
      else next.set(asset.id, asset);
      return next;
    });
  };
  const confirm = async () => {
    setConfirming(true);
    setFailures([]);
    try {
      const result = await onConfirm(chosen);
      if (result?.failures?.length) {
        setFailures(result.failures);
        const failed = new Set(result.failures.map((failure) => failure.id));
        setSelected(
          (current) => new Map([...current].filter(([id]) => failed.has(id))),
        );
      }
    } catch (error) {
      setFailures([
        {
          id: "picker",
          name: "Content selection",
          message:
            error instanceof Error
              ? error.message
              : "Content could not be added.",
        },
      ]);
    } finally {
      setConfirming(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onCloseComplete?.();
      }}
    >
      <DialogContent
        className="content-picker max-w-none gap-0 p-0"
        showCloseButton={false}
      >
        <DialogHeader className="content-picker__header">
          <div>
            <DialogTitle className="content-picker__title">{title}</DialogTitle>
            <DialogDescription className="content-picker__description">
              {description}
            </DialogDescription>
          </div>
          <div className="content-picker__primary-actions">
            {(allowed.has("image") || allowed.has("video")) && (
              <Button variant="secondary" onClick={() => setUploadOpen(true)}>
                <Upload size={16} /> Upload media
              </Button>
            )}
            {allowed.has("widget") && onCreateWidget && (
              <Button variant="secondary" onClick={onCreateWidget}>
                <Globe2 size={16} /> Create widget
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close content picker"
              onClick={onClose}
            >
              <X size={18} />
            </Button>
          </div>
        </DialogHeader>
        <ContentPickerToolbar
          search={search}
          filter={filter}
          allowedTypes={allowedTypes}
          sort={sort}
          view={view}
          folders={folders.data ?? []}
          collections={collections.data ?? []}
          tags={tags.data ?? []}
          folderFilter={folderFilter}
          collectionFilter={collectionFilter}
          tagFilter={tagFilter}
          onSearch={setSearch}
          onFilter={setFilter}
          onFolderFilter={setFolderFilter}
          onCollectionFilter={setCollectionFilter}
          onTagFilter={setTagFilter}
          onSort={setSort}
          onView={setView}
        />
        <main className="content-picker__library">
          {library.isLoading ? (
            <div className="table-loading">Loading content…</div>
          ) : library.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Content could not be loaded.</AlertTitle>
              <AlertDescription>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void library.refetch()}
                >
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          ) : combined.length === 0 ? (
            <div className="content-empty">
              <h3>No matching content</h3>
              <p>Try a different search or create new content.</p>
            </div>
          ) : (
            <>
              <ContentLibraryGrid
                items={combined}
                view={view}
                selectedIds={new Set(selected.keys())}
                disabledIds={disabled}
                highlightedIds={highlighted}
                onToggle={toggle}
              />
              {library.hasNextPage && (
                <Button
                  variant="secondary"
                  className="picker-load-more"
                  disabled={library.isFetchingNextPage}
                  onClick={() => void library.fetchNextPage()}
                >
                  {library.isFetchingNextPage
                    ? "Loading…"
                    : "Load more content"}
                </Button>
              )}
            </>
          )}
        </main>
        <SelectedContentTray
          items={chosen}
          onRemove={(id) =>
            setSelected(
              (current) => new Map([...current].filter(([key]) => key !== id)),
            )
          }
          onClear={() => setSelected(new Map())}
        />
        {failures.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Some content could not be added.</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {failures.map((failure) => (
                  <li key={failure.id}>
                    <b>{failure.name}:</b> {failure.message}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <footer className="content-picker__footer">
          <span>
            {chosen.length} item{chosen.length === 1 ? "" : "s"} selected
            {selectionPreparing ? " · waiting for processing" : ""}
          </span>
          <div>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={chosen.length === 0 || selectionPreparing || confirming}
              onClick={() => void confirm()}
            >
              {confirming
                ? "Adding…"
                : `${confirmLabel}${chosen.length > 0 ? ` (${chosen.length})` : ""}`}
            </Button>
          </div>
        </footer>
      </DialogContent>
      <UploadContentDialog
        open={open && uploadOpen}
        csrf={csrf}
        onCreated={trackCreated}
        onClose={() => setUploadOpen(false)}
      />
    </Dialog>
  );
}
