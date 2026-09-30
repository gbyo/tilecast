import { cn } from "cn";
import { ContentPicker, PlaylistPicker } from "../components/content-picker";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Toggle } from "../components/ui/toggle";
import {
  EditorHeaderPortal,
  useEditorHeaderRename,
} from "../components/studio/EditorHeaderSlots";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "../components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { ButtonGroup, ButtonGroupText } from "../components/ui/button-group";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Input } from "../components/ui/input";
import { Field, FieldLabel } from "../components/ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Kbd } from "../components/ui/kbd";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "../components/ui/menubar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
import {
  isEditorCommandShortcutTarget,
  isInteractiveShortcutTarget,
} from "../lib/keyboard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { CanvasInspector } from "../components/layout-editor/CanvasInspector";
import { PlacementInspector } from "../components/layout-editor/PlacementInspector";
import { toast } from "../components/ui/toast";
import { LayoutPlacementView as PlacementView } from "../components/layout-editor/LayoutPlacementView";
import {
  LayoutCaptureCoordinator,
  LAYOUT_CAPTURE_SETTLE_TIMEOUT_MS,
  layoutPreviewNeedsCapture,
} from "../components/layout-editor/layoutCaptureReadiness";
import { studioWidgetComponent } from "../content/studioWidgets";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  AppWindow,
  Blocks,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  MonitorCog,
  Play,
  Square,
  SquareDashed,
  X,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  BoxSelect,
  Circle,
  CircleAlert,
  CircleDot,
  CloudCheck,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Group,
  History,
  Image as ImageIcon,
  Keyboard,
  Layers,
  Lock,
  LockOpen,
  ListVideo,
  Magnet,
  Maximize2,
  Minus,
  MoreHorizontal,
  MousePointerClick,
  Pencil,
  Plus,
  Redo2,
  RectangleHorizontal,
  Save,
  Scan,
  Settings,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Ungroup,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  presentationPath,
  useNativePresentationAvailable,
  useOpenNativePresentation,
} from "../native-presentation/openNativePresentation";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api/client";
import type {
  Asset,
  LayoutDocument,
  LayoutPlacement,
  LayoutPrimitive,
  Playlist,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { UsedByPanel } from "../content/UsedByPanel";
import { useFormatLocale } from "../i18n";
import { captureLayoutPreview } from "../content/widgetPreviewCapture";

// Room the canvas keeps clear of the floating chrome: the dock on the left
// (12px inset + 46px wide) and the zoom bar at the bottom (12px inset + 32px
// tall), each plus a 16px gap. Also the stage padding, so fit and layout agree.
const STAGE_PADDING = { top: 48, right: 48, bottom: 60, left: 74 };
const MAX_ZOOM = 4;
const MIN_ZOOM = 0.1;
/** At least this much of the canvas stays inside the viewport while panning. */
const PAN_MARGIN = 80;
const VIEW_ANIMATION_MS = 180;
type Viewport = { zoom: number; panX: number; panY: number };

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";
type LayoutLibrarySection = "widgets" | "media" | "playlists";
type LayoutLibraryItem =
  | { kind: "asset"; createdAt: string; asset: Asset }
  | { kind: "playlist"; createdAt: string; playlist: Playlist };

export function recentLayoutLibraryItems(
  section: LayoutLibrarySection,
  assets: Asset[],
  playlists: Playlist[],
): LayoutLibraryItem[] {
  const matchingAssets = assets
    .filter((asset) =>
      section === "widgets"
        ? asset.type === "widget"
        : section === "media"
          ? asset.type === "image" || asset.type === "video"
          : false,
    )
    .map((asset) => ({
      kind: "asset" as const,
      createdAt: asset.createdAt,
      asset,
    }));
  const matchingPlaylists =
    section === "playlists"
      ? playlists.map((playlist) => ({
          kind: "playlist" as const,
          createdAt: playlist.createdAt,
          playlist,
        }))
      : [];
  return [...matchingAssets, ...matchingPlaylists]
    .sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    )
    .slice(0, 20);
}

const clone = <T,>(value: T): T => structuredClone(value);

export async function flushLatestLayoutDraft(
  read: () => {
    changeVersion: number;
    savedChangeVersion: number;
    revision: number;
    document: LayoutDocument;
  },
  persist: (
    revision: number,
    document: LayoutDocument,
  ) => Promise<{ draftRevision: number }>,
  applied: (changeVersion: number, draftRevision: number) => void,
) {
  while (true) {
    const snapshot = read();
    if (snapshot.savedChangeVersion === snapshot.changeVersion) return;
    const saved = await persist(snapshot.revision, clone(snapshot.document));
    applied(snapshot.changeVersion, saved.draftRevision);
  }
}
const selectedPlacements = (document: LayoutDocument, selection: Set<string>) =>
  document.placements.filter((item) => selection.has(item.id));

/**
 * Default geometry for anything dropped in from the library: 40% of the canvas, centred
 * on the pointer when there is one, otherwise parked in the upper left.
 */
function placementBox(
  canvas: LayoutDocument["canvas"],
  position?: { x: number; y: number },
) {
  const width = canvas.width * 0.4;
  const height = canvas.height * 0.4;
  return {
    width,
    height,
    x: position
      ? Math.max(0, Math.min(canvas.width - width, position.x - width / 2))
      : canvas.width * 0.2,
    y: position
      ? Math.max(0, Math.min(canvas.height - height, position.y - height / 2))
      : canvas.height * 0.2,
  };
}

/** `layer` is left at 0; callers stack it against the document they are pushing into. */
export function createContentPlacement(
  asset: Asset,
  canvas: LayoutDocument["canvas"],
  position?: { x: number; y: number },
): LayoutPlacement {
  const isApp = asset.type === "widget";
  const variantId = isApp
    ? undefined
    : asset.variants
        ?.filter((variant) => variant.playerCompatible)
        .sort((a, b) =>
          a.kind === "playback" ? -1 : b.kind === "playback" ? 1 : 0,
        )[0]?.id;
  return {
    id: crypto.randomUUID(),
    type: isApp ? "widget" : "asset",
    name: asset.name,
    ...placementBox(canvas, position),
    layer: 0,
    opacity: 1,
    visible: true,
    locked: false,
    widgetId: isApp ? asset.id : undefined,
    assetId: isApp ? undefined : asset.id,
    variantId,
    playback: !isApp
      ? {
          fit: "contain",
          muted: true,
          loop: true,
          fallback: "hide",
          cornerRadius: 0,
        }
      : undefined,
  };
}

export function createPlaylistZonePlacement(
  playlist: Playlist,
  canvas: LayoutDocument["canvas"],
  position?: { x: number; y: number },
): LayoutPlacement {
  return {
    id: crypto.randomUUID(),
    type: "playlistZone",
    name: playlist.name,
    ...placementBox(canvas, position),
    layer: 0,
    opacity: 1,
    visible: true,
    locked: false,
    playlistId: playlist.id,
    playback: {
      fit: "contain",
      muted: true,
      loop: true,
      fallback: "background",
      cornerRadius: 0,
    },
  };
}

/** Where a right-click landed: on a placement, or on the empty canvas behind them. */
type LayoutMenuTarget =
  { kind: "placement"; item: LayoutPlacement } | { kind: "canvas" };

type LayoutMenuEntry = {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  separated?: boolean;
  danger?: boolean;
  submenu?: LayoutMenuEntry[];
  onSelect?: () => void;
};

function LayoutEditorMenuEntries({ items }: { items: LayoutMenuEntry[] }) {
  return (
    <>
      {items.map((entry, index) => (
        <Fragment key={`${entry.label}-${index}`}>
          {entry.separated && <ContextMenuSeparator />}
          {entry.submenu ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={entry.disabled}>
                {entry.icon}
                {entry.label}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent aria-label={entry.label}>
                <LayoutEditorMenuEntries items={entry.submenu} />
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : (
            <ContextMenuItem
              variant={entry.danger ? "destructive" : "default"}
              disabled={entry.disabled}
              onClick={entry.onSelect}
            >
              {entry.icon}
              {entry.label}
            </ContextMenuItem>
          )}
        </Fragment>
      ))}
    </>
  );
}

export type LayoutArrangeMode = "front" | "forward" | "backward" | "back";
export type LayoutAlignMode =
  "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom";

/**
 * Restacks the document so `layer` is a dense 0..n-1 sequence with the selection moved
 * as one block. Renumbering rather than adding/subtracting keeps repeated "bring
 * forward" presses meaningful even when a document arrives with duplicate layers.
 */
export function arrangePlacements(
  placements: LayoutPlacement[],
  selection: Set<string>,
  mode: LayoutArrangeMode,
) {
  const ordered = [...placements].sort((a, b) => a.layer - b.layer);
  const isSelected = (item: LayoutPlacement) => selection.has(item.id);
  if (mode === "front" || mode === "back") {
    const moving = ordered.filter(isSelected);
    const rest = ordered.filter((item) => !isSelected(item));
    const next = mode === "front" ? [...rest, ...moving] : [...moving, ...rest];
    next.forEach((item, index) => {
      item.layer = index;
    });
    return;
  }
  const swapPast = (at: number, neighbour: number) => {
    const item = ordered[at];
    const other = ordered[neighbour];
    if (!item || !other) return;
    if (!isSelected(item) || isSelected(other)) return;
    ordered[at] = other;
    ordered[neighbour] = item;
  };
  // Walk from the end the selection is heading toward so a block of selected items
  // shuffles past its neighbour intact instead of collapsing onto itself.
  if (mode === "forward")
    for (let index = ordered.length - 2; index >= 0; index -= 1)
      swapPast(index, index + 1);
  else
    for (let index = 1; index < ordered.length; index += 1)
      swapPast(index, index - 1);
  ordered.forEach((item, index) => {
    item.layer = index;
  });
}

/**
 * Moves the named placements by the given offsets, clamped to the canvas, carrying the
 * children of any group by whatever offset its box actually took.
 */
export function offsetPlacements(
  document: LayoutDocument,
  moves: Map<string, { dx: number; dy: number }>,
) {
  const byID = new Map(document.placements.map((item) => [item.id, item]));
  moves.forEach(({ dx, dy }, id) => {
    const item = byID.get(id);
    if (!item) return;
    const x = Math.max(
      0,
      Math.min(document.canvas.width - item.width, item.x + dx),
    );
    const y = Math.max(
      0,
      Math.min(document.canvas.height - item.height, item.y + dy),
    );
    const appliedX = x - item.x;
    const appliedY = y - item.y;
    item.x = x;
    item.y = y;
    if (!appliedX && !appliedY) return;
    document.placements.forEach((child) => {
      if (child.groupId !== id) return;
      child.x = Math.max(
        0,
        Math.min(document.canvas.width - child.width, child.x + appliedX),
      );
      child.y = Math.max(
        0,
        Math.min(document.canvas.height - child.height, child.y + appliedY),
      );
    });
  });
}

/**
 * Offsets that align every item to a shared edge or centre line. `box` is the selection's
 * own bounds when several items are selected, or the canvas when only one is.
 */
export function alignOffsets(
  items: LayoutPlacement[],
  box: { left: number; top: number; right: number; bottom: number },
  mode: LayoutAlignMode,
) {
  return new Map(
    items.map((item) => {
      const target =
        mode === "left"
          ? box.left
          : mode === "hcenter"
            ? box.left + (box.right - box.left - item.width) / 2
            : mode === "right"
              ? box.right - item.width
              : mode === "top"
                ? box.top
                : mode === "vmiddle"
                  ? box.top + (box.bottom - box.top - item.height) / 2
                  : box.bottom - item.height;
      const horizontal =
        mode === "left" || mode === "hcenter" || mode === "right";
      return [
        item.id,
        horizontal
          ? { dx: target - item.x, dy: 0 }
          : { dx: 0, dy: target - item.y },
      ] as const;
    }),
  );
}

/** Offsets that spread the middle items so every centre-to-centre gap is equal. */
export function distributeOffsets(
  items: LayoutPlacement[],
  axis: "horizontal" | "vertical",
) {
  const centerOf = (item: LayoutPlacement) =>
    axis === "horizontal" ? item.x + item.width / 2 : item.y + item.height / 2;
  const sorted = [...items].sort((a, b) => centerOf(a) - centerOf(b));
  const head = sorted[0];
  const tail = sorted[sorted.length - 1];
  // Fewer than two items have no gap to even out; callers already guard on three.
  if (!head || !tail || sorted.length < 2)
    return new Map<string, { dx: number; dy: number }>();
  const first = centerOf(head);
  const step = (centerOf(tail) - first) / (sorted.length - 1);
  return new Map(
    sorted.map((item, index) => {
      const delta = first + step * index - centerOf(item);
      return [
        item.id,
        axis === "horizontal" ? { dx: delta, dy: 0 } : { dx: 0, dy: delta },
      ] as const;
    }),
  );
}

export function createPrimitivePlacement(
  kind: LayoutPrimitive["kind"],
  canvas: LayoutDocument["canvas"],
): LayoutPlacement {
  const isLine = kind === "line";
  const isGroup = kind === "group";
  return {
    id: crypto.randomUUID(),
    type: "primitive",
    name: kind === "text" ? "Text" : kind[0]!.toUpperCase() + kind.slice(1),
    x: canvas.width * 0.25,
    y: canvas.height * 0.25,
    width: isLine
      ? canvas.width * 0.3
      : isGroup
        ? canvas.width * 0.4
        : canvas.width * 0.25,
    height: isLine ? 8 : isGroup ? canvas.height * 0.3 : canvas.height * 0.16,
    layer: 1,
    opacity: 1,
    visible: true,
    locked: false,
    primitive: {
      kind,
      text: kind === "text" ? "New text" : undefined,
      fontFamily: "Inter",
      fontSize: 64,
      fontWeight: 600,
      textAlign: "left",
      verticalAlign: "center",
      color: "#FFFFFF",
      backgroundColor: "#00000000",
      lineHeight: 1.2,
      letterSpacing: 0,
      padding: 12,
      borderWidth: 0,
      borderColor: "#FFFFFF",
      cornerRadius: 0,
      maximumLines: 4,
      overflow: "ellipsis",
      autoFit: false,
      minimumFontSize: 18,
      fillColor:
        kind === "circle" || kind === "rectangle" ? "#2D7FF9" : "#00000000",
      strokeColor: "#FFFFFF",
      strokeWidth: kind === "line" ? 6 : 0,
    },
  };
}

