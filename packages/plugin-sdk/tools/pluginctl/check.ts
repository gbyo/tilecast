/**
 * `plugins:check`: everything that can be known about a plugin without
 * compiling it. The Go and Vitest conformance suites cover what needs the
 * code itself (implemented contributions against declared capabilities,
 * status, removal, rendering).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import YAML from "yaml";
import {
  conventionalEntrypoints,
  playerEntryTypes,
  reservedPlayerEntryTypes,
  runtimeEntrypoint,
} from "../../src/manifest.ts";
import { checkAutomationFiles } from "./automation.ts";
import { checkBoundaries } from "./boundaries.ts";
import { checkCssScope } from "./css-scope.ts";
import { generate, stale } from "./generate.ts";
import { COMPOSED_OPENAPI, CORE_OPENAPI } from "./openapi.ts";
import {
  checkDerivedConformance,
  checkFragmentOperationIds,
} from "./supported.ts";
import {
  dirForId,
  walk,
  type DiscoveredPlugin,
  type Problem,
  type Repo,
} from "./repo.ts";

const DOCS_CONTENT = "apps/docs/src/content/docs";
const WIDGET_SCHEMA = "packages/widget-sdk/schema/tilecast-widget.schema.json";
const DATA_SOURCE_SCHEMA =
  "packages/data-source-sdk/schema/tilecast-datasource.schema.json";

export async function check(repo: Repo): Promise<Problem[]> {
  const problems: Problem[] = [...repo.problems];
  const validateWidget = loadWidgetValidator(repo.root, problems);
  const validateDataSource = loadDataSourceValidator(repo.root, problems);
  const ids = new Map<string, string>();
  const manifestTypes = new Map<string, string>();
  const slugs = new Map<string, string>();
  const bases: { base: string; id: string }[] = [];
  const studioRoutes: { route: string; id: string }[] = [];

  for (const plugin of repo.plugins) {
    const { manifest } = plugin;
    const id = manifest.id;
    const add = (message: string, file?: string) =>
      problems.push({ plugin: id, file, message });

    if (ids.has(id)) add(`id is also used by plugins/${ids.get(id)}`);
    ids.set(id, plugin.dir);
    if (plugin.dir !== dirForId(id))
      add(`directory must be named plugins/${dirForId(id)}`);

    checkServer(plugin, add);
    checkConventionalEntrypoints(plugin, add);

    if (manifest.studio) {
      const expected = `/plugins/${plugin.dir}`;
      if (manifest.studio.route !== expected)
        add(`studio.route must be ${expected}`);
      requireFile(plugin, manifest.studio.entrypoint, "studio.entrypoint", add);
      for (const route of manifest.studio.additionalRoutes ?? []) {
        if (route === "/plugins" || route.startsWith("/plugins/")) {
          add(`studio additional route ${route} must not live below /plugins`);
        }
        for (const other of studioRoutes) {
          if (
            route === other.route ||
            route.startsWith(`${other.route}/`) ||
            other.route.startsWith(`${route}/`)
          ) {
            add(
              `studio additional route ${route} overlaps ${other.route} of ${other.id}`,
            );
          }
        }
        studioRoutes.push({ route, id });
      }
      studioRoutes.push({ route: manifest.studio.route, id });
    }

    for (const type of playerEntryTypes(manifest)) {
      if ((reservedPlayerEntryTypes as readonly string[]).includes(type))
        add(`Player entry type ${type} is reserved for the host`);
      if (manifestTypes.has(type))
        add(
          `Player entry type ${type} is also owned by ${manifestTypes.get(type)}`,
        );
      manifestTypes.set(type, id);
    }
    if (manifest.apiVersion === 1 && manifest.runtime) {
      if (manifest.runtime.entrypoint) {
        requireFile(
          plugin,
          manifest.runtime.entrypoint,
          "runtime.entrypoint",
          add,
        );
      }
      if (!manifest.capabilities.playerManifest) {
        add("a runtime entry needs capabilities.playerManifest");
      }
      if (
        manifest.runtime.surfaces.length > 0 &&
        !manifest.runtime.entrypoint
      ) {
        add(
          "a plugin that declares runtime.surfaces must render them in ./runtime/index.ts",
        );
      }
    }
    if (manifest.apiVersion === 2) checkPlayerContribution(plugin, add);

    if (manifest.api) {
      if (!manifest.server) add("api routes need a server entry point");
      if (!manifest.api.openapi)
        add("a plugin with api.basePaths must describe them in api.openapi");
      for (const base of manifest.api.basePaths) {
        for (const other of bases) {
          if (
            base === other.base ||
            base.startsWith(`${other.base}/`) ||
            other.base.startsWith(`${base}/`)
          ) {
            add(`api base path ${base} overlaps ${other.base} of ${other.id}`);
          }
        }
        bases.push({ base, id });
      }
    }

    if (!manifest.docs?.reference && (manifest.docs?.pages.length ?? 0) === 0) {
      add("document the plugin: add docs.pages or docs.reference");
    }
    for (const page of manifest.docs?.pages ?? []) {
      requireFile(plugin, page.source, "docs.pages.source", add);
      if (slugs.has(page.slug))
        add(`docs slug ${page.slug} is also used by ${slugs.get(page.slug)}`);
      slugs.set(page.slug, id);
      for (const extension of [".md", ".mdx", "/index.md", "/index.mdx"]) {
        const collision = join(repo.root, DOCS_CONTENT, page.slug + extension);
        if (existsSync(collision))
          add(
            `docs slug ${page.slug} collides with ${relative(repo.root, collision)}`,
          );
      }
    }

    for (const file of walk(join(plugin.path, "runtime"))) {
      if (!file.endsWith(".css")) continue;
      const path = join("runtime", file);
      for (const problem of checkCssScope(
        readFileSync(join(plugin.path, path), "utf8"),
        plugin.dir,
      )) {
        add(`${path}: ${problem}`);
      }
    }

    checkTests(plugin, add);
    checkWidgetContributions(repo.root, plugin, validateWidget, add);
    checkDataSourceContributions(repo.root, plugin, validateDataSource, add);
  }

  problems.push(...checkBoundaries(repo));

  const generated = await generate(repo);
  problems.push(...generated.problems);
  const composed = generated.files.get(COMPOSED_OPENAPI);
  const corePath = join(repo.root, CORE_OPENAPI);
  if (composed !== undefined && existsSync(corePath)) {
    problems.push(
      ...checkDerivedConformance(
        YAML.parseDocument(composed),
        YAML.parseDocument(readFileSync(corePath, "utf8")),
      ),
    );
  }
  const fragments = readApiFragments(repo);
  problems.push(...checkFragmentOperationIds(fragments));
  problems.push(...checkAutomationFiles(repo, fragments));

  for (const path of stale(repo, generated.files)) {
    problems.push({
      file: path,
      message: "generated file is stale; run npm run plugins:generate",
    });
  }
  return problems;
}

type Add = (message: string, file?: string) => void;

/**
 * Compile the portable Widget manifest schema once for nested
 * contribution checks. A missing schema is a repo-level problem; every
 * nested manifest then reports that it cannot be validated.
 */
