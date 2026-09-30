import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  new URL("./data-sources.css", import.meta.url),
  "utf8",
);

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

describe("data-sources editor stylesheet", () => {
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
});
