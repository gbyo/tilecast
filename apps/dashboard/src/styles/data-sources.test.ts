import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("./data-sources.css", import.meta.url),
  "utf8",
);

function ruleBody(selector: string, source = stylesheet): string | null {
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

function mediaBlock(query: string): string | null {
  const start = stylesheet.indexOf(query);
  if (start < 0) return null;
  const open = stylesheet.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < stylesheet.length; i += 1) {
    if (stylesheet[i] === "{") depth += 1;
    else if (stylesheet[i] === "}") {
      depth -= 1;
      if (depth === 0) return stylesheet.slice(open + 1, i);
    }
  }
  return null;
}

describe("data-sources editor stylesheet", () => {
  it("keeps the V2 live preview stuck alongside long inspectors", () => {
    const body = ruleBody(".v2-editor__preview");
    expect(body).not.toBeNull();
    expect(body).toMatch(/position\s*:\s*sticky/);
    expect(body).toMatch(/top\s*:/);
    expect(body).toMatch(/max-height\s*:/);
    expect(body).toMatch(/overflow\s*:\s*auto/);
    const routeBody = ruleBody(".app-editor-route .v2-editor__preview");
    expect(routeBody).not.toBeNull();
    expect(routeBody).toMatch(/top\s*:\s*calc\(56px/);
  });

  it("docks a compact sticky preview on narrow screens", () => {
    const narrow = mediaBlock("@media (max-width: 1100px)");
    expect(narrow).not.toBeNull();
    const source = narrow as unknown as string;
    const body = ruleBody(".v2-editor__preview", source);
    expect(body).not.toBeNull();
    expect(body).toMatch(/order\s*:\s*-1/);
    const height = body?.match(/max-height\s*:\s*(\d+)dvh/);
    expect(height).not.toBeNull();
    expect(Number(height?.[1])).toBeLessThan(100);
    expect(body).toMatch(/background\s*:/);
    expect(body).toMatch(/z-index\s*:/);
    expect(
      ruleBody(".app-editor-route .v2-editor__preview", source),
    ).not.toBeNull();
  });
});
