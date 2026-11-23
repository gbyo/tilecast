/**
 * The Tilecast plugin manifest (`tilecast.plugin.json`): Plugin API v1 and
 * v2, and Plugin Manifest API 3.
 *
 * Plugin API v1 is frozen: its `runtime` member describes surface-only Player
 * behavior. Plugin API v2 describes a plugin by independent contributions:
 * Server and Studio exactly as in v1, and an optional `player` contribution
 * whose Shared Runtime and native parts request versioned Player services.
 * A surface is one of those services, not what defines a plugin. Plugin
 * Manifest API 3 keeps the v2 Player contribution and adds host-owned
 * settings and instance kinds described with `@tilecast/config-schema`, the
 * Server services the plugin's typed Go client calls, and host-owned
 * outbound connections.
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
  configFieldSchema,
  configSchemaProblems,
  type ConfigField,
} from "@tilecast/config-schema";
import serverServices from "../server-services.json" with { type: "json" };
import {
  connectionProblems,
  MAX_CONNECTION_ORIGINS,
  MAX_CONNECTIONS,
  MAX_MAX_RESPONSE_BYTES,
  MAX_ORIGIN_LENGTH,
  MAX_TIMEOUT_SECONDS,
  MIN_MAX_RESPONSE_BYTES,
  OPERATOR_ORIGIN,
} from "./connections.ts";
import {
  parseServiceReference,
  serviceReferencePattern,
  serviceReferenceProblem,
  type PlayerServiceExecution,
} from "./services.ts";

/** The newest Tilecast Plugin API this SDK implements. */
export const PLUGIN_API_VERSION = 3;

/** Plugin API versions this release can load. */
export const SUPPORTED_PLUGIN_API_VERSIONS = [1, 2, 3] as const;

/**
 * The most instance kinds one plugin may declare. Studio renders each kind
 * as one tab of the plugin's page; four is the most tabs Studio already
 * shows in one tab list (the Widget inspector's sections), and it fits a
 * phone-width page without a scrolling tab list.
 */
export const MAX_INSTANCE_KINDS = 4;
/** The most fields of one settings scope or instance kind. */
export const MAX_SCHEMA_FIELDS = 64;
/** The most Server services one plugin declares. */
export const MAX_SERVICE_DECLARATIONS = 16;

/** Host members of an instance document. A kind's field cannot use one as its key. */
export const reservedInstanceKeys = [
  "id",
  "kind",
  "plugin",
  "name",
  "enabled",
  "priority",
  "targetScope",
  "targetIds",
  "schedule",
  "revision",
  "expectedRevision",
  "secrets",
  "clearSecrets",
  "createdAt",
  "updatedAt",
  "createdBy",
] as const;

const reservedKindPaths = [
  "settings",
  "secrets",
  "status",
  "install",
  "kinds",
  "connections",
];

/** Server services a bundled API 3 plugin may declare, from the registry. */
export const bundledServerServices: readonly {
  id: string;
  version: number;
  name: string;
}[] = serverServices.capabilities;

export const pluginIdPattern = /^[a-z][a-z0-9_]{0,79}$/;

/** A contribution identifier inside one plugin, for example `ticker`. */
export const contributionIdPattern = /^[a-z][a-z0-9-]{0,39}$/;

/** A Player plugin event name inside one plugin, for example `button_pressed`. */
export const eventNamePattern = /^[a-z][a-z0-9_]{0,63}$/;

const EVENTS_SERVICE = "player.events";
const PROVIDE_SERVICE = "player.presentation.provide";

