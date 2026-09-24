import type {
  DependencyGraph,
  DependencyNode,
  DependencyNodeType,
} from "../api/types";
import { compareTypes, typeOrder } from "./resourceTypes";

/** `<type>:<id>`, unique across the graph because ids are per-type UUIDs. */
export type NodeKey = string;

export const nodeKey = (type: DependencyNodeType, id: string): NodeKey =>
  `${type}:${id}`;

/** A directed relationship from a dependency to the record consuming it. */
export type GraphLink = {
  from: NodeKey;
  to: NodeKey;
  relationship: string;
};

export type GraphIndex = {
  /** Every node, in stable type-then-name order. */
  nodes: readonly DependencyNode[];
  nodesByKey: ReadonlyMap<NodeKey, DependencyNode>;
  /** Links whose `to` is the key: the key's direct dependencies. */
  incomingByKey: ReadonlyMap<NodeKey, readonly GraphLink[]>;
  /** Links whose `from` is the key: the key's direct consumers. */
  outgoingByKey: ReadonlyMap<NodeKey, readonly GraphLink[]>;
  links: readonly GraphLink[];
  countsByType: ReadonlyMap<DependencyNodeType, number>;
};

export type Direction = "dependencies" | "both" | "consumers";
export type Depth = 1 | 2 | 3 | "all";
export type Side = "dependencies" | "consumers";

export const DEFAULT_DIRECTION: Direction = "both";
export const DEFAULT_DEPTH: Depth = 2;

/**
 * A parent with at least this many terminal children of one type shows them
 * as a single "N screens" node until the operator expands it.
 */
export const TERMINAL_FANOUT_THRESHOLD = 8;

const noLinks: readonly GraphLink[] = [];

