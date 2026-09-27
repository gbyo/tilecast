/**
 * Supported-operation contract for the programmable control plane.
 *
 * The operations below are what the generated Go client and the handwritten
 * CLI build on, and their operationIds are what plugin automation will
 * refer to. This module only reads the composed OpenAPI document; it never
 * interprets command semantics. Changing a supported operation (renaming an
 * ID, dropping a schema, weakening auth documentation) must update this
 * list in the same change, so drift fails `plugins:check` instead of
 * reaching clients silently.
 *
 * Scope is deliberate: only the supported slice is pinned here. Other core
 * operations gain IDs and schemas progressively as they become
 * client-facing. Every plugin fragment operation needs an ID today, because
 * automation refers to plugin operations by ID.
 */
import YAML, {
  isMap,
  isScalar,
  isSeq,
  type Document,
  type YAMLMap,
} from "yaml";
import { COMPOSED_OPENAPI } from "./openapi.ts";
import type { Problem } from "./repo.ts";

export type SupportedAuth = "public" | "session" | "session-manager";

export interface SupportedOperation {
  method: string;
  path: string;
  operationId: string;
  /** "schema" requires a JSON request body schema; "none" forbids a body. */
  requestBody: "none" | "schema";
  /** Whether a 2xx response must carry an application/json schema. */
  responseSchema: boolean;
  /** Error status codes the contract must document. */
  errors: string[];
  auth: SupportedAuth;
}

export const SUPPORTED_OPERATIONS: SupportedOperation[] = [
  {
    method: "get",
    path: "/api/v1/system/identity",
    operationId: "installationIdentity",
    requestBody: "none",
    responseSchema: true,
    errors: [],
    auth: "public",
  },
  {
    method: "get",
    path: "/api/v1/system/status",
    operationId: "systemStatus",
    requestBody: "none",
    responseSchema: false,
    errors: ["401", "403"],
    auth: "session-manager",
  },
  {
    method: "get",
    path: "/api/v1/auth/status",
    operationId: "authStatus",
    requestBody: "none",
    responseSchema: true,
    errors: [],
    auth: "public",
  },
  {
    method: "get",
    path: "/api/v1/screens",
    operationId: "listScreens",
    requestBody: "none",
    responseSchema: false,
    errors: ["401"],
    auth: "session",
  },
  {
    method: "get",
    path: "/api/v1/screens/{id}",
    operationId: "getScreen",
    requestBody: "none",
    responseSchema: false,
    errors: ["401", "404"],
    auth: "session",
  },
  {
    method: "get",
    path: "/api/v1/settings",
    operationId: "getSettings",
    requestBody: "none",
    responseSchema: false,
    errors: ["401"],
    auth: "session",
  },
  {
    method: "patch",
    path: "/api/v1/settings",
    operationId: "updateSettings",
    requestBody: "schema",
    responseSchema: false,
    errors: ["401", "403", "409", "422"],
    auth: "session-manager",
  },
  {
    method: "get",
    path: "/api/v1/screens/{id}/effective-policy",
    operationId: "getEffectivePolicy",
    requestBody: "none",
    responseSchema: false,
    errors: ["401", "404"],
    auth: "session",
  },
  {
    method: "get",
    path: "/api/v1/plugins",
    operationId: "listPlugins",
    requestBody: "none",
    responseSchema: true,
    errors: ["401"],
    auth: "session",
  },
  {
    method: "post",
    path: "/api/v1/plugins/{pluginId}/install",
    operationId: "installPlugin",
    requestBody: "none",
    responseSchema: true,
    errors: ["403", "404", "409"],
    auth: "session-manager",
  },
  {
    method: "delete",
    path: "/api/v1/plugins/{pluginId}/installation",
    operationId: "removePlugin",
    requestBody: "none",
    responseSchema: false,
    errors: ["403", "404", "409"],
    auth: "session-manager",
  },
  {
    method: "get",
    path: "/api/v1/plugins/{pluginId}/automation",
    operationId: "getPluginAutomation",
    requestBody: "none",
    responseSchema: true,
    errors: ["401", "404", "409"],
    auth: "session",
  },
  {
    method: "get",
    path: "/api/v1/screens/pairing/pending",
    operationId: "listPendingPairings",
    requestBody: "none",
    responseSchema: false,
    errors: ["401", "403"],
    auth: "session-manager",
  },
  {
    method: "get",
    path: "/api/v1/me/preferences",
    operationId: "getPreferences",
    requestBody: "none",
    responseSchema: false,
    errors: ["401"],
    auth: "session",
  },
  {
    method: "patch",
    path: "/api/v1/me/preferences",
    operationId: "updatePreferences",
    requestBody: "schema",
    responseSchema: false,
    errors: ["401", "403", "409"],
    auth: "session",
  },
];

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

