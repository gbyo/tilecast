import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check } from "../tools/pluginctl/check.ts";
import { generate } from "../tools/pluginctl/generate.ts";
import { collectMigrations } from "../tools/pluginctl/migrations.ts";
import { discover, repoRoot } from "../tools/pluginctl/repo.ts";
import { createMigration } from "../tools/pluginctl/scaffold-migration.ts";
import { scaffold } from "../tools/pluginctl/scaffold.ts";
import {
  checkFragmentOperationIds,
  checkSupportedOperations,
} from "../tools/pluginctl/supported.ts";
import YAML from "yaml";

let root: string;

/** A throwaway repository with the pieces pluginctl reads. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pluginctl-"));
  mkdirSync(join(dir, "plugins"));
  mkdirSync(join(dir, "apps/server/internal/database/migrations"), {
    recursive: true,
  });
  writeFileSync(
    join(dir, "apps/server/internal/database/migrations/00001_foundation.sql"),
    "-- +goose Up\nSELECT 1;\n-- +goose Down\nSELECT 1;\n",
  );
  mkdirSync(join(dir, "docs/openapi"), { recursive: true });
  writeFileSync(join(dir, "docs/openapi/core.yaml"), fixtureCore());
  writeFileSync(
    join(dir, "plugins/review-eligibility.json"),
    JSON.stringify({ eligible: ["@gbyo"] }),
  );
  mkdirSync(join(dir, "packages/plugin-sdk/schema"), { recursive: true });
  cpSync(
    join(repoRoot(), "packages/plugin-sdk/schema"),
    join(dir, "packages/plugin-sdk/schema"),
    { recursive: true },
  );
  return dir;
}

async function generateInto(dir: string) {
  const repo = discover(dir);
  const { files, problems } = await generate(repo);
  expect(problems).toEqual([]);
  for (const [path, content] of files) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

async function problems(dir: string) {
  return (await check(discover(dir))).map((problem) => problem.message);
}

function editManifest(
  dir: string,
  name: string,
  edit: (manifest: Record<string, unknown>) => void,
) {
  const path = join(dir, "plugins", name, "tilecast.plugin.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  edit(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

beforeEach(() => {
  root = makeRepo();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Minimal core contract carrying the supported slice under test. */
