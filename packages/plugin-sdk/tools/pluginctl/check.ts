/**
 * `plugins:check`: everything that can be known about a plugin without
 * compiling it. The Go and Vitest conformance suites cover what needs the
 * code itself (implemented contributions against declared capabilities,
 * status, removal, rendering).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { conventionalEntrypoints } from "../../src/manifest.ts";
import { checkBoundaries } from "./boundaries.ts";
import { generate, stale } from "./generate.ts";
import {
  dirForId,
  walk,
  type DiscoveredPlugin,
  type Problem,
  type Repo,
} from "./repo.ts";

const DOCS_CONTENT = "apps/docs/src/content/docs";

export async function check(repo: Repo): Promise<Problem[]> {
  const problems: Problem[] = [...repo.problems];
  const ids = new Map<string, string>();
  const manifestTypes = new Map<string, string>();
  const slugs = new Map<string, string>();
  const bases: { base: string; id: string }[] = [];

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
    }

    if (manifest.runtime) {
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
      for (const type of manifest.runtime.manifestTypes) {
        if (manifestTypes.has(type))
          add(
            `manifest type ${type} is also rendered by ${manifestTypes.get(type)}`,
          );
        manifestTypes.set(type, id);
      }
    }

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

    checkTests(plugin, add);
  }

  problems.push(...checkBoundaries(repo));

  const generated = await generate(repo);
  problems.push(...generated.problems);
  for (const path of stale(repo, generated.files)) {
    problems.push({
      file: path,
      message: "generated file is stale; run npm run plugins:generate",
    });
  }
  return problems;
}

type Add = (message: string, file?: string) => void;

function requireFile(
  plugin: DiscoveredPlugin,
  path: string,
  field: string,
  add: Add,
) {
  if (!existsSync(join(plugin.path, path)))
    add(`${field} ${path} does not exist`);
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
    [conventionalEntrypoints.runtime, manifest.runtime?.entrypoint],
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
