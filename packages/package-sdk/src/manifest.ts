/**
 * The Tilecast package manifest (`tilecast.package.json`).
 *
 * A package is a distribution container, not a fourth extension API: it
 * carries distribution, version, provenance, and contribution metadata for
 * Widgets, declarative Data Sources, and (once the external runtime exists)
 * plugin behavior. The contribution contracts themselves
 * (`tilecast.widget.json`, `tilecast.datasource.json`,
 * `tilecast.plugin.json`) are unchanged.
 *
 * This Zod schema is the source of the portable JSON Schema in
 * `schema/tilecast-package.schema.json` (Draft 2020-12), written by
 * `npm run generate`. The Go SDK parses the same file with its own
 * validator; the fixtures in `testdata/manifests/` keep the two in
 * agreement.
 *
 * A manifest is data. Version 1 declares no capabilities, no source, and
 * no code to download: contribution paths point inside the package, and
 * the host decides what an extension class may do. Version 2 adds an
 * optional server runtime module and the bounded capabilities it
 * requests; version 3 keeps those capabilities and adds bounded Tilecast
 * service grants. The declarations are requests, never grants — the host
 * decides what is supported and permitted, and installation review
 * shows every requested capability before anything is installed.
 */
import { z } from "zod";

/** The latest Tilecast package manifest version this SDK implements. */
export const PACKAGE_API_VERSION = 3;

/** Package manifest versions this release can load. */
export const SUPPORTED_PACKAGE_API_VERSIONS = [1, 2, 3] as const;

/** Maximum Tilecast service grants one package may request. */
export const MAX_SERVICE_GRANTS = 16;

/** Maximum requested service capability version. */
export const MAX_SERVICE_VERSION = 99;

/**
 * A qualified package identity: at least two dot-separated segments of
 * lowercase ASCII letters, digits, and hyphens. The `tilecast` namespace is
 * reserved for release-owned contributions and is rejected separately.
 */
export const packageIdPattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A publisher handle: one namespace segment. */
export const publisherIdPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Strict SemVer: X.Y.Z with optional prerelease and build metadata. */
export const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * One Tilecast compatibility clause: a comparator and a 1-to-3-component
 * numeric version, for example `>=1.2.0`. Clauses join with single spaces
 * and all must hold. No OR, ranges, or wildcards: the grammar stays small
 * enough to evaluate identically in every language.
 */
export const tilecastRangePattern =
  /^(?:>=|<=|>|<|=)?\d{1,5}(?:\.\d{1,5}){0,2}(?: (?:>=|<=|>|<|=)?\d{1,5}(?:\.\d{1,5}){0,2})*$/;

/**
 * An OCI distribution reference without tag or digest: the registry and
 * repository the installer resolves to an immutable digest at install time.
 * Lowercase only; a port may appear in the first segment only.
 */
export const ociReferencePattern =
  /^[a-z0-9][a-z0-9._-]*(:[0-9]{1,5})?(\/[a-z0-9_][a-z0-9._-]{0,63})+$/;

/** An https URL with a host and path, such as a repository address. */
const httpsUrl = (description: string) =>
  z
    .string()
    .max(200)
    .regex(/^https:\/\/[^/\s]+\/[^/\s].{0,180}$/, description);

const text = (max: number) => z.string().min(1).max(max);

/**
 * A path inside the package directory, written `./relative/path`. Every
 * segment starts with a letter, digit, underscore, or hyphen, so `..`, `.`,
 * and empty segments cannot appear and the path cannot leave the package.
 */
const packagePath = z
  .string()
  .regex(
    /^\.(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/,
    "must be a ./relative path inside the package directory",
  );

export const contributionTypes = ["plugin", "widget", "dataSource"] as const;

const contributionSchema = z.strictObject({
  type: z
    .enum(contributionTypes)
    .describe("Which existing extension contract the nested manifest uses."),
  path: packagePath.describe(
    "Directory inside the package holding the contribution manifest.",
  ),
});

/**
 * A `./relative/file.wasm` module inside the package directory. The
 * extension is part of the contract: only WebAssembly modules load.
 */
const wasmModulePath = packagePath
  .refine((path) => path.endsWith(".wasm"), "must name a .wasm module file")
  .describe("Package-relative WebAssembly module for server behavior.");

/**
 * A `./relative/page.html` entry inside the package directory. The frame
 * serves the entry plus its directory's web assets, nothing else.
 */
const studioEntryPath = packagePath
  .refine((path) => path.endsWith(".html"), "must name an .html entry page")
  .describe("Package-relative entry page for the sandboxed Studio UI.");

/**
 * A lowercase DNS hostname without port or scheme. No wildcards, no IP
 * literals: every approved origin is explicit. The Go validator enforces
 * the same pattern plus the numeric-address rejection below.
 */
export const capabilityHostPattern =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

const capabilityHost = z
  .string()
  .regex(capabilityHostPattern, "must be a lowercase DNS hostname")
  .refine((host) => !/^[0-9.]+$/.test(host), "must not be an IP literal")
  .describe("Approved outbound HTTPS origin.");

/** A background job identity: one dotless segment, like a nested ID. */
const capabilityJobId = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,79}$/,
    "must be a lowercase job identity such as refresh",
  );

