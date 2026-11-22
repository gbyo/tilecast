/**
 * Resolve variables only inside Website URL query *values*. Never expand
 * authority, path, parameter names or fragments: the author-approved host
 * and navigation policy must remain unchanged.
 */
import type { ManifestDataSource } from "../compat/projection/content-types";
import { normalizeSource } from "../compat/projection/datasource";

export interface WebsiteUrlContext {
  screenId: string;
  at: Date;
  dataSourceId?: string;
  dataSources?: ReadonlyMap<string, ManifestDataSource>;
  /** Resolve date/time placeholders only when the Website surface mounts. */
  deferClock?: boolean;
}

const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_.:-]*)\}/g;
const CLOCK_TOKEN = /\{(date|time|datetime)\}/g;
const MAX_URL_LENGTH = 2048;
const DATE_PAD = (value: number) => String(value).padStart(2, "0");

function dateParts(at: Date) {
  const date = `${at.getFullYear()}-${DATE_PAD(at.getMonth() + 1)}-${DATE_PAD(at.getDate())}`;
  const time = `${DATE_PAD(at.getHours())}:${DATE_PAD(at.getMinutes())}:${DATE_PAD(at.getSeconds())}`;
  return { date, time, datetime: `${date}T${time}` };
}

/**
 * Returns null rather than navigating when a requested value is missing,
 * malformed or produces an oversized URL. Ordinary URLs are kept byte-for-byte.
 */
export function resolveWebsiteUrl(
  template: string,
  context: WebsiteUrlContext,
): string | null {
  // Encoded braces in an ordinary URL (for example a JSON query value) are
  // literal data, not a template opt-in. Only author-written braces expand.
  if (!template.includes("{")) return template;
  if (!Number.isFinite(context.at.getTime())) return null;
  let url: URL;
  try {
    url = new URL(template);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return null;
  }
  const queryStart = template.indexOf("?");
  const fragmentStart = template.indexOf("#");
  if (
    queryStart < 0 ||
    (fragmentStart >= 0 && fragmentStart < queryStart) ||
    /[{}]/.test(template.slice(0, queryStart)) ||
    (fragmentStart >= 0 && /[{}]/.test(template.slice(fragmentStart)))
  ) {
    return null;
  }

  const { date, time, datetime } = dateParts(context.at);
  const source = context.dataSourceId
    ? context.dataSources?.get(context.dataSourceId)
    : undefined;
  const data = source ? normalizeSource(source, context.at) : null;
  const values: Record<string, string> = {
    "screen.id": context.screenId,
    date: context.deferClock ? "{date}" : date,
    time: context.deferClock ? "{time}" : time,
    datetime: context.deferClock ? "{datetime}" : datetime,
  };

  const select = (key: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    if (!key.startsWith("data.") || !data || data.unavailable || data.hidden) {
      return undefined;
    }
    const path = key.slice(5);
    if (path === "json") {
      return JSON.stringify(
        data.records.length
          ? data.records.map((record) => record.rawFields)
          : data.rawObjectValues,
      );
    }
    if (path === "values") {
      const firstField = data.records[0]
        ? Object.keys(data.records[0].rawFields)[0]
        : undefined;
      if (!firstField) return undefined;
      return JSON.stringify(
        data.records.map((record) => record.rawFields[firstField] ?? ""),
      );
    }
    const match = /^([a-zA-Z_][\w-]*)(?::(\d{1,3}))?$/.exec(path);
    if (!match) return undefined;
    const fieldName = match[1];
    if (!fieldName) return undefined;
    const index = match[2] ? Number(match[2]) : 0;
    // Own properties only: `constructor` or `__proto__` must not resolve.
    const own = (fields: Record<string, string> | undefined) =>
      fields && Object.prototype.hasOwnProperty.call(fields, fieldName)
        ? fields[fieldName]
        : undefined;
    if (data.records.length) return own(data.records[index]?.rawFields);
    return index === 0 ? own(data.rawObjectValues) : undefined;
  };

  try {
    const parts: string[] = [];
    for (const part of url.search.slice(1).split("&")) {
      const separator = part.indexOf("=");
      const name = separator < 0 ? part : part.slice(0, separator);
      const value = separator < 0 ? "" : part.slice(separator + 1);
      if (/[{}]|%7[bd]/i.test(name)) return null;
      if (!/[{}]/.test(value)) {
        parts.push(part);
        continue;
      }
      // Match authored tokens in the raw query and leave percent-encoded data intact.
      if (/[{}]/.test(value.replace(TOKEN, ""))) return null;
      let invalid = false;
      const replaced = value.replace(TOKEN, (_match, key: string) => {
        const raw = select(key);
        if (raw === undefined || raw === null) {
          invalid = true;
          return "";
        }
        // Raw braces distinguish deferred tokens from encoded literal values.
        return context.deferClock &&
          (key === "date" || key === "time" || key === "datetime")
          ? raw
          : encodeURIComponent(raw);
      });
      if (invalid) return null;
      parts.push(`${name}=${replaced}`);
    }
    url.search = parts.join("&");
    const result = url.toString();
    return result.length <= MAX_URL_LENGTH ? result : null;
  } catch {
    return null;
  }
}

/**
 * Expand only the clock placeholders intentionally deferred by the Website
 * projector. This is called when a Website surface is mounted, not whenever
 * the projector periodically refreshes the Playlist.
 */
export function resolveWebsiteClockUrl(url: string, at: Date): string | null {
  if (!Number.isFinite(at.getTime())) return null;
  const values = dateParts(at);
  const result = url.replace(CLOCK_TOKEN, (_token, key: string) =>
    encodeURIComponent(values[key as keyof typeof values]),
  );
  return result.length <= MAX_URL_LENGTH ? result : null;
}
