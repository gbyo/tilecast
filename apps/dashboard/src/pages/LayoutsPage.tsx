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
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../api/client";
import type { LayoutOrientation, LayoutSummary } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  DashboardListToolbar,
  DashboardSearch,
} from "../components/DashboardListToolbar";
import { LayoutPreview } from "../components/PresentationPreview";
import { WorkspaceTabs, presentationTabs } from "../navigation/WorkspaceTabs";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog as RheaAlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button as RheaButton } from "../components/ui/button";
import {
  ContextMenu as RheaContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import {
  Dialog as RheaDialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu as RheaDropdownMenu,
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
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import {
  ToggleGroup as RheaToggleGroup,
  ToggleGroupItem as RheaToggleGroupItem,
} from "../components/ui/toggle-group";
import { optionLabel } from "../content/data-sources/shared";
import "./LayoutLibraryPage.css";

const presets = [
  {
    label: "Full HD landscape",
    orientation: "landscape" as const,
    width: 1920,
    height: 1080,
  },
  {
    label: "Full HD portrait",
    orientation: "portrait" as const,
    width: 1080,
    height: 1920,
  },
  {
    label: "4K landscape",
    orientation: "landscape" as const,
    width: 3840,
    height: 2160,
  },
  {
    label: "4K portrait",
    orientation: "portrait" as const,
    width: 2160,
    height: 3840,
  },
];

export type LayoutLibraryOrientationFilter = "all" | LayoutOrientation;
export type LayoutLibraryPublicationFilter =
  "all" | "published" | "changes" | "draft";
export type LayoutLibrarySort = "updated" | "name" | "created" | "published";
export type LayoutPublicationState = Exclude<
  LayoutLibraryPublicationFilter,
  "all"
>;

const layoutOrientationOptions = [
  { value: "all", label: "All orientations" },
  { value: "landscape", label: "Landscape" },
  { value: "portrait", label: "Portrait" },
  { value: "custom", label: "Custom" },
];

const layoutPublicationOptions = [
  { value: "all", label: "All statuses" },
  { value: "published", label: "Published" },
  { value: "changes", label: "Unpublished changes" },
  { value: "draft", label: "Draft only" },
];

const layoutSortOptions = [
  { value: "updated", label: "Recently updated" },
  { value: "name", label: "Name" },
  { value: "created", label: "Recently created" },
  { value: "published", label: "Recently published" },
];

const layoutViewStorageKey = "tilecast.layout-library.view";
const layoutNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

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

function orientationLabel(value: LayoutOrientation): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function layoutPublicationState(
  layout: LayoutSummary,
): LayoutPublicationState {
  if (!layout.publishedRevision) return "draft";
  if (layout.hasUnpublishedChanges) return "changes";
  return "published";
}

export function layoutPublicationLabel(layout: LayoutSummary): string {
  const state = layoutPublicationState(layout);
  if (state === "draft") return "Draft only";
  if (state === "changes") return "Unpublished changes";
  return `Published r${layout.publishedRevision}`;
}

export function filterAndSortLayouts(
  layouts: LayoutSummary[],
  search: string,
  orientation: LayoutLibraryOrientationFilter,
  publication: LayoutLibraryPublicationFilter,
  sort: LayoutLibrarySort,
): LayoutSummary[] {
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
      orientationLabel(layout.orientation),
      `${layout.canvasWidth}x${layout.canvasHeight}`,
      `${layout.canvasWidth} × ${layout.canvasHeight}`,
      layoutPublicationLabel(layout),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return searchable.includes(normalizedSearch);
  });

  return [...filtered].sort((left, right) => {
    if (sort === "name")
      return layoutNameCollator.compare(left.name, right.name);
    if (sort === "created") {
      return (
        timestamp(right.createdAt) - timestamp(left.createdAt) ||
        layoutNameCollator.compare(left.name, right.name)
      );
    }
    if (sort === "published") {
      return (
        timestamp(right.publishedAt) - timestamp(left.publishedAt) ||
        timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
        layoutNameCollator.compare(left.name, right.name)
      );
    }
    return (
      timestamp(right.updatedAt) - timestamp(left.updatedAt) ||
      layoutNameCollator.compare(left.name, right.name)
    );
  });
}

