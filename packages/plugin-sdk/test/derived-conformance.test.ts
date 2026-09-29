import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generate } from "../tools/pluginctl/generate.ts";
import { COMPOSED_OPENAPI, CORE_OPENAPI } from "../tools/pluginctl/openapi.ts";
import { discover, repoRoot } from "../tools/pluginctl/repo.ts";
import {
  checkDerivedConformance,
  checkFragmentOperationIds,
  collectOperations,
  EXCLUDED_OPERATIONS,
  MAX_EXCLUDED_OPERATIONS,
  MIN_EXCLUSION_REASON_LENGTH,
  operationIdLocations,
} from "../tools/pluginctl/supported.ts";
import * as supportedModule from "../tools/pluginctl/supported.ts";

function doc(text: string) {
  return YAML.parseDocument(text);
}

const OPERATION = (
  body: string,
  path = "/api/v1/things",
  method = "get",
) => `openapi: 3.1.0
info:
  title: T
  version: 1.0.0
paths:
  ${path}:
    ${method}:
${body
  .split("\n")
  .map((line) => (line ? `      ${line}` : line))
  .join("\n")}
`;

describe("derived conformance", () => {
  it("accepts a fully described operation", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: Requires an authenticated dashboard session.
parameters:
  - { name: q, in: query, required: false, schema: { type: string } }
responses:
  "200":
    description: Things
    content:
      application/json:
        schema: { type: object, additionalProperties: true }
  "401": { description: Dashboard authentication required }`),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("rejects duplicate operationIds", () => {
    const problems = checkDerivedConformance(
      doc(`openapi: 3.1.0
info: { title: T, version: 1.0.0 }
paths:
  /api/v1/a:
    get:
      operationId: same
      description: Requires an authenticated dashboard session.
      responses: { "200": { description: ok, content: { application/json: { schema: { type: object, additionalProperties: true } } } } }
  /api/v1/b:
    get:
      operationId: same
      description: Requires an authenticated dashboard session.
      responses: { "200": { description: ok, content: { application/json: { schema: { type: object, additionalProperties: true } } } } }
`),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "operationId same is not unique (GET /api/v1/a, GET /api/v1/b)",
    ]);
  });

  it("requires a stable operationId on /api/v1 operations", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`description: Requires an authenticated dashboard session.
responses: { "200": { description: ok, content: { application/json: { schema: { type: object, additionalProperties: true } } } } }`),
      ),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "GET /api/v1/things needs a stable operationId",
    ]);
  });

  it("requires a useful description on /api/v1 operations", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
responses:
  "200":
    description: ok
    content:
      application/json:
        schema: { type: object, additionalProperties: true }
  "401": { description: Dashboard authentication required }`),
      ),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "GET /api/v1/things (getThings) needs a useful description",
    ]);
  });

  it("accepts a summary as the useful description", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
summary: List things.
responses:
  "200":
    description: ok
    content:
      application/json:
        schema: { type: object, additionalProperties: true }
  "401": { description: Dashboard authentication required }`),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("falls back to summary when description is whitespace", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: "   "
summary: List things from the dashboard.
responses:
  "200":
    description: ok
    content:
      application/json:
        schema: { type: object, additionalProperties: true }
  "401": { description: Dashboard authentication required }`),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("rejects placeholder descriptions", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: TODO.
responses:
  "200":
    description: ok
    content:
      application/json:
        schema: { type: object, additionalProperties: true }
  "401": { description: Dashboard authentication required }`),
      ),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "GET /api/v1/things (getThings) needs a useful description",
    ]);
  });

  it("accepts a 101 upgrade for the Player socket", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(
          `operationId: playerSocket
description: Requires an authenticated player credential.
security: [{ deviceBearer: [] }]
responses:
  "101": { description: Player WebSocket connected }
  "401": { description: Credential invalid or revoked }`,
          "/api/v1/player/socket",
          "get",
        ),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("does not accept 101 as success for ordinary operations", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(
          `operationId: updateThing
description: Requires an authenticated dashboard session.
responses:
  "101": { description: Unexpected protocol switch }
  "401": { description: Dashboard authentication required }`,
          "/api/v1/things/{id}",
          "post",
        ),
      ),
    );
    expect(problems.map((p) => p.message)).toContain(
      "POST /api/v1/things/{id} (updateThing) must document a 2xx response",
    );
  });

  it("accepts a referenced parameter schema", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: Requires an authenticated dashboard session.
parameters:
  - { name: type, in: query, required: false, schema: { $ref: "#/components/schemas/ThingType" } }
responses: { "200": { description: ok, content: { application/json: { schema: { type: object, additionalProperties: true } } } } }`) +
          `components:
  schemas:
    ThingType: { type: string }
`,
      ),
    );
    expect(problems).toEqual([]);
  });

  it("requires typed inline parameter schemas", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: Requires an authenticated dashboard session.
parameters:
  - { name: q, in: query, required: false }
responses: { "200": { description: ok, content: { application/json: { schema: { type: object, additionalProperties: true } } } } }`),
      ),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "GET /api/v1/things (getThings) parameter q needs a typed schema",
    ]);
  });

  it("requires a JSON schema wherever a body exists", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(
          `operationId: updateThing
description: Requires an authenticated dashboard session.
requestBody:
  required: true
  content:
    application/json: {}
responses: { "200": { description: ok, content: { application/json: { schema: { type: object, additionalProperties: true } } } } }`,
          "/api/v1/things/{id}",
          "patch",
        ),
      ),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "PATCH /api/v1/things/{id} (updateThing) application/json request body needs a schema",
    ]);
  });

  it("requires documented responses with schemas on content", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: Requires an authenticated dashboard session.`),
      ),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "GET /api/v1/things (getThings) must document responses",
    ]);
  });

  it("requires auth evidence on non-public operations", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: Returns things.
responses: { "200": { description: ok, content: { application/json: { schema: { type: object, additionalProperties: true } } } } }`),
      ),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "GET /api/v1/things (getThings) must document its authentication requirement or declare itself public",
    ]);
  });

  it("exempts operations that declare themselves public", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getIdentity
description: Public. Safe installation identity.
responses:
  "200":
    description: Identity
    content:
      application/json:
        schema: { type: object, additionalProperties: true }`),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("rejects a bare object schema", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: Requires an authenticated dashboard session.
responses:
  "200":
    description: Things
    content:
      application/json:
        schema:
          type: object
          required: [data]
          properties:
            data: { type: object }
  "401": { description: Dashboard authentication required }`),
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("properties.data");
    expect(problems[0]?.message).toContain("additionalProperties");
  });

  it("accepts open, closed-empty, and composed object schemas", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: Requires an authenticated dashboard session.
responses:
  "200":
    description: Things
    content:
      application/json:
        schema:
          type: object
          required: [open, empty, either, nullable]
          properties:
            open: { type: object, additionalProperties: true }
            empty: { type: object, additionalProperties: false }
            either: { oneOf: [{ type: object, properties: { a: { type: string } } }, { type: "null" }] }
            nullable: { type: [object, "null"], additionalProperties: { type: string } }
  "401": { description: Dashboard authentication required }`),
      ),
    );
    expect(problems).toEqual([]);
  });

  it("rejects dangling local references", () => {
    const problems = checkDerivedConformance(
      doc(
        OPERATION(`operationId: getThings
description: Requires an authenticated dashboard session.
responses:
  "200":
    description: Things
    content:
      application/json:
        schema: { $ref: "#/components/schemas/Missing" }
components: { schemas: {} }`),
      ),
    );
    expect(problems.map((p) => p.message)).toEqual([
      "reference #/components/schemas/Missing does not resolve in the composed document",
    ]);
  });

  it("honors justified exclusions", () => {
    const excluded = EXCLUDED_OPERATIONS[0];
    expect(excluded).toBeDefined();
    const problems = checkDerivedConformance(
      doc(`openapi: 3.1.0
info: { title: T, version: 1.0.0 }
paths:
  /api/v1/demo:
    get:
      operationId: ${excluded!.operationId}
      description: Demo-only endpoint for tests.
      responses: { "200": { description: ok, content: { application/json: { schema: { type: object, additionalProperties: true } } } } }
`),
    );
    expect(problems).toEqual([]);
  });
});

