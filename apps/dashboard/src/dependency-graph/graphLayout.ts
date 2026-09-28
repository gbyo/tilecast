import type { DependencyNode, DependencyNodeType } from "../api/types";
import {
  compareNodes,
  type ExplorerGraph,
  type FanoutGroup,
  type OverviewGraph,
} from "./graphModel";
import { compareTypes, dependencyStages } from "./resourceTypes";

export type Box = { x: number; y: number; width: number; height: number };

export type LayoutItem =
  | {
      kind: "type";
      key: string;
      type: DependencyNodeType;
      count: number;
      box: Box;
    }
  | {
      kind: "resource";
      key: string;
      node: DependencyNode;
      layer: number;
      box: Box;
    }
  | { kind: "group"; key: string; group: FanoutGroup; box: Box };

export type LayoutEdge = {
  key: string;
  from: string;
  to: string;
  d: string;
  count: number;
  /** Midpoint of the curve, where a count label can sit. */
  labelX: number;
  labelY: number;
};

export type LayoutHeading = {
  key: "sources" | "presentations" | "delivery" | "dependencies" | "consumers";
  x: number;
  y: number;
  width: number;
};

export type GraphLayout = {
  width: number;
  height: number;
  items: LayoutItem[];
  edges: LayoutEdge[];
  headings: LayoutHeading[];
  /** The item an automatic view keeps on screen: the root in focus mode. */
  focusKey?: string;
};

export const overviewMetrics = {
  nodeWidth: 196,
  nodeHeight: 52,
  columnGap: 112,
  rowGap: 48,
  padding: 40,
  headingHeight: 36,
} as const;

export const focusMetrics = {
  nodeWidth: 208,
  nodeHeight: 56,
  columnGap: 112,
  rowGap: 16,
  padding: 40,
  headingHeight: 36,
} as const;

type Point = { x: number; y: number };

function cubic(start: Point, c1: Point, c2: Point, end: Point) {
  return {
    d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    labelX: 0.125 * start.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * end.x,
    labelY: 0.125 * start.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * end.y,
  };
}

/**
 * Routes one connection. Boxes in different columns join side to side;
 * boxes in one column either join top to bottom (`bow: "none"`, used for
 * neighbours) or curve around the column on the given side.
 */
export function edgePath(
  from: Box,
  to: Box,
  {
    bow = "right",
    offset = 0,
  }: { bow?: "left" | "right" | "none"; offset?: number } = {},
) {
  const fromMidY = from.y + from.height / 2;
  const toMidY = to.y + to.height / 2;
  if (to.x >= from.x + from.width) {
    const start = { x: from.x + from.width, y: fromMidY };
    const end = { x: to.x, y: toMidY };
    const curve = Math.max(36, (end.x - start.x) * 0.45);
    return cubic(
      start,
      { x: start.x + curve, y: start.y },
      { x: end.x - curve, y: end.y },
      end,
    );
  }
  if (to.x + to.width <= from.x) {
    const start = { x: from.x, y: fromMidY };
    const end = { x: to.x + to.width, y: toMidY };
    const curve = Math.max(36, (start.x - end.x) * 0.45);
    return cubic(
      start,
      { x: start.x - curve, y: start.y },
      { x: end.x + curve, y: end.y },
      end,
    );
  }
  if (bow === "none") {
    const downward = to.y > from.y;
    const x = from.x + from.width / 2 + offset;
    const start = { x, y: downward ? from.y + from.height : from.y };
    const end = { x, y: downward ? to.y : to.y + to.height };
    const third = (end.y - start.y) / 3;
    return cubic(
      start,
      { x, y: start.y + third },
      { x, y: end.y - third },
      end,
    );
  }
  const sideX = (box: Box) => (bow === "left" ? box.x : box.x + box.width);
  const start = { x: sideX(from), y: fromMidY };
  const end = { x: sideX(to), y: toMidY };
  const reach = 36 + Math.abs(end.y - start.y) * 0.12;
  const control = bow === "left" ? -reach : reach;
  return cubic(
    start,
    { x: start.x + control, y: start.y },
    { x: end.x + control, y: end.y },
    end,
  );
}

