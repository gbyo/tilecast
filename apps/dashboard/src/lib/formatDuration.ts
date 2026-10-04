/** Clock notation uses total minutes, with whole seconds and no unit labels. */
export function formatDurationClock(
  seconds: number | null | undefined,
): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}
