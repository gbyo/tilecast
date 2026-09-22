import { ContextMenu, Select, useContextMenu } from "../components/ui";
import type { ContextMenuItem } from "../components/ui";
import { ContentPicker, PlaylistPicker } from "../components/content-picker";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlignCenter,
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
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Group,
  History,
  Image as ImageIcon,
  Layers,
  Lock,
  LockOpen,
  ListVideo,
  Magnet,
  Maximize2,
  Minus,
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
  Type,
  Undo2,
  Ungroup,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import QRCode from "qrcode";
import { api, ApiError } from "../api/client";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
import type {
  Asset,
  CalendarEvent,
  CalendarPreview,
  ClockWidgetConfig,
  DataSourceProvider,
  DataSource,
  DateWidgetConfig,
  DisplayWidgetConfig,
  LayoutDocument,
  LayoutPlacement,
  LayoutPrimitive,
  Playlist,
  PlaylistItem,
  QRCodeWidgetConfig,
  StructuredPreview,
  StructuredRecord,
  TickerWidgetConfig,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  ConnectDataNotice,
  DataSourcePicker,
} from "../content/DataSourcePicker";
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

// Resolved live data for one Data Source, keyed by its id, shared by every
// widget/binding that references it so the preview mirrors the Player.
type LivePreviewSource = {
  provider: DataSourceProvider;
  records?: StructuredRecord[];
  events?: CalendarEvent[];
  emptyState: string;
};
type LivePreviewData = Record<string, LivePreviewSource>;

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
  const { prompt } = useSpectrumDialogs();
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
  const previewFrameRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [picker, setPicker] = useState<"media" | "widgets" | "playlists">();
  // Anything chosen through a picker can live outside the shelf query's first page, so
  // it is cached here and merged into the lookups the canvas renders from.
  const [pickedAssets, setPickedAssets] = useState<Asset[]>([]);
  const [pickedPlaylists, setPickedPlaylists] = useState<Playlist[]>([]);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const canvasRef = useRef<HTMLDivElement>(null);
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
    const frame = previewFrameRef.current;
    if (!preview || !frame || !document) return;
    const measure = () =>
      setPreviewScale(frame.clientWidth / document.canvas.width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [preview, document]);
  const publish = useMutation<unknown, ApiError>({
    mutationFn: () =>
      canPublish
        ? api.publishLayout(id, serverRevision, csrf)
        : api.submitContent("layout", id, csrf, undefined, serverRevision),
    onSuccess: () => {
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
      void queryClient.invalidateQueries({ queryKey: ["layout", id] });
      void queryClient.invalidateQueries({ queryKey: ["layouts"] });
    },
  });
  const restore = useMutation({
    mutationFn: (revisionId: string) =>
      api.restoreLayoutRevision(id, revisionId, serverRevision, csrf),
    onSuccess: (saved) => {
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
  const renamePlacement = useCallback(
    async (target: LayoutPlacement) => {
      const answer = await prompt({
        title: "Rename layer",
        label: "Layer name",
        defaultValue: target.name,
        confirmLabel: "Rename layer",
      });
      if (answer === null) return;
      const name = answer.trim();
      if (!name || name === target.name) return;
      update((draft) => {
        const item = draft.placements.find((one) => one.id === target.id);
        if (item) item.name = name;
      });
    },
    [prompt, update],
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
  const menu = useContextMenu<LayoutMenuTarget>();
  const openPlacementMenu = (
    event: ReactMouseEvent<HTMLElement>,
    item: LayoutPlacement,
  ) => {
    // Right-clicking outside the current selection retargets it, so the commands in the
    // menu always act on what the user just pointed at.
    if (!selection.has(item.id)) setSelection(new Set([item.id]));
    menu.open(event, { kind: "placement", item });
  };
  const placementMenuItems = (target: LayoutPlacement): ContextMenuItem[] => {
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
  const canvasMenuItems = (): ContextMenuItem[] => [
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
      <div className="empty-state">
        <h2>Layout unavailable</h2>
        <button className="button" onClick={() => void navigate("/layouts")}>
          Back to Layouts
        </button>
      </div>
    );
  if (layoutQuery.isLoading || !document)
    return <p className="status-copy">Loading Layout editor…</p>;
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
  return (
    <div className="layout-editor">
      <div className="layout-editor-toolbar">
        <strong>{layoutQuery.data?.name}</strong>
        <button
          className="icon-button"
          title="Rename Layout"
          aria-label={`Rename ${layoutQuery.data?.name ?? "Layout"}`}
          onClick={async () => {
            const next = await prompt({
              title: "Rename Layout",
              label: "Layout name",
              defaultValue: layoutQuery.data?.name ?? "",
              confirmLabel: "Rename Layout",
            });
            if (next?.trim() && next.trim() !== layoutQuery.data?.name)
              rename.mutate(next.trim());
          }}
          disabled={rename.isPending}
        >
          <Pencil size={16} />
        </button>
        <span className="toolbar-divider" />
        <button
          className="icon-button"
          title="Undo"
          onClick={undo}
          disabled={!past.length}
        >
          <Undo2 size={17} />
        </button>
        <button
          className="icon-button"
          title="Redo"
          onClick={redo}
          disabled={!future.length}
        >
          <Redo2 size={17} />
        </button>
        <span className="toolbar-divider" />
        <button
          className="button button--compact button--secondary"
          onClick={() => {
            setPreview(true);
            void loadLayoutPreview();
          }}
        >
          <Scan size={16} />
          Preview
        </button>
        <button
          className="button button--compact button--secondary"
          onClick={() => {
            setHistoryOpen(true);
            void revisions.refetch();
          }}
        >
          <History size={16} />
          History
        </button>
        <button
          type="button"
          className={`layout-save-state layout-save-state--${saveState}`}
          onClick={() => void save()}
          disabled={
            saveState === "saved" ||
            saveState === "saving" ||
            saveState === "conflict"
          }
          title={
            saveState === "error"
              ? "Try saving again"
              : saveState === "unsaved"
                ? "Save now (Ctrl/Command + S)"
                : undefined
          }
          aria-live="polite"
        >
          <Save size={14} />
          {saveState === "saved"
            ? "Saved"
            : saveState === "saving"
              ? "Saving…"
              : saveState === "conflict"
                ? "Reload required"
                : saveState === "error"
                  ? "Retry save"
                  : "Save now"}
        </button>
        {canSubmit && (
          <button
            className="button button--compact button--primary"
            disabled={saveState !== "saved" || publish.isPending}
            onClick={() => publish.mutate()}
          >
            {publish.isPending
              ? canPublish
                ? "Publishing…"
                : "Submitting…"
              : canPublish
                ? "Publish"
                : "Submit for review"}
          </button>
        )}
      </div>
      <aside className="layout-editor-left">
        <nav className="layout-sidebar-nav" aria-label="Layout builder">
          {(
            [
              ["media", "Media", ImageIcon],
              ["widgets", "Widgets", AppWindow],
              ["playlists", "Playlists", ListVideo],
              ["elements", "Elements", RectangleHorizontal],
              ["layers", "Layers", BoxSelect],
              ["settings", "Settings", Settings],
            ] as const
          ).map(([section, label, Icon]) => (
            <button
              key={section}
              type="button"
              className={sidebarSection === section ? "is-active" : ""}
              aria-pressed={sidebarSection === section}
              onClick={() => setSidebarSection(section)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="layout-sidebar-panel">
          {(sidebarSection === "media" ||
            sidebarSection === "widgets" ||
            sidebarSection === "playlists") && (
            <>
              <div className="layout-panel-heading">
                <strong>
                  {
                    {
                      media: "Media",
                      widgets: "Widgets",
                      playlists: "Playlists",
                    }[sidebarSection]
                  }
                </strong>
              </div>
              <button
                type="button"
                className="button button--primary layout-library-browse"
                onClick={() => setPicker(sidebarSection)}
              >
                <Search size={16} />
                {
                  {
                    media: "Browse media library",
                    widgets: "Browse apps",
                    playlists: "Browse playlists",
                  }[sidebarSection]
                }
              </button>
              <div className="layout-panel-heading layout-panel-heading--sub">
                <strong>Recent</strong>
                <span>Drag to canvas</span>
              </div>
              <div className="layout-content-shelf">
                {recentLibraryItems.map((item) => {
                  const asset = item.kind === "asset" ? item.asset : undefined;
                  const playlist =
                    item.kind === "playlist" ? item.playlist : undefined;
                  const name = asset?.name ?? playlist?.name ?? "";
                  return (
                    <button
                      key={`${item.kind}-${asset?.id ?? playlist?.id}`}
                      draggable
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
                      title={`Add ${name}`}
                    >
                      <span className="layout-content-shelf__preview">
                        {asset?.thumbnailUrl ? (
                          <img
                            src={asset.thumbnailUrl}
                            alt=""
                            draggable={false}
                          />
                        ) : asset?.type === "widget" ? (
                          <AppWindow size={18} />
                        ) : playlist ? (
                          <ListVideo size={18} />
                        ) : (
                          <ImageIcon size={18} />
                        )}
                      </span>
                      <span>
                        <strong>{name}</strong>
                        <small>
                          {playlist
                            ? `${playlist.itemCount} items`
                            : (asset?.widget?.provider ?? asset?.type)}
                        </small>
                      </span>
                    </button>
                  );
                })}
                {!recentLibraryItems.length && (
                  <p className="layout-content-shelf__empty">
                    No recently created {sidebarSection}. Use the browse button
                    above to search the whole library.
                  </p>
                )}
              </div>
            </>
          )}
          {sidebarSection === "elements" && (
            <>
              <div className="layout-panel-heading">
                <strong>Elements</strong>
              </div>
              <div className="layout-add-grid">
                <button onClick={() => addPrimitive("text")}>
                  <Type size={20} />
                  Text
                </button>
                <button onClick={() => addPrimitive("rectangle")}>
                  <RectangleHorizontal size={20} />
                  Rectangle
                </button>
                <button onClick={() => addPrimitive("circle")}>
                  <Circle size={20} />
                  Circle
                </button>
                <button onClick={() => addPrimitive("line")}>
                  <Minus size={20} />
                  Line
                </button>
              </div>
            </>
          )}
          {sidebarSection === "layers" && (
            <>
              <div className="layout-panel-heading">
                <strong>Layers</strong>
                <span>{document.placements.length}</span>
              </div>
              <div className="layout-layers">
                {[...document.placements]
                  .sort((a, b) => b.layer - a.layer)
                  .map((item) => (
                    <button
                      key={item.id}
                      className={selection.has(item.id) ? "is-selected" : ""}
                      onClick={(event) =>
                        setSelection(
                          new Set(
                            event.shiftKey
                              ? [...selection, item.id]
                              : [item.id],
                          ),
                        )
                      }
                      onContextMenu={(event) => openPlacementMenu(event, item)}
                    >
                      <span className="layout-layer-icon">
                        {item.primitive?.kind === "text" ? (
                          <Type size={14} />
                        ) : item.primitive?.kind === "group" ? (
                          <Group size={14} />
                        ) : (
                          <BoxSelect size={14} />
                        )}
                      </span>
                      <span>{item.name}</span>
                      <span className="layout-layer-actions">
                        <span
                          role="button"
                          tabIndex={0}
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
                            <Eye size={13} />
                          ) : (
                            <EyeOff size={13} />
                          )}
                        </span>
                        <span
                          role="button"
                          tabIndex={0}
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
                            <Lock size={13} />
                          ) : (
                            <LockOpen size={13} />
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
              </div>
              {primary && (
                <div className="layout-layer-inspector">
                  <div className="layout-panel-heading">
                    <strong>Selected layer</strong>
                    <span>{selected.length} selected</span>
                  </div>
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
                      primary.playlistId
                        ? playlistByID.get(primary.playlistId)
                        : undefined
                    }
                    dataSources={dataSources}
                    update={(change) => mutateSelected(change)}
                    duplicate={duplicateSelection}
                    group={groupSelection}
                    ungroup={ungroupSelection}
                    canGroup={selection.size > 1}
                  />
                </div>
              )}
            </>
          )}
          {sidebarSection === "settings" && (
            <>
              <div className="layout-panel-heading">
                <strong>Layout settings</strong>
              </div>
              <CanvasInspector document={document} update={update} />
              {layoutQuery.data && (
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
              )}
            </>
          )}
        </div>
      </aside>
      <main className="layout-stage">
        <div className="layout-stage-controls">
          <button
            className="icon-button"
            onClick={() => setZoom((value) => Math.max(0.25, value - 0.1))}
            title="Zoom out"
          >
            <ZoomOut size={16} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            className="icon-button"
            onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}
            title="Zoom in"
          >
            <ZoomIn size={16} />
          </button>
          <label>
            <input
              type="checkbox"
              checked={snap}
              onChange={(event) => setSnap(event.target.checked)}
            />
            Snap
          </label>
          <label>
            <input
              type="checkbox"
              checked={safeArea}
              onChange={(event) => setSafeArea(event.target.checked)}
            />
            Safe area
          </label>
        </div>
        <div
          className="layout-stage-scroll"
          onPointerDown={(event) => {
            if (event.button === 0) setSelection(new Set());
          }}
          onContextMenu={(event) => menu.open(event, { kind: "canvas" })}
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
                style={{ left: `${(guides.x / document.canvas.width) * 100}%` }}
              />
            )}
            {guides.y !== undefined && (
              <span
                className="layout-guide layout-guide--horizontal"
                style={{ top: `${(guides.y / document.canvas.height) * 100}%` }}
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
        </div>
      </main>
      {/* Mounted on demand, like the playlist editor: the picker keeps its search and
          selection in local state, so a fresh mount is the reset. */}
      {(picker === "media" || picker === "widgets") && (
        <ContentPicker
          open
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
            setPicker(undefined);
          }}
          onClose={() => setPicker(undefined)}
          onCreateWidget={() =>
            void navigate(
              `/widgets/new?returnTo=${encodeURIComponent(location.pathname)}`,
            )
          }
        />
      )}
      {picker === "playlists" && (
        <PlaylistPicker
          open
          description="Add a playlist zone that loops independently inside this Layout."
          confirmLabel="Add to canvas"
          onConfirm={(choice) => {
            if (choice.kind === "playlist") addPlaylistZone(choice.playlist);
            setPicker(undefined);
          }}
          onClose={() => setPicker(undefined)}
        />
      )}
      {menu.anchor && (
        <ContextMenu
          x={menu.anchor.x}
          y={menu.anchor.y}
          label={
            menu.anchor.target.kind === "placement"
              ? `Actions for ${menu.anchor.target.item.name}`
              : "Canvas actions"
          }
          items={
            menu.anchor.target.kind === "placement"
              ? placementMenuItems(menu.anchor.target.item)
              : canvasMenuItems()
          }
          onClose={menu.close}
        />
      )}
      {preview && (
        <div className="layout-preview-overlay" role="dialog" aria-modal="true">
          <div className="layout-preview-toolbar">
            <strong>{layoutQuery.data?.name}</strong>
            <span>
              {document.canvas.width} × {document.canvas.height}
            </span>
            <input
              type="date"
              aria-label="Preview date"
              value={previewDate}
              onChange={(event) => {
                const date = event.target.value;
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
            <button
              className="button button--secondary"
              onClick={() => setPreview(false)}
            >
              Close preview
            </button>
          </div>
          <div
            ref={previewFrameRef}
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
        </div>
      )}
      {historyOpen && (
        <div className="details-backdrop">
          <section
            className="asset-details layout-history"
            role="dialog"
            aria-modal="true"
          >
            <header>
              <div>
                <h2>Published revisions</h2>
                <p>Restoring creates a new editable draft.</p>
              </div>
            </header>
            <div className="source-editor__body">
              {revisions.isLoading ? (
                <p>Loading history…</p>
              ) : revisions.data?.items?.length ? (
                revisions.data.items.map((revision) => (
                  <div className="layout-history-row" key={revision.id}>
                    <div>
                      <strong>Revision {revision.revision}</strong>
                      <span>
                        {new Date(revision.publishedAt).toLocaleString()}
                      </span>
                      <code>{revision.documentSha256.slice(0, 12)}</code>
                    </div>
                    <button
                      className="button button--secondary"
                      onClick={() => restore.mutate(revision.id)}
                    >
                      Restore as draft
                    </button>
                  </div>
                ))
              ) : (
                <p>No published revisions yet.</p>
              )}
            </div>
            <footer>
              <button
                className="button button--secondary"
                onClick={() => setHistoryOpen(false)}
              >
                Close
              </button>
            </footer>
          </section>
        </div>
      )}
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
      onContextMenu={onContextMenu}
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
        <button
          className="layout-resize-handle"
          aria-label="Resize"
          onPointerDown={onResize}
        />
      )}
    </div>
  );
}

function assetPreviewStyle(
  fit: NonNullable<LayoutPlacement["playback"]>["fit"],
  cornerRadius?: number,
): React.CSSProperties {
  return {
    objectFit:
      fit === "cover" ? "cover" : fit === "stretch" ? "fill" : "contain",
    borderRadius: cornerRadius,
  };
}

function AssetPlaybackPreview({
  asset,
  placement,
}: {
  asset: Asset;
  placement: LayoutPlacement;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id]);
  if (failed || (asset.type !== "image" && asset.type !== "video"))
    return (
      <div className="layout-placement-placeholder">
        <ImageIcon size={22} />
        <span>{asset.name}</span>
      </div>
    );
  const common = {
    className: "layout-asset-placement layout-asset-placement--playback",
    src: api.assetPreviewUrl(asset.id),
    style: assetPreviewStyle(
      placement.playback?.fit,
      placement.playback?.cornerRadius,
    ),
    onError: () => setFailed(true),
  };
  if (asset.type === "video")
    return (
      <video
        {...common}
        autoPlay
        playsInline
        loop={placement.playback?.loop ?? true}
        muted={placement.playback?.muted ?? true}
        preload="auto"
      />
    );
  return <img {...common} alt="" draggable={false} />;
}

export function playlistPreviewDuration(item: PlaylistItem) {
  if (item.durationMs && item.durationMs > 0) return item.durationMs;
  return item.assetType === "video" ? undefined : 10_000;
}

export function nextPlaylistPreviewIndex(
  index: number,
  length: number,
  loop: boolean,
) {
  if (!length) return 0;
  if (index + 1 >= length) return loop ? 0 : index;
  return index + 1;
}

function PlaylistZonePreview({
  placement,
  playlist,
  assetsById,
  live,
  scale,
}: {
  placement: LayoutPlacement;
  playlist: Playlist;
  assetsById: Map<string, Asset>;
  live: LivePreviewData;
  scale: number;
}) {
  const items = playlist.items.filter((item) => item.assetStatus === "ready");
  const [index, setIndex] = useState(0);
  const current = items[index % Math.max(1, items.length)];
  const asset = current ? assetsById.get(current.assetId) : undefined;
  const advance = useCallback(
    () =>
      setIndex((value) => {
        return nextPlaylistPreviewIndex(
          value,
          items.length,
          placement.playback?.loop !== false,
        );
      }),
    [items.length, placement.playback?.loop],
  );
  useEffect(() => setIndex(0), [playlist.id, playlist.revision]);
  useEffect(() => {
    if (!current) return;
    const duration = playlistPreviewDuration(current);
    if (!duration) return;
    const timer = window.setTimeout(advance, duration);
    return () => window.clearTimeout(timer);
  }, [advance, current]);

  if (!current)
    return (
      <div className="layout-playlist-zone">
        <ListVideo size={22} />
        <strong>{playlist.name}</strong>
        <span>No ready items</span>
      </div>
    );
  if (!asset)
    return (
      <div className="layout-placement-placeholder">
        <ListVideo size={22} />
        <span>{current.assetName}</span>
      </div>
    );
  const fit = placement.playback?.fit ?? current.fitMode;
  const radius = placement.playback?.cornerRadius;
  const className = `layout-playlist-preview${current.transition === "fade" || current.transition === "crossfade" ? " layout-playlist-preview--fade" : ""}`;
  if (asset.type === "widget")
    return (
      <div className={className} key={`${playlist.id}-${current.id}`}>
        {asset.widget ? (
          <WidgetLivePreview
            asset={asset}
            item={placement}
            live={live}
            scale={scale}
          />
        ) : (
          <AppPlacementPreview asset={asset} item={placement} />
        )}
      </div>
    );
  if (asset.type === "video")
    return (
      <video
        key={`${playlist.id}-${current.id}`}
        className={className}
        src={api.assetPreviewUrl(asset.id)}
        style={assetPreviewStyle(fit, radius)}
        autoPlay
        playsInline
        muted={(placement.playback?.muted ?? true) || !current.audioEnabled}
        preload="auto"
        onLoadedMetadata={(event) => {
          event.currentTarget.volume = current.volume;
          if (current.videoStartOffsetMs)
            event.currentTarget.currentTime = current.videoStartOffsetMs / 1000;
        }}
        onTimeUpdate={(event) => {
          if (
            current.videoEndOffsetMs &&
            event.currentTarget.currentTime >= current.videoEndOffsetMs / 1000
          )
            advance();
        }}
        onEnded={advance}
        onError={advance}
      />
    );
  return (
    <img
      key={`${playlist.id}-${current.id}`}
      className={className}
      src={api.assetPreviewUrl(asset.id)}
      style={assetPreviewStyle(fit, radius)}
      alt=""
      onError={advance}
    />
  );
}

function AppPlacementPreview({
  asset,
  item,
}: {
  asset?: Asset;
  item: LayoutPlacement;
}) {
  if (asset?.thumbnailUrl)
    return (
      <img
        className="layout-asset-placement"
        src={asset.thumbnailUrl}
        alt=""
        style={assetPreviewStyle(
          item.playback?.fit,
          item.playback?.cornerRadius,
        )}
      />
    );
  const provider = asset?.widget?.provider;
  const config = (asset?.widget?.configuration ?? {}) as Record<
    string,
    unknown
  >;
  const background =
    (item.overrides?.backgroundColor as string | undefined) ??
    (config.backgroundColor as string | undefined) ??
    "#18232D";
  const foreground =
    (item.overrides?.foregroundColor as string | undefined) ??
    (config.foregroundColor as string | undefined) ??
    "#F5F7FA";
  let value = asset?.name ?? item.name;
  if (provider === "clock") {
    const timezone =
      typeof config.timezone === "string" ? config.timezone : "UTC";
    value = new Intl.DateTimeFormat(undefined, {
      timeStyle: config.showSeconds ? "medium" : "short",
      timeZone: timezone,
    }).format(new Date());
  } else if (provider === "date") {
    const timezone =
      typeof config.timezone === "string" ? config.timezone : "UTC";
    value = new Intl.DateTimeFormat(undefined, {
      dateStyle:
        (config.format as "full" | "long" | "medium" | "short") ?? "full",
      timeZone: timezone,
    }).format(new Date());
  } else if (provider === "qrcode")
    value =
      typeof config.label === "string" && config.label
        ? config.label
        : "QR Code";
  else if (provider === "ticker")
    value = `${asset?.name ?? "Ticker"} · live data`;
  return (
    <div
      className={`layout-app-placement layout-app-placement--${provider ?? "unknown"}`}
      style={{
        background,
        color: foreground,
        alignItems:
          item.overrides?.alignment === "left"
            ? "flex-start"
            : item.overrides?.alignment === "right"
              ? "flex-end"
              : "center",
      }}
    >
      <span className="layout-app-placement__provider">
        {provider ?? "Widget"}
      </span>
      <strong>{value}</strong>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Faithful native-widget preview. Mirrors the Android Player's Compose renderers
// (apps/player-android/.../content/NativeWidgetPlayback.kt + CalendarPlayback.kt)
// so the Layout preview shows real live data laid out like the Player. Canvas
// pixel sizes are multiplied by `scale` (renderedFrameWidth / canvasWidth) to
// match how the Player scales the whole canvas onto the screen.
// ---------------------------------------------------------------------------

// The Player parses colors with android.graphics.Color.parseColor, which uses
// #AARRGGBB order and falls back to black on any failure.
function colorToCss(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  const argb = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{6})$/.exec(v);
  if (argb) {
    const alpha = argb[1] ?? "ff";
    const rgb = argb[2] ?? "000000";
    const a = parseInt(alpha, 16) / 255;
    const r = parseInt(rgb.slice(0, 2), 16);
    const g = parseInt(rgb.slice(2, 4), 16);
    const b = parseInt(rgb.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v)) return v;
  return fallback;
}

// The QR encoder needs solid #RRGGBB colors; drop any leading ARGB alpha.
function hex6(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v)) return v;
  if (/^#[0-9a-fA-F]{8}$/.test(v)) return `#${v.slice(3)}`;
  return fallback;
}

function structuredFieldValue(record: StructuredRecord, field: string): string {
  if (field === "title") return record.title ?? "";
  if (field === "subtitle") return record.subtitle ?? "";
  if (field === "date") return record.date ?? "";
  if (field === "author") return record.author ?? "";
  if (field === "description") return record.description ?? "";
  return record.values?.[field] ?? "";
}

function menuFieldLabel(field: string): string {
  const key = field.toLowerCase();
  if (
    ["option_2", "alternative", "secondary", "secondary_option"].includes(key)
  )
    return "Alternative";
  if (
    ["option_1", "primary", "primary_option", "entree", "entrée"].includes(key)
  )
    return "Entrée";
  return field.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function clockText(cfg: ClockWidgetConfig): string {
  const is24 = cfg.format === "24";
  return new Intl.DateTimeFormat(undefined, {
    timeZone: cfg.timezone || "UTC",
    hour12: !is24,
    hour: is24 ? "2-digit" : "numeric",
    minute: "2-digit",
    ...(cfg.showSeconds ? { second: "2-digit" as const } : {}),
  }).format(new Date());
}

function dateText(cfg: DateWidgetConfig): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: cfg.format || "full",
    timeZone: cfg.timezone || "UTC",
  }).format(new Date());
}

function tickerText(
  cfg: TickerWidgetConfig,
  source?: LivePreviewSource,
): string {
  const parts = (source?.records ?? [])
    .map((record) => structuredFieldValue(record, cfg.field || "title"))
    .filter((value) => value.trim().length > 0);
  return parts.length
    ? parts.join(cfg.separator || " • ")
    : source?.emptyState || "No items available";
}

export function widgetContentArea(
  item: Pick<LayoutPlacement, "width" | "height">,
  cfg: { contentPadding?: number },
) {
  const padding = Math.max(0, Math.min(40, cfg.contentPadding ?? 10)) / 100;
  return {
    width: item.width * (1 - padding * 2),
    height: item.height * (1 - padding * 2),
    horizontalPadding: item.width * padding,
    verticalPadding: item.height * padding,
  };
}

// Shrinks text to fit its box, matching the Player's FittedWidgetText.
function FittedText({
  text,
  color,
  fontPx,
  weight,
  maxLines = 1,
  textScale = 100,
}: {
  text: string;
  color: string;
  fontPx: number;
  weight: number;
  maxLines?: number;
  textScale?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = boxRef.current;
    const span = spanRef.current;
    if (!box || !span) return;
    const shrinkToFit = (from: number) => {
      let size = from;
      span.style.fontSize = `${size}px`;
      let guard = 0;
      while (
        guard++ < 80 &&
        size > 4 &&
        (span.scrollWidth > box.clientWidth + 1 ||
          span.scrollHeight > box.clientHeight + 1)
      ) {
        size = Math.max(4, size * 0.9);
        span.style.fontSize = `${size}px`;
      }
      return size;
    };
    // Automatic sizing is the bounds-first fit. An author scale multiplies that
    // — previously it was capped at 1, which made every scale above 100 percent
    // a no-op — and a second fit pass is the final guard against overflow.
    const automatic = shrinkToFit(fontPx);
    const authorScale = Math.max(25, Math.min(500, textScale)) / 100;
    if (authorScale !== 1) shrinkToFit(automatic * authorScale);
  }, [text, fontPx, maxLines, textScale]);
  return (
    <div ref={boxRef} className="wpv-fit-box">
      <span
        ref={spanRef}
        className={`wpv-fit ${maxLines > 1 ? "wpv-fit--multi" : ""}`}
        style={{ color, fontWeight: weight }}
      >
        {text}
      </span>
    </div>
  );
}

// Full-bleed background with content centered inside an inset, like CenteredWidget.
function CenteredWidget({
  background,
  item,
  scale,
  contentPadding,
  children,
}: {
  background: string;
  item: LayoutPlacement;
  scale: number;
  contentPadding?: number;
  children: React.ReactNode;
}) {
  const area = widgetContentArea(item, { contentPadding });
  return (
    <div
      className="wpv-root wpv-centered"
      style={{
        background,
        padding: `${area.verticalPadding * scale}px ${area.horizontalPadding * scale}px`,
      }}
    >
      {children}
    </div>
  );
}

function QrWidget({
  cfg,
  item,
  scale,
}: {
  cfg: QRCodeWidgetConfig;
  item: LayoutPlacement;
  scale: number;
}) {
  const [dataUrl, setDataUrl] = useState("");
  useEffect(() => {
    if (!cfg.value) {
      setDataUrl("");
      return;
    }
    void QRCode.toDataURL(cfg.value, {
      margin: 2,
      errorCorrectionLevel: { low: "L", medium: "M", quartile: "Q", high: "H" }[
        cfg.errorCorrection
      ] as "L" | "M" | "Q" | "H",
      color: {
        dark: hex6(cfg.foregroundColor, "#000000"),
        light: hex6(cfg.backgroundColor, "#ffffff"),
      },
      width: 480,
    })
      .then(setDataUrl)
      .catch(() => setDataUrl(""));
  }, [
    cfg.value,
    cfg.errorCorrection,
    cfg.foregroundColor,
    cfg.backgroundColor,
  ]);
  const area = widgetContentArea(item, cfg);
  const label = cfg.label?.trim();
  return (
    <div
      className="wpv-root wpv-qr"
      style={{
        background: colorToCss(cfg.backgroundColor, "#FFFFFF"),
        padding: `${area.verticalPadding * scale}px ${area.horizontalPadding * scale}px`,
        gap: area.height * scale * 0.025,
      }}
    >
      {dataUrl && <img className="wpv-qr__image" src={dataUrl} alt="" />}
      {label && (
        <div style={{ width: "100%", height: "18%" }}>
          <FittedText
            text={label}
            color={colorToCss(cfg.foregroundColor, "#000000")}
            fontPx={Math.max(area.width, area.height) * scale}
            weight={400}
            maxLines={2}
            textScale={cfg.textScale}
          />
        </div>
      )}
    </div>
  );
}

function MenuWidget({
  name,
  cfg,
  source,
  fg,
  bg,
  scale,
  item,
}: {
  name: string;
  cfg: DisplayWidgetConfig;
  source?: LivePreviewSource;
  fg: string;
  bg: string;
  scale: number;
  item: LayoutPlacement;
}) {
  const record = source?.records?.[0];
  const values = record
    ? (cfg.fields ?? [])
        .map((field) => ({ field, value: structuredFieldValue(record, field) }))
        .filter((entry) => entry.value.trim().length > 0)
        .slice(0, Math.min(cfg.maximumItems ?? 8, 8))
    : [];
  const area = widgetContentArea(item, cfg);
  const padding = `${area.verticalPadding * scale}px ${area.horizontalPadding * scale}px`;
  if (!values.length)
    return (
      <div
        className="wpv-root wpv-centered"
        style={{ background: bg, padding }}
      >
        <FittedText
          text={source?.emptyState || "No items available"}
          color={fg}
          fontPx={Math.max(area.width, area.height) * scale}
          weight={500}
          maxLines={3}
          textScale={cfg.textScale}
        />
      </div>
    );
  const authorScale = Math.max(25, Math.min(500, cfg.textScale ?? 100)) / 100;
  const contentFactor = Math.max(
    0.05,
    Math.min(
      area.height / (50 + values.length * 150),
      (area.height / (50 + values.length * 150)) * authorScale,
    ),
  );
  return (
    <div className="wpv-root wpv-menu" style={{ background: bg, padding }}>
      <div
        className="wpv-menu__header"
        style={{ color: fg, fontSize: 24 * scale * contentFactor }}
      >
        {name.toUpperCase()}
      </div>
      {record?.date && (
        <div
          className="wpv-menu__date"
          style={{ color: fg, fontSize: 18 * scale * contentFactor }}
        >
          {record.date}
        </div>
      )}
      {values.map((entry, index) => (
        <div key={entry.field} className="wpv-menu__item">
          <div
            className="wpv-menu__label"
            style={{
              color: fg,
              fontSize: (index === 0 ? 20 : 16) * scale * contentFactor,
              paddingTop: (index === 0 ? 28 : 22) * scale * contentFactor,
            }}
          >
            {index === 0
              ? "TODAY'S LUNCH"
              : menuFieldLabel(entry.field).toUpperCase()}
          </div>
          <div
            className="wpv-menu__value"
            style={{
              color: fg,
              fontSize: (index === 0 ? 52 : 34) * scale * contentFactor,
              fontWeight: index === 0 ? 700 : 500,
            }}
          >
            {entry.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function DisplayWidget({
  cfg,
  source,
  fg,
  bg,
  scale,
  item,
}: {
  cfg: DisplayWidgetConfig;
  source?: LivePreviewSource;
  fg: string;
  bg: string;
  scale: number;
  item: LayoutPlacement;
}) {
  const max = cfg.maximumItems ?? 20;
  let rows: string[];
  if (source?.provider === "calendar") {
    rows = (source.events ?? [])
      .slice(0, max)
      .map((event) =>
        [event.start, event.title, event.location]
          .filter((value) => value && String(value).trim().length > 0)
          .join("  "),
      );
  } else {
    const fields = cfg.fields ?? [];
    rows = (source?.records ?? [])
      .slice(0, max)
      .map((record) =>
        fields
          .map((field) => structuredFieldValue(record, field))
          .filter((value) => value.trim().length > 0)
          .join("  "),
      )
      .filter((row) => row.trim().length > 0);
  }
  const area = widgetContentArea(item, cfg);
  const padding = `${area.verticalPadding * scale}px ${area.horizontalPadding * scale}px`;
  if (!rows.length)
    return (
      <div
        className="wpv-root wpv-centered"
        style={{ background: bg, padding }}
      >
        <FittedText
          text={source?.emptyState || "No items available"}
          color={fg}
          fontPx={Math.max(area.width, area.height) * scale}
          weight={400}
          maxLines={3}
          textScale={cfg.textScale}
        />
      </div>
    );
  const gap = Math.max(2, area.height * scale * 0.025);
  const availableHeight = Math.max(1, area.height * scale);
  const maximumRows = Math.max(
    1,
    Math.floor((availableHeight + gap) / (4 * 1.15 + gap)),
  );
  const visibleRows = rows.slice(0, maximumRows);
  return (
    <div
      className="wpv-root wpv-display"
      style={{
        background: bg,
        padding,
        gap,
      }}
    >
      {visibleRows.map((row, index) => (
        <div
          key={index}
          className="wpv-display__row"
          style={{
            color: fg,
            fontSize:
              Math.min(
                (area.width * scale) / Math.max(1, row.length * 0.62),
                Math.max(4, availableHeight / visibleRows.length / 1.15),
              ) * Math.min(1, Math.max(25, cfg.textScale ?? 100) / 100),
          }}
        >
          {row}
        </div>
      ))}
    </div>
  );
}

function WidgetLivePreview({
  asset,
  item,
  live,
  scale,
}: {
  asset: Asset;
  item: LayoutPlacement;
  live: LivePreviewData;
  scale: number;
}) {
  const widget = asset.widget!;
  const provider = widget.provider;
  const cfg = widget.configuration as Record<string, unknown>;
  const fg = colorToCss(cfg.foregroundColor as string, "#F5F7FA");
  const bg = colorToCss(
    cfg.backgroundColor as string,
    provider === "qrcode" ? "#FFFFFF" : "#0E141B",
  );
  const sourceId = cfg.dataSourceId as string | undefined;
  const source = sourceId ? live[sourceId] : undefined;
  switch (provider) {
    case "clock":
      return (
        <CenteredWidget
          background={bg}
          item={item}
          scale={scale}
          contentPadding={(cfg as unknown as ClockWidgetConfig).contentPadding}
        >
          <FittedText
            text={clockText(cfg as unknown as ClockWidgetConfig)}
            color={fg}
            fontPx={Math.max(item.width, item.height) * scale}
            weight={600}
            textScale={(cfg as unknown as ClockWidgetConfig).textScale}
          />
        </CenteredWidget>
      );
    case "date":
      return (
        <CenteredWidget
          background={bg}
          item={item}
          scale={scale}
          contentPadding={(cfg as unknown as DateWidgetConfig).contentPadding}
        >
          <FittedText
            text={dateText(cfg as unknown as DateWidgetConfig)}
            color={fg}
            fontPx={Math.max(item.width, item.height) * scale}
            weight={500}
            textScale={(cfg as unknown as DateWidgetConfig).textScale}
          />
        </CenteredWidget>
      );
    case "qrcode":
      return (
        <QrWidget
          cfg={cfg as unknown as QRCodeWidgetConfig}
          item={item}
          scale={scale}
        />
      );
    case "ticker":
      return (
        <CenteredWidget
          background={bg}
          item={item}
          scale={scale}
          contentPadding={(cfg as unknown as TickerWidgetConfig).contentPadding}
        >
          <FittedText
            text={tickerText(cfg as unknown as TickerWidgetConfig, source)}
            color={fg}
            fontPx={Math.max(item.width, item.height) * scale}
            weight={400}
            maxLines={2}
            textScale={(cfg as unknown as TickerWidgetConfig).textScale}
          />
        </CenteredWidget>
      );
    case "menu":
      return (
        <MenuWidget
          name={asset.name}
          cfg={cfg as unknown as DisplayWidgetConfig}
          source={source}
          fg={fg}
          bg={bg}
          scale={scale}
          item={item}
        />
      );
    case "list":
    case "table":
    case "agenda":
      return (
        <DisplayWidget
          cfg={cfg as unknown as DisplayWidgetConfig}
          source={source}
          fg={fg}
          bg={bg}
          scale={scale}
          item={item}
        />
      );
    default:
      return <AppPlacementPreview asset={asset} item={item} />;
  }
}

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 7680,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field field--compact">
      <span className="field__label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(value.toFixed(2))}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
function PlacementInspector({
  item,
  content,
  playlist,
  dataSources,
  update,
  duplicate,
  group,
  ungroup,
  canGroup,
}: {
  item: LayoutPlacement;
  content?: Asset;
  playlist?: Playlist;
  dataSources: DataSource[];
  update: (change: (item: LayoutPlacement) => void) => void;
  duplicate: () => void;
  group: () => void;
  ungroup: () => void;
  canGroup: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  // Connecting data from the empty state must also apply the binding, matching what selecting an
  // existing source does. The refreshed list is awaited so the new source's own first field is
  // used, rather than guessing a field name the source may not have.
  const bindNewDataSource = async (
    dataSourceId: string,
    apply: (binding: { dataSourceId: string; field: string }) => void,
  ) => {
    await queryClient.invalidateQueries({ queryKey: ["layout-data-sources"] });
    const refreshed = queryClient.getQueryData<{ items: DataSource[] }>([
      "layout-data-sources",
    ]);
    const created = refreshed?.items?.find(
      (source) => source.id === dataSourceId,
    );
    apply({
      dataSourceId,
      field: (created ? structuredFields(created)[0] : undefined) ?? "title",
    });
  };
  const primitive = item.primitive;
  return (
    <div className="layout-inspector">
      <label className="field">
        <span className="field__label">Layer name</span>
        <input
          value={item.name}
          onChange={(event) =>
            update((target) => (target.name = event.target.value))
          }
        />
      </label>
      <div className="form-grid form-grid--2">
        <NumberField
          label="X"
          value={item.x}
          onChange={(value) => update((target) => (target.x = value))}
        />
        <NumberField
          label="Y"
          value={item.y}
          onChange={(value) => update((target) => (target.y = value))}
        />
        <NumberField
          label="Width"
          value={item.width}
          min={1}
          onChange={(value) => update((target) => (target.width = value))}
        />
        <NumberField
          label="Height"
          value={item.height}
          min={1}
          onChange={(value) => update((target) => (target.height = value))}
        />
      </div>
      <NumberField
        label="Opacity"
        value={item.opacity}
        min={0}
        max={1}
        step={0.05}
        onChange={(value) => update((target) => (target.opacity = value))}
      />
      <div className="layout-inspector-actions">
        <button
          className="icon-button"
          title="Move forward"
          onClick={() =>
            update((target) => (target.layer = Math.min(999, target.layer + 1)))
          }
        >
          <ArrowUp size={16} />
        </button>
        <button
          className="icon-button"
          title="Move backward"
          onClick={() =>
            update((target) => (target.layer = Math.max(0, target.layer - 1)))
          }
        >
          <ArrowDown size={16} />
        </button>
        <button className="icon-button" title="Duplicate" onClick={duplicate}>
          <Copy size={16} />
        </button>
        <button
          className="icon-button"
          title="Lock"
          onClick={() => update((target) => (target.locked = !target.locked))}
        >
          {item.locked ? <Lock size={16} /> : <LockOpen size={16} />}
        </button>
        <button
          className="icon-button"
          title="Hide"
          onClick={() => update((target) => (target.visible = !target.visible))}
        >
          {item.visible ? <Eye size={16} /> : <EyeOff size={16} />}
        </button>
      </div>
      {item.type === "widget" && (
        <div className="layout-placement-settings">
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">Fit</span>
              <Select
                value={(item.overrides?.fit as string | undefined) ?? "contain"}
                onChange={(event) =>
                  update((target) => {
                    target.overrides = {
                      ...target.overrides,
                      fit: event.target.value,
                    };
                  })
                }
              >
                <option value="contain">Fit</option>
                <option value="cover">Fill</option>
                <option value="stretch">Stretch</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Alignment</span>
              <Select
                value={
                  (item.overrides?.alignment as string | undefined) ?? "center"
                }
                onChange={(event) =>
                  update((target) => {
                    target.overrides = {
                      ...target.overrides,
                      alignment: event.target.value,
                    };
                  })
                }
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Foreground</span>
              <input
                type="color"
                value={(
                  (item.overrides?.foregroundColor as string | undefined) ??
                  "#F5F7FA"
                ).slice(0, 7)}
                onChange={(event) =>
                  update((target) => {
                    target.overrides = {
                      ...target.overrides,
                      foregroundColor: event.target.value,
                    };
                  })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Background</span>
              <input
                type="color"
                value={(
                  (item.overrides?.backgroundColor as string | undefined) ??
                  "#18232D"
                ).slice(0, 7)}
                onChange={(event) =>
                  update((target) => {
                    target.overrides = {
                      ...target.overrides,
                      backgroundColor: event.target.value,
                    };
                  })
                }
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">When unavailable</span>
            <Select
              value={
                (item.overrides?.fallbackVisibility as string | undefined) ??
                "show"
              }
              onChange={(event) =>
                update((target) => {
                  target.overrides = {
                    ...target.overrides,
                    fallbackVisibility: event.target.value,
                  };
                })
              }
            >
              <option value="show">Show App fallback</option>
              <option value="hide">Hide placement</option>
            </Select>
          </label>
          {(content?.widget?.provider === "website" ||
            content?.widget?.provider === "youtube") && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={(item.overrides?.muted as boolean | undefined) ?? true}
                onChange={(event) =>
                  update((target) => {
                    target.overrides = {
                      ...target.overrides,
                      muted: event.target.checked,
                    };
                  })
                }
              />
              Muted in this Layout
            </label>
          )}
          {/* Opens the Widget itself and carries a return path, instead of asking for confirmation
              and then abandoning the author at the Widget list. The Widget editor reports its own
              consumers, so the warning this dialog used to guess at is shown where it is
              actionable. */}
          <button
            className="button button--secondary"
            disabled={!content}
            onClick={() => {
              if (!content) return;
              void navigate(
                `/widgets/${content.id}?returnTo=${encodeURIComponent(location.pathname)}`,
              );
            }}
          >
            <AppWindow size={16} />
            Edit shared Widget
          </button>
        </div>
      )}
      {item.type === "playlistZone" && (
        <div className="layout-placement-settings">
          <div className="notice notice--neutral">
            <strong>{playlist?.name ?? item.name}</strong>
            <span>{playlist?.itemCount ?? 0} items</span>
          </div>
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">Fit</span>
              <Select
                value={item.playback?.fit ?? "contain"}
                onChange={(event) =>
                  update((target) => {
                    target.playback = {
                      ...target.playback,
                      fit: event.target.value as
                        "contain" | "cover" | "stretch",
                    };
                  })
                }
              >
                <option value="contain">Fit</option>
                <option value="cover">Fill</option>
                <option value="stretch">Stretch</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Fallback</span>
              <Select
                value={item.playback?.fallback ?? "background"}
                onChange={(event) =>
                  update((target) => {
                    target.playback = {
                      ...target.playback,
                      fallback: event.target.value as
                        "hide" | "background" | "previous",
                    };
                  })
                }
              >
                <option value="background">Zone background</option>
                <option value="previous">Previous item</option>
                <option value="hide">Hide zone</option>
              </Select>
            </label>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={item.playback?.loop ?? true}
              onChange={(event) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    loop: event.target.checked,
                  };
                })
              }
            />
            Loop independently
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={item.playback?.muted ?? true}
              onChange={(event) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    muted: event.target.checked,
                  };
                })
              }
            />
            Muted
          </label>
          <NumberField
            label="Corner radius"
            value={item.playback?.cornerRadius ?? 0}
            max={1000}
            onChange={(value) =>
              update((target) => {
                target.playback = { ...target.playback, cornerRadius: value };
              })
            }
          />
          <button
            className="button button--secondary"
            onClick={() => void navigate(`/playlists/${item.playlistId}`)}
          >
            Edit playlist
          </button>
        </div>
      )}
      {item.type === "asset" && (
        <div className="layout-placement-settings">
          <label className="field">
            <span className="field__label">Fit</span>
            <Select
              value={item.playback?.fit ?? "contain"}
              onChange={(event) =>
                update((target) => {
                  target.playback = {
                    ...target.playback,
                    fit: event.target.value as "contain" | "cover" | "stretch",
                  };
                })
              }
            >
              <option value="contain">Fit</option>
              <option value="cover">Fill</option>
              <option value="stretch">Stretch</option>
            </Select>
          </label>
          <div className="form-grid form-grid--2">
            <NumberField
              label="Corner radius"
              value={item.playback?.cornerRadius ?? 0}
              max={1000}
              onChange={(value) =>
                update((target) => {
                  target.playback = { ...target.playback, cornerRadius: value };
                })
              }
            />
            <label className="field">
              <span className="field__label">Fallback</span>
              <Select
                value={item.playback?.fallback ?? "hide"}
                onChange={(event) =>
                  update((target) => {
                    target.playback = {
                      ...target.playback,
                      fallback: event.target.value as
                        "hide" | "background" | "previous",
                    };
                  })
                }
              >
                <option value="hide">Hide</option>
                <option value="background">Background</option>
                <option value="previous">Previous frame</option>
              </Select>
            </label>
          </div>
          {content?.type === "video" && (
            <>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={item.playback?.muted ?? true}
                  onChange={(event) =>
                    update((target) => {
                      target.playback = {
                        ...target.playback,
                        muted: event.target.checked,
                      };
                    })
                  }
                />
                <span>Muted</span>
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={item.playback?.loop ?? true}
                  onChange={(event) =>
                    update((target) => {
                      target.playback = {
                        ...target.playback,
                        loop: event.target.checked,
                      };
                    })
                  }
                />
                <span>Loop</span>
              </label>
            </>
          )}
        </div>
      )}
      {canGroup && (
        <button className="button button--secondary" onClick={group}>
          <Group size={16} />
          Group selection
        </button>
      )}
      {primitive?.kind === "group" && (
        <>
          <button className="button button--secondary" onClick={ungroup}>
            <Ungroup size={16} />
            Ungroup
          </button>
          {!primitive.binding && dataSources.length === 0 ? (
            <ConnectDataNotice
              message="Connect data to hide this group when a field is empty."
              csrf={csrf}
              onCreated={(dataSourceId) =>
                void bindNewDataSource(dataSourceId, (binding) =>
                  update((target) => {
                    target.primitive!.binding = {
                      ...binding,
                      hideWhenEmpty: true,
                    };
                  }),
                )
              }
            />
          ) : (
            <label className="field">
              <span className="field__label">Visibility</span>
              <Select
                value={primitive.binding ? "field" : "always"}
                onChange={(event) =>
                  update((target) => {
                    if (event.target.value === "always") {
                      delete target.primitive!.binding;
                      return;
                    }
                    const source = dataSources[0];
                    if (source)
                      target.primitive!.binding = {
                        dataSourceId: source.id,
                        field: structuredFields(source)[0] ?? "title",
                        hideWhenEmpty: true,
                      };
                  })
                }
              >
                <option value="always">Always visible</option>
                <option value="field">Hide when field is empty</option>
              </Select>
            </label>
          )}
          {primitive.binding && (
            <div className="form-grid form-grid--2">
              <DataSourcePicker
                value={primitive.binding.dataSourceId}
                sources={dataSources}
                csrf={csrf}
                allowEmpty={false}
                onChange={(dataSourceId) =>
                  update(
                    (target) =>
                      (target.primitive!.binding!.dataSourceId = dataSourceId),
                  )
                }
              />
              <label className="field">
                <span className="field__label">Field</span>
                <Select
                  value={primitive.binding.field}
                  onChange={(event) =>
                    update(
                      (target) =>
                        (target.primitive!.binding!.field = event.target.value),
                    )
                  }
                >
                  {structuredFields(
                    dataSources.find(
                      (asset) => asset.id === primitive.binding!.dataSourceId,
                    ),
                  ).map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
          )}
        </>
      )}
      {primitive?.kind === "text" && (
        <>
          {!primitive.binding && dataSources.length === 0 ? (
            <ConnectDataNotice
              message="Connect data to bind this text to a live field."
              csrf={csrf}
              onCreated={(dataSourceId) =>
                void bindNewDataSource(dataSourceId, (binding) =>
                  update((target) => {
                    target.primitive!.binding = {
                      ...binding,
                      format: "text",
                    };
                  }),
                )
              }
            />
          ) : (
            <label className="field">
              <span className="field__label">Content mode</span>
              <Select
                value={primitive.binding ? "dynamic" : "static"}
                onChange={(event) =>
                  update((target) => {
                    if (event.target.value === "static") {
                      delete target.primitive!.binding;
                      return;
                    }
                    const source = dataSources[0];
                    if (source)
                      target.primitive!.binding = {
                        dataSourceId: source.id,
                        field: structuredFields(source)[0] ?? "title",
                        format: "text",
                      };
                  })
                }
              >
                <option value="static">Static</option>
                <option value="dynamic">Dynamic field</option>
              </Select>
            </label>
          )}
          {primitive.binding && (
            <div className="layout-placement-settings">
              <DataSourcePicker
                value={primitive.binding.dataSourceId}
                sources={dataSources}
                csrf={csrf}
                allowEmpty={false}
                onChange={(dataSourceId) =>
                  update((target) => {
                    const source = dataSources.find(
                      (asset) => asset.id === dataSourceId,
                    );
                    target.primitive!.binding = {
                      ...target.primitive!.binding!,
                      dataSourceId,
                      field: source
                        ? (structuredFields(source)[0] ?? "title")
                        : "title",
                    };
                  })
                }
              />
              <label className="field">
                <span className="field__label">Field</span>
                <Select
                  value={primitive.binding.field}
                  onChange={(event) =>
                    update(
                      (target) =>
                        (target.primitive!.binding!.field = event.target.value),
                    )
                  }
                >
                  {structuredFields(
                    dataSources.find(
                      (asset) => asset.id === primitive.binding!.dataSourceId,
                    ),
                  ).map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="form-grid form-grid--2">
                <label className="field">
                  <span className="field__label">Prefix</span>
                  <input
                    value={primitive.binding.prefix ?? ""}
                    onChange={(event) =>
                      update(
                        (target) =>
                          (target.primitive!.binding!.prefix =
                            event.target.value),
                      )
                    }
                  />
                </label>
                <label className="field">
                  <span className="field__label">Suffix</span>
                  <input
                    value={primitive.binding.suffix ?? ""}
                    onChange={(event) =>
                      update(
                        (target) =>
                          (target.primitive!.binding!.suffix =
                            event.target.value),
                      )
                    }
                  />
                </label>
              </div>
              <label className="field">
                <span className="field__label">Fallback text</span>
                <input
                  value={primitive.binding.fallbackText ?? ""}
                  onChange={(event) =>
                    update(
                      (target) =>
                        (target.primitive!.binding!.fallbackText =
                          event.target.value),
                    )
                  }
                />
              </label>
              <label className="field">
                <span className="field__label">Format</span>
                <Select
                  value={primitive.binding.format ?? "text"}
                  onChange={(event) =>
                    update(
                      (target) =>
                        (target.primitive!.binding!.format = event.target
                          .value as NonNullable<
                          LayoutPrimitive["binding"]
                        >["format"]),
                    )
                  }
                >
                  <option value="text">Text</option>
                  <option value="date-short">Short date</option>
                  <option value="date-long">Long date</option>
                  <option value="number">Number</option>
                  <option value="integer">Integer</option>
                  <option value="currency">Currency</option>
                </Select>
              </label>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={primitive.binding.hideWhenEmpty ?? false}
                  onChange={(event) =>
                    update(
                      (target) =>
                        (target.primitive!.binding!.hideWhenEmpty =
                          event.target.checked),
                    )
                  }
                />
                <span>Hide when empty</span>
              </label>
            </div>
          )}
          {!primitive.binding && (
            <label className="field">
              <span className="field__label">Text</span>
              <textarea
                value={primitive.text ?? ""}
                onChange={(event) =>
                  update((target) => {
                    target.primitive!.text = event.target.value;
                  })
                }
              />
            </label>
          )}
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">Font</span>
              <Select
                value={primitive.fontFamily}
                onChange={(event) =>
                  update(
                    (target) =>
                      (target.primitive!.fontFamily = event.target
                        .value as LayoutPrimitive["fontFamily"]),
                  )
                }
              >
                <option>Inter</option>
                <option>Roboto</option>
                <option>Source Sans 3</option>
                <option>Noto Sans</option>
              </Select>
            </label>
            <NumberField
              label="Size"
              value={primitive.fontSize ?? 48}
              min={8}
              max={600}
              onChange={(value) =>
                update((target) => (target.primitive!.fontSize = value))
              }
            />
            <label className="field">
              <span className="field__label">Weight</span>
              <Select
                value={primitive.fontWeight}
                onChange={(event) =>
                  update(
                    (target) =>
                      (target.primitive!.fontWeight = Number(
                        event.target.value,
                      ) as LayoutPrimitive["fontWeight"]),
                  )
                }
              >
                {[400, 500, 600, 700, 800].map((weight) => (
                  <option key={weight}>{weight}</option>
                ))}
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Align</span>
              <Select
                value={primitive.textAlign}
                onChange={(event) =>
                  update(
                    (target) =>
                      (target.primitive!.textAlign = event.target
                        .value as LayoutPrimitive["textAlign"]),
                  )
                }
              >
                <option value="left">Left</option>
                <option value="center">Center</option>
                <option value="right">Right</option>
              </Select>
            </label>
            <label className="field">
              <span className="field__label">Text color</span>
              <input
                type="color"
                value={primitive.color?.slice(0, 7)}
                onChange={(event) =>
                  update(
                    (target) => (target.primitive!.color = event.target.value),
                  )
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Background</span>
              <input
                type="color"
                value={(primitive.backgroundColor ?? "#000000").slice(0, 7)}
                onChange={(event) =>
                  update(
                    (target) =>
                      (target.primitive!.backgroundColor = event.target.value),
                  )
                }
              />
            </label>
            <NumberField
              label="Line height"
              value={primitive.lineHeight ?? 1.2}
              min={0.8}
              max={3}
              step={0.1}
              onChange={(value) =>
                update((target) => (target.primitive!.lineHeight = value))
              }
            />
            <NumberField
              label="Letter spacing"
              value={primitive.letterSpacing ?? 0}
              min={0}
              max={40}
              step={0.5}
              onChange={(value) =>
                update((target) => (target.primitive!.letterSpacing = value))
              }
            />
            <NumberField
              label="Padding"
              value={primitive.padding ?? 0}
              max={300}
              onChange={(value) =>
                update((target) => (target.primitive!.padding = value))
              }
            />
            <NumberField
              label="Corner radius"
              value={primitive.cornerRadius ?? 0}
              max={1000}
              onChange={(value) =>
                update((target) => (target.primitive!.cornerRadius = value))
              }
            />
            <NumberField
              label="Border"
              value={primitive.borderWidth ?? 0}
              max={100}
              onChange={(value) =>
                update((target) => (target.primitive!.borderWidth = value))
              }
            />
            <NumberField
              label="Maximum lines"
              value={primitive.maximumLines ?? 4}
              min={1}
              max={100}
              onChange={(value) =>
                update((target) => (target.primitive!.maximumLines = value))
              }
            />
          </div>
          <label className="switch-row">
            <input
              type="checkbox"
              checked={primitive.autoFit ?? false}
              onChange={(event) =>
                update(
                  (target) =>
                    (target.primitive!.autoFit = event.target.checked),
                )
              }
            />
            <span>Automatically fit text</span>
          </label>
        </>
      )}
      {primitive &&
        ["rectangle", "circle", "line"].includes(primitive.kind) && (
          <div className="form-grid form-grid--2">
            <label className="field">
              <span className="field__label">Fill</span>
              <input
                type="color"
                value={(primitive.fillColor ?? "#2D7FF9").slice(0, 7)}
                onChange={(event) =>
                  update(
                    (target) =>
                      (target.primitive!.fillColor = event.target.value),
                  )
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Stroke</span>
              <input
                type="color"
                value={(primitive.strokeColor ?? "#FFFFFF").slice(0, 7)}
                onChange={(event) =>
                  update(
                    (target) =>
                      (target.primitive!.strokeColor = event.target.value),
                  )
                }
              />
            </label>
            <NumberField
              label="Stroke width"
              value={primitive.strokeWidth ?? 0}
              max={100}
              onChange={(value) =>
                update((target) => (target.primitive!.strokeWidth = value))
              }
            />
          </div>
        )}
    </div>
  );
}

function structuredFields(source?: DataSource): string[] {
  if (!source || !["csv", "json"].includes(source.provider)) return [];
  const config = source.configuration as {
    mapping?: { valueFields?: Record<string, string> };
  };
  return [
    "title",
    "subtitle",
    "date",
    "author",
    "description",
    ...Object.keys(config.mapping?.valueFields ?? {}),
  ];
}
function CanvasInspector({
  document,
  update,
}: {
  document: LayoutDocument;
  update: (change: (draft: LayoutDocument) => void) => void;
}) {
  return (
    <div className="layout-inspector">
      <label className="field">
        <span className="field__label">Canvas preset</span>
        <Select
          value={`${document.canvas.width}x${document.canvas.height}`}
          onChange={(event) => {
            const [width, height] = event.target.value.split("x").map(Number);
            update((draft) => {
              draft.canvas.width = width!;
              draft.canvas.height = height!;
              draft.canvas.orientation =
                width! > height! ? "landscape" : "portrait";
              draft.placements = draft.placements.filter(
                (item) =>
                  item.x + item.width <= width! &&
                  item.y + item.height <= height!,
              );
            });
          }}
        >
          <option value="1920x1080">1920 × 1080</option>
          <option value="1080x1920">1080 × 1920</option>
          <option value="3840x2160">3840 × 2160</option>
          <option value="2160x3840">2160 × 3840</option>
        </Select>
      </label>
      <div className="form-grid form-grid--2">
        <NumberField
          label="Width"
          value={document.canvas.width}
          min={320}
          max={7680}
          onChange={(value) =>
            update((d) => {
              d.canvas.width = value;
              d.canvas.orientation = "custom";
            })
          }
        />
        <NumberField
          label="Height"
          value={document.canvas.height}
          min={320}
          max={7680}
          onChange={(value) =>
            update((d) => {
              d.canvas.height = value;
              d.canvas.orientation = "custom";
            })
          }
        />
      </div>
      <label className="field">
        <span className="field__label">Background</span>
        <input
          type="color"
          value={document.canvas.backgroundColor.slice(0, 7)}
          onChange={(event) =>
            update((d) => (d.canvas.backgroundColor = event.target.value))
          }
        />
      </label>
      <NumberField
        label="Safe area (%)"
        value={document.canvas.safeAreaPercent}
        min={0}
        max={20}
        step={1}
        onChange={(value) => update((d) => (d.canvas.safeAreaPercent = value))}
      />
      <div className="layout-canvas-summary">
        <AlignCenter size={17} />
        <span>
          {document.placements.length} layers · {document.canvas.orientation}
        </span>
      </div>
    </div>
  );
}
