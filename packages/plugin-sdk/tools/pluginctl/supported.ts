/**
 * Derived structural conformance for the programmable control plane.
 *
 * OpenAPI is the API contract. pluginctl validates the OpenAPI contract;
 * it does not maintain another exhaustive API contract. Every check below
 * reads the composed document and derives its expectations from what it
 * finds there:
 *
 * - a stable operationId on every /api/v1 operation (core plus fragments)
 * - a useful description (description or summary) on every /api/v1
 *   operation, so an undescribed operation can no longer stay outside
 *   the surface by staying undescribed
 * - operationId uniqueness (global, core plus plugin fragments)
 * - typed path/query parameters wherever parameters are declared inline
 * - request schemas wherever request bodies exist
 * - response documentation and success schemas where appropriate
 *   (a 101 Switching Protocols is the success case for upgrades)
 * - authentication evidence (a `security` declaration, a CSRF parameter,
 *   a documented 401, or an explicit auth description) on every
 *   non-public operation; operations that declare themselves public are
 *   exempt from the evidence rule
 * - every local `$ref` resolves inside the composed document
 * - every plugin fragment operation carries a stable operationId before
 *   automation can refer to it
 *
 * The only hand-maintained data is EXCLUDED_OPERATIONS: operations that
 * are intentionally not yet part of the programmable management surface,
 * each with a reason. The conformance test caps the size of that set,
 * requires non-trivial reasons, and rejects stale entries, so a second
 * source of truth cannot quietly regrow. There is deliberately no table
 * of methods, paths, operationIds, bodies, errors, or auth classes here:
 * adding a supported operation means describing it in OpenAPI, nothing
 * else.
 */
import YAML, {
  isMap,
  isScalar,
  isSeq,
  type Document,
  type YAMLMap,
} from "yaml";
import { COMPOSED_OPENAPI, CORE_OPENAPI } from "./openapi.ts";
import type { Problem } from "./repo.ts";

export { COMPOSED_OPENAPI, CORE_OPENAPI };

export interface ExcludedOperation {
  /** operationId as declared in OpenAPI. */
  operationId: string;
  /** Why this operation is intentionally outside the surface for now. */
  reason: string;
}

/**
 * Operations intentionally outside the programmable management surface.
 * Keep this small and justified: the conformance test enforces a size
 * cap, a minimum reason length, and that every entry still matches a
 * real operation in the composed document.
 */
export const EXCLUDED_OPERATIONS: ExcludedOperation[] = [
  {
    operationId: "demoState",
    reason:
      "Demo-mode introspection for the local demo stack only; not part of the supported management API.",
  },
];

/** Minimum useful-description length, so a placeholder cannot pass. */
export const MIN_DESCRIPTION_LENGTH = 12;

/** Hard cap on exclusions so the exception set cannot become an allowlist. */
export const MAX_EXCLUDED_OPERATIONS = 8;

/** Minimum reason length so exclusions stay justified, not habitual. */
export const MIN_EXCLUSION_REASON_LENGTH = 40;

const METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);

function scalar(node: unknown): string | null {
  if (!isScalar(node) || typeof node.value !== "string") return null;
  return node.value;
}

function findPair(map: YAMLMap, key: string): unknown {
  for (const pair of map.items) {
    if (scalar(pair.key) === key) return pair.value;
  }
  return null;
}

function textOf(node: unknown): string {
  const value = scalar(node);
  return value ?? "";
}

/** Every operation in a document, with its location. */
export function collectOperations(
  doc: Document,
): { path: string; method: string; operation: YAMLMap }[] {
  const found: { path: string; method: string; operation: YAMLMap }[] = [];
  const paths = doc.get("paths");
  if (!isMap(paths)) return found;
  for (const pathPair of paths.items) {
    const path = scalar(pathPair.key);
    if (path === null || !isMap(pathPair.value)) continue;
    for (const methodPair of pathPair.value.items) {
      const method = scalar(methodPair.key);
      if (method === null || !METHODS.has(method) || !isMap(methodPair.value))
        continue;
      found.push({ path, method, operation: methodPair.value });
    }
  }
  return found;
}

/** operationId -> locations, for uniqueness checks. */
export function operationIdLocations(
  operations: { path: string; method: string; operation: YAMLMap }[],
): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  for (const entry of operations) {
    const id = scalar(findPair(entry.operation, "operationId"));
    if (id === null) continue;
    const location = `${entry.method.toUpperCase()} ${entry.path}`;
    byId.set(id, [...(byId.get(id) ?? []), location]);
  }
  return byId;
}

