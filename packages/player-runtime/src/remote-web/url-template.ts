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
}

const TOKEN = /\{([a-zA-Z][a-zA-Z0-9_.:-]*)\}/g;
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
  if (!template.includes("{") && !/%7b/i.test(template)) return template;
  if (!Number.isFinite(context.at.getTime())) return null;
  let url: URL;
  try {
    url = new URL(template);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  if (/[{}]/.test(decodeURIComponent(url.pathname)) || /[{}]/.test(decodeURIComponent(url.hash))) return null;

  const { date, time, datetime } = dateParts(context.at);
  const source = context.dataSourceId
    ? context.dataSources?.get(context.dataSourceId)
    : undefined;
  const data = source ? normalizeSource(source, context.at) : null;
  const values: Record<string, string> = {
    "screen.id": context.screenId,
    date, time, datetime,
  };

  const select = (key: string): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    if (!key.startsWith("data.") || !data || data.unavailable || data.hidden) return undefined;
    const path = key.slice(5);
    if (path === "json") {
      return JSON.stringify(data.records.length
        ? data.records.map((record) => record.rawFields)
        : data.rawObjectValues);
    }
    if (path === "values") {
      const firstField = data.records[0] ? Object.keys(data.records[0].rawFields)[0] : undefined;
      return firstField
        ? JSON.stringify(data.records.map((record) => record.rawFields[firstField] ?? ""))
        : undefined;
    }
    const match = /^([a-zA-Z_][\w-]*)(?::(\d{1,3}))?$/.exec(path);
    if (!match) return undefined;
    const fieldName = match[1];
    if (!fieldName) return undefined;
    const index = match[2] ? Number(match[2]) : 0;
    return data.records.length
      ? data.records[index]?.rawFields[fieldName]
      : (index === 0 ? data.rawObjectValues[fieldName] : undefined);
  };

  try {
    const params = new URLSearchParams();
    for (const [name, value] of url.searchParams) {
      if (/[{}]/.test(name)) return null;
      if (!/[{}]/.test(value)) {
        params.append(name, value);
        continue;
      }
      // Check the template, not substituted content: JSON values contain braces.
      if (/[{}]/.test(value.replace(TOKEN, ""))) return null;
      let invalid = false;
      const replaced = value.replace(TOKEN, (_match, key: string) => {
        const raw = select(key);
        if (raw === undefined || raw === null) {
          invalid = true;
          return "";
        }
        return String(raw);
      });
      if (invalid) return null;
      params.append(name, replaced);
    }
    url.search = params.toString();
    const result = url.toString();
    if (result.length > 2048 || result.includes("{") || result.includes("}")) return null;
    return result;
  } catch {
    return null;
  }
}
