/**
 * The Tilecast plugin manifest (`tilecast.plugin.json`), Plugin API v1 and v2.
 *
 * Plugin API v1 is frozen: its `runtime` member describes surface-only Player
 * behavior. Plugin API v2 describes a plugin by independent contributions:
 * Server and Studio exactly as in v1, and an optional `player` contribution
 * whose Shared Runtime and native parts request versioned Player services.
 * A surface is one of those services, not what defines a plugin.
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
import {
  parseServiceReference,
  serviceReferencePattern,
  serviceReferenceProblem,
  type PlayerServiceExecution,
} from "./services.ts";

/** The newest Tilecast Plugin API this SDK implements. */
export const PLUGIN_API_VERSION = 2;

/** Plugin API versions this release can load. */
export const SUPPORTED_PLUGIN_API_VERSIONS = [1, 2] as const;

export const pluginIdPattern = /^[a-z][a-z0-9_]{0,79}$/;

/** A contribution identifier inside one plugin, for example `ticker`. */
export const contributionIdPattern = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Player manifest entry types that the host itself owns. No plugin may use
 * them as a v1 manifest type or a v2 state type.
 */
export const reservedPlayerEntryTypes = [
  "plugin_state",
  "external_plugin",
] as const;

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
 * Runtime arbitration tiers, strongest first. A plugin declares one tier for
 * all of its surfaces; the host compares tiers before any claimed priority,
 * so no configuration can lift a plugin above a stronger tier.
 */
export const surfaceTiers = [
  "emergency",
  "live",
  "scheduled",
  "ambient",
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

const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "must be a lowercase DNS hostname",
  );

const text = (max: number) =>
  z.string().trim().min(1).max(max).regex(/\S/, "must not be blank");

/** Members every Plugin API version shares: identity, catalog, Server, Studio, and docs. */
const sharedMembers = {
  $schema: z.string().optional(),
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
    .describe("Bounded icon identifier. Studio falls back to a generic icon."),
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
        .describe("Route prefixes below /api/v1 that the plugin may register."),
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
      additionalRoutes: z
        .array(
          z.string().regex(/^\/[a-z0-9][a-z0-9/-]{0,119}$/, "must be /path"),
        )
        .optional()
        .describe(
          "Absolute Studio routes outside /plugins/<id> the plugin owns, such as a portal or inbox. Each must mount through the definition's standaloneRoutes.",
        ),
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
};

const v1Members = {
  apiVersion: z
    .literal(1)
    .describe("Version of the Tilecast Plugin API the plugin is written for."),
  capabilities: z
    .strictObject({
      playerManifest: z
        .boolean()
        .default(false)
        .describe("Contributes entries to the authenticated Player manifest."),
      backgroundWorkers: z.boolean().default(false),
      network: z
        .array(hostname)
        .default([])
        .describe("Hosts Tilecast Server contacts for this plugin."),
    })
    .default({
      playerManifest: false,
      backgroundWorkers: false,
      network: [],
    }),
  runtime: z
    .strictObject({
      entrypoint: z
        .literal(conventionalEntrypoints.runtime)
        .optional()
        .describe(
          "Shared Player runtime module that renders the manifest types. Always ./runtime/index.ts; omitted when only native Players render them.",
        ),
      manifestTypes: z
        .array(z.string().regex(pluginIdPattern))
        .min(1)
        .describe("Player manifest plugin entry types this runtime renders."),
      surfaces: z.array(z.enum(surfaceSlots)).default([]),
      tier: z
        .enum(surfaceTiers)
        .describe(
          "Arbitration tier of the plugin's surfaces: emergency, live, scheduled, or ambient. Declared once; a claim cannot choose its own tier.",
        ),
    })
    .optional(),
};

/**
 * One visual contribution that uses `player.surface@1`. The tier belongs to
 * the contribution, not to the whole plugin, and a claim can never name or
 * raise it.
 */
