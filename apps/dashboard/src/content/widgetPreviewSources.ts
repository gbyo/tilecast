import type { ContentDefinitionField } from "../api/types";
import { dataSourceKeysIn } from "./DefinitionForm";

/**
 * App Recipes deliberately keep their managed Data Source out of the author-facing schema.
 * Preview compilation still needs the release-derived keys that Player projection receives.
 */
export function widgetPreviewConfiguration(
  configuration: Record<string, unknown>,
  managedDataSourceId?: string,
): Record<string, unknown> {
  if (!managedDataSourceId) return configuration;
  return {
    ...configuration,
    sourceId: managedDataSourceId,
    managedDataSourceId,
  };
}

/**
 * Resolve every Data Source a preview needs. A managed App source is explicit and first so
 * single-source presentations receive it as their primary preview, while ordinary declared
 * data_source controls (including controls inside repeating groups) continue to be followed.
 */
export function widgetPreviewDataSourceIds(
  fields: ContentDefinitionField[],
  configuration: Record<string, unknown>,
  managedDataSourceId?: string,
): string[] {
  const ids = [
    ...(managedDataSourceId ? [managedDataSourceId] : []),
    ...dataSourceKeysIn(fields, configuration),
  ];
  return [...new Set(ids)];
}

/**
 * The variant alias Studio previews use for a selected media asset. Player
 * manifest projection writes the real variant under the derived key
 * (`imageAssetId` gives `imageVariantId`); a preview has no manifest, so
 * it grants the asset's preview image under this alias instead.
 */
export const PREVIEW_MEDIA_VARIANT = "preview";

function mediaVariantKey(field: ContentDefinitionField): string | null {
  if (field.control !== "media_asset" || !field.key.endsWith("AssetId")) {
    return null;
  }
  return `${field.key.slice(0, -"AssetId".length)}VariantId`;
}

/**
 * The media a preview grants, and the configuration with each derived
 * variant key the Player would receive. Only media_asset fields with a
 * selection take part, so a Widget never reaches an asset it did not name.
 */
export function widgetPreviewMedia(
  fields: readonly ContentDefinitionField[],
  configuration: Record<string, unknown>,
): {
  configuration: Record<string, unknown>;
  media: { assetId: string; variantId: string }[];
} {
  const media: { assetId: string; variantId: string }[] = [];
  let next = configuration;
  for (const field of fields) {
    const variantKey = mediaVariantKey(field);
    const assetId = configuration[field.key];
    if (!variantKey || typeof assetId !== "string" || assetId === "") continue;
    media.push({ assetId, variantId: PREVIEW_MEDIA_VARIANT });
    next = { ...next, [variantKey]: PREVIEW_MEDIA_VARIANT };
  }
  return { configuration: next, media };
}
