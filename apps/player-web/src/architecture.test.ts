import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
        ? [path]
        : [];
  });

it("keeps Browser Host independent of Studio and native host implementations", () => {
  for (const path of sources(root)) {
    const source = readFileSync(path, "utf8");
    expect(source, path).not.toMatch(
      /(?:from|import\s*\()\s*["'][^"']*(?:dashboard|player-linux|player-android|player-windows|apps\/edge)/,
    );
    expect(source, path).not.toMatch(
      /\blocalStorage\b|\bsessionStorage\b|\bgetDisplayMedia\b/,
    );
    expect(source, path).not.toMatch(/from\s*["'](?:react|react-dom)/);
  }
});
