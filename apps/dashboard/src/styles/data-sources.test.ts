import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("./data-sources.css", import.meta.url),
  "utf8",
);

function ruleBody(selector: string): string | null {
  for (const block of stylesheet.split("}")) {
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
  it("keeps every generic editor footer sticky, not just widgets", () => {
    // Both GenericWidgetEditor and GenericDataSourceEditor render
    // GenericEditorShell with the shared `source-editor` class, so the
    // sticky footer rule must hang off that class to keep Save reachable
    // in long schema-driven Data Source forms too.
    const body = ruleBody(".source-editor > footer");
    expect(body).not.toBeNull();
    expect(body).toMatch(/position\s*:\s*sticky/);
    expect(body).toMatch(/bottom\s*:\s*0/);
  });
});
