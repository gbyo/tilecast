import { cn } from "cn";
import { ContentPicker, PlaylistPicker } from "../components/content-picker";
import { DateInput } from "../components/date-picker";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
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
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Input } from "../components/ui/input";
import { Field, FieldLabel } from "../components/ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/ui/resizable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
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
import {
  AppPlacementPreview,
  AssetPlaybackPreview,
  PlaylistZonePreview,
  WidgetLivePreview,
  assetPreviewStyle,
} from "../components/layout-editor/WidgetLivePreview";
import type { LivePreviewData } from "../components/layout-editor/WidgetLivePreview";
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
  Search,
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "../api/client";
import type {
  Asset,
  CalendarPreview,
  LayoutDocument,
  LayoutPlacement,
  LayoutPrimitive,
  Playlist,
  StructuredPreview,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { UsedByPanel } from "../content/UsedByPanel";
import { layoutFontStack } from "../layoutFonts";
import { captureLayoutPreview } from "../content/widgetPreviewCapture";

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";
type LayoutLibrarySection = "widgets" | "media" | "playlists";
type LayoutSidebarSection =
  LayoutLibrarySection | "elements" | "layers" | "settings";
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

const widgetDataSourceId = (asset?: Asset): string | undefined => {
  const widget = asset?.widget;
  if (!widget) return undefined;
  if (["ticker", "menu", "list", "table", "agenda"].includes(widget.provider))
    return (widget.configuration as { dataSourceId?: string }).dataSourceId;
  return undefined;
};

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
    overrides: isApp
      ? {
          fit: "contain",
          alignment: "center",
          fallbackVisibility: "show",
          muted: true,
        }
      : undefined,
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
  const [document, setDocument] = useState<LayoutDocument>();
  const [selection, setSelection] = useState(new Set<string>());
  const [past, setPast] = useState<LayoutDocument[]>([]);
  const [future, setFuture] = useState<LayoutDocument[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [serverRevision, setServerRevision] = useState(0);
  const [zoom, setZoom] = useState(1);
  const desktop = useDesktopLayout();
  const [snap, setSnap] = useState(true);
  const [safeArea, setSafeArea] = useState(true);
  const [sidebarSection, setSidebarSection] =
    useState<LayoutSidebarSection>("media");
  const [preview, setPreview] = useState(false);
  const [previewDate, setPreviewDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [previewValues, setPreviewValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [liveData, setLiveData] = useState<LivePreviewData>({});
  const [previewAssets, setPreviewAssets] = useState<Asset[]>([]);
  const [previewPlaylists, setPreviewPlaylists] = useState<Playlist[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [previewScale, setPreviewScale] = useState(0);
  // State rather than a ref: the frame mounts inside the Dialog portal after
  // the preview opens, and measuring must wait for it to exist.
  const [previewFrame, setPreviewFrame] = useState<HTMLDivElement | null>(null);
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
  const zoomIn = useCallback(
    () => setZoom((value) => Math.min(1.5, value + 0.1)),
    [],
  );
  const zoomOut = useCallback(
    () => setZoom((value) => Math.max(0.25, value - 0.1)),
    [],
  );
  // Fit keeps the whole canvas visible inside the scroll viewport: the canvas
  // is sized as a percentage of that viewport, so full width is zoom 1 and a
  // short viewport pulls the zoom down by the height ratio. Padding mirrors
  // .layout-stage-scroll so the canvas never hides under the control bar.
  // Reads the canvas from state (not the mutable draft ref) so the callback
  // stays a pure function of its declared dependency.
  const fitZoom = useCallback(() => {
    const scroll = canvasRef.current?.parentElement;
    if (!scroll || !document) return;
    const availW = Math.max(1, scroll.clientWidth - 96);
    const availH = Math.max(1, scroll.clientHeight - 112);
    const fit = Math.min(
      1,
      (availH / availW) * (document.canvas.width / document.canvas.height),
    );
    setZoom(Math.max(0.25, Math.min(1.5, fit)));
  }, [document]);
  const clipboard = useRef<LayoutPlacement[]>([]);
  const initialized = useRef(false);
  const documentRef = useRef<LayoutDocument | undefined>(undefined);
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
      layoutQuery.data?.previewImageUrl ||
      !document ||
      contentQuery.isLoading
    )
      return;
    initialPreviewAttemptedRef.current = true;
    const timer = window.setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      void captureLayoutPreview(
        canvas,
        document.canvas.width,
        document.canvas.height,
      )
        .then((image) =>
          api.uploadLayoutPreview(
            id,
            layoutQuery.data!.draftRevision,
            image,
            csrf,
          ),
        )
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ["layout", id] });
          void queryClient.invalidateQueries({ queryKey: ["layouts"] });
        })
        .catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    contentQuery.isLoading,
    csrf,
    document,
    id,
    layoutQuery.data,
    queryClient,
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
    if (
      !documentRef.current ||
      savingRef.current ||
      savedChangeVersionRef.current === changeVersionRef.current
    )
      return;
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
      const canvas = canvasRef.current;
      if (canvas) {
        void captureLayoutPreview(
          canvas,
          previewDocument.canvas.width,
          previewDocument.canvas.height,
        )
          .then((previewImage) => {
            if (
              previewVersion !== changeVersionRef.current ||
              previewRevision !== revisionRef.current
            )
              return;
            return api.uploadLayoutPreview(
              id,
              previewRevision,
              previewImage,
              csrf,
            );
          })
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: ["layouts"] });
          })
          // Thumbnail capture can fail because of browser canvas/CORS support. The
          // server draft is already safely persisted, so do not report this as a
          // draft-save failure or prevent publishing.
          .catch(() => undefined);
      }
    } catch (error) {
      setSaveState(
        error instanceof ApiError && error.code === "layout_revision_conflict"
          ? "conflict"
          : "error",
      );
    } finally {
      savingRef.current = false;
    }
  }, [csrf, id, queryClient]);
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
  // Track the rendered size of the preview frame so widgets can convert canvas
  // pixels into screen pixels the same way the Player scales the whole canvas.
  useLayoutEffect(() => {
    const frame = previewFrame;
    if (!preview || !frame || !document) return;
    const measure = () =>
      setPreviewScale(frame.clientWidth / document.canvas.width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [preview, previewFrame, document]);
  const publish = useMutation<unknown, ApiError>({
    mutationFn: () =>
      canPublish
        ? api.publishLayout(id, serverRevision, csrf)
        : api.submitContent("layout", id, csrf, undefined, serverRevision),
    onSuccess: () => {
      toast.add({
        title: canPublish
          ? "Layout published."
          : "Layout submitted for review.",
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
      toast.add({ title: "Layout renamed.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["layout", id] });
      void queryClient.invalidateQueries({ queryKey: ["layouts"] });
    },
  });
  const restore = useMutation({
    mutationFn: (revisionId: string) =>
      api.restoreLayoutRevision(id, revisionId, serverRevision, csrf),
    onSuccess: (saved) => {
      toast.add({ title: "Layout revision restored.", type: "success" });
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
      sidebarSection === "widgets" ||
      sidebarSection === "media" ||
      sidebarSection === "playlists"
        ? recentLayoutLibraryItems(
            sidebarSection,
            contentQuery.data?.items ?? [],
            playlistsQuery.data?.items ?? [],
          )
        : [],
    [contentQuery.data?.items, sidebarSection, playlistsQuery.data?.items],
  );
  const primary = selected.at(-1);
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
  const addContent = (asset: Asset, position?: { x: number; y: number }) => {
    if (!document) return;
    rememberAssets([asset]);
    const item = createContentPlacement(asset, document.canvas, position);
    stack(item);
    setSelection(new Set([item.id]));
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
  };
  // Resolve the same date-selected records/events the Player receives so previews
  // show real values without copying data into the Layout document. Collects Data
  // Sources referenced by both text bindings and native widgets.
  const loadStructuredPreview = async (
    date = previewDate,
    resolvedAssets: Asset[] = [],
  ) => {
    const current = documentRef.current;
    if (!current) return;
    const assetsById = new Map(
      [...(contentQuery.data?.items ?? []), ...resolvedAssets].map((asset) => [
        asset.id,
        asset,
      ]),
    );
    const dataSourceIds = new Set<string>();
    current.placements.forEach((placement) => {
      const bindingId = placement.primitive?.binding?.dataSourceId;
      if (bindingId) dataSourceIds.add(bindingId);
      const widgetSourceId = placement.widgetId
        ? widgetDataSourceId(assetsById.get(placement.widgetId))
        : undefined;
      if (widgetSourceId) dataSourceIds.add(widgetSourceId);
    });
    resolvedAssets.forEach((asset) => {
      const dataSourceID = widgetDataSourceId(asset);
      if (dataSourceID) dataSourceIds.add(dataSourceID);
    });
    try {
      const resolved = await Promise.all(
        Array.from(dataSourceIds).map(async (dataSourceId) => {
          // Preview the saved Source by id so uploaded CSV content (stripped from
          // the detail response) is resolved server-side, exactly as the Player sees it.
          const preview = await api.previewSavedDataSource(dataSourceId, date);
          if ("records" in preview) {
            const typed = preview;
            return [
              dataSourceId,
              {
                provider: "manual" as const,
                records: typed.records.map((record) => ({
                  id: record.id,
                  title:
                    record.values.title ??
                    Object.values(record.values).find(Boolean) ??
                    "",
                  values: record.values,
                })),
                emptyState: "No items available",
              },
            ] as const;
          }
          if ("events" in preview.configuration.data) {
            const calendar = preview as CalendarPreview;
            return [
              dataSourceId,
              {
                provider: "calendar" as const,
                events: calendar.configuration.data.events,
                emptyState: calendar.configuration.emptyState,
              },
            ] as const;
          }
          const structured = preview as StructuredPreview;
          return [
            dataSourceId,
            {
              provider: "json" as const,
              records: structured.configuration.data.records,
              emptyState: structured.configuration.emptyState,
            },
          ] as const;
        }),
      );
      const live = Object.fromEntries(resolved) as LivePreviewData;
      setLiveData(live);
      // Derive first-record field values for text bindings (unchanged behaviour).
      const values: Record<string, Record<string, string>> = {};
      Object.entries(live).forEach(([dataSourceId, source]) => {
        const record = source.records?.[0];
        if (!record) return;
        const fields: Record<string, string> = { ...(record.values ?? {}) };
        (
          ["title", "subtitle", "date", "author", "description"] as const
        ).forEach((key) => {
          const value = record[key];
          if (value) fields[key] = value;
        });
        values[dataSourceId] = fields;
      });
      setPreviewValues(values);
    } catch {
      setLiveData({});
      setPreviewValues({});
    }
  };
  const loadLayoutPreview = async (date = previewDate) => {
    const current = documentRef.current;
    if (!current) return;
    setPreviewLoading(true);
    setPreviewError("");
    const playlistIDs = Array.from(
      new Set(
        current.placements
          .map((placement) => placement.playlistId)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const playlistResults = await Promise.allSettled(
      playlistIDs.map((playlistID) => api.playlist(playlistID)),
    );
    const playlists = playlistResults.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    setPreviewPlaylists(playlists);

    const assetIDs = new Set<string>();
    if (current.canvas.backgroundAssetId)
      assetIDs.add(current.canvas.backgroundAssetId);
    current.placements.forEach((placement) => {
      if (placement.assetId) assetIDs.add(placement.assetId);
      if (placement.widgetId) assetIDs.add(placement.widgetId);
    });
    playlists.forEach((playlist) =>
      playlist.items.forEach((item) => assetIDs.add(item.assetId)),
    );
    const knownAssets = new Map(
      (contentQuery.data?.items ?? []).map((asset) => [asset.id, asset]),
    );
    const missingIDs = Array.from(assetIDs).filter(
      (assetID) => !knownAssets.has(assetID),
    );
    const assetResults = await Promise.allSettled(
      missingIDs.map((assetID) => api.asset(assetID)),
    );
    const assets = [
      ...Array.from(assetIDs).flatMap((assetID) => {
        const asset = knownAssets.get(assetID);
        return asset ? [asset] : [];
      }),
      ...assetResults.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      ),
    ];
    setPreviewAssets(assets);
    await loadStructuredPreview(date, assets);
    const failures =
      playlistResults.filter((result) => result.status === "rejected").length +
      assetResults.filter((result) => result.status === "rejected").length;
    if (failures)
      setPreviewError(
        `${failures} referenced item${failures === 1 ? " is" : "s are"} unavailable.`,
      );
    setPreviewLoading(false);
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
        label: "Rename…",
        icon: <Pencil size={14} />,
        disabled: many,
        onSelect: () => renamePlacement(target),
      },
      { label: "Copy", icon: <Copy size={14} />, onSelect: copySelection },
      {
        label: "Paste",
        icon: <ClipboardPaste size={14} />,
        disabled: !clipboard.current.length,
        onSelect: pasteClipboard,
      },
      {
        label: "Duplicate",
        icon: <CopyPlus size={14} />,
        onSelect: duplicateSelection,
      },
      {
        label: "Arrange",
        icon: <Layers size={14} />,
        separated: true,
        submenu: [
          {
            label: "Bring to front",
            icon: <ArrowUpToLine size={14} />,
            onSelect: () => arrangeSelection("front"),
          },
          {
            label: "Bring forward",
            icon: <ArrowUp size={14} />,
            onSelect: () => arrangeSelection("forward"),
          },
          {
            label: "Send backward",
            icon: <ArrowDown size={14} />,
            onSelect: () => arrangeSelection("backward"),
          },
          {
            label: "Send to back",
            icon: <ArrowDownToLine size={14} />,
            onSelect: () => arrangeSelection("back"),
          },
        ],
      },
      {
        label: many ? "Align" : "Align to canvas",
        icon: <AlignCenterHorizontal size={14} />,
        disabled: !alignable,
        submenu: [
          {
            label: "Left",
            icon: <AlignStartVertical size={14} />,
            onSelect: () => alignSelection("left"),
          },
          {
            label: "Horizontal centres",
            icon: <AlignCenterVertical size={14} />,
            onSelect: () => alignSelection("hcenter"),
          },
          {
            label: "Right",
            icon: <AlignEndVertical size={14} />,
            onSelect: () => alignSelection("right"),
          },
          {
            label: "Top",
            icon: <AlignStartHorizontal size={14} />,
            separated: true,
            onSelect: () => alignSelection("top"),
          },
          {
            label: "Vertical centres",
            icon: <AlignCenterHorizontal size={14} />,
            onSelect: () => alignSelection("vmiddle"),
          },
          {
            label: "Bottom",
            icon: <AlignEndHorizontal size={14} />,
            onSelect: () => alignSelection("bottom"),
          },
          {
            label: "Distribute horizontally",
            icon: <AlignHorizontalDistributeCenter size={14} />,
            separated: true,
            disabled: alignable < 3,
            onSelect: () => distributeSelection("horizontal"),
          },
          {
            label: "Distribute vertically",
            icon: <AlignVerticalDistributeCenter size={14} />,
            disabled: alignable < 3,
            onSelect: () => distributeSelection("vertical"),
          },
          {
            label: "Fill canvas",
            icon: <Maximize2 size={14} />,
            separated: true,
            onSelect: fillCanvas,
          },
        ],
      },
      {
        label: "Group selection",
        icon: <Group size={14} />,
        disabled: selection.size < 2,
        onSelect: groupSelection,
      },
      {
        label: "Ungroup",
        icon: <Ungroup size={14} />,
        disabled: !scope.some((item) => item.primitive?.kind === "group"),
        onSelect: ungroupSelection,
      },
      {
        label: locked ? "Unlock" : "Lock",
        icon: locked ? <LockOpen size={14} /> : <Lock size={14} />,
        separated: true,
        onSelect: () => toggleSelectionFlag("locked"),
      },
      {
        label: hidden ? "Show" : "Hide",
        icon: hidden ? <Eye size={14} /> : <EyeOff size={14} />,
        onSelect: () => toggleSelectionFlag("visible"),
      },
      {
        label: "Layer settings",
        icon: <Settings size={14} />,
        onSelect: () => setSidebarSection("layers"),
      },
      {
        label: many ? `Delete ${scope.length} layers` : "Delete",
        icon: <Trash2 size={14} />,
        separated: true,
        danger: true,
        onSelect: deleteSelection,
      },
    ];
  };
  const canvasMenuItems = (): LayoutMenuEntry[] => [
    {
      label: "Add element",
      icon: <Plus size={14} />,
      submenu: [
        {
          label: "Text",
          icon: <Type size={14} />,
          onSelect: () => addPrimitive("text"),
        },
        {
          label: "Rectangle",
          icon: <RectangleHorizontal size={14} />,
          onSelect: () => addPrimitive("rectangle"),
        },
        {
          label: "Circle",
          icon: <Circle size={14} />,
          onSelect: () => addPrimitive("circle"),
        },
        {
          label: "Line",
          icon: <Minus size={14} />,
          onSelect: () => addPrimitive("line"),
        },
      ],
    },
    {
      label: "Paste",
      icon: <ClipboardPaste size={14} />,
      disabled: !clipboard.current.length,
      onSelect: pasteClipboard,
    },
    {
      label: "Select all",
      icon: <BoxSelect size={14} />,
      separated: true,
      disabled: !document?.placements.length,
      onSelect: selectAll,
    },
    {
      label: "Deselect",
      icon: <MousePointerClick size={14} />,
      disabled: !selection.size,
      onSelect: () => setSelection(new Set()),
    },
    {
      label: "Undo",
      icon: <Undo2 size={14} />,
      separated: true,
      disabled: !past.length,
      onSelect: undo,
    },
    {
      label: "Redo",
      icon: <Redo2 size={14} />,
      disabled: !future.length,
      onSelect: redo,
    },
    {
      label: snap ? "Turn off snapping" : "Snap to grid",
      icon: <Magnet size={14} />,
      separated: true,
      onSelect: () => setSnap((value) => !value),
    },
    {
      label: safeArea ? "Hide safe area" : "Show safe area",
      icon: <Scan size={14} />,
      onSelect: () => setSafeArea((value) => !value),
    },
    {
      label: "Layout settings",
      icon: <Settings size={14} />,
      separated: true,
      onSelect: () => setSidebarSection("settings"),
    },
  ];
  const beginMove = (
    event: ReactPointerEvent,
    item: LayoutPlacement,
    resize = false,
  ) => {
    event.stopPropagation();
    // Right- and middle-clicks must not start a drag: their pointerup would otherwise
    // push an undo entry and mark the layout dirty without anything having moved.
    if (event.button !== 0) return;
    if (item.locked) return;
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
      if ((event.target as HTMLElement).matches("input,textarea,select"))
        return;
      // While a context menu is up its own keys own the keyboard, so arrowing through
      // the items does not also nudge or delete the selection behind it.
      if (window.document.querySelector(".context-menu-layer")) return;
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
          <EmptyTitle>Layout unavailable</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="secondary" onClick={() => void navigate("/layouts")}>
            Back to Layouts
          </Button>
        </EmptyContent>
      </Empty>
    );
  if (layoutQuery.isLoading || !document)
    return (
      <div
        className="grid gap-3"
        aria-busy="true"
        aria-label="Loading Layout editor"
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
  const previewContentByID = new Map(
    [...libraryAssets, ...previewAssets].map(
      (asset) => [asset.id, asset] as const,
    ),
  );
  const previewPlaylistByID = new Map(
    [...libraryPlaylists, ...previewPlaylists].map(
      (playlist) => [playlist.id, playlist] as const,
    ),
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
    setPreview(true);
    void loadLayoutPreview();
  };
  const openHistory = () => {
    setHistoryOpen(true);
    void revisions.refetch();
  };
  // On desktop the right-hand pane always shows Layout settings when nothing
  // is selected, so the Settings section only exists in the narrow layout.
  const sidebarSections = [
    ["media", "Media", ImageIcon],
    ["widgets", "Widgets", AppWindow],
    ["playlists", "Playlists", ListVideo],
    ["elements", "Elements", RectangleHorizontal],
    ["layers", "Layers", BoxSelect],
    ...(desktop ? [] : ([["settings", "Settings", Settings]] as const)),
  ] as const;
  const activeSidebarSection =
    desktop && sidebarSection === "settings" ? "media" : sidebarSection;
  const layoutUsage = layoutQuery.data && (
    <UsedByPanel
      emptyMessage="No campaign, screen, or schedule shows this Layout yet."
      groups={[
        {
          label: "Screens",
          items: layoutQuery.data.usage.screens,
          to: (screenId) => `/screens/${screenId}`,
        },
        {
          label: "Schedules",
          items: layoutQuery.data.usage.schedules,
          to: (scheduleId) => `/schedules/${scheduleId}`,
        },
        {
          label: "Campaigns",
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
  const renderSidebarPanel = (section: LayoutSidebarSection) => {
    if (
      section === "media" ||
      section === "widgets" ||
      section === "playlists"
    ) {
      const label = {
        media: "Media",
        widgets: "Widgets",
        playlists: "Playlists",
      }[section];
      return (
        <>
          <LayoutPaneHeading title={label} />
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-3">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                setPicker(section);
                setPickerOpen(true);
              }}
            >
              <Search aria-hidden="true" />
              {
                {
                  media: "Browse media library",
                  widgets: "Browse apps",
                  playlists: "Browse playlists",
                }[section]
              }
            </Button>
            <section
              className="grid grid-cols-[minmax(0,1fr)] gap-2"
              aria-labelledby={`recent-${section}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3
                  id={`recent-${section}`}
                  className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                >
                  Recent
                </h3>
                {recentLibraryItems.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Drag to canvas
                  </span>
                )}
              </div>
              {recentLibraryItems.length ? (
                <ItemGroup className="gap-0.5">
                  {recentLibraryItems.map((item) => {
                    const asset =
                      item.kind === "asset" ? item.asset : undefined;
                    const playlist =
                      item.kind === "playlist" ? item.playlist : undefined;
                    const name = asset?.name ?? playlist?.name ?? "";
                    return (
                      <Item
                        key={`${item.kind}-${asset?.id ?? playlist?.id}`}
                        role="listitem"
                        size="xs"
                        className="cursor-grab flex-nowrap text-left hover:bg-muted active:cursor-grabbing"
                        render={
                          <button
                            type="button"
                            draggable
                            title={`Add ${name}`}
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "copy";
                              event.dataTransfer.setData(
                                "application/x-tilecast-layout-library",
                                JSON.stringify({
                                  kind: item.kind,
                                  id: asset?.id ?? playlist?.id,
                                }),
                              );
                            }}
                            onClick={() => addLibraryItem(item)}
                          />
                        }
                      >
                        <ItemMedia
                          variant={asset?.thumbnailUrl ? "image" : "icon"}
                          className="size-9 rounded-sm bg-muted text-muted-foreground"
                        >
                          {asset?.thumbnailUrl ? (
                            <img
                              src={asset.thumbnailUrl}
                              alt=""
                              draggable={false}
                            />
                          ) : asset?.type === "widget" ? (
                            <AppWindow aria-hidden="true" />
                          ) : playlist ? (
                            <ListVideo aria-hidden="true" />
                          ) : (
                            <ImageIcon aria-hidden="true" />
                          )}
                        </ItemMedia>
                        <ItemContent className="min-w-0 gap-0">
                          <ItemTitle className="block w-full truncate">
                            {name}
                          </ItemTitle>
                          <ItemDescription className="truncate capitalize">
                            {playlist
                              ? `${playlist.itemCount} items`
                              : (asset?.widget?.provider ?? asset?.type)}
                          </ItemDescription>
                        </ItemContent>
                      </Item>
                    );
                  })}
                </ItemGroup>
              ) : (
                <Empty className="border border-dashed p-4 md:p-4">
                  <EmptyHeader>
                    <EmptyDescription className="text-xs">
                      No recent {section}. Browse the whole library above.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </section>
          </div>
        </>
      );
    }
    if (section === "elements") {
      return (
        <>
          <LayoutPaneHeading title="Elements" />
          <div className="grid grid-cols-2 gap-2 p-3">
            {(
              [
                ["text", "Text", Type],
                ["rectangle", "Rectangle", RectangleHorizontal],
                ["circle", "Circle", Circle],
                ["line", "Line", Minus],
              ] as const
            ).map(([kind, label, Icon]) => (
              <Button
                key={kind}
                type="button"
                variant="outline"
                className="h-auto min-h-17 flex-col gap-1.5 py-3 font-normal"
                onClick={() => addPrimitive(kind)}
              >
                <Icon className="size-5" aria-hidden="true" />
                {label}
              </Button>
            ))}
          </div>
        </>
      );
    }
    if (section === "layers") {
      return (
        <>
          <LayoutPaneHeading
            title="Layers"
            meta={String(document.placements.length)}
          />
          <ItemGroup className="gap-0.5 p-2" aria-label="Layers">
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
                        onContextMenu={(event) =>
                          openPlacementMenu(event, item)
                        }
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
                            event.shiftKey
                              ? [...selection, item.id]
                              : [item.id],
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
                            ? `Hide ${item.name}`
                            : `Show ${item.name}`
                        }
                        aria-pressed={item.visible}
                        title={item.visible ? "Hide" : "Show"}
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
                            ? `Unlock ${item.name}`
                            : `Lock ${item.name}`
                        }
                        aria-pressed={item.locked}
                        title={item.locked ? "Unlock" : "Lock"}
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
                  <ContextMenuContent aria-label={`Actions for ${item.name}`}>
                    <LayoutEditorMenuEntries items={placementMenuItems(item)} />
                  </ContextMenuContent>
                </ContextMenu>
              ))}
          </ItemGroup>
          {!document.placements.length && (
            <Empty className="m-3 border border-dashed p-4 md:p-4">
              <EmptyHeader>
                <EmptyDescription className="text-xs">
                  Add media, apps, or elements to build this Layout.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {!desktop && primary && (
            <>
              <Separator />
              <LayoutPaneHeading
                title="Selected layer"
                meta={`${selected.length} selected`}
              />
              <div className="p-3">{placementInspector}</div>
            </>
          )}
        </>
      );
    }
    return (
      <>
        <LayoutPaneHeading title="Layout settings" />
        {layoutSettings}
      </>
    );
  };
  const librarySidebar = (
    <aside
      aria-label="Layout library"
      className="h-full min-h-0 overflow-hidden bg-background max-lg:max-h-[60vh] max-lg:border-b"
    >
      <Tabs
        value={activeSidebarSection}
        onValueChange={(value) => {
          if (value) setSidebarSection(value as LayoutSidebarSection);
        }}
        orientation="vertical"
        className="h-full gap-0"
      >
        <TabsList
          variant="line"
          className="h-full w-20 shrink-0 justify-start gap-1 rounded-none border-r px-1.5 py-2"
          aria-label="Layout builder"
        >
          {sidebarSections.map(([section, label, Icon]) => (
            <TabsTrigger
              key={section}
              value={section}
              className="h-auto flex-none flex-col justify-center gap-1 py-2 text-xs group-data-vertical/tabs:justify-center"
            >
              <Icon aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {sidebarSections.map(([section]) => (
          <TabsContent
            key={section}
            value={section}
            className="min-h-0 min-w-0 overflow-y-auto"
          >
            {renderSidebarPanel(section)}
          </TabsContent>
        ))}
      </Tabs>
    </aside>
  );

  const stage = (
    <main className="layout-stage">
      <div className="layout-stage-controls">
        <ButtonGroup aria-label="Canvas zoom">
          <Button
            variant="outline"
            size="sm"
            onClick={zoomOut}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut size={16} aria-hidden="true" />
          </Button>
          <ButtonGroupText aria-live="polite">
            {Math.round(zoom * 100)}%
          </ButtonGroupText>
          <Button
            variant="outline"
            size="sm"
            onClick={zoomIn}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={fitZoom}
            title="Fit canvas to view"
            aria-label="Fit canvas to view"
          >
            <Maximize2 size={16} aria-hidden="true" />
          </Button>
        </ButtonGroup>
        {/* The wrapping label names the checkbox; no extra aria-label. */}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={snap}
            onCheckedChange={(checked) => setSnap(checked === true)}
          />
          Snap
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={safeArea}
            onCheckedChange={(checked) => setSafeArea(checked === true)}
          />
          Safe area
        </label>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                title="Keyboard shortcuts"
                aria-label="Keyboard shortcuts"
              >
                <Keyboard size={16} aria-hidden="true" />
              </Button>
            }
          />
          <PopoverContent
            side="bottom"
            align="center"
            aria-label="Canvas keyboard shortcuts"
          >
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Keyboard shortcuts
            </p>
            <ul className="grid gap-2 text-sm">
              <li className="flex items-center justify-between gap-3">
                <span>Save</span>
                <span className="flex items-center gap-1">
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>S</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Undo / redo</span>
                <span className="flex items-center gap-1">
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>Z</Kbd>
                  <Kbd>⇧</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Duplicate</span>
                <span className="flex items-center gap-1">
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>D</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Copy / paste</span>
                <span className="flex items-center gap-1">
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>C</Kbd>
                  <Kbd>V</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Select all</span>
                <span className="flex items-center gap-1">
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>A</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Group / ungroup</span>
                <span className="flex items-center gap-1">
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>G</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Arrange (Shift: front/back)</span>
                <span className="flex items-center gap-1">
                  <Kbd>Ctrl/⌘</Kbd>
                  <Kbd>[</Kbd>
                  <Kbd>]</Kbd>
                </span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Delete selection</span>
                <Kbd>Del</Kbd>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Nudge (Shift: 10px)</span>
                <Kbd>← ↑ ↓ →</Kbd>
              </li>
            </ul>
          </PopoverContent>
        </Popover>
      </div>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <div
              className="layout-stage-scroll"
              onPointerDown={(event) => {
                if (event.button === 0) setSelection(new Set());
              }}
              onContextMenuCapture={() => setMenuTarget({ kind: "canvas" })}
            />
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
            onDrop={dropLibraryItem}
            style={{
              aspectRatio: `${document.canvas.width}/${document.canvas.height}`,
              width: `${zoom * 100}%`,
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
                  selected={selection.has(item.id)}
                  onPointerDown={(event) => beginMove(event, item)}
                  onResize={(event) => beginMove(event, item, true)}
                  onContextMenu={(event) => openPlacementMenu(event, item)}
                />
              ))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          aria-label={
            menuTarget?.kind === "placement"
              ? `Actions for ${menuTarget.item.name}`
              : "Canvas actions"
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
                  ? "Rename Layout"
                  : "Rename layer"}
              </DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <Field className="gap-1.5">
                <FieldLabel
                  htmlFor="rename-target-name"
                  className="text-sm font-medium"
                >
                  Name
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
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!renameValue.trim() || rename.isPending}
              >
                {renameTarget?.kind === "layout" && rename.isPending
                  ? "Renaming…"
                  : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b bg-background px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <h1
            className="max-w-64 truncate text-sm font-semibold"
            title={layoutQuery.data?.name}
          >
            {layoutQuery.data?.name}
          </h1>
          {desktop ? (
            <Menubar
              aria-label="Layout editor commands"
              className="shrink-0 border-0 p-0 shadow-none"
            >
              <MenubarMenu>
                <MenubarTrigger ref={fileMenuTrigger}>File</MenubarTrigger>
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
                    Rename Layout…
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
                    Save now
                    <MenubarShortcut>Ctrl/⌘ S</MenubarShortcut>
                  </MenubarItem>
                  <MenubarSeparator />
                  <MenubarItem onClick={openPreview}>
                    <Scan aria-hidden="true" />
                    Preview
                  </MenubarItem>
                  <MenubarItem onClick={openHistory}>
                    <History aria-hidden="true" />
                    History…
                  </MenubarItem>
                  {canSubmit && (
                    <>
                      <MenubarSeparator />
                      <MenubarItem
                        disabled={saveState !== "saved" || publish.isPending}
                        onClick={() => publish.mutate()}
                      >
                        {canPublish ? "Publish" : "Submit for review"}
                      </MenubarItem>
                    </>
                  )}
                </MenubarContent>
              </MenubarMenu>
              <MenubarMenu>
                <MenubarTrigger>Edit</MenubarTrigger>
                <MenubarContent className="min-w-52">
                  <MenubarItem disabled={!past.length} onClick={undo}>
                    Undo
                    <MenubarShortcut>Ctrl/⌘ Z</MenubarShortcut>
                  </MenubarItem>
                  <MenubarItem disabled={!future.length} onClick={redo}>
                    Redo
                    <MenubarShortcut>Ctrl/⌘ ⇧ Z</MenubarShortcut>
                  </MenubarItem>
                  <MenubarSeparator />
                  <MenubarItem
                    disabled={!selection.size}
                    onClick={copySelection}
                  >
                    Copy
                    <MenubarShortcut>Ctrl/⌘ C</MenubarShortcut>
                  </MenubarItem>
                  <MenubarItem
                    disabled={!clipboard.current.length}
                    onClick={pasteClipboard}
                  >
                    Paste
                    <MenubarShortcut>Ctrl/⌘ V</MenubarShortcut>
                  </MenubarItem>
                  <MenubarItem
                    disabled={!selection.size}
                    onClick={duplicateSelection}
                  >
                    Duplicate
                    <MenubarShortcut>Ctrl/⌘ D</MenubarShortcut>
                  </MenubarItem>
                  <MenubarSeparator />
                  <MenubarItem
                    disabled={!document.placements.length}
                    onClick={selectAll}
                  >
                    Select all
                    <MenubarShortcut>Ctrl/⌘ A</MenubarShortcut>
                  </MenubarItem>
                  <MenubarItem
                    disabled={!selection.size}
                    onClick={() => setSelection(new Set())}
                  >
                    Deselect
                  </MenubarItem>
                  <MenubarItem
                    disabled={!selection.size}
                    variant="destructive"
                    onClick={deleteSelection}
                  >
                    Delete selection
                    <MenubarShortcut>Del</MenubarShortcut>
                  </MenubarItem>
                </MenubarContent>
              </MenubarMenu>
              <MenubarMenu>
                <MenubarTrigger>Arrange</MenubarTrigger>
                <MenubarContent className="min-w-52">
                  <MenubarItem
                    disabled={selection.size < 2}
                    onClick={groupSelection}
                  >
                    Group selection
                    <MenubarShortcut>Ctrl/⌘ G</MenubarShortcut>
                  </MenubarItem>
                  <MenubarItem
                    disabled={
                      !selected.some((item) => item.primitive?.kind === "group")
                    }
                    onClick={ungroupSelection}
                  >
                    Ungroup
                  </MenubarItem>
                  <MenubarSub>
                    <MenubarSubTrigger disabled={!selected.length}>
                      Layer order
                    </MenubarSubTrigger>
                    <MenubarSubContent>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => arrangeSelection("front")}
                      >
                        Bring to front
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => arrangeSelection("forward")}
                      >
                        Bring forward
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => arrangeSelection("backward")}
                      >
                        Send backward
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => arrangeSelection("back")}
                      >
                        Send to back
                      </MenubarItem>
                    </MenubarSubContent>
                  </MenubarSub>
                  <MenubarSub>
                    <MenubarSubTrigger disabled={!selected.length}>
                      Align selection
                    </MenubarSubTrigger>
                    <MenubarSubContent>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => alignSelection("left")}
                      >
                        Align left
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => alignSelection("hcenter")}
                      >
                        Horizontal centres
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => alignSelection("right")}
                      >
                        Align right
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => alignSelection("top")}
                      >
                        Align top
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => alignSelection("vmiddle")}
                      >
                        Vertical centres
                      </MenubarItem>
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={() => alignSelection("bottom")}
                      >
                        Align bottom
                      </MenubarItem>
                      <MenubarSeparator />
                      <MenubarItem
                        disabled={selected.length < 3}
                        onClick={() => distributeSelection("horizontal")}
                      >
                        Distribute horizontally
                      </MenubarItem>
                      <MenubarItem
                        disabled={selected.length < 3}
                        onClick={() => distributeSelection("vertical")}
                      >
                        Distribute vertically
                      </MenubarItem>
                      <MenubarSeparator />
                      <MenubarItem
                        disabled={!selected.length}
                        onClick={fillCanvas}
                      >
                        Fill canvas
                      </MenubarItem>
                    </MenubarSubContent>
                  </MenubarSub>
                  <MenubarSeparator />
                  <MenubarItem
                    disabled={!selected.length}
                    onClick={() => toggleSelectionFlag("locked")}
                  >
                    {selected.some((item) => item.locked) ? "Unlock" : "Lock"}{" "}
                    selection
                  </MenubarItem>
                  <MenubarItem
                    disabled={!selected.length}
                    onClick={() => toggleSelectionFlag("visible")}
                  >
                    {selected.some((item) => !item.visible)
                      ? "Show selection"
                      : "Hide selection"}
                  </MenubarItem>
                </MenubarContent>
              </MenubarMenu>
              <MenubarMenu>
                <MenubarTrigger>View</MenubarTrigger>
                <MenubarContent className="min-w-52">
                  <MenubarCheckboxItem
                    checked={snap}
                    onCheckedChange={(checked) => setSnap(checked)}
                  >
                    Snap to grid
                  </MenubarCheckboxItem>
                  <MenubarCheckboxItem
                    checked={safeArea}
                    onCheckedChange={(checked) => setSafeArea(checked)}
                  >
                    Show safe area
                  </MenubarCheckboxItem>
                  <MenubarSeparator />
                  <MenubarItem onClick={zoomOut}>Zoom out</MenubarItem>
                  <MenubarItem onClick={zoomIn}>Zoom in</MenubarItem>
                  <MenubarItem onClick={fitZoom}>
                    Fit canvas to view
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
                    aria-label="Layout file actions"
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
                  Rename Layout…
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
                  Save now
                </DropdownMenuItem>
                <DropdownMenuItem onClick={openHistory}>
                  <History aria-hidden="true" />
                  History…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <ButtonGroup aria-label="Undo and redo">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Undo"
                  onClick={undo}
                  disabled={!past.length}
                />
              }
            >
              <Undo2 aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>
              Undo <Kbd>Ctrl+Z</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Redo"
                  onClick={redo}
                  disabled={!future.length}
                />
              }
            >
              <Redo2 aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>
              Redo <Kbd>Ctrl+Shift+Z</Kbd>
            </TooltipContent>
          </Tooltip>
        </ButtonGroup>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LayoutSaveStatus state={saveState} onRetry={() => void save()} />
          <Separator orientation="vertical" className="mx-1 h-5 self-center" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openPreview}
          >
            <Scan aria-hidden="true" />
            Preview
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
              {canPublish ? "Publish" : "Submit for review"}
            </Button>
          )}
        </div>
      </div>
      {saveState === "conflict" && (
        <Alert
          variant="destructive"
          className="shrink-0 rounded-none border-x-0 border-t-0"
        >
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>This Layout changed somewhere else</AlertTitle>
          <AlertDescription>
            Reload to continue from the latest draft. Edits made here since the
            last save cannot be saved over it.
          </AlertDescription>
          <AlertAction>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </Button>
          </AlertAction>
        </Alert>
      )}
      {desktop ? (
        // Three stable panes: the inspector always exists, showing Layout
        // settings until something is selected, so selecting never resizes
        // the canvas.
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          role="group"
          aria-label="Layout library, canvas, and inspector"
        >
          <ResizablePanel
            id="layout-library-pane"
            defaultSize="24%"
            minSize="16%"
            maxSize="36%"
            className="min-h-0 min-w-0"
          >
            {librarySidebar}
          </ResizablePanel>
          <ResizableHandle
            withHandle
            aria-label="Resize library and canvas panes"
          />
          <ResizablePanel
            id="layout-stage-pane"
            defaultSize="52%"
            minSize="30%"
            className="min-h-0 min-w-0"
          >
            {stage}
          </ResizablePanel>
          <ResizableHandle
            withHandle
            aria-label="Resize canvas and inspector panes"
          />
          <ResizablePanel
            id="layout-inspector-pane"
            defaultSize="24%"
            minSize="18%"
            maxSize="36%"
            className="min-h-0 min-w-0"
          >
            <aside
              aria-label={primary ? "Layer inspector" : "Layout settings"}
              className="h-full overflow-y-auto bg-background"
            >
              {primary ? (
                <>
                  <LayoutPaneHeading
                    title="Inspector"
                    meta={`${selected.length} selected`}
                  />
                  <div className="p-3">{placementInspector}</div>
                </>
              ) : (
                <>
                  <LayoutPaneHeading title="Layout settings" />
                  {layoutSettings}
                </>
              )}
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <>
          {librarySidebar}
          {stage}
        </>
      )}
      {/* Keep the selected picker mounted until its generated Dialog completes closing. */}
      {(picker === "media" || picker === "widgets") && (
        <ContentPicker
          open={pickerOpen}
          mode="multiple"
          csrf={csrf}
          allowedTypes={picker === "widgets" ? ["widget"] : ["image", "video"]}
          title={picker === "widgets" ? "Choose apps" : "Choose media"}
          description={
            picker === "widgets"
              ? "Add an app to the canvas. Apps keep rendering live once the Layout is published."
              : "Add images or video to the canvas. Anything you upload here lands in your library too."
          }
          confirmLabel="Add to canvas"
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
          description="Add a playlist zone that loops independently inside this Layout."
          confirmLabel="Add to canvas"
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
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent
          className="layout-preview-overlay"
          showCloseButton={false}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>
              Preview {layoutQuery.data?.name ?? "Layout"}
            </DialogTitle>
            <DialogDescription>
              Playback preview of the current Layout.
            </DialogDescription>
          </DialogHeader>
          <div className="layout-preview-toolbar">
            <strong>{layoutQuery.data?.name}</strong>
            <span>
              {document.canvas.width} × {document.canvas.height}
            </span>
            <DateInput
              id="layout-preview-date"
              aria-label="Preview date"
              value={previewDate}
              onChange={(date) => {
                setPreviewDate(date);
                void loadLayoutPreview(date);
              }}
            />
            {previewLoading && (
              <span className="layout-preview-status">Loading content…</span>
            )}
            {!previewLoading && previewError && (
              <span className="layout-preview-status layout-preview-status--warning">
                {previewError}
              </span>
            )}
            <Button variant="secondary" onClick={() => setPreview(false)}>
              Close preview
            </Button>
          </div>
          <div
            ref={setPreviewFrame}
            className="layout-preview-frame"
            style={{
              aspectRatio: `${document.canvas.width}/${document.canvas.height}`,
              backgroundColor: document.canvas.backgroundColor,
            }}
          >
            {document.canvas.backgroundAssetId &&
              previewContentByID.get(document.canvas.backgroundAssetId)
                ?.type === "image" && (
                <img
                  className="layout-preview-background"
                  src={api.assetPreviewUrl(document.canvas.backgroundAssetId)}
                  alt=""
                />
              )}
            {previewScale > 0 &&
              [...document.placements]
                .sort((a, b) => a.layer - b.layer)
                .map((item) => (
                  <PlacementView
                    key={item.id}
                    item={item}
                    canvas={document.canvas}
                    content={
                      item.widgetId
                        ? previewContentByID.get(item.widgetId)
                        : item.assetId
                          ? previewContentByID.get(item.assetId)
                          : undefined
                    }
                    playlist={
                      item.playlistId
                        ? previewPlaylistByID.get(item.playlistId)
                        : undefined
                    }
                    assetsById={previewContentByID}
                    previewValues={previewValues}
                    live={liveData}
                    previewScale={previewScale}
                    playbackPreview
                  />
                ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent
          finalFocus={fileMenuTrigger}
          className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"
        >
          <DialogHeader>
            <DialogTitle>Published revisions</DialogTitle>
            <DialogDescription>
              Restoring creates a new editable draft.
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
                      <ItemTitle>Revision {revision.revision}</ItemTitle>
                      <ItemDescription>
                        {new Date(revision.publishedAt).toLocaleString()}·
                        digest {revision.documentSha256.slice(0, 12)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => restore.mutate(revision.id)}
                      >
                        Restore as draft
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <Empty className="border-0 py-6">
                <EmptyHeader>
                  <EmptyTitle>No published revisions yet</EmptyTitle>
                  <EmptyDescription>
                    Publish this Layout to start a revision history.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHistoryOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PlacementView({
  item,
  canvas,
  content,
  playlist,
  assetsById,
  previewValues,
  live,
  previewScale = 0,
  playbackPreview = false,
  selected = false,
  onPointerDown,
  onResize,
  onContextMenu,
}: {
  item: LayoutPlacement;
  canvas: LayoutDocument["canvas"];
  content?: Asset;
  playlist?: Playlist;
  assetsById?: Map<string, Asset>;
  previewValues?: Record<string, Record<string, string>>;
  live?: LivePreviewData;
  previewScale?: number;
  playbackPreview?: boolean;
  selected?: boolean;
  onPointerDown?: (event: ReactPointerEvent) => void;
  onResize?: (event: ReactPointerEvent) => void;
  onContextMenu?: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  if (!item.visible) return null;
  const primitive = item.primitive;
  const style: React.CSSProperties = {
    left: `${(item.x / canvas.width) * 100}%`,
    top: `${(item.y / canvas.height) * 100}%`,
    width: `${(item.width / canvas.width) * 100}%`,
    height: `${(item.height / canvas.height) * 100}%`,
    zIndex: item.layer,
    opacity: item.opacity,
  };
  return (
    <div
      className={`layout-placement ${selected ? "is-selected" : ""} ${item.locked ? "is-locked" : ""}`}
      style={style}
      onPointerDown={onPointerDown}
      // Capture phase so the menu target is set before the Base UI trigger opens.
      onContextMenuCapture={onContextMenu}
    >
      {item.type === "playlistZone" ? (
        playbackPreview && playlist?.items?.length ? (
          <PlaylistZonePreview
            placement={item}
            playlist={playlist}
            assetsById={assetsById ?? new Map()}
            live={live ?? {}}
            scale={previewScale}
          />
        ) : playlist?.items?.[0]?.thumbnailUrl ? (
          <img
            className="layout-asset-placement"
            src={playlist.items[0].thumbnailUrl}
            alt=""
            draggable={false}
            style={assetPreviewStyle(
              item.playback?.fit,
              item.playback?.cornerRadius,
            )}
          />
        ) : (
          <div className="layout-playlist-zone">
            <ListVideo size={22} />
            <strong>{playlist?.name ?? item.name}</strong>
            <span>{playlist?.itemCount ?? 0} items · independent loop</span>
          </div>
        )
      ) : item.type === "asset" ? (
        playbackPreview && content ? (
          <AssetPlaybackPreview asset={content} placement={item} />
        ) : content?.thumbnailUrl ? (
          <img
            className="layout-asset-placement"
            src={content.thumbnailUrl}
            alt=""
            draggable={false}
            style={assetPreviewStyle(
              item.playback?.fit,
              item.playback?.cornerRadius,
            )}
          />
        ) : (
          <div className="layout-placement-placeholder">
            <ImageIcon size={22} />
            <span>{content?.name ?? item.name}</span>
          </div>
        )
      ) : item.type === "widget" ? (
        live && content?.widget ? (
          <WidgetLivePreview
            asset={content}
            item={item}
            live={live}
            scale={previewScale}
          />
        ) : (
          <AppPlacementPreview asset={content} item={item} />
        )
      ) : primitive?.kind === "text" ? (
        <div
          className="layout-text-primitive"
          style={{
            fontFamily: layoutFontStack(primitive.fontFamily),
            fontSize: `${((primitive.fontSize ?? 48) / canvas.width) * 100}cqw`,
            fontWeight: primitive.fontWeight,
            textAlign: primitive.textAlign,
            color: primitive.color,
            backgroundColor: primitive.backgroundColor,
            lineHeight: primitive.lineHeight,
            letterSpacing: primitive.letterSpacing,
            padding: `${((primitive.padding ?? 0) / canvas.width) * 100}cqw`,
            border: `${primitive.borderWidth ?? 0}px solid ${primitive.borderColor ?? "transparent"}`,
            borderRadius: `${primitive.cornerRadius ?? 0}px`,
            justifyContent:
              primitive.verticalAlign === "top"
                ? "flex-start"
                : primitive.verticalAlign === "bottom"
                  ? "flex-end"
                  : "center",
            WebkitLineClamp: primitive.maximumLines,
            overflow: primitive.overflow === "clip" ? "hidden" : "hidden",
          }}
        >
          {primitive.binding
            ? (() => {
                const binding = primitive.binding;
                const value =
                  previewValues?.[binding.dataSourceId]?.[binding.field];
                return value
                  ? `${binding.prefix ?? ""}${value}${binding.suffix ?? ""}`
                  : binding.fallbackText ||
                      `${binding.prefix ?? ""}{{${binding.field}}}${binding.suffix ?? ""}`;
              })()
            : primitive.text}
        </div>
      ) : primitive?.kind === "circle" ? (
        <div
          className="layout-shape layout-shape--circle"
          style={{
            background: primitive.fillColor,
            border: `${primitive.strokeWidth ?? 0}px solid ${primitive.strokeColor ?? "transparent"}`,
          }}
        />
      ) : primitive?.kind === "line" ? (
        <div
          className="layout-line"
          style={{
            height: `${Math.max(1, primitive.strokeWidth ?? 4)}px`,
            background: primitive.strokeColor,
          }}
        />
      ) : primitive?.kind === "group" ? (
        <div className="layout-group-outline">
          <Group size={18} />
          <span>{item.name}</span>
        </div>
      ) : (
        <div
          className="layout-shape"
          style={{
            background: primitive?.fillColor,
            border: `${primitive?.strokeWidth ?? 0}px solid ${primitive?.strokeColor ?? "transparent"}`,
            borderRadius: `${primitive?.cornerRadius ?? 0}px`,
          }}
        />
      )}
      {selected && !item.locked && onResize && (
        <Button
          type="button"
          variant="outline"
          size="icon-xs"
          className="layout-resize-handle"
          aria-label="Resize"
          onPointerDown={onResize}
        />
      )}
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
}: {
  state: SaveState;
  onRetry: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        role="status"
        className={cn(
          "flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5",
          (state === "error" || state === "conflict") && "text-destructive",
        )}
      >
        {state === "saving" ? (
          <>
            <Spinner aria-hidden="true" />
            Saving…
          </>
        ) : state === "unsaved" ? (
          <>
            <CircleDot aria-hidden="true" />
            Unsaved
          </>
        ) : state === "error" ? (
          <>
            <CircleAlert aria-hidden="true" />
            Not saved
          </>
        ) : state === "conflict" ? (
          <>
            <TriangleAlert aria-hidden="true" />
            Reload required
          </>
        ) : (
          <>
            <CloudCheck aria-hidden="true" />
            Saved
          </>
        )}
      </span>
      {state === "error" && (
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
