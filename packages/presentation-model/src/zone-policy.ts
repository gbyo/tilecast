export type ZoneFallback = "hide" | "background" | "previous";
export type ZoneFallbackResult = "current" | ZoneFallback;

/** Resolve an advance from a zero-based current occurrence. */
export function resolvePlaylistAdvance(
  index: number,
  count: number,
  loop = true,
) {
  if (count <= 0) return { nextIndex: 0, canAdvance: false };
  const current = loop ? index % count : Math.min(index, count - 1);
  const canAdvance = loop || current + 1 < count;
  return {
    nextIndex: canAdvance ? (current + 1) % count : current,
    canAdvance,
  };
}

export function resolveNativeVideoLoop(
  item: {
    kind: string;
    loop?: boolean;
    videoStartOffsetMs?: number | null;
    videoEndOffsetMs?: number | null;
  },
  count: number,
  loop = true,
): boolean {
  return (
    item.kind === "video" &&
    !item.videoStartOffsetMs &&
    !item.videoEndOffsetMs &&
    Boolean(item.loop || (loop && count === 1))
  );
}

/** Choose fallback visibility; consumers retain and release their own media. */
export function resolveZoneFallback(
  failed: boolean,
  fallback: ZoneFallback,
  hasPrevious: boolean,
): ZoneFallbackResult {
  if (!failed) return "current";
  if (fallback === "previous") return hasPrevious ? "previous" : "background";
  return fallback;
}