function checkParameters(
  operation: YAMLMap,
  location: string,
  problems: Problem[],
): void {
  const parameters = findPair(operation, "parameters");
  if (parameters === null) return;
  if (!isSeq(parameters)) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} parameters must be a sequence`,
    });
    return;
  }
  for (const item of parameters.items) {
    if (!isMap(item)) continue;
    const ref = scalar(findPair(item, "$ref"));
    if (ref !== null) continue;
    const schema = findPair(item, "schema");
    const name = textOf(findPair(item, "name")) || "unknown";
    const schemaRef =
      isMap(schema) && typeof scalar(findPair(schema, "$ref")) === "string";
    if (
      !isMap(schema) ||
      (!schemaRef && typeof scalar(findPair(schema, "type")) !== "string")
    ) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} parameter ${name} needs a typed schema`,
      });
    }
  }
}

function checkRequestBody(
  operation: YAMLMap,
  location: string,
  problems: Problem[],
): void {
  const body = findPair(operation, "requestBody");
  if (body === null) return;
  if (!isMap(body)) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must declare its request body as a map`,
    });
    return;
  }
  const content = findPair(body, "content");
  if (!isMap(content) || content.items.length === 0) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must declare a request body content schema`,
    });
    return;
  }
  for (const media of content.items) {
    const schema = isMap(media.value) ? findPair(media.value, "schema") : null;
    if (!isMap(schema)) {
      const mediaType = scalar(media.key) ?? "unknown";
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} ${mediaType} request body needs a schema`,
      });
    }
  }
}

function checkResponses(
  operation: YAMLMap,
  method: string,
  path: string,
  location: string,
  problems: Problem[],
): void {
  const responses = findPair(operation, "responses");
  if (!isMap(responses)) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must document responses`,
    });
    return;
  }
  // The authenticated Player socket is the only HTTP upgrade operation in
  // the contract. Every ordinary operation must still document a 2xx success.
  const allowsProtocolUpgrade =
    method === "get" && path === "/api/v1/player/socket";
  const success = responses.items.find((pair) => {
    const code = scalar(pair.key);
    return (
      code !== null &&
      (code.startsWith("2") || (allowsProtocolUpgrade && code === "101"))
    );
  });
  if (success === undefined) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: allowsProtocolUpgrade
        ? `${location} must document a 2xx response or the Player socket 101 upgrade`
        : `${location} must document a 2xx response`,
    });
    return;
  }
  // Every 2xx carries a described body, except 204 No Content (which is
  // bodyless by definition) and HEAD responses (which describe headers,
  // never a body).
  for (const pair of responses.items) {
    const code = scalar(pair.key);
    if (code === null || !code.startsWith("2") || code === "204") continue;
    if (method === "head") continue;
    if (!isMap(pair.value)) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} ${code} success body needs content`,
      });
      continue;
    }
    const content = findPair(pair.value, "content");
    if (content === null || !isMap(content)) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} ${code} success body needs content`,
      });
      continue;
    }
    for (const media of content.items) {
      const schema = isMap(media.value)
        ? findPair(media.value, "schema")
        : null;
      if (!isMap(schema)) {
        const mediaType = scalar(media.key) ?? "unknown";
        problems.push({
          file: COMPOSED_OPENAPI,
          message: `${location} ${mediaType} success body needs a schema`,
        });
      }
    }
  }
}

function usesCsrfParam(operation: YAMLMap): boolean {
  const parameters = findPair(operation, "parameters");
  if (!isSeq(parameters)) return false;
  return parameters.items.some((item) => {
    if (!isMap(item)) return false;
    const ref = scalar(findPair(item, "$ref"));
    if (typeof ref === "string" && ref.includes("CSRFToken")) return true;
    return textOf(findPair(item, "name")) === "X-CSRF-Token";
  });
}

function declaresPublic(operation: YAMLMap): boolean {
  const description = textOf(findPair(operation, "description"));
  return /^\s*Public\./i.test(description);
}

