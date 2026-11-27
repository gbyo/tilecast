// Intl formatters are costly to build and Studio formats many values per
// render (data-source previews, bindings), so these keep one per locale and
// option set.
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

export function cachedNumberFormat(
  locale: string | string[] | undefined,
  options: Intl.NumberFormatOptions,
) {
  const key = `${String(locale)}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

/**
 * The time zone is required: without one the format follows the device's
 * zone at construction, which a cached format would keep after it changed.
 */
export function cachedDateTimeFormat(
  locale: string | string[] | undefined,
  options: Intl.DateTimeFormatOptions & { timeZone: string },
) {
  const key = `${String(locale)}|${JSON.stringify(options)}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}
