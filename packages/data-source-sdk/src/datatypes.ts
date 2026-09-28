/**
 * Tilecast Data Types: the only value vocabulary a declarative Data Source
 * module may declare for its output fields. The set mirrors
 * `supportedOutputFieldTypes` in `apps/server/internal/contentdefs`
 * (the scalar kinds the Player's Data Document projector understands);
 * a module that declares anything else fails Server validation, so
 * `data-sources:check` rejects it before it ever reaches the catalog.
 */
export interface DataTypeDefinition {
  readonly type: string;
  /** What the value is when projected. */
  readonly value: string;
  /** What Studio shows and validates while authoring. */
  readonly authoring: string;
}

export const DATA_TYPES: readonly DataTypeDefinition[] = [
  {
    type: "text",
    value: "Literal text, projected as written.",
    authoring: "A single line of text.",
  },
  {
    type: "number",
    value: "A decimal number, projected with regional formatting.",
    authoring: "A decimal number.",
  },
  {
    type: "integer",
    value: "A whole number, projected with regional formatting.",
    authoring: "A whole number.",
  },
  {
    type: "percent",
    value: "A ratio, projected as a percentage.",
    authoring: "A percentage value.",
  },
  {
    type: "currency",
    value: "A monetary amount, projected with its currency.",
    authoring: "A monetary amount with a currency.",
  },
  {
    type: "boolean",
    value: "True or false, projected as Yes or No.",
    authoring: "A true/false switch.",
  },
  {
    type: "date",
    value: "A calendar date, projected in the viewer's regional format.",
    authoring: "A calendar date.",
  },
  {
    type: "datetime",
    value: "A timestamp, projected in the viewer's timezone.",
    authoring: "A date and time.",
  },
  {
    type: "duration",
    value: "A length of time in seconds, projected as words.",
    authoring: "A length of time in seconds.",
  },
  {
    type: "url",
    value: "An absolute URL, projected as a link target.",
    authoring: "An absolute URL.",
  },
  {
    type: "asset",
    value: "A media asset reference, projected through the asset pipeline.",
    authoring: "A media asset reference.",
  },
];

/** Every Tilecast Data Type name. */
export const DATA_TYPE_NAMES: readonly string[] = DATA_TYPES.map(
  (definition) => definition.type,
);

const DATA_TYPE_SET = new Set<string>(DATA_TYPE_NAMES);

/** Null when the type is a Tilecast Data Type, otherwise a diagnostic. */
export function dataTypeProblem(type: unknown): string | null {
  if (typeof type !== "string" || !DATA_TYPE_SET.has(type)) {
    return `unknown Tilecast Data Type ${JSON.stringify(type)}; expected one of ${DATA_TYPE_NAMES.join(", ")}`;
  }
  return null;
}
