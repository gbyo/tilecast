import { describe, expect, it } from "vitest";
import {
  TERMINAL_FANOUT_THRESHOLD,
  buildFocusedSubgraph,
  buildGraphIndex,
  buildOverviewGraph,
  directLinks,
  fanoutGroupKey,
  groupTerminalFanout,
  traverse,
  type Depth,
  type Direction,
} from "./graphModel";
import {
  chainGraph,
  fanoutGraph,
  keys,
  makeGraph,
  type GraphEdge,
} from "./testGraphs";

const layers = (
  graph: ReturnType<typeof makeGraph>,
  root: string,
  direction: Direction = "both",
  depth: Depth = 2,
) =>
  Object.fromEntries(
    buildFocusedSubgraph(buildGraphIndex(graph), root, {
      direction,
      depth,
    })!.nodes.map((node) => [node.key, node.layer]),
  );

describe("buildGraphIndex", () => {
  it("indexes links by both ends and drops duplicates and dangling edges", () => {
    const index = buildGraphIndex(
      makeGraph(
        ["asset:a", "playlist:p"],
        [
          ["asset:a", "playlist:p", "included in"],
          ["asset:a", "playlist:p", "included in"],
          ["asset:a", "layout:missing", "used by"],
          ["asset:a", "asset:a", "used by"],
        ],
      ),
    );
    expect(index.links).toEqual([
      { from: "asset:a", to: "playlist:p", relationship: "included in" },
    ]);
    expect(index.outgoingByKey.get("asset:a")).toHaveLength(1);
    expect(index.incomingByKey.get("playlist:p")).toHaveLength(1);
    expect(index.incomingByKey.has("asset:a")).toBe(false);
  });
});

describe("buildOverviewGraph", () => {
  it("aggregates resources into one node per type instead of one per resource", () => {
    const overview = buildOverviewGraph(buildGraphIndex(fanoutGraph(30)));
    expect(overview.nodes).toHaveLength(9);
    expect(
      Object.fromEntries(overview.nodes.map((node) => [node.type, node.count])),
    ).toMatchObject({ layout: 1, widget: 1, screen: 30, campaign: 0 });
  });

  it("counts the underlying relationships on each type-to-type edge", () => {
    const graph = makeGraph(
      ["asset:a", "asset:b", "playlist:p", "playlist:q", "layout:l"],
      [
        ["asset:a", "playlist:p", "included in"],
        ["asset:b", "playlist:p", "included in"],
        ["asset:b", "playlist:q", "included in"],
        ["asset:a", "layout:l", "used by"],
        ["layout:l", "playlist:q", "included in"],
      ],
    );
    expect(buildOverviewGraph(buildGraphIndex(graph)).edges).toEqual([
      { fromType: "asset", toType: "layout", count: 1 },
      { fromType: "asset", toType: "playlist", count: 3 },
      { fromType: "layout", toType: "playlist", count: 1 },
    ]);
  });
});

describe("buildFocusedSubgraph", () => {
  it("places dependencies at negative and consumers at positive distances", () => {
    expect(layers(chainGraph, "layout:cafe", "both", "all")).toEqual({
      "data_source:menu": -2,
      "widget:board": -1,
      "layout:cafe": 0,
      "playlist:lunch": 1,
      "schedule:noon": 2,
      "screen_group:cafe": 3,
      "screen:cafe-1": 4,
    });
  });

  it.each([
    [1, ["widget:board", "layout:cafe", "playlist:lunch"]],
    [
      2,
      [
        "data_source:menu",
        "widget:board",
        "layout:cafe",
        "playlist:lunch",
        "schedule:noon",
      ],
    ],
    [
      3,
      [
        "data_source:menu",
        "widget:board",
        "layout:cafe",
        "playlist:lunch",
        "schedule:noon",
        "screen_group:cafe",
      ],
    ],
  ] as const)("limits the graph to %s hops", (depth, keys) => {
    expect(
      Object.keys(layers(chainGraph, "layout:cafe", "both", depth)),
    ).toEqual(keys);
  });

  it("follows only the chosen direction", () => {
    expect(
      Object.keys(layers(chainGraph, "layout:cafe", "dependencies", "all")),
    ).toEqual(["data_source:menu", "widget:board", "layout:cafe"]);
    expect(
      Object.keys(layers(chainGraph, "layout:cafe", "consumers", 1)),
    ).toEqual(["layout:cafe", "playlist:lunch"]);
  });

  it("includes the root once and terminates on cycles", () => {
    const cyclic = makeGraph(
      ["layout:a", "playlist:b", "campaign:c"],
      [
        ["layout:a", "playlist:b"],
        ["playlist:b", "layout:a"],
        ["playlist:b", "campaign:c"],
        ["campaign:c", "layout:a"],
      ],
    );
    const subgraph = buildFocusedSubgraph(buildGraphIndex(cyclic), "layout:a", {
      direction: "both",
      depth: "all",
    })!;
    const keys = subgraph.nodes.map((node) => node.key);
    expect(keys.filter((key) => key === "layout:a")).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(["campaign:c", "layout:a", "playlist:b"]);
    // A node reachable both ways sits on the nearer side, consumers on a tie.
    expect(
      subgraph.nodes.find((node) => node.key === "playlist:b")!.layer,
    ).toBe(1);
    expect(
      subgraph.nodes.find((node) => node.key === "campaign:c")!.layer,
    ).toBe(-1);
  });

  it("keeps only links between visible nodes", () => {
    const subgraph = buildFocusedSubgraph(
      buildGraphIndex(chainGraph),
      "layout:cafe",
      { direction: "both", depth: 1 },
    )!;
    expect(subgraph.links.map((link) => `${link.from}>${link.to}`)).toEqual([
      "widget:board>layout:cafe",
      "layout:cafe>playlist:lunch",
    ]);
  });

  it("returns nothing for a root the graph does not contain", () => {
    expect(
      buildFocusedSubgraph(buildGraphIndex(chainGraph), "layout:gone", {
        direction: "both",
        depth: 2,
      }),
    ).toBeUndefined();
  });
});

