/**
 * Pure draft logic for the Widget editor: how a draft starts, how two drafts
 * compare, and what a save sends. No React, so it is easy to test and the
 * session hook stays about state and effects.
 */
import { upgradeAuthorConfiguration } from "@tilecast/widget-sdk/upgrade";
import type {
  Asset,
  ContentDefinitionField,
  WidgetDefinition,
} from "@/api/types";
import type { WidgetAuthoring } from "./widgetAuthoring";

export type WidgetConfiguration = Record<string, unknown>;

export type WidgetDraft = {
  readonly name: string;
  readonly description: string;
  readonly configuration: WidgetConfiguration;
};

const NAME_LIMIT = 180;
const DESCRIPTION_LIMIT = 2000;

export const widgetDetailLimits = {
  name: NAME_LIMIT,
  description: DESCRIPTION_LIMIT,
} as const;

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/**
 * Saved rows from before a provider gained its current style key. The
 * component template reads the old key as a fallback, but the inspector
 * shows the new one, so it is filled from the old value when the row has
 * none. This is data migration for saved content, not editor behavior.
 */
const legacyAuthorUpgrades: Record<
  string,
  (saved: WidgetConfiguration, upgraded: WidgetConfiguration) => void
> = {
  chart(saved, upgraded) {
    if (Object.hasOwn(saved, "style") || Object.hasOwn(upgraded, "style"))
      return;
    const chartType = upgraded["chartType"] ?? saved["chartType"];
    if (chartType === "bar" || chartType === "donut") upgraded["style"] = "bar";
    else if (chartType === "line") upgraded["style"] = "line";
    else if (chartType === "area") upgraded["style"] = "area";
  },
};

/** Fill each missing top-level field from its declared default, as the Server does. */
export function withFieldDefaults(
  fields: readonly ContentDefinitionField[],
  configuration: WidgetConfiguration,
): WidgetConfiguration {
  const out = { ...configuration };
  for (const field of fields) {
    if (out[field.key] === undefined && field.default !== undefined)
      out[field.key] = clone(field.default);
  }
  return out;
}

function savedConfiguration(asset: Asset): WidgetConfiguration {
  const saved: WidgetConfiguration = {
    ...(asset.widget?.authorConfiguration ?? asset.widget?.configuration),
  };
  return saved;
}

/**
 * The configuration the inspector edits. A saved component Widget opens
 * upgraded to its provider's current schema (docs/widgets-v2-catalog.md §8);
 * any other saved Widget keeps only the keys its schema declares, so
 * Server-derived values such as a website's display URL are never sent
 * back as author input.
 */
export function initialConfiguration(
  definition: WidgetDefinition,
  authoring: WidgetAuthoring,
  asset?: Asset,
): WidgetConfiguration {
  const fields = definition.configurationSchema.fields;
  if (!asset)
    return withFieldDefaults(
      fields,
      clone(definition.defaultConfiguration ?? {}),
    );
  const saved = savedConfiguration(asset);
  let configuration: WidgetConfiguration;
  if (authoring.kind === "component") {
    const shape =
      authoring.component.kind === "trusted"
        ? authoring.component.component
        : authoring.component.sandbox;
    configuration = upgradeAuthorConfiguration(
      fields,
      shape.configTemplate,
      saved,
      { dropUnknown: true },
    ).configuration;
    legacyAuthorUpgrades[definition.id]?.(saved, configuration);
  } else {
    const keys = new Set(fields.map((field) => field.key));
    configuration = Object.fromEntries(
      Object.entries(saved).filter(
        ([key, value]) => keys.has(key) && value !== null,
      ),
    );
  }
  return withFieldDefaults(fields, clone(configuration));
}

export function initialDraft(
  definition: WidgetDefinition,
  authoring: WidgetAuthoring,
  asset: Asset | undefined,
  newName: string,
): WidgetDraft {
  return {
    name: asset?.name ?? newName,
    description: asset?.description ?? "",
    configuration: initialConfiguration(definition, authoring, asset),
  };
}

/**
 * A stable serialization: object keys sorted, undefined members dropped.
 * Two drafts are the same Widget exactly when these strings match, so
 * reverting a value clears the change and key order never matters.
 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return entry;
    const record = entry as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, record[key]]),
    );
  });
}

export function sameDraft(a: WidgetDraft, b: WidgetDraft): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    stableSerialize(a.configuration) === stableSerialize(b.configuration)
  );
}

/** What Save sends. Trimming matches the Server, so a saved draft compares equal. */
export function widgetSaveInput(
  definition: WidgetDefinition,
  draft: WidgetDraft,
) {
  return {
    provider: definition.id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    configuration: JSON.parse(
      stableSerialize(draft.configuration),
    ) as WidgetConfiguration,
  };
}
