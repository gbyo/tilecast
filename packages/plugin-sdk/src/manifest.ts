/**
 * The Tilecast plugin manifest (`tilecast.plugin.json`), Plugin API v1.
 *
 * This Zod schema is the source of the portable JSON Schema in
 * `schema/tilecast-plugin.schema.json` (Draft 2020-12). The Go SDK parses the
 * same file with its own validator; the fixtures in `testdata/manifests/`
 * keep the two in agreement.
 *
 * A manifest is data. It never names code to download: every entry point is a
 * path inside the plugin's own directory, compiled into the Tilecast release.
 */
import { z } from "zod";

/** The Tilecast Plugin API this SDK implements. */
export const PLUGIN_API_VERSION = 1;

/** Plugin API versions this release can load. */
export const SUPPORTED_PLUGIN_API_VERSIONS = [1] as const;

export const pluginIdPattern = /^[a-z][a-z0-9_]{0,79}$/;

/**
 * A GitHub-style handle: `@user` or `@org/team`. Maintainers are stewards,
 * not owners; the handle does not need repository access to be valid here.
 */
export const maintainerPattern =
  /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;

/**
 * A path inside the plugin directory, written `./relative/path`. Every
 * segment starts with a letter, digit, underscore, or hyphen, so `..`, `.`,
 * and empty segments cannot appear and the path cannot leave the plugin.
 */
const pluginPath = z
  .string()
  .regex(
    /^\.(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/,
    "must be a ./relative path inside the plugin directory",
  );

export const pluginCategories = [
  "Display",
  "Automation",
  "Workflow",
  "Hardware",
] as const;

export const requirementKinds = [
  "platform",
  "hardware",
  "region",
  "network",
  "provider",
  "player",
] as const;

/**
 * Where a runtime plugin may draw. The runtime host owns the geometry of each
 * slot; a plugin only fills the element the host gives it.
 */
export const surfaceSlots = [
  "strip.top",
  "strip.bottom",
  "corner.top-left",
  "corner.top-right",
  "corner.bottom-left",
  "corner.bottom-right",
  "overlay",
] as const;

/**
 * Entry points are conventional, not configurable. The Go registry generator,
 * Studio, and the Player runtime each find plugin code by these fixed paths
 * (Vite `import.meta.glob` is convention-based), so a manifest may only name
 * the path the build actually discovers.
 */
export const conventionalEntrypoints = {
  server: "./plugin.go",
  studio: "./studio/index.tsx",
  runtime: "./runtime/index.ts",
} as const;

/** Docs site sidebar groups a plugin page may be listed in. */
export const docsSidebarGroups = ["plugins", "review-and-collect"] as const;

/** Player hardware a plugin may use. The host decides whether it exists. */
export const hardwareCapabilities = ["microphone"] as const;

const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "must be a lowercase DNS hostname",
  );

const text = (max: number) =>
  z.string().trim().min(1).max(max).regex(/\S/, "must not be blank");

