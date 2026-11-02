/**
 * Projection of first-class Widget components (docs/widgets-v2.md §6).
 *
 * A manifest v16 or v17 Widget whose presentation is `kind: "component"` projects
 * to a RuntimeWidgetComponentPayload: the component reference, the Data
 * Documents selected for the Player instant, and its declared media variants.
 * Selection uses the same host-owned rules as compatibility Widgets.
 *
 * Node-safe. The Electron main process imports it through
 * `@tilecast/player-runtime/projection`; the runtime runs it when a host
 * sends references (compat/projector.ts).
 */
import type {
  RuntimeWidgetComponentPayload,
  RuntimeWidgetComponentV1,
  RuntimeWidgetSandboxExecutionV1,
} from "../host/contract";
import type {
  DataDocument,
  ManifestDataSource,
  ManifestWidget,
} from "../compat/projection/content-types";
import type { RegionalFormatting } from "../compat/projection/format";
import { normalizeSource } from "../compat/projection/datasource";
import type { ManifestAsset } from "../compat/projection/types";

/**
 * Mirrors `@tilecast/widget-sdk/identity`'s component-type rule. The SDK
 * ships ES modules and this file also compiles to CommonJS for Node hosts,
 * so the values are mirrored instead of imported; projection.test.ts asserts
 * parity with the SDK.
 */
export const COMPONENT_TYPE_PATTERN =
  /^[a-z][a-z0-9]{1,31}(\.[a-z][a-z0-9-]{0,47})+$/;
export const MAX_COMPONENT_TYPE_LENGTH = 80 - "widget.".length;

/** Latest presentation schema version of `kind: "component"` presentations. */
export const COMPONENT_PRESENTATION_SCHEMA = 3;
const LEGACY_COMPONENT_PRESENTATION_SCHEMA = 2;

const MAX_DATA_SOURCES = 8;
const MAX_MEDIA = 16;
const IDENTIFIER = /^[A-Za-z0-9-]{1,64}$/;
/** Mirrors the package SDK's package identity rule (at most 128 runes). */
const PACKAGE_ID =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const HEX64 = /^[0-9a-f]{64}$/;
/**
 * Canonical frame references the projector translates through the host's
 * frame table: `tcwidget://frame/<packageId>/<frameDigest>`. The Runtime
 * never sends one to an executor untranslated.
 */
export const FRAME_URI_PREFIX = "tcwidget://frame/";
/** Mirrors the Server frame cap: a maximum bundle plus template headroom. */
export const MAX_FRAME_BYTES = (1 << 20) + (1 << 16);
/** The external Widget execution ABI that runs sandbox frames. */
export const EXTERNAL_RUNTIME_FRAME_VERSION = 2;
/** The host capability name for the frame execution ABI. */
export const EXTERNAL_RUNTIME_CAPABILITY = "widget.external-runtime";

/** A validated v19 frame claim: the executable frame a host must prepare. */
export interface FrameClaim {
  packageId: string;
  packageDigest: string;
  frameDigest: string;
  size: number;
  downloadPath: string;
}

/**
 * Parse one manifest `package` block. Absent for bundled components;
 * null when the block names no executable frame or is malformed. The
 * single validation rule for projection and planning: size and download
 * path stay Core's business at execution time, but planning needs them
 * to prepare the exact bytes, so the claim carries all three.
 */
export function parseFrameClaim(value: unknown): FrameClaim | null | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const packageId = record.packageId;
  const digest = record.digest;
  const frame = record.frame;
  if (
    typeof packageId !== "string" ||
    packageId.length > 128 ||
    !PACKAGE_ID.test(packageId) ||
    packageId.split(".")[0] === "tilecast"
  ) {
    return null;
  }
  if (
    typeof digest !== "string" ||
    !digest.startsWith("sha256:") ||
    !HEX64.test(digest.slice("sha256:".length))
  ) {
    return null;
  }
  if (!frame || typeof frame !== "object") return null;
  const entry = frame as Record<string, unknown>;
  const sha256 = entry.sha256;
  const fileSize = entry.fileSize;
  const downloadPath = entry.downloadPath;
  if (typeof sha256 !== "string" || !HEX64.test(sha256)) return null;
  if (
    typeof fileSize !== "number" ||
    !Number.isInteger(fileSize) ||
    fileSize < 1 ||
    fileSize > MAX_FRAME_BYTES
  ) {
    return null;
  }
  if (
    typeof downloadPath !== "string" ||
    downloadPath.length > 256 ||
    !/^\/api\/v1\/player\/packages\/[A-Za-z0-9._-]+\/widgets\/[A-Za-z0-9_-]+\/frame$/.test(
      downloadPath,
    )
  ) {
    return null;
  }
  return {
    packageId,
    packageDigest: digest,
    frameDigest: sha256,
    size: fileSize,
    downloadPath,
  };
}

export interface ComponentProjectionContext {
  dataSources: ReadonlyMap<string, ManifestDataSource>;
  assets?: readonly ManifestAsset[];
  regionalFormat: RegionalFormatting;
  at: Date;
}

/** True when a manifest Widget carries a component presentation. */
export function isComponentWidget(widget: ManifestWidget): boolean {
  return widget.presentation?.kind === "component";
}

/**
 * Extract a package block's executable frame claim as the canonical
 * reference the projector translates through the host's frame table.
 * Absent for bundled components. Null fails the component: a package
 * claim without an executable frame (a v18 bundle claim, or a malformed
 * block) never mounts, trusted or otherwise.
 */
