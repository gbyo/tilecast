import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  checkFragmentOperationIds,
  checkSupportedOperations,
} from "../tools/pluginctl/supported.ts";
import { COMPOSED_OPENAPI } from "../tools/pluginctl/openapi.ts";
import { discover, repoRoot } from "../tools/pluginctl/repo.ts";

const SESSION_OP = `openapi: 3.1.0
info:
  title: T
  version: "1"
paths:
  /api/v1/system/identity:
    get:
      operationId: installationIdentity
      description: Public installation identity.
      responses:
        "200":
          description: Identity
          content:
            application/json:
              schema:
                type: object
  /api/v1/screens:
    get:
      operationId: listScreens
      description: Requires an enrolled dashboard session.
      responses:
        "200":
          description: Screens
        "401":
          description: Dashboard authentication required
  /api/v1/settings:
    patch:
      operationId: updateSettings
      description: Requires the Owner or Administrator role and the X-CSRF-Token header.
      parameters:
        - $ref: "#/components/parameters/CSRFToken"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Updated
        "401":
          description: Dashboard authentication required
        "403":
          description: Owner or Administrator required
        "409":
          description: Revision conflict
        "422":
          description: Invalid setting
`;

describe("supported operations", () => {
  it("accepts hardened entries and reports only undescribed paths", () => {
    const messages = checkSupportedOperations(
      YAML.parseDocument(SESSION_OP),
      COMPOSED_OPENAPI,
    ).map((problem) => problem.message);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).toContain(
        "is a supported operation but is not described",
      );
    }
  });

  it("rejects a renamed operationId", () => {
    const doc = YAML.parseDocument(
      SESSION_OP.replace(
        "operationId: listScreens",
        "operationId: listAllScreens",
      ),
    );
    const messages = checkSupportedOperations(doc, COMPOSED_OPENAPI).map(
      (problem) => problem.message,
    );
    expect(messages.join("\n")).toContain("automation refers to listScreens");
  });

  it("rejects an untyped parameter", () => {
    const doc = YAML.parseDocument(
      SESSION_OP.replace(
        "  /api/v1/screens:\n    get:",
        "  /api/v1/screens:\n    get:\n      parameters:\n        - { in: query, name: q }",
      ),
    );
    const messages = checkSupportedOperations(doc, COMPOSED_OPENAPI).map(
      (problem) => problem.message,
    );
    expect(messages.join("\n")).toContain("parameter q needs a typed schema");
  });

  it("rejects a missing conflict response", () => {
    const doc = YAML.parseDocument(
      SESSION_OP.replace(
        '        "409":\n          description: Revision conflict\n',
        "",
      ),
    );
    const messages = checkSupportedOperations(doc, COMPOSED_OPENAPI).map(
      (problem) => problem.message,
    );
    expect(messages.join("\n")).toContain("must document the 409 response");
  });

  it("rejects a fragment operation without an operationId", () => {
    const problems = checkFragmentOperationIds([
      {
        plugin: "emergency-alerts",
        file: "plugins/emergency-alerts/api/openapi.yaml",
        text: `openapi: 3.1.0
info:
  title: Emergency Alerts plugin API
  version: "1"
paths:
  /api/v1/alerts/nws:
    get:
      summary: Read the monitor
      responses:
        "200":
          description: Monitor
`,
      },
    ]);
    expect(problems.map((problem) => problem.message).join("\n")).toContain(
      "needs a stable operationId",
    );
  });

  it("rejects duplicate fragment operationIds", () => {
    const fragment = (path: string) => `openapi: 3.1.0
info:
  title: T
  version: "1"
paths:
  ${path}:
    get:
      operationId: listThings
      responses:
        "200":
          description: Things
`;
    const problems = checkFragmentOperationIds([
      { plugin: "a", file: "a.yaml", text: fragment("/api/v1/a/things") },
      { plugin: "b", file: "b.yaml", text: fragment("/api/v1/b/things") },
    ]);
    expect(problems.map((problem) => problem.message).join("\n")).toContain(
      "operationId listThings is also used by",
    );
  });

  it("holds the real composed contract", () => {
    const root = repoRoot();
    const text = readFileSync(join(root, COMPOSED_OPENAPI), "utf8");
    const problems = checkSupportedOperations(
      YAML.parseDocument(text),
      COMPOSED_OPENAPI,
    );
    expect(problems.map((problem) => problem.message)).toEqual([]);
  });

  it("holds every real plugin fragment", () => {
    const root = repoRoot();
    const fragments = discover(root).plugins.flatMap((plugin) => {
      const declared = plugin.manifest.api?.openapi;
      if (!declared) return [];
      const file = join(plugin.path, declared);
      return [
        { plugin: plugin.manifest.id, file, text: readFileSync(file, "utf8") },
      ];
    });
    expect(fragments.length).toBeGreaterThan(0);
    const problems = checkFragmentOperationIds(fragments);
    expect(problems.map((problem) => problem.message)).toEqual([]);
  });
});