describe("traverse", () => {
  it("reads adjacency in both directions", () => {
    const index = buildGraphIndex(chainGraph);
    expect([...traverse(index, "playlist:lunch", "dependencies")]).toEqual([
      ["layout:cafe", 1],
      ["widget:board", 2],
      ["data_source:menu", 3],
    ]);
    expect([...traverse(index, "playlist:lunch", "consumers", 2)]).toEqual([
      ["schedule:noon", 1],
      ["screen_group:cafe", 2],
    ]);
  });
});

describe("groupTerminalFanout", () => {
  const explore = (count: number, expanded?: Set<string>) => {
    const index = buildGraphIndex(fanoutGraph(count));
    const subgraph = buildFocusedSubgraph(index, "layout:lobby", {
      direction: "both",
      depth: 2,
    })!;
    return groupTerminalFanout(index, subgraph, { expanded });
  };

  it(`groups ${TERMINAL_FANOUT_THRESHOLD} or more terminal screens into one node`, () => {
    const graph = explore(30);
    expect(graph.nodes.map((node) => node.key)).toEqual([
      "widget:clock",
      "layout:lobby",
    ]);
    expect(graph.groups).toHaveLength(1);
    expect(graph.groups[0]).toMatchObject({
      key: fanoutGroupKey("consumers", "layout:lobby", "screen"),
      anchorKey: "layout:lobby",
      type: "screen",
      side: "consumers",
      layer: 1,
    });
    expect(graph.groups[0]!.members).toHaveLength(30);
    expect(graph.groupLinks).toEqual([
      { from: "layout:lobby", to: graph.groups[0]!.key, count: 30 },
    ]);
    expect(graph.links.every((link) => !link.to.startsWith("screen:"))).toBe(
      true,
    );
  });

  it("leaves fan-outs below the threshold as individual nodes", () => {
    const graph = explore(TERMINAL_FANOUT_THRESHOLD - 1);
    expect(graph.groups).toEqual([]);
    expect(graph.nodes).toHaveLength(TERMINAL_FANOUT_THRESHOLD + 1);
  });

  it("expands a group the operator asked to see", () => {
    const key = fanoutGroupKey("consumers", "layout:lobby", "screen");
    const graph = explore(30, new Set([key]));
    expect(graph.groups).toEqual([]);
    expect(graph.nodes).toHaveLength(32);
    expect(graph.links).toHaveLength(31);
  });

  it("does not hide a screen that another visible node also reaches", () => {
    const screens = keys("screen", "s", 10);
    const shared = makeGraph(
      ["layout:lobby", "schedule:mornings", ...screens],
      [
        ["layout:lobby", "schedule:mornings", "scheduled by"],
        ...screens.map((screen): GraphEdge => [
          "layout:lobby",
          screen,
          "assigned to",
        ]),
        ["schedule:mornings", "screen:s0", "targets"],
      ],
    );
    const index = buildGraphIndex(shared);
    const graph = groupTerminalFanout(
      index,
      buildFocusedSubgraph(index, "layout:lobby", {
        direction: "both",
        depth: 2,
      })!,
    );
    expect(graph.groups[0]!.members).toHaveLength(9);
    expect(graph.nodes.map((node) => node.key)).toContain("screen:s0");
  });

  it("does not group intermediate resources that lead further", () => {
    const layouts = keys("layout", "l", 10);
    const graph = makeGraph(
      ["widget:clock", ...layouts, "playlist:p"],
      layouts.flatMap((layout): GraphEdge[] => [
        ["widget:clock", layout],
        [layout, "playlist:p"],
      ]),
    );
    const index = buildGraphIndex(graph);
    const explorer = groupTerminalFanout(
      index,
      buildFocusedSubgraph(index, "widget:clock", {
        direction: "consumers",
        depth: 1,
      })!,
    );
    expect(explorer.groups).toEqual([]);
    expect(explorer.nodes).toHaveLength(11);
  });

  it("groups standalone sources on the dependency side", () => {
    const assets = keys("asset", "a", 12);
    const graph = makeGraph(
      ["playlist:loop", ...assets],
      assets.map((asset): GraphEdge => [asset, "playlist:loop", "included in"]),
    );
    const index = buildGraphIndex(graph);
    const explorer = groupTerminalFanout(
      index,
      buildFocusedSubgraph(index, "playlist:loop", {
        direction: "both",
        depth: 2,
      })!,
    );
    expect(explorer.groups[0]).toMatchObject({
      side: "dependencies",
      type: "asset",
      layer: -1,
    });
    expect(explorer.groupLinks[0]).toMatchObject({ to: "playlist:loop" });
  });
});

describe("directLinks", () => {
  it("lists a resource's immediate dependencies and consumers", () => {
    const direct = directLinks(buildGraphIndex(chainGraph), "layout:cafe");
    expect(direct.dependencies.map((link) => link.from)).toEqual([
      "widget:board",
    ]);
    expect(direct.consumers.map((link) => link.to)).toEqual(["playlist:lunch"]);
  });
});