export function LayoutEditorPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation(["layouts", "common"]);
  const nativePresentations = useNativePresentationAvailable();
  const openNativePresentation = useOpenNativePresentation();
  const { t: tContent } = useTranslation("content");
  const formatLocale = useFormatLocale();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const canPublish = ["owner", "administrator", "editor"].includes(
    auth.status?.user?.role ?? "",
  );
  const canSubmit = canPublish || auth.status?.user?.role === "contributor";
  const queryClient = useQueryClient();
  const layoutQuery = useQuery({
    queryKey: ["layout", id],
    queryFn: () => api.layout(id),
    enabled: Boolean(id),
  });
  const contentQuery = useQuery({
    queryKey: ["layout-content-library"],
    queryFn: () =>
      api.assets(
        new URLSearchParams({
          status: "ready",
          page: "1",
          pageSize: "100",
          sort: "name",
        }),
      ),
  });
  const playlistsQuery = useQuery({
    queryKey: ["layout-playlists"],
    queryFn: () => api.playlists(""),
  });
  const dataSourcesQuery = useQuery({
    queryKey: ["layout-data-sources"],
    queryFn: () =>
      api.listDataSources(
        new URLSearchParams({ page: "1", pageSize: "100", sort: "name" }),
      ),
  });
  const revisions = useQuery({
    queryKey: ["layout-revisions", id],
    queryFn: () => api.layoutRevisions(id),
    enabled: false,
  });
  // One capture-readiness coordinator per editor instance. Live V2 zones on
  // the canvas register by placement id; thumbnail triggers wait through it
  // instead of racing Widget loads with an arbitrary delay.
  const captureCoordinator = useMemo(() => new LayoutCaptureCoordinator(), []);
  const definitionsQuery = useQuery({
    queryKey: ["content-definitions"],
    queryFn: () => api.contentDefinitions(),
  });
  // Placement ids whose V2 Widgets a thumbnail must wait for: visible,
  // directly placed Widgets with a migrated component. Playlist zones join
  // the wait through the coordinator when they currently show a V2 Widget.
  const captureZoneIds = useCallback(
    (doc: LayoutDocument): string[] => {
      const assets = new Map(
        (contentQuery.data?.items ?? []).map((asset) => [asset.id, asset]),
      );
      return doc.placements
        .filter((item) => item.visible !== false && item.type === "widget")
        .filter((item) => {
          const provider = item.widgetId
            ? assets.get(item.widgetId)?.widget?.provider
            : undefined;
          return (
            provider != null &&
            studioWidgetComponent(definitionsQuery.data, provider) != null
          );
        })
        .map((item) => item.id);
    },
    [contentQuery.data?.items, definitionsQuery.data],
  );
  const [document, setDocument] = useState<LayoutDocument>();
  const [selection, setSelection] = useState(new Set<string>());
  const [past, setPast] = useState<LayoutDocument[]>([]);
  const [future, setFuture] = useState<LayoutDocument[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [serverRevision, setServerRevision] = useState(0);
  const [view, setViewState] = useState<Viewport>({
    zoom: 1,
    panX: 0,
    panY: 0,
  });
  const viewRef = useRef(view);
  const worldRef = useRef<HTMLDivElement>(null);
  const commitFrame = useRef(0);
  const viewAnimation = useRef(0);
  const spaceHeld = useRef(false);
  const [panMode, setPanMode] = useState<"idle" | "ready" | "dragging">("idle");
  const zoom = view.zoom;
  const desktop = useDesktopLayout();
  const [snap, setSnap] = useState(true);
  const [safeArea, setSafeArea] = useState(true);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuQuery, setAddMenuQuery] = useState("");
  const [activeTool, setActiveTool] = useState<LayoutPrimitive["kind"] | null>(
    null,
  );
  const [layersOpen, setLayersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [toolDraft, setToolDraft] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [picker, setPicker] = useState<"media" | "widgets" | "playlists">();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<
    | { kind: "placement"; id: string; name: string }
    | { kind: "layout"; name: string }
    | null
  >(null);
  const [renameValue, setRenameValue] = useState("");
  // Anything chosen through a picker can live outside the shelf query's first page, so
  // it is cached here and merged into the lookups the canvas renders from.
  const [pickedAssets, setPickedAssets] = useState<Asset[]>([]);
  const [pickedPlaylists, setPickedPlaylists] = useState<Playlist[]>([]);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const canvasRef = useRef<HTMLDivElement>(null);
  // History opens from a menu item that unmounts, so focus returns to the
  // menu's trigger when the dialog closes.
  const fileMenuTrigger = useRef<HTMLButtonElement>(null);
  const canvasWidth = document?.canvas.width;
  const canvasHeight = document?.canvas.height;
  const getViewport = useCallback(
    () =>
      canvasRef.current?.closest<HTMLElement>(".layout-stage-scroll") ?? null,
    [],
  );
  const clampView = useCallback(
    (next: Viewport): Viewport => {
      const viewport = getViewport();
      const zoomValue = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next.zoom));
      if (!viewport || !canvasWidth || !canvasHeight)
        return { ...next, zoom: zoomValue };
      const w = canvasWidth * zoomValue;
      const h = canvasHeight * zoomValue;
      const clampAxis = (pan: number, size: number, extent: number) =>
        Math.min(
          Math.max(pan, Math.min(PAN_MARGIN, size) - size),
          extent - Math.min(PAN_MARGIN, size),
        );
      return {
        zoom: zoomValue,
        panX: clampAxis(next.panX, w, viewport.clientWidth),
        panY: clampAxis(next.panY, h, viewport.clientHeight),
      };
    },
    [canvasWidth, canvasHeight, getViewport],
  );
  // Pan and zoom write the transform straight to the DOM so they never wait
  // on a React render of the whole editor; React state only follows, coalesced
  // to one commit per frame, for the zoom readout and the selection chrome.
  const applyView = useCallback((next: Viewport) => {
    viewRef.current = next;
    const world = worldRef.current;
    if (world) {
      world.style.transform = `translate(${next.panX}px, ${next.panY}px) scale(${next.zoom})`;
      world.style.setProperty("--tc-zoom", String(next.zoom));
    }
    if (!commitFrame.current) {
      commitFrame.current = window.requestAnimationFrame(() => {
        commitFrame.current = 0;
        setViewState(viewRef.current);
      });
    }
  }, []);
  const setViewport = useCallback(
    (next: Viewport) => {
      window.cancelAnimationFrame(viewAnimation.current);
      applyView(clampView(next));
    },
    [clampView, applyView],
  );
  /** Eases to `target` over 180ms; jumps when the user prefers reduced motion. */
  const animateViewport = useCallback(
    (target: Viewport) => {
      window.cancelAnimationFrame(viewAnimation.current);
      const end = clampView(target);
      const reduce =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) {
        applyView(end);
        return;
      }
      const from = viewRef.current;
      const startTime = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startTime) / VIEW_ANIMATION_MS);
        const eased = 1 - (1 - t) ** 3;
        const frame = {
          zoom: from.zoom + (end.zoom - from.zoom) * eased,
          panX: from.panX + (end.panX - from.panX) * eased,
          panY: from.panY + (end.panY - from.panY) * eased,
        };
        applyView(frame);
        if (t < 1) viewAnimation.current = window.requestAnimationFrame(step);
      };
      viewAnimation.current = window.requestAnimationFrame(step);
    },
    [clampView, applyView],
  );
  /** Zoom keeping the viewport point (px, py) fixed on the canvas. */
  const viewAt = useCallback(
    (zoomValue: number, px: number, py: number): Viewport => {
      const current = viewRef.current;
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomValue));
      const wx = (px - current.panX) / current.zoom;
      const wy = (py - current.panY) / current.zoom;
      return {
        zoom: nextZoom,
        panX: px - wx * nextZoom,
        panY: py - wy * nextZoom,
      };
    },
    [],
  );
  const viewCenter = useCallback(() => {
    const viewport = getViewport();
    return {
      x: (viewport?.clientWidth ?? 0) / 2,
      y: (viewport?.clientHeight ?? 0) / 2,
    };
  }, [getViewport]);
  const zoomTo = useCallback(
    (zoomValue: number, animate = true) => {
      const { x, y } = viewCenter();
      const next = viewAt(zoomValue, x, y);
      if (animate) animateViewport(next);
      else setViewport(next);
    },
    [animateViewport, setViewport, viewAt, viewCenter],
  );
  const zoomIn = useCallback(
    () => zoomTo(viewRef.current.zoom + 0.1),
    [zoomTo],
  );
  const zoomOut = useCallback(
    () => zoomTo(viewRef.current.zoom - 0.1),
    [zoomTo],
  );
  // Fit centers the whole canvas in the space the floating dock and zoom bar
  // leave free, and never scales above 100%. Skipped before the viewport has
  // a size (first layout, tests) so the canvas is not collapsed to nothing.
  const fitZoom = useCallback(
    (animate = true) => {
      const viewport = getViewport();
      if (!viewport || !canvasWidth || !canvasHeight) return;
      if (!viewport.clientWidth || !viewport.clientHeight) return;
      const availW = Math.max(
        1,
        viewport.clientWidth - STAGE_PADDING.left - STAGE_PADDING.right,
      );
      const availH = Math.max(
        1,
        viewport.clientHeight - STAGE_PADDING.top - STAGE_PADDING.bottom,
      );
      const fitValue = Math.max(
        MIN_ZOOM,
        Math.min(1, availW / canvasWidth, availH / canvasHeight),
      );
      const next = {
        zoom: fitValue,
        panX: STAGE_PADDING.left + (availW - canvasWidth * fitValue) / 2,
        panY: STAGE_PADDING.top + (availH - canvasHeight * fitValue) / 2,
      };
      if (animate) animateViewport(next);
      else setViewport(next);
    },
    [canvasWidth, canvasHeight, animateViewport, setViewport, getViewport],
  );
  // Fit on load, when the pane or window resizes, and when the canvas
  // orientation or size changes.
  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const refit = () => fitZoom(false);
    refit();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", refit);
      return () => window.removeEventListener("resize", refit);
    }
    const observer = new ResizeObserver(refit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitZoom, getViewport]);
  // Wheel: pinch (ctrlKey) or Cmd + wheel zooms about the cursor; a plain
  // wheel or two-finger scroll pans and leaves inertia to the OS. Safari
  // reports pinch as gesture events instead.
  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;
    const origin = (event: { clientX: number; clientY: number }) => {
      const rect = viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      let dx = event.deltaX * unit;
      let dy = event.deltaY * unit;
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const { x, y } = origin(event);
        setViewport(viewAt(viewRef.current.zoom * Math.exp(-dy * 0.01), x, y));
        return;
      }
      if (!dx && !dy) return;
      event.preventDefault();
      if (event.shiftKey && !dx) {
        dx = dy;
        dy = 0;
      }
      const current = viewRef.current;
      setViewport({
        ...current,
        panX: current.panX - dx,
        panY: current.panY - dy,
      });
    };
    let gestureStartZoom = 1;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoom = viewRef.current.zoom;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & {
        scale: number;
        clientX: number;
        clientY: number;
      };
      const { x, y } = origin(gesture);
      setViewport(viewAt(gestureStartZoom * gesture.scale, x, y));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("gesturestart", onGestureStart);
    viewport.addEventListener("gesturechange", onGestureChange);
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("gesturestart", onGestureStart);
      viewport.removeEventListener("gesturechange", onGestureChange);
    };
  }, [setViewport, viewAt, canvasWidth, getViewport]);
  // Cmd/Ctrl 0 fits, 1 is 100%, +/- zoom about the center; Space arms panning.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const controlCommand =
        (event.ctrlKey || event.metaKey) &&
        isEditorCommandShortcutTarget(event.target);
      if (
        event.defaultPrevented ||
        (isInteractiveShortcutTarget(event.target) && !controlCommand)
      )
        return;
      if (event.code === "Space") {
        event.preventDefault();
        if (!spaceHeld.current) {
          spaceHeld.current = true;
          setPanMode((mode) => (mode === "idle" ? "ready" : mode));
        }
        return;
      }
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        zoomIn();
      } else if (event.key === "-") {
        event.preventDefault();
        zoomOut();
      } else if (event.key === "0") {
        event.preventDefault();
        fitZoom();
      } else if (event.key === "1") {
        event.preventDefault();
        zoomTo(1);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceHeld.current = false;
      setPanMode((mode) => (mode === "ready" ? "idle" : mode));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [fitZoom, zoomIn, zoomOut, zoomTo]);
  /**
   * Middle-button or Space + primary drag pans. Touch can opt in when the
   * gesture starts on the canvas (or a locked placement), so one-finger
   * navigation does not steal direct manipulation from unlocked placements.
   */
  const beginPan = (event: ReactPointerEvent, allowTouch = false) => {
    const touchPan =
      allowTouch && event.pointerType === "touch" && event.button === 0;
    if (!(
      touchPan ||
      event.button === 1 ||
      (event.button === 0 && spaceHeld.current)
    ))
      return false;
    event.preventDefault();
    event.stopPropagation();
    const startPointer = { x: event.clientX, y: event.clientY };
    const startView = viewRef.current;
    setPanMode("dragging");
    const move = (e: PointerEvent) =>
      setViewport({
        ...startView,
        panX: startView.panX + e.clientX - startPointer.x,
        panY: startView.panY + e.clientY - startPointer.y,
      });
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setPanMode(spaceHeld.current ? "ready" : "idle");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return true;
  };
  const clipboard = useRef<LayoutPlacement[]>([]);
  const initialized = useRef(false);
  const documentRef = useRef<LayoutDocument | undefined>(undefined);
  const activeToolRef = useRef<LayoutPrimitive["kind"] | null>(null);
  const revisionRef = useRef(0);
  const savingRef = useRef(false);
  const changeVersionRef = useRef(0);
  const savedChangeVersionRef = useRef(0);
  const initialPreviewAttemptedRef = useRef(false);
  useEffect(() => {
    if (!layoutQuery.data || initialized.current) return;
    initialized.current = true;
    const next = clone(layoutQuery.data.draft);
    setDocument(next);
    documentRef.current = next;
    setServerRevision(layoutQuery.data.draftRevision);
    revisionRef.current = layoutQuery.data.draftRevision;
  }, [layoutQuery.data]);
  useEffect(() => {
    documentRef.current = document;
  }, [document]);
  useEffect(() => {
    revisionRef.current = serverRevision;
  }, [serverRevision]);
  useEffect(() => {
    if (
      initialPreviewAttemptedRef.current ||
      !document ||
      contentQuery.isLoading ||
      definitionsQuery.isLoading ||
      playlistsQuery.isLoading ||
      !layoutQuery.data
    )
      return;
    // A failed metadata query means the canvas may still contain placeholder
    // zones. Keep the preview stale until a retry can identify them safely.
    if (
      contentQuery.isError ||
      definitionsQuery.isError ||
      playlistsQuery.isError
    )
      return;
    // Regenerate missing previews and ones stored by an older capture
    // pipeline (stale generations may show blank Widget zones). Fresh
    // previews are trusted; lists never trigger regeneration.
    if (
      !layoutPreviewNeedsCapture(
        layoutQuery.data.previewImageUrl,
        layoutQuery.data.previewCaptureVersion,
      )
    )
      return;
    // Wait for embedded V2 Widgets to settle (ready, intentional empty, or
    // an explicitly handled failure) instead of capturing after a fixed
    // delay. A failure or timeout skips the capture: the Layout keeps its
    // honest missing-preview state instead of a half-rendered thumbnail.
    // The attempt flag is set only when the async attempt runs to
    // completion. If the inputs change mid-attempt, cleanup cancels it and
    // leaves the flag unset so the effect retries with the current zones
    // instead of suppressing the capture forever.
    const revision = revisionRef.current;
    const zones = captureZoneIds(document);
    const { width, height } = document.canvas;
    let cancelled = false;
    void (async () => {
      try {
        const { ok } = await captureCoordinator.waitForSettled(
          zones,
          LAYOUT_CAPTURE_SETTLE_TIMEOUT_MS,
        );
        if (cancelled || !ok) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const image = await captureLayoutPreview(
          canvas,
          width,
          height,
          tContent,
        ).catch(() => undefined);
        if (!image || cancelled) return;
        // The draft may have been edited or saved while the Widgets settled;
        // never let a stale capture overwrite a newer revision's thumbnail.
        if (revision !== revisionRef.current) return;
        await api
          .uploadLayoutPreview(id, revision, image, csrf)
          .catch(() => undefined);
        if (cancelled) return;
        void queryClient.invalidateQueries({ queryKey: ["layout", id] });
        void queryClient.invalidateQueries({ queryKey: ["layouts"] });
      } finally {
        if (!cancelled) initialPreviewAttemptedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    captureCoordinator,
    captureZoneIds,
    contentQuery.isError,
    contentQuery.isLoading,
    csrf,
    definitionsQuery.isError,
    definitionsQuery.isLoading,
    document,
    id,
    layoutQuery.data,
    playlistsQuery.isError,
    playlistsQuery.isLoading,
    queryClient,
    tContent,
  ]);
  const markUnsaved = useCallback(() => {
    changeVersionRef.current += 1;
    setSaveState("unsaved");
  }, []);
  const commit = useCallback(
    (next: LayoutDocument) => {
      documentRef.current = next;
      setDocument((current) => {
        if (current) setPast((items) => [...items.slice(-79), clone(current)]);
        return next;
      });
      setFuture([]);
      markUnsaved();
    },
    [markUnsaved],
  );
  const update = useCallback(
    (change: (draft: LayoutDocument) => void) => {
      if (!documentRef.current) return;
      const next = clone(documentRef.current);
      change(next);
      commit(next);
    },
    [commit],
  );
  const undo = useCallback(() => {
    setPast((items) => {
      const prior = items.at(-1);
      if (!prior) return items;
      setDocument((current) => {
        if (current) setFuture((next) => [clone(current), ...next]);
        const restored = clone(prior);
        documentRef.current = restored;
        return restored;
      });
      markUnsaved();
      return items.slice(0, -1);
    });
  }, [markUnsaved]);
  const redo = useCallback(() => {
    setFuture((items) => {
      const next = items[0];
      if (!next) return items;
      setDocument((current) => {
        if (current) setPast((previous) => [...previous, clone(current)]);
        const restored = clone(next);
        documentRef.current = restored;
        return restored;
      });
      markUnsaved();
      return items.slice(1);
    });
  }, [markUnsaved]);
  const save = useCallback(async () => {
    if (!documentRef.current) return false;
    if (savingRef.current) return false;
    if (savedChangeVersionRef.current === changeVersionRef.current) return true;
    savingRef.current = true;
    try {
      setSaveState("saving");
      await flushLatestLayoutDraft(
        () => ({
          changeVersion: changeVersionRef.current,
          savedChangeVersion: savedChangeVersionRef.current,
          revision: revisionRef.current,
          document: documentRef.current!,
        }),
        (revision, snapshot) =>
          api.saveLayoutDraft(id, revision, snapshot, csrf),
        (savedVersion, draftRevision) => {
          revisionRef.current = draftRevision;
          setServerRevision(draftRevision);
          savedChangeVersionRef.current = savedVersion;
          void queryClient.invalidateQueries({ queryKey: ["layouts"] });
        },
      );
      setSaveState("saved");

      // A preview is useful library artwork, but it is not the draft. Generate it
      // after releasing the save lock so a slow browser capture cannot strand an
      // edit made while the thumbnail is rendering.
      const previewVersion = changeVersionRef.current;
      const previewRevision = revisionRef.current;
      const previewDocument = clone(documentRef.current);
      const zones = captureZoneIds(previewDocument);
      const canvas = canvasRef.current;
      if (canvas) {
        void (async () => {
          // Settle first: an edit saved while a Widget is still loading must
          // not be immortalized as a half-rendered thumbnail. Failure and
          // timeout skip the upload; the saved draft is unaffected and the
          // next save retries.
          const { ok } = await captureCoordinator.waitForSettled(
            zones,
            LAYOUT_CAPTURE_SETTLE_TIMEOUT_MS,
          );
          if (!ok) return;
          const previewImage = await captureLayoutPreview(
            canvas,
            previewDocument.canvas.width,
            previewDocument.canvas.height,
            tContent,
          ).catch(() => undefined);
          if (!previewImage) return;
          if (
            previewVersion !== changeVersionRef.current ||
            previewRevision !== revisionRef.current
          )
            return;
          await api
            .uploadLayoutPreview(id, previewRevision, previewImage, csrf)
            // Thumbnail capture can fail because of browser canvas/CORS support. The
            // server draft is already safely persisted, so do not report this as a
            // draft-save failure or prevent publishing.
            .catch(() => undefined);
          void queryClient.invalidateQueries({ queryKey: ["layouts"] });
        })();
      }
      return true;
    } catch (error) {
      setSaveState(
        error instanceof ApiError && error.code === "layout_revision_conflict"
          ? "conflict"
          : "error",
      );
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [captureCoordinator, captureZoneIds, csrf, id, queryClient, tContent]);
  useEffect(() => {
    if (saveState !== "unsaved") return;
    const timer = window.setTimeout(() => void save(), 900);
    return () => window.clearTimeout(timer);
  }, [document, save, saveState]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (
        savedChangeVersionRef.current !== changeVersionRef.current ||
        savingRef.current
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const publish = useMutation<unknown, ApiError>({
    mutationFn: () =>
      canPublish
        ? api.publishLayout(id, serverRevision, csrf)
        : api.submitContent("layout", id, csrf, undefined, serverRevision),
    onSuccess: () => {
      toast.add({
        title: canPublish
          ? t("editor.toastPublished")
          : t("editor.toastSubmitted"),
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["layout", id] });
      void queryClient.invalidateQueries({ queryKey: ["layouts"] });
      void queryClient.invalidateQueries({ queryKey: ["content-submissions"] });
      void queryClient.invalidateQueries({
        queryKey: ["content-history", "layout", id],
      });
    },
  });
  const rename = useMutation({
    mutationFn: (name: string) =>
      api.updateLayout(
        id,
        { name, description: layoutQuery.data?.description ?? "" },
        csrf,
      ),
    onSuccess: () => {
      toast.add({ title: t("editor.toastRenamed"), type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["layout", id] });
      void queryClient.invalidateQueries({ queryKey: ["layouts"] });
    },
  });
  const restore = useMutation({
    mutationFn: (revisionId: string) =>
      api.restoreLayoutRevision(id, revisionId, serverRevision, csrf),
    onSuccess: (saved) => {
      toast.add({
        title: t("editor.toastRestored"),
        type: "success",
      });
      const next = clone(saved.draft);
      setDocument(next);
      documentRef.current = next;
      setServerRevision(saved.draftRevision);
      revisionRef.current = saved.draftRevision;
      changeVersionRef.current = 0;
      savedChangeVersionRef.current = 0;
      setPast([]);
      setFuture([]);
      setSaveState("saved");
      setHistoryOpen(false);
    },
  });
  const selected = useMemo(
    () => (document ? selectedPlacements(document, selection) : []),
    [document, selection],
  );
  const recentLibraryItems = useMemo(
    () =>
      (["media", "widgets", "playlists"] as const)
        .flatMap((section) =>
          recentLayoutLibraryItems(
            section,
            contentQuery.data?.items ?? [],
            playlistsQuery.data?.items ?? [],
          ),
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 4),
    [contentQuery.data?.items, playlistsQuery.data?.items],
  );
  const primary = selected.at(-1);
  useEffect(() => {
    if (desktop || (!primary && !settingsOpen)) setMobileInspectorOpen(false);
  }, [desktop, primary, settingsOpen]);
  const mutateSelected = useCallback(
    (change: (item: LayoutPlacement) => void) =>
      update((draft) =>
        draft.placements.forEach((item) => {
          if (selection.has(item.id)) change(item);
        }),
      ),
    [selection, update],
  );
  const addPrimitive = (kind: LayoutPrimitive["kind"]) => {
    if (!document) return;
    const item = createPrimitivePlacement(kind, document.canvas);
    update((draft) => {
      item.layer = Math.max(0, ...draft.placements.map((x) => x.layer)) + 1;
      draft.placements.push(item);
    });
    setSelection(new Set([item.id]));
  };
  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);
  const canvasPoint = (event: { clientX: number; clientY: number }) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    const current = documentRef.current;
    if (!bounds || !current || !bounds.width) return undefined;
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * current.canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * current.canvas.height,
    };
  };
  /** Armed tool: a click drops the default size at the pointer, a drag draws the box. */
  const beginToolDraw = (event: ReactPointerEvent) => {
    const kind = activeTool;
    const start = canvasPoint(event);
    const current = documentRef.current;
    if (!kind || !start || !current || event.button !== 0) return false;
    event.preventDefault();
    const startClient = { x: event.clientX, y: event.clientY };
    setToolDraft({ x0: start.x, y0: start.y, x1: start.x, y1: start.y });
    const move = (e: PointerEvent) => {
      const point = canvasPoint(e);
      if (point)
        setToolDraft({ x0: start.x, y0: start.y, x1: point.x, y1: point.y });
    };
    const finish = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      setToolDraft(null);
      const end = canvasPoint(e) ?? start;
      const item = createPrimitivePlacement(kind, current.canvas);
      const dragged =
        Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) > 6;
      if (dragged) {
        item.x = Math.min(start.x, end.x);
        item.y = Math.min(start.y, end.y);
        item.width = Math.max(16, Math.abs(end.x - start.x));
        item.height =
          kind === "line"
            ? item.height
            : Math.max(16, Math.abs(end.y - start.y));
      } else {
        item.x = start.x - item.width / 2;
        item.y = start.y - item.height / 2;
      }
      item.x = Math.max(0, Math.min(current.canvas.width - item.width, item.x));
      item.y = Math.max(
        0,
        Math.min(current.canvas.height - item.height, item.y),
      );
      update((draft) => {
        item.layer = Math.max(0, ...draft.placements.map((x) => x.layer)) + 1;
        draft.placements.push(item);
      });
      setSelection(new Set([item.id]));
      setActiveTool(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    return true;
  };
  const rememberAssets = (assets: Asset[]) =>
    setPickedAssets((current) => [
      ...current.filter(
        (item) => !assets.some((asset) => asset.id === item.id),
      ),
      ...assets,
    ]);
  const rememberPlaylists = (playlists: Playlist[]) =>
    setPickedPlaylists((current) => [
      ...current.filter(
        (item) => !playlists.some((playlist) => playlist.id === item.id),
      ),
      ...playlists,
    ]);
  const stack = (item: LayoutPlacement) =>
    update((draft) => {
      item.layer = Math.max(0, ...draft.placements.map((x) => x.layer)) + 1;
      draft.placements.push(item);
    });
  const announceAdded = (name: string) =>
    toast.add({
      title: t("editor.addedToast", { name }),
      description: t("editor.addedToastHint"),
      type: "success",
      actionProps: { children: t("editor.menuUndo"), onClick: () => undo() },
    });
  const addContent = (asset: Asset, position?: { x: number; y: number }) => {
    if (!document) return;
    rememberAssets([asset]);
    const item = createContentPlacement(asset, document.canvas, position);
    stack(item);
    setSelection(new Set([item.id]));
    announceAdded(asset.name);
  };
  /** Adds everything chosen in one trip through the picker, cascaded so nothing hides. */
  const addContentBatch = (assets: Asset[]) => {
    const current = documentRef.current;
    if (!current || !assets.length) return;
    rememberAssets(assets);
    const created = assets.map((asset, index) => {
      const item = createContentPlacement(asset, current.canvas);
      item.x = Math.min(current.canvas.width - item.width, item.x + index * 24);
      item.y = Math.min(
        current.canvas.height - item.height,
        item.y + index * 24,
      );
      return item;
    });
    update((draft) => {
      const base = Math.max(0, ...draft.placements.map((x) => x.layer)) + 1;
      created.forEach((item, index) => {
        item.layer = base + index;
      });
      draft.placements.push(...created);
    });
    setSelection(new Set(created.map((item) => item.id)));
    announceAdded(
      assets.length === 1
        ? assets[0]!.name
        : t("editor.addedMany", { count: assets.length }),
    );
  };
  const addPlaylistZone = (
    playlist: Playlist,
    position?: { x: number; y: number },
  ) => {
    if (!document) return;
    rememberPlaylists([playlist]);
    const item = createPlaylistZonePlacement(
      playlist,
      document.canvas,
      position,
    );
    stack(item);
    setSelection(new Set([item.id]));
    announceAdded(playlist.name);
  };
  const duplicateSelection = useCallback(() => {
    const current = documentRef.current;
    if (!current) return;
    const source = selectedPlacements(current, selection);
    if (!source.length) return;
    const mapping = new Map(
      source.map((item) => [item.id, crypto.randomUUID()]),
    );
    const copies = source.map((item) => ({
      ...clone(item),
      id: mapping.get(item.id)!,
      name: `${item.name} copy`,
      x: Math.min(item.x + 20, current.canvas.width - item.width),
      y: Math.min(item.y + 20, current.canvas.height - item.height),
      groupId: item.groupId && mapping.get(item.groupId),
    }));
    update((draft) => draft.placements.push(...copies));
    setSelection(new Set(copies.map((item) => item.id)));
  }, [selection, update]);
  const groupSelection = useCallback(() => {
    if (!documentRef.current || selection.size < 2) return;
    const items = selectedPlacements(documentRef.current, selection);
    const x = Math.min(...items.map((i) => i.x)),
      y = Math.min(...items.map((i) => i.y)),
      right = Math.max(...items.map((i) => i.x + i.width)),
      bottom = Math.max(...items.map((i) => i.y + i.height));
    const group = createPrimitivePlacement("group", documentRef.current.canvas);
    group.x = x;
    group.y = y;
    group.width = right - x;
    group.height = bottom - y;
    group.name = "Group";
    group.layer = Math.max(...items.map((i) => i.layer));
    update((draft) => {
      draft.placements.push(group);
      draft.placements.forEach((item) => {
        if (selection.has(item.id)) item.groupId = group.id;
      });
    });
    setSelection(new Set([group.id]));
  }, [selection, update]);
  const ungroupSelection = useCallback(() => {
    const groups = new Set(
      selected.filter((i) => i.primitive?.kind === "group").map((i) => i.id),
    );
    if (!groups.size) return;
    update((draft) => {
      draft.placements = draft.placements.filter(
        (item) => !groups.has(item.id),
      );
      draft.placements.forEach((item) => {
        if (item.groupId && groups.has(item.groupId)) delete item.groupId;
      });
    });
    setSelection(new Set());
  }, [selected, update]);
  const deleteSelection = useCallback(() => {
    if (!selection.size) return;
    update((draft) => {
      draft.placements = draft.placements.filter(
        (item) => !selection.has(item.id),
      );
      draft.placements.forEach((item) => {
        if (item.groupId && selection.has(item.groupId)) delete item.groupId;
      });
    });
    setSelection(new Set());
  }, [selection, update]);
  const copySelection = useCallback(() => {
    if (selected.length) clipboard.current = clone(selected);
  }, [selected]);
  const pasteClipboard = useCallback(() => {
    const current = documentRef.current;
    if (!current || !clipboard.current.length) return;
    const pasted = clipboard.current.map((item) => ({
      ...clone(item),
      id: crypto.randomUUID(),
      x: Math.max(0, Math.min(item.x + 20, current.canvas.width - item.width)),
      y: Math.max(
        0,
        Math.min(item.y + 20, current.canvas.height - item.height),
      ),
      groupId: undefined,
    }));
    update((draft) => draft.placements.push(...pasted));
    setSelection(new Set(pasted.map((item) => item.id)));
  }, [update]);
  const selectAll = useCallback(() => {
    const current = documentRef.current;
    if (current)
      setSelection(new Set(current.placements.map((item) => item.id)));
  }, []);
  const arrangeSelection = useCallback(
    (mode: LayoutArrangeMode) => {
      if (!selection.size) return;
      update((draft) => arrangePlacements(draft.placements, selection, mode));
    },
    [selection, update],
  );
  // A group box already carries its children, so a selected child of a selected group
  // would otherwise be moved twice.
  const movablePlacements = useCallback(() => {
    const current = documentRef.current;
    if (!current) return [];
    return selectedPlacements(current, selection).filter(
      (item) => !item.locked && !(item.groupId && selection.has(item.groupId)),
    );
  }, [selection]);
  const alignSelection = useCallback(
    (mode: LayoutAlignMode) => {
      const current = documentRef.current;
      const items = movablePlacements();
      if (!current || !items.length) return;
      // One item aligns against the canvas; several align against their shared bounds.
      const box =
        items.length > 1
          ? {
              left: Math.min(...items.map((item) => item.x)),
              top: Math.min(...items.map((item) => item.y)),
              right: Math.max(...items.map((item) => item.x + item.width)),
              bottom: Math.max(...items.map((item) => item.y + item.height)),
            }
          : {
              left: 0,
              top: 0,
              right: current.canvas.width,
              bottom: current.canvas.height,
            };
      const moves = alignOffsets(items, box, mode);
      update((draft) => offsetPlacements(draft, moves));
    },
    [movablePlacements, update],
  );
  const distributeSelection = useCallback(
    (axis: "horizontal" | "vertical") => {
      const items = movablePlacements();
      if (items.length < 3) return;
      const moves = distributeOffsets(items, axis);
      update((draft) => offsetPlacements(draft, moves));
    },
    [movablePlacements, update],
  );
  const fillCanvas = useCallback(() => {
    update((draft) =>
      draft.placements.forEach((item) => {
        // Groups are skipped: resizing the box here would strand its children.
        if (
          !selection.has(item.id) ||
          item.locked ||
          item.primitive?.kind === "group"
        )
          return;
        item.x = 0;
        item.y = 0;
        item.width = draft.canvas.width;
        item.height = draft.canvas.height;
      }),
    );
  }, [selection, update]);
  const openRename = useCallback(
    (
      target:
        | { kind: "placement"; id: string; name: string }
        | { kind: "layout"; name: string },
    ) => {
      setRenameTarget(target);
      setRenameValue(target.name);
    },
    [],
  );
  const layoutName = layoutQuery.data?.name;
  useEditorHeaderRename(
    useCallback(
      () => openRename({ kind: "layout", name: layoutName ?? "" }),
      [openRename, layoutName],
    ),
  );
  const saveRename = useCallback(() => {
    const name = renameValue.trim();
    if (!renameTarget || !name || name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    if (renameTarget.kind === "layout") rename.mutate(name);
    else {
      const id = renameTarget.id;
      update((draft) => {
        const item = draft.placements.find((one) => one.id === id);
        if (item) item.name = name;
      });
    }
    setRenameTarget(null);
  }, [rename, renameTarget, renameValue, update]);
  const renamePlacement = useCallback(
    (target: LayoutPlacement) => {
      openRename({ kind: "placement", id: target.id, name: target.name });
    },
    [openRename],
  );
  // One switch for the whole selection rather than a per-item toggle, so a mixed
  // selection resolves to a single predictable state.
  const toggleSelectionFlag = useCallback(
    (flag: "locked" | "visible") => {
      const current = documentRef.current;
      if (!current) return;
      const items = selectedPlacements(current, selection);
      if (!items.length) return;
      const next =
        flag === "locked"
          ? !items.some((item) => item.locked)
          : !items.every((item) => item.visible);
      update((draft) =>
        draft.placements.forEach((item) => {
          if (selection.has(item.id)) item[flag] = next;
        }),
      );
    },
    [selection, update],
  );
  // Right-click target for the canvas menu. Capture-phase handlers set this
  // before the Base UI trigger opens, so the content always matches the pointer.
  const [menuTarget, setMenuTarget] = useState<LayoutMenuTarget | null>(null);
  const openPlacementMenu = (
    _event: ReactMouseEvent<HTMLElement>,
    item: LayoutPlacement,
  ) => {
    // Right-clicking outside the current selection retargets it, so the commands in the
    // menu always act on what the user just pointed at.
    if (!selection.has(item.id)) setSelection(new Set([item.id]));
    setMenuTarget({ kind: "placement", item });
  };
  const placementMenuItems = (target: LayoutPlacement): LayoutMenuEntry[] => {
    const scope = selection.has(target.id) ? selected : [target];
    const many = scope.length > 1;
    const locked = scope.some((item) => item.locked);
    const hidden = scope.some((item) => !item.visible);
    const alignable = scope.filter(
      (item) => !item.locked && !(item.groupId && selection.has(item.groupId)),
    ).length;
    return [
      {
        label: t("editor.menuRename"),
        icon: <Pencil size={14} />,
        disabled: many,
        onSelect: () => renamePlacement(target),
      },
      {
        label: t("editor.menuCopy"),
        icon: <Copy size={14} />,
        onSelect: copySelection,
      },
      {
        label: t("editor.menuPaste"),
        icon: <ClipboardPaste size={14} />,
        disabled: !clipboard.current.length,
        onSelect: pasteClipboard,
      },
      {
        label: t("editor.menuDuplicate"),
        icon: <CopyPlus size={14} />,
        onSelect: duplicateSelection,
      },
      {
        label: t("editor.menuArrange"),
        icon: <Layers size={14} />,
        separated: true,
        submenu: [
          {
            label: t("editor.menuBringToFront"),
            icon: <ArrowUpToLine size={14} />,
            onSelect: () => arrangeSelection("front"),
          },
          {
            label: t("editor.menuBringForward"),
            icon: <ArrowUp size={14} />,
            onSelect: () => arrangeSelection("forward"),
          },
          {
            label: t("editor.menuSendBackward"),
            icon: <ArrowDown size={14} />,
            onSelect: () => arrangeSelection("backward"),
          },
          {
            label: t("editor.menuSendToBack"),
            icon: <ArrowDownToLine size={14} />,
            onSelect: () => arrangeSelection("back"),
          },
        ],
      },
      {
        label: many ? t("editor.menuAlign") : t("editor.menuAlignToCanvas"),
        icon: <AlignCenterHorizontal size={14} />,
        disabled: !alignable,
        submenu: [
          {
            label: t("editor.menuAlignLeft"),
            icon: <AlignStartVertical size={14} />,
            onSelect: () => alignSelection("left"),
          },
          {
            label: t("editor.menuAlignHCenter"),
            icon: <AlignCenterVertical size={14} />,
            onSelect: () => alignSelection("hcenter"),
          },
          {
            label: t("editor.menuAlignRight"),
            icon: <AlignEndVertical size={14} />,
            onSelect: () => alignSelection("right"),
          },
          {
            label: t("editor.menuAlignTop"),
            icon: <AlignStartHorizontal size={14} />,
            separated: true,
            onSelect: () => alignSelection("top"),
          },
          {
            label: t("editor.menuAlignVCenter"),
            icon: <AlignCenterHorizontal size={14} />,
            onSelect: () => alignSelection("vmiddle"),
          },
          {
            label: t("editor.menuAlignBottom"),
            icon: <AlignEndHorizontal size={14} />,
            onSelect: () => alignSelection("bottom"),
          },
          {
            label: t("editor.menuDistributeH"),
            icon: <AlignHorizontalDistributeCenter size={14} />,
            separated: true,
            disabled: alignable < 3,
            onSelect: () => distributeSelection("horizontal"),
          },
          {
            label: t("editor.menuDistributeV"),
            icon: <AlignVerticalDistributeCenter size={14} />,
            disabled: alignable < 3,
            onSelect: () => distributeSelection("vertical"),
          },
          {
            label: t("editor.menuFillCanvas"),
            icon: <Maximize2 size={14} />,
            separated: true,
            onSelect: fillCanvas,
          },
        ],
      },
      {
        label: t("editor.menuGroup"),
        icon: <Group size={14} />,
        disabled: selection.size < 2,
        onSelect: groupSelection,
      },
      {
        label: t("editor.menuUngroup"),
        icon: <Ungroup size={14} />,
        disabled: !scope.some((item) => item.primitive?.kind === "group"),
        onSelect: ungroupSelection,
      },
      {
        label: locked ? t("editor.menuUnlock") : t("editor.menuLock"),
        icon: locked ? <LockOpen size={14} /> : <Lock size={14} />,
        separated: true,
        onSelect: () => toggleSelectionFlag("locked"),
      },
      {
        label: hidden ? t("editor.menuShow") : t("editor.menuHide"),
        icon: hidden ? <Eye size={14} /> : <EyeOff size={14} />,
        onSelect: () => toggleSelectionFlag("visible"),
      },
      {
        label: t("editor.menuLayerSettings"),
        icon: <Settings size={14} />,
        onSelect: () => setLayersOpen(true),
      },
      {
        label: many
          ? t("editor.menuDeleteCount", { count: scope.length })
          : t("editor.menuDelete"),
        icon: <Trash2 size={14} />,
        separated: true,
        danger: true,
        onSelect: deleteSelection,
      },
    ];
  };
  const canvasMenuItems = (): LayoutMenuEntry[] => [
    {
      label: t("editor.menuAddElement"),
      icon: <Plus size={14} />,
      submenu: [
        {
          label: t("elementKinds.text"),
          icon: <Type size={14} />,
          onSelect: () => addPrimitive("text"),
        },
        {
          label: t("elementKinds.rectangle"),
          icon: <RectangleHorizontal size={14} />,
          onSelect: () => addPrimitive("rectangle"),
        },
        {
          label: t("elementKinds.circle"),
          icon: <Circle size={14} />,
          onSelect: () => addPrimitive("circle"),
        },
        {
          label: t("elementKinds.line"),
          icon: <Minus size={14} />,
          onSelect: () => addPrimitive("line"),
        },
      ],
    },
    {
      label: t("editor.menuPaste"),
      icon: <ClipboardPaste size={14} />,
      disabled: !clipboard.current.length,
      onSelect: pasteClipboard,
    },
    {
      label: t("editor.menuSelectAll"),
      icon: <BoxSelect size={14} />,
      separated: true,
      disabled: !document?.placements.length,
      onSelect: selectAll,
    },
    {
      label: t("editor.menuDeselect"),
      icon: <MousePointerClick size={14} />,
      disabled: !selection.size,
      onSelect: () => setSelection(new Set()),
    },
    {
      label: t("editor.menuUndo"),
      icon: <Undo2 size={14} />,
      separated: true,
      disabled: !past.length,
      onSelect: undo,
    },
    {
      label: t("editor.menuRedo"),
      icon: <Redo2 size={14} />,
      disabled: !future.length,
      onSelect: redo,
    },
    {
      label: snap ? t("editor.menuSnapOff") : t("editor.menuSnapOn"),
      icon: <Magnet size={14} />,
      separated: true,
      onSelect: () => setSnap((value) => !value),
    },
    {
      label: safeArea
        ? t("editor.menuSafeAreaHide")
        : t("editor.menuSafeAreaShow"),
      icon: <Scan size={14} />,
      onSelect: () => setSafeArea((value) => !value),
    },
    {
      label: t("editor.sectionSettings"),
      icon: <Settings size={14} />,
      separated: true,
      onSelect: () => setSettingsOpen(true),
    },
  ];
  const beginMove = (
    event: ReactPointerEvent,
    item: LayoutPlacement,
    resize = false,
  ) => {
    if (beginPan(event)) return;
    event.stopPropagation();
    if (activeTool) {
      beginToolDraw(event);
      return;
    }
    // Right- and middle-clicks must not start a drag: their pointerup would otherwise
    // push an undo entry and mark the layout dirty without anything having moved.
    if (event.button !== 0) return;
    if (item.locked) {
      if (event.pointerType === "touch") beginPan(event, true);
      return;
    }
    event.preventDefault();
    const sourceDocument = documentRef.current;
    if (!sourceDocument || !canvasRef.current) return;
    const active = selection.has(item.id)
      ? new Set(selection)
      : new Set(event.shiftKey ? [...selection, item.id] : [item.id]);
    if (!selection.has(item.id)) setSelection(active);
    const start = { x: event.clientX, y: event.clientY };
    const initial = new Map(
      sourceDocument.placements
        .filter((p) => active.has(p.id) || p.groupId === item.id)
        .map((p) => [p.id, clone(p)]),
    );
    const beforeDocument = clone(sourceDocument);
    const bounds = canvasRef.current.getBoundingClientRect();
    let changed = false;
    const move = (pointer: PointerEvent) => {
      const current = documentRef.current;
      if (!current) return;
      const dx =
          ((pointer.clientX - start.x) * current.canvas.width) / bounds.width,
        dy =
          ((pointer.clientY - start.y) * current.canvas.height) / bounds.height;
      if (!dx && !dy) return;
      changed = true;
      const next = clone(current);
      const groupWidth = Math.max(
        20,
        Math.min(next.canvas.width - item.x, item.width + dx),
      );
      const groupHeight = Math.max(
        20,
        Math.min(next.canvas.height - item.y, item.height + dy),
      );
      next.placements.forEach((p) => {
        const before = initial.get(p.id);
        if (!before) return;
        if (resize && p.id === item.id) {
          p.width = groupWidth;
          p.height = groupHeight;
        } else if (resize && before.groupId === item.id) {
          const scaleX = groupWidth / item.width;
          const scaleY = groupHeight / item.height;
          p.x = item.x + (before.x - item.x) * scaleX;
          p.y = item.y + (before.y - item.y) * scaleY;
          p.width = before.width * scaleX;
          p.height = before.height * scaleY;
        } else {
          // Snap first, then clamp: clamping last guarantees the item stays
          // inside the canvas. Snapping after the clamp could round an
          // edge-placed item back out of bounds (fractional widths/heights
          // make canvas.width - width a non-multiple of 10), which the server
          // rejects with "bounds must fit inside the canvas" and the save fails.
          let x = before.x + dx;
          let y = before.y + dy;
          if (snap) {
            x = Math.round(x / 10) * 10;
            y = Math.round(y / 10) * 10;
          }
          p.x = Math.max(0, Math.min(next.canvas.width - p.width, x));
          p.y = Math.max(0, Math.min(next.canvas.height - p.height, y));
        }
      });
      const main = next.placements.find((p) => p.id === item.id);
      setGuides(
        main
          ? {
              x:
                Math.abs(main.x + main.width / 2 - next.canvas.width / 2) < 8
                  ? next.canvas.width / 2
                  : undefined,
              y:
                Math.abs(main.y + main.height / 2 - next.canvas.height / 2) < 8
                  ? next.canvas.height / 2
                  : undefined,
            }
          : {},
      );
      documentRef.current = next;
      setDocument(next);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      setGuides({});
      if (!changed) return;
      setPast((items) => [...items.slice(-79), beforeDocument]);
      setFuture([]);
      markUnsaved();
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      setGuides({});
      if (!changed) return;
      documentRef.current = beforeDocument;
      setDocument(beforeDocument);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
        return;
      }
      const controlCommand =
        (event.ctrlKey || event.metaKey) &&
        isEditorCommandShortcutTarget(event.target);
      if (
        event.defaultPrevented ||
        (isInteractiveShortcutTarget(event.target) && !controlCommand)
      )
        return;
      // While a context menu is up its own keys own the keyboard, so arrowing through
      // the items does not also nudge or delete the selection behind it.
      if (window.document.querySelector(".context-menu-layer")) return;
      if (event.key === "Escape" && activeToolRef.current) {
        setActiveTool(null);
        return;
      }
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        (event.key === "/" || event.key.toLowerCase() === "a") &&
        !window.document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        setAddMenuOpen(true);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        copySelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        pasteClipboard();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAll();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey) ungroupSelection();
        else groupSelection();
        return;
      }
      // The bracket shortcuts mirror the Arrange submenu, with Shift for the extremes.
      // Shift rewrites the key on most layouts, so both faces of the bracket count.
      if (event.ctrlKey || event.metaKey) {
        const forward = event.key === "]" || event.key === "}";
        const backward = event.key === "[" || event.key === "{";
        if (forward || backward) {
          event.preventDefault();
          arrangeSelection(
            event.shiftKey
              ? forward
                ? "front"
                : "back"
              : forward
                ? "forward"
                : "backward",
          );
          return;
        }
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelection();
        return;
      }
      const delta = event.shiftKey ? 10 : 1;
      if (
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        mutateSelected((item) => {
          const current = documentRef.current;
          if (!current) return;
          if (item.locked) return;
          if (event.key === "ArrowLeft") item.x = Math.max(0, item.x - delta);
          if (event.key === "ArrowRight")
            item.x = Math.min(
              current.canvas.width - item.width,
              item.x + delta,
            );
          if (event.key === "ArrowUp") item.y = Math.max(0, item.y - delta);
          if (event.key === "ArrowDown")
            item.y = Math.min(
              current.canvas.height - item.height,
              item.y + delta,
            );
        });
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    arrangeSelection,
    copySelection,
    deleteSelection,
    duplicateSelection,
    groupSelection,
    mutateSelected,
    pasteClipboard,
    redo,
    save,
    selectAll,
    undo,
    ungroupSelection,
  ]);
  if (layoutQuery.isError)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("editor.unavailableTitle")}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="secondary" onClick={() => void navigate("/layouts")}>
            {t("editor.unavailableBack")}
          </Button>
        </EmptyContent>
      </Empty>
    );
  if (layoutQuery.isLoading || !document)
    return (
      <div
        className="grid gap-3"
        aria-busy="true"
        aria-label={t("editor.loadingLabel")}
      >
        <Skeleton className="h-12" />
        <Skeleton className="h-[60vh]" />
      </div>
    );
  const libraryAssets = [...(contentQuery.data?.items ?? []), ...pickedAssets];
  const libraryPlaylists = [
    ...(playlistsQuery.data?.items ?? []),
    ...pickedPlaylists,
  ];
  const contentByID = new Map(
    libraryAssets.map((asset) => [asset.id, asset] as const),
  );
  const playlistByID = new Map(
    libraryPlaylists.map((playlist) => [playlist.id, playlist] as const),
  );
  const dataSources = dataSourcesQuery.data?.items ?? [];
  const addLibraryItem = (
    item: LayoutLibraryItem,
    position?: { x: number; y: number },
  ) => {
    if (item.kind === "asset") addContent(item.asset, position);
    else addPlaylistZone(item.playlist, position);
  };

  const dropLibraryItem = (event: ReactDragEvent<HTMLDivElement>) => {
    const serialized = event.dataTransfer.getData(
      "application/x-tilecast-layout-library",
    );
    if (!serialized || !document || !canvasRef.current) return;
    event.preventDefault();
    let reference: { kind: LayoutLibraryItem["kind"]; id: string };
    try {
      reference = JSON.parse(serialized) as typeof reference;
    } catch {
      return;
    }
    const item = recentLibraryItems.find((candidate) =>
      candidate.kind === "asset"
        ? reference.kind === "asset" && candidate.asset.id === reference.id
        : reference.kind === "playlist" &&
          candidate.playlist.id === reference.id,
    );
    if (!item) return;
    const bounds = canvasRef.current.getBoundingClientRect();
    addLibraryItem(item, {
      x: ((event.clientX - bounds.left) / bounds.width) * document.canvas.width,
      y:
        ((event.clientY - bounds.top) / bounds.height) * document.canvas.height,
    });
  };
  const openPreview = () => {
    if (nativePresentations) {
      // Save first, as the popup does, so the preview shows this draft.
      void (async () => {
        if (!(await save())) return;
        await openNativePresentation({
          path:
            presentationPath("layout-preview", id) +
            "?date=" +
            encodeURIComponent(new Date().toISOString().slice(0, 10)),
          title: t("layouts:editor.previewTitle", {
            name: layoutQuery.data?.name ?? "",
          }),
          size: "full",
        });
      })();
      return;
    }
    const popup = window.open(
      "about:blank",
      "tilecast-layout-preview-" + id,
      "popup=yes,width=1280,height=800,resizable=yes,scrollbars=no",
    );
    if (!popup) return;
    popup.opener = null;
    void (async () => {
      const saved = await save();
      if (!saved) {
        popup.close();
        return;
      }
      const date = new Date().toISOString().slice(0, 10);
      popup.location.replace(
        "/layouts/" +
          encodeURIComponent(id) +
          "/preview?date=" +
          encodeURIComponent(date),
      );
      popup.focus();
    })();
  };
  const openHistory = () => {
    setHistoryOpen(true);
    void revisions.refetch();
  };
  const layoutUsage = layoutQuery.data && (
    <UsedByPanel
      emptyMessage={t("editor.usageEmpty")}
      groups={[
        {
          label: t("editor.usageScreens"),
          items: layoutQuery.data.usage.screens,
          to: (screenId) => `/screens/${screenId}`,
        },
        {
          label: t("editor.usageSchedules"),
          items: layoutQuery.data.usage.schedules,
          to: (scheduleId) => `/schedules/${scheduleId}`,
        },
        {
          label: t("editor.usageCampaigns"),
          items: layoutQuery.data.usage.campaigns,
          to: (campaignId) => `/campaigns/${campaignId}`,
        },
      ]}
    />
  );
  const placementInspector = primary && (
    <PlacementInspector
      item={primary}
      content={
        primary.widgetId
          ? contentByID.get(primary.widgetId)
          : primary.assetId
            ? contentByID.get(primary.assetId)
            : undefined
      }
      playlist={
        primary.playlistId ? playlistByID.get(primary.playlistId) : undefined
      }
      dataSources={dataSources}
      update={(change) => mutateSelected(change)}
      duplicate={duplicateSelection}
      group={groupSelection}
      ungroup={ungroupSelection}
      canGroup={selection.size > 1}
    />
  );
  const layoutSettings = (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-3">
      <CanvasInspector document={document} update={update} />
      {layoutUsage && (
        <>
          <Separator />
          {layoutUsage}
        </>
      )}
    </div>
  );
  const layersPanel = (
    <>
      <LayoutPaneHeading
        title={t("editor.sectionLayers")}
        meta={String(document.placements.length)}
      />
      <ItemGroup className="gap-0.5 p-2" aria-label={t("editor.sectionLayers")}>
        {[...document.placements]
          .sort((a, b) => b.layer - a.layer)
          .map((item) => (
            <ContextMenu key={item.id}>
              <ContextMenuTrigger
                render={
                  <Item
                    role="listitem"
                    size="xs"
                    variant={selection.has(item.id) ? "muted" : "default"}
                    data-layer-row={item.id}
                    className="flex-nowrap gap-1 py-1 pr-1 hover:bg-muted/50 data-[variant=muted]:border-border"
                    onContextMenu={(event) => openPlacementMenu(event, item)}
                  />
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-w-0 flex-1 justify-start gap-2 px-1.5 font-normal"
                  aria-pressed={selection.has(item.id)}
                  onClick={(event) =>
                    setSelection(
                      new Set(
                        event.shiftKey ? [...selection, item.id] : [item.id],
                      ),
                    )
                  }
                >
                  {item.primitive?.kind === "text" ? (
                    <Type aria-hidden="true" />
                  ) : item.primitive?.kind === "group" ? (
                    <Group aria-hidden="true" />
                  ) : (
                    <BoxSelect aria-hidden="true" />
                  )}
                  <span className="truncate">{item.name}</span>
                </Button>
                <ItemActions className="gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={
                      item.visible
                        ? t("editor.layerHide", { name: item.name })
                        : t("editor.layerShow", { name: item.name })
                    }
                    aria-pressed={item.visible}
                    title={
                      item.visible ? t("editor.menuHide") : t("editor.menuShow")
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      update((d) => {
                        const target = d.placements.find(
                          (x) => x.id === item.id,
                        );
                        if (target) target.visible = !target.visible;
                      });
                    }}
                  >
                    {item.visible ? (
                      <Eye aria-hidden="true" />
                    ) : (
                      <EyeOff aria-hidden="true" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={
                      item.locked
                        ? t("editor.layerUnlock", { name: item.name })
                        : t("editor.layerLock", { name: item.name })
                    }
                    aria-pressed={item.locked}
                    title={
                      item.locked
                        ? t("editor.menuUnlock")
                        : t("editor.menuLock")
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      update((d) => {
                        const target = d.placements.find(
                          (x) => x.id === item.id,
                        );
                        if (target) target.locked = !target.locked;
                      });
                    }}
                  >
                    {item.locked ? (
                      <Lock aria-hidden="true" />
                    ) : (
                      <LockOpen aria-hidden="true" />
                    )}
                  </Button>
                </ItemActions>
              </ContextMenuTrigger>
              <ContextMenuContent
                aria-label={t("editor.layerActions", { name: item.name })}
              >
                <LayoutEditorMenuEntries items={placementMenuItems(item)} />
              </ContextMenuContent>
            </ContextMenu>
          ))}
      </ItemGroup>
      {!document.placements.length && (
        <Empty className="m-3 border border-dashed p-4 md:p-4">
          <EmptyHeader>
            <EmptyDescription className="text-xs">
              {t("editor.layersEmpty")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );

  const selectionBox = selected.length
    ? {
        x: Math.min(...selected.map((item) => item.x)),
        y: Math.min(...selected.map((item) => item.y)),
        right: Math.max(...selected.map((item) => item.x + item.width)),
        bottom: Math.max(...selected.map((item) => item.y + item.height)),
      }
    : undefined;
  const placementIcon = (item: LayoutPlacement) =>
    item.primitive?.kind === "text" ? (
      <Type aria-hidden="true" />
    ) : item.primitive?.kind === "group" ? (
      <Group aria-hidden="true" />
    ) : item.widgetId ? (
      <AppWindow aria-hidden="true" />
    ) : item.playlistId ? (
      <ListVideo aria-hidden="true" />
    ) : item.assetId ? (
      <ImageIcon aria-hidden="true" />
    ) : (
      <BoxSelect aria-hidden="true" />
    );
  const openChooser = (kind: "media" | "widgets" | "playlists") => {
    setAddMenuOpen(false);
    setPicker(kind);
    setPickerOpen(true);
  };
  const armTool = (kind: LayoutPrimitive["kind"]) => {
    setAddMenuOpen(false);
    setSelection(new Set());
    setActiveTool(kind);
    window.requestAnimationFrame(() => {
      canvasRef.current
        ?.closest<HTMLElement>(".layout-stage-scroll")
        ?.focus({ preventScroll: true });
    });
  };
  const dockButtonClass = "size-9 rounded-md text-muted-foreground";
  const addMenu = (
    <Popover
      open={addMenuOpen}
      onOpenChange={(open) => {
        setAddMenuOpen(open);
        if (!open) setAddMenuQuery("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon"
            className={cn(
              "size-9 rounded-md",
              addMenuOpen && "ring-3 ring-foreground/20",
            )}
            aria-label={t("editor.addTitle")}
            title={t("editor.addTitle")}
            aria-keyshortcuts="A /"
          />
        }
      >
        <Plus
          aria-hidden="true"
          className={cn(
            "transition-transform duration-(--tc-motion-standard) ease-(--tc-ease-standard) motion-reduce:transition-none",
            addMenuOpen && "rotate-45",
          )}
        />
      </PopoverTrigger>
      <PopoverContent
        side={desktop ? "right" : "bottom"}
        align="start"
        sideOffset={8}
        aria-label={t("editor.addTitle")}
        className="w-[min(18.75rem,calc(100vw-2rem))] gap-0 rounded-xl p-1"
      >
        <Command>
          <CommandInput
            autoFocus
            value={addMenuQuery}
            onValueChange={setAddMenuQuery}
            placeholder={t("editor.addPlaceholder")}
          />
          <CommandList className="max-h-96">
            <CommandEmpty>{t("editor.addEmpty")}</CommandEmpty>
            <CommandGroup heading={t("editor.addGroupContent")}>
              {(
                [
                  [
                    "media",
                    t("editor.addMedia"),
                    t("editor.addMediaHint"),
                    ImageIcon,
                  ],
                  [
                    "widgets",
                    t("editor.addWidget"),
                    t("editor.addWidgetHint"),
                    Blocks,
                  ],
                  [
                    "playlists",
                    t("editor.addPlaylist"),
                    t("editor.addPlaylistHint"),
                    ListVideo,
                  ],
                ] as const
              ).map(([kind, label, hint, Icon]) => (
                <CommandItem
                  key={kind}
                  value={`${label} ${hint}`}
                  onSelect={() => openChooser(kind)}
                >
                  <Icon aria-hidden="true" />
                  {label}
                  <CommandShortcut className="tracking-normal">
                    {hint}
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
            {recentLibraryItems.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup
                  heading={`${t("editor.shelfRecent")} · ${t("editor.addRecentHint")}`}
                >
                  {recentLibraryItems.map((item) => {
                    const asset =
                      item.kind === "asset" ? item.asset : undefined;
                    const playlist =
                      item.kind === "playlist" ? item.playlist : undefined;
                    const name = asset?.name ?? playlist?.name ?? "";
                    return (
                      <CommandItem
                        key={`${item.kind}-${asset?.id ?? playlist?.id}`}
                        value={`${name} ${asset?.type ?? "playlist"}`}
                        draggable
                        title={t("editor.shelfAdd", { name })}
                        onDragStart={(
                          event: ReactDragEvent<HTMLDivElement>,
                        ) => {
                          event.dataTransfer.effectAllowed = "copy";
                          event.dataTransfer.setData(
                            "application/x-tilecast-layout-library",
                            JSON.stringify({
                              kind: item.kind,
                              id: asset?.id ?? playlist?.id,
                            }),
                          );
                        }}
                        onSelect={() => {
                          setAddMenuOpen(false);
                          addLibraryItem(item);
                        }}
                        className="h-10"
                      >
                        <span className="flex h-6.5 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm border bg-muted text-muted-foreground">
                          {asset?.thumbnailUrl ? (
                            <img
                              src={asset.thumbnailUrl}
                              alt=""
                              draggable={false}
                              className="size-full object-cover"
                            />
                          ) : asset?.type === "widget" ? (
                            <AppWindow aria-hidden="true" />
                          ) : playlist ? (
                            <ListVideo aria-hidden="true" />
                          ) : (
                            <ImageIcon aria-hidden="true" />
                          )}
                        </span>
                        <span className="grid min-w-0 flex-1 gap-0 leading-tight">
                          <span className="truncate text-sm font-medium">
                            {name}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {playlist
                              ? t("common:count.items", {
                                  count: playlist.itemCount,
                                })
                              : asset?.type === "widget"
                                ? t("editor.recentWidget")
                                : asset?.type === "video"
                                  ? tContent("media.type.video")
                                  : tContent("media.type.image")}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
            <CommandSeparator />
            <CommandGroup className="**:[[cmdk-group-items]]:grid **:[[cmdk-group-items]]:grid-cols-4 **:[[cmdk-group-items]]:gap-0.5">
              {(
                [
                  ["text", t("elementKinds.text"), Type],
                  [
                    "rectangle",
                    t("elementKinds.rectangle"),
                    RectangleHorizontal,
                  ],
                  ["circle", t("elementKinds.circle"), Circle],
                  ["line", t("elementKinds.line"), Minus],
                ] as const
              ).map(([kind, label, Icon]) => (
                <CommandItem
                  key={kind}
                  value={`${label} tool shape`}
                  onSelect={() => armTool(kind)}
                  className="flex-col gap-1 py-2 text-xs font-medium"
                >
                  <Icon aria-hidden="true" />
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
  const dock = (
    <div
      role="toolbar"
      aria-label={t("editor.dockLabel")}
      aria-orientation={desktop ? "vertical" : "horizontal"}
      className={cn(
        "absolute top-3 left-3 z-20 flex gap-0.5 rounded-xl border bg-card p-1 shadow-md",
        desktop ? "flex-col" : "flex-row",
      )}
    >
      {addMenu}
      {desktop ? (
        <Popover open={layersOpen} onOpenChange={setLayersOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(dockButtonClass, layersOpen && "bg-muted")}
                aria-label={t("editor.sectionLayers")}
                title={t("editor.sectionLayers")}
              />
            }
          >
            <Layers aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="start"
            sideOffset={8}
            aria-label={t("editor.sectionLayers")}
            className="max-h-[70vh] w-72 gap-0 overflow-y-auto p-0"
          >
            {layersPanel}
          </PopoverContent>
        </Popover>
      ) : (
        <Sheet open={layersOpen} onOpenChange={setLayersOpen}>
          <SheetTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(dockButtonClass, layersOpen && "bg-muted")}
                aria-label={t("editor.sectionLayers")}
                title={t("editor.sectionLayers")}
              />
            }
          >
            <Layers aria-hidden="true" />
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-[min(20rem,88vw)] gap-0 overflow-y-auto"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{t("editor.sectionLayers")}</SheetTitle>
            </SheetHeader>
            {layersPanel}
          </SheetContent>
        </Sheet>
      )}
      {desktop && <Separator className="my-0.5" />}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(dockButtonClass, activeTool === "text" && "bg-muted")}
        aria-label={t("elementKinds.text")}
        aria-pressed={activeTool === "text"}
        title={t("elementKinds.text")}
        onClick={() =>
          activeTool === "text" ? setActiveTool(null) : armTool("text")
        }
      >
        <Type aria-hidden="true" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                dockButtonClass,
                activeTool && activeTool !== "text" && "bg-muted",
              )}
              aria-label={t("editor.dockShape")}
              title={t("editor.dockShape")}
            />
          }
        >
          <Square aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" sideOffset={8}>
          <DropdownMenuItem onClick={() => armTool("rectangle")}>
            <RectangleHorizontal aria-hidden="true" />
            {t("elementKinds.rectangle")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => armTool("circle")}>
            <Circle aria-hidden="true" />
            {t("elementKinds.circle")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => armTool("line")}>
            <Minus aria-hidden="true" />
            {t("elementKinds.line")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(dockButtonClass, settingsOpen && "bg-muted")}
        aria-label={t("editor.sectionSettings")}
        aria-pressed={settingsOpen}
        title={t("editor.sectionSettings")}
        onClick={() => {
          setSelection(new Set());
          if (desktop) {
            setSettingsOpen((open) => !open);
          } else {
            setSettingsOpen(true);
            setMobileInspectorOpen(true);
          }
        }}
      >
        <MonitorCog aria-hidden="true" />
      </Button>
    </div>
  );
  const inspectorCard = desktop && (primary || settingsOpen) && (
    <aside
      aria-label={
        primary ? t("editor.panesInspector") : t("editor.sectionSettings")
      }
      className="absolute top-3 right-3 z-20 flex max-h-[calc(100%-24px)] w-70 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-md"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {primary
            ? t("editor.panesInspectorTitle")
            : t("editor.sectionSettings")}
        </h2>
        {primary && (
          <Badge variant="secondary">
            {t("editor.selectedCount", { count: selected.length })}
          </Badge>
        )}
        {primary ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-expanded={!inspectorCollapsed}
            aria-label={
              inspectorCollapsed
                ? t("editor.inspectorExpand")
                : t("editor.inspectorCollapse")
            }
            onClick={() => setInspectorCollapsed((value) => !value)}
          >
            {inspectorCollapsed ? (
              <ChevronDown aria-hidden="true" />
            ) : (
              <ChevronUp aria-hidden="true" />
            )}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("common:actions.close")}
            onClick={() => setSettingsOpen(false)}
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </div>
      {!(primary && inspectorCollapsed) && (
        <div className="min-h-0 overflow-y-auto border-t">
          {primary ? (
            <div className="p-3">{placementInspector}</div>
          ) : (
            layoutSettings
          )}
        </div>
      )}
    </aside>
  );
  const mobileInspectorSheet = !desktop && (primary || settingsOpen) && (
    <Sheet
      open={mobileInspectorOpen}
      onOpenChange={(open) => {
        setMobileInspectorOpen(open);
        if (!open && settingsOpen) setSettingsOpen(false);
      }}
    >
      <SheetContent
        side="bottom"
        className="max-h-[78dvh] gap-0 overflow-hidden rounded-t-xl"
      >
        <SheetHeader className="border-b">
          <SheetTitle className="flex min-w-0 items-center gap-2">
            <span className="truncate">
              {primary
                ? t("editor.panesInspectorTitle")
                : t("editor.sectionSettings")}
            </span>
            {primary && (
              <Badge variant="secondary">
                {t("editor.selectedCount", { count: selected.length })}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>
        <div className="min-h-0 overflow-y-auto">
          {primary ? (
            <div className="p-3">{placementInspector}</div>
          ) : (
            layoutSettings
          )}
        </div>
      </SheetContent>
    </Sheet>
  );

  const selectionOverlay = selectionBox && !activeTool && (
    <div className="pointer-events-none absolute inset-0 z-[1000]">
      <div
        role="toolbar"
        aria-label={t("editor.selectionToolbar")}
        className={cn(
          "pointer-events-auto absolute -translate-x-1/2",
          !desktop && "bottom-14 left-1/2",
        )}
        style={
          desktop
            ? {
                left:
                  ((selectionBox.x + selectionBox.right) / 2) * view.zoom +
                  view.panX,
                top: Math.max(8, selectionBox.y * view.zoom + view.panY - 48),
              }
            : undefined
        }
        onPointerDown={(event) => event.stopPropagation()}
      >
        <ButtonGroup
          className={cn(
            "rounded-lg bg-background shadow-md",
            !desktop && "hidden",
          )}
        >
          <ButtonGroupText className="max-w-40 gap-1.5 bg-background">
            {primary && placementIcon(primary)}
            <span className="truncate">
              {selected.length > 1
                ? t("editor.selectedCount", { count: selected.length })
                : primary?.name}
            </span>
          </ButtonGroupText>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("editor.toolbarCenter")}
            title={t("editor.toolbarCenter")}
            onClick={() =>
              mutateSelected((item) => {
                if (!item.locked)
                  item.x = (document.canvas.width - item.width) / 2;
              })
            }
          >
            <AlignCenterVertical aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("editor.toolbarFront")}
            title={t("editor.toolbarFront")}
            onClick={() => arrangeSelection("front")}
          >
            <ArrowUpToLine aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("editor.menuDuplicate")}
            title={t("editor.menuDuplicate")}
            onClick={duplicateSelection}
          >
            <Copy aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={
              primary?.locked ? t("editor.menuUnlock") : t("editor.menuLock")
            }
            title={
              primary?.locked ? t("editor.menuUnlock") : t("editor.menuLock")
            }
            aria-pressed={primary?.locked}
            onClick={() => toggleSelectionFlag("locked")}
          >
            {primary?.locked ? (
              <Lock aria-hidden="true" />
            ) : (
              <LockOpen aria-hidden="true" />
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="text-destructive"
            aria-label={t("editor.menuDelete")}
            title={t("editor.menuDelete")}
            onClick={deleteSelection}
          >
            <Trash2 aria-hidden="true" />
          </Button>
          {primary && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("editor.toolbarMore")}
                    title={t("editor.toolbarMore")}
                  />
                }
              >
                <Ellipsis aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {placementMenuItems(primary).map((entry, index) =>
                  entry.submenu ? null : (
                    <Fragment key={`${entry.label}-${index}`}>
                      {entry.separated && <DropdownMenuSeparator />}
                      <DropdownMenuItem
                        variant={entry.danger ? "destructive" : "default"}
                        disabled={entry.disabled}
                        onClick={entry.onSelect}
                      >
                        {entry.icon}
                        {entry.label}
                      </DropdownMenuItem>
                    </Fragment>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </ButtonGroup>
        {!desktop && (
          <ButtonGroup className="rounded-lg bg-background shadow-md">
            <ButtonGroupText className="max-w-28 gap-1.5 bg-background">
              {primary && placementIcon(primary)}
              <span className="truncate">
                {selected.length > 1
                  ? t("editor.selectedCount", { count: selected.length })
                  : primary?.name}
              </span>
            </ButtonGroupText>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("editor.panesInspectorTitle")}
              title={t("editor.panesInspectorTitle")}
              onClick={() => setMobileInspectorOpen(true)}
            >
              <Settings aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t("editor.menuDuplicate")}
              title={t("editor.menuDuplicate")}
              onClick={duplicateSelection}
            >
              <Copy aria-hidden="true" />
            </Button>
            {primary && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={t("editor.toolbarMore")}
                      title={t("editor.toolbarMore")}
                    />
                  }
                >
                  <Ellipsis aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  {placementMenuItems(primary).map((entry, index) =>
                    entry.submenu ? null : (
                      <Fragment key={`${entry.label}-mobile-${index}`}>
                        {entry.separated && <DropdownMenuSeparator />}
                        <DropdownMenuItem
                          variant={entry.danger ? "destructive" : "default"}
                          disabled={entry.disabled}
                          onClick={entry.onSelect}
                        >
                          {entry.icon}
                          {entry.label}
                        </DropdownMenuItem>
                      </Fragment>
                    ),
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </ButtonGroup>
        )}
      </div>
      <span
        className="absolute -translate-x-1/2 rounded-sm bg-blue-500 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-white"
        style={{
          left:
            ((selectionBox.x + selectionBox.right) / 2) * view.zoom + view.panX,
          top: selectionBox.bottom * view.zoom + view.panY + 8,
        }}
      >
        {Math.round(selectionBox.right - selectionBox.x)} ×{" "}
        {Math.round(selectionBox.bottom - selectionBox.y)}
      </span>
    </div>
  );
  const draftBox = toolDraft && (
    <div
      className="pointer-events-none absolute z-[1000] border border-blue-500 bg-blue-500/10"
      style={{
        left: `${(Math.min(toolDraft.x0, toolDraft.x1) / document.canvas.width) * 100}%`,
        top: `${(Math.min(toolDraft.y0, toolDraft.y1) / document.canvas.height) * 100}%`,
        width: `${(Math.abs(toolDraft.x1 - toolDraft.x0) / document.canvas.width) * 100}%`,
        height: `${(Math.abs(toolDraft.y1 - toolDraft.y0) / document.canvas.height) * 100}%`,
      }}
    />
  );

  const stage = (
    <main className="layout-stage">
      {dock}
      {inspectorCard}
      {mobileInspectorSheet}
      {activeTool && (
        <div
          role="status"
          className={cn(
            "absolute left-1/2 z-20 -translate-x-1/2 rounded-md border bg-card px-3 py-1.5 text-sm shadow-md",
            desktop ? "top-3" : "top-16",
          )}
        >
          {t("editor.toolArmed")}
        </div>
      )}
      <div
        className={cn(
          "absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2",
          !desktop && "hidden",
        )}
      >
        <ButtonGroup aria-label={t("editor.zoomLabel")}>
          <Button
            variant="outline"
            size="sm"
            onClick={zoomOut}
            title={t("editor.zoomOut")}
            aria-label={t("editor.zoomOut")}
          >
            <ZoomOut size={16} aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="w-16 tabular-nums"
                  aria-label={t("editor.zoomPresets")}
                  title={t("editor.zoomPresets")}
                />
              }
            >
              <span aria-live="polite">{Math.round(zoom * 100)}%</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center" className="min-w-32">
              <DropdownMenuItem onClick={() => fitZoom()}>
                {t("editor.zoomFit")}
              </DropdownMenuItem>
              {[0.5, 1, 2].map((preset) => (
                <DropdownMenuItem key={preset} onClick={() => zoomTo(preset)}>
                  {Math.round(preset * 100)}%
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            onClick={zoomIn}
            title={t("editor.zoomIn")}
            aria-label={t("editor.zoomIn")}
          >
            <ZoomIn size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fitZoom()}
            title={t("editor.zoomFit")}
            aria-label={t("editor.zoomFit")}
          >
            <Scan size={16} aria-hidden="true" />
          </Button>
        </ButtonGroup>
        <div className="flex items-center gap-1">
          {(
            [
              [
                "snap",
                snap,
                setSnap,
                t("editor.snapLabel"),
                t(snap ? "editor.snapOn" : "editor.snapOff"),
                Magnet,
              ],
              [
                "safe-area",
                safeArea,
                setSafeArea,
                t("editor.safeAreaLabel"),
                t(safeArea ? "editor.safeAreaOn" : "editor.safeAreaOff"),
                SquareDashed,
              ],
            ] as const
          ).map(([key, pressed, setPressed, label, state, Icon]) => (
            <Tooltip key={key}>
              <TooltipTrigger
                render={
                  <Toggle
                    variant="outline"
                    size="sm"
                    pressed={pressed}
                    onPressedChange={setPressed}
                    className="border-input bg-background text-muted-foreground shadow-xs hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground"
                  />
                }
              >
                <Icon
                  aria-hidden="true"
                  className={cn(!pressed && "opacity-50")}
                />
                {label}
              </TooltipTrigger>
              <TooltipContent>{state}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("editor.shortcutsTitle")}
                aria-label={t("editor.shortcutsTitle")}
              >
                <Keyboard size={16} aria-hidden="true" />
              </Button>
            }
          />
          <PopoverContent
            side="bottom"
            align="center"
            aria-label={t("editor.shortcutsDialogLabel")}
          >
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("editor.shortcutsTitle")}
            </p>
            <ul className="grid gap-2 text-sm">
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.shortcutSave")}</span>
                <span className="flex items-center gap-1">
                  <Kbd>{/* i18n-ignore: key name */}Ctrl/⌘</Kbd>
                  <Kbd>{/* i18n-ignore: key name */}S</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.shortcutUndoRedo")}</span>
                <span className="flex items-center gap-1">
                  <Kbd>{/* i18n-ignore: key name */}Ctrl/⌘</Kbd>
                  <Kbd>{/* i18n-ignore: key name */}Z</Kbd>
                  <Kbd>⇧</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.menuDuplicate")}</span>
                <span className="flex items-center gap-1">
                  <Kbd>{/* i18n-ignore: key name */}Ctrl/⌘</Kbd>
                  <Kbd>{/* i18n-ignore: key name */}D</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.shortcutCopyPaste")}</span>
                <span className="flex items-center gap-1">
                  <Kbd>{/* i18n-ignore: key name */}Ctrl/⌘</Kbd>
                  <Kbd>{/* i18n-ignore: key name */}C</Kbd>
                  <Kbd>{/* i18n-ignore: key name */}V</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.menuSelectAll")}</span>
                <span className="flex items-center gap-1">
                  <Kbd>{/* i18n-ignore: key name */}Ctrl/⌘</Kbd>
                  <Kbd>{/* i18n-ignore: key name */}A</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.shortcutGroup")}</span>
                <span className="flex items-center gap-1">
                  <Kbd>{/* i18n-ignore: key name */}Ctrl/⌘</Kbd>
                  <Kbd>{/* i18n-ignore: key name */}G</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.shortcutArrange")}</span>
                <span className="flex items-center gap-1">
                  <Kbd>{/* i18n-ignore: key name */}Ctrl/⌘</Kbd>
                  <Kbd>[</Kbd>
                  <Kbd>]</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.shortcutDelete")}</span>
                <Kbd>{/* i18n-ignore: key name */}Del</Kbd>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>{t("editor.shortcutNudge")}</span>
                <Kbd>← ↑ ↓ →</Kbd>
              </li>
            </ul>
          </PopoverContent>
        </Popover>
      </div>
      {!desktop && (
        <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
          <ButtonGroup aria-label={t("editor.zoomLabel")}>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-16 tabular-nums"
                    aria-label={t("editor.zoomPresets")}
                    title={t("editor.zoomPresets")}
                  />
                }
              >
                <span aria-live="polite">{Math.round(zoom * 100)}%</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="center"
                className="min-w-32"
              >
                <DropdownMenuItem onClick={() => fitZoom()}>
                  {t("editor.zoomFit")}
                </DropdownMenuItem>
                {[0.5, 1, 2].map((preset) => (
                  <DropdownMenuItem key={preset} onClick={() => zoomTo(preset)}>
                    {Math.round(preset * 100)}%
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fitZoom()}
              title={t("editor.zoomFit")}
              aria-label={t("editor.zoomFit")}
            >
              <Scan size={16} aria-hidden="true" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("editor.toolbarMore")}
                    title={t("editor.toolbarMore")}
                  />
                }
              >
                <Ellipsis aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="min-w-44">
                <DropdownMenuItem onClick={() => setSnap((value) => !value)}>
                  <Magnet aria-hidden="true" />
                  {t("editor.snapLabel")}:{" "}
                  {t(snap ? "editor.snapOn" : "editor.snapOff")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => setSafeArea((value) => !value)}
                >
                  <SquareDashed aria-hidden="true" />
                  {t("editor.safeAreaLabel")}:{" "}
                  {t(safeArea ? "editor.safeAreaOn" : "editor.safeAreaOff")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>
      )}
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              tabIndex={-1}
              className={cn(
                "layout-stage-scroll",
                activeTool && "cursor-crosshair",
                panMode === "ready" && "cursor-grab",
                panMode === "dragging" && "cursor-grabbing",
              )}
              onPointerDown={(event) => {
                if (beginPan(event, true)) return;
                if (activeTool) {
                  beginToolDraw(event);
                  return;
                }
                if (event.button === 0) setSelection(new Set());
              }}
              onContextMenuCapture={() => setMenuTarget({ kind: "canvas" })}
            />
          }
        >
          <div
            ref={worldRef}
            className="absolute top-0 left-0 will-change-transform"
            style={
              {
                width: document.canvas.width,
                height: document.canvas.height,
                transform: `translate(${viewRef.current.panX}px, ${viewRef.current.panY}px) scale(${viewRef.current.zoom})`,
                transformOrigin: "0 0",
                "--tc-zoom": viewRef.current.zoom,
              } as React.CSSProperties
            }
          >
            <div
              ref={canvasRef}
              className="layout-canvas"
              onDragOver={(event) => {
                if (
                  event.dataTransfer.types.includes(
                    "application/x-tilecast-layout-library",
                  )
                ) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }
              }}
              onDrop={(event) => {
                setAddMenuOpen(false);
                dropLibraryItem(event);
              }}
              style={{
                width: "100%",
                height: "100%",
                backgroundColor: document.canvas.backgroundColor,
              }}
            >
              {document.canvas.backgroundAssetId &&
                contentByID.get(document.canvas.backgroundAssetId)?.type ===
                  "image" && (
                  <img
                    className="layout-preview-background"
                    src={api.assetPreviewUrl(document.canvas.backgroundAssetId)}
                    alt=""
                    draggable={false}
                  />
                )}
              {safeArea && (
                <div
                  className="layout-safe-area"
                  style={{ inset: `${document.canvas.safeAreaPercent}%` }}
                />
              )}
              {guides.x !== undefined && (
                <span
                  className="layout-guide layout-guide--vertical"
                  style={{
                    left: `${(guides.x / document.canvas.width) * 100}%`,
                  }}
                />
              )}
              {guides.y !== undefined && (
                <span
                  className="layout-guide layout-guide--horizontal"
                  style={{
                    top: `${(guides.y / document.canvas.height) * 100}%`,
                  }}
                />
              )}
              {[...document.placements]
                .sort((a, b) => a.layer - b.layer)
                .map((item) => (
                  <PlacementView
                    key={item.id}
                    item={item}
                    content={
                      item.widgetId
                        ? contentByID.get(item.widgetId)
                        : item.assetId
                          ? contentByID.get(item.assetId)
                          : undefined
                    }
                    playlist={
                      item.playlistId
                        ? playlistByID.get(item.playlistId)
                        : undefined
                    }
                    assetsById={contentByID}
                    canvas={document.canvas}
                    captureCoordinator={captureCoordinator}
                    selected={selection.has(item.id)}
                    onPointerDown={(event) => beginMove(event, item)}
                    onResize={(event) => beginMove(event, item, true)}
                    onContextMenu={(event) => openPlacementMenu(event, item)}
                  />
                ))}
            </div>
            {draftBox}
          </div>
          {selectionOverlay}
        </ContextMenuTrigger>
        <ContextMenuContent
          aria-label={
            menuTarget?.kind === "placement"
              ? t("editor.layerActions", { name: menuTarget.item.name })
              : t("editor.menuCanvasActions")
          }
        >
          <LayoutEditorMenuEntries
            items={
              menuTarget?.kind === "placement"
                ? placementMenuItems(menuTarget.item)
                : canvasMenuItems()
            }
          />
        </ContextMenuContent>
      </ContextMenu>
    </main>
  );

  return (
    <div className="layout-editor">
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              saveRename();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {renameTarget?.kind === "layout"
                  ? t("editor.renameLayoutTitle")
                  : t("editor.renameLayerTitle")}
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <Field className="gap-1.5">
                <FieldLabel
                  htmlFor="rename-target-name"
                  className="text-sm font-medium"
                >
                  {t("editor.renameNameLabel")}
                </FieldLabel>
                <Input
                  id="rename-target-name"
                  value={renameValue}
                  autoFocus
                  maxLength={120}
                  onChange={(event) => setRenameValue(event.target.value)}
                />
              </Field>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setRenameTarget(null)}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={!renameValue.trim() || rename.isPending}
              >
                {renameTarget?.kind === "layout" && rename.isPending
                  ? t("editor.renameSubmitting")
                  : t("editor.renameSubmit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <EditorHeaderPortal
        left={
          <>
            <div className="flex shrink-0 items-center gap-2">
              {desktop ? (
                <Menubar
                  aria-label={t("editor.menubar.label")}
                  className="shrink-0"
                >
                  <MenubarMenu>
                    <MenubarTrigger ref={fileMenuTrigger}>
                      {t("editor.menubar.file")}
                    </MenubarTrigger>
                    <MenubarContent className="min-w-52">
                      <MenubarItem
                        disabled={rename.isPending}
                        onClick={() =>
                          openRename({
                            kind: "layout",
                            name: layoutQuery.data?.name ?? "",
                          })
                        }
                      >
                        <Pencil aria-hidden="true" />
                        {t("editor.menubar.renameLayout")}
                      </MenubarItem>
                      <MenubarItem
                        disabled={
                          saveState === "saved" ||
                          saveState === "saving" ||
                          saveState === "conflict"
                        }
                        onClick={() => void save()}
                      >
                        <Save aria-hidden="true" />
                        {t("editor.saveNow")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Ctrl/⌘ S
                        </MenubarShortcut>
                      </MenubarItem>
                      <MenubarSeparator />
                      <MenubarItem
                        disabled={saveState === "saving"}
                        onClick={openPreview}
                      >
                        <Scan aria-hidden="true" />
                        {t("editor.toolbarPreview")}
                      </MenubarItem>
                      <MenubarItem onClick={openHistory}>
                        <History aria-hidden="true" />
                        {t("editor.menubar.history")}
                      </MenubarItem>
                      {canSubmit && (
                        <>
                          <MenubarSeparator />
                          <MenubarItem
                            disabled={
                              saveState !== "saved" || publish.isPending
                            }
                            onClick={() => publish.mutate()}
                          >
                            {canPublish
                              ? t("editor.publishAction")
                              : t("editor.submitAction")}
                          </MenubarItem>
                        </>
                      )}
                    </MenubarContent>
                  </MenubarMenu>
                  <MenubarMenu>
                    <MenubarTrigger>{t("editor.menubar.edit")}</MenubarTrigger>
                    <MenubarContent className="min-w-52">
                      <MenubarItem disabled={!past.length} onClick={undo}>
                        {t("editor.menuUndo")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Ctrl/⌘ Z
                        </MenubarShortcut>
                      </MenubarItem>
                      <MenubarItem disabled={!future.length} onClick={redo}>
                        {t("editor.menuRedo")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Ctrl/⌘ ⇧ Z
                        </MenubarShortcut>
                      </MenubarItem>
                      <MenubarSeparator />
                      <MenubarItem
                        disabled={!selection.size}
                        onClick={copySelection}
                      >
                        {t("editor.menuCopy")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Ctrl/⌘ C
                        </MenubarShortcut>
                      </MenubarItem>
                      <MenubarItem
                        disabled={!clipboard.current.length}
                        onClick={pasteClipboard}
                      >
                        {t("editor.menuPaste")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Ctrl/⌘ V
                        </MenubarShortcut>
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selection.size}
                        onClick={duplicateSelection}
                      >
                        {t("editor.menuDuplicate")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Ctrl/⌘ D
                        </MenubarShortcut>
                      </MenubarItem>
                      <MenubarSeparator />
                      <MenubarItem
                        disabled={!document.placements.length}
                        onClick={selectAll}
                      >
                        {t("editor.menuSelectAll")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Ctrl/⌘ A
                        </MenubarShortcut>
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selection.size}
                        onClick={() => setSelection(new Set())}
                      >
                        {t("editor.menuDeselect")}
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selection.size}
                        variant="destructive"
                        onClick={deleteSelection}
                      >
                        {t("editor.shortcutDelete")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Del
                        </MenubarShortcut>
                      </MenubarItem>
                    </MenubarContent>
                  </MenubarMenu>
                  <MenubarMenu>
                    <MenubarTrigger>{t("editor.menuArrange")}</MenubarTrigger>
                    <MenubarContent className="min-w-52">
                      <MenubarItem
                        disabled={selection.size < 2}
                        onClick={groupSelection}
                      >
                        {t("editor.menuGroup")}
                        <MenubarShortcut>
                          {/* i18n-ignore: key name */}Ctrl/⌘ G
                        </MenubarShortcut>
                      </MenubarItem>
                      <MenubarItem
                        disabled={
                          !selected.some(
                            (item) => item.primitive?.kind === "group",
                          )
                        }
                        onClick={ungroupSelection}
                      >
                        {t("editor.menuUngroup")}
                      </MenubarItem>
                      <MenubarSub>
                        <MenubarSubTrigger disabled={!selected.length}>
                          {t("editor.menubar.layerOrder")}
                        </MenubarSubTrigger>
                        <MenubarSubContent>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => arrangeSelection("front")}
                          >
                            {t("editor.menuBringToFront")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => arrangeSelection("forward")}
                          >
                            {t("editor.menuBringForward")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => arrangeSelection("backward")}
                          >
                            {t("editor.menuSendBackward")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => arrangeSelection("back")}
                          >
                            {t("editor.menuSendToBack")}
                          </MenubarItem>
                        </MenubarSubContent>
                      </MenubarSub>
                      <MenubarSub>
                        <MenubarSubTrigger disabled={!selected.length}>
                          {t("editor.menubar.alignSelection")}
                        </MenubarSubTrigger>
                        <MenubarSubContent>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => alignSelection("left")}
                          >
                            {t("editor.menubar.alignLeft")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => alignSelection("hcenter")}
                          >
                            {t("editor.menuAlignHCenter")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => alignSelection("right")}
                          >
                            {t("editor.menubar.alignRight")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => alignSelection("top")}
                          >
                            {t("editor.menubar.alignTop")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => alignSelection("vmiddle")}
                          >
                            {t("editor.menuAlignVCenter")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={() => alignSelection("bottom")}
                          >
                            {t("editor.menubar.alignBottom")}
                          </MenubarItem>
                          <MenubarSeparator />
                          <MenubarItem
                            disabled={selected.length < 3}
                            onClick={() => distributeSelection("horizontal")}
                          >
                            {t("editor.menuDistributeH")}
                          </MenubarItem>
                          <MenubarItem
                            disabled={selected.length < 3}
                            onClick={() => distributeSelection("vertical")}
                          >
                            {t("editor.menuDistributeV")}
                          </MenubarItem>
                          <MenubarSeparator />
                          <MenubarItem
                            disabled={!selected.length}
                            onClick={fillCanvas}
                          >
                            {t("editor.menuFillCanvas")}
                          </MenubarItem>
                        </MenubarSubContent>
                      </MenubarSub>
                      <MenubarSeparator />
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => toggleSelectionFlag("locked")}
                      >
                        {selected.some((item) => item.locked)
                          ? t("editor.menubar.unlockSelection")
                          : t("editor.menubar.lockSelection")}
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => toggleSelectionFlag("visible")}
                      >
                        {selected.some((item) => !item.visible)
                          ? t("editor.menubar.showSelection")
                          : t("editor.menubar.hideSelection")}
                      </MenubarItem>
                    </MenubarContent>
                  </MenubarMenu>
                  <MenubarMenu>
                    <MenubarTrigger>{t("editor.menubar.view")}</MenubarTrigger>
                    <MenubarContent className="min-w-52">
                      <MenubarCheckboxItem
                        checked={snap}
                        onCheckedChange={(checked) => setSnap(checked)}
                      >
                        {t("editor.menuSnapOn")}
                      </MenubarCheckboxItem>
                      <MenubarCheckboxItem
                        checked={safeArea}
                        onCheckedChange={(checked) => setSafeArea(checked)}
                      >
                        {t("editor.menuSafeAreaShow")}
                      </MenubarCheckboxItem>
                      <MenubarSeparator />
                      <MenubarItem onClick={zoomOut}>
                        {t("editor.zoomOut")}
                      </MenubarItem>
                      <MenubarItem onClick={zoomIn}>
                        {t("editor.zoomIn")}
                      </MenubarItem>
                      <MenubarItem onClick={() => fitZoom()}>
                        {t("editor.zoomFit")}
                      </MenubarItem>
                    </MenubarContent>
                  </MenubarMenu>
                </Menubar>
              ) : (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    ref={fileMenuTrigger}
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("editor.menubar.fileActions")}
                      />
                    }
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-48">
                    <DropdownMenuItem
                      disabled={rename.isPending}
                      onClick={() =>
                        openRename({
                          kind: "layout",
                          name: layoutQuery.data?.name ?? "",
                        })
                      }
                    >
                      <Pencil aria-hidden="true" />
                      {t("editor.menubar.renameLayout")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={
                        saveState === "saved" ||
                        saveState === "saving" ||
                        saveState === "conflict"
                      }
                      onClick={() => void save()}
                    >
                      <Save aria-hidden="true" />
                      {t("editor.saveNow")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={openHistory}>
                      <History aria-hidden="true" />
                      {t("editor.menubar.history")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={!past.length} onClick={undo}>
                      <Undo2 aria-hidden="true" />
                      {t("editor.menuUndo")}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!future.length} onClick={redo}>
                      <Redo2 aria-hidden="true" />
                      {t("editor.menuRedo")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={saveState === "saving"}
                      onClick={openPreview}
                    >
                      <Play aria-hidden="true" />
                      {t("editor.toolbarPreview")}
                    </DropdownMenuItem>
                    {canSubmit && (
                      <DropdownMenuItem
                        disabled={saveState !== "saved" || publish.isPending}
                        onClick={() => publish.mutate()}
                      >
                        {publish.isPending && <Spinner aria-hidden="true" />}
                        {canPublish
                          ? t("editor.publishAction")
                          : t("editor.submitAction")}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
            {desktop && (
              <ButtonGroup
                aria-label={t("editor.undoRedoLabel")}
                className="shrink-0"
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="disabled:text-[#a1a1a1] disabled:opacity-100"
                        aria-label={t("editor.menuUndo")}
                        onClick={undo}
                        disabled={!past.length}
                      />
                    }
                  >
                    <Undo2 aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("editor.menuUndo")}{" "}
                    <Kbd>{/* i18n-ignore: key name */}Ctrl+Z</Kbd>
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="disabled:text-[#a1a1a1] disabled:opacity-100"
                        aria-label={t("editor.menuRedo")}
                        onClick={redo}
                        disabled={!future.length}
                      />
                    }
                  >
                    <Redo2 aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("editor.menuRedo")}{" "}
                    <Kbd>{/* i18n-ignore: key name */}Ctrl+Shift+Z</Kbd>
                  </TooltipContent>
                </Tooltip>
              </ButtonGroup>
            )}
          </>
        }
        right={
          desktop ? (
            <div className="flex shrink-0 items-center gap-2">
              <LayoutSaveStatus state={saveState} onRetry={() => void save()} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saveState === "saving"}
                onClick={openPreview}
              >
                <Play aria-hidden="true" />
                {t("editor.toolbarPreview")}
              </Button>
              {canSubmit && (
                <Button
                  type="button"
                  size="sm"
                  disabled={saveState !== "saved" || publish.isPending}
                  aria-busy={publish.isPending || undefined}
                  onClick={() => publish.mutate()}
                >
                  {publish.isPending && <Spinner aria-hidden="true" />}
                  {canPublish
                    ? t("editor.publishAction")
                    : t("editor.submitAction")}
                </Button>
              )}
            </div>
          ) : (
            <LayoutSaveStatus
              state={saveState}
              onRetry={() => void save()}
              compact
            />
          )
        }
      />
      {saveState === "conflict" && (
        <Alert
          variant="destructive"
          className="shrink-0 rounded-none border-x-0 border-t-0"
        >
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t("editor.conflictTitle")}</AlertTitle>
          <AlertDescription>{t("editor.conflictDescription")}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
            >
              {t("editor.conflictReload")}
            </Button>
          </AlertAction>
        </Alert>
      )}
      <div className={cn("min-h-0 flex-1", !desktop && "min-h-[70vh]")}>
        {stage}
      </div>
      {/* Keep the selected picker mounted until its generated Dialog completes closing. */}
      {(picker === "media" || picker === "widgets") && (
        <ContentPicker
          open={pickerOpen}
          mode="multiple"
          csrf={csrf}
          allowedTypes={picker === "widgets" ? ["widget"] : ["image", "video"]}
          title={
            picker === "widgets"
              ? t("editor.pickerAppsTitle")
              : t("editor.pickerMediaTitle")
          }
          description={
            picker === "widgets"
              ? t("editor.pickerAppsDescription")
              : t("editor.pickerMediaDescription")
          }
          confirmLabel={t("editor.pickerConfirm")}
          onConfirm={(assets) => {
            addContentBatch(assets);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
          onCloseComplete={() => {
            if (!pickerOpen) setPicker(undefined);
          }}
          onCreateWidget={() =>
            void navigate(
              `/widgets/new?returnTo=${encodeURIComponent(location.pathname)}`,
            )
          }
        />
      )}
      {picker === "playlists" && (
        <PlaylistPicker
          open={pickerOpen}
          description={t("editor.pickerPlaylistDescription")}
          confirmLabel={t("editor.pickerConfirm")}
          onConfirm={(choice) => {
            if (choice.kind === "playlist") addPlaylistZone(choice.playlist);
            setPickerOpen(false);
          }}
          onClose={() => setPickerOpen(false)}
          onCloseComplete={() => {
            if (!pickerOpen) setPicker(undefined);
          }}
        />
      )}
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          finalFocus={fileMenuTrigger}
          className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle>{t("editor.historyTitle")}</DialogTitle>
            <DialogDescription>
              {t("editor.historyDescription")}
            </DialogDescription>
          </DialogHeader>
          <div>
            {revisions.isLoading ? (
              <div className="grid gap-2" aria-busy="true">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : revisions.data?.items?.length ? (
              <ItemGroup className="gap-0 divide-y divide-border">
                {revisions.data.items.map((revision) => (
                  <Item
                    key={revision.id}
                    size="sm"
                    className="rounded-none px-0"
                  >
                    <ItemContent>
                      <ItemTitle>
                        {t("editor.historyRevision", {
                          revision: revision.revision,
                        })}
                      </ItemTitle>
                      <ItemDescription>
                        {new Date(revision.publishedAt).toLocaleString(
                          formatLocale,
                        )}
                        {" · "}
                        {t("editor.historyDigest", {
                          digest: revision.documentSha256.slice(0, 12),
                        })}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => restore.mutate(revision.id)}
                      >
                        {t("editor.historyRestore")}
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <Empty className="border-0 py-6">
                <EmptyHeader>
                  <EmptyTitle>{t("editor.historyEmpty")}</EmptyTitle>
                  <EmptyDescription>
                    {t("editor.historyEmptyDescription")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>
              {t("common:actions.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LayoutPaneHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2.5">
      <h2 className="text-sm font-medium">{title}</h2>
      {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
    </div>
  );
}

// Autosave state is status, not a button: File > Save and Ctrl/Command+S stay
// available, and only a failed save offers an inline retry.
function LayoutSaveStatus({
  state,
  onRetry,
  compact = false,
}: {
  state: SaveState;
  onRetry: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation(["layouts", "common"]);
  const label =
    state === "saving"
      ? t("common:actions.saving")
      : state === "unsaved"
        ? t("editor.saveUnsaved")
        : state === "error"
          ? t("editor.saveFailed")
          : state === "conflict"
            ? t("editor.saveConflict")
            : t("editor.saveSaved");
  return (
    <div className="flex items-center gap-2">
      <span
        role="status"
        aria-label={compact ? label : undefined}
        title={compact ? label : undefined}
        className={cn(
          "flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5",
          (state === "error" || state === "conflict") && "text-destructive",
        )}
      >
        {state === "saving" ? (
          <>
            <Spinner aria-hidden="true" />
            <span className={compact ? "sr-only" : undefined}>{label}</span>
          </>
        ) : state === "unsaved" ? (
          <>
            <CircleDot aria-hidden="true" />
            <span className={compact ? "sr-only" : undefined}>{label}</span>
          </>
        ) : state === "error" ? (
          <>
            <CircleAlert aria-hidden="true" />
            <span className={compact ? "sr-only" : undefined}>{label}</span>
          </>
        ) : state === "conflict" ? (
          <>
            <TriangleAlert aria-hidden="true" />
            <span className={compact ? "sr-only" : undefined}>{label}</span>
          </>
        ) : (
          <>
            <CloudCheck aria-hidden="true" />
            <span className={compact ? "sr-only" : "max-xl:sr-only"}>
              {label}
            </span>
          </>
        )}
      </span>
      {!compact && state === "error" && (
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          {t("common:actions.retry")}
        </Button>
      )}
    </div>
  );
}
