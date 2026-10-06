/**
 * The Widget manifest (`widgets/<name>/tilecast.widget.json`).
 *
 * One file is the whole public description of a Widget: its catalog entry
 * (the fields the Server's content-definition catalog already understands,
 * at the top level), its first-class component, and how Players that
 * predate the component render it. The Server embeds the same files
 * (widgets/catalog.go), so there is no second registry.
 *
 * This Zod schema is the source of `schema/tilecast-widget.schema.json`.
 * The Server validates the catalog half again with its own rules
 * (apps/server/internal/contentdefs); `widgetctl check` runs both sides'
 * checks that can run without Go.
 */
import { z } from "zod";
import {
  componentCapability,
  COMPONENT_TYPE_PATTERN,
  MAX_COMPONENT_CAPABILITY_LENGTH,
  MAX_COMPONENT_TYPE_LENGTH,
  MAX_COMPONENT_VERSION,
  TAG_NAME_PATTERN,
} from "./identity.ts";

/** Directory names below widgets/. */
export const widgetDirPattern = /^[a-z][a-z0-9-]{0,47}$/;

/** Catalog IDs are persisted as Widget providers. */
export const catalogIdPattern = /^[a-z][a-z0-9_-]{0,79}$/;

/** Limits on the configuration a component presentation carries. */
export const COMPONENT_CONFIG_LIMITS = {
  bytes: 8 * 1024,
  depth: 6,
  keys: 64,
  items: 200,
  stringLength: 2_000,
} as const;

