#!/usr/bin/env node
/**
 * widgetctl — Tilecast's Widgets V2 tool (docs/widgets-v2.md).
 *
 *   npm run widgets:check            validate every Widget module and generated file
 *   npm run widgets:generate         rewrite the generated files
 *   npm run widgets:new -- <name>    scaffold widgets/<name>/
 *   npm run widgets:new -- <name> --plugin <plugin>
 *                                    scaffold plugins/<plugin>/widgets/<name>/
 *
 * `widgets:check` runs these static checks, then the Widget catalog suite
 * (packages/widget-sdk/test/widgets), which loads every module in jsdom to
 * prove its definition agrees with its manifest and its fixtures render.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  COMPONENT_TYPE_PATTERN,
  MAX_COMPONENT_TYPE_LENGTH,
  TAG_NAME_PATTERN,
} from "../../src/identity.ts";
import {
  catalogIdPattern,
  compileComponentConfig,
  configLimitProblem,
  widgetDirPattern,
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

const CATALOG_DEFINITIONS = "apps/server/internal/contentdefs/definitions";

function report(problems: Problem[]): number {
  for (const problem of problems) {
    const where = [problem.widget, problem.file].filter(Boolean).join(" ");
    console.error(`✗ ${where ? `${where}: ` : ""}${problem.message}`);
  }
  return problems.length === 0 ? 0 : 1;
}

/** Widget IDs the Server's own definition files declare. */
function catalogWidgetIds(root: string): Map<string, string> {
  const ids = new Map<string, string>();
  const dir = join(root, CATALOG_DEFINITIONS);
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
      widgets?: { id: string }[];
    };
    for (const widget of parsed.widgets ?? []) ids.set(widget.id, name);
  }
  return ids;
}

const AUTHORING_SECTIONS = ["data", "content", "appearance", "behavior"];

/** Why a configuration field's authoring `ui` metadata is invalid, or null. */
export function authoringUiProblem(
  key: string | undefined,
  control: string | undefined,
  ui: unknown,
  fieldKeys?: ReadonlySet<string | undefined>,
): string | null {
  if (ui === undefined) return null;
  const where = key ? `field ${key}` : "a configuration field";
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    return `${where} has invalid authoring metadata`;
  }
  const record = ui as Record<string, unknown>;
  if (
    record["section"] !== undefined &&
    !AUTHORING_SECTIONS.includes(record["section"] as string)
  ) {
    return `${where} names an unknown authoring section`;
  }
  if (
    record["order"] !== undefined &&
    (typeof record["order"] !== "number" || !Number.isFinite(record["order"]))
  ) {
    return `${where} has a non-numeric authoring order`;
  }
  const visibleWhen = record["visibleWhen"];
  if (visibleWhen !== undefined) {
    if (
      !visibleWhen ||
      typeof visibleWhen !== "object" ||
      Array.isArray(visibleWhen) ||
      typeof (visibleWhen as Record<string, unknown>)["key"] !== "string"
    ) {
      return `${where} has an invalid authoring visibility rule`;
    }
    const rule = visibleWhen as Record<string, unknown>;
    if (rule["equals"] === undefined && rule["notEquals"] === undefined) {
      return `${where} has a visibility rule with nothing to compare`;
    }
    if (fieldKeys && !fieldKeys.has(rule["key"] as string)) {
      return `${where} has a visibility rule on unknown field ${String(rule["key"])}`;
    }
  }
  if (record["styleCard"] !== undefined) {
    if (record["styleCard"] !== true && record["styleCard"] !== false) {
      return `${where} has a non-boolean style-card flag`;
    }
    if (record["styleCard"] === true && control !== "select") {
      return `${where} renders style cards for a non-select control`;
    }
  }
  if (
    record["semanticRole"] !== undefined &&
    (typeof record["semanticRole"] !== "string" || !record["semanticRole"])
  ) {
    return `${where} has an invalid semantic role`;
  }
  if (record["legacyKeys"] !== undefined) {
    const keys = record["legacyKeys"];
    if (
      !Array.isArray(keys) ||
      keys.length === 0 ||
      keys.some((key) => typeof key !== "string" || !key)
    ) {
      return `${where} has invalid legacy-key fallbacks`;
    }
  }
  return null;
}