export function compareNodes(left: DependencyNode, right: DependencyNode) {
  return (
    compareTypes(left.type, right.type) ||
    left.name.localeCompare(right.name) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Indexes the graph once so traversal reads each node's own links rather than
 * scanning every edge. Duplicate edges (the same playlist item listed twice)
 * collapse to one link, and edges to a node the response omitted are dropped
 * because there is nothing to draw or open at that end.
 */
export function buildGraphIndex(graph: DependencyGraph): GraphIndex {
  const nodes = [...graph.nodes].sort(compareNodes);
  const nodesByKey = new Map<NodeKey, DependencyNode>();
  const countsByType = new Map<DependencyNodeType, number>(
    typeOrder.map((type) => [type, 0]),
  );
  for (const node of nodes) {
    const key = nodeKey(node.type, node.id);
    if (nodesByKey.has(key)) continue;
    nodesByKey.set(key, node);
    countsByType.set(node.type, (countsByType.get(node.type) ?? 0) + 1);
  }
  const incomingByKey = new Map<NodeKey, GraphLink[]>();
  const outgoingByKey = new Map<NodeKey, GraphLink[]>();
  const links: GraphLink[] = [];
  const seen = new Set<string>();
  for (const edge of graph.edges) {
    const from = nodeKey(edge.fromType, edge.fromId);
    const to = nodeKey(edge.toType, edge.toId);
    if (from === to || !nodesByKey.has(from) || !nodesByKey.has(to)) continue;
    const identity = `${from}\u0000${to}\u0000${edge.relationship}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const link = { from, to, relationship: edge.relationship };
    links.push(link);
    append(outgoingByKey, from, link);
    append(incomingByKey, to, link);
  }
  return {
    nodes: [...nodesByKey.values()],
    nodesByKey,
    incomingByKey,
    outgoingByKey,
    links,
    countsByType,
  };
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function incoming(index: GraphIndex, key: NodeKey) {
  return index.incomingByKey.get(key) ?? noLinks;
}

export function outgoing(index: GraphIndex, key: NodeKey) {
  return index.outgoingByKey.get(key) ?? noLinks;
}

export type OverviewNode = { type: DependencyNodeType; count: number };
export type OverviewEdge = {
  fromType: DependencyNodeType;
  toType: DependencyNodeType;
  /** Underlying resource relationships between the two types. */
  count: number;
};
export type OverviewGraph = {
  nodes: OverviewNode[];
  edges: OverviewEdge[];
};

/**
 * One node per resource type and one edge per type pair, so the overview
 * stays nine nodes however many resources an installation has.
 */
export function buildOverviewGraph(index: GraphIndex): OverviewGraph {
  const counts = new Map<string, OverviewEdge>();
  for (const link of index.links) {
    const fromType = index.nodesByKey.get(link.from)!.type;
    const toType = index.nodesByKey.get(link.to)!.type;
    // A type feeding itself has no drawable aggregate edge.
    if (fromType === toType) continue;
    const key = `${fromType}>${toType}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { fromType, toType, count: 1 });
  }
  return {
    nodes: typeOrder.map((type) => ({
      type,
      count: index.countsByType.get(type) ?? 0,
    })),
    edges: [...counts.values()].sort(
      (left, right) =>
        compareTypes(left.fromType, right.fromType) ||
        compareTypes(left.toType, right.toType),
    ),
  };
}

export function depthLimit(depth: Depth) {
  return depth === "all" ? Number.POSITIVE_INFINITY : depth;
}

/**
 * Breadth-first distances from `start` along one side, excluding `start`.
 * The visited set makes cycles terminate even though Tilecast content is
 * normally acyclic.
 */
export function traverse(
  index: GraphIndex,
  start: NodeKey,
  side: Side,
  maxDepth = Number.POSITIVE_INFINITY,
) {
  const distances = new Map<NodeKey, number>();
  const visited = new Set<NodeKey>([start]);
  let frontier = [start];
  for (
    let distance = 1;
    frontier.length > 0 && distance <= maxDepth;
    distance++
  ) {
    const next: NodeKey[] = [];
    for (const key of frontier) {
      const links =
        side === "consumers" ? outgoing(index, key) : incoming(index, key);
      for (const link of links) {
        const neighbor = side === "consumers" ? link.to : link.from;
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        distances.set(neighbor, distance);
        next.push(neighbor);
      }
    }
    frontier = next;
  }
  return distances;
}

export type FocusedNode = {
  key: NodeKey;
  node: DependencyNode;
  /** Signed hops from the root: dependencies negative, consumers positive. */
  layer: number;
};

export type FocusedSubgraph = {
  rootKey: NodeKey;
  nodes: FocusedNode[];
  /** Links whose two ends are both visible. */
  links: GraphLink[];
};

export function buildFocusedSubgraph(
  index: GraphIndex,
  rootKey: NodeKey,
  { direction, depth }: { direction: Direction; depth: Depth },
): FocusedSubgraph | undefined {
  const root = index.nodesByKey.get(rootKey);
  if (!root) return undefined;
  const limit = depthLimit(depth);
  const dependencies =
    direction === "consumers"
      ? new Map<NodeKey, number>()
      : traverse(index, rootKey, "dependencies", limit);
  const consumers =
    direction === "dependencies"
      ? new Map<NodeKey, number>()
      : traverse(index, rootKey, "consumers", limit);
  const layers = new Map<NodeKey, number>([[rootKey, 0]]);
  for (const [key, distance] of dependencies) layers.set(key, -distance);
  // In a cycle a node is both; it sits on the nearer side, consumers on a tie.
  for (const [key, distance] of consumers) {
    const asDependency = dependencies.get(key);
    if (asDependency === undefined || distance <= asDependency)
      layers.set(key, distance);
  }
  const nodes = [...layers].map(([key, layer]) => ({
    key,
    node: index.nodesByKey.get(key)!,
    layer,
  }));
  nodes.sort(
    (left, right) =>
      left.layer - right.layer || compareNodes(left.node, right.node),
  );
  const links: GraphLink[] = [];
  for (const { key } of nodes) {
    for (const link of outgoing(index, key)) {
      if (layers.has(link.to)) links.push(link);
    }
  }
  return { rootKey, nodes, links };
}

export type FanoutGroup = {
  key: string;
  /** The single visible node every member connects to. */
  anchorKey: NodeKey;
  side: Side;
  type: DependencyNodeType;
  layer: number;
  members: DependencyNode[];
};

export type ExplorerGraph = FocusedSubgraph & {
  groups: FanoutGroup[];
  /** Links from a group's members to its anchor, or anchor to members. */
  groupLinks: { from: string; to: string; count: number }[];
};

export const fanoutGroupKey = (
  side: Side,
  anchorKey: NodeKey,
  type: DependencyNodeType,
) => `group:${side}:${anchorKey}:${type}`;

/**
 * Collapses large sets of leaf resources into one node per anchor and type.
 *
 * A node is only grouped when hiding it cannot hide a path: it has no links
 * further out in the whole installation (a screen consumes nothing; a
 * standalone media item depends on nothing), and its only visible link is to
 * the anchor. A screen reached through both a group and a schedule stays an
 * individual node.
 */
export function groupTerminalFanout(
  index: GraphIndex,
  subgraph: FocusedSubgraph,
  {
    threshold = TERMINAL_FANOUT_THRESHOLD,
    expanded = new Set<string>(),
  }: { threshold?: number; expanded?: ReadonlySet<string> } = {},
): ExplorerGraph {
  const visibleLinksByKey = new Map<NodeKey, GraphLink[]>();
  for (const link of subgraph.links) {
    append(visibleLinksByKey, link.from, link);
    append(visibleLinksByKey, link.to, link);
  }
  const candidates = new Map<string, FanoutGroup>();
  for (const focused of subgraph.nodes) {
    if (focused.layer === 0) continue;
    const side: Side = focused.layer > 0 ? "consumers" : "dependencies";
    const further =
      side === "consumers"
        ? outgoing(index, focused.key)
        : incoming(index, focused.key);
    if (further.length > 0) continue;
    const links = visibleLinksByKey.get(focused.key) ?? noLinks;
    const anchors = new Set(
      links.map((link) => (link.from === focused.key ? link.to : link.from)),
    );
    if (anchors.size !== 1) continue;
    const anchorKey = [...anchors][0]!;
    const groupKey = fanoutGroupKey(side, anchorKey, focused.node.type);
    const group = candidates.get(groupKey);
    if (group) group.members.push(focused.node);
    else
      candidates.set(groupKey, {
        key: groupKey,
        anchorKey,
        side,
        type: focused.node.type,
        layer: focused.layer,
        members: [focused.node],
      });
  }
  const hidden = new Set<NodeKey>();
  const groups: FanoutGroup[] = [];
  for (const group of candidates.values()) {
    if (group.members.length < threshold || expanded.has(group.key)) continue;
    group.members.sort(compareNodes);
    groups.push(group);
    for (const member of group.members)
      hidden.add(nodeKey(member.type, member.id));
  }
  groups.sort(
    (left, right) =>
      left.layer - right.layer ||
      compareTypes(left.type, right.type) ||
      left.anchorKey.localeCompare(right.anchorKey),
  );
  if (hidden.size === 0) return { ...subgraph, groups, groupLinks: [] };
  return {
    rootKey: subgraph.rootKey,
    nodes: subgraph.nodes.filter((node) => !hidden.has(node.key)),
    links: subgraph.links.filter(
      (link) => !hidden.has(link.from) && !hidden.has(link.to),
    ),
    groups,
    groupLinks: groups.map((group) =>
      group.side === "consumers"
        ? { from: group.anchorKey, to: group.key, count: group.members.length }
        : { from: group.key, to: group.anchorKey, count: group.members.length },
    ),
  };
}

export function directLinks(index: GraphIndex, key: NodeKey) {
  return {
    dependencies: [...incoming(index, key)].sort((left, right) =>
      compareNodes(
        index.nodesByKey.get(left.from)!,
        index.nodesByKey.get(right.from)!,
      ),
    ),
    consumers: [...outgoing(index, key)].sort((left, right) =>
      compareNodes(
        index.nodesByKey.get(left.to)!,
        index.nodesByKey.get(right.to)!,
      ),
    ),
  };
}

export function nodesOfType(index: GraphIndex, type: DependencyNodeType) {
  return index.nodes.filter((node) => node.type === type);
}