function checkAuth(
  operation: YAMLMap,
  location: string,
  problems: Problem[],
): void {
  if (declaresPublic(operation)) return;
  const responses = findPair(operation, "responses");
  const unauthorized = isMap(responses) && findPair(responses, "401") !== null;
  const security = findPair(operation, "security");
  const documented =
    (isSeq(security) && security.items.length > 0) ||
    usesCsrfParam(operation) ||
    unauthorized ||
    /session|authenticat|signed-in|owner|administrator|csrf/i.test(
      textOf(findPair(operation, "description")),
    );
  if (!documented) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must document its authentication requirement or declare itself public`,
    });
  }
}

function collectLocalRefs(node: unknown, refs: string[]): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      if (scalar(pair.key) === "$ref") {
        const target = scalar(pair.value);
        if (target !== null && target.startsWith("#/")) refs.push(target);
      }
      collectLocalRefs(pair.key, refs);
      collectLocalRefs(pair.value, refs);
    }
    return;
  }
  if (isSeq(node)) {
    for (const item of node.items) collectLocalRefs(item, refs);
  }
}

function checkReferences(doc: Document, problems: Problem[]): void {
  const refs: string[] = [];
  const root = doc.contents;
  if (root !== null) collectLocalRefs(root, refs);
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const parts = ref
      .slice(2)
      .split("/")
      .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let node: unknown = doc.toJS({ mapAsMap: false });
    let ok = true;
    for (const part of parts) {
      if (typeof node !== "object" || node === null || !(part in node)) {
        ok = false;
        break;
      }
      node = (node as Record<string, unknown>)[part];
    }
    if (!ok) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `reference ${ref} does not resolve in the composed document`,
      });
    }
  }
}

/**
 * Validate the programmable surface against the OpenAPI documents.
 *
 * `composed` is the merged core-plus-fragments document: operationId
 * uniqueness and local reference resolution hold globally across it.
 * `core` carries the per-operation rules: every /api/v1 operation owes a
 * stable operationId and a useful description (description or summary),
 * plus typed parameters, request/response schemas, and authentication
 * evidence. Plugin fragments owe stable operationIds and useful
 * descriptions at this layer — see checkFragmentOperationIds. There is
 * no undescribed back door: adding an /api/v1 operation means
 * describing it in OpenAPI, which is what makes the rule a ratchet
 * instead of a second contract.
 */
export function checkDerivedConformance(
  composed: Document,
  core: Document = composed,
): Problem[] {
  const problems: Problem[] = [];
  const excluded = new Map(
    EXCLUDED_OPERATIONS.map((entry) => [entry.operationId, entry.reason]),
  );
  const byId = operationIdLocations(collectOperations(composed));
  for (const [id, locations] of byId) {
    if (locations.length > 1) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `operationId ${id} is not unique (${locations.join(", ")})`,
      });
    }
  }
  for (const entry of collectOperations(core)) {
    if (!entry.path.startsWith("/api/v1")) continue;
    const id = scalar(findPair(entry.operation, "operationId"));
    const location =
      id === null
        ? `${entry.method.toUpperCase()} ${entry.path}`
        : `${entry.method.toUpperCase()} ${entry.path} (${id})`;
    if (id === null) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} needs a stable operationId`,
      });
    }
    const description = textOf(findPair(entry.operation, "description")).trim();
    const useful =
      description || textOf(findPair(entry.operation, "summary")).trim();
    if (useful.length < MIN_DESCRIPTION_LENGTH) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} needs a useful description`,
      });
    }
    if (id === null) continue;
    if (excluded.has(id)) continue;
    checkParameters(entry.operation, location, problems);
    checkRequestBody(entry.operation, location, problems);
    checkResponses(
      entry.operation,
      entry.method,
      entry.path,
      location,
      problems,
    );
    checkAuth(entry.operation, location, problems);
  }
  checkReferences(composed, problems);
  return problems;
}

/**
 * Every plugin fragment operation needs a stable operationId before
 * automation can refer to it, and a useful description like every other
 * /api/v1 operation. Fragment operationIds share the global uniqueness
 * namespace with core, enforced on the composed document.
 */
export function checkFragmentOperationIds(
  fragments: { plugin: string; file: string; text: string }[],
): Problem[] {
  const problems: Problem[] = [];
  const seen = new Map<string, string>();
  for (const fragment of fragments) {
    let doc: Document;
    try {
      doc = YAML.parseDocument(fragment.text);
    } catch {
      problems.push({
        plugin: fragment.plugin,
        file: fragment.file,
        message: "OpenAPI fragment does not parse",
      });
      continue;
    }
    if (doc.errors.length > 0) {
      problems.push({
        plugin: fragment.plugin,
        file: fragment.file,
        message: "OpenAPI fragment does not parse",
      });
      continue;
    }
    for (const entry of collectOperations(doc)) {
      const location = `${entry.method.toUpperCase()} ${entry.path}`;
      const id = scalar(findPair(entry.operation, "operationId"));
      if (id === null) {
        problems.push({
          plugin: fragment.plugin,
          file: fragment.file,
          message: `${location} needs a stable operationId before automation can refer to it`,
        });
        continue;
      }
      const first = seen.get(id);
      if (first !== undefined) {
        problems.push({
          plugin: fragment.plugin,
          file: fragment.file,
          message: `operationId ${id} is also used by ${first}`,
        });
      } else {
        seen.set(id, `${fragment.plugin} ${location}`);
      }
      const description = textOf(
        findPair(entry.operation, "description"),
      ).trim();
      const useful =
        description || textOf(findPair(entry.operation, "summary")).trim();
      if (useful.length < MIN_DESCRIPTION_LENGTH) {
        problems.push({
          plugin: fragment.plugin,
          file: fragment.file,
          message: `${location} needs a useful description`,
        });
      }
    }
  }
  return problems;
}
