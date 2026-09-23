import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  Database,
  ExternalLink,
  FileImage,
  Focus,
  LayoutTemplate,
  ListVideo,
  Megaphone,
  Monitor,
  Network,
  Search,
  Users,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import type {
  DependencyEdge,
  DependencyGraph,
  DependencyNode,
  DependencyNodeType,
} from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../components/ui/input-group";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

/**
 * The graph groups every type into one of three delivery stages, and each
 * stage keeps its own accent so a reader sees sources, presentations, and
 * delivery without decoding every icon.
 */
const typeAccent: Record<DependencyNodeType, string> = {
  data_source: "border-l-sky-500",
  asset: "border-l-sky-500",
  widget: "border-l-sky-500",
  layout: "border-l-primary",
  playlist: "border-l-primary",
  campaign: "border-l-primary",
  schedule: "border-l-green-600",
  screen_group: "border-l-green-600",
  screen: "border-l-green-600",
};

type TypePresentation = {
  label: string;
  plural: string;
  icon: LucideIcon;
  path: (id: string) => string;
};

type PositionedNode = DependencyNode & { x: number; y: number };
type Viewport = { x: number; y: number; scale: number };

const nodeWidth = 184;
const nodeHeight = 58;
const columnGap = 82;
const rowGap = 24;
const worldPadding = 42;

const typePresentation: Record<DependencyNodeType, TypePresentation> = {
  data_source: {
    label: "Data Source",
    plural: "Data Sources",
    icon: Database,
    path: (id) => `/data-sources/${id}`,
  },
  asset: {
    label: "Media",
    plural: "Media",
    icon: FileImage,
    path: () => "/assets",
  },
  widget: {
    label: "Widget",
    plural: "Widgets",
    icon: WandSparkles,
    path: (id) => `/widgets/${id}`,
  },
  layout: {
    label: "Layout",
    plural: "Layouts",
    icon: LayoutTemplate,
    path: (id) => `/layouts/${id}`,
  },
  playlist: {
    label: "Playlist",
    plural: "Playlists",
    icon: ListVideo,
    path: (id) => `/playlists/${id}`,
  },
  campaign: {
    label: "Campaign",
    plural: "Campaigns",
    icon: Megaphone,
    path: (id) => `/campaigns/${id}`,
  },
  schedule: {
    label: "Schedule",
    plural: "Schedules",
    icon: CalendarClock,
    path: (id) => `/schedules/${id}`,
  },
  screen_group: {
    label: "Display Group",
    plural: "Display Groups",
    icon: Users,
    path: (id) => `/groups/${id}`,
  },
  screen: {
    label: "Screen",
    plural: "Screens",
    icon: Monitor,
    path: (id) => `/screens/${id}`,
  },
};

const typeOrder = Object.keys(typePresentation) as DependencyNodeType[];
const nodeKey = (type: DependencyNodeType, id: string) => `${type}:${id}`;
const emptyGraph: DependencyGraph = { nodes: [], edges: [] };

function connectedNodes(
  graph: DependencyGraph,
  start: DependencyNode,
  direction: "upstream" | "downstream",
) {
  const byKey = new Map(
    graph.nodes.map((node) => [nodeKey(node.type, node.id), node]),
  );
  const visited = new Set<string>([nodeKey(start.type, start.id)]);
  let frontier = [start];
  const result: DependencyNode[] = [];
  while (frontier.length > 0) {
    const next: DependencyNode[] = [];
    for (const node of frontier) {
      for (const edge of graph.edges) {
        const matches =
          direction === "downstream"
            ? edge.fromType === node.type && edge.fromId === node.id
            : edge.toType === node.type && edge.toId === node.id;
        if (!matches) continue;
        const key =
          direction === "downstream"
            ? nodeKey(edge.toType, edge.toId)
            : nodeKey(edge.fromType, edge.fromId);
        if (visited.has(key)) continue;
        visited.add(key);
        const connected = byKey.get(key);
        if (connected) {
          result.push(connected);
          next.push(connected);
        }
      }
    }
    frontier = next;
  }
  return result;
}

