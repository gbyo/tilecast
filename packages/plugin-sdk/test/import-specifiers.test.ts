import { describe, expect, it } from "vitest";
import { importSpecifiers } from "../tools/pluginctl/boundaries";

describe("importSpecifiers", () => {
  it("finds every static and dynamic module specifier", () => {
    const source = `
      import a from "pkg-a";
      import type { B } from '@scope/pkg-b/sub';
      import "side-effect";
      import {
        c,
        d,
      } from "../outside";
      export * from "pkg-e";
      export { f } from "pkg-f";
      const g = await import("pkg-g");
      const h = require("pkg-h");
    `;
    expect(importSpecifiers(source).sort()).toEqual(
      [
        "../outside",
        "@scope/pkg-b/sub",
        "pkg-a",
        "pkg-e",
        "pkg-f",
        "pkg-g",
        "pkg-h",
        "side-effect",
      ].sort(),
    );
  });

  it("ignores commented-out imports and URLs in strings", () => {
    const source = `
      // import x from "commented-line";
      /* import y from "commented-block"; */
      const url = "https://example.org/path"; // import w from "trailing";
      export const value = "from";
    `;
    expect(importSpecifiers(source)).toEqual([]);
  });
});
