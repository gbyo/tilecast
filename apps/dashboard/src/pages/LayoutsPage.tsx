import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Copy,
  EllipsisVertical,
  LayoutGrid,
  LayoutTemplate,
  List,
  Pencil,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { LayoutOrientation, LayoutSummary } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import { LayoutPreview } from "../components/PresentationPreview";
import { Alert, AlertDescription } from "../components/ui/alert";
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
import { Button } from "../components/ui/button";
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
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";

export type LayoutsT = TFunction<"layouts", undefined>;

const presets = [
  {
    labelKey: "library.presetFullHdLandscape",
    orientation: "landscape" as const,
    width: 1920,
    height: 1080,
  },
  {
    labelKey: "library.presetFullHdPortrait",
    orientation: "portrait" as const,
    width: 1080,
    height: 1920,
  },
  {
    labelKey: "library.preset4kLandscape",
    orientation: "landscape" as const,
    width: 3840,
    height: 2160,
  },
  {
    labelKey: "library.preset4kPortrait",
    orientation: "portrait" as const,
    width: 2160,
    height: 3840,
  },
] as const;

export type LayoutLibraryOrientationFilter = "all" | LayoutOrientation;
export type LayoutLibraryPublicationFilter =
  "all" | "published" | "changes" | "draft";
export type LayoutLibrarySort = "updated" | "name" | "created" | "published";
export type LayoutPublicationState = Exclude<
  LayoutLibraryPublicationFilter,
  "all"
>;

const layoutOrientationOptions = [
  { value: "all", labelKey: "library.orientationAll" },
  { value: "landscape", labelKey: "orientation.landscape" },
  { value: "portrait", labelKey: "orientation.portrait" },
  { value: "custom", labelKey: "orientation.custom" },
] as const;

const layoutPublicationOptions = [
  { value: "all", labelKey: "library.statusAll" },
  { value: "published", labelKey: "library.statusPublished" },
  { value: "changes", labelKey: "library.publicationChanges" },
  { value: "draft", labelKey: "library.publicationDraft" },
] as const;

const layoutSortOptions = [
  { value: "updated", labelKey: "library.sortUpdated" },
  { value: "name", labelKey: "library.sortName" },
  { value: "created", labelKey: "library.sortCreated" },
  { value: "published", labelKey: "library.sortPublished" },
] as const;

const layoutViewStorageKey = "tilecast.layout-library.view";

function storedLayoutView(): "grid" | "list" {
  if (typeof window === "undefined") return "grid";
  try {
    return window.localStorage.getItem(layoutViewStorageKey) === "list"
      ? "list"
      : "grid";
  } catch {
    return "grid";
  }
}

function timestamp(value?: string): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function orientationLabel(value: LayoutOrientation, t: LayoutsT): string {
  if (value === "landscape") return t("orientation.landscape");
  if (value === "portrait") return t("orientation.portrait");
  return t("orientation.custom");
}

export function layoutPublicationState(
  layout: LayoutSummary,
): LayoutPublicationState {
  if (!layout.publishedRevision) return "draft";
  if (layout.hasUnpublishedChanges) return "changes";
  return "published";
}

export function layoutPublicationLabel(
  layout: LayoutSummary,
  t: LayoutsT,
): string {
  const state = layoutPublicationState(layout);
  if (state === "draft") return t("library.publicationDraft");
  if (state === "changes") return t("library.publicationChanges");
  return t("library.publicationPublished", {
    revision: layout.publishedRevision,
  });
}

