const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;

/** Format a byte count with binary units and the person's format locale. */
export function formatBytes(
  bytes: number | null | undefined,
  locale: string,
): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(amount);
  return `${number} ${units[unit]}`;
}
