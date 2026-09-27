import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  automationDocumentJSONSchema,
  parseAutomationDocument,
} from "../src/automation.ts";
import {
  checkAutomationFile,
  checkAutomationFiles,
} from "../tools/pluginctl/automation.ts";
import type { DiscoveredPlugin, Repo } from "../tools/pluginctl/repo.ts";
import { collectOperations } from "../tools/pluginctl/supported.ts";

const fixtures = join(import.meta.dirname, "..", "testdata", "automation");
const repoRoot = join(import.meta.dirname, "..", "..", "..");

function load(group: "valid" | "invalid") {
  return readdirSync(join(fixtures, group))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => ({
      name,
      value: YAML.parse(
        readFileSync(join(fixtures, group, name), "utf8"),
      ) as unknown,
    }));
}

function fragmentOperationIds(pluginDir: string): Set<string> {
  const text = readFileSync(
    join(repoRoot, "plugins", pluginDir, "api", "openapi.yaml"),
    "utf8",
  );
  const ids = new Set<string>();
  for (const entry of collectOperations(YAML.parseDocument(text))) {
    const id = entry.operation.get("operationId");
    if (typeof id === "string") ids.add(id);
  }
  return ids;
}

describe("automation contract schema", () => {
  it.each(load("valid"))("accepts $name", ({ value }) => {
    expect(() => parseAutomationDocument(value)).not.toThrow();
  });

  it.each(load("invalid"))("rejects $name", ({ value }) => {
    expect(() => parseAutomationDocument(value)).toThrow();
  });

  it("fills in the documented exclusion default", () => {
    const document = parseAutomationDocument(
      YAML.parse(readFileSync(join(fixtures, "valid", "minimal.yaml"), "utf8")),
    );
    expect(document.exclusions).toEqual([]);
  });

  it("publishes a Draft 2020-12 JSON Schema that matches the checked-in file", () => {
    const generated = automationDocumentJSONSchema();
    expect(generated.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    const committed = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "..",
          "schema",
          "tilecast-automation.schema.json",
        ),
        "utf8",
      ),
    );
    expect(committed).toEqual(generated);
  });

  it("validates the fixtures with a Draft 2020-12 validator", () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(automationDocumentJSONSchema());
    for (const { name, value } of load("valid")) {
      expect(
        validate(value),
        `${name}: ${JSON.stringify(validate.errors)}`,
      ).toBe(true);
    }
    for (const { name, value } of load("invalid")) {
      expect(validate(value), name).toBe(false);
    }
  });
});

describe("automation file references", () => {
  const ownOperationIds = fragmentOperationIds("countdown-bar");
  const file = "plugins/countdown-bar/automation.yaml";
  const text = readFileSync(join(repoRoot, file), "utf8");

  it("accepts the countdown-bar mapping against its own fragment", () => {
    const result = checkAutomationFile({
      plugin: "countdown_bar",
      file,
      text,
      ownOperationIds,
    });
    expect(result.problems).toEqual([]);
    expect(result.document?.operations).toHaveLength(5);
  });

  it("rejects an operationId outside the plugin fragment", () => {
    const edited = text.replace("listCountdownBarInstances", "listScreens");
    const result = checkAutomationFile({
      plugin: "countdown_bar",
      file,
      text: edited,
      ownOperationIds,
    });
    expect(result.document).toBeUndefined();
    expect(
      result.problems.some((problem) =>
        problem.message.includes("outside this plugin's OpenAPI fragment"),
      ),
    ).toBe(true);
  });

  it("rejects duplicates, overlaps, and path collisions", () => {
    const duplicate = text.replace(
      "operationId: getCountdownBarInstance",
      "operationId: listCountdownBarInstances",
    );
    const duplicated = checkAutomationFile({
      plugin: "countdown_bar",
      file,
      text: duplicate,
      ownOperationIds,
    });
    expect(
      duplicated.problems.some((problem) =>
        problem.message.includes("duplicates operationId"),
      ),
    ).toBe(true);

    const overlap = text.replace(
      "exclusions: []",
      "exclusions:\n  - operationId: getCountdownBarInstance\n    reason: Trying to exclude a mapped operation here.",
    );
    const overlapped = checkAutomationFile({
      plugin: "countdown_bar",
      file,
      text: overlap,
      ownOperationIds,
    });
    expect(
      overlapped.problems.some((problem) =>
        problem.message.includes("either automated or excluded"),
      ),
    ).toBe(true);

    const collision = text.replace(
      "path: [countdown-bar, instance, get]",
      "path: [countdown-bar, instance, list]",
    );
    const collided = checkAutomationFile({
      plugin: "countdown_bar",
      file,
      text: collision,
      ownOperationIds,
    });
    expect(
      collided.problems.some((problem) => problem.message.includes("CLI path")),
    ).toBe(true);
  });

  it("rejects an exclusion outside the plugin fragment", () => {
    const edited = text.replace(
      "exclusions: []",
      "exclusions:\n  - operationId: listScreens\n    reason: Core operations stay out of plugin files.",
    );
    const result = checkAutomationFile({
      plugin: "countdown_bar",
      file,
      text: edited,
      ownOperationIds,
    });
    expect(
      result.problems.some((problem) =>
        problem.message.includes("exclusion listScreens"),
      ),
    ).toBe(true);
  });

  it("reports unparsable YAML without throwing", () => {
    const result = checkAutomationFile({
      plugin: "countdown_bar",
      file,
      text: "apiVersion: [unclosed\n",
      ownOperationIds,
    });
    expect(result.document).toBeUndefined();
    expect(result.problems).toHaveLength(1);
  });
});

