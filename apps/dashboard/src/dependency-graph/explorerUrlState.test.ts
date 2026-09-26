import { describe, expect, it } from "vitest";
import { explorerSearch, parseExplorerParams } from "./explorerUrlState";

const parse = (search: string) =>
  parseExplorerParams(new URLSearchParams(search));

describe("parseExplorerParams", () => {
  it("restores a focused resource with its direction and depth", () => {
    expect(parse("?node=widget:abc&direction=consumers&depth=3")).toEqual({
      node: "widget:abc",
      type: undefined,
      direction: "consumers",
      depth: 3,
    });
    expect(parse("?node=screen:x&depth=all").depth).toBe("all");
  });

  it("defaults to the overview with both directions and two hops", () => {
    expect(parse("")).toEqual({
      node: undefined,
      type: undefined,
      direction: "both",
      depth: 2,
    });
  });

  it.each([
    "?node=widget",
    "?node=widget:",
    "?node=:abc",
    "?node=gadget:abc",
    "?node=",
  ])("ignores a malformed node in %s", (search) => {
    expect(parse(search).node).toBeUndefined();
  });

  it("falls back to defaults for unknown options", () => {
    const state = parse("?node=layout:a&direction=sideways&depth=9");
    expect(state.direction).toBe("both");
    expect(state.depth).toBe(2);
  });

  it("reads a browsed type only in the overview", () => {
    expect(parse("?type=screen").type).toBe("screen");
    expect(parse("?type=gadget").type).toBeUndefined();
    expect(parse("?node=layout:a&type=screen").type).toBeUndefined();
  });
});

describe("explorerSearch", () => {
  it("omits defaults", () => {
    expect(
      explorerSearch({ node: "layout:a", direction: "both", depth: 2 }),
    ).toBe("?node=layout%3Aa");
    expect(explorerSearch({})).toBe("");
  });

  it("round-trips non-default options", () => {
    const search = explorerSearch({
      node: "layout:a",
      direction: "dependencies",
      depth: "all",
    });
    expect(search).toBe("?node=layout%3Aa&direction=dependencies&depth=all");
    expect(parse(search)).toMatchObject({
      node: "layout:a",
      direction: "dependencies",
      depth: "all",
    });
  });

  it("drops focus options from the overview", () => {
    expect(explorerSearch({ type: "screen", direction: "consumers" })).toBe(
      "?type=screen",
    );
  });
});