const surfaceContribution = z.strictObject({
  id: z
    .string()
    .regex(contributionIdPattern)
    .describe("Contribution identifier, unique within the plugin."),
  slots: z
    .array(z.enum(surfaceSlots))
    .min(1)
    .max(surfaceSlots.length)
    .describe("Slots this contribution may claim."),
  tier: z
    .enum(surfaceTiers)
    .describe(
      "Arbitration tier of this contribution's claims. Reviewed here; a claim cannot choose it.",
    ),
});

const serviceRequests = z
  .strictObject({
    required: z
      .array(z.string().regex(serviceReferencePattern))
      .max(16)
      .default([])
      .describe(
        "Services the contribution cannot run without. A Player that lacks one does not activate the contribution.",
      ),
    optional: z
      .array(z.string().regex(serviceReferencePattern))
      .max(16)
      .default([])
      .describe(
        "Enhancements. The contribution runs without them and receives null.",
      ),
  })
  .default({ required: [], optional: [] });

const playerContribution = z
  .strictObject({
    state: z
      .array(
        z.strictObject({
          type: z
            .string()
            .regex(pluginIdPattern)
            .describe("Player state type, unique across every plugin."),
          version: z.int().min(1).max(1000),
        }),
      )
      .min(1)
      .max(16)
      .describe(
        "Player state the Server projects and the Player consumes. A Player contribution activates while state for it exists.",
      ),
    runtime: z
      .strictObject({
        entrypoint: z
          .literal(conventionalEntrypoints.runtime)
          .describe(
            "Shared Player Runtime module that default-exports definePlayerPlugin. Always ./runtime/index.ts.",
          ),
        services: serviceRequests,
        surfaces: z
          .array(surfaceContribution)
          .max(8)
          .default([])
          .describe(
            "Visual contributions for player.surface@1. Empty for a plugin that draws nothing.",
          ),
      })
      .optional()
      .describe("Portable Player behavior in the Shared Runtime."),
    native: z
      .array(
        z.strictObject({
          id: z.string().regex(contributionIdPattern),
          services: serviceRequests,
        }),
      )
      .max(8)
      .default([])
      .describe(
        "First-party native contributions compiled into Player builds. Platforms register them through typed Player Core interfaces.",
      ),
  })
  .describe(
    "Player contribution. Omit it for a plugin that has no Player behavior.",
  );

const v2Members = {
  apiVersion: z
    .literal(2)
    .describe("Version of the Tilecast Plugin API the plugin is written for."),
  capabilities: z
    .strictObject({
      backgroundWorkers: z.boolean().default(false),
      network: z
        .array(hostname)
        .default([])
        .describe("Hosts Tilecast Server contacts for this plugin."),
    })
    .default({ backgroundWorkers: false, network: [] })
    .describe(
      "Server declarations. Player state is declared by the player contribution, not by a flag.",
    ),
  player: playerContribution.optional(),
};

export const pluginManifestV1Schema = z
  .strictObject({ ...sharedMembers, ...v1Members })
  .describe("Tilecast plugin manifest (tilecast.plugin.json), Plugin API v1.");

export const pluginManifestV2Schema = z
  .strictObject({ ...sharedMembers, ...v2Members })
  .describe(
    "Tilecast plugin manifest (tilecast.plugin.json), Plugin API v2: independent Server, Studio, and Player contributions.",
  );

export const pluginManifestSchema = z
  .discriminatedUnion("apiVersion", [
    pluginManifestV1Schema,
    pluginManifestV2Schema,
  ])
  .superRefine((manifest, context) => {
    if (manifest.apiVersion !== 2) return;
    for (const message of playerContributionProblems(manifest.player)) {
      context.addIssue({ code: "custom", path: ["player"], message });
    }
  })
  .describe("Tilecast plugin manifest (tilecast.plugin.json).");

export type PluginManifestInput = z.input<typeof pluginManifestSchema>;
export type PluginManifest = z.output<typeof pluginManifestSchema>;

export function parsePluginManifest(value: unknown): PluginManifest {
  return pluginManifestSchema.parse(value);
}