describe("repository automation validation", () => {
  let root: string;
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function fragment(operationIds: string[]): string {
    const paths = operationIds
      .map(
        (id, index) => `  /api/v1/plugins/example/things${index}:
    get:
      operationId: ${id}
      responses:
        "200": { description: Things }`,
      )
      .join("\n");
    return `openapi: 3.1.0\ninfo:\n  title: T\n  version: "1"\npaths:\n${paths}\n`;
  }

  function automation(
    operationId: string,
    path: string[],
    action: string,
  ): string {
    return `apiVersion: 1
operations:
  - operationId: ${operationId}
    risk: read
    cli:
      path: [${path.join(", ")}]
    mcp:
      action: ${action}
`;
  }

  function addPlugin(
    repo: Repo,
    fragments: { plugin: string; text: string }[],
    dir: string,
    id: string,
    operationIds: string[],
    automationText?: string,
  ): void {
    const path = join(repo.root, "plugins", dir);
    mkdirSync(join(path, "api"), { recursive: true });
    const fragmentText = fragment(operationIds);
    writeFileSync(join(path, "api", "openapi.yaml"), fragmentText);
    fragments.push({ plugin: id, text: fragmentText });
    if (automationText !== undefined) {
      writeFileSync(join(path, "automation.yaml"), automationText);
    }
    repo.plugins.push({
      dir,
      path,
      manifest: { id } as DiscoveredPlugin["manifest"],
      goPackage: null,
    });
  }

  function makeRepo(): {
    repo: Repo;
    fragments: { plugin: string; text: string }[];
  } {
    root = mkdtempSync(join(tmpdir(), "automation-"));
    roots.push(root);
    const repo: Repo = {
      root,
      pluginsDir: join(root, "plugins"),
      plugins: [],
      problems: [],
    };
    return { repo, fragments: [] };
  }

  it("stays silent when no plugin opts in", () => {
    const { repo, fragments } = makeRepo();
    addPlugin(repo, fragments, "alpha-one", "alpha_one", ["listAlphas"]);
    addPlugin(repo, fragments, "beta-two", "beta_two", ["listBetas"]);
    expect(checkAutomationFiles(repo, fragments)).toEqual([]);
  });

  it("accepts a valid file", () => {
    const { repo, fragments } = makeRepo();
    addPlugin(
      repo,
      fragments,
      "alpha-one",
      "alpha_one",
      ["listAlphas"],
      automation("listAlphas", ["alpha", "list"], "list_alphas"),
    );
    expect(checkAutomationFiles(repo, fragments)).toEqual([]);
  });

  it("treats CLI paths as relative to the plugin namespace", () => {
    // No central registry of plugin roots: any non-lifecycle root mounts
    // below `tilecast plugin` without competing with core commands.
    const { repo, fragments } = makeRepo();
    addPlugin(
      repo,
      fragments,
      "alpha-one",
      "alpha_one",
      ["listAlphas"],
      automation("listAlphas", ["alpha", "things", "list"], "list_alphas"),
    );
    expect(checkAutomationFiles(repo, fragments)).toEqual([]);
  });

  it("rejects CLI roots colliding with lifecycle commands", () => {
    const { repo, fragments } = makeRepo();
    addPlugin(
      repo,
      fragments,
      "list",
      "list",
      ["listLists"],
      automation("listLists", ["list", "run"], "run"),
    );
    const problems = checkAutomationFiles(repo, fragments);
    expect(
      problems.some((problem) =>
        problem.message.includes("collides with the handwritten plugin lifecycle"),
      ),
    ).toBe(true);
  });

  it("fails drift when the fragment renames an operation", () => {
    const { repo, fragments } = makeRepo();
    addPlugin(
      repo,
      fragments,
      "alpha-one",
      "alpha_one",
      ["searchAlphas"],
      automation("listAlphas", ["alpha", "list"], "list_alphas"),
    );
    const problems = checkAutomationFiles(repo, fragments);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain(
      "outside this plugin's OpenAPI fragment",
    );
  });

  it("rejects CLI path and MCP action collisions across plugins", () => {
    const { repo, fragments } = makeRepo();
    addPlugin(
      repo,
      fragments,
      "alpha-one",
      "alpha_one",
      ["runAlpha"],
      automation("runAlpha", ["shared", "run"], "shared_run"),
    );
    addPlugin(
      repo,
      fragments,
      "beta-two",
      "beta_two",
      ["runBeta"],
      automation("runBeta", ["shared", "run"], "shared_run"),
    );
    const problems = checkAutomationFiles(repo, fragments);
    expect(
      problems.filter((problem) =>
        problem.message.includes('CLI path "shared run"'),
      ),
    ).toHaveLength(2);
    expect(
      problems.filter((problem) =>
        problem.message.includes('MCP action "shared_run"'),
      ),
    ).toHaveLength(2);
  });

  it("reports a broken file without throwing", () => {
    const { repo, fragments } = makeRepo();
    addPlugin(
      repo,
      fragments,
      "alpha-one",
      "alpha_one",
      ["listAlphas"],
      "apiVersion: [unclosed\n",
    );
    const problems = checkAutomationFiles(repo, fragments);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe(
      join("plugins", "alpha-one", "automation.yaml"),
    );
  });
});

