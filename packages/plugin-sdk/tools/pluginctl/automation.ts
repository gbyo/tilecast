/**
 * Plugin Automation Contract v1 file handling (`automation.yaml`).
 *
 * This module only reads one file at a time: it parses the YAML,
 * validates it against the contract schema, and checks the references
 * a single file can prove on its own (duplicates, unknown operation
 * IDs, operation/exclusion overlap). Cross-plugin checks (CLI path or
 * MCP action collisions between plugins) live in `checkAutomationFiles`,
 * which sees every file. The generic CLI (Phase 14) consumes only
 * files that pass there.
 *
 * The file maps existing OpenAPI operations to automation
 * presentation. It redefines no HTTP path, schema, authorization, or
 * validation, so the validator never reads those facets: an
 * operationId either exists in the plugin's own fragment or it does
 * not. `checkAutomationFiles` runs every present file plus the
 * cross-plugin uniqueness rules; `check.ts` wires it into
 * `plugins:check`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import YAML, { type Document } from "yaml";
import {
  AUTOMATION_FILENAME,
  parseAutomationDocument,
  type AutomationDocument,
} from "../../src/automation.ts";
import type { Problem, Repo } from "./repo.ts";
import { collectOperations } from "./supported.ts";

export { AUTOMATION_FILENAME };

export interface AutomationFileInput {
  /** Plugin ID, for example `countdown_bar`. */
  plugin: string;
  /** Path of the file relative to the repository root. */
  file: string;
  /** Raw file text. */
  text: string;
  /** operationIds from the plugin's own OpenAPI fragment. */
  ownOperationIds: Set<string>;
}

export interface AutomationFileResult {
  problems: Problem[];
  document?: AutomationDocument;
}

/** Validate one `automation.yaml` file. Never throws. */
export function checkAutomationFile(
  input: AutomationFileInput,
): AutomationFileResult {
  const { plugin, file, text, ownOperationIds } = input;
  const fail = (message: string): AutomationFileResult => ({
    problems: [{ plugin, file, message }],
  });

  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch {
    return fail("automation file does not parse as YAML");
  }

  let document: AutomationDocument;
  try {
    document = parseAutomationDocument(raw);
  } catch (error) {
    return fail(
      `automation file is not a valid v1 document: ${schemaMessage(error)}`,
    );
  }

  const problems: Problem[] = [];
  const add = (message: string) => problems.push({ plugin, file, message });

  const seenOperations = new Map<string, number>();
  const seenPaths = new Map<string, string>();
  const seenActions = new Map<string, string>();
  document.operations.forEach((operation, index) => {
    const at = `operations[${index}] (${operation.operationId})`;
    const first = seenOperations.get(operation.operationId);
    if (first !== undefined) {
      add(`${at} duplicates operationId also listed at operations[${first}]`);
    } else {
      seenOperations.set(operation.operationId, index);
    }
    if (!ownOperationIds.has(operation.operationId)) {
      add(
        `${at} names an operationId outside this plugin's OpenAPI fragment; automation maps existing operations only`,
      );
    }
    const path = operation.cli.path.join(" ");
    const pathOwner = seenPaths.get(path);
    if (pathOwner !== undefined) {
      add(`${at} CLI path "${path}" is also used by ${pathOwner}`);
    } else {
      seenPaths.set(path, at);
    }
    const actionOwner = seenActions.get(operation.mcp.action);
    if (actionOwner !== undefined) {
      add(
        `${at} MCP action "${operation.mcp.action}" is also used by ${actionOwner}`,
      );
    } else {
      seenActions.set(operation.mcp.action, at);
    }
  });

  for (const exclusion of document.exclusions) {
    if (seenOperations.has(exclusion.operationId)) {
      add(
        `exclusion ${exclusion.operationId} is also mapped under operations; an operation is either automated or excluded`,
      );
    }
    if (!ownOperationIds.has(exclusion.operationId)) {
      add(
        `exclusion ${exclusion.operationId} names an operationId outside this plugin's OpenAPI fragment`,
      );
    }
  }

  if (problems.length > 0) return { problems };
  return { problems, document };
}

/**
 * Every operation a fragment defines, keyed by operationId. Throws when
 * the fragment does not parse; callers that already report fragment
 * errors skip the file instead.
 */
export function collectFragmentOperations(
  fragmentText: string,
): Map<string, { method: string; path: string }> {
  const found = new Map<string, { method: string; path: string }>();
  for (const entry of collectOperations(YAML.parseDocument(fragmentText))) {
    const id = entry.operation.get("operationId");
    if (typeof id === "string" && !found.has(id)) {
      found.set(id, { method: entry.method, path: entry.path });
    }
  }
  return found;
}

/**
 * Validate every `automation.yaml` in the repository. A plugin without
 * one is silent: automation is opt-in per plugin, so a missing file is
 * not drift. A present file must parse, satisfy the contract, reference
 * only its own fragment's operation IDs, and share no CLI path or MCP
 * action with another plugin. Wire into `plugins:check`; the generic
 * CLI (Phase 14) consumes only files that pass here.
 */