/** Every operation in the composed document, with its location. */
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
    if (
      !isMap(schema) ||
      typeof scalar(findPair(schema, "type")) !== "string"
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
  expected: SupportedOperation,
  location: string,
  problems: Problem[],
): void {
  const body = findPair(operation, "requestBody");
  if (expected.requestBody === "none") {
    if (body !== null) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} must not declare a request body`,
      });
    }
    return;
  }
  if (!isMap(body)) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must declare a JSON request body schema`,
    });
    return;
  }
  const content = findPair(body, "content");
  const json = isMap(content) ? findPair(content, "application/json") : null;
  const schema = isMap(json) ? findPair(json, "schema") : null;
  if (!isMap(schema)) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must declare a JSON request body schema`,
    });
  }
}

function checkResponses(
  operation: YAMLMap,
  expected: SupportedOperation,
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
  for (const code of expected.errors) {
    if (findPair(responses, code) === null) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} must document the ${code} response`,
      });
    }
  }
  if (!expected.responseSchema) return;
  const success = responses.items.find((pair) => {
    const code = scalar(pair.key);
    return code !== null && code.startsWith("2");
  });
  const content =
    success && isMap(success.value) ? findPair(success.value, "content") : null;
  const json = isMap(content) ? findPair(content, "application/json") : null;
  const schema = isMap(json) ? findPair(json, "schema") : null;
  if (!isMap(schema)) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must document a JSON success schema`,
    });
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

function checkAuth(
  operation: YAMLMap,
  expected: SupportedOperation,
  location: string,
  problems: Problem[],
): void {
  const description = textOf(findPair(operation, "description"));
  if (expected.auth === "public") {
    if (!/public/i.test(description)) {
      problems.push({
        file: COMPOSED_OPENAPI,
        message: `${location} must document that it needs no authentication`,
      });
    }
    return;
  }
  const responses = findPair(operation, "responses");
  const unauthorized = isMap(responses) && findPair(responses, "401") !== null;
  const security = findPair(operation, "security");
  const documented =
    (isSeq(security) && security.items.length > 0) ||
    usesCsrfParam(operation) ||
    unauthorized ||
    /session|authenticat|signed-in|owner|administrator|csrf/i.test(description);
  if (!documented) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must document its session authentication requirement`,
    });
    return;
  }
  if (
    expected.auth === "session-manager" &&
    !/owner|administrator/i.test(description)
  ) {
    problems.push({
      file: COMPOSED_OPENAPI,
      message: `${location} must document the Owner or Administrator role requirement`,
    });
  }
}

/**
 * Validate the supported slice against the composed document. Only the
 * listed operations are pinned; anything else may harden progressively.
 */
export function checkSupportedOperations(
  doc: Document,
  file: string,
): Problem[] {
  const problems: Problem[] = [];
  const operations = collectOperations(doc);
  const byId = new Map<string, number>();
  for (const entry of operations) {
    const id = scalar(findPair(entry.operation, "operationId"));
    if (id !== null) byId.set(id, (byId.get(id) ?? 0) + 1);
  }
  for (const expected of SUPPORTED_OPERATIONS) {
    const location = `${expected.method.toUpperCase()} ${expected.path}`;
    const match = operations.find(
      (entry) =>
        entry.path === expected.path && entry.method === expected.method,
    );
    if (!match) {
      problems.push({
        file,
        message: `${location} is a supported operation but is not described`,
      });
      continue;
    }
    const actual = scalar(findPair(match.operation, "operationId"));
    if (actual !== expected.operationId) {
      problems.push({
        file,
        message: `${location} operationId is ${actual ?? "missing"}; automation refers to ${expected.operationId}`,
      });
      continue;
    }
    if ((byId.get(expected.operationId) ?? 0) > 1) {
      problems.push({
        file,
        message: `operationId ${expected.operationId} is not unique`,
      });
    }
    checkParameters(match.operation, location, problems);
    checkRequestBody(match.operation, expected, location, problems);
    checkResponses(match.operation, expected, location, problems);
    checkAuth(match.operation, expected, location, problems);
  }
  return problems;
}

/**
 * Every plugin fragment operation needs a stable operationId before
 * automation can refer to it. Core operations outside the supported slice
 * harden progressively and are not pinned here.
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
    }
  }
  return problems;
}