export async function check(repo: Repo): Promise<Problem[]> {
  const problems: Problem[] = [...repo.problems];
  const catalog = catalogWidgetIds(repo.root);
  const ids = new Map<string, string>();
  const types = new Map<string, string>();
  const tags = new Map<string, string>();
  for (const widget of repo.widgets) {
    const { manifest, dir } = widget;
    const add = (message: string, file?: string) =>
      problems.push({ widget: dir, file, message });
    const { component } = manifest;

    for (const [value, owners, label] of [
      [manifest.id, ids, "provider identity"],
      [component.type, types, "component type"],
      [component.tagName, tags, "tag"],
    ] as const) {
      const owner = owners.get(value);
      if (owner) add(`${label} ${value} is also declared by ${owner}`);
      owners.set(value, dir);
    }
    if (
      widget.source.kind !== "core" &&
      component.type.startsWith("tilecast.")
    ) {
      add(
        `type ${component.type} uses the reserved tilecast namespace but comes from a non-core source`,
      );
    }
    if (widget.source.kind === "plugin") {
      // The manifest beside the Widget cannot declare its own source (the
      // schema rejects a source key), so re-resolve the parent plugin
      // manifest and confirm the discovered identity still matches. This
      // keeps a moved or renamed plugin directory from silently keeping
      // another plugin's identity.
      const segment = dir.split("/")[1] ?? "";
      const resolved = pluginIdForDir(repo.root, segment);
      if (resolved === null || "problem" in resolved) {
        add(
          `parent plugin manifest is missing or invalid below plugins/${segment}`,
        );
      } else if (resolved.id !== widget.source.pluginId) {
        add(
          `source plugin ${widget.source.pluginId} does not match parent plugin manifest ${resolved.id}`,
        );
      }
    }
    if (
      widget.source.kind === "core" &&
      component.type.startsWith("tilecast.") &&
      component.type !== `tilecast.${dir.split("/").pop()}`
    ) {
      add(
        `a tilecast Widget in ${dir} must have type tilecast.${dir.split("/").pop()}`,
      );
    }
    if (catalog.has(manifest.id)) {
      add(
        `id ${manifest.id} is also defined in ${CATALOG_DEFINITIONS}/${catalog.get(manifest.id)}; a Widget module replaces its catalog entry`,
      );
    }
    if (!existsSync(join(widget.path, component.entrypoint))) {
      add(`component.entrypoint ${component.entrypoint} does not exist`);
    }
    const runtimeDir = join(widget.path, "runtime");
    const runtimeFiles = existsSync(runtimeDir) ? readdirSync(runtimeDir) : [];
    if (!runtimeFiles.some((name) => name.endsWith(".stories.ts"))) {
      add("runtime/ has no *.stories.ts");
    }
    if (!runtimeFiles.some((name) => name.endsWith(".test.ts"))) {
      add("runtime/ has no *.test.ts");
    }
    if (!widget.fixtures.some(({ fixture }) => fixture.expect === "ready")) {
      add("fixtures/ has no fixture that expects ready");
    }
    const schemaKeys = new Map(
      (
        manifest.configurationSchema.fields as {
          key?: string;
          control?: string;
        }[]
      ).map((field) => [field.key, field.control]),
    );
    for (const key of component.dataSourceFields ?? []) {
      const control = schemaKeys.get(key);
      if (
        control !== undefined
          ? control !== "data_source"
          : !manifest.legacyEditor
      ) {
        add(
          `component.dataSourceFields names ${key}, which is not a data_source control`,
        );
      }
    }
    for (const field of manifest.configurationSchema.fields as {
      key?: string;
      control?: string;
      ui?: unknown;
    }[]) {
      const problem = authoringUiProblem(
        field.key,
        field.control,
        field.ui,
        new Set(schemaKeys.keys()),
      );
      if (problem) add(problem);
    }
    const compile = (configuration: Record<string, unknown>, file?: string) => {
      try {
        const problem = configLimitProblem(
          compileComponentConfig(component.configTemplate, configuration),
        );
        if (problem) add(problem, file);
      } catch (error) {
        add((error as Error).message, file);
      }
    };
    compile(manifest.defaultConfiguration);
    for (const { file, fixture } of widget.fixtures)
      compile(fixture.configuration, file);
  }
  const files = await generate(repo);
  for (const path of stale(repo, files)) {
    problems.push({
      file: path,
      message: "generated file is stale; run npm run widgets:generate",
    });
  }
  return problems;
}