describe("fragment operationIds", () => {
  it("requires stable IDs, descriptions, and uniqueness", () => {
    const problems = checkFragmentOperationIds([
      {
        plugin: "a",
        file: "plugins/a/api/openapi.yaml",
        text: "openapi: 3.1.0\ninfo: {title: A, version: 1.0.0}\npaths:\n  /api/v1/a:\n    get:\n      responses:\n        '200': {description: ok}\n",
      },
      {
        plugin: "b",
        file: "plugins/b/api/openapi.yaml",
        text: "openapi: 3.1.0\ninfo: {title: B, version: 1.0.0}\npaths:\n  /api/v1/b:\n    get:\n      operationId: dup\n      responses:\n        '200': {description: ok}\n",
      },
      {
        plugin: "c",
        file: "plugins/c/api/openapi.yaml",
        text: "openapi: 3.1.0\ninfo: {title: C, version: 1.0.0}\npaths:\n  /api/v1/c:\n    get:\n      operationId: dup\n      responses:\n        '200': {description: ok}\n",
      },
    ]);
    expect(problems.map((p) => p.message)).toEqual([
      "GET /api/v1/a needs a stable operationId before automation can refer to it",
      "GET /api/v1/b needs a useful description",
      "operationId dup is also used by b GET /api/v1/b",
      "GET /api/v1/c needs a useful description",
    ]);
  });

  it("falls back to summary when a fragment description is whitespace", () => {
    const problems = checkFragmentOperationIds([
      {
        plugin: "a",
        file: "plugins/a/api/openapi.yaml",
        text: "openapi: 3.1.0\ninfo: {title: A, version: 1.0.0}\npaths:\n  /api/v1/a:\n    get:\n      operationId: listA\n      description: '   '\n      summary: List plugin resources.\n      responses:\n        '200': {description: ok}\n",
      },
    ]);
    expect(problems).toEqual([]);
  });
});

