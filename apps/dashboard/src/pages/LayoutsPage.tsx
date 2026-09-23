import {
  Button,
  ContextMenu,
  Dialog,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Select,
  ViewToggle,
  useContextMenu,
  type ContextMenuItem,
} from "../components/legacy-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Copy,
  EllipsisVertical,
  LayoutTemplate,
  Pencil,
  Plus,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  const menu = useContextMenu<LayoutSummary>();

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
  const actionsFor = (layout: LayoutSummary): ContextMenuItem[] => {
    const actions: ContextMenuItem[] = [
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
          onSelect: () => {
            if (window.confirm(`Delete ${layout.name}?`))
              remove.mutate(layout.id);
          },
        },
      );
    }
    return actions;
  };

  return (
    <section className="layout-library-page">
      <WorkspaceTabs label="Presentations" tabs={presentationTabs} />
      <PageHeader
        title="Layouts"
        description="Design reusable screen compositions and find the right canvas at a glance."
        actions={
          canManage ? (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />
              Create layout
            </Button>
          ) : undefined
        }
      />
      <DashboardListToolbar className="layout-library-toolbar">
        <DashboardSearch
          value={search}
          onValueChange={setSearch}
          label="Search layouts"
          placeholder="Search names, descriptions, or dimensions"
        />
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Filter layouts by orientation"
          value={orientation}
          onChange={(event) =>
            setOrientation(event.target.value as LayoutLibraryOrientationFilter)
          }
        >
          <option value="all">All orientations</option>
          <option value="landscape">Landscape</option>
          <option value="portrait">Portrait</option>
          <option value="custom">Custom</option>
        </Select>
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Filter layouts by publication status"
          value={publication}
          onChange={(event) =>
            setPublication(event.target.value as LayoutLibraryPublicationFilter)
          }
        >
          <option value="all">All statuses</option>
          <option value="published">Published</option>
          <option value="changes">Unpublished changes</option>
          <option value="draft">Draft only</option>
        </Select>
        <Select
          className="dashboard-list-toolbar__filter"
          aria-label="Sort layouts"
          value={sort}
          onChange={(event) => setSort(event.target.value as LayoutLibrarySort)}
        >
          <option value="updated">Recently updated</option>
          <option value="name">Name</option>
          <option value="created">Recently created</option>
          <option value="published">Recently published</option>
        </Select>
        <ViewToggle value={view} onValueChange={setView} label="Layout view" />
      </DashboardListToolbar>

      {!layouts.isLoading && allLayouts.length > 0 && (
        <div className="layout-library-summary" aria-live="polite">
          Showing {visibleLayouts.length} of {allLayouts.length} layouts
        </div>
      )}

      {layouts.isError && (
        <Notice variant="danger">
          {layouts.error instanceof Error
            ? layouts.error.message
            : "Layouts could not be loaded."}
        </Notice>
      )}
      {actionError && <Notice variant="danger">{actionError}</Notice>}

      {layouts.isLoading ? (
        <div className="table-loading">Loading layouts…</div>
      ) : allLayouts.length === 0 ? (
        <EmptyState
          className="content-empty"
          icon={<LayoutTemplate size={24} aria-hidden="true" />}
          title="No layouts yet"
          message={
            canManage
              ? "Create a landscape or portrait canvas, then arrange reusable content on it."
              : "An Owner, Administrator, or Editor can create layouts."
          }
          action={
            canManage ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                Create layout
              </Button>
            ) : undefined
          }
        />
      ) : visibleLayouts.length === 0 ? (
        <EmptyState
          className="content-empty"
          icon={<LayoutTemplate size={24} aria-hidden="true" />}
          title="No matching layouts"
          message="Try a different search or clear the layout filters."
          action={
            <Button variant="secondary" onClick={clearLibraryFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <div className={`layout-library-grid layout-library-grid--${view}`}>
          {visibleLayouts.map((layout) => {
            const publicationState = layoutPublicationState(layout);
            return (
              <article
                className="layout-library-card"
                data-orientation={layout.orientation}
                data-publication={publicationState}
                key={layout.id}
                onContextMenu={(event) => menu.open(event, layout)}
              >
                <button
                  type="button"
                  className="layout-library-card__menu"
                  aria-haspopup="menu"
                  aria-expanded={menu.anchor?.target.id === layout.id}
                  aria-label={`Actions for ${layout.name}`}
                  onClick={(event) => menu.open(event, layout)}
                >
                  <EllipsisVertical size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="layout-library-card__open"
                  aria-label={`${canManage ? "Edit" : "Open"} ${layout.name}`}
                  onClick={() => void navigate(`/layouts/${layout.id}`)}
                >
                  <span className="layout-library-card__preview">
                    <LayoutPreview layout={layout} />
                    <span className="layout-library-card__status">
                      {layoutPublicationLabel(layout)}
                    </span>
                    <span className="layout-library-card__dimensions">
                      {layout.canvasWidth} × {layout.canvasHeight}
                    </span>
                  </span>
                  <span className="layout-library-card__body">
                    <span className="layout-library-card__heading">
                      <strong title={layout.name}>{layout.name}</strong>
                      <ChevronRight size={17} aria-hidden="true" />
                    </span>
                    <span
                      className={`layout-library-card__description${layout.description ? "" : " is-empty"}`}
                    >
                      {layout.description || "No description"}
                    </span>
                    <span className="layout-library-card__metadata">
                      <span>{orientationLabel(layout.orientation)}</span>
                      <span>Draft r{layout.draftRevision}</span>
                      {layout.publishedRevision && (
                        <span>Published r{layout.publishedRevision}</span>
                      )}
                    </span>
                    <small>{formatLayoutUpdatedAt(layout.updatedAt)}</small>
                  </span>
                </button>
              </article>
            );
          })}
          {menu.anchor && (
            <ContextMenu
              x={menu.anchor.x}
              y={menu.anchor.y}
              label={`Actions for ${menu.anchor.target.name}`}
              items={actionsFor(menu.anchor.target)}
              onClose={menu.close}
            />
          )}
        </div>
      )}

      <Dialog
        open={creating}
        title="Create layout"
        onClose={closeCreate}
        className="layout-library-dialog"
      >
        <div className="layout-library-dialog__body">
          <Field label="Name" required>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label="Description"
            description="Optional context that makes the layout easier to find later."
          >
            <textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <fieldset className="layout-library-presets">
            <legend>Canvas size</legend>
            <div className="layout-library-presets__grid">
              {presets.map((item, index) => (
                <button
                  type="button"
                  aria-pressed={preset === index}
                  key={item.label}
                  onClick={() => setPreset(index)}
                >
                  <span
                    className={`layout-library-preset-shape layout-library-preset-shape--${item.orientation}`}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>{item.label}</strong>
                    <small>
                      {item.width} × {item.height}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="layout-library-starting-point">
            <legend>Starting point</legend>
            <button
              type="button"
              aria-pressed={template === "blank"}
              onClick={() => setTemplate("blank")}
            >
              <LayoutTemplate size={20} aria-hidden="true" />
              <span>
                <strong>Blank canvas</strong>
                <small>Start with an empty layout.</small>
              </span>
            </button>
            <button
              type="button"
              aria-pressed={template === "announcement"}
              onClick={() => setTemplate("announcement")}
            >
              <SquarePen size={20} aria-hidden="true" />
              <span>
                <strong>Announcement</strong>
                <small>Begin with an accent bar and headline.</small>
              </span>
            </button>
          </fieldset>
          {create.error && (
            <Notice variant="danger">
              {create.error instanceof Error
                ? create.error.message
                : "The layout could not be created."}
            </Notice>
          )}
        </div>
        <div className="form-actions">
          <Button variant="quiet" onClick={closeCreate}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Create layout
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(renaming)}
        title="Rename layout"
        onClose={closeRename}
        className="layout-library-rename-dialog"
      >
        <Field label="Name" required>
          <input
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
          <Notice variant="danger">
            {rename.error instanceof Error
              ? rename.error.message
              : "The layout could not be renamed."}
          </Notice>
        )}
        <div className="form-actions">
          <Button variant="quiet" onClick={closeRename}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              !renaming ||
              !renameName.trim() ||
              renameName.trim() === renaming.name
            }
            loading={rename.isPending}
            onClick={() => {
              if (!renaming) return;
              rename.mutate({
                layout: renaming,
                nextName: renameName.trim(),
              });
            }}
          >
            Save name
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

export const layoutPresets: {
  label: string;
  orientation: LayoutOrientation;
  width: number;
  height: number;
}[] = presets;