function loadWidgetValidator(
  root: string,
  problems: Problem[],
): ((manifest: unknown) => string[]) | null {
  const path = join(root, WIDGET_SCHEMA);
  try {
    const schema = JSON.parse(readFileSync(path, "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    return (manifest: unknown) => {
      if (validate(manifest)) return [];
      return (validate.errors ?? []).slice(0, 3).map((error) => {
        const extra =
          typeof (error.params as { additionalProperty?: unknown })
            ?.additionalProperty === "string"
            ? `(${(error.params as { additionalProperty: string }).additionalProperty}) `
            : "";
        return `manifest${error.instancePath || ""} ${extra}${error.message ?? "is invalid"}`;
      });
    };
  } catch {
    problems.push({
      file: WIDGET_SCHEMA,
      message: "widget schema is missing; run npm run widgets:generate",
    });
    return null;
  }
}

/**
 * Ownership checks for a plugin's nested Widgets. The Widget lives beneath
 * the plugin's own directory, so its source identity is the parent
 * manifest id by construction; this check confirms the manifest itself is
 * a conforming Widget that claims nothing else. Deep conformance (stories,
 * tests, fixtures, runtime entrypoint, cross-source collisions) stays in
 * widgets:check, which discovers the same directories; extensions:check
 * runs every suite.
 */
function checkWidgetContributions(
  root: string,
  plugin: DiscoveredPlugin,
  validateWidget: ((manifest: unknown) => string[]) | null,
  add: Add,
): void {
  const widgetsDir = join(plugin.path, "widgets");
  let names: string[];
  try {
    names = readdirSync(widgetsDir).filter(
      (name) =>
        !name.startsWith(".") &&
        name !== "node_modules" &&
        statSync(join(widgetsDir, name)).isDirectory(),
    );
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const manifestPath = join(widgetsDir, name, "tilecast.widget.json");
    const relativePath = relative(root, manifestPath);
    if (!existsSync(manifestPath)) {
      add(`widgets/${name} has no tilecast.widget.json`);
      continue;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      add(`widgets/${name}/tilecast.widget.json is not valid JSON`);
      continue;
    }
    if (validateWidget === null) {
      add(`widgets/${name} cannot be validated without ${WIDGET_SCHEMA}`);
      continue;
    }
    for (const problem of validateWidget(manifest)) {
      add(`widgets/${name}: ${problem}`, relativePath);
    }
    const entrypoint = (manifest as { component?: { entrypoint?: unknown } })
      ?.component?.entrypoint;
    if (typeof entrypoint === "string" && entrypoint.startsWith("./")) {
      if (!existsSync(join(widgetsDir, name, entrypoint.slice(2)))) {
        add(
          `widgets/${name} entrypoint ${entrypoint} does not exist`,
          relativePath,
        );
      }
    }
  }
}

/**
 * Compile the portable Data Source manifest schema once for nested
 * contribution checks. A missing schema is a repo-level problem; every
 * nested manifest then reports that it cannot be validated.
 */
function loadDataSourceValidator(
  root: string,
  problems: Problem[],
): ((manifest: unknown) => string[]) | null {
  const path = join(root, DATA_SOURCE_SCHEMA);
  try {
    const schema = JSON.parse(readFileSync(path, "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    return (manifest: unknown) => {
      if (validate(manifest)) return [];
      return (validate.errors ?? []).slice(0, 3).map((error) => {
        const extra =
          typeof (error.params as { additionalProperty?: unknown })
            ?.additionalProperty === "string"
            ? `(${(error.params as { additionalProperty: string }).additionalProperty}) `
            : "";
        return `manifest${error.instancePath || ""} ${extra}${error.message ?? "is invalid"}`;
      });
    };
  } catch {
    problems.push({
      file: DATA_SOURCE_SCHEMA,
      message:
        "data source schema is missing; run npm run data-sources:generate",
    });
    return null;
  }
}

/**
 * Ownership checks for a plugin's nested Data Sources. The module lives
 * beneath the plugin's own directory, so its source identity is the
 * parent manifest id by construction; this check confirms the manifest
 * itself is a conforming Data Source that claims nothing else and ships
 * its sample-configuration fixture. Deep conformance (adapter bindings,
 * fetch safety, fixtures, cross-source collisions) stays in
 * data-sources:check, which discovers the same directories;
 * extensions:check runs all three suites.
 */
function checkDataSourceContributions(
  root: string,
  plugin: DiscoveredPlugin,
  validateDataSource: ((manifest: unknown) => string[]) | null,
  add: Add,
): void {
  const sourcesDir = join(plugin.path, "data-sources");
  let names: string[];
  try {
    names = readdirSync(sourcesDir).filter(
      (name) =>
        !name.startsWith(".") &&
        name !== "node_modules" &&
        statSync(join(sourcesDir, name)).isDirectory(),
    );
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const manifestPath = join(sourcesDir, name, "tilecast.datasource.json");
    const relativePath = relative(root, manifestPath);
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      add(`data-sources/${name}/tilecast.datasource.json is not valid JSON`);
      continue;
    }
    if (validateDataSource === null) {
      add(
        `data-sources/${name} cannot be validated without ${DATA_SOURCE_SCHEMA}`,
      );
      continue;
    }
    for (const problem of validateDataSource(manifest)) {
      add(`data-sources/${name}: ${problem}`, relativePath);
    }
    if (!existsSync(join(sourcesDir, name, "fixtures", "default.json"))) {
      add(
        `data-sources/${name} is missing fixtures/default.json: every module ships a sample configuration`,
        relativePath,
      );
    }
  }
}

/** Raw plugin API fragments for the operation-ID contract. */
function readApiFragments(
  repo: Repo,
): { plugin: string; file: string; text: string }[] {
  const fragments: { plugin: string; file: string; text: string }[] = [];
  for (const plugin of repo.plugins) {
    const declared = plugin.manifest.api?.openapi;
    if (!declared) continue;
    const absolute = join(plugin.path, declared);
    if (!existsSync(absolute)) continue;
    fragments.push({
      plugin: plugin.manifest.id,
      file: relative(repo.root, absolute),
      text: readFileSync(absolute, "utf8"),
    });
  }
  return fragments;
}

function requireFile(
  plugin: DiscoveredPlugin,
  path: string,
  field: string,
  add: Add,
) {
  if (!existsSync(join(plugin.path, path)))
    add(`${field} ${path} does not exist`);
}

/**
 * A Plugin API v2 Player contribution. The Shared Runtime part must exist at
 * its conventional path. Each native contribution is a Rust crate in
 * native/<id>/ that implements player_core::NativePluginContribution; the
 * two directions must agree, like the conventional entry points.
 */
function checkPlayerContribution(plugin: DiscoveredPlugin, add: Add) {
  const { manifest } = plugin;
  if (manifest.apiVersion !== 2) return;
  const player = manifest.player;
  if (player?.runtime) {
    requireFile(
      plugin,
      player.runtime.entrypoint,
      "player.runtime.entrypoint",
      add,
    );
  }
  const declared = new Set((player?.native ?? []).map((native) => native.id));
  const workspace = readWorkspaceMembers(plugin.path);
  for (const id of declared) {
    const cargo = join(plugin.path, "native", id, "Cargo.toml");
    if (!existsSync(cargo)) {
      add(
        `native contribution ${id} needs a crate at native/${id}/Cargo.toml implementing player_core::NativePluginContribution`,
      );
      continue;
    }
    const member = `plugins/${plugin.dir}/native/${id}`;
    if (workspace !== null && !workspace.includes(member))
      add(`native contribution ${id}: add ${member} to the Cargo workspace`);
    for (const dependency of cargoDependencies(readFileSync(cargo, "utf8"))) {
      if (!NATIVE_DEPENDENCIES.includes(dependency))
        add(
          `native contribution ${id} depends on ${dependency}; native contributions use player-core and player-types, never Edge or platform crates`,
        );
    }
  }
  const nativeDir = join(plugin.path, "native");
  if (existsSync(nativeDir)) {
    for (const name of readdirSync(nativeDir)) {
      if (!statSync(join(nativeDir, name)).isDirectory()) continue;
      if (!declared.has(name))
        add(`native/${name} exists but player.native does not declare it`);
    }
  }
}

/**
 * Crates a native contribution may depend on: the shared Player contracts and
 * plain data libraries. Platform behavior reaches it through typed Core
 * interfaces, so it never names Edge, Windows, or Android crates.
 */
const NATIVE_DEPENDENCIES = [
  "player-core",
  "player-types",
  "serde",
  "serde_json",
  "thiserror",
  "tracing",
  "uuid",
  "jiff",
];

/** Dependency names in [dependencies] and [dev-dependencies]. */
export function cargoDependencies(text: string): string[] {
  const names: string[] = [];
  let inDependencies = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inDependencies = /^\[(dev-)?dependencies\]$/.test(line);
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)(?:\.workspace)?\s*=/.exec(line);
    if (inDependencies && match?.[1]) names.push(match[1]);
  }
  return names;
}

