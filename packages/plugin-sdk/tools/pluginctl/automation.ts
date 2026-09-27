/**
 * Plugin Automation Contract v1 file handling (`automation.yaml`).
 *
 * This module only reads one file at a time: it parses the YAML,
 * validates it against the contract schema, and checks the references
 * a single file can prove on its own (duplicates, unknown operation
 * IDs, operation/exclusion overlap). Cross-plugin checks (CLI path or
 * MCP action collisions between plugins) belong to the Phase 14
 * generic CLI, which sees every file. Wiring into `plugins:check`
 * arrives in Phase 13.
 *
 * The file maps existing OpenAPI operations to automation
 * presentation. It redefines no HTTP path, schema, authorization, or
 * validation, so the validator never reads those facets: an
 * operationId either exists in the plugin's own fragment or it does
 * not.
 */
import YAML from "yaml";
import {
  AUTOMATION_FILENAME,
  parseAutomationDocument,
  type AutomationDocument,
} from "../../src/automation.ts";
import type { Problem } from "./repo.ts";

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
