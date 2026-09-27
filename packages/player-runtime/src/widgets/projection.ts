/**
 * Projection of first-class Widget components (docs/widgets-v2.md §6).
 *
 * A manifest v16 Widget whose presentation is `kind: "component"` projects
 * to a RuntimeWidgetComponentPayload: the component reference, the Data
 * Documents and media variants it declares, and the regional formatting
 * for its context. Nothing here depends on the current time, so the
 * runtime's periodic re-projection never restarts a component, and nothing
 * here renders: the Widget's own element does that in every host.
 *
 * Node-safe. The Electron main process imports it through
 * `@tilecast/player-runtime/projection`; the runtime runs it when a host
 * sends references (compat/projector.ts).
 */
import type {
  RuntimeWidgetComponentPayload,
  RuntimeWidgetComponentV1,
} from "../host/contract";
import type {
  ManifestDataSource,
  ManifestWidget,
} from "../compat/projection/content-types";
import type { RegionalFormatting } from "../compat/projection/format";
import type { ManifestAsset } from "../compat/projection/types";

/** Presentation schema version of `kind: "component"` presentations. */
export const COMPONENT_PRESENTATION_SCHEMA = 2;

const MAX_DATA_SOURCES = 8;
const MAX_MEDIA = 16;
const IDENTIFIER = /^[A-Za-z0-9-]{1,64}$/;
const TYPE = /^[a-z][a-z0-9]{1,31}\.[a-z][a-z0-9-]{0,47}$/;

export interface ComponentProjectionContext {
  dataSources: ReadonlyMap<string, ManifestDataSource>;
  assets?: readonly ManifestAsset[];
  regionalFormat: RegionalFormatting;
}

/** True when a manifest Widget carries a component presentation. */
export function isComponentWidget(widget: ManifestWidget): boolean {
  return widget.presentation?.kind === "component";
}

function componentOf(widget: ManifestWidget): RuntimeWidgetComponentV1 | null {
  const presentation = widget.presentation;
  if (
    !presentation ||
    presentation.kind !== "component" ||
    presentation.schemaVersion !== COMPONENT_PRESENTATION_SCHEMA
  ) {
    return null;
  }
  const raw = presentation.component;
  if (!raw || typeof raw !== "object") return null;
  const { type, version, config } = raw;
  if (typeof type !== "string" || type.length > 72 || !TYPE.test(type)) {
    return null;
  }
  if (!Number.isInteger(version) || version < 1 || version > 100) return null;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
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
  return {
    type,
    version,
    config,
    dataSources: [...dataSources],
    media: media.map(({ assetId, variantId }) => ({ assetId, variantId })),
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
  const component = componentOf(widget);
  if (!component) return null;
  const documents: Record<string, unknown> = {};
  for (const id of component.dataSources) {
    const document = ctx.dataSources.get(id)?.dataDocument;
    if (document) documents[id] = document;
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
    regional: {
      locale: ctx.regionalFormat.locale,
      timeZone: ctx.regionalFormat.timezone,
      hourCycle: hourCycle(ctx.regionalFormat.timeFormat),
    },
  };
}