export type PluginManifestV1 = Extract<PluginManifest, { apiVersion: 1 }>;
export type PluginManifestV2 = Extract<PluginManifest, { apiVersion: 2 }>;
export type PlayerContribution = NonNullable<PluginManifestV2["player"]>;
export type SurfaceContribution = NonNullable<
  PlayerContribution["runtime"]
>["surfaces"][number];

type PlayerInput = z.input<typeof playerContribution>;

/**
 * Cross-field rules of a v2 Player contribution that a JSON Schema cannot
 * state. The Go SDK applies the same rules; the `invalid-semantic` fixtures
 * keep them in agreement.
 */
export function playerContributionProblems(
  player: PlayerInput | undefined,
): string[] {
  if (!player) return [];
  const problems: string[] = [];
  const native = player.native ?? [];
  if (!player.runtime && native.length === 0) {
    problems.push(
      "a player contribution needs a runtime entrypoint or a native contribution",
    );
  }
  const states = new Set<string>();
  for (const state of player.state) {
    const key = `${state.type}@${state.version}`;
    if (states.has(key)) problems.push(`state ${key} is declared twice`);
    states.add(key);
    if ((reservedPlayerEntryTypes as readonly string[]).includes(state.type))
      problems.push(`state type ${state.type} is reserved`);
  }
  const checkServices = (
    where: string,
    execution: PlayerServiceExecution,
    services: { required?: string[]; optional?: string[] } | undefined,
  ): Set<string> => {
    const names = new Set<string>();
    for (const value of [
      ...(services?.required ?? []),
      ...(services?.optional ?? []),
    ]) {
      const problem = serviceReferenceProblem(value, execution);
      if (problem) problems.push(`${where}: ${problem}`);
      const name = parseServiceReference(value)?.name ?? value;
      if (names.has(name))
        problems.push(`${where}: ${name} is requested more than once`);
      names.add(name);
    }
    return names;
  };
  if (player.runtime) {
    const names = checkServices("runtime", "runtime", player.runtime.services);
    const surfaces = player.runtime.surfaces ?? [];
    if (surfaces.length > 0 && !names.has("player.surface")) {
      problems.push(
        "runtime: surfaces are declared without requesting player.surface",
      );
    }
    if (names.has("player.surface") && surfaces.length === 0) {
      problems.push(
        "runtime: player.surface is requested without declaring surfaces",
      );
    }
    const ids = new Set<string>();
    for (const surface of surfaces) {
      if (ids.has(surface.id))
        problems.push(`runtime: surface ${surface.id} is declared twice`);
      ids.add(surface.id);
      if (new Set(surface.slots).size !== surface.slots.length)
        problems.push(`runtime: surface ${surface.id} repeats a slot`);
    }
  }
  const nativeIds = new Set<string>();
  for (const contribution of native) {
    if (nativeIds.has(contribution.id))
      problems.push(`native contribution ${contribution.id} is declared twice`);
    nativeIds.add(contribution.id);
    checkServices(`native ${contribution.id}`, "native", contribution.services);
  }
  return problems;
}

/**
 * Player manifest entry types the plugin owns: v1 `runtime.manifestTypes`,
 * or v2 `player.state` types. One namespace across every plugin.
 */
export function playerEntryTypes(manifest: PluginManifest): string[] {
  if (manifest.apiVersion === 1)
    return [...(manifest.runtime?.manifestTypes ?? [])];
  return [
    ...new Set((manifest.player?.state ?? []).map((state) => state.type)),
  ];
}

/** Whether the Server projects Player manifest data for this plugin. */
export function isPlayerFacing(manifest: PluginManifest): boolean {
  return manifest.apiVersion === 1
    ? manifest.capabilities.playerManifest
    : manifest.player !== undefined;
}

/** The Shared Runtime entry point the manifest declares, if any. */
export function runtimeEntrypoint(
  manifest: PluginManifest,
): string | undefined {
  return manifest.apiVersion === 1
    ? manifest.runtime?.entrypoint
    : manifest.player?.runtime?.entrypoint;
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