function fixtureCore(): string {
  const unauthorized =
    "        '401': { description: Authentication required }";
  const ok = (description: string, extra = "") =>
    `        '200':\n          description: ${description}\n${extra}`;
  const schemaRef = (ref: string) =>
    `          content:\n            application/json:\n              schema: { $ref: "#/components/schemas/${ref}" }`;
  const csrf =
    '      parameters:\n        - { $ref: "#/components/parameters/CSRFToken" }';
  const op = (id: string, description: string, body: string) =>
    `      operationId: ${id}\n      description: ${description}\n${body}`;
  // [path, method, operationId, description, body]
  const entries: [string, string, string, string, string][] = [
    [
      "/api/v1/system/identity",
      "get",
      "installationIdentity",
      "Public installation identity.",
      `      responses:\n${ok("Identity", `${schemaRef("InstallationIdentity")}\n`)}`,
    ],
    [
      "/api/v1/system/status",
      "get",
      "systemStatus",
      "Requires the Owner or Administrator role and an enrolled dashboard session.",
      `      responses:\n${ok("Status")}\n${unauthorized}\n        '403': { description: Owner or Administrator required }`,
    ],
    [
      "/api/v1/auth/status",
      "get",
      "authStatus",
      "Public installation state and current user.",
      `      responses:\n${ok("Status", `${schemaRef("AuthStatus")}\n`)}`,
    ],
    [
      "/api/v1/screens",
      "get",
      "listScreens",
      "Requires an enrolled dashboard session.",
      `      responses:\n${ok("Screens")}\n${unauthorized}`,
    ],
    [
      "/api/v1/screens/{id}",
      "get",
      "getScreen",
      "Requires an enrolled dashboard session.",
      `      parameters:\n        - { in: path, name: id, required: true, schema: { type: string, format: uuid } }\n      responses:\n${ok("Screen")}\n${unauthorized}\n        '404': { description: Unknown }`,
    ],
    [
      "/api/v1/settings",
      "get",
      "getSettings",
      "Requires an enrolled dashboard session.",
      `      responses:\n${ok("Settings")}\n${unauthorized}`,
    ],
    [
      "/api/v1/settings",
      "patch",
      "updateSettings",
      "Requires the Owner or Administrator role and the X-CSRF-Token header.",
      `${csrf}\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: "#/components/schemas/SettingsUpdate" }\n      responses:\n${ok("Updated")}\n${unauthorized}\n        '403': { description: Forbidden }\n        '409': { description: Conflict }\n        '422': { description: Invalid }`,
    ],
    [
      "/api/v1/screens/{id}/effective-policy",
      "get",
      "getEffectivePolicy",
      "Requires an enrolled dashboard session.",
      `      parameters:\n        - { $ref: "#/components/parameters/ResourceID" }\n      responses:\n${ok("Policy")}\n${unauthorized}\n        '404': { description: Unknown }`,
    ],
    [
      "/api/v1/plugins",
      "get",
      "listPlugins",
      "Readable by any signed-in account with a dashboard session.",
      `      responses:\n${ok("Catalog", `${schemaRef("PluginCatalog")}\n`)}\n${unauthorized}`,
    ],
    [
      "/api/v1/plugins/{pluginId}/install",
      "post",
      "installPlugin",
      "Requires the Owner or Administrator role and an enrolled dashboard session.",
      `      parameters:\n        - { in: path, name: pluginId, required: true, schema: { type: string } }\n        - { $ref: "#/components/parameters/CSRFToken" }\n      responses:\n        '201':\n          description: Installed\n${schemaRef("CatalogPlugin")}\n        '403': { description: Forbidden }\n        '404': { description: Unknown }\n        '409': { description: Conflict }`,
    ],
    [
      "/api/v1/plugins/{pluginId}/installation",
      "delete",
      "removePlugin",
      "Requires the Owner or Administrator role and an enrolled dashboard session.",
      `      parameters:\n        - { in: path, name: pluginId, required: true, schema: { type: string } }\n        - { $ref: "#/components/parameters/CSRFToken" }\n      responses:\n        '204': { description: Removed }\n        '403': { description: Forbidden }\n        '404': { description: Unknown }\n        '409': { description: Conflict }`,
    ],
    [
      "/api/v1/me/preferences",
      "get",
      "getPreferences",
      "Requires an enrolled dashboard session.",
      `      responses:\n${ok("Preferences")}\n${unauthorized}`,
    ],
    [
      "/api/v1/me/preferences",
      "patch",
      "updatePreferences",
      "Requires an enrolled dashboard session and the X-CSRF-Token header.",
      `${csrf}\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: "#/components/schemas/SettingsUpdate" }\n      responses:\n${ok("Updated")}\n${unauthorized}\n        '403': { description: Forbidden }\n        '409': { description: Conflict }`,
    ],
  ];
  const byPath = new Map<string, string[]>();
  for (const [path, method, id, description, body] of entries) {
    const block = `    ${method}:\n${op(id, description, body)}`;
    byPath.set(path, [...(byPath.get(path) ?? []), block]);
  }
  const paths = [...byPath]
    .map(([path, blocks]) => `  ${path}:\n${blocks.join("\n")}`)
    .join("\n");
  return [
    "openapi: 3.1.0",
    "info:",
    "  title: Core",
    "  version: 1.0.0",
    "paths:",
    "  /healthz:",
    "    get:",
    "      responses:",
    "        '200':",
    "          description: ok",
    paths,
    "components:",
    "  parameters:",
    "    ResourceID:",
    "      in: path",
    "      name: id",
    "      required: true",
    "      schema: { type: string, format: uuid }",
    "    CSRFToken:",
    "      in: header",
    "      name: X-CSRF-Token",
    "      required: true",
    "      schema: { type: string }",
    "  schemas:",
    "    Error:",
    "      type: object",
    "    InstallationIdentity:",
    "      type: object",
    "    AuthStatus:",
    "      type: object",
    "    SettingsUpdate:",
    "      type: object",
    "    PluginCatalog:",
    "      type: object",
    "    CatalogPlugin:",
    "      type: object",
    "",
  ].join("\n");
}