function frameExecutionOf(
  value: unknown,
): RuntimeWidgetSandboxExecutionV1 | null | undefined {
  const claim = parseFrameClaim(value);
  if (claim === undefined || claim === null) return claim;
  // The Runtime joins the claim to its authorized frame by package and
  // frame digest; size and download path stay the preparer's business.
  return {
    kind: "sandboxed",
    frameUrl: `${FRAME_URI_PREFIX}${claim.packageId}/${claim.frameDigest}`,
  };
}

function componentOf(widget: ManifestWidget): {
  component: RuntimeWidgetComponentV1;
  execution?: RuntimeWidgetSandboxExecutionV1;
} | null {
  const presentation = widget.presentation;
  if (
    !presentation ||
    presentation.kind !== "component" ||
    ![
      LEGACY_COMPONENT_PRESENTATION_SCHEMA,
      COMPONENT_PRESENTATION_SCHEMA,
    ].includes(presentation.schemaVersion)
  ) {
    return null;
  }
  const raw = presentation.component;
  if (!raw || typeof raw !== "object") return null;
  const { type, version, config } = raw;
  const empty =
    presentation.schemaVersion === COMPONENT_PRESENTATION_SCHEMA
      ? raw.empty
      : "render";
  if (
    typeof type !== "string" ||
    type.length > MAX_COMPONENT_TYPE_LENGTH ||
    !COMPONENT_TYPE_PATTERN.test(type)
  ) {
    return null;
  }
  if (!Number.isInteger(version) || version < 1 || version > 100) return null;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  if (empty !== "render" && empty !== "skip-eligible") return null;
  const dataSources = Array.isArray(raw.dataSources) ? raw.dataSources : [];
  const media = Array.isArray(raw.media) ? raw.media : [];
  if (dataSources.length > MAX_DATA_SOURCES || media.length > MAX_MEDIA) {
    return null;
  }
  if (
    !dataSources.every((id) => typeof id === "string" && IDENTIFIER.test(id))
  ) {
    return null;
  }
  if (
    !media.every(
      (ref) =>
        ref &&
        typeof ref.assetId === "string" &&
        IDENTIFIER.test(ref.assetId) &&
        typeof ref.variantId === "string" &&
        IDENTIFIER.test(ref.variantId),
    )
  ) {
    return null;
  }
  const execution = frameExecutionOf(raw.package);
  if (execution === null) return null;
  return {
    component: {
      type,
      version,
      config,
      empty,
      dataSources: [...dataSources],
      media: media.map(({ assetId, variantId }) => ({ assetId, variantId })),
    },
    ...(execution === undefined ? {} : { execution }),
  };
}

function hourCycle(
  format: RegionalFormatting["timeFormat"],
): RuntimeWidgetComponentPayload["regional"]["hourCycle"] {
  if (format === "12-hour") return "h12";
  if (format === "24-hour") return "h23";
  return "locale";
}

/**
 * Project a component Widget, or return null when the Widget is not a
 * component or its presentation is malformed. A malformed component is
 * never downgraded to something else on the Player: the Server chose the
 * presentation for this Player, so the item is left out like any other
 * Widget that cannot render.
 */
export function projectWidgetComponent(
  widget: ManifestWidget,
  ctx: ComponentProjectionContext,
): RuntimeWidgetComponentPayload | null {
  const projected = componentOf(widget);
  if (!projected) return null;
  const { component, execution } = projected;
  const documents: Record<string, unknown> = {};
  let hidden = false;
  for (const id of component.dataSources) {
    const source = ctx.dataSources.get(id);
    const document = source?.dataDocument;
    if (!source || !document) continue;
    const selectedDocument: DataDocument = {
      ...document,
      datasets: document.datasets.map((dataset) => {
        if (dataset.kind !== "records" || !dataset.dateSelection) {
          return dataset;
        }
        const normalized = normalizeSource(
          {
            ...source,
            dataDocument: { schemaVersion: 1, datasets: [dataset] },
          },
          ctx.at,
          ctx.regionalFormat,
        );
        hidden ||= normalized.hidden;
        const recordsById = new Map(
          (dataset.records ?? []).map((record) => [record.id, record]),
        );
        return {
          ...dataset,
          records: normalized.records.flatMap((record) => {
            const selected = recordsById.get(record.id);
            return selected ? [selected] : [];
          }),
        };
      }),
    };
    documents[id] = selectedDocument;
  }
  const media: Record<string, string> = {};
  for (const { assetId, variantId } of component.media) {
    const verified = ctx.assets?.some(
      (asset) => asset.assetId === assetId && asset.variantId === variantId,
    );
    // Only variants the manifest carries, which the Player has verified
    // and cached, become URIs. Hosts translate this form (projector.ts).
    if (verified) {
      media[`${assetId}/${variantId}`] =
        `tcmedia://variant/${assetId}/${variantId}`;
    }
  }
  return {
    component,
    documents,
    media,
    ...(hidden ? { hidden: true } : null),
    regional: {
      locale: ctx.regionalFormat.locale,
      timeZone: ctx.regionalFormat.timezone,
      hourCycle: hourCycle(ctx.regionalFormat.timeFormat),
    },
    // A canonical frame reference, translated through the host's frame
    // table before any executor sees it (projector.ts).
    ...(execution === undefined ? {} : { execution }),
  };
}