export function filterAndSortLayouts(
  layouts: LayoutSummary[],
  search: string,
  orientation: LayoutLibraryOrientationFilter,
  publication: LayoutLibraryPublicationFilter,
  sort: LayoutLibrarySort,
  t: LayoutsT,
  locale: string,
): LayoutSummary[] {
  const collator = new Intl.Collator(locale, {
    numeric: true,
    sensitivity: "base",
  });
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filtered = layouts.filter((layout) => {
    const state = layoutPublicationState(layout);
    if (orientation !== "all" && layout.orientation !== orientation)
      return false;
    if (publication !== "all" && state !== publication) return false;
    if (!normalizedSearch) return true;
    const searchable = [
      layout.name,
      layout.description,
      layout.orientation,
      orientationLabel(layout.orientation, t),
      `${layout.canvasWidth}x${layout.canvasHeight}`,
      `${layout.canvasWidth} × ${layout.canvasHeight}`,
      layoutPublicationLabel(layout, t),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(normalizedSearch);
  });

  return [...filtered].sort((left, right) => {
    if (sort === "name") return collator.compare(left.name, right.name);
    if (sort === "created") {
      return (
        timestamp(right.createdAt) - timestamp(left.createdAt) ||
        collator.compare(left.name, right.name)
      );
    }
    if (sort === "published") {
      return (
        timestamp(right.publishedAt) - timestamp(left.publishedAt) ||
        timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
        collator.compare(left.name, right.name)
      );
    }
    return (
      timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
      collator.compare(left.name, right.name)
    );
  });
}

export function formatLayoutUpdatedAt(
  value: string,
  t: LayoutsT,
  locale: string,
  now = Date.now(),
): string {
  const valueTimestamp = Date.parse(value);
  if (!Number.isFinite(valueTimestamp)) return t("library.updatedUnavailable");
  const elapsed = Math.max(0, now - valueTimestamp);
  if (elapsed < 60_000) return t("library.updatedJustNow");
  if (elapsed < 3_600_000) {
    const minutes = Math.max(1, Math.floor(elapsed / 60_000));
    return t("library.updatedMinutesAgo", { count: minutes });
  }
  if (elapsed < 86_400_000) {
    const hours = Math.max(1, Math.floor(elapsed / 3_600_000));
    return t("library.updatedHoursAgo", { count: hours });
  }
  if (elapsed < 604_800_000) {
    const days = Math.max(1, Math.floor(elapsed / 86_400_000));
    return t("library.updatedDaysAgo", { count: days });
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (new Date(valueTimestamp).getFullYear() !== new Date(now).getFullYear()) {
    options.year = "numeric";
  }
  return t("library.updatedOnDate", {
    date: new Intl.DateTimeFormat(locale, options).format(valueTimestamp),
  });
}

export function LayoutsPage() {
  const { t } = useTranslation(["layouts", "common"]);
  const formatLocale = useFormatLocale();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const canManage = auth.status?.user?.role !== "viewer";
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [orientation, setOrientation] =
    useState<LayoutLibraryOrientationFilter>("all");
  const [publication, setPublication] =
    useState<LayoutLibraryPublicationFilter>("all");
  const [sort, setSort] = useState<LayoutLibrarySort>("updated");
  const [view, setView] = useState<"grid" | "list">(storedLayoutView);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [preset, setPreset] = useState(0);
  const [template, setTemplate] = useState<"blank" | "announcement">("blank");
  const [actionError, setActionError] = useState("");
  const [renaming, setRenaming] = useState<LayoutSummary>();
  const [renameName, setRenameName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<LayoutSummary | null>(
    null,
  );

  const layouts = useQuery({
    queryKey: ["layouts", "library"],
    queryFn: () => api.layouts(""),
  });
  const create = useMutation({
    mutationFn: async () => {
      const selectedPreset = presets[preset]!;
      const created = await api.createLayout(
        {
          name: name.trim(),
          description: description.trim(),
          orientation: selectedPreset.orientation,
          canvasWidth: selectedPreset.width,
          canvasHeight: selectedPreset.height,
        },
        csrf,
      );
      if (template === "blank") return created;
      const document = structuredClone(created.draft);
      document.placements.push(
        {
          id: crypto.randomUUID(),
          type: "primitive",
          name: "Accent",
          x: 0,
          y: 0,
          width: Math.max(24, document.canvas.width * 0.025),
          height: document.canvas.height,
          layer: 1,
          opacity: 1,
          visible: true,
          locked: false,
          primitive: { kind: "rectangle", fillColor: "#2D7FF9" },
        },
        {
          id: crypto.randomUUID(),
          type: "primitive",
          name: "Headline",
          x: document.canvas.width * 0.1,
          y: document.canvas.height * 0.24,
          width: document.canvas.width * 0.8,
          height: document.canvas.height * 0.5,
          layer: 2,
          opacity: 1,
          visible: true,
          locked: false,
          primitive: {
            kind: "text",
            // i18n-ignore: default headline text is layout content shown on screens, not UI
            text: "Announcement",
            fontFamily: "Inter",
            fontSize: 112,
            fontWeight: 700,
            textAlign: "left",
            verticalAlign: "center",
            color: "#F5F7FA",
            backgroundColor: "#00000000",
            lineHeight: 1.1,
            maximumLines: 3,
            overflow: "ellipsis",
          },
        },
      );
      return api.saveLayoutDraft(
        created.id,
        created.draftRevision,
        document,
        csrf,
      );
    },
    onSuccess: (layout) => {
      void queryClient.invalidateQueries({ queryKey: ["layouts"] });
      void navigate(`/layouts/${layout.id}`);
    },
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateLayout(id, csrf),
    onMutate: () => setActionError(""),
    onSuccess: (layout) => {
      void queryClient.invalidateQueries({ queryKey: ["layouts"] });
      void navigate(`/layouts/${layout.id}`);
    },
    onError: (error) =>
      setActionError(
        error instanceof Error
          ? apiErrorMessage(error)
          : t("library.duplicateFailed"),
      ),
  });
  const rename = useMutation({
    mutationFn: ({
      layout,
      nextName,
    }: {
      layout: LayoutSummary;
      nextName: string;
    }) =>
      api.updateLayout(
        layout.id,
        { name: nextName, description: layout.description },
        csrf,
      ),
    onMutate: () => setActionError(""),
    onSuccess: () => {
      setRenaming(undefined);
      setRenameName("");
      void queryClient.invalidateQueries({ queryKey: ["layouts"] });
    },
    onError: (error) =>
      setActionError(
        error instanceof Error
          ? apiErrorMessage(error)
          : t("library.renameFailed"),
      ),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteLayout(id, csrf),
    onMutate: () => setActionError(""),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["layouts"] }),
    onError: (error) =>
      setActionError(
        error instanceof Error
          ? apiErrorMessage(error)
          : t("library.deleteFailed"),
      ),
  });

  useEffect(() => {
    if (canManage && searchParams.get("create") === "1") setCreating(true);
  }, [canManage, searchParams]);

  useEffect(() => {
    try {
      window.localStorage.setItem(layoutViewStorageKey, view);
    } catch {
      // The view preference is optional; the library remains usable without storage.
    }
  }, [view]);

  const allLayouts = useMemo(
    () => layouts.data?.items ?? [],
    [layouts.data?.items],
  );
  const visibleLayouts = useMemo(
    () =>
      filterAndSortLayouts(
        allLayouts,
        search,
        orientation,
        publication,
        sort,
        t,
        formatLocale,
      ),
    [allLayouts, formatLocale, orientation, publication, search, sort, t],
  );
  const orientationOptions = layoutOrientationOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const publicationOptions = layoutPublicationOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const sortOptions = layoutSortOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));

  const closeCreate = () => {
    setCreating(false);
    setName("");
    setDescription("");
    setPreset(0);
    setTemplate("blank");
    create.reset();
    if (searchParams.has("create")) {
      const next = new URLSearchParams(searchParams);
      next.delete("create");
      setSearchParams(next, { replace: true });
    }
  };
  const openRename = (layout: LayoutSummary) => {
    setActionError("");
    setRenaming(layout);
    setRenameName(layout.name);
  };
  const closeRename = () => {
    setRenaming(undefined);
    setRenameName("");
    rename.reset();
  };
  const clearLibraryFilters = () => {
    setSearch("");
    setOrientation("all");
    setPublication("all");
  };
  type LayoutMenuAction = {
    label: string;
    icon: ReactNode;
    danger?: boolean;
    separated?: boolean;
    disabled?: boolean;
    onSelect: () => void;
  };
  const actionsFor = (layout: LayoutSummary): LayoutMenuAction[] => {
    const actions: LayoutMenuAction[] = [
      {
        label: canManage ? t("common:actions.edit") : t("library.menuOpen"),
        icon: <SquarePen size={14} />,
        onSelect: () => void navigate(`/layouts/${layout.id}`),
      },
    ];
    if (canManage) {
      actions.push(
        {
          label: t("library.menuRename"),
          icon: <Pencil size={14} />,
          disabled: rename.isPending,
          onSelect: () => openRename(layout),
        },
        {
          label: t("library.menuDuplicate"),
          icon: <Copy size={14} />,
          disabled: duplicate.isPending,
          onSelect: () => duplicate.mutate(layout.id),
        },
        {
          label: t("common:actions.delete"),
          icon: <Trash2 size={14} />,
          danger: true,
          separated: true,
          disabled: remove.isPending,
          onSelect: () => setPendingDelete(layout),
        },
      );
    }
    return actions;
  };

  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("library.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("library.description")}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />
              {t("library.createLayout")}
            </Button>
          </div>
        )}
      </header>
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label={t("library.searchLabel")}
          placeholder={t("library.searchPlaceholder")}
        />
        <Select
          items={orientationOptions}
          value={orientation}
          onValueChange={(next) =>
            setOrientation(next as LayoutLibraryOrientationFilter)
          }
        >
          <SelectTrigger
            aria-label={t("library.filterOrientation")}
            className="w-40 max-sm:flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {orientationOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={publicationOptions}
          value={publication}
          onValueChange={(next) =>
            setPublication(next as LayoutLibraryPublicationFilter)
          }
        >
          <SelectTrigger
            aria-label={t("library.filterStatus")}
            className="w-48 max-sm:flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {publicationOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={sortOptions}
          value={sort}
          onValueChange={(next) => setSort(next as LayoutLibrarySort)}
        >
          <SelectTrigger
            aria-label={t("library.sortLabel")}
            className="w-48 max-sm:flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ToggleGroup
          aria-label={t("library.viewLabel")}
          variant="outline"
          spacing={0}
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "grid" || next === "list") setView(next);
          }}
        >
          <ToggleGroupItem value="grid" aria-label={t("library.viewGrid")}>
            <LayoutGrid size={16} aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label={t("library.viewList")}>
            <List size={16} aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </DashboardListToolbar>

      {!layouts.isLoading && allLayouts.length > 0 && (
        <div className="text-sm text-muted-foreground" aria-live="polite">
          {t("library.showingCount", {
            count: allLayouts.length,
            shown: visibleLayouts.length,
            total: allLayouts.length,
          })}
        </div>
      )}

      {layouts.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {layouts.error instanceof Error
              ? apiErrorMessage(layouts.error)
              : t("library.loadFailed")}
          </AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {layouts.isLoading ? (
        <div className="grid gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : allLayouts.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutTemplate size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("library.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {canManage
                ? t("library.emptyCreateHint")
                : t("library.emptyReadOnlyHint")}
            </EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <Button type="button" onClick={() => setCreating(true)}>
                {t("library.createLayout")}
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : visibleLayouts.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutTemplate size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("library.noResultsTitle")}</EmptyTitle>
            <EmptyDescription>{t("library.noResultsHint")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              onClick={clearLibraryFilters}
            >
              {t("library.clearFilters")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div
          className={
            view === "grid"
              ? "grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
              : "grid gap-2"
          }
        >
          {visibleLayouts.map((layout) => {
            const publicationState = layoutPublicationState(layout);
            const menuLabel = t("library.cardActions", { name: layout.name });
            return (
              <ContextMenu key={layout.id}>
                <ContextMenuTrigger
                  render={
                    <article
                      className="relative min-w-0"
                      data-orientation={layout.orientation}
                      data-publication={publicationState}
                    />
                  }
                >
                  <button
                    type="button"
                    className="grid w-full gap-3 rounded-xl border border-border p-3 text-left hover:bg-muted"
                    aria-label={
                      canManage
                        ? t("library.cardEdit", { name: layout.name })
                        : t("library.cardOpen", { name: layout.name })
                    }
                    onClick={() => void navigate(`/layouts/${layout.id}`)}
                  >
                    <span className="relative block">
                      <LayoutPreview layout={layout} />
                      <span className="absolute top-2 left-2 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium">
                        {layoutPublicationLabel(layout, t)}
                      </span>
                      <span className="absolute right-2 bottom-2 rounded-full bg-background/90 px-2 py-0.5 text-xs tabular-nums">
                        {layout.canvasWidth} × {layout.canvasHeight}
                      </span>
                    </span>
                    <span className="grid gap-1">
                      <span className="flex items-center justify-between gap-2">
                        <strong
                          title={layout.name}
                          className="truncate text-sm"
                        >
                          {layout.name}
                        </strong>
                        <ChevronRight
                          size={17}
                          aria-hidden="true"
                          className="shrink-0 text-muted-foreground"
                        />
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {layout.description || t("library.cardNoDescription")}
                      </span>
                      <span className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{orientationLabel(layout.orientation, t)}</span>
                        <span>
                          {t("library.cardDraftRevision", {
                            revision: layout.draftRevision,
                          })}
                        </span>
                        {layout.publishedRevision && (
                          <span>
                            {t("library.publicationPublished", {
                              revision: layout.publishedRevision,
                            })}
                          </span>
                        )}
                      </span>
                      <small className="text-xs text-muted-foreground">
                        {formatLayoutUpdatedAt(
                          layout.updatedAt,
                          t,
                          formatLocale,
                        )}
                      </small>
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      className="absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-xl bg-background/90 hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
                      aria-label={menuLabel}
                    >
                      <EllipsisVertical size={16} aria-hidden="true" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" aria-label={menuLabel}>
                      {actionsFor(layout).map((action, index) => (
                        <Fragment key={`${action.label}-${index}`}>
                          {action.separated && <DropdownMenuSeparator />}
                          <DropdownMenuItem
                            variant={action.danger ? "destructive" : "default"}
                            disabled={action.disabled}
                            onClick={action.onSelect}
                          >
                            {action.icon}
                            {action.label}
                          </DropdownMenuItem>
                        </Fragment>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ContextMenuTrigger>
                <ContextMenuContent aria-label={menuLabel}>
                  {actionsFor(layout).map((action, index) => (
                    <Fragment key={`${action.label}-${index}`}>
                      {action.separated && <ContextMenuSeparator />}
                      <ContextMenuItem
                        variant={action.danger ? "destructive" : "default"}
                        disabled={action.disabled}
                        onClick={action.onSelect}
                      >
                        {action.icon}
                        {action.label}
                      </ContextMenuItem>
                    </Fragment>
                  ))}
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      )}

      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("library.createLayout")}</DialogTitle>
            <DialogDescription>
              {t("library.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="layout-create-name">
                {t("library.formName")}
              </FieldLabel>
              <Input
                id="layout-create-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="layout-create-description">
                {t("library.formDescription")}
              </FieldLabel>
              <Textarea
                id="layout-create-description"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <FieldDescription>
                {t("library.formDescriptionHint")}
              </FieldDescription>
            </Field>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">
                {t("canvas.sizeTitle")}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {presets.map((item, index) => (
                  <Button
                    type="button"
                    variant={preset === index ? "default" : "outline"}
                    className="h-auto items-center gap-3 p-3 text-left"
                    aria-pressed={preset === index}
                    key={item.labelKey}
                    onClick={() => setPreset(index)}
                  >
                    <span
                      aria-hidden="true"
                      className={
                        item.orientation === "landscape"
                          ? "h-6 w-10 shrink-0 rounded-sm border-2 border-current"
                          : "h-10 w-6 shrink-0 rounded-sm border-2 border-current"
                      }
                    />
                    <span className="grid gap-0.5">
                      <strong className="text-sm">{t(item.labelKey)}</strong>
                      <small className="text-xs font-normal opacity-80">
                        {item.width} × {item.height}
                      </small>
                    </span>
                  </Button>
                ))}
              </div>
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">
                {t("library.templateLegend")}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  type="button"
                  variant={template === "blank" ? "default" : "outline"}
                  className="h-auto items-center gap-3 p-3 text-left"
                  aria-pressed={template === "blank"}
                  onClick={() => setTemplate("blank")}
                >
                  <LayoutTemplate size={20} aria-hidden="true" />
                  <span className="grid gap-0.5">
                    <strong className="text-sm">
                      {t("library.templateBlank")}
                    </strong>
                    <small className="text-xs font-normal opacity-80">
                      {t("library.templateBlankHint")}
                    </small>
                  </span>
                </Button>
                <Button
                  type="button"
                  variant={template === "announcement" ? "default" : "outline"}
                  className="h-auto items-center gap-3 p-3 text-left"
                  aria-pressed={template === "announcement"}
                  onClick={() => setTemplate("announcement")}
                >
                  <SquarePen size={20} aria-hidden="true" />
                  <span className="grid gap-0.5">
                    <strong className="text-sm">
                      {t("library.templateAnnouncement")}
                    </strong>
                    <small className="text-xs font-normal opacity-80">
                      {t("library.templateAnnouncementHint")}
                    </small>
                  </span>
                </Button>
              </div>
            </fieldset>
            {create.error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {create.error instanceof Error
                    ? apiErrorMessage(create.error)
                    : t("library.createFailed")}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeCreate}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending
                ? t("library.creating")
                : t("library.createLayout")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renaming)}
        onOpenChange={(open) => {
          if (!open) closeRename();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("library.renameTitle")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="layout-rename-name">
                {t("library.formName")}
              </FieldLabel>
              <Input
                id="layout-rename-name"
                autoFocus
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !rename.isPending &&
                    renaming &&
                    renameName.trim() &&
                    renameName.trim() !== renaming.name
                  ) {
                    rename.mutate({
                      layout: renaming,
                      nextName: renameName.trim(),
                    });
                  }
                }}
              />
            </Field>
            {rename.error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {rename.error instanceof Error
                    ? apiErrorMessage(rename.error)
                    : t("library.renameFailed")}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeRename}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              type="button"
              disabled={
                !renaming ||
                !renameName.trim() ||
                renameName.trim() === renaming.name ||
                rename.isPending
              }
              onClick={() => {
                if (!renaming) return;
                rename.mutate({
                  layout: renaming,
                  nextName: renameName.trim(),
                });
              }}
            >
              {rename.isPending
                ? t("common:actions.saving")
                : t("library.renameSave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("library.deleteTitle", {
                name: pendingDelete?.name ?? t("library.deleteFallbackName"),
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("library.deleteDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => {
                if (pendingDelete) {
                  remove.mutate(pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
            >
              {t("library.deleteSubmit")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export const layoutPresets: {
  labelKey: string;
  orientation: LayoutOrientation;
  width: number;
  height: number;
}[] = [...presets];