function layoutGraph(nodes: DependencyNode[]) {
  const positioned: PositionedNode[] = [];
  let longestColumn = 1;
  typeOrder.forEach((type, column) => {
    const typedNodes = nodes
      .filter((node) => node.type === type)
      .sort((left, right) => left.name.localeCompare(right.name));
    longestColumn = Math.max(longestColumn, typedNodes.length);
    typedNodes.forEach((node, row) => {
      positioned.push({
        ...node,
        x: worldPadding + column * (nodeWidth + columnGap),
        y: worldPadding + 46 + row * (nodeHeight + rowGap),
      });
    });
  });
  return {
    nodes: positioned,
    width:
      worldPadding * 2 +
      typeOrder.length * nodeWidth +
      (typeOrder.length - 1) * columnGap,
    height: Math.max(
      620,
      worldPadding * 2 +
        46 +
        longestColumn * nodeHeight +
        (longestColumn - 1) * rowGap,
    ),
  };
}

function edgePath(from: PositionedNode, to: PositionedNode) {
  const forward = to.x >= from.x;
  const startX = forward ? from.x + nodeWidth : from.x;
  const endX = forward ? to.x : to.x + nodeWidth;
  const startY = from.y + nodeHeight / 2;
  const endY = to.y + nodeHeight / 2;
  const curve = Math.max(38, Math.abs(endX - startX) * 0.42);
  const firstControl = forward ? startX + curve : startX - curve;
  const secondControl = forward ? endX - curve : endX + curve;
  return `M ${startX} ${startY} C ${firstControl} ${startY}, ${secondControl} ${endY}, ${endX} ${endY}`;
}

function RelationshipNode({
  node,
  relationship,
  onSelect,
}: {
  node: DependencyNode;
  relationship?: string;
  onSelect: (node: DependencyNode) => void;
}) {
  const presentation = typePresentation[node.type];
  const Icon = presentation.icon;
  return (
    <button
      className={`grid min-h-[54px] w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border border-border border-l-[3px] bg-card px-3 py-2 text-left text-muted-foreground outline-none hover:border-primary hover:bg-primary/5 hover:text-primary focus-visible:border-primary ${typeAccent[node.type]}`}
      type="button"
      onClick={() => onSelect(node)}
    >
      <Icon size={16} aria-hidden="true" />
      <span className="grid min-w-0">
        <strong className="truncate text-sm font-semibold text-foreground">
          {node.name}
        </strong>
        <small className="truncate text-xs text-muted-foreground">
          {presentation.label}
          {relationship ? ` · ${relationship}` : ""}
        </small>
      </span>
    </button>
  );
}

function RelationshipList({
  title,
  icon: Icon,
  edges,
  graph,
  direction,
  onSelect,
}: {
  title: string;
  icon: LucideIcon;
  edges: DependencyEdge[];
  graph: DependencyGraph;
  direction: "upstream" | "downstream";
  onSelect: (node: DependencyNode) => void;
}) {
  const nodes = new Map(
    graph.nodes.map((node) => [nodeKey(node.type, node.id), node]),
  );
  return (
    <section className="grid min-w-0 content-start gap-3">
      <h3 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
        <Icon size={16} aria-hidden="true" />
        {title}
        <span className="ml-auto text-muted-foreground tabular-nums">
          {edges.length}
        </span>
      </h3>
      {edges.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/50 p-4 text-sm text-muted-foreground">
          No direct {direction} connections.
        </p>
      ) : (
        <div className="grid gap-2">
          {edges.map((edge) => {
            const key =
              direction === "upstream"
                ? nodeKey(edge.fromType, edge.fromId)
                : nodeKey(edge.toType, edge.toId);
            const node = nodes.get(key);
            return node ? (
              <RelationshipNode
                key={`${key}-${edge.relationship}`}
                node={node}
                relationship={edge.relationship}
                onSelect={onSelect}
              />
            ) : null;
          })}
        </div>
      )}
    </section>
  );
}