/**
 * The fixed overview: one column per delivery stage and one row per type
 * within it, so positions never move as counts change.
 */
export function layoutOverview(overview: OverviewGraph): GraphLayout {
  const m = overviewMetrics;
  const counts = new Map(overview.nodes.map((node) => [node.type, node.count]));
  const cells = new Map<DependencyNodeType, { column: number; row: number }>();
  const items: LayoutItem[] = [];
  const headings: LayoutHeading[] = [];
  let rows = 0;
  dependencyStages.forEach((stage, column) => {
    const x = m.padding + column * (m.nodeWidth + m.columnGap);
    headings.push({ key: stage.id, x, y: m.padding, width: m.nodeWidth });
    rows = Math.max(rows, stage.types.length);
    stage.types.forEach((type, row) => {
      cells.set(type, { column, row });
      items.push({
        kind: "type",
        key: type,
        type,
        count: counts.get(type) ?? 0,
        box: {
          x,
          y: m.padding + m.headingHeight + row * (m.nodeHeight + m.rowGap),
          width: m.nodeWidth,
          height: m.nodeHeight,
        },
      });
    });
  });
  const boxes = new Map(items.map((item) => [item.key, item.box]));
  const pairs = new Set(
    overview.edges.map((edge) => `${edge.fromType}>${edge.toType}`),
  );
  const edges = overview.edges.map((edge) => {
    const from = cells.get(edge.fromType)!;
    const to = cells.get(edge.toType)!;
    let bow: "left" | "right" | "none" = "right";
    let offset = 0;
    if (from.column === to.column && Math.abs(from.row - to.row) === 1) {
      bow = "none";
      // Two-way neighbours get separate lanes instead of one doubled line.
      if (pairs.has(`${edge.toType}>${edge.fromType}`))
        offset = to.row > from.row ? -14 : 14;
    } else if (from.column === to.column && from.column === 0) {
      bow = "left";
    }
    return {
      key: `${edge.fromType}>${edge.toType}`,
      from: edge.fromType,
      to: edge.toType,
      count: edge.count,
      ...edgePath(boxes.get(edge.fromType)!, boxes.get(edge.toType)!, {
        bow,
        offset,
      }),
    };
  });
  const columns = dependencyStages.length;
  return {
    width: m.padding * 2 + columns * m.nodeWidth + (columns - 1) * m.columnGap,
    height:
      m.padding * 2 +
      m.headingHeight +
      rows * m.nodeHeight +
      (rows - 1) * m.rowGap,
    items,
    edges,
    headings,
  };
}

type Entry =
  | { kind: "resource"; key: string; layer: number; node: DependencyNode }
  | { kind: "group"; key: string; layer: number; group: FanoutGroup };

function compareEntries(left: Entry, right: Entry) {
  if (left.kind !== right.kind) return left.kind === "resource" ? -1 : 1;
  if (left.kind === "resource" && right.kind === "resource")
    return compareNodes(left.node, right.node);
  if (left.kind === "group" && right.kind === "group")
    return (
      compareTypes(left.group.type, right.group.type) ||
      left.key.localeCompare(right.key)
    );
  return 0;
}

/**
 * Lays a focused graph out by signed distance from its root: the root in the
 * centre column, dependencies in columns to its left and consumers to its
 * right. Each layer is centred on the root's row and ordered once, outward
 * from the root, by the mean row of its neighbours nearer the root — enough
 * to untangle the obvious crossings without an iterative layout engine.
 */
