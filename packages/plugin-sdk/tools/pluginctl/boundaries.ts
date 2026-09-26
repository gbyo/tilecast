/**
 * Host-boundary compliance. A plugin depends on the SDK and the host
 * surfaces made for it, never on core internals or on another plugin. The Go
 * toolchain already refuses apps/server/internal imports from the plugins
 * module; this check also covers the rest of apps/ and the TypeScript side,
 * where a relative path could otherwise reach anywhere in the repository.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  walk,
  type DiscoveredPlugin,
  type Problem,
  type Repo,
} from "./repo.ts";

const GO_MODULE_ROOT = "github.com/tilecast/tilecast/";
const GO_ALLOWED_TILECAST = [
  "github.com/tilecast/tilecast/packages/plugin-sdk/go/",
];
/** The server's plugin test harness, allowed in _test.go files only. */
const GO_TEST_HARNESS =
  "github.com/tilecast/tilecast/apps/server/pluginharness";

/** npm packages Studio code may import, in addition to the host surfaces. */
const STUDIO_PACKAGES = [
  "react",
  "react-dom",
  "react-router",
  "react-i18next",
  "i18next",
  "@tanstack/react-query",
  "react-hook-form",
  "@hookform/resolvers",
  "zod",
  "lucide-react",
  "date-fns",
  "recharts",
  "vitest",
  "@testing-library/react",
  "@testing-library/user-event",
  "@testing-library/jest-dom",
];
const STUDIO_HOST = ["@tilecast/studio", "@tilecast/plugin-sdk"];

/** The runtime is engine-agnostic: Lit and the SDK contract only. */
const RUNTIME_PACKAGES = ["lit", "vitest"];
const RUNTIME_HOST = ["@tilecast/plugin-sdk"];

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export function checkBoundaries(repo: Repo): Problem[] {
  const problems: Problem[] = [];
  for (const plugin of repo.plugins) {
    for (const file of walk(plugin.path)) {
      const full = join(plugin.path, file);
      if (file.endsWith(".go")) {
        problems.push(...checkGo(repo, plugin, full));
      } else if (/\.(ts|tsx|mts)$/.test(file)) {
        const area = file.split(sep)[0];
        if (area === "studio") {
          problems.push(
            ...checkTs(repo, plugin, full, STUDIO_HOST, STUDIO_PACKAGES),
          );
        } else if (area === "runtime") {
          problems.push(
            ...checkTs(repo, plugin, full, RUNTIME_HOST, RUNTIME_PACKAGES),
          );
        } else {
          problems.push({
            plugin: plugin.manifest.id,
            file: relative(repo.root, full),
            message:
              "TypeScript belongs in the plugin's studio/ or runtime/ directory",
          });
        }
      }
    }
  }
  return problems;
}

function checkGo(
  repo: Repo,
  plugin: DiscoveredPlugin,
  file: string,
): Problem[] {
  const text = readFileSync(file, "utf8");
  const imports: string[] = [];
  for (const block of text.matchAll(/^import\s*\(([\s\S]*?)^\)/gm)) {
    for (const line of block[1]!.matchAll(/"([^"]+)"/g)) imports.push(line[1]!);
  }
  for (const single of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm))
    imports.push(single[1]!);
  const own = `${GO_MODULE_ROOT}plugins/${plugin.dir}`;
  return imports
    .filter((path) => path.startsWith(GO_MODULE_ROOT))
    .filter((path) => path !== own && !path.startsWith(`${own}/`))
    .filter(
      (path) =>
        !GO_ALLOWED_TILECAST.some((allowed) => path.startsWith(allowed)),
    )
    .filter((path) => !(file.endsWith("_test.go") && path === GO_TEST_HARNESS))
    .map((path) => ({
      plugin: plugin.manifest.id,
      file: relative(repo.root, file),
      message: `imports ${path}; plugins may import only the plugin SDK and their own packages (tests may also import apps/server/pluginharness)`,
    }));
}

function checkTs(
  repo: Repo,
  plugin: DiscoveredPlugin,
  file: string,
  host: string[],
  packages: string[],
): Problem[] {
  const problems: Problem[] = [];
  const info = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
  for (const { fileName: specifier } of info.importedFiles) {
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier);
      if (target !== plugin.path && !target.startsWith(plugin.path + sep)) {
        problems.push({
          plugin: plugin.manifest.id,
          file: relative(repo.root, file),
          message: `imports ${specifier}, which is outside the plugin directory`,
        });
      }
      continue;
    }
    const name = packageName(specifier);
    if (host.includes(name) || packages.includes(name)) continue;
    problems.push({
      plugin: plugin.manifest.id,
      file: relative(repo.root, file),
      message: `imports ${specifier}; allowed are ${[...host, ...packages].join(", ")}`,
    });
  }
  return problems;
}
