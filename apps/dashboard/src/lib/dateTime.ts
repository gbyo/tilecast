// Convert a stored RFC 3339 instant into the local wall-clock value accepted by
// DateTimeInput (`YYYY-MM-DDTHH:mm`).
export function rfc3339ToLocalDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

// Convert a local wall-clock datetime back to the RFC 3339 instant expected by
// the server.
export function localDateTimeToRfc3339(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}
