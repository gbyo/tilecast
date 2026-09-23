import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const tokensDir = fileURLToPath(
  new URL("../../../../../packages/design-tokens/", import.meta.url),
);

function readTokenFile(name: string) {
  return readFileSync(`${tokensDir}${name}`, "utf8");
}

/** Collects `--name: value` pairs from the first block matching `selector`. */
function declarationsIn(css: string, selector: string) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`Missing selector ${selector}`);
  const open = css.indexOf("{", start);
  const block = css.slice(open + 1, css.indexOf("}", open));
  const pairs = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (name && value) pairs.set(name, value.trim());
  }
  return pairs;
}

/**
 * Resolves a token to a literal hex, following `var(--x)` indirection.
 * Later maps win, mirroring the cascade order the browser applies.
 */
function resolveToken(name: string, ...scopes: Map<string, string>[]) {
  let value: string | undefined;
  for (const scope of scopes) value = scope.get(name) ?? value;
  if (!value) throw new Error(`Unresolved token ${name}`);
  const reference = value.match(/^var\(\s*(--[\w-]+)/);
  if (reference?.[1]) return resolveToken(reference[1], ...scopes);
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`Token ${name} is not a plain hex: ${value}`);
  }
  return value.slice(1).toUpperCase();
}

function luminance(hex: string) {
  const channels = hex
    .match(/.{2}/g)
    ?.map((value) => parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error("Invalid test color");
  const [red = 0, green = 0, blue = 0] = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

describe("Tilecast Signal contrast", () => {
  it.each([
    ["FFFFFF", "3E6FE0", "primary button"],
    ["17212B", "F6F8FA", "light canvas text"],
    ["1A2333", "FFFFFF", "light field value"],
    ["3D4C66", "FFFFFF", "light secondary button"],
    ["C23B46", "FFFFFF", "light notification badge"],
    ["F5F7FA", "151D26", "dark surface text"],
    ["0E141B", "F4C15A", "amber identity mark"],
  ])("meets AA for %s on %s (%s)", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});

/*
 * These read the token files rather than hardcoding hexes, so reverting the
 * dark-mode --tc-status-danger override fails the suite instead of silently
 * dropping danger text back to ~3.5:1.
 */
describe("dark-mode danger tokens", () => {
  const palette = declarationsIn(readTokenFile("colors.css"), ":root");
  const semantic = readTokenFile("semantic.css");
  const base = declarationsIn(semantic, ":root");
  const dark = declarationsIn(semantic, "html.dark");
  const scopes = [palette, base, dark];

  const danger = resolveToken("--tc-status-danger", ...scopes);

  it.each([
    ["--tc-bg-canvas", "canvas"],
    ["--tc-status-danger-bg", "danger surface"],
    ["--tc-bg-subtle", "subtle surface"],
  ])("danger text meets AA on %s (%s)", (background) => {
    const surface = resolveToken(background, ...scopes);
    expect(contrast(danger, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a solid danger fill dark enough to carry white text", () => {
    const fill = resolveToken("--tc-status-danger-solid", ...scopes);
    expect(contrast("FFFFFF", fill)).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves the light theme danger colour unchanged", () => {
    expect(resolveToken("--tc-status-danger", palette, base)).toBe("C23B46");
  });
});