describe("pluginctl", () => {
  it("scaffolds a sixth plugin that passes every check without touching core files", async () => {
    const created = scaffold(root, {
      id: "transit_alerts",
      category: "Automation",
      maintainer: "@someone-new",
      api: true,
    });
    expect(
      created.every((path) => path.startsWith("plugins/transit-alerts/")),
    ).toBe(true);
    await generateInto(root);
    expect(await problems(root)).toEqual([]);

    const registry = readFileSync(
      join(root, "plugins/registry_gen.go"),
      "utf8",
    );
    expect(registry).toContain(
      'transitalerts "github.com/tilecast/tilecast/plugins/transit-alerts"',
    );
    expect(registry).toContain("transitalerts.New(),");
    const codeowners = readFileSync(join(root, ".github/CODEOWNERS"), "utf8");
    expect(codeowners).toContain("# Do not edit");
    expect(codeowners).toContain(
      "# transit_alerts: also maintained by @someone-new",
    );
    expect(codeowners).toContain(
      "# /plugins/transit-alerts/ has no maintainer eligible",
    );
  });

  it("detects generated files that are stale", async () => {
    scaffold(root, {
      id: "transit_alerts",
      category: "Display",
      maintainer: "@gbyo",
      api: false,
    });
    await generateInto(root);
    editManifest(root, "transit-alerts", (manifest) => {
      manifest.maintainers = ["@gbyo", "@another"];
    });
    expect(await problems(root)).toContain(
      "generated file is stale; run npm run plugins:generate",
    );
  });

  it("requires the directory to match the id and entry points to exist", async () => {
    scaffold(root, {
      id: "transit_alerts",
      category: "Display",
      maintainer: "@gbyo",
      api: false,
    });
    editManifest(root, "transit-alerts", (manifest) => {
      manifest.id = "transit_feeds";
      manifest.studio = {
        route: "/plugins/elsewhere",
        entrypoint: "./studio/index.tsx",
      };
    });
    rmSync(join(root, "plugins/transit-alerts/studio/index.tsx"));
    await generateInto(root);
    const found = await problems(root);
    expect(found).toContain("directory must be named plugins/transit-feeds");
    expect(found).toContain("studio.route must be /plugins/transit-alerts");
    expect(found).toContain(
      "studio.entrypoint ./studio/index.tsx does not exist",
    );
  });

  it("accepts only the conventional entry points, in both directions", async () => {
    scaffold(root, {
      id: "transit_alerts",
      category: "Display",
      maintainer: "@gbyo",
      api: false,
    });
    await generateInto(root);
    editManifest(root, "transit-alerts", (manifest) => {
      manifest.studio = {
        route: "/plugins/transit-alerts",
        entrypoint: "./studio/editor.tsx",
      };
    });
    const renamed = (await check(discover(root))).map(
      (problem) => `${problem.file ?? ""} ${problem.message}`,
    );
    expect(renamed.join("\n")).toMatch(/studio\.entrypoint/);

    editManifest(root, "transit-alerts", (manifest) => {
      delete manifest.studio;
    });
    await generateInto(root);
    expect(await problems(root)).toContain(
      "studio/index.tsx exists but the manifest does not declare it",
    );
  });

  it("requires runtime/index.ts for declared surfaces and scoped runtime CSS", async () => {
    scaffold(root, {
      id: "transit_alerts",
      category: "Display",
      maintainer: "@gbyo",
      api: false,
    });
    editManifest(root, "transit-alerts", (manifest) => {
      manifest.capabilities = { playerManifest: true };
      manifest.runtime = {
        manifestTypes: ["transit_alert"],
        surfaces: ["strip.bottom"],
        tier: "live",
      };
    });
    await generateInto(root);
    expect(await problems(root)).toContain(
      "a plugin that declares runtime.surfaces must render them in ./runtime/index.ts",
    );

    mkdirSync(join(root, "plugins/transit-alerts/runtime"));
    writeFileSync(join(root, "plugins/transit-alerts/runtime/index.ts"), "");
    writeFileSync(
      join(root, "plugins/transit-alerts/runtime/transit.css"),
      ".tc-transit-alerts { color: red; }\n#content-stage { bottom: 0; }\n",
    );
    editManifest(root, "transit-alerts", (manifest) => {
      (manifest.runtime as Record<string, unknown>).entrypoint =
        "./runtime/index.ts";
    });
    await generateInto(root);
    const found = await problems(root);
    expect(found).not.toContain(
      "a plugin that declares runtime.surfaces must render them in ./runtime/index.ts",
    );
    expect(found).toContain(
      'runtime/transit.css: selector "#content-stage" must start with .tc-transit-alerts',
    );
  });

  it("keeps plugins to the SDK and their own directory", async () => {
    scaffold(root, {
      id: "transit_alerts",
      category: "Display",
      maintainer: "@gbyo",
      api: false,
    });
    const studio = join(root, "plugins/transit-alerts/studio/index.tsx");
    writeFileSync(
      studio,
      `import { api } from "../../../apps/dashboard/src/api/client";\n${readFileSync(studio, "utf8")}`,
    );
    const go = join(root, "plugins/transit-alerts/plugin.go");
    writeFileSync(
      go,
      readFileSync(go, "utf8").replace(
        "import (\n",
        'import (\n\t"github.com/tilecast/tilecast/apps/server/internal/auth"\n',
      ),
    );
    mkdirSync(join(root, "plugins/transit-alerts/runtime"));
    writeFileSync(
      join(root, "plugins/transit-alerts/runtime/index.ts"),
      `import React from "react";\nexport default React;\n`,
    );
    await generateInto(root);
    const found = await problems(root);
    expect(
      found.some((message) => message.includes("outside the plugin directory")),
    ).toBe(true);
    expect(
      found.some((message) =>
        message.includes(
          "imports github.com/tilecast/tilecast/apps/server/internal/auth",
        ),
      ),
    ).toBe(true);
    expect(found.some((message) => message.startsWith("imports react;"))).toBe(
      true,
    );
  });

  it("refuses overlapping API base paths and undescribed routes", async () => {
    scaffold(root, {
      id: "transit_alerts",
      category: "Display",
      maintainer: "@gbyo",
      api: true,
    });
    scaffold(root, {
      id: "transit_boards",
      category: "Display",
      maintainer: "@gbyo",
      api: true,
    });
    editManifest(root, "transit-boards", (manifest) => {
      manifest.api = { basePaths: ["/plugins/transit-alerts/boards"] };
    });
    await generateInto(root).catch(() => undefined);
    const found = await problems(root);
    expect(found).toContain(
      "api base path /plugins/transit-alerts/boards overlaps /plugins/transit-alerts of transit_alerts",
    );
    expect(found).toContain(
      "a plugin with api.basePaths must describe them in api.openapi",
    );
  });

  it("composes plugin OpenAPI fragments into the canonical document", async () => {
    scaffold(root, {
      id: "transit_alerts",
      category: "Display",
      maintainer: "@gbyo",
      api: true,
    });
    writeFileSync(
      join(root, "plugins/transit-alerts/api/openapi.yaml"),
      [
        "openapi: 3.1.0",
        "info: { title: Transit Alerts, version: '1' }",
        "paths:",
        "  /api/v1/plugins/transit-alerts/feeds:",
        "    get:",
        "      operationId: listTransitFeeds",
        "      responses:",
        "        '200': { description: Feeds }",
        "        '404': { $ref: '../../../docs/openapi/core.yaml#/components/responses/NotFound' }",
        "components:",
        "  schemas:",
        "    TransitFeed: { type: object }",
        "",
      ].join("\n"),
    );
    await generateInto(root);
    const composed = readFileSync(join(root, "docs/openapi.yaml"), "utf8");
    expect(composed.startsWith("# Generated by pluginctl")).toBe(true);
    expect(composed).toContain("/api/v1/plugins/transit-alerts/feeds:");
    expect(composed).toContain('$ref: "#/components/responses/NotFound"');
    expect(composed).toContain("TransitFeed:");
    expect(await problems(root)).toEqual([]);

    writeFileSync(
      join(root, "plugins/transit-alerts/api/openapi.yaml"),
      "openapi: 3.1.0\ninfo: { title: x, version: '1' }\npaths:\n  /api/v1/screens:\n    get: { responses: { '200': { description: x } } }\n",
    );
    expect(await problems(root)).toContain(
      "path /api/v1/screens is outside the manifest's api.basePaths",
    );
  });

  it("reserves migrations from the one global sequence", async () => {
    scaffold(root, {
      id: "transit_alerts",
      category: "Display",
      maintainer: "@gbyo",
      api: false,
    });
    expect(() =>
      createMigration(discover(root), "transit_alerts", "feeds"),
    ).toThrow(/does not declare "migrations"/);
    editManifest(root, "transit-alerts", (manifest) => {
      manifest.migrations = "./migrations";
    });
    const go = join(root, "plugins/transit-alerts/plugin.go");
    writeFileSync(
      go,
      readFileSync(go, "utf8").replace(
        "//go:embed tilecast.plugin.json",
        "//go:embed tilecast.plugin.json\n//go:embed migrations/*.sql",
      ),
    );
    const plugin = createMigration(discover(root), "transit_alerts", "feeds");
    const core = createMigration(discover(root), "core", "screens_index");
    expect(plugin).toBe("plugins/transit-alerts/migrations/00002_feeds.sql");
    expect(core).toBe(
      "apps/server/internal/database/migrations/00003_screens_index.sql",
    );

    writeFileSync(
      join(root, "plugins/transit-alerts/migrations/00003_clash.sql"),
      "-- +goose Up\n-- +goose Down\n",
    );
    const { problems: found } = collectMigrations(discover(root));
    expect(found.map((problem) => problem.message).join("\n")).toContain(
      "migration version 3 is also used by",
    );
  });
});