const backgroundJobSchema = z.strictObject({
  id: capabilityJobId.describe("Stable job identity within the package."),
  intervalMinutes: z
    .number()
    .int()
    .min(5)
    .max(1440)
    .describe("How often the host runs the job, in minutes."),
});

/**
 * A Tilecast service capability identity: dotted lowercase segments such as
 * `screens.read` or `managed-presentations.manage`. The manifest checks
 * only the shape and bounds; the server registry decides which identities
 * and versions exist at install/review time.
 */
export const serviceCapabilityIdPattern =
  /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

const serviceGrantSchema = z
  .strictObject({
    id: z
      .string()
      .max(64)
      .regex(
        serviceCapabilityIdPattern,
        "must be a dotted service identity such as screens.read",
      )
      .describe("Stable Tilecast service capability identity."),
    version: z
      .number()
      .int()
      .min(1)
      .max(MAX_SERVICE_VERSION)
      .describe("Requested service capability version."),
  })
  .describe("One requested Tilecast service grant.");

const networkCapabilitySchema = z
  .strictObject({
    hosts: z
      .array(capabilityHost)
      .min(1)
      .max(8)
      .describe("Approved outbound HTTPS origins."),
  })
  .describe("Approved outbound network access.");

const backgroundCapabilitySchema = z
  .strictObject({
    jobs: z
      .array(backgroundJobSchema)
      .min(1)
      .max(4)
      .describe("Package-owned background jobs the host runs."),
  })
  .describe("Package-owned background behavior.");

const studioUICapabilitySchema = z
  .strictObject({
    entry: studioEntryPath,
  })
  .describe("Sandboxed Studio UI entry.");

const capabilitiesSchema = z
  .strictObject({
    network: networkCapabilitySchema.optional(),
    background: backgroundCapabilitySchema.optional(),
    storage: z
      .literal(true)
      .optional()
      .describe("Request plugin-owned key/value storage."),
    studioUI: studioUICapabilitySchema.optional(),
    services: z
      .array(serviceGrantSchema)
      .min(1)
      .max(MAX_SERVICE_GRANTS)
      .optional()
      .describe(
        "Requested versioned Tilecast service grants (version 3 only).",
      ),
  })
  .describe("Bounded capabilities the package requests.");

const runtimeSchema = z
  .strictObject({
    module: wasmModulePath,
  })
  .describe("External server behavior module.");