/**
 * A Studio system tool rather than a plugin: it has no installation and
 * projects nothing to Players. It renders inside Settings, which supplies the
 * page heading.
 */
export function DependencyGraphPage() {
  const graph = useQuery({
    queryKey: ["dependency-graph"],
    queryFn: api.dependencyGraph,
  });
  const [selectedKey, setSelectedKey] = useState<string>();
  const [search, setSearch] = useState("");
  const [type, setType] = useState<DependencyNodeType | "all">("all");
  const [viewport, setViewport] = useState<Viewport>({
    x: 32,
    y: 32,
    scale: 0.7,
  });
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | {
        pointerX: number;
        pointerY: number;
        viewportX: number;
        viewportY: number;
      }
    | undefined
  >(undefined);
  const data = graph.data ?? emptyGraph;
  const layout = useMemo(() => layoutGraph(data.nodes), [data.nodes]);
  const positionedByKey = useMemo(
    () =>
      new Map(layout.nodes.map((node) => [nodeKey(node.type, node.id), node])),
    [layout.nodes],
  );
  const selected = data.nodes.find(
    (node) => nodeKey(node.type, node.id) === selectedKey,
  );

  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey(undefined);
  }, [selected, selectedKey]);

  const { upstream, downstream } = useMemo(
    () => ({
      upstream: selected ? connectedNodes(data, selected, "upstream") : [],
      downstream: selected ? connectedNodes(data, selected, "downstream") : [],
    }),
    [data, selected],
  );
  const connectedKeys = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(
      [selected, ...upstream, ...downstream].map((node) =>
        nodeKey(node.type, node.id),
      ),
    );
  }, [downstream, selected, upstream]);
  const directUpstream = selected
    ? data.edges.filter(
        (edge) => edge.toType === selected.type && edge.toId === selected.id,
      )
    : [];
  const directDownstream = selected
    ? data.edges.filter(
        (edge) =>
          edge.fromType === selected.type && edge.fromId === selected.id,
      )
    : [];
  const needle = search.trim().toLocaleLowerCase();
  const matchingNodes = useMemo(
    () =>
      data.nodes.filter(
        (node) =>
          (type === "all" || node.type === type) &&
          (!needle || node.name.toLocaleLowerCase().includes(needle)),
      ),
    [data.nodes, needle, type],
  );
  const matchingKeys = useMemo(
    () => new Set(matchingNodes.map((node) => nodeKey(node.type, node.id))),
    [matchingNodes],
  );
  const filtering = type !== "all" || Boolean(needle);

  const fitGraph = useCallback(() => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const scale = Math.min(
      1,
      (bounds.width - 48) / layout.width,
      (bounds.height - 48) / layout.height,
    );
    setViewport({
      scale,
      x: (bounds.width - layout.width * scale) / 2,
      y: Math.max(24, (bounds.height - layout.height * scale) / 2),
    });
  }, [layout.height, layout.width]);

  useEffect(() => {
    if (data.nodes.length === 0) return;
    const frame = requestAnimationFrame(fitGraph);
    return () => cancelAnimationFrame(frame);
  }, [data.nodes.length, fitGraph]);

  const zoom = (factor: number) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setViewport((current) => {
      const nextScale = Math.min(1.8, Math.max(0.22, current.scale * factor));
      const centerX = bounds.width / 2;
      const centerY = bounds.height / 2;
      const worldX = (centerX - current.x) / current.scale;
      const worldY = (centerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: centerX - worldX * nextScale,
        y: centerY - worldY * nextScale,
      };
    });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("[data-graph-chrome]")) {
      return;
    }
    event.preventDefault();
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    setViewport((current) => {
      const factor = Math.min(
        1.06,
        Math.max(0.94, Math.exp(-event.deltaY * 0.0012)),
      );
      const nextScale = Math.min(1.8, Math.max(0.22, current.scale * factor));
      const worldX = (pointerX - current.x) / current.scale;
      const worldY = (pointerY - current.y) / current.scale;
      return {
        scale: nextScale,
        x: pointerX - worldX * nextScale,
        y: pointerY - worldY * nextScale,
      };
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      (event.target as HTMLElement).closest(
        "[data-graph-node], [data-graph-chrome]",
      )
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      viewportX: viewport.x,
      viewportY: viewport.y,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setViewport((current) => ({
      ...current,
      x: drag.viewportX + event.clientX - drag.pointerX,
      y: drag.viewportY + event.clientY - drag.pointerY,
    }));
  };

  const selectNode = (node: DependencyNode) => {
    const key = nodeKey(node.type, node.id);
    setSelectedKey(key);
    const positioned = positionedByKey.get(key);
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!positioned || !bounds) return;
    setViewport((current) => ({
      ...current,
      x: bounds.width / 2 - (positioned.x + nodeWidth / 2) * current.scale,
      y: bounds.height / 2 - (positioned.y + nodeHeight / 2) * current.scale,
    }));
  };

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedKey(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  return (
    <div className="grid w-full gap-4 pt-5">
      {graph.isError && (
        <Alert variant="destructive" className="mx-auto w-full max-w-6xl">
          <AlertDescription>
            The dependency graph could not be loaded.
          </AlertDescription>
        </Alert>
      )}
      {graph.isLoading ? (
        <p className="mx-auto w-full max-w-6xl text-sm text-muted-foreground">
          Mapping dependencies…
        </p>
      ) : data.nodes.length === 0 ? (
        <Empty className="mx-auto w-full max-w-6xl">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Network size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Nothing to map yet</EmptyTitle>
            <EmptyDescription>
              Add content, a presentation, or a screen to start building the
              graph.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="relative min-h-[680px] max-sm:min-h-[560px]">
          <section
            className={`relative h-[680px] min-w-0 touch-none overflow-hidden rounded-xl border border-border bg-background select-none max-sm:h-[560px] ${dragRef.current ? "cursor-grabbing" : "cursor-grab"} bg-[linear-gradient(var(--color-border)_1px,transparent_1px),linear-gradient(90deg,var(--color-border)_1px,transparent_1px)] bg-[size:24px_24px]`}
            ref={canvasRef}
            aria-label="Visual dependency graph"
            onWheel={handleWheel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={() => {
              dragRef.current = undefined;
            }}
            onPointerCancel={() => {
              dragRef.current = undefined;
            }}
          >
            <div
              data-graph-chrome
              className="absolute top-3 left-3 z-10 grid min-h-9 grid-cols-[minmax(160px,260px)_142px_auto] items-center gap-1 rounded-md border border-border bg-card/95 p-1 text-muted-foreground shadow-sm max-[900px]:right-3 max-sm:grid-cols-[minmax(0,1fr)_116px]"
            >
              <InputGroup className="h-[34px] min-w-0 border-transparent bg-muted shadow-none dark:bg-muted">
                <InputGroupAddon>
                  <Search aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  type="search"
                  aria-label="Search graph"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && matchingNodes[0]) {
                      selectNode(matchingNodes[0]);
                    }
                  }}
                  placeholder="Search nodes"
                />
                {search && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="icon-xs"
                      aria-label="Clear search"
                      onClick={() => setSearch("")}
                    >
                      <X aria-hidden="true" />
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
              <Select
                items={[
                  { value: "all", label: "All types" },
                  ...typeOrder.map((nodeType) => ({
                    value: nodeType,
                    label: typePresentation[nodeType].plural,
                  })),
                ]}
                value={type}
                onValueChange={(value) =>
                  setType((value as DependencyNodeType | "all") ?? "all")
                }
              >
                <SelectTrigger
                  aria-label="Filter by type"
                  className="h-[34px] border-transparent"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {typeOrder.map((nodeType) => (
                    <SelectItem value={nodeType} key={nodeType}>
                      {typePresentation[nodeType].plural}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="min-w-[34px] px-2 text-center text-xs text-muted-foreground tabular-nums max-sm:hidden">
                {filtering
                  ? `${matchingNodes.length}/${data.nodes.length}`
                  : data.nodes.length}
              </span>
            </div>
            <div
              data-graph-chrome
              className={`absolute top-3 right-3 z-10 flex overflow-hidden rounded-md border border-border bg-card shadow-sm max-[900px]:top-16 ${selected ? "right-[372px] max-[900px]:right-3" : ""}`}
            >
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => zoom(1.1)}
                className="grid h-9 w-9 place-items-center text-muted-foreground hover:bg-primary/10 hover:text-primary"
              >
                <ZoomIn size={16} />
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => zoom(0.9)}
                className="grid h-9 w-9 place-items-center border-l border-border text-muted-foreground hover:bg-primary/10 hover:text-primary"
              >
                <ZoomOut size={16} />
              </button>
              <button
                type="button"
                aria-label="Fit graph"
                onClick={fitGraph}
                className="grid h-9 w-9 place-items-center border-l border-border text-muted-foreground hover:bg-primary/10 hover:text-primary"
              >
                <Focus size={16} />
              </button>
            </div>
            <div
              className="absolute bottom-3 left-3 z-[8] flex gap-3 rounded-md border border-border bg-card/90 px-3 py-2 text-xs text-muted-foreground shadow-sm max-sm:hidden"
              aria-hidden="true"
            >
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full bg-sky-500" />
                Sources
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full bg-primary" />
                Presentations
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block size-2 rounded-full bg-green-600" />
                Delivery
              </span>
            </div>
            <div
              className="absolute top-0 left-0 origin-[0_0] will-change-transform"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
              }}
            >
              <svg
                className="pointer-events-none absolute inset-0 overflow-visible"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="dependency-arrow"
                    markerWidth="7"
                    markerHeight="7"
                    refX="6"
                    refY="3.5"
                    orient="auto"
                  >
                    <path
                      d="M0,0 L7,3.5 L0,7 Z"
                      className="fill-muted-foreground"
                    />
                  </marker>
                  <marker
                    id="dependency-arrow-active"
                    markerWidth="7"
                    markerHeight="7"
                    refX="6"
                    refY="3.5"
                    orient="auto"
                  >
                    <path d="M0,0 L7,3.5 L0,7 Z" className="fill-primary" />
                  </marker>
                </defs>
                {data.edges.map((edge, index) => {
                  const fromKey = nodeKey(edge.fromType, edge.fromId);
                  const toKey = nodeKey(edge.toType, edge.toId);
                  const from = positionedByKey.get(fromKey);
                  const to = positionedByKey.get(toKey);
                  if (!from || !to) return null;
                  const active =
                    selected &&
                    connectedKeys.has(fromKey) &&
                    connectedKeys.has(toKey);
                  return (
                    <path
                      className={`dependency-edge fill-none transition-opacity ${active ? "stroke-primary opacity-100 [stroke-width:2.5]" : "stroke-muted-foreground opacity-70 [stroke-width:1.5]"}${selected && !active ? " opacity-[0.09]" : ""}`}
                      d={edgePath(from, to)}
                      key={`${fromKey}-${toKey}-${edge.relationship}-${index}`}
                      markerEnd={
                        active
                          ? "url(#dependency-arrow-active)"
                          : "url(#dependency-arrow)"
                      }
                    />
                  );
                })}
              </svg>
              {typeOrder.map((nodeType, column) => (
                <div
                  className="absolute top-3 overflow-hidden text-center text-[11px] font-semibold tracking-wider text-ellipsis whitespace-nowrap text-muted-foreground uppercase"
                  key={nodeType}
                  style={{
                    left: worldPadding + column * (nodeWidth + columnGap),
                    width: nodeWidth,
                  }}
                >
                  {typePresentation[nodeType].plural}
                </div>
              ))}
              {layout.nodes.map((node) => {
                const key = nodeKey(node.type, node.id);
                const presentation = typePresentation[node.type];
                const Icon = presentation.icon;
                const muted =
                  (selected && !connectedKeys.has(key)) ||
                  (filtering && !matchingKeys.has(key));
                const isSelected = key === selectedKey;
                return (
                  <button
                    data-graph-node
                    className={`absolute grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border border-border border-l-4 bg-card px-2 py-2 text-left text-muted-foreground shadow-sm transition outline-none hover:z-[2] hover:-translate-y-px hover:border-primary hover:shadow-md hover:ring-2 hover:ring-primary/20 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 ${typeAccent[node.type]}${isSelected ? " z-[3] border-primary text-primary ring-4 ring-primary/15" : ""}${muted ? " opacity-25" : ""}`}
                    type="button"
                    key={key}
                    style={{
                      left: node.x,
                      top: node.y,
                      width: nodeWidth,
                      height: nodeHeight,
                    }}
                    aria-pressed={isSelected}
                    onClick={() => selectNode(node)}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span className="grid min-w-0">
                      <strong className="truncate text-sm font-semibold text-foreground">
                        {node.name}
                      </strong>
                      <small className="truncate text-xs text-muted-foreground">
                        {presentation.label}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="pointer-events-none absolute bottom-3 left-1/2 z-[8] -translate-x-1/2 rounded-md border border-border bg-card/90 px-3 py-1 text-xs whitespace-nowrap text-muted-foreground max-sm:max-w-[calc(100%-24px)] max-sm:text-center">
              Drag to pan · Scroll to zoom · Arrows point to consumers
            </p>
          </section>

          {selected && (
            <aside
              data-graph-chrome
              className="absolute top-3 right-3 z-[11] max-h-[calc(100%-24px)] w-[340px] max-w-[calc(100%-24px)] overflow-auto rounded-xl border border-border bg-card shadow-xl max-sm:top-auto max-sm:right-3 max-sm:bottom-3 max-sm:left-3 max-sm:max-h-[min(70%,440px)] max-sm:w-auto"
              aria-label={`${selected.name} dependency details`}
            >
              <header className="sticky top-0 z-[2] flex min-h-[68px] items-center justify-between gap-3 border-b border-border bg-card px-4 py-3">
                <span className="grid min-w-0 gap-1">
                  <small className="text-xs text-muted-foreground">
                    {typePresentation[selected.type].label}
                  </small>
                  <h2 className="truncate text-base font-semibold">
                    {selected.name}
                  </h2>
                </span>
                <div className="flex items-center gap-1">
                  <Link
                    className={buttonVariants({
                      variant: "secondary",
                      size: "sm",
                    })}
                    to={typePresentation[selected.type].path(selected.id)}
                  >
                    Open <ExternalLink size={14} aria-hidden="true" />
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    aria-label="Close inspector"
                    onClick={() => setSelectedKey(undefined)}
                  >
                    <X size={16} />
                  </Button>
                </div>
              </header>
              <div className="flex gap-6 border-b border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
                <span className="flex items-baseline gap-2">
                  <strong className="text-foreground tabular-nums">
                    {upstream.length}
                  </strong>
                  upstream
                </span>
                <span className="flex items-baseline gap-2">
                  <strong className="text-foreground tabular-nums">
                    {downstream.length}
                  </strong>
                  downstream
                </span>
              </div>
              <div className="grid gap-5 p-4">
                <RelationshipList
                  title="Direct dependencies"
                  icon={ArrowUp}
                  edges={directUpstream}
                  graph={data}
                  direction="upstream"
                  onSelect={selectNode}
                />
                <RelationshipList
                  title="Direct consumers"
                  icon={ArrowDown}
                  edges={directDownstream}
                  graph={data}
                  direction="downstream"
                  onSelect={selectNode}
                />
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