/** Root Cargo workspace members, or null when there is no workspace file. */
function readWorkspaceMembers(pluginPath: string): string[] | null {
  const path = join(pluginPath, "..", "..", "Cargo.toml");
  if (!existsSync(path)) return null;
  const members = /members\s*=\s*\[([^\]]*)\]/.exec(readFileSync(path, "utf8"));
  return [...(members?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

function checkServer(plugin: DiscoveredPlugin, add: Add) {
  const server = plugin.manifest.server;
  if (!server) {
    add(
      "server.entrypoint is required: the catalog and installation state are server-side",
    );
    return;
  }
  const entry = join(plugin.path, server.entrypoint);
  if (!existsSync(entry)) {
    add(`server.entrypoint ${server.entrypoint} does not exist`);
    return;
  }
  if (!plugin.goPackage) add(`${server.entrypoint} has no package clause`);
  const text = readFileSync(entry, "utf8");
  if (!/^func New\(\) plugin\.Plugin \{/m.test(text)) {
    add(`${server.entrypoint} must declare func New() plugin.Plugin`);
  }
  if (!text.includes("//go:embed tilecast.plugin.json")) {
    add(`${server.entrypoint} must embed tilecast.plugin.json`);
  }
  if (
    plugin.manifest.migrations &&
    !new RegExp(`//go:embed ${plugin.manifest.migrations.slice(2)}`).test(text)
  ) {
    add(`${server.entrypoint} must embed the declared migrations directory`);
  }
}

/**
 * The builds find entry points by convention (the manifest schema only
 * accepts the conventional paths). A conventional file that the manifest does
 * not declare would be discovered by Vite anyway, or silently ignored by the
 * host, so the manifest and the directory must agree both ways.
 */
function checkConventionalEntrypoints(plugin: DiscoveredPlugin, add: Add) {
  const { manifest } = plugin;
  const declared: [string, string | undefined][] = [
    [conventionalEntrypoints.studio, manifest.studio?.entrypoint],
    [conventionalEntrypoints.runtime, runtimeEntrypoint(manifest)],
  ];
  for (const [path, entrypoint] of declared) {
    if (entrypoint === undefined && existsSync(join(plugin.path, path))) {
      add(`${path.slice(2)} exists but the manifest does not declare it`);
    }
  }
}

/**
 * Implementation needs tests where it lives. The thin entry points
 * (plugin.go, studio/index.tsx, runtime/index.ts) are exercised by the shared
 * conformance suites; anything more needs its own test beside it.
 */
function checkTests(plugin: DiscoveredPlugin, add: Add) {
  const files = walk(plugin.path);
  const areas: {
    name: string;
    implementation: RegExp;
    test: RegExp;
    entry: string[];
  }[] = [
    {
      name: "Go",
      implementation: /\.go$/,
      test: /_test\.go$/,
      entry: ["plugin.go"],
    },
    {
      name: "Studio",
      implementation: /^studio\/.*\.tsx?$/,
      test: /^studio\/.*\.test\.tsx?$/,
      entry: ["studio/index.tsx"],
    },
    {
      name: "runtime",
      implementation: /^runtime\/.*\.ts$/,
      test: /^runtime\/.*\.test\.ts$/,
      entry: ["runtime/index.ts"],
    },
  ];
  for (const area of areas) {
    const implementation = files.filter(
      (file) =>
        area.implementation.test(file) &&
        !area.test.test(file) &&
        !area.entry.includes(file),
    );
    const tests = files.filter((file) => area.test.test(file));
    if (implementation.length > 0 && tests.length === 0) {
      add(`${area.name} implementation has no tests`);
    }
  }
}
