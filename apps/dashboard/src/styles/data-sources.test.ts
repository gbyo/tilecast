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

function ruleBodiesFor(className: string): string[] {
  const bodies: string[] = [];
  for (const block of stylesheet.split("}")) {
    const [head, ...rest] = block.split("{");
    if (!head || rest.length === 0) continue;
    const selectors = head
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (
      selectors.some((selector) =>
        selector.split(/\s+/).some((part) => part.includes(className)),
      )
    ) {
      bodies.push(rest.join("{"));
    }
  }
  return bodies;
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

  it("keeps Data Source bodies single-column at every width", () => {
    // GenericDataSourceEditor renders .source-editor__body in an unstyled
    // block-flow div, so its fields already stack in one column. No rule
    // may reintroduce a multi-column body layout; the two-column Widget +
    // preview surface lives on .widget-editor__layout instead.
    const bodies = ruleBodiesFor("source-editor__body");
    expect(bodies.filter((body) => /grid-template-columns/.test(body))).toEqual(
      [],
    );
    expect(
      bodies.filter((body) => /flex-direction\s*:\s*row/.test(body)),
    ).toEqual([]);
    expect(stylesheet).not.toContain(".widget-editor > .source-editor__body");
  });

  it("leaves the two-column Widget + preview layout untouched", () => {
    expect(stylesheet).toMatch(
      /\.widget-editor__layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(340px,\s*0\.82fr\)/,
    );
  });

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
