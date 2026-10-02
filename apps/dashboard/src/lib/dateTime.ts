/** Display an instant in the reader's locale and browser timezone. */
export function formatDateTime(
  value: string | null | undefined,
  locale: string,
  missing = "—",
): string {
  if (!value) return missing;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return missing;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

// Convert a stored RFC 3339 instant into the local wall-clock value accepted by
// DateTimeInput (`YYYY-MM-DDTHH:mm`).
export function rfc3339ToLocalDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

// Return the local calendar date accepted by a date input (`YYYY-MM-DD`).
export function localDateInputValue(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Convert a local wall-clock datetime back to the RFC 3339 instant expected by
// the server.
export function localDateTimeToRfc3339(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}