export function checkAutomationFiles(
  repo: Repo,
  fragments: { plugin: string; text: string }[],
): Problem[] {
  const problems: Problem[] = [];
  const idsByPlugin = new Map<string, Set<string>>();
  for (const fragment of fragments) {
    let operations: Map<string, { method: string; path: string }>;
    try {
      operations = collectFragmentOperations(fragment.text);
    } catch {
      continue;
    }
    const ids = idsByPlugin.get(fragment.plugin) ?? new Set<string>();
    for (const id of operations.keys()) ids.add(id);
    idsByPlugin.set(fragment.plugin, ids);
  }

  const parsed: {
    plugin: string;
    file: string;
    document: AutomationDocument;
  }[] = [];
  for (const plugin of repo.plugins) {
    const id = plugin.manifest.id;
    const absolute = join(plugin.path, AUTOMATION_FILENAME);
    if (!existsSync(absolute)) continue;
    const file = relative(repo.root, absolute);
    const result = checkAutomationFile({
      plugin: id,
      file,
      text: readFileSync(absolute, "utf8"),
      ownOperationIds: idsByPlugin.get(id) ?? new Set<string>(),
    });
    problems.push(...result.problems);
    if (result.document)
      parsed.push({ plugin: id, file, document: result.document });
  }

  const cliPaths = new Map<string, { plugin: string; file: string }[]>();
  const mcpActions = new Map<string, { plugin: string; file: string }[]>();
  for (const entry of parsed) {
    for (const operation of entry.document.operations) {
      const path = operation.cli.path.join(" ");
      pushOwner(cliPaths, path, entry);
      pushOwner(mcpActions, operation.mcp.action, entry);
    }
  }
  for (const [path, owners] of cliPaths) {
    if (owners.length < 2) continue;
    for (const owner of owners) {
      problems.push({
        plugin: owner.plugin,
        file: owner.file,
        message: `CLI path "${path}" is also automated by ${owners
          .filter((other) => other.plugin !== owner.plugin)
          .map((other) => other.plugin)
          .join(", ")}; automation paths must be unique across plugins`,
      });
    }
  }
  for (const [action, owners] of mcpActions) {
    if (owners.length < 2) continue;
    for (const owner of owners) {
      problems.push({
        plugin: owner.plugin,
        file: owner.file,
        message: `MCP action "${action}" is also automated by ${owners
          .filter((other) => other.plugin !== owner.plugin)
          .map((other) => other.plugin)
          .join(", ")}; automation actions must be unique across plugins`,
      });
    }
  }
  return problems;
}

/**
 * One automation operation with its HTTP binding resolved from the
 * plugin's own fragment. This is what the server embeds and the CLI
 * dispatches on: the CLI never reads YAML or OpenAPI itself.
 */
export interface ResolvedAutomationOperation {
  operationId: string;
  method: string;
  path: string;
  risk: string;
  cliPath: string[];
  mcpAction: string;
  input?: string;
  description?: string;
}

export interface ResolvedAutomation {
  apiVersion: 1;
  plugin: string;
  operations: ResolvedAutomationOperation[];
  exclusions: { operationId: string; reason: string }[];
}

/**
 * Resolve one plugin's automation file against its fragment. Returns
 * problems instead of a document when the file is missing, invalid, or
 * drifts from the fragment; `generate` skips emission then, and `check`
 * reports the same problems through `checkAutomationFiles`.
 */
export function resolveAutomation(
  plugin: string,
  automationText: string | null,
  fragmentText: string | null,
): { problems: Problem[]; resolved?: ResolvedAutomation } {
  const problems: Problem[] = [];
  if (automationText === null) return { problems };
  if (fragmentText === null) {
    return {
      problems: [
        {
          plugin,
          file: automationFileFor(plugin),
          message: "automation file exists but the plugin declares no OpenAPI fragment",
        },
      ],
    };
  }
  let operations: Map<string, { method: string; path: string }>;
  try {
    operations = collectFragmentOperations(fragmentText);
  } catch {
    return { problems };
  }
  const checked = checkAutomationFile({
    plugin,
    file: automationFileFor(plugin),
    text: automationText,
    ownOperationIds: new Set(operations.keys()),
  });
  problems.push(...checked.problems);
  if (!checked.document) return { problems };
  return {
    problems,
    resolved: {
      apiVersion: 1,
      plugin,
      operations: checked.document.operations.map((operation) => {
        const binding = operations.get(operation.operationId);
        const resolved: ResolvedAutomationOperation = {
          operationId: operation.operationId,
          method: binding?.method ?? "get",
          path: binding?.path ?? "",
          risk: operation.risk,
          cliPath: operation.cli.path,
          mcpAction: operation.mcp.action,
        };
        if (operation.input !== undefined) resolved.input = operation.input;
        if (operation.description !== undefined) {
          resolved.description = operation.description;
        }
        return resolved;
      }),
      exclusions: checked.document.exclusions.map((exclusion) => ({
        operationId: exclusion.operationId,
        reason: exclusion.reason,
      })),
    },
  };
}

function automationFileFor(plugin: string): string {
  return `plugins/${plugin.replaceAll("_", "-")}/automation.yaml`;
}

function pushOwner(
  owners: Map<string, { plugin: string; file: string }[]>,
  key: string,
  entry: { plugin: string; file: string },
): void {
  const list = owners.get(key) ?? [];
  if (!list.some((owner) => owner.plugin === entry.plugin)) list.push(entry);
  owners.set(key, list);
}

function schemaMessage(error: unknown): string {
  if (error !== null && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: { path: unknown[]; message: string }[] })
      .issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .slice(0, 3)
        .map((issue) => `${formatPath(issue.path)}: ${issue.message}`)
        .join("; ");
    }
  }
  return "schema validation failed";
}

function formatPath(path: unknown[]): string {
  if (path.length === 0) return "document";
  return path.map((segment) => String(segment)).join(".");
}
