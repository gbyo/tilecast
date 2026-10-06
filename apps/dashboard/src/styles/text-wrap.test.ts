import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sourceRoot = new URL("../", import.meta.url);

function stylesheets(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      directory,
    );
    if (entry.isDirectory()) return stylesheets(child);
    return entry.name.endsWith(".css") ? [child] : [];
  });
}

describe("text wrapping styles", () => {
  // The text-wrap shorthand includes text-wrap-mode. Set on an element selector in an unlayered
  // rule, it beats Tailwind's `truncate` (white-space: nowrap) and turns the ellipsis into a wrap.
  it("never uses the text-wrap shorthand, which resets text-wrap-mode", () => {
    const offenders = stylesheets(sourceRoot)
      .filter((file) =>
        /(^|[;{\s])text-wrap\s*:/.test(readFileSync(file, "utf8")),
      )
      .map((file) => file.pathname);
    expect(offenders).toEqual([]);
  });

  it("keeps pretty wrapping on headings and paragraphs through text-wrap-style", () => {
    const css = readFileSync(new URL("./signal.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /h1,\s*h2,\s*h3,\s*p\s*{[^}]*text-wrap-style:\s*pretty/,
    );
  });
});
