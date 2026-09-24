/**
 * Widget, data-source, layout, and declarative-presentation wire types.
 *
 * Field names mirror the Go/Kotlin server structs exactly. Only the subset
 * the Linux player consumes is typed; unknown fields are tolerated. All
 * schema-11/12 record values arrive as strings; only DataDocument (v13)
 * carries real typed scalars.
 */

// ---------------------------------------------------------------------------
// Manifest widget + data source entries

export interface ManifestWidget {
  assetId: string;
  name: string;
  provider: string;
  configVersion: number;
  configuration: Record<string, unknown>;
  presentation?: WidgetPresentation | null;
}

export interface ManifestDataSource {
  id: string;
  name: string;
  provider: string;
  configVersion: number;
  configuration: Record<string, unknown>;
  dataDocument?: DataDocument | null;
}

// ---------------------------------------------------------------------------
// Typed records (schema 12) and legacy structured/calendar (schema 11)

export interface DataSourceField {
  key: string;
  label: string;
  type: string; // text|number|integer|percent|currency|boolean|date|datetime|url
  /** Semantic ISO 4217 code for currency values; never inferred from locale. */
  currency?: string;
}

export interface TypedRecord {
  id: string;
  values: Record<string, string>;
}

export interface TypedRecordData {
  fields: DataSourceField[];
  records: TypedRecord[];
  cachedAt?: string | null;
  staleAt?: string | null;
  usingCachedData?: boolean;
  unavailable?: boolean;
  dateField?: string;
  attribution?: string;
}

export interface StructuredRecord {
  id: string;
  title: string;
  subtitle?: string;
  date?: string;
  author?: string;
  description?: string;
  imageUrl?: string;
  link?: string;
  values?: Record<string, string>;
}

export interface CalendarEvent {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  descriptionExcerpt?: string;
}

export interface DateSelection {
  enabled?: boolean;
  timezone?: string;
  mode?: string; // today|tomorrow|next_available|current_week|custom_range
  customStartDate?: string;
  customEndDate?: string;
  excludePast?: boolean;
  noMatchBehavior?: string; // fallback_text|next_available|empty|hide|last_known_good
  fallbackText?: string;
}

// ---------------------------------------------------------------------------
// DataDocument (schema 13)

export interface DocumentValue {
  kind: string;
  text?: string | null;
  number?: number | null;
  integer?: number | null;
  boolean?: boolean | null;
  date?: string | null;
  datetime?: string | null;
  durationSeconds?: number | null;
  url?: string | null;
  assetId?: string | null;
  list?: DocumentValue[];
  object?: Record<string, DocumentValue>;
}

export interface DocumentRecord {
  id: string;
  values: Record<string, DocumentValue>;
}

export interface DocumentPoint {
  at: string;
  value?: DocumentValue | null;
  values?: Record<string, DocumentValue>;
}

export interface DocumentField {
  key: string;
  label: string;
  type: string;
  currency?: string;
}

export interface DocumentDataset {
  id: string;
  kind: string; // scalar|records|time_series|list|object
  fields?: DocumentField[];
  scalar?: DocumentValue | null;
  records?: DocumentRecord[];
  points?: DocumentPoint[];
  value?: DocumentValue | null;
  attribution?: string;
  timezone?: string;
  dateSelection?: DocumentDateSelection | null;
  units?: Record<string, string>;
}

export interface DocumentDateSelection {
  field: string;
  timezone: string;
  mode: string;
  customStartDate?: string;
  customEndDate?: string;
  excludePast?: boolean;
  noMatchBehavior?: string;
  fallbackText?: string;
}

export interface DataDocument {
  schemaVersion: number;
  datasets: DocumentDataset[];
}

// ---------------------------------------------------------------------------
// Declarative presentation (schema 13)

export interface PresentationBinding {
  source: string; // literal|dataset|repeat|repeat_index|environment
  dataset?: string;
  path?: string;
  selector?: "all" | "current" | "next" | "upcoming" | "current_or_next";
  startField?: string;
  endField?: string;
  value?: string;
  fields?: string[];
  format?: string;
  precision?: number | null;
  prefix?: string;
  suffix?: string;
  fallback?: string;
  separator?: string;
}

export interface PresentationRepeat {
  dataset: string;
  limit: number;
  /** Leading records to skip, so a second region can list what follows the current one. */
  offset?: number;
  selector?: "all" | "current" | "next" | "upcoming" | "current_or_next";
  startField?: string;
  endField?: string;
}

export interface PresentationCondition {
  binding: PresentationBinding;
  op: string;
  value?: string;
}

export interface PresentationNode {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  binding?: PresentationBinding | null;
  repeat?: PresentationRepeat | null;
  condition?: PresentationCondition | null;
  children?: PresentationNode[];
}

export interface NativePresentation {
  root: PresentationNode;
}

export interface WebSandboxPresentation {
  mode: string; // remote|bundle
  url?: string;
  integritySha256?: string;
  packageSize?: number;
  downloadPath?: string;
  allowedHosts?: string[];
  onlineOnly?: boolean;
  fallbackBehavior?: string;
  loadTimeoutSeconds?: number;
  readonly reload?: {
    mode: "periodic";
    intervalSeconds: number;
  } | null;
}

export interface WidgetPresentation {
  schemaVersion: number;
  kind: string; // native|web
  requiredCapabilities?: Record<string, number>;
  native?: NativePresentation | null;
  web?: WebSandboxPresentation | null;
}

// ---------------------------------------------------------------------------
// Layout document (schemaVersion 2)

export interface LayoutBinding {
  dataSourceId: string;
  field: string;
  prefix?: string;
  suffix?: string;
  fallbackText?: string;
  hideWhenEmpty?: boolean;
  format?: string;
}

export interface LayoutPrimitive {
  kind: string; // text|rectangle|circle|line|group
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: string;
  verticalAlign?: string;
  color?: string;
  backgroundColor?: string;
  lineHeight?: number;
  letterSpacing?: number;
  padding?: number;
  borderWidth?: number;
  borderColor?: string;
  cornerRadius?: number;
  maximumLines?: number;
  overflow?: string;
  autoFit?: boolean;
  minimumFontSize?: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  binding?: LayoutBinding | null;
}

export interface LayoutPlayback {
  fit?: string;
  muted?: boolean;
  loop?: boolean;
  fallback?: string;
  cornerRadius?: number;
}

export interface LayoutPlacement {
  id: string;
  type: string; // widget|asset|playlistZone|primitive
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  groupId?: string | null;
  widgetId?: string | null;
  assetId?: string | null;
  variantId?: string | null;
  playlistId?: string | null;
  overrides?: Record<string, unknown> | null;
  primitive?: LayoutPrimitive | null;
  playback?: LayoutPlayback | null;
}

export interface LayoutCanvas {
  width: number;
  height: number;
  orientation: string;
  backgroundColor: string;
  backgroundAssetId?: string | null;
  backgroundVariantId?: string | null;
  safeAreaPercent?: number;
}

export interface LayoutDocument {
  schemaVersion: number;
  canvas: LayoutCanvas;
  placements: LayoutPlacement[];
}

export interface ManifestLayout {
  id: string;
  revisionId: string;
  revision: number;
  documentSha256: string;
  document: LayoutDocument;
}
