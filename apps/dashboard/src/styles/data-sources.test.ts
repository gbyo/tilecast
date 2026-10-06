import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("./data-sources.css", import.meta.url),
  "utf8",
);

function ruleBody(selector: string): string | null {
  const source = stylesheet.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const block of source.split("}")) {
    const [head, ...rest] = block.split("{");
    if (!head || rest.length === 0) continue;
    const selectors = head
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (selectors.includes(selector)) return rest.join("{");
  }
  return null;
}

describe("data-sources editor stylesheet", () => {
  it("keeps the generic Data Source editor footer sticky", () => {
    // Long schema-driven Data Source forms keep Save reachable.
    const body = ruleBody(".source-editor > footer");
    expect(body).not.toBeNull();
    expect(body).toMatch(/position\s*:\s*sticky/);
    expect(body).toMatch(/bottom\s*:\s*0/);
  });

  it("carries no Widget editor rules", () => {
    // The Widget editor composes Tailwind around its primitives; the old
    // stylesheet-driven editors are gone and must not come back here.
    expect(stylesheet).not.toMatch(/\.widget-editor/);
    expect(stylesheet).not.toMatch(/\.v2-editor/);
  });
});
