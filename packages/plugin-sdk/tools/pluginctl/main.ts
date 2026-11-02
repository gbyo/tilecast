#!/usr/bin/env node
/**
 * pluginctl — Tilecast's first-party plugin tool.
 *
 *   npm run plugins:check                     validate every plugin and generated file
 *   npm run plugins:generate                  rewrite the generated files
 *   npm run plugins:new -- <id> [options]     scaffold plugins/<id>/ (Plugin API v2)
 *       --api                 dashboard API routes and an OpenAPI fragment
 *       --no-studio           no Studio pages (a Server-only plugin)
 *       --player              a Shared Runtime Player contribution
 *       --services a@1,b@1    its required services (default player.clock@1)
 *       --optional a@1        its optional services
 *       --surface id:slots:tier  a visual contribution (adds player.surface@1)
 *       --plugin-api 1        the frozen Plugin API v1 shape
 *   npm run plugins:migration -- <id|core> <name>
 *                                             reserve the next global migration version
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { check } from "./check.ts";
import { generate } from "./generate.ts";
import { createMigration } from "./scaffold-migration.ts";
import { parseSurface, scaffold } from "./scaffold.ts";
import { discover, repoRoot, type Problem } from "./repo.ts";

function report(problems: Problem[]): number {
  for (const problem of problems) {
    const where = [problem.plugin, problem.file].filter(Boolean).join(" ");
    console.error(`✗ ${where ? `${where}: ` : ""}${problem.message}`);
  }
  return problems.length === 0 ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const root = repoRoot();
  switch (command) {
    case "check": {
      const repo = discover(root);
      const problems = await check(repo);
      if (problems.length === 0) {
        const count = (version: number) =>
          repo.plugins.filter(
            (plugin) => plugin.manifest.apiVersion === version,
          ).length;
        console.log(
          `✓ ${repo.plugins.length} plugins conform (Plugin API v1: ${count(1)}, v2: ${count(2)})`,
        );
      }
      return report(problems);
    }
    case "generate": {
      const repo = discover(root);
      if (repo.problems.length > 0) return report(repo.problems);
      const { files, problems } = await generate(repo);
      if (problems.length > 0) return report(problems);
      for (const [path, content] of files) {
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
        options: {
          name: { type: "string" },
          category: { type: "string", default: "Display" },
          maintainer: { type: "string", default: "@gbyo" },
          api: { type: "boolean", default: false },
          "plugin-api": { type: "string", default: "2" },
          "no-studio": { type: "boolean", default: false },
          player: { type: "boolean", default: false },
          services: { type: "string", default: "player.clock@1" },
          optional: { type: "string", default: "" },
          surface: { type: "string", multiple: true, default: [] },
        },
      });
      const id = positionals[0];
      if (!id) {
        console.error(
          "usage: npm run plugins:new -- <plugin_id> [--name Name] [--category Display] [--api] [--no-studio] [--player [--services a@1,...] [--optional a@1,...] [--surface id:slot,slot:tier]] [--plugin-api 1]",
        );
        return 2;
      }
      const csv = (value: string | undefined) =>
        (value ?? "").split(",").filter(Boolean);
      const surfaces = (values.surface ?? []).map(parseSurface);
      const required = csv(values.services);
      if (surfaces.length > 0 && !required.includes("player.surface@1"))
        required.push("player.surface@1");
      const created = scaffold(root, {
        id,
        name: values.name,
        category: values.category!,
        maintainer: values.maintainer!,
        api: values.api!,
        pluginApi: values["plugin-api"] === "1" ? 1 : 2,
        studio: !values["no-studio"],
        ...(values.player || surfaces.length > 0
          ? { player: { required, optional: csv(values.optional), surfaces } }
          : {}),
      });
      for (const path of created) console.log(`created ${path}`);
      return main(["generate"]);
    }
    case "migration": {
      const [owner, name] = rest;
      if (!owner || !name) {
        console.error(
          "usage: npm run plugins:migration -- <plugin_id|core> <snake_case_name>",
        );
        return 2;
      }
      const path = createMigration(discover(root), owner, name);
      console.log(`created ${path}`);
      return main(["generate"]);
    }
    default:
      console.error(
        "usage: pluginctl check | generate | new <id> | migration <id|core> <name>",
      );
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