/** Why a JSON value exceeds the component configuration limits, or null. */
export function configLimitProblem(value: unknown): string | null {
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? "";
  } catch {
    return "configuration is not JSON";
  }
  if (encoded.length > COMPONENT_CONFIG_LIMITS.bytes) {
    return `configuration exceeds ${COMPONENT_CONFIG_LIMITS.bytes} bytes`;
  }
  const visit = (node: unknown, depth: number): string | null => {
    if (depth > COMPONENT_CONFIG_LIMITS.depth) {
      return `configuration is deeper than ${COMPONENT_CONFIG_LIMITS.depth}`;
    }
    if (typeof node === "string") {
      return node.length > COMPONENT_CONFIG_LIMITS.stringLength
        ? "configuration contains an oversized string"
        : null;
    }
    if (Array.isArray(node)) {
      if (node.length > COMPONENT_CONFIG_LIMITS.items) {
        return "configuration contains an oversized array";
      }
      for (const item of node) {
        const problem = visit(item, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    if (node && typeof node === "object") {
      const keys = Object.keys(node);
      if (keys.length > COMPONENT_CONFIG_LIMITS.keys) {
        return "configuration contains an oversized object";
      }
      for (const key of keys) {
        const problem = visit(
          (node as Record<string, unknown>)[key],
          depth + 1,
        );
        if (problem) return problem;
      }
    }
    return null;
  };
  return visit(value, 1);
}

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const componentSchema = z
  .object({
    type: z
      .string()
      .max(
        MAX_COMPONENT_TYPE_LENGTH,
        `must fit widget.<type> within ${MAX_COMPONENT_CAPABILITY_LENGTH} characters`,
      )
      .regex(COMPONENT_TYPE_PATTERN, "must be a qualified identity")
      .refine(
        (type) =>
          componentCapability(type).length <= MAX_COMPONENT_CAPABILITY_LENGTH,
        {
          message: `the widget.<type> capability must fit within ${MAX_COMPONENT_CAPABILITY_LENGTH} characters`,
        },
      )
      .describe(
        "Qualified component type; the Player capability is widget.<type>.",
      ),
    version: z.number().int().min(1).max(MAX_COMPONENT_VERSION),
    tagName: z
      .string()
      .regex(TAG_NAME_PATTERN, "must be a custom-element name"),
    entrypoint: z
      .literal("./runtime/index.ts")
      .describe("Module that default-exports defineWidget(...)."),
    configTemplate: z
      .record(z.string(), jsonValue)
      .describe(
        'Compiles the persisted Widget configuration into the component config. Values may be {"$config": key, "default": value, "when": flag}.',
      ),
    dataSourceFields: z
      .array(z.string().min(1).max(80))
      .max(8)
      .optional()
      .describe(
        "Configuration keys that hold Data Source IDs the component may read.",
      ),
    empty: z
      .enum(["render", "skip-eligible"])
      .describe(
        "render: an empty Widget shows its empty presentation. skip-eligible: a later release may skip it in unsynchronized playlists.",
      ),
  })
  .strict();

export const widgetManifestSchema = z
  .object({
    $schema: z.string().optional(),
    apiVersion: z
      .literal(1)
      .describe(
        "Manifest API version: the shape and semantics of tilecast.widget.json.",
      ),
    id: z.string().regex(catalogIdPattern),
    version: z
      .number()
      .int()
      .min(1)
      .describe("Version of the release-owned Widget definition."),
    configVersion: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Version of the persisted Widget configuration; omission keeps legacy version 1.",
      ),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    category: z.string().min(1).max(40),
    icon: z.string().min(1).max(40),
    thumbnail: z.string().max(40).optional(),
    kind: z.enum(["widget", "app"]).optional(),
    featured: z.boolean().optional(),
    keywords: z.array(z.string().max(40)).max(16).optional(),
    runtime: z.literal("native"),
    configurationSchema: z.object({ fields: z.array(jsonValue) }).strict(),
    defaultConfiguration: z.record(z.string(), jsonValue),
    acceptedDataSourceKinds: z.array(z.string()).optional(),
    requiredFieldTypes: z.record(z.string(), z.string()).optional(),
    presentationSchemaVersion: z.literal(1),
    presentationTemplate: jsonValue.optional(),
    requiredCapabilities: z.record(z.string(), z.number().int().min(1)),
    emptyStateBehavior: z.string().min(1),
    legacyEditor: z.boolean().optional(),
    requiresManifestV13: z.boolean().optional(),
    authoring: z
      .object({
        recommendedFrame: z
          .object({
            width: z.number().int().min(120).max(3840),
            height: z.number().int().min(48).max(2160),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional()
      .describe("Studio authoring hints that never change Player rendering."),
    setup: z.record(z.string(), jsonValue).optional(),
    deprecation: z.record(z.string(), jsonValue),
    component: componentSchema,
    compatibility: z
      .object({
        fallback: z
          .enum(["legacy", "template", "none"])
          .describe(
            "How Players without the component render this Widget: the Server's built-in compiler (legacy), presentationTemplate (template), or not at all (none).",
          ),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const { fallback } = manifest.compatibility;
    if (fallback === "legacy" && !manifest.legacyEditor) {
      ctx.addIssue({
        code: "custom",
        path: ["compatibility", "fallback"],
        message: "legacy fallback requires legacyEditor",
      });
    }
    if (
      fallback === "template" &&
      manifest.presentationTemplate === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["compatibility", "fallback"],
        message: "template fallback requires presentationTemplate",
      });
    }
  })
  .describe("Tilecast Widget manifest (tilecast.widget.json), Widgets V2.");

export type WidgetManifestInput = z.input<typeof widgetManifestSchema>;
export type WidgetManifest = z.output<typeof widgetManifestSchema>;

/** The portable Draft 2020-12 JSON Schema generated from the Zod schema. */
export function widgetManifestJSONSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/gbyo/tilecast/packages/widget-sdk/schema/tilecast-widget.schema.json",
    ...z.toJSONSchema(widgetManifestSchema, {
      target: "draft-2020-12",
      io: "input",
      unrepresentable: "any",
    }),
  };
}

/**
 * A deterministic Widget fixture (`widgets/<name>/fixtures/*.json`): a
 * persisted Widget configuration plus the context and prepared resources a
 * story, a test or a visual-regression run renders it with.
 */
export const widgetFixtureSchema = z
  .object({
    $schema: z.string().optional(),
    name: z.string().min(1).max(80),
    description: z.string().max(280).optional(),
    /**
     * The persisted provider when it is a compatibility identity that maps
     * into this Widget (for example `date` into Clock). The fixture then
     * compiles with that provider's configTemplate from the release
     * catalog. Absent means the module's own provider.
     */
    provider: z.string().regex(catalogIdPattern).optional(),
    /** The persisted Widget configuration, before configTemplate. */
    configuration: z.record(z.string(), jsonValue),
    /**
     * The exact component configuration the persisted configuration must
     * compile to. The TypeScript and Go compilers both assert it.
     */
    expectConfig: z.record(z.string(), jsonValue).optional(),
    context: z
      .object({
        now: z.iso.datetime({ offset: true }).optional(),
        timeZone: z.string().max(64).optional(),
        locale: z.string().max(35).optional(),
        hourCycle: z.enum(["locale", "h12", "h23"]).optional(),
        reducedMotion: z.boolean().optional(),
        theme: z
          .object({
            background: z.string().optional(),
            foreground: z.string().optional(),
            accent: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /** Prepared Data Documents keyed by Data Source ID. */
    documents: z.record(z.string(), jsonValue).optional(),
    /** Fixture media aliases keyed by `${assetId}/${variantId}`. */
    media: z.record(z.string(), z.string()).optional(),
    /** The state the Widget must settle in. */
    expect: z.enum(["ready", "empty", "error"]),
  })
  .strict();

export type WidgetFixture = z.output<typeof widgetFixtureSchema>;

/**
 * Compile a persisted configuration with a component's configTemplate. The
 * Server implements the same closed rules (playlists/component.go); the
 * fixtures in widgets/<name>/fixtures keep the two in agreement.
 */
function isConfigFlagOn(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "";
  if (typeof value === "number") return value !== 0;
  return true;
}

export function compileComponentConfig(
  template: Readonly<Record<string, unknown>>,
  configuration: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (typeof node["$config"] === "string") {
        const key = node["$config"];
        // A "when" gate keeps legacy toggles meaningful in projections: a
        // falsy gate resolves the default instead of the mapped value.
        if (typeof node["when"] === "string" && node["when"] !== "") {
          const flag = node["when"];
          if (
            Object.hasOwn(configuration, flag) &&
            !isConfigFlagOn(configuration[flag])
          ) {
            if (Object.hasOwn(node, "default")) return resolve(node["default"]);
            return "";
          }
        }
        if (Object.hasOwn(configuration, key)) return configuration[key];
        if (Object.hasOwn(node, "default")) {
          // A default may itself reference configuration, so a
          // compatibility definition can prefer its current keys and fall
          // back to the legacy keys it supersedes.
          return resolve(node["default"]);
        }
        throw new Error(
          `configTemplate references missing configuration ${key}`,
        );
      }
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node)) out[key] = resolve(item);
      return out;
    }
    return value;
  };
  return resolve(template) as Record<string, unknown>;
}