export const pluginManifestSchema = z
  .strictObject({
    $schema: z.string().optional(),
    apiVersion: z
      .literal(PLUGIN_API_VERSION)
      .describe(
        "Version of the Tilecast Plugin API the plugin is written for.",
      ),
    id: z
      .string()
      .regex(pluginIdPattern)
      .describe(
        "Stable identifier. It is stored in plugin_installations and must never change.",
      ),
    definitionVersion: z
      .int()
      .min(1)
      .describe(
        "Version of this plugin's persisted and Player-facing definition. Recorded in the install and remove audit events.",
      ),
    name: text(80),
    description: text(280),
    category: z.enum(pluginCategories),
    icon: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,39}$/)
      .describe(
        "Bounded icon identifier. Studio falls back to a generic icon.",
      ),
    maintainers: z
      .array(z.string().regex(maintainerPattern))
      .min(1)
      .describe(
        "Subject-matter stewards. Eligible handles are requested for review through the generated CODEOWNERS file.",
      ),
    installable: z.boolean().default(true),
    instanceNoun: z.strictObject({ singular: text(40), plural: text(40) }),
    requirements: z
      .array(
        z.strictObject({
          kind: z.enum(requirementKinds),
          label: text(80),
          description: text(280).optional(),
        }),
      )
      .default([])
      .describe(
        "Advice shown before installation. Requirements are never evaluated.",
      ),
    uses: z
      .array(text(80))
      .default([])
      .describe(
        "What the plugin uses, as shown in the catalog (the catalog API field `capabilities`).",
      ),
    capabilities: z
      .strictObject({
        playerManifest: z
          .boolean()
          .default(false)
          .describe(
            "Contributes entries to the authenticated Player manifest.",
          ),
        backgroundWorkers: z.boolean().default(false),
        network: z
          .array(hostname)
          .default([])
          .describe("Hosts Tilecast Server contacts for this plugin."),
        hardware: z.array(z.enum(hardwareCapabilities)).default([]),
        heartbeat: z
          .array(z.string().regex(/^[a-z][A-Za-z0-9]{0,39}$/))
          .default([])
          .describe("Optional Player heartbeat sections this plugin consumes."),
      })
      .default({
        playerManifest: false,
        backgroundWorkers: false,
        network: [],
        hardware: [],
        heartbeat: [],
      }),
    server: z
      .strictObject({
        entrypoint: z
          .literal(conventionalEntrypoints.server)
          .describe(
            "Go file that declares the plugin package and its New constructor. Always ./plugin.go.",
          ),
      })
      .optional(),
    migrations: pluginPath
      .optional()
      .describe(
        "Directory of Goose SQL files. Versions share the one global Tilecast sequence.",
      ),
    api: z
      .strictObject({
        basePaths: z
          .array(
            z.string().regex(/^\/[a-z0-9][a-z0-9/-]{0,119}$/, "must be /path"),
          )
          .min(1)
          .describe(
            "Route prefixes below /api/v1 that the plugin may register.",
          ),
        openapi: pluginPath.optional(),
      })
      .optional(),
    studio: z
      .strictObject({
        route: z
          .string()
          .regex(/^\/[a-z0-9][a-z0-9/-]{0,119}$/)
          .describe("The Studio route that manages the plugin."),
        entrypoint: z
          .literal(conventionalEntrypoints.studio)
          .describe(
            "Studio module that default-exports defineStudioPlugin. Always ./studio/index.tsx.",
          ),
      })
      .optional(),
    runtime: z
      .strictObject({
        entrypoint: z
          .literal(conventionalEntrypoints.runtime)
          .describe(
            "Shared Player runtime module that renders the manifest types. Always ./runtime/index.ts.",
          ),
        manifestTypes: z
          .array(z.string().regex(pluginIdPattern))
          .min(1)
          .describe("Player manifest plugin entry types this runtime renders."),
        surfaces: z.array(z.enum(surfaceSlots)).default([]),
      })
      .optional(),
    docs: z
      .strictObject({
        reference: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Engineering reference, published as the catalog documentation link.",
          ),
        pages: z
          .array(
            z.strictObject({
              source: pluginPath,
              slug: z
                .string()
                .regex(/^[a-z0-9][a-z0-9/-]{0,119}$/)
                .describe(
                  "Public docs site slug, for example operations/plugins/countdown-bar.",
                ),
              label: text(80).optional(),
              sidebar: z
                .strictObject({
                  group: z
                    .enum(docsSidebarGroups)
                    .default("plugins")
                    .describe("Docs site sidebar group the page is listed in."),
                  badge: text(12).optional(),
                })
                .optional(),
            }),
          )
          .default([]),
      })
      .optional(),
  })
  .describe("Tilecast plugin manifest (tilecast.plugin.json), Plugin API v1.");

export type PluginManifestInput = z.input<typeof pluginManifestSchema>;
export type PluginManifest = z.output<typeof pluginManifestSchema>;

export function parsePluginManifest(value: unknown): PluginManifest {
  return pluginManifestSchema.parse(value);
}

/** The portable Draft 2020-12 JSON Schema generated from the Zod schema. */
export function pluginManifestJSONSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/gbyo/tilecast/packages/plugin-sdk/schema/tilecast-plugin.schema.json",
    ...z.toJSONSchema(pluginManifestSchema, {
      target: "draft-2020-12",
      io: "input",
    }),
  };
}
