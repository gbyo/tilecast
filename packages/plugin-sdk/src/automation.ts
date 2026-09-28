/**
 * The Tilecast plugin automation contract (`automation.yaml`),
 * Automation Contract v1.
 *
 * A plugin maps its existing OpenAPI operations to automation
 * presentation: a CLI path, an MCP action, and a risk class. The file
 * redefines no HTTP path, request schema, response schema,
 * authorization, validation rule, or business logic; it only says how
 * already-supported operations appear to operators.
 *
 * This Zod schema is the source of the portable JSON Schema in
 * `schema/tilecast-automation.schema.json` (Draft 2020-12). The
 * `pluginctl` automation module parses the same file with this schema;
 * the fixtures in `testdata/automation/` keep the two in agreement.
 *
 * Shape lessons from the first handwritten core CLI slice (Phase 11):
 * command paths are short kebab-case segment lists, complex structured
 * input travels as a document (`--input`/`--file`) rather than a growing
 * flag language, and ambiguous names are errors, never guesses.
 */
import { z } from "zod";

/** The automation contract version this SDK implements. */
export const AUTOMATION_API_VERSION = 1;

/**
 * The one durable risk model for CLI paths and MCP actions. Risk
 * annotations describe; the server authorizes. `break-glass` is
 * deliberately absent: local recovery operations never enter
 * automation, so the schema rejects the class outright.
 */
export const automationRiskClasses = [
  "read",
  "routine",
  "sensitive",
  "high-impact",
  "security-critical",
] as const;

export type AutomationRiskClass = (typeof automationRiskClasses)[number];

/** One CLI path segment: short kebab-case, for example `instance`. */
const cliSegment = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,31}$/,
    "must be kebab-case: a lowercase letter followed by lowercase letters, digits, or hyphens",
  );

/** One MCP action name: snake_case, for example `list_instances`. */
const mcpAction = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,47}$/,
    "must be snake_case: a lowercase letter followed by lowercase letters, digits, or underscores",
  );

/**
 * How the generic CLI feeds an operation its input. `fields` means
 * scalar flags; `document` means a JSON document via `--input` or
 * `--file`. Complex structured input always uses `document` rather
 * than growth of the automation language. Read-only operations omit
 * the field.
 */
export const automationInputKinds = ["fields", "document"] as const;

export type AutomationInputKind = (typeof automationInputKinds)[number];

const automationOperation = z
  .object({
    /** An operationId from the plugin's own OpenAPI fragment. */
    operationId: z.string().min(1, "must name an operationId"),
    risk: z.enum(automationRiskClasses),
    /** Human sentence for generated help text. Never shown secrets. */
    description: z.string().min(1).max(280).optional(),
    cli: z.object({
      /** Command path below `tilecast`, for example `[instance, list]`. */
      path: cliSegment.array().min(1).max(4),
    }),
    mcp: z.object({
      /** Semantic action inside the plugin's MCP tool family. */
      action: mcpAction,
    }),
    /** Omitted for read-only operations. */
    input: z.enum(automationInputKinds).optional(),
  })
  .strict();

export type AutomationOperation = z.infer<typeof automationOperation>;

/**
 * An explicit exclusion: an operation that must stay out of
 * automation, with the reason stated. Reasons are free text so new
 * constraints do not require a contract revision; examples are
 * `browser-only-security-ceremony` and `internal-poll-trigger`.
 */
const automationExclusion = z
  .object({
    operationId: z.string().min(1, "must name an operationId"),
    reason: z
      .string()
      .min(8, "must explain why the operation stays out")
      .max(280),
  })
  .strict();

export type AutomationExclusion = z.infer<typeof automationExclusion>;

export const automationDocument = z
  .object({
    apiVersion: z.literal(AUTOMATION_API_VERSION),
    operations: automationOperation.array().min(1),
    exclusions: automationExclusion.array().default([]),
  })
  .strict();

export type AutomationDocument = z.infer<typeof automationDocument>;

export function parseAutomationDocument(value: unknown): AutomationDocument {
  return automationDocument.parse(value);
}

/** The portable Draft 2020-12 JSON Schema generated from the Zod schema. */
export function automationDocumentJSONSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/gbyo/tilecast/packages/plugin-sdk/schema/tilecast-automation.schema.json",
    ...z.toJSONSchema(automationDocument, {
      target: "draft-2020-12",
      io: "input",
    }),
  };
}

/** The fixed filename, relative to the plugin directory. */
export const AUTOMATION_FILENAME = "automation.yaml";
