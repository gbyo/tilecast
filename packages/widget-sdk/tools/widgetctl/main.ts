#!/usr/bin/env node
/**
 * widgetctl — Tilecast's Widgets V2 tool (docs/widgets-v2.md).
 *
 *   npm run widgets:check            validate every Widget module and generated file
 *   npm run widgets:generate         rewrite the generated files
 *   npm run widgets:new -- <name>    scaffold widgets/<name>/
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
import { parseArgs } from "node:util";
import {
  compileComponentConfig,
  configLimitProblem,
  widgetDirPattern,
} from "../../src/manifest.ts";
import { generate, stale } from "./generate.ts";
import { discover, repoRoot, type Problem, type Repo } from "./repo.ts";

const CATALOG_DEFINITIONS = "apps/server/internal/contentdefs/definitions";

function report(problems: Problem[]): number {
  for (const problem of problems) {
    const where = [problem.widget && `widgets/${problem.widget}`, problem.file]
      .filter(Boolean)
      .join(" ");
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
      [manifest.id, ids, "id"],
      [component.type, types, "component type"],
      [component.tagName, tags, "tag"],
    ] as const) {
      const owner = owners.get(value);
      if (owner) add(`${label} ${value} is also declared by widgets/${owner}`);
      owners.set(value, dir);
    }
    if (catalog.has(manifest.id)) {
      add(
        `id ${manifest.id} is also defined in ${CATALOG_DEFINITIONS}/${catalog.get(manifest.id)}; a Widget module replaces its catalog entry`,
      );
    }
    if (
      component.type.startsWith("tilecast.") &&
      component.type !== `tilecast.${dir}`
    ) {
      add(`a tilecast Widget in widgets/${dir} must have type tilecast.${dir}`);
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

function scaffold(root: string, name: string, displayName: string): string[] {
  if (!widgetDirPattern.test(name))
    throw new Error("name must match [a-z][a-z0-9-]*");
  const dir = join(root, "widgets", name);
  if (existsSync(dir)) throw new Error(`widgets/${name} already exists`);
  const className = `Tilecast${name
    .split("-")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("")}Widget`;
  const files: Record<string, string> = {
    "tilecast.widget.json": `${JSON.stringify(
      {
        $schema: "../../packages/widget-sdk/schema/tilecast-widget.schema.json",
        id: name,
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
          type: `tilecast.${name}`,
          version: 1,
          tagName: `tc-widget-${name}`,
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
  type: "tilecast.${name}",
  version: 1,
  tagName: "tc-widget-${name}",
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

const meta: Meta = { title: "Widgets/${displayName}" };
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
    created.push(`widgets/${name}/${path}`);
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
        options: { name: { type: "string" } },
      });
      const name = positionals[0];
      if (!name) {
        console.error(
          "usage: npm run widgets:new -- <name> [--name 'Display Name']",
        );
        return 2;
      }
      for (const path of scaffold(root, name, values.name ?? name)) {
        console.log(`created ${path}`);
      }
      return main(["generate"]);
    }
    default:
      console.error("usage: widgetctl check | generate | new <name>");
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
