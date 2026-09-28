/**
 * `data-sources:*`: everything that can be known about a declarative Data
 * Source module without compiling the Server.
 *
 *   npm run data-sources:check            validate every module and generated file
 *   npm run data-sources:generate         rewrite the generated files
 *   npm run data-sources:new -- <name> --adapter <adapter>
 *                                     scaffold data-sources/<name>/
 *   npm run data-sources:new -- <name> --adapter <adapter> --plugin <plugin>
 *                                     scaffold plugins/<plugin>/data-sources/<name>/
 *
 * Adapters are the exact Server registry ids; only manual_object,
 * manual_records, and http_records have a declarative binding. A module
 * is declarative JSON plus fixtures: the manifest names a generic
 * adapter id, never declares its own source, and never carries
 * credentials. Executable refresh stays behind the Server's adapters.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { setupGuideProblems } from "../../src/setup.ts";
import {
  adapterDeclarativeProblem,
  adapterProblem,
  adapterTakesFetch,
  fetchSpecProblems,
} from "../../src/fetch.ts";
import {
  dataSourceDirPattern,
  dataSourceIdPattern,
  dataSourceManifestSchema,
  type DataSourceManifest,
} from "../../src/manifest.ts";
import { generate, stale } from "./generate.ts";
import {
  discover,
  pluginIdForDir,
  repoRoot,
  resolvePlugin,
  type Problem,
  type Repo,
  type ResolvedPlugin,
} from "./repo.ts";

export function check(repo: Repo): Problem[] {
  const problems: Problem[] = [...repo.problems];
  const ids = new Map<string, string>();
  for (const source of repo.sources) {
    const dir = source.dir;
    const add = (message: string) => problems.push({ source: dir, message });
    const parsed = dataSourceManifestSchema.safeParse(source.manifest);
    if (!parsed.success) {
      for (const issue of parsed.error.issues.slice(0, 5)) {
        add(`manifest ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      continue;
    }
    const manifest = parsed.data;
    if (ids.has(manifest.id)) {
      add(`id ${manifest.id} is also used by ${ids.get(manifest.id)}`);
    } else {
      ids.set(manifest.id, dir);
    }
    if (source.source.kind === "plugin") {
      const segment = dir.split("/")[1] ?? "";
      const resolved = pluginIdForDir(repo.root, segment);
      if (resolved === null || "problem" in resolved) {
        add(
          `parent plugin manifest is missing or invalid below plugins/${segment}`,
        );
      } else if (resolved.id !== source.source.pluginId) {
        add(
          `source plugin ${source.source.pluginId} does not match parent plugin manifest ${resolved.id}`,
        );
      }
    }
    checkAdapter(manifest, add);
    checkModuleFiles(repo.root, source.path, manifest, add);
    for (const problem of setupGuideProblems(manifest.setup)) {
      add(problem);
    }
  }
  return problems;
}

function checkAdapter(
  manifest: DataSourceManifest,
  add: (message: string) => void,
): void {
  const unknown = adapterProblem(manifest.adapterId);
  if (unknown) {
    add(unknown);
    return;
  }
  const declarative = adapterDeclarativeProblem(manifest.adapterId);
  if (declarative) {
    add(declarative);
    return;
  }
  const takesFetch = adapterTakesFetch(manifest.adapterId);
  if (takesFetch && !manifest.fetch) {
    add(`adapter ${manifest.adapterId} needs a bounded fetch specification`);
    return;
  }
  if (!takesFetch && manifest.fetch) {
    add(
      `adapter ${manifest.adapterId} projects authored values and must not carry a fetch specification`,
    );
    return;
  }
  if (
    manifest.adapterId === "http_records" &&
    manifest.outputSchema.kind !== "records"
  ) {
    add(`adapter http_records needs a records output schema`);
  }
  if (manifest.fetch) {
    const outputKeys = new Set(
      manifest.outputSchema.fields.map((field) => field.key),
    );
    for (const problem of fetchSpecProblems(
      manifest.fetch,
      manifest.configurationSchema.fields,
      outputKeys,
    )) {
      add(problem);
    }
  }
}

function checkModuleFiles(
  root: string,
  path: string,
  manifest: DataSourceManifest,
  add: (message: string) => void,
): void {
  void root;
  const fixture = join(path, "fixtures/default.json");
  if (!existsSync(fixture)) {
    add(
      "fixtures/default.json is missing: every module ships a sample configuration",
    );
    return;
  }
  try {
    const sample: unknown = JSON.parse(readFileSync(fixture, "utf8"));
    if (
      typeof sample !== "object" ||
      sample === null ||
      Array.isArray(sample)
    ) {
      add("fixtures/default.json must hold a sample configuration object");
      return;
    }
    const declared = new Set(
      manifest.configurationSchema.fields.map((field) => field.key),
    );
    for (const key of Object.keys(sample)) {
      if (!declared.has(key)) {
        add(
          `fixtures/default.json sets undeclared configuration ${JSON.stringify(key)}`,
        );
      }
    }
  } catch {
    add("fixtures/default.json is not valid JSON");
  }
}

export interface ScaffoldTarget {
  name: string;
  displayName: string;
  adapter: "manual_object" | "manual_records" | "http_records";
  plugin?: ResolvedPlugin;
}

export function scaffold(root: string, target: ScaffoldTarget): string[] {
  const { name, displayName, adapter, plugin } = target;
  if (!dataSourceDirPattern.test(name)) {
    throw new Error("name must match [a-z][a-z0-9-]*");
  }
  const id = plugin ? `${plugin.id}_${name}` : name.replace(/-/g, "_");
  if (!dataSourceIdPattern.test(id)) {
    throw new Error(
      `provider id ${id} is too long or invalid; pick a shorter source name`,
    );
  }
  const location = plugin
    ? `plugins/${plugin.dir}/data-sources/${name}`
    : `data-sources/${name}`;
  const dir = join(root, location);
  if (existsSync(dir)) throw new Error(`${location} already exists`);
  const schemaPath = plugin
    ? "../../../../packages/data-source-sdk/schema/tilecast-datasource.schema.json"
    : "../../packages/data-source-sdk/schema/tilecast-datasource.schema.json";
  const outputSchema =
    adapter === "manual_object"
      ? {
          kind: "object",
          fields: [{ key: "headline", label: "Headline", type: "text" }],
        }
      : {
          kind: "records",
          fields: [{ key: "title", label: "Title", type: "text" }],
        };
  const manifest: Record<string, unknown> = {
    $schema: schemaPath,
    apiVersion: 1,
    id,
    version: 1,
    name: displayName,
    description: `${displayName}.`,
    category: "Essentials",
    icon: "layout",
    configurationSchema: { fields: [] },
    defaultConfiguration: {},
    outputSchema,
    adapterId: adapter,
    refreshBehavior: "manual",
  };
  if (adapter === "http_records") {
    manifest.fetch = {
      urlTemplate: "https://example.org/api/items",
      format: "json",
      mapping: { title: "title" },
      maximumRecords: 100,
      refreshSeconds: 3600,
    };
  }
  const files: Record<string, string> = {
    "tilecast.datasource.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "fixtures/default.json": `${JSON.stringify({}, null, 2)}\n`,
  };
  const created: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    created.push(`${location}/${path}`);
  }
  return created;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const root = repoRoot();
  switch (command) {
    case "check": {
      const problems = check(discover(root));
      for (const problem of problems) {
        console.error(`${problem.source}: ${problem.message}`);
      }
      if (problems.length > 0) return 1;
      const generated = await generate(discover(root));
      for (const path of stale(discover(root), generated)) {
        console.error(
          `${path}: generated file is stale; run npm run data-sources:generate`,
        );
        return 1;
      }
      console.error(
        `✓ ${discover(root).sources.length} Data Source modules pass static checks`,
      );
      return 0;
    }
    case "generate": {
      const files = await generate(discover(root));
      for (const [path, content] of files) {
        mkdirSync(join(root, dirname(path)), { recursive: true });
        writeFileSync(join(root, path), content);
        console.error(`wrote ${path}`);
      }
      return 0;
    }
    case "new": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          name: { type: "string" },
          plugin: { type: "string" },
          adapter: { type: "string" },
        },
      });
      const name = positionals[0];
      const adapter = values.adapter;
      if (!name || !adapter) {
        console.error(
          "usage: npm run data-sources:new -- <name> --adapter manual_object|manual_records|http_records [--name 'Display Name'] [--plugin <plugin>]",
        );
        return 2;
      }
      if (
        !["manual_object", "manual_records", "http_records"].includes(adapter)
      ) {
        console.error(
          `unknown adapter ${JSON.stringify(adapter)}: declarative modules may use manual_object, manual_records, http_records`,
        );
        return 2;
      }
      let plugin: ResolvedPlugin | undefined;
      if (values.plugin) {
        const resolved = resolvePlugin(root, values.plugin);
        if (!resolved) {
          console.error(
            `unknown plugin ${JSON.stringify(values.plugin)}: expected a plugin id or directory with a tilecast.plugin.json`,
          );
          return 2;
        }
        plugin = resolved;
      }
      try {
        for (const path of scaffold(root, {
          name,
          displayName: values.name ?? name,
          adapter: adapter as ScaffoldTarget["adapter"],
          plugin,
        })) {
          console.log(`created ${path}`);
        }
        if (adapter === "http_records") {
          console.log(
            "replace the example.org urlTemplate with the release-pinned endpoint before shipping",
          );
        }
      } catch (error) {
        console.error((error as Error).message);
        return 1;
      }
      return main(["generate"]);
    }
    default:
      console.error("usage: datactl <check|generate|new>");
      return 2;
  }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
