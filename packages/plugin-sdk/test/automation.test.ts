import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  automationDocumentJSONSchema,
  parseAutomationDocument,
} from "../src/automation.ts";
import { checkAutomationFile } from "../tools/pluginctl/automation.ts";
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
