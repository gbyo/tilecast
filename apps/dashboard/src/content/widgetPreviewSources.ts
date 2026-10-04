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
 * manifest projection writes the real variant under the schema-derived key;
 * a preview has no manifest, so it grants the asset's preview image under
 * the same alias instead.
 */
export const PREVIEW_MEDIA_VARIANT = "preview";

function mediaVariantKey(field: ContentDefinitionField): string | null {
  if (field.control !== "media_asset") {
    return null;
  }
  return field.key.endsWith("AssetId")
    ? `${field.key.slice(0, -"AssetId".length)}VariantId`
    : `${field.key}VariantId`;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function projectPreviewMedia(
  fields: readonly ContentDefinitionField[],
  values: Record<string, unknown>,
  media: { assetId: string; variantId: string }[],
): Record<string, unknown> {
  let next: Record<string, unknown> | undefined;
  for (const field of fields) {
    const variantKey = mediaVariantKey(field);
    if (variantKey) {
      const assetId = values[field.key];
      if (typeof assetId === "string" && assetId !== "") {
        media.push({ assetId, variantId: PREVIEW_MEDIA_VARIANT });
        next ??= { ...values };
        next[variantKey] = PREVIEW_MEDIA_VARIANT;
      }
      continue;
    }
    if (field.control !== "repeating_group" || !field.itemFields) continue;
    const items = values[field.key];
    if (!isUnknownArray(items)) continue;
    let nextItems: unknown[] | undefined;
    items.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return;
      const projected = projectPreviewMedia(
        field.itemFields!,
        item as Record<string, unknown>,
        media,
      );
      if (projected !== item) {
        nextItems ??= [...items];
        nextItems[index] = projected;
      }
    });
    if (nextItems) {
      next ??= { ...values };
      next[field.key] = nextItems;
    }
  }
  return next ?? values;
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
  return {
    configuration: projectPreviewMedia(fields, configuration, media),
    media,
  };
}

export interface WidgetPreviewAssetField {
  readonly dataSourceId: string;
  readonly fieldKey: string;
  readonly maximumItems: number;
}

/** Selected asset-valued fields that a component may consume from a source. */
export function widgetPreviewAssetFields(
  fields: readonly ContentDefinitionField[],
  configuration: Record<string, unknown>,
): WidgetPreviewAssetField[] {
  const sourceKeys = fields
    .filter((field) => field.control === "data_source")
    .map((field) => field.key);
  const maximumItems =
    typeof configuration.maximumItems === "number" &&
    Number.isInteger(configuration.maximumItems)
      ? Math.max(1, Math.min(100, configuration.maximumItems))
      : 6;
  return fields.flatMap((field) => {
    if (
      field.control !== "data_source_field" ||
      !field.dataSourceFieldTypes?.includes("asset")
    ) {
      return [];
    }
    const fieldKey = configuration[field.key];
    const sourceKey =
      field.dataSourceKey ??
      (sourceKeys.length === 1 ? sourceKeys[0] : undefined);
    const dataSourceId = sourceKey ? configuration[sourceKey] : undefined;
    return typeof fieldKey === "string" &&
      fieldKey !== "" &&
      typeof dataSourceId === "string" &&
      dataSourceId !== ""
      ? [{ dataSourceId, fieldKey, maximumItems }]
      : [];
  });
}