/** Which side of a plugin raises an event. The other side receives it. */
export const eventSources = ["native", "runtime"] as const;

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
        providers: z
          .array(
            z.strictObject({
              id: z
                .string()
                .regex(contributionIdPattern)
                .describe(
                  "Presentation provider identifier, unique within the plugin. An external presentation names it as `<plugin id>/<provider id>`.",
                ),
            }),
          )
          .max(4)
          .default([])
          .describe(
            "Presentation providers for player.presentation.provide@1. Empty for a plugin that provides none.",
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
    v1ManifestTypes: z
      .array(z.string().regex(pluginIdPattern))
      .max(8)
      .default([])
      .describe(
        "Plugin API 1 manifest entry types the plugin still projects for Players that do not host Plugin API 2. Its Shared Runtime contribution also consumes them, so one implementation serves every Player.",
      ),
    events: z
      .array(
        z.strictObject({
          name: z
            .string()
            .regex(eventNamePattern)
            .describe("Event name, unique within the plugin."),
          version: z.int().min(1).max(1000),
          source: z
            .enum(eventSources)
            .describe(
              "Which part raises the event. The other part receives it: a native source reaches the Shared Runtime part, and a runtime source reaches the native part.",
            ),
        }),
      )
      .max(16)
      .default([])
      .describe(
        "Ephemeral, typed events between the plugin's native and Shared Runtime parts. State stays in player.state; events never carry configuration.",
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

const pluginFields = z
  .array(configFieldSchema("plugin"))
  .max(MAX_SCHEMA_FIELDS)
  .default([]);

const instanceKind = z.strictObject({
  kind: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .describe("Identifier stored with every instance. It never changes."),
  noun: z.strictObject({ singular: text(40), plural: text(40) }),
  path: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .describe(
      "URL segment below the plugin's API base path and Studio route, for example instances.",
    ),
  operations: z
    .strictObject({
      singular: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
      plural: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
    })
    .describe(
      "Names of the generated operations: list<Plural>, get<Singular>, create<Singular>, update<Singular>, delete<Singular>.",
    ),
  targeting: z
    .enum(["screens", "none"])
    .describe(
      "screens: the host projects the instance to its target screens. none: the instance is never projected.",
    ),
  schedule: z
    .enum(["none", "window", "weekly"])
    .describe(
      "When the host projects the instance. A domain calendar stays plugin data.",
    ),
  priority: z
    .strictObject({
      minimum: z.int().min(-1000000).max(1000000),
      maximum: z.int().min(-1000000).max(1000000),
      default: z.int().min(-1000000).max(1000000),
    })
    .optional()
    .describe("Gives each instance a priority. The host projects the strongest first."),
  fields: pluginFields,
});

const networkRule = z.enum(["refused", "allowed"]);

const connectionDeclaration = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .describe("Identifier that connection records and connection fields name. It never changes."),
  title: text(80),
  description: text(280).optional(),
  type: z
    .enum(["http"])
    .describe("http: requests through http.fetch@1."),
  origins: z
    .union([
      z.literal(OPERATOR_ORIGIN),
      z
        .array(z.string().min(1).max(MAX_ORIGIN_LENGTH))
        .min(1)
        .max(MAX_CONNECTION_ORIGINS),
    ])
    .describe(
      'A fixed list of canonical https origins (scheme, host, and port), or "operator": an Owner or Administrator enters one origin in Studio.',
    ),
  privateNetwork: networkRule
    .optional()
    .describe(
      "allowed makes private addresses possible after a separate operator consent. Loopback and link-local addresses are never reached.",
    ),
  plainHttp: networkRule
    .optional()
    .describe(
      'allowed makes an operator-entered http origin on private addresses possible after its own consent. Needs origins "operator" and privateNetwork "allowed".',
    ),
  allowPlaintextSecret: z
    .boolean()
    .optional()
    .describe(
      "Lets a secret header travel over plain HTTP after a third consent. Needs plainHttp allowed.",
    ),
  maxResponseBytes: z
    .int()
    .min(MIN_MAX_RESPONSE_BYTES)
    .max(MAX_MAX_RESPONSE_BYTES)
    .optional()
    .describe("Response body bound. Default 1 MiB, at most 16 MiB. The install review shows a larger value."),
  timeoutSeconds: z
    .int()
    .min(1)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe("Time bound of one request, redirects and body included. Default 10 seconds."),
});

const v3Members = {
  apiVersion: z
    .literal(3)
    .describe("Version of the Tilecast Plugin API the plugin is written for."),
  capabilities: z
    .strictObject({ backgroundWorkers: z.boolean().default(false) })
    .default({ backgroundWorkers: false })
    .describe(
      "Server declarations. Outbound access is declared with connections.",
    ),
  studio: z
    .strictObject({
      route: z
        .string()
        .regex(/^\/[a-z0-9][a-z0-9/-]{0,119}$/)
        .describe("The Studio route that manages the plugin and holds its generated pages."),
      entrypoint: z
        .literal(conventionalEntrypoints.studio)
        .optional()
        .describe(
          "Optional Studio module. Omit it when the host's generated pages are all the plugin needs.",
        ),
      additionalRoutes: z
        .array(z.string().regex(/^\/[a-z0-9][a-z0-9/-]{0,119}$/, "must be /path"))
        .optional(),
    })
    .optional(),
  player: playerContribution.optional(),
  services: z
    .array(z.string().regex(serviceReferencePattern))
    .max(MAX_SERVICE_DECLARATIONS)
    .default([])
    .describe(
      "Server services (name@version) the plugin's typed Go client calls. The registry decides which a bundled plugin may declare.",
    ),
  settings: z
    .strictObject({ organization: pluginFields, screen: pluginFields })
    .optional()
    .describe(
      "Host-owned settings. The organization scope holds one value for each field; the screen scope holds one for each field and screen.",
    ),
  instances: z
    .array(instanceKind)
    .max(MAX_INSTANCE_KINDS)
    .default([])
    .describe("Host-owned instance kinds."),
  connections: z
    .array(connectionDeclaration)
    .max(MAX_CONNECTIONS)
    .default([])
    .describe(
      "Host-owned outbound connections. Plugin code names a connection record and never states an origin, an address rule, or a credential.",
    ),
};

