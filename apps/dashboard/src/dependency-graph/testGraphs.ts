import type {
  DependencyEdge,
  DependencyGraph,
  DependencyNode,
  DependencyNodeType,
} from "../api/types";

export type GraphKey = `${DependencyNodeType}:${string}`;
export type GraphEdge = [GraphKey, GraphKey, string?];
type Key = GraphKey;

/** `count` keys of one type: `screen:s0`, `screen:s1`, … */
export const keys = (
  type: DependencyNodeType,
  prefix: string,
  count: number,
): GraphKey[] =>
  Array.from(
    { length: count },
    (_, index) => `${type}:${prefix}${index}` as const,
  );

function split(key: Key) {
  const separator = key.indexOf(":");
  return {
    type: key.slice(0, separator) as DependencyNodeType,
    id: key.slice(separator + 1),
  };
}

/**
 * Builds a graph from `type:id` keys. Names default to the id, so tests can
 * refer to a node by one string.
 */
export function makeGraph(
  nodes: (Key | [Key, string])[],
  edges: GraphEdge[],
): DependencyGraph {
  return {
    nodes: nodes.map((entry): DependencyNode => {
      const [key, name] = Array.isArray(entry) ? entry : [entry, undefined];
      const { type, id } = split(key);
      return { type, id, name: name ?? id };
    }),
    edges: edges.map(([from, to, relationship = "used by"]): DependencyEdge => {
      const source = split(from);
      const target = split(to);
      return {
        fromType: source.type,
        fromId: source.id,
        toType: target.type,
        toId: target.id,
        relationship,
      };
    }),
  };
}

/** Data source → widget → layout → playlist → schedule → group → screen. */
export const chainGraph = makeGraph(
  [
    ["data_source:menu", "Lunch menu"],
    ["widget:board", "Menu board"],
    ["layout:cafe", "Cafeteria layout"],
    ["playlist:lunch", "Lunch loop"],
    ["schedule:noon", "Lunch periods"],
    ["screen_group:cafe", "Cafeteria wall"],
    ["screen:cafe-1", "Cafeteria TV"],
  ],
  [
    ["data_source:menu", "widget:board", "provides data to"],
    ["widget:board", "layout:cafe", "used by"],
    ["layout:cafe", "playlist:lunch", "included in"],
    ["playlist:lunch", "schedule:noon", "scheduled by"],
    ["schedule:noon", "screen_group:cafe", "targets"],
    ["screen_group:cafe", "screen:cafe-1", "contains"],
  ],
);

/** A layout assigned directly to `count` screens. */
export function fanoutGraph(count: number) {
  const screens = Array.from(
    { length: count },
    (_, index) => `screen:s${String(index + 1).padStart(2, "0")}` as Key,
  );
  return makeGraph(
    [["layout:lobby", "Lobby layout"], "widget:clock", ...screens],
    [
      ["widget:clock", "layout:lobby", "used by"],
      ...screens.map((screen): [Key, Key, string] => [
        "layout:lobby",
        screen,
        "assigned to",
      ]),
    ],
  );
}