export function formatLayoutUpdatedAt(value: string, now = Date.now()): string {
  const valueTimestamp = Date.parse(value);
  if (!Number.isFinite(valueTimestamp)) return "Update time unavailable";
  const elapsed = Math.max(0, now - valueTimestamp);
  if (elapsed < 60_000) return "Updated just now";
  if (elapsed < 3_600_000) {
    const minutes = Math.max(1, Math.floor(elapsed / 60_000));
    return `Updated ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (elapsed < 86_400_000) {
    const hours = Math.max(1, Math.floor(elapsed / 3_600_000));
    return `Updated ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (elapsed < 604_800_000) {
    const days = Math.max(1, Math.floor(elapsed / 86_400_000));
    return `Updated ${days} day${days === 1 ? "" : "s"} ago`;
  }
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (new Date(valueTimestamp).getFullYear() !== new Date(now).getFullYear()) {
    options.year = "numeric";
  }
  return `Updated ${new Intl.DateTimeFormat(undefined, options).format(valueTimestamp)}`;
}

export function LayoutsPage() {
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
          ? error.message
          : "The layout could not be duplicated.",
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
          ? error.message
          : "The layout could not be renamed.",
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
          ? error.message
          : "The layout could not be deleted because it is still in use.",
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
      filterAndSortLayouts(allLayouts, search, orientation, publication, sort),
    [allLayouts, orientation, publication, search, sort],
  );

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
        label: canManage ? "Edit" : "Open",
        icon: <SquarePen size={14} />,
        onSelect: () => void navigate(`/layouts/${layout.id}`),
      },
    ];
    if (canManage) {
      actions.push(
        {
          label: "Rename",
          icon: <Pencil size={14} />,
          disabled: rename.isPending,
          onSelect: () => openRename(layout),
        },
        {
          label: "Duplicate",
          icon: <Copy size={14} />,
          disabled: duplicate.isPending,
          onSelect: () => duplicate.mutate(layout.id),
        },
        {
          label: "Delete",
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
      <WorkspaceTabs label="Presentations" tabs={presentationTabs} />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Layouts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Design reusable screen compositions and find the right canvas at a
            glance.
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <RheaButton type="button" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />
              Create layout
            </RheaButton>
          </div>
        )}
      </header>
      <DashboardListToolbar>
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search layouts"
          placeholder="Search names, descriptions, or dimensions"
        />
        <RheaSelect
          value={orientation}
          onValueChange={(next) =>
            setOrientation(next as LayoutLibraryOrientationFilter)
          }
        >
          <SelectTrigger aria-label="Filter layouts by orientation">
            <SelectValue>
              {optionLabel(layoutOrientationOptions, orientation)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {layoutOrientationOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </RheaSelect>
        <RheaSelect
          value={publication}
          onValueChange={(next) =>
            setPublication(next as LayoutLibraryPublicationFilter)
          }
        >
          <SelectTrigger aria-label="Filter layouts by publication status">
            <SelectValue>
              {optionLabel(layoutPublicationOptions, publication)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {layoutPublicationOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </RheaSelect>
        <RheaSelect
          value={sort}
          onValueChange={(next) => setSort(next as LayoutLibrarySort)}
        >
          <SelectTrigger aria-label="Sort layouts">
            <SelectValue>{optionLabel(layoutSortOptions, sort)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {layoutSortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </RheaSelect>
        <RheaToggleGroup
          aria-label="Layout view"
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "grid" || next === "list") setView(next);
          }}
        >
          <RheaToggleGroupItem value="grid" aria-label="Grid view">
            <LayoutGrid size={16} aria-hidden="true" />
          </RheaToggleGroupItem>
          <RheaToggleGroupItem value="list" aria-label="List view">
            <List size={16} aria-hidden="true" />
          </RheaToggleGroupItem>
        </RheaToggleGroup>
      </DashboardListToolbar>

      {!layouts.isLoading && allLayouts.length > 0 && (
        <div className="text-sm text-muted-foreground" aria-live="polite">
          Showing {visibleLayouts.length} of {allLayouts.length} layouts
        </div>
      )}

      {layouts.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {layouts.error instanceof Error
              ? layouts.error.message
              : "Layouts could not be loaded."}
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
            <EmptyTitle>No layouts yet</EmptyTitle>
            <EmptyDescription>
              {canManage
                ? "Create a landscape or portrait canvas, then arrange reusable content on it."
                : "An Owner, Administrator, or Editor can create layouts."}
            </EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <RheaButton type="button" onClick={() => setCreating(true)}>
                Create layout
              </RheaButton>
            </EmptyContent>
          )}
        </Empty>
      ) : visibleLayouts.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayoutTemplate size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No matching layouts</EmptyTitle>
            <EmptyDescription>
              Try a different search or clear the layout filters.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <RheaButton
              type="button"
              variant="outline"
              onClick={clearLibraryFilters}
            >
              Clear filters
            </RheaButton>
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
            const menuLabel = `Actions for ${layout.name}`;
            return (
              <RheaContextMenu key={layout.id}>
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
                    aria-label={`${canManage ? "Edit" : "Open"} ${layout.name}`}
                    onClick={() => void navigate(`/layouts/${layout.id}`)}
                  >
                    <span className="relative block">
                      <LayoutPreview layout={layout} />
                      <span className="absolute top-2 left-2 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium">
                        {layoutPublicationLabel(layout)}
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
                        {layout.description || "No description"}
                      </span>
                      <span className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{orientationLabel(layout.orientation)}</span>
                        <span>Draft r{layout.draftRevision}</span>
                        {layout.publishedRevision && (
                          <span>Published r{layout.publishedRevision}</span>
                        )}
                      </span>
                      <small className="text-xs text-muted-foreground">
                        {formatLayoutUpdatedAt(layout.updatedAt)}
                      </small>
                    </span>
                  </button>
                  <RheaDropdownMenu>
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
                  </RheaDropdownMenu>
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
              </RheaContextMenu>
            );
          })}
        </div>
      )}

      <RheaDialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create layout</DialogTitle>
            <DialogDescription>
              Name the canvas, pick its size, and choose a starting point.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="layout-create-name">Name *</FieldLabel>
              <Input
                id="layout-create-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="layout-create-description">
                Description
              </FieldLabel>
              <Textarea
                id="layout-create-description"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <FieldDescription>
                Optional context that makes the layout easier to find later.
              </FieldDescription>
            </Field>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Canvas size</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {presets.map((item, index) => (
                  <RheaButton
                    type="button"
                    variant={preset === index ? "default" : "outline"}
                    className="h-auto items-center gap-3 p-3 text-left"
                    aria-pressed={preset === index}
                    key={item.label}
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
                      <strong className="text-sm">{item.label}</strong>
                      <small className="text-xs font-normal opacity-80">
                        {item.width} × {item.height}
                      </small>
                    </span>
                  </RheaButton>
                ))}
              </div>
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Starting point</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <RheaButton
                  type="button"
                  variant={template === "blank" ? "default" : "outline"}
                  className="h-auto items-center gap-3 p-3 text-left"
                  aria-pressed={template === "blank"}
                  onClick={() => setTemplate("blank")}
                >
                  <LayoutTemplate size={20} aria-hidden="true" />
                  <span className="grid gap-0.5">
                    <strong className="text-sm">Blank canvas</strong>
                    <small className="text-xs font-normal opacity-80">
                      Start with an empty layout.
                    </small>
                  </span>
                </RheaButton>
                <RheaButton
                  type="button"
                  variant={template === "announcement" ? "default" : "outline"}
                  className="h-auto items-center gap-3 p-3 text-left"
                  aria-pressed={template === "announcement"}
                  onClick={() => setTemplate("announcement")}
                >
                  <SquarePen size={20} aria-hidden="true" />
                  <span className="grid gap-0.5">
                    <strong className="text-sm">Announcement</strong>
                    <small className="text-xs font-normal opacity-80">
                      Begin with an accent bar and headline.
                    </small>
                  </span>
                </RheaButton>
              </div>
            </fieldset>
            {create.error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {create.error instanceof Error
                    ? create.error.message
                    : "The layout could not be created."}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <RheaButton type="button" variant="outline" onClick={closeCreate}>
              Cancel
            </RheaButton>
            <RheaButton
              type="button"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create layout"}
            </RheaButton>
          </DialogFooter>
        </DialogContent>
      </RheaDialog>

      <RheaDialog
        open={Boolean(renaming)}
        onOpenChange={(open) => {
          if (!open) closeRename();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rename layout</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <Field>
              <FieldLabel htmlFor="layout-rename-name">Name *</FieldLabel>
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
                    ? rename.error.message
                    : "The layout could not be renamed."}
                </AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <RheaButton type="button" variant="outline" onClick={closeRename}>
              Cancel
            </RheaButton>
            <RheaButton
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
              {rename.isPending ? "Saving…" : "Save name"}
            </RheaButton>
          </DialogFooter>
        </DialogContent>
      </RheaDialog>
      <RheaAlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {pendingDelete?.name ?? "layout"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Playlists using this layout keep their last published copy. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={remove.isPending}
              onClick={() => {
                if (pendingDelete) {
                  remove.mutate(pendingDelete.id);
                  setPendingDelete(null);
                }
              }}
            >
              Delete layout
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </RheaAlertDialog>
    </section>
  );
}

export const layoutPresets: {
  label: string;
  orientation: LayoutOrientation;
  width: number;
  height: number;
}[] = presets;
