/**
 * Adapter vocabulary and FetchSpec conformance for declarative Data Source
 * modules. The adapter IDs are the exact registry keys in
 * `apps/server/internal/media/datasources.go`; a manifest that names
 * anything else fails Server startup validation, so `data-sources:check`
 * rejects it first.
 *
 * Only the trusted Tilecast-owned declarative families may back a module:
 * `manual_object`, `manual_records`, and `http_records`. The remaining
 * adapters read adapter-specific Studio-built configuration shapes rather
 * than definition schemas (or, for `form_records`, run plugin-owned
 * executable code behind `plugin.DataSourceProvider`), so they have no
 * declarative binding. `fetchSpecProblems` mirrors Go's
 * `validateFetchSpec` rule for rule so a contributor can validate a
 * purely declarative Data Source without PostgreSQL or a running Server;
 * the Server re-validates the same rules at catalog load.
 */

export const ADAPTER_IDS = [
  "calendar",
  "structured",
  "manual_table",
  "weather",
  "transit",
  "cap_alerts",
  "air_quality",
  "manual_object",
  "manual_records",
  "http_records",
  "form_records",
] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

/**
 * Adapters a declarative module may use. The release owns the endpoint
 * and the field mapping for `http_records`; the author only fills in the
 * placeholders the definition declares.
 */
export const DECLARATIVE_ADAPTERS = [
  "manual_object",
  "manual_records",
  "http_records",
] as const;

export type DeclarativeAdapter = (typeof DECLARATIVE_ADAPTERS)[number];

const ADAPTER_ID_SET = new Set<string>(ADAPTER_IDS);
const DECLARATIVE_SET = new Set<string>(DECLARATIVE_ADAPTERS);

/** Null when the id names a real Server adapter, otherwise a diagnostic. */
export function adapterProblem(adapterId: unknown): string | null {
  if (typeof adapterId !== "string" || !ADAPTER_ID_SET.has(adapterId)) {
    return `unknown adapter ${JSON.stringify(adapterId)}; expected one of ${ADAPTER_IDS.join(", ")}`;
  }
  return null;
}

/**
 * Null when a declarative module may use this adapter, otherwise a
 * diagnostic naming the declarative families.
 */
export function adapterDeclarativeProblem(adapterId: string): string | null {
  if (!DECLARATIVE_SET.has(adapterId)) {
    return (
      `adapter ${adapterId} has no declarative binding; ` +
      `declarative modules may use ${DECLARATIVE_ADAPTERS.join(", ")}`
    );
  }
  return null;
}

/**
 * Whether the adapter takes a bounded fetch specification. Only
 * `http_records` reaches a release-pinned endpoint; the manual adapters
 * project authored values and must not carry one.
 */
export function adapterTakesFetch(adapterId: string): boolean {
  return adapterId === "http_records";
}

/** Minimal structural view of a configuration field for fetch checks. */
export interface FetchConfigField {
  readonly key: string;
  readonly control: string;
  readonly maxLength?: number;
}

/** Minimal structural view of a fetch declaration for fetch checks. */
export interface FetchDeclarationInput {
  readonly urlTemplate: string;
  readonly format: string;
  readonly recordsPath?: string;
  readonly mapping: Readonly<Record<string, string>>;
  readonly maximumRecords?: number;
  readonly refreshSeconds?: number;
}

const PLACEHOLDER_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;
const MAX_FETCH_RECORDS = 500;
const MIN_FETCH_REFRESH = 60;
const MAX_FETCH_PATH = 200;

function placeholders(template: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const key = match[1];
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/**
 * Mirror of Go's `validateFetchSpec`: every rule here has a twin in
 * `apps/server/internal/contentdefs/catalog.go`, and the Server
 * re-validates at catalog load. Returns diagnostics; empty means the
 * declaration carries the same bounded mapping semantics the Server
 * implements.
 */
export function fetchSpecProblems(
  fetch: FetchDeclarationInput,
  configFields: readonly FetchConfigField[],
  outputFieldKeys: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  if (fetch.format !== "json" && fetch.format !== "csv") {
    problems.push(
      `fetch format ${JSON.stringify(fetch.format)} is not supported`,
    );
  }
  let url: URL | null = null;
  try {
    url = new URL(fetch.urlTemplate);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || url.hostname === "") {
    problems.push("fetch url template must be an absolute HTTPS URL");
  } else {
    if (url.hostname.includes("{") || url.hostname.includes("}")) {
      problems.push(
        "fetch url template may not place a placeholder in its scheme or host",
      );
    }
    if (url.username !== "" || url.password !== "") {
      problems.push("fetch url template may not carry credentials");
    }
  }
  const fields = new Map(configFields.map((field) => [field.key, field]));
  for (const key of placeholders(fetch.urlTemplate)) {
    const field = fields.get(key);
    if (!field) {
      problems.push(
        `fetch url template references unknown configuration ${JSON.stringify(key)}`,
      );
      continue;
    }
    if (!["text", "select", "integer", "number"].includes(field.control)) {
      problems.push(
        `fetch url placeholder ${JSON.stringify(key)} must name a text, select, integer, or number field`,
      );
    } else if (
      field.control === "text" &&
      (field.maxLength === undefined ||
        field.maxLength <= 0 ||
        field.maxLength > MAX_FETCH_PATH)
    ) {
      problems.push(
        `fetch url placeholder ${JSON.stringify(key)} must declare a maximum length of 1 to ${MAX_FETCH_PATH}`,
      );
    }
  }
  const mapping = fetch.mapping ?? {};
  if (Object.keys(mapping).length === 0) {
    problems.push("fetch specification declares no field mapping");
  }
  for (const [key, path] of Object.entries(mapping)) {
    if (!outputFieldKeys.has(key)) {
      problems.push(
        `fetch mapping targets undeclared output field ${JSON.stringify(key)}`,
      );
    }
    if (
      path === "" ||
      path.length > MAX_FETCH_PATH ||
      path.includes("{") ||
      path.includes("}")
    ) {
      problems.push(
        `fetch mapping for ${JSON.stringify(key)} is not a plain path`,
      );
    }
  }
  if (
    fetch.recordsPath !== undefined &&
    fetch.recordsPath !== "" &&
    (fetch.recordsPath.length > MAX_FETCH_PATH ||
      fetch.recordsPath.includes("{") ||
      fetch.recordsPath.includes("}"))
  ) {
    problems.push("fetch records path is not a plain path");
  }
  if (
    fetch.maximumRecords !== undefined &&
    (fetch.maximumRecords < 0 || fetch.maximumRecords > MAX_FETCH_RECORDS)
  ) {
    problems.push(
      `fetch maximum record count must be between 0 and ${MAX_FETCH_RECORDS}`,
    );
  }
  if (
    fetch.refreshSeconds !== undefined &&
    fetch.refreshSeconds !== 0 &&
    fetch.refreshSeconds < MIN_FETCH_REFRESH
  ) {
    problems.push(
      `fetch refresh interval must be at least ${MIN_FETCH_REFRESH} seconds`,
    );
  }
  return problems;
}
