/**
 * The only way a Widget reads data. A Widget's `resolveData` receives a
 * `WidgetResources` that answers for the prepared Data Documents and the
 * verified media variants its component presentation declares, and nothing
 * else: no network, files, storage, credentials or host members.
 *
 * The document shapes mirror Data Document v1 in the Player manifest
 * (packages/manifest-schema). They are read-only views of data the Server
 * already sanitized and bounded; a Widget still treats every value as
 * untrusted display data.
 */
import { boundedCode } from "./identity.ts";

export interface WidgetValue {
  readonly kind: string;
  readonly text?: string | null;
  readonly number?: number | null;
  readonly integer?: number | null;
  readonly boolean?: boolean | null;
  readonly date?: string | null;
  readonly datetime?: string | null;
  readonly durationSeconds?: number | null;
  readonly url?: string | null;
  readonly assetId?: string | null;
  readonly list?: readonly WidgetValue[];
  readonly object?: Readonly<Record<string, WidgetValue>>;
}

export interface WidgetField {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly currency?: string;
}

export interface WidgetRecord {
  readonly id: string;
  readonly values: Readonly<Record<string, WidgetValue>>;
}

export interface WidgetPoint {
  readonly at: string;
  readonly value?: WidgetValue | null;
  readonly values?: Readonly<Record<string, WidgetValue>>;
}

export interface WidgetDataset {
  readonly id: string;
  readonly kind: string;
  readonly fields?: readonly WidgetField[];
  readonly scalar?: WidgetValue | null;
  readonly records?: readonly WidgetRecord[];
  readonly points?: readonly WidgetPoint[];
  readonly value?: WidgetValue | null;
  readonly attribution?: string;
  readonly timezone?: string;
  readonly units?: Readonly<Record<string, string>>;
}

export interface WidgetCacheState {
  readonly cachedAt?: string | null;
  readonly staleAt?: string | null;
  readonly usingCachedData?: boolean;
  readonly unavailable?: boolean;
}

export interface WidgetDataDocument {
  readonly schemaVersion: number;
  readonly datasets: readonly WidgetDataset[];
  readonly cache?: WidgetCacheState | null;
}

export interface WidgetMediaRef {
  readonly assetId: string;
  readonly variantId: string;
}

export interface WidgetResources {
  /** A declared Data Source's prepared document, or null. */
  dataDocument(dataSourceId: string): WidgetDataDocument | null;
  /** One dataset of a declared Data Source, or null. */
  dataset(dataSourceId: string, datasetId: string): WidgetDataset | null;
  /** A host-authorized URI for a declared media variant, or null. */
  media(assetId: string, variantId: string): string | null;
  /** Attribution the Data Source requires, or null. */
  attribution(dataSourceId: string): string | null;
}

/** What a Widget's data resolution produced. */
export type WidgetResolution<Data> =
  | { readonly state: "ready"; readonly data: Data }
  | { readonly state: "empty"; readonly reason: string }
  | { readonly state: "error"; readonly code: string };

export const ready = <Data>(data: Data): WidgetResolution<Data> => ({
  state: "ready",
  data,
});

/** Expected absence of content. Never a failure. */
export const empty = <Data = never>(
  reason: string,
): WidgetResolution<Data> => ({
  state: "empty",
  reason: boundedCode(reason, "no_content"),
});

export const failure = <Data = never>(
  code: string,
): WidgetResolution<Data> => ({
  state: "error",
  code: boundedCode(code, "widget_error"),
});

export interface ResourceTables {
  /** Data Documents by Data Source ID (typically the whole manifest's). */
  documents?: ReadonlyMap<string, WidgetDataDocument>;
  /** Host-authorized URIs keyed by `${assetId}/${variantId}`. */
  media?: ReadonlyMap<string, string>;
}

export interface ResourceGrant {
  /** Data Source IDs the component presentation declares. */
  dataSources?: readonly string[];
  /** Media variants the component presentation declares. */
  media?: readonly WidgetMediaRef[];
}

const EMPTY_RESOURCES: WidgetResources = Object.freeze({
  dataDocument: () => null,
  dataset: () => null,
  media: () => null,
  attribution: () => null,
});

/**
 * Narrow the host's tables to what one component declared. A lookup
 * outside the grant returns null exactly like a missing entry, so a Widget
 * cannot probe for unrelated manifest content.
 */
export function createWidgetResources(
  tables: ResourceTables,
  grant: ResourceGrant,
): WidgetResources {
  const sources = new Set(grant.dataSources ?? []);
  const media = new Set(
    (grant.media ?? []).map((ref) => `${ref.assetId}/${ref.variantId}`),
  );
  if (sources.size === 0 && media.size === 0) return EMPTY_RESOURCES;
  const documentOf = (id: string) =>
    sources.has(id) ? (tables.documents?.get(id) ?? null) : null;
  return Object.freeze({
    dataDocument: documentOf,
    dataset(id: string, datasetId: string) {
      return (
        documentOf(id)?.datasets.find((dataset) => dataset.id === datasetId) ??
        null
      );
    },
    media(assetId: string, variantId: string) {
      const key = `${assetId}/${variantId}`;
      return media.has(key) ? (tables.media?.get(key) ?? null) : null;
    },
    attribution(id: string) {
      const document = documentOf(id);
      const text = document?.datasets.find(
        (dataset) => dataset.attribution,
      )?.attribution;
      return text ? text.slice(0, 280) : null;
    },
  });
}