export const pluginManifestV1Schema = z
  .strictObject({ ...sharedMembers, ...v1Members })
  .describe("Tilecast plugin manifest (tilecast.plugin.json), Plugin API v1.");

export const pluginManifestV2Schema = z
  .strictObject({ ...sharedMembers, ...v2Members })
  .describe(
    "Tilecast plugin manifest (tilecast.plugin.json), Plugin API v2: independent Server, Studio, and Player contributions.",
  );

export const pluginManifestV3Schema = z
  .strictObject({ ...sharedMembers, ...v3Members })
  .describe(
    "Tilecast plugin manifest (tilecast.plugin.json), Plugin Manifest API 3: host-owned settings and instances beside the v2 contributions.",
  );

export const pluginManifestSchema = z
  .discriminatedUnion("apiVersion", [
    pluginManifestV1Schema,
    pluginManifestV2Schema,
    pluginManifestV3Schema,
  ])
  .superRefine((manifest, context) => {
    if (manifest.apiVersion === 1) return;
    for (const message of playerContributionProblems(manifest.player)) {
      context.addIssue({ code: "custom", path: ["player"], message });
    }
    if (manifest.apiVersion === 3) {
      for (const message of manifestV3Problems(manifest)) {
        context.addIssue({ code: "custom", message });
      }
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
export type PluginManifestV3 = Extract<PluginManifest, { apiVersion: 3 }>;
export type InstanceKind = PluginManifestV3["instances"][number];
export type ConnectionDeclaration = PluginManifestV3["connections"][number];

/** Problems of one API 3 field list beyond the shared schema rules. */
export function pluginFieldProblems(
  where: string,
  fields: readonly ConfigField[],
): string[] {
  const problems = configSchemaProblems(fields, "plugin").map(
    (problem) => `${where}: ${problem}`,
  );
  const walk = (fields: readonly ConfigField[]) => {
    for (const field of fields) {
      if (field.personal && field.required)
        problems.push(
          `${where} field "${field.key}" is personal and required; a personal value must be removable when its retention ends`,
        );
      if (field.control === "data_source" || field.control === "data_source_field")
        problems.push(
          `${where} field "${field.key}" uses a Data Source control, which plugin settings do not support yet`,
        );
      if (field.control === "repeating_group") {
        if ((field.itemFields ?? []).some((item) => item.personal))
          problems.push(
            `${where} field "${field.key}" holds a personal field; personal fields are top-level until per-record retention exists`,
          );
        walk(field.itemFields ?? []);
      }
    }
  };
  walk(fields);
  return problems;
}

/**
 * Cross-field rules of a Plugin Manifest API 3 manifest. The Go SDK applies
 * the same rules; the v3 fixtures keep them in agreement.
 */
export function manifestV3Problems(
  manifest: z.input<typeof pluginManifestV3Schema>,
): string[] {
  const problems: string[] = [];
  const declared = new Set<string>();
  for (const value of manifest.services ?? []) {
    const reference = parseServiceReference(value);
    if (!reference) continue;
    if (declared.has(reference.name))
      problems.push(`service ${reference.name} is declared twice`);
    declared.add(reference.name);
    if (
      !bundledServerServices.some(
        (service) =>
          service.id === reference.name && service.version === reference.version,
      )
    )
      problems.push(
        `service ${value} is not a Server service a bundled plugin can call`,
      );
  }
  problems.push(
    ...pluginFieldProblems(
      "settings.organization",
      (manifest.settings?.organization ?? []) as ConfigField[],
    ),
    ...pluginFieldProblems(
      "settings.screen",
      (manifest.settings?.screen ?? []) as ConfigField[],
    ),
  );
  const kinds = new Set<string>();
  const paths = new Set<string>();
  const operations = new Set<string>();
  for (const kind of manifest.instances ?? []) {
    if (kinds.has(kind.kind)) problems.push(`instance kind "${kind.kind}" is declared twice`);
    kinds.add(kind.kind);
    if (reservedKindPaths.includes(kind.path))
      problems.push(`instance kind "${kind.kind}" has a reserved path "${kind.path}"`);
    if (paths.has(kind.path)) problems.push(`instance path "${kind.path}" is declared twice`);
    paths.add(kind.path);
    const { singular, plural } = kind.operations;
    if (singular === plural || operations.has(singular) || operations.has(plural))
      problems.push(`instance kind "${kind.kind}" repeats an operation name`);
    operations.add(singular);
    operations.add(plural);
    if ((kind.schedule ?? "none") !== "none" && kind.targeting !== "screens")
      problems.push(
        `instance kind "${kind.kind}" has a ${kind.schedule} schedule but no screen targeting; the host schedules only what it projects`,
      );
    const priority = kind.priority;
    if (
      priority &&
      (priority.minimum > priority.default || priority.default > priority.maximum)
    )
      problems.push(`instance kind "${kind.kind}" has an invalid priority range`);
    const fields = (kind.fields ?? []) as ConfigField[];
    problems.push(...pluginFieldProblems(`instances.${kind.kind}`, fields));
    for (const field of fields)
      if ((reservedInstanceKeys as readonly string[]).includes(field.key))
        problems.push(
          `instance kind "${kind.kind}" field "${field.key}" uses a key the host owns`,
        );
  }
  const connections = new Set<string>();
  for (const connection of manifest.connections ?? []) {
    if (connections.has(connection.id))
      problems.push(`connection "${connection.id}" is declared twice`);
    connections.add(connection.id);
    problems.push(...connectionProblems(connection));
  }
  const checkConnectionFields = (where: string, fields: readonly ConfigField[]) => {
    for (const field of fields)
      if (field.control === "connection")
        for (const id of field.connections ?? [])
          if (!connections.has(id))
            problems.push(
              `${where} field "${field.key}" accepts connection "${id}", which the manifest does not declare`,
            );
  };
  checkConnectionFields(
    "settings.organization",
    (manifest.settings?.organization ?? []) as ConfigField[],
  );
  checkConnectionFields("settings.screen", (manifest.settings?.screen ?? []) as ConfigField[]);
  for (const kind of manifest.instances ?? [])
    checkConnectionFields(`instances.${kind.kind}`, (kind.fields ?? []) as ConfigField[]);
  if ((manifest.instances ?? []).length > 0) {
    if (!manifest.api)
      problems.push(
        "instances need api.basePaths: the host mounts their routes below the first base path",
      );
    if (!manifest.studio)
      problems.push("instances need a studio route: the host mounts their pages there");
  }
  if (
    manifest.studio &&
    manifest.settings?.organization?.length &&
    !manifest.api
  ) {
    problems.push(
      "hosted Studio settings need api.basePaths: the host mounts their routes below the first base path",
    );
  }
  return problems;
}
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
  const v1Types = player.v1ManifestTypes ?? [];
  if (new Set(v1Types).size !== v1Types.length)
    problems.push("v1ManifestTypes repeats a type");
  for (const type of v1Types)
    if ((reservedPlayerEntryTypes as readonly string[]).includes(type))
      problems.push(`v1 manifest type ${type} is reserved`);
  if (v1Types.length > 0 && !player.runtime)
    problems.push(
      "v1ManifestTypes needs a runtime contribution to consume the v1 entries",
    );
  const providerIds = new Set<string>();
  const providers = player.runtime?.providers ?? [];
  const requestsProvide = (player.runtime?.services?.required ?? [])
    .concat(player.runtime?.services?.optional ?? [])
    .some((value) => parseServiceReference(value)?.name === PROVIDE_SERVICE);
  if (providers.length > 0 && !requestsProvide)
    problems.push(
      "runtime: providers are declared without requesting player.presentation.provide",
    );
  if (requestsProvide && providers.length === 0)
    problems.push(
      "runtime: player.presentation.provide is requested without declaring providers",
    );
  for (const provider of providers) {
    if (providerIds.has(provider.id))
      problems.push(`runtime: provider ${provider.id} is declared twice`);
    providerIds.add(provider.id);
  }
  const events = player.events ?? [];
  const requestsEvents = (player.runtime?.services?.required ?? [])
    .concat(player.runtime?.services?.optional ?? [])
    .some((value) => parseServiceReference(value)?.name === EVENTS_SERVICE);
  const eventKeys = new Set<string>();
  for (const event of events) {
    const key = `${event.name}@${event.version}`;
    if (eventKeys.has(key)) problems.push(`event ${key} is declared twice`);
    eventKeys.add(key);
  }
  if (events.length > 0) {
    if (!player.runtime || native.length === 0)
      problems.push(
        "events connect a native contribution to a Shared Runtime contribution; declare both",
      );
    else if (!requestsEvents)
      problems.push(
        "runtime: events are declared without requesting player.events",
      );
  }
  if (requestsEvents && events.length === 0)
    problems.push(
      "runtime: player.events is requested without declaring events",
    );
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
 * or v2 `player.state` types and `player.v1ManifestTypes`. One namespace
 * across every plugin.
 */
export function playerEntryTypes(manifest: PluginManifest): string[] {
  if (manifest.apiVersion === 1)
    return [...(manifest.runtime?.manifestTypes ?? [])];
  return [
    ...new Set([
      ...(manifest.player?.state ?? []).map((state) => state.type),
      ...(manifest.player?.v1ManifestTypes ?? []),
    ]),
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