export const packageManifestSchema = z
  .strictObject({
    apiVersion: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .describe(
        "Package manifest version. Versions 2 and 3 declare runtime and capabilities; only 3 declares service grants.",
      ),
    packageId: z
      .string()
      .max(128)
      .regex(
        packageIdPattern,
        "must be a qualified identity such as acme.athletics",
      )
      .describe(
        "Stable qualified package identity. Registry location is not identity.",
      ),
    packageVersion: z
      .string()
      .max(64)
      .regex(semverPattern, "must be SemVer such as 2.4.1")
      .describe(
        "Release version of this package. Independent of contribution versions.",
      ),
    name: text(80).describe("Human-readable package name."),
    description: text(500).describe("What the package adds."),
    publisher: z
      .strictObject({
        id: z
          .string()
          .regex(publisherIdPattern, "must be one namespace segment")
          .describe("Publisher namespace. The package ID starts with it."),
        name: text(80).describe("Human-readable publisher name."),
      })
      .describe("Who publishes this package."),
    repository: httpsUrl("must be an https URL with a host and path").describe(
      "Public source repository of the package.",
    ),
    license: text(32).describe("SPDX license identifier such as MIT."),
    tilecast: z
      .strictObject({
        version: z
          .string()
          .max(128)
          .regex(
            tilecastRangePattern,
            "must be space-separated clauses such as >=1.2.0 <2.0.0",
          )
          .describe("Tilecast versions this package supports."),
      })
      .describe("Compatibility of this package."),
    distribution: z
      .strictObject({
        oci: z
          .string()
          .max(255)
          .regex(
            ociReferencePattern,
            "must be an OCI registry/repository without tag or digest",
          )
          .describe("OCI artifact the installer resolves to a digest."),
      })
      .describe("Where the installer fetches package bytes."),
    contributions: z
      .array(contributionSchema)
      .min(1)
      .max(64)
      .describe("Extension contributions bundled in this package."),
    documentation: httpsUrl("must be an https URL with a host and path")
      .optional()
      .describe("Documentation page for the package."),
    issues: httpsUrl("must be an https URL with a host and path")
      .optional()
      .describe("Issue tracker for the package."),
    runtime: runtimeSchema
      .optional()
      .describe("External server behavior module (versions 2 and 3)."),
    capabilities: capabilitiesSchema
      .optional()
      .describe(
        "Bounded capabilities the package requests (versions 2 and 3; services are version 3 only).",
      ),
  })
  .describe("Tilecast package manifest (tilecast.package.json).")
  .superRefine((manifest, context) => {
    if (
      manifest.apiVersion === 1 &&
      (manifest.runtime ?? manifest.capabilities)
    ) {
      context.addIssue({
        code: "custom",
        path: ["apiVersion"],
        message: "runtime and capabilities require apiVersion 2",
      });
    }
    if (
      manifest.capabilities?.services !== undefined &&
      manifest.apiVersion !== 3
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "services"],
        message: "service grants require apiVersion 3",
      });
    }
    const executable = manifest.capabilities
      ? (manifest.capabilities.network ??
        manifest.capabilities.background ??
        manifest.capabilities.storage ??
        manifest.capabilities.services)
      : undefined;
    if (executable !== undefined && !manifest.runtime) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message:
          "network, background, storage, and service capabilities require a runtime module",
      });
    }
    const capabilities = manifest.capabilities;
    if (
      capabilities &&
      capabilities.network === undefined &&
      capabilities.background === undefined &&
      capabilities.storage === undefined &&
      capabilities.studioUI === undefined &&
      capabilities.services === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "capabilities must declare at least one capability",
      });
    }
    if (manifest.packageId.split(".")[0] === "tilecast") {
      context.addIssue({
        code: "custom",
        path: ["packageId"],
        message: "the tilecast namespace is reserved for the release",
      });
    }
    if (
      manifest.packageId !== manifest.publisher.id &&
      !manifest.packageId.startsWith(`${manifest.publisher.id}.`)
    ) {
      context.addIssue({
        code: "custom",
        path: ["packageId"],
        message: "must start with the publisher namespace",
      });
    }
    const seen = new Set<string>();
    manifest.contributions.forEach((contribution, index) => {
      const key = contribution.path;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["contributions", index, "path"],
          message: "contribution paths must be unique",
        });
      }
      seen.add(key);
    });
    const hosts = manifest.capabilities?.network?.hosts ?? [];
    const seenHosts = new Set<string>();
    hosts.forEach((host, index) => {
      if (seenHosts.has(host)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", "network", "hosts", index],
          message: "capability hosts must be unique",
        });
      }
      seenHosts.add(host);
    });
    const jobs = manifest.capabilities?.background?.jobs ?? [];
    const seenJobs = new Set<string>();
    jobs.forEach((job, index) => {
      if (seenJobs.has(job.id)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", "background", "jobs", index, "id"],
          message: "background job ids must be unique",
        });
      }
      seenJobs.add(job.id);
    });
    const services = manifest.capabilities?.services ?? [];
    const seenServices = new Set<string>();
    services.forEach((service, index) => {
      const key = `${service.id}@${service.version}`;
      if (seenServices.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities", "services", index],
          message: "service grants must be unique",
        });
      }
      seenServices.add(key);
    });
  });

export type PackageManifestInput = z.input<typeof packageManifestSchema>;
export type PackageManifest = z.output<typeof packageManifestSchema>;

export function parsePackageManifest(value: unknown): PackageManifest {
  return packageManifestSchema.parse(value);
}

/** The portable Draft 2020-12 JSON Schema generated from the Zod schema. */
export function packageManifestJSONSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/gbyo/tilecast/packages/package-sdk/schema/tilecast-package.schema.json",
    ...z.toJSONSchema(packageManifestSchema, {
      target: "draft-2020-12",
      io: "input",
    }),
  };
}

/** True when the contribution ID equals the package ID or lives beneath it. */
export function isPackageNamespace(
  contributionId: string,
  packageId: string,
): boolean {
  return (
    contributionId === packageId || contributionId.startsWith(`${packageId}.`)
  );
}

type TilecastVersion = readonly [number, number, number];

function parseTilecastVersion(value: string): TilecastVersion | null {
  const match = /^(\d{1,5})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2] ?? 0),
    Number(match[3] ?? 0),
  ] as const;
}

function compareVersions(
  left: TilecastVersion,
  right: TilecastVersion,
): number {
  for (let index = 0; index < 3; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a Tilecast version satisfies a manifest compatibility range. Every
 * space-separated clause must hold. Unknown input fails closed.
 */
export function satisfiesTilecastRange(
  range: string,
  version: string,
): boolean {
  // A Beta release satisfies the ranges its core satisfies; any other
  // suffix, such as a development build's "-dev", stays unparseable.
  const current = parseTilecastVersion(
    version.trim().replace(/-beta\.[1-9][0-9]?$/, ""),
  );
  if (!current) return false;
  const clauses = range.trim().split(/\s+/);
  if (clauses.length === 0 || clauses.some((clause) => clause === "")) {
    return false;
  }
  return clauses.every((clause) => {
    const match = /^(>=|<=|>|<|=)?(\d{1,5}(?:\.\d{1,5}){0,2})$/.exec(clause);
    if (!match?.[2]) return false;
    const wanted = parseTilecastVersion(match[2]);
    if (!wanted) return false;
    const order = compareVersions(current, wanted);
    switch (match[1] ?? "=") {
      case ">":
        return order > 0;
      case ">=":
        return order >= 0;
      case "<":
        return order < 0;
      case "<=":
        return order <= 0;
      default:
        return order === 0;
    }
  });
}