export interface ScaffoldTarget {
  /** Widget directory name, for example "scoreboard". */
  name: string;
  displayName: string;
  /** When set, the Widget is owned by this plugin instead of the release. */
  plugin?: ResolvedPlugin;
}

/**
 * Derive a plugin-owned Widget's identities from its plugin and name. The
 * provider id stays in the plugin's own lane (`emergency_alerts_siren`),
 * and the component type uses the plugin id without separators
 * (`emergencyalerts.siren`), because qualified type segments allow neither
 * underscores nor leading hyphens. A plugin Widget is otherwise an
 * ordinary Widget: same manifest, same SDK, same WidgetMount.
 */
export function pluginWidgetIdentities(
  plugin: ResolvedPlugin,
  name: string,
): { id: string; type: string; tagName: string } {
  const namespace = plugin.id.replace(/[-_]/g, "");
  return {
    id: `${plugin.id}_${name}`,
    type: `${namespace}.${name}`,
    tagName: `tc-widget-${namespace}-${name}`,
  };
}

export function scaffold(root: string, target: ScaffoldTarget): string[] {
  const { name, displayName, plugin } = target;
  if (!widgetDirPattern.test(name))
    throw new Error("name must match [a-z][a-z0-9-]*");
  const location = plugin
    ? `plugins/${plugin.dir}/widgets/${name}`
    : `widgets/${name}`;
  const dir = join(root, location);
  if (existsSync(dir)) throw new Error(`${location} already exists`);
  const identities = plugin
    ? pluginWidgetIdentities(plugin, name)
    : {
        id: name,
        type: `tilecast.${name}`,
        tagName: `tc-widget-${name}`,
      };
  if (!catalogIdPattern.test(identities.id)) {
    throw new Error(
      `provider id ${identities.id} is too long or invalid; pick a shorter Widget name`,
    );
  }
  if (
    identities.type.length > MAX_COMPONENT_TYPE_LENGTH ||
    !COMPONENT_TYPE_PATTERN.test(identities.type)
  ) {
    throw new Error(
      `component type ${identities.type} is too long or invalid; pick a shorter Widget name`,
    );
  }
  if (!TAG_NAME_PATTERN.test(identities.tagName)) {
    throw new Error(
      `tag ${identities.tagName} is invalid; pick a shorter Widget name`,
    );
  }
  // Plugin namespaces drop separators, so distinct plugin ids such as
  // ab_c and a_bc derive the same component type and tag. widgets:check
  // reports that afterwards; refuse it here before any file is written.
  const clash = discover(root).widgets.find(
    (widget) =>
      widget.manifest.id === identities.id ||
      widget.manifest.component?.type === identities.type ||
      widget.manifest.component?.tagName === identities.tagName,
  );
  if (clash) {
    throw new Error(
      `${location} would reuse the provider id, component type, or tag of ${clash.dir} (${identities.type}); pick another Widget name`,
    );
  }
  const schemaPath = plugin
    ? "../../../../packages/widget-sdk/schema/tilecast-widget.schema.json"
    : "../../packages/widget-sdk/schema/tilecast-widget.schema.json";
  const className = `Tilecast${name
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("")}Widget`;
  const files: Record<string, string> = {
    "tilecast.widget.json": `${JSON.stringify(
      {
        $schema: schemaPath,
        apiVersion: 1,
        id: identities.id,
        version: 1,
        name: displayName,
        description: `${displayName}.`,
        category: "Essentials",
        icon: "layout",
        runtime: "native",
        configurationSchema: {
          fields: [
            {
              key: "title",
              label: "Title",
              control: "text",
              maxLength: 80,
              default: displayName,
            },
          ],
        },
        defaultConfiguration: { title: displayName },
        presentationSchemaVersion: 1,
        requiredCapabilities: { "content.text": 1 },
        emptyStateBehavior: "text",
        deprecation: {},
        component: {
          type: identities.type,
          version: 1,
          tagName: identities.tagName,
          entrypoint: "./runtime/index.ts",
          configTemplate: { title: { $config: "title", default: "" } },
          empty: "render",
        },
        compatibility: { fallback: "none" },
      },
      null,
      2,
    )}\n`,
    "runtime/index.ts": `import { defineWidget, ready } from "@tilecast/widget-sdk";
import { ${className}, type Config } from "./${name}.ts";

export default defineWidget<Config, null>({
  type: ${JSON.stringify(identities.type)},
  version: 1,
  tagName: ${JSON.stringify(identities.tagName)},
  parseConfig(value) {
    const title = (value as { title?: unknown } | null)?.title;
    return typeof title === "string" && title.length <= 80
      ? { ok: true, config: { title } }
      : { ok: false, problem: "title must be text" };
  },
  resolveData: () => ready(null),
  element: ${className},
});
`,
    [`runtime/${name}.ts`]: `import { css, html } from "lit";
import { TilecastWidgetElement } from "@tilecast/widget-kit";

export interface Config {
  readonly title: string;
}

export class ${className} extends TilecastWidgetElement<Config, null> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css\`
      .title {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: var(--tc-gutter);
      }
    \`,
  ];

  protected override renderContent() {
    return html\`<div class="title tc-headline">\${this.config.title}</div>\`;
  }
}
`,
    [`runtime/${name}.test.ts`]: `import { afterEach, expect, it } from "vitest";
import { mountForTest } from "@tilecast/widget-sdk/testing";
import widget from "./index.ts";

afterEach(() => document.body.replaceChildren());

it("renders its title and reports ready", async () => {
  const test = mountForTest(widget, { config: { title: "Hello" } });
  await (test.element as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  expect(test.states).toEqual([{ state: "ready" }]);
  test.dispose();
});
`,
    [`runtime/${name}.stories.ts`]: `import type { Meta, StoryObj } from "@storybook/web-components-vite";
import { widgetStory } from "@tilecast/widget-sdk/stories";
import manifest from "../tilecast.widget.json";
import fixture from "../fixtures/default.json";
import widget from "./index.ts";

const meta: Meta = { title: ${JSON.stringify(plugin ? `Plugins/${plugin.id}/${displayName}` : `Widgets/${displayName}`)} };
export default meta;

const story = (frame: Parameters<typeof widgetStory>[3]): StoryObj =>
  widgetStory(widget, manifest as never, fixture, frame);

export const Landscape = story("landscape");
export const Portrait = story("portrait");
export const Strip = story("strip");
export const Zone = story("zone");
`,
    "fixtures/default.json": `${JSON.stringify(
      {
        name: "Default",
        configuration: { title: displayName },
        expect: "ready",
      },
      null,
      2,
    )}\n`,
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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const root = repoRoot();
  switch (command) {
    case "check": {
      const repo = discover(root);
      const problems = await check(repo);
      if (problems.length === 0) {
        console.log(
          `✓ ${repo.widgets.length} Widget modules pass static checks`,
        );
      }
      return report(problems);
    }
    case "generate": {
      const repo = discover(root);
      if (repo.problems.length > 0) return report(repo.problems);
      for (const [path, content] of await generate(repo)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
        console.log(`wrote ${path}`);
      }
      return 0;
    }
    case "new": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { name: { type: "string" }, plugin: { type: "string" } },
      });
      const name = positionals[0];
      if (!name) {
        console.error(
          "usage: npm run widgets:new -- <name> [--name 'Display Name'] [--plugin <plugin>]",
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
          plugin,
        })) {
          console.log(`created ${path}`);
        }
      } catch (error) {
        console.error((error as Error).message);
        return 1;
      }
      return main(["generate"]);
    }
    default:
      console.error("usage: widgetctl check | generate | new <name>");
      return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