export function layoutFocus(graph: ExplorerGraph): GraphLayout {
  const m = focusMetrics;
  const layers = new Map<number, Entry[]>();
  const place = (entry: Entry) => {
    const list = layers.get(entry.layer);
    if (list) list.push(entry);
    else layers.set(entry.layer, [entry]);
  };
  for (const focused of graph.nodes)
    place({
      kind: "resource",
      key: focused.key,
      layer: focused.layer,
      node: focused.node,
    });
  for (const group of graph.groups)
    place({ kind: "group", key: group.key, layer: group.layer, group });
  for (const list of layers.values()) list.sort(compareEntries);

  const neighbours = new Map<string, string[]>();
  const connect = (a: string, b: string) => {
    const list = neighbours.get(a);
    if (list) list.push(b);
    else neighbours.set(a, [b]);
  };
  for (const link of [...graph.links, ...graph.groupLinks]) {
    connect(link.from, link.to);
    connect(link.to, link.from);
  }

  const rowOf = new Map<string, number>([[graph.rootKey, 0]]);
  const layerNumbers = [...layers.keys()];
  const minLayer = Math.min(0, ...layerNumbers);
  const maxLayer = Math.max(0, ...layerNumbers);
  const order = (layer: number, inner: number) => {
    const list = layers.get(layer);
    if (!list) return;
    const innerKeys = new Set((layers.get(inner) ?? []).map((e) => e.key));
    const centres = list.map((entry, initial) => {
      const rows = (neighbours.get(entry.key) ?? [])
        .filter((key) => innerKeys.has(key))
        .map((key) => rowOf.get(key)!);
      const centre =
        rows.length > 0
          ? rows.reduce((sum, row) => sum + row, 0) / rows.length
          : Number.POSITIVE_INFINITY;
      return { entry, initial, centre };
    });
    centres.sort(
      (left, right) =>
        left.centre - right.centre || left.initial - right.initial,
    );
    list.splice(0, list.length, ...centres.map(({ entry }) => entry));
    list.forEach((entry, index) =>
      rowOf.set(entry.key, index - (list.length - 1) / 2),
    );
  };
  for (let layer = -1; layer >= minLayer; layer--) order(layer, layer + 1);
  for (let layer = 1; layer <= maxLayer; layer++) order(layer, layer - 1);

  const pitchX = m.nodeWidth + m.columnGap;
  const pitchY = m.nodeHeight + m.rowGap;
  const top = Math.min(...[...rowOf.values()]);
  const bottom = Math.max(...[...rowOf.values()]);
  const originY = m.padding + m.headingHeight - top * pitchY;
  const columnX = (layer: number) => m.padding + (layer - minLayer) * pitchX;

  const items: LayoutItem[] = [];
  for (const [layer, list] of layers) {
    for (const entry of list) {
      const box = {
        x: columnX(layer),
        y: originY + rowOf.get(entry.key)! * pitchY,
        width: m.nodeWidth,
        height: m.nodeHeight,
      };
      items.push(
        entry.kind === "resource"
          ? { kind: "resource", key: entry.key, node: entry.node, layer, box }
          : { kind: "group", key: entry.key, group: entry.group, box },
      );
    }
  }
  // Document order is reading order: left to right, then top to bottom.
  items.sort(
    (left, right) => left.box.x - right.box.x || left.box.y - right.box.y,
  );

  const boxes = new Map(items.map((item) => [item.key, item.box]));
  const layerOf = (key: string) =>
    (boxes.get(key)!.x - m.padding) / pitchX + minLayer;
  const edges: LayoutEdge[] = [];
  const drawn = new Map<string, LayoutEdge>();
  for (const link of [...graph.links, ...graph.groupLinks]) {
    const pair = `${link.from}>${link.to}`;
    const existing = drawn.get(pair);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const layer = layerOf(link.from);
    const edge = {
      key: pair,
      from: link.from,
      to: link.to,
      count: "count" in link ? link.count : 1,
      ...edgePath(boxes.get(link.from)!, boxes.get(link.to)!, {
        bow: layer < 0 ? "left" : "right",
      }),
    };
    drawn.set(pair, edge);
    edges.push(edge);
  }

  const headings: LayoutHeading[] = [];
  if (minLayer < 0)
    headings.push({
      key: "dependencies",
      x: columnX(minLayer),
      y: m.padding,
      width: -minLayer * pitchX - m.columnGap,
    });
  if (maxLayer > 0)
    headings.push({
      key: "consumers",
      x: columnX(1),
      y: m.padding,
      width: maxLayer * pitchX - m.columnGap,
    });

  return {
    width: m.padding * 2 + (maxLayer - minLayer) * pitchX + m.nodeWidth,
    height:
      m.padding * 2 + m.headingHeight + (bottom - top) * pitchY + m.nodeHeight,
    items,
    edges,
    headings,
    focusKey: graph.rootKey,
  };
}
