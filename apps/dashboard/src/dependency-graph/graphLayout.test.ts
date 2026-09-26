import { describe, expect, it } from "vitest";
import { layoutFocus, layoutOverview } from "./graphLayout";
import {
  buildFocusedSubgraph,
  buildGraphIndex,
  buildOverviewGraph,
  groupTerminalFanout,
  type Direction,
} from "./graphModel";
import { chainGraph, fanoutGraph, makeGraph } from "./testGraphs";

function focusLayout(
  graph: ReturnType<typeof makeGraph>,
  root: string,
  direction: Direction = "both",
) {
  const index = buildGraphIndex(graph);
  return layoutFocus(
    groupTerminalFanout(
      index,
      buildFocusedSubgraph(index, root, { direction, depth: "all" })!,
    ),
  );
}

const boxOf = (layout: ReturnType<typeof layoutFocus>, key: string) =>
  layout.items.find((item) => item.key === key)!.box;

describe("layoutOverview", () => {
  it("draws nine type nodes whose positions do not depend on counts", () => {
    const small = layoutOverview(
      buildOverviewGraph(buildGraphIndex(chainGraph)),
    );
    const large = layoutOverview(
      buildOverviewGraph(buildGraphIndex(fanoutGraph(300))),
    );
    expect(small.items).toHaveLength(9);
    expect(large.items).toHaveLength(9);
    expect(large.items.map((item) => [item.key, item.box])).toEqual(
      small.items.map((item) => [item.key, item.box]),
    );
    expect(small.headings.map((heading) => heading.key)).toEqual([
      "sources",
      "presentations",
      "delivery",
    ]);
  });

  it("draws one edge per type pair with its relationship count", () => {
    const layout = layoutOverview(
      buildOverviewGraph(buildGraphIndex(fanoutGraph(30))),
    );
    expect(layout.edges.map((edge) => [edge.key, edge.count])).toEqual([
      ["widget>layout", 1],
      ["layout>screen", 30],
    ]);
  });
});

describe("layoutFocus", () => {
  it("centres the root with dependencies left and consumers right", () => {
    const layout = focusLayout(chainGraph, "playlist:lunch");
    const root = boxOf(layout, "playlist:lunch");
    const x = (key: string) => boxOf(layout, key).x;
    expect(x("widget:board")).toBeLessThan(x("layout:cafe"));
    expect(x("layout:cafe")).toBeLessThan(root.x);
    expect(root.x).toBeLessThan(x("schedule:noon"));
    expect(x("schedule:noon")).toBeLessThan(x("screen_group:cafe"));
    expect(layout.focusKey).toBe("playlist:lunch");
    expect(layout.headings.map((heading) => heading.key)).toEqual([
      "dependencies",
      "consumers",
    ]);
  });

  it("centres each layer vertically on the root", () => {
    const graph = makeGraph(
      ["layout:root", "playlist:a", "playlist:b", "playlist:c"],
      [
        ["layout:root", "playlist:a"],
        ["layout:root", "playlist:b"],
        ["layout:root", "playlist:c"],
      ],
    );
    const layout = focusLayout(graph, "layout:root");
    const root = boxOf(layout, "layout:root");
    expect(boxOf(layout, "playlist:b").y).toBe(root.y);
    expect(boxOf(layout, "playlist:a").y).toBeLessThan(root.y);
    expect(boxOf(layout, "playlist:c").y).toBeGreaterThan(root.y);
  });

  it("re-lays out without the unrelated side when the direction changes", () => {
    const both = focusLayout(chainGraph, "playlist:lunch", "both");
    const consumers = focusLayout(chainGraph, "playlist:lunch", "consumers");
    expect(both.items).toHaveLength(7);
    expect(consumers.items.map((item) => item.key)).toEqual([
      "playlist:lunch",
      "schedule:noon",
      "screen_group:cafe",
      "screen:cafe-1",
    ]);
    // The root moves to the first column instead of keeping empty space.
    expect(boxOf(consumers, "playlist:lunch").x).toBeLessThan(
      boxOf(both, "playlist:lunch").x,
    );
    expect(consumers.width).toBeLessThan(both.width);
  });

  it("orders a layer by its neighbours nearer the root", () => {
    // b's consumer is listed first alphabetically but feeds from the lower
    // parent, so the barycentre pass moves it below.
    const graph = makeGraph(
      [
        "layout:root",
        ["playlist:p1", "A playlist"],
        ["playlist:p2", "B playlist"],
        ["schedule:s1", "A schedule"],
        ["schedule:s2", "B schedule"],
      ],
      [
        ["layout:root", "playlist:p1"],
        ["layout:root", "playlist:p2"],
        ["playlist:p1", "schedule:s2"],
        ["playlist:p2", "schedule:s1"],
      ],
    );
    const layout = focusLayout(graph, "layout:root");
    expect(boxOf(layout, "schedule:s2").y).toBeLessThan(
      boxOf(layout, "schedule:s1").y,
    );
  });

  it("is stable for the same input", () => {
    expect(focusLayout(chainGraph, "layout:cafe")).toEqual(
      focusLayout(chainGraph, "layout:cafe"),
    );
  });

  it("gives a collapsed fan-out one node and one edge", () => {
    const layout = focusLayout(fanoutGraph(30), "layout:lobby");
    expect(layout.items.map((item) => item.kind)).toEqual([
      "resource",
      "resource",
      "group",
    ]);
    expect(layout.edges).toHaveLength(2);
  });
});