describe("automation resolution against OpenAPI", () => {
  const coreText = readFileSync(join(repoRoot, "docs", "openapi", "core.yaml"), "utf8");
  const fragmentText = readFileSync(
    join(repoRoot, "plugins", "countdown-bar", "api", "openapi.yaml"),
    "utf8",
  );
  const automationText = readFileSync(
    join(repoRoot, "plugins", "countdown-bar", "automation.yaml"),
    "utf8",
  );

  it("derives mechanical metadata without growing automation.yaml", async () => {
    const { resolveAutomation } = await import("../tools/pluginctl/automation.ts");
    const { problems, resolved } = resolveAutomation(
      "countdown_bar",
      automationText,
      fragmentText,
      coreText,
    );
    expect(problems).toEqual([]);
    expect(resolved?.operations).toHaveLength(5);
    const byId = new Map(resolved!.operations.map((op) => [op.operationId, op]));
    expect(byId.get("getCountdownBarInstance")?.pathParams).toEqual([
      { name: "id", required: true, type: "string", format: "uuid" },
    ]);
    expect(byId.get("listCountdownBarInstances")?.pathParams).toEqual([]);
    const schema = byId.get("createCountdownBarInstance")?.requestBody?.schema as {
      properties?: Record<string, { type?: string }>;
    };
    expect(schema?.properties?.["name"]?.type).toBe("string");
    expect(schema?.properties?.["showConfetti"]?.type).toBe("boolean");
    expect(automationText).not.toContain("queryParams");
    expect(automationText).not.toContain("requestBody");
  });

  it("keeps break-glass out of automation", async () => {
    const { parseAutomationDocument } = await import("../src/automation.ts");
    expect(() =>
      parseAutomationDocument(
        YAML.parse(readFileSync(join(fixtures, "invalid", "break-glass-risk.yaml"), "utf8")),
      ),
    ).toThrow();
  });

  it("fails clearly on fields input", async () => {
    const { resolveAutomation } = await import("../tools/pluginctl/automation.ts");
    const yamlText = `apiVersion: 1
operations:
  - operationId: listCountdownBarInstances
    risk: read
    cli:
      path: [countdown-bar, instance, list]
    mcp:
      action: list_instances
    input: fields
`;
    const { problems, resolved } = resolveAutomation(
      "countdown_bar",
      yamlText,
      fragmentText,
      coreText,
    );
    expect(resolved).toBeUndefined();
    expect(problems.some((p) => p.message.includes('input "fields"'))).toBe(true);
  });

  it("fails clearly on unsupported OpenAPI shapes", async () => {
    const { extractOperationMetadata } = await import(
      "../tools/pluginctl/automation-params.ts"
    );
    const fragment = `openapi: 3.1.0
info:
  title: T
  version: "1"
paths:
  /api/v1/plugins/example/things:
    get:
      operationId: listThings
      parameters:
        - name: filter
          in: query
          required: false
          schema:
            type: object
      responses:
        "200": { description: Things }
  /api/v1/plugins/example/blob:
    post:
      operationId: uploadBlob
      requestBody:
        required: true
        content:
          image/png:
            schema: { type: string, format: binary }
      responses:
        "201": { description: Created }
`;
    const { metadata, problems } = extractOperationMetadata("example", "f", fragment, null);
    expect(metadata.size).toBe(0);
    expect(problems.some((p) => p.message.includes("non-scalar type"))).toBe(true);
    expect(problems.some((p) => p.message.includes("only application/json"))).toBe(true);
  });
});
