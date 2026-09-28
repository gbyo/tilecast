/**
 * Host-boundary compliance. A plugin depends on the SDK and the host
 * surfaces made for it, never on core internals or on another plugin. The Go
 * toolchain already refuses apps/server/internal imports from the plugins
 * module; this check also covers the rest of apps/ and the TypeScript side,
 * where a relative path could otherwise reach anywhere in the repository.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  "@tanstack/react-table",
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

/**
 * Nested Widgets are ordinary Widgets in a plugin's directory: the Widget
 * SDK (including its testing and stories surfaces), Lit, the shared
 * widget-kit, and the tools' own test/story runners. Relative imports must
 * stay inside the plugin directory, like every other area.
 */
const WIDGET_TS_PACKAGES = [
  "lit",
  "vitest",
  "@storybook/web-components-vite",
  "@tilecast/widget-kit",
];
const WIDGET_TS_HOST = ["@tilecast/widget-sdk"];

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
        } else if (area === "widgets") {
          problems.push(
            ...checkTs(repo, plugin, full, WIDGET_TS_HOST, WIDGET_TS_PACKAGES),
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

const COMMENTS_OUTSIDE_STRINGS =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const STATIC_IMPORT =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
const CALLED_IMPORT = /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;

// The TypeScript compiler API is not available from the native compiler, so
// the boundary check scans module specifiers itself. It errs toward reporting
// too many specifiers, never too few.
export function importSpecifiers(source: string): string[] {
  const code = source.replace(
    COMMENTS_OUTSIDE_STRINGS,
    (_match, quoted) => quoted ?? " ",
  );
  return [
    ...[...code.matchAll(STATIC_IMPORT)].map((match) => match[1]!),
    ...[...code.matchAll(CALLED_IMPORT)].map((match) => match[1]!),
  ];
}

function checkTs(
  repo: Repo,
  plugin: DiscoveredPlugin,
  file: string,
  host: string[],
  packages: string[],
): Problem[] {
  const problems: Problem[] = [];
  for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
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