describe("no second source of truth", () => {
  it("exports no operation restatement table", () => {
    for (const [key, value] of Object.entries(supportedModule)) {
      if (key === "EXCLUDED_OPERATIONS") continue;
      expect(
        Array.isArray(value),
        `${key} must not be a maintained operation list`,
      ).toBe(false);
    }
  });

  // Regenerates the composed contract and runs full conformance: seconds of
  // YAML work even unloaded, so it gets an explicit budget instead of the 5s default.
  it("keeps the exclusion set small, justified, and live", async () => {
    expect(EXCLUDED_OPERATIONS.length).toBeLessThanOrEqual(
      MAX_EXCLUDED_OPERATIONS,
    );
    const ids = new Set<string>();
    for (const entry of EXCLUDED_OPERATIONS) {
      expect(entry.operationId).toBeTruthy();
      expect(ids.has(entry.operationId)).toBe(false);
      ids.add(entry.operationId);
      expect(entry.reason.length).toBeGreaterThanOrEqual(
        MIN_EXCLUSION_REASON_LENGTH,
      );
    }
    const repo = discover(repoRoot());
    const { files, problems } = await generate(repo);
    expect(problems).toEqual([]);
    const composed = files.get(COMPOSED_OPENAPI);
    expect(composed).toBeDefined();
    const live = operationIdLocations(collectOperations(doc(composed!)));
    for (const entry of EXCLUDED_OPERATIONS) {
      expect(
        live.has(entry.operationId),
        `exclusion ${entry.operationId} is stale; remove it`,
      ).toBe(true);
    }
    const core = doc(readFileSync(join(repoRoot(), CORE_OPENAPI), "utf8"));
    expect(checkDerivedConformance(doc(composed!), core)).toEqual([]);
  }, 30000);
});
