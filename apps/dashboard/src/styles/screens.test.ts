import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("./screens.css", import.meta.url),
  "utf8",
);

/** Everything inside the first block whose prelude starts with `prelude`. */
function blockAfter(prelude: string): string {
  const start = stylesheet.indexOf(prelude);
  expect(start, `${prelude} is missing`).toBeGreaterThanOrEqual(0);
  const open = stylesheet.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === "{") depth += 1;
    if (stylesheet[index] === "}") {
      depth -= 1;
      if (depth === 0) return stylesheet.slice(open + 1, index);
    }
  }
  throw new Error(`${prelude} is not closed`);
}

describe("preview freshness rail styles", () => {
  it("turns the sweep off for the system reduced-motion preference", () => {
    const block = blockAfter("@media (prefers-reduced-motion: reduce)");
    expect(block).toMatch(/\.screen-preview-rail\[data-state\][^{]*sweep/);
    expect(block).toMatch(/animation:\s*none/);
  });

  it("turns the sweep off for Tilecast's reduced-motion preference", () => {
    const block = blockAfter(
      'html[data-reduced-motion="true"]\n  .screen-preview-rail[data-state]',
    );
    expect(block).toMatch(/animation:\s*none/);
  });

  it("animates only transform on the sweep and uses the shared motion tokens", () => {
    const keyframes = blockAfter("@keyframes screen-preview-rail-sweep");
    expect(keyframes).toContain("transform");
    expect(keyframes).not.toMatch(/left|width|opacity/);
    expect(stylesheet).toContain("var(--tc-motion-standard)");
    expect(stylesheet).toContain("var(--tc-ease-standard)");
    expect(stylesheet).not.toContain("will-change");
  });
});
