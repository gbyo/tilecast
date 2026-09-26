import type { DependencyNodeType } from "../api/types";
import {
  DEFAULT_DEPTH,
  DEFAULT_DIRECTION,
  type Depth,
  type Direction,
  type NodeKey,
} from "./graphModel";
import { isDependencyNodeType } from "./resourceTypes";

/**
 * What the explorer shows, as carried in the query string:
 *
 * - `node=<type>:<id>` focuses a resource; without it the overview shows.
 * - `type=<type>` browses one type from the overview.
 * - `direction` and `depth` appear only when they differ from the default.
 */
export type ExplorerUrlState = {
  node?: NodeKey;
  type?: DependencyNodeType;
  direction: Direction;
  depth: Depth;
};

const directions: readonly Direction[] = ["dependencies", "both", "consumers"];
const depths: readonly Depth[] = [1, 2, 3, "all"];

export function parseDirection(value: string | null | undefined): Direction {
  return (
    directions.find((direction) => direction === value) ?? DEFAULT_DIRECTION
  );
}

export function parseDepth(value: string | null | undefined): Depth {
  return depths.find((depth) => String(depth) === value) ?? DEFAULT_DEPTH;
}

/** A syntactically valid node key; whether it exists is the graph's call. */
export function parseNodeKey(value: string | null | undefined) {
  if (!value) return undefined;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return isDependencyNodeType(value.slice(0, separator)) ? value : undefined;
}

export function parseExplorerParams(params: URLSearchParams): ExplorerUrlState {
  const node = parseNodeKey(params.get("node"));
  const type = params.get("type");
  return {
    node,
    type: !node && type && isDependencyNodeType(type) ? type : undefined,
    direction: parseDirection(params.get("direction")),
    depth: parseDepth(params.get("depth")),
  };
}

export function explorerSearch(state: Partial<ExplorerUrlState>) {
  const params = new URLSearchParams();
  if (state.node) {
    params.set("node", state.node);
    if (state.direction && state.direction !== DEFAULT_DIRECTION)
      params.set("direction", state.direction);
    if (state.depth !== undefined && state.depth !== DEFAULT_DEPTH)
      params.set("depth", String(state.depth));
  } else if (state.type) {
    params.set("type", state.type);
  }
  const search = params.toString();
  return search ? `?${search}` : "";
}
