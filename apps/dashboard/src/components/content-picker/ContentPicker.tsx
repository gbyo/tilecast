import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { AlertCircle, LibraryBig, Plus, SearchX, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { Asset, WidgetProvider } from "../../api/types";
import { apiErrorMessage } from "../../i18n";
import {
  ContentLibraryGrid,
  ContentLibraryList,
  ContentLibraryLoading,
} from "./ContentLibraryGrid";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  ContentPickerToolbar,
  type ContentPickerFilter,
} from "./ContentPickerToolbar";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { useUploadCloseGuard } from "./MediaUploadDialog";
import { MediaUploadPanel } from "./MediaUploadPanel";
import { SelectedContentTray } from "./SelectedContentTray";

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
  confirmLabel,
  title,
  description,
  onConfirm,
  onClose,
  onCloseComplete,
  onCreateWidget,
}: ContentPickerProps) {
  const { t } = useTranslation(["content", "common"]);
  const queryClient = useQueryClient();
  const resolvedConfirmLabel = confirmLabel ?? t("picker.dialog.addContent");
  const resolvedTitle = title ?? t("picker.dialog.chooseContent");
  const resolvedDescription =
    description ?? t("picker.dialog.chooseDescription");
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
  const [tab, setTab] = useState<"library" | "upload">("library");
  const seen = useRef(new Set<string>());
  const uploads = useUploadCloseGuard();
  const [uploadsActive, setUploadsActive] = useState(false);
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
  // Every opening starts on the library.
  useEffect(() => {
    if (open) setTab("library");
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
  // The upload panel follows each new asset until processing settles and
  // reports every change here. A new upload joins the selection at once; later
  // reports refresh it in place so it becomes confirmable when ready.
  const trackUpload = (asset: Asset) => {
    const first = !seen.current.has(asset.id);
    seen.current.add(asset.id);
    setCreated((current) => new Map(current).set(asset.id, asset));
    if (first) {
      setHighlighted((current) => new Set(current).add(asset.id));
      setSelected((current) => {
        const next =
          mode === "single" ? new Map<string, Asset>() : new Map(current);
        next.set(asset.id, asset);
        return next;
      });
    } else {
      setSelected((current) => {
        if (!current.has(asset.id)) return current;
        const next = new Map(current);
        // A failed upload can never be confirmed, so it leaves the selection
        // instead of holding the confirm action disabled.
        if (asset.processingStatus === "failed") next.delete(asset.id);
        else next.set(asset.id, asset);
        return next;
      });
    }
    if (first || asset.processingStatus === "ready") {
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
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
  const selectionPreparing =
    uploadsActive || chosen.some((asset) => asset.processingStatus !== "ready");
  const canUpload = allowed.has("image") || allowed.has("video");
  const filtered =
    search !== "" ||
    filter !== "all" ||
    folderFilter !== "" ||
    collectionFilter !== "" ||
    tagFilter !== "";
  const clearFilters = () => {
    setSearch("");
    setFilter("all");
    setFolderFilter("");
    setCollectionFilter("");
    setTagFilter("");
  };
  const close = () => uploads.guard(onClose);
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
          name: t("picker.errors.selectionName"),
          message:
            error instanceof Error
              ? apiErrorMessage(error)
              : t("picker.errors.addError"),
        },
      ]);
    } finally {
      setConfirming(false);
    }
  };
  const libraryProps = {
    items: combined,
    selectedIds: new Set(selected.keys()),
    disabledIds: disabled,
    highlightedIds: highlighted,
    onToggle: toggle,
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) onCloseComplete?.();
      }}
    >
      {uploads.dialog}
      <DialogContent className="flex h-[min(54rem,calc(100dvh-2rem))] w-[min(74rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="gap-1 px-6 pt-5 pb-3 pr-14">
          <DialogTitle className="text-base">{resolvedTitle}</DialogTitle>
          <DialogDescription>{resolvedDescription}</DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "library" | "upload")}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="flex items-center justify-between gap-3 border-b px-6">
            <TabsList variant="line">
              <TabsTrigger value="library">
                <LibraryBig aria-hidden="true" />
                {t("picker.tabs.library")}
              </TabsTrigger>
              {canUpload && (
                <TabsTrigger value="upload">
                  <Upload aria-hidden="true" />
                  {t("picker.tabs.upload")}
                </TabsTrigger>
              )}
            </TabsList>
            {allowed.has("widget") && onCreateWidget && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onCreateWidget}
              >
                <Plus aria-hidden="true" />
                {t("picker.dialog.createWidget")}
              </Button>
            )}
          </div>
          <TabsContent
            value="library"
            className="flex min-h-0 flex-1 flex-col data-hidden:hidden"
          >
            <div className="border-b px-6 py-3">
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
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {library.isLoading ? (
                <ContentLibraryLoading view={view} />
              ) : library.isError ? (
                <Alert variant="destructive">
                  <AlertCircle aria-hidden="true" />
                  <AlertTitle>{t("picker.library.loadError")}</AlertTitle>
                  <AlertDescription>
                    {t("picker.library.loadErrorHint")}
                  </AlertDescription>
                  <AlertAction>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void library.refetch()}
                    >
                      {t("picker.errors.tryAgain")}
                    </Button>
                  </AlertAction>
                </Alert>
              ) : combined.length === 0 ? (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <SearchX aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyTitle>
                      {filtered
                        ? t("picker.library.noMatch")
                        : t("picker.library.emptyTitle")}
                    </EmptyTitle>
                    <EmptyDescription>
                      {filtered
                        ? t("picker.library.noMatchClearHint")
                        : canUpload
                          ? t("picker.library.emptyUploadHint")
                          : t("picker.library.emptyWidgetHint")}
                    </EmptyDescription>
                  </EmptyHeader>
                  {(filtered || canUpload) && (
                    <EmptyContent className="flex-row justify-center">
                      {filtered && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={clearFilters}
                        >
                          {t("picker.library.clearFilters")}
                        </Button>
                      )}
                      {canUpload && (
                        <Button type="button" onClick={() => setTab("upload")}>
                          <Upload aria-hidden="true" />
                          {t("picker.upload.uploadMedia")}
                        </Button>
                      )}
                    </EmptyContent>
                  )}
                </Empty>
              ) : (
                <div className="grid gap-6">
                  {view === "grid" ? (
                    <ContentLibraryGrid {...libraryProps} />
                  ) : (
                    <ContentLibraryList {...libraryProps} />
                  )}
                  {library.hasNextPage && (
                    <Button
                      type="button"
                      variant="outline"
                      className="justify-self-center"
                      disabled={library.isFetchingNextPage}
                      onClick={() => void library.fetchNextPage()}
                    >
                      {library.isFetchingNextPage && (
                        <Spinner aria-hidden="true" />
                      )}
                      {t("picker.library.loadMore")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </TabsContent>
          {canUpload && (
            // Kept mounted so switching back to the library never drops an
            // upload that is still transferring or processing.
            <TabsContent
              value="upload"
              keepMounted
              className="min-h-0 flex-1 overflow-y-auto px-6 py-4 data-hidden:hidden"
            >
              <MediaUploadPanel
                csrf={csrf}
                onAsset={trackUpload}
                onActiveChange={(active) => {
                  setUploadsActive(active);
                  uploads.setActive(active);
                }}
              />
              {created.size > 0 && (
                <p className="mt-4 text-sm text-muted-foreground">
                  <Trans
                    i18nKey="picker.upload.newUploadsHint"
                    ns="content"
                    components={{
                      libraryLink: (
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto p-0"
                          onClick={() => setTab("library")}
                        />
                      ),
                    }}
                  />
                </p>
              )}
            </TabsContent>
          )}
        </Tabs>
        {failures.length > 0 && (
          <div className="px-6 pb-3">
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>{t("picker.errors.addFailed")}</AlertTitle>
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
          </div>
        )}
        <DialogFooter className="gap-3 border-t px-6 py-3 sm:items-center sm:justify-between">
          <SelectedContentTray
            items={chosen}
            preparing={selectionPreparing}
            onRemove={(id) =>
              setSelected(
                (current) =>
                  new Map([...current].filter(([key]) => key !== id)),
              )
            }
            onClear={() => setSelected(new Map())}
          />
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="button"
              disabled={chosen.length === 0 || selectionPreparing || confirming}
              onClick={() => void confirm()}
            >
              {confirming && <Spinner aria-hidden="true" />}
              {chosen.length > 0
                ? t("picker.footer.confirmWithCount", {
                    label: resolvedConfirmLabel,
                    count: chosen.length,
                  })
                : resolvedConfirmLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
