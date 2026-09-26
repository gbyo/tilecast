/**
 * Brand Bug / Watermark resolution: which corner marks should be on screen
 * right now. Kept as a tiny global beside the countdown resolver because
 * renderer scripts run directly in the sandboxed page without module imports,
 * and shared so the renderer surface and its tests evaluate the exact same
 * window, priority, and per-corner rules.
 *
 * Unlike Countdown Bar, several marks can be visible at once — but only one per
 * corner, so two instances can never stack into an unreadable pile.
 */
export interface TilecastBrandBugPlugin {
  id: string;
  type: string;
  version: number;
  config: {
    name?: string;
    corner: string;
    imageAssetId?: string | null;
    imageVariantId?: string | null;
    imageAvailableFrom?: string | null;
    imageExpiresAt?: string | null;
    text?: string;
    widthPercent: number;
    textSizePercent: number;
    opacityPercent: number;
    marginPercent: number;
    textColor: string;
    backgroundStyle: string;
    startsAt?: string | null;
    endsAt?: string | null;
    priority: number;
  };
}

export interface TilecastActiveBrandBug {
  id: string;
  corner: "top_left" | "top_right" | "bottom_left" | "bottom_right";
  /** tcmedia:// URL of the cached logo, or null for a text-only mark. */
  imageSrc: string | null;
  text: string;
  widthPercent: number;
  textSizePercent: number;
  opacityPercent: number;
  marginPercent: number;
  textColor: string;
  backgroundStyle: "none" | "scrim";
  priority: number;
}

export interface TilecastBrandBugResolver {
  resolve(
    plugins: readonly TilecastBrandBugPlugin[] | null | undefined,
    localNow: Date,
    clockOffsetMs?: number,
    mediaUrl?: (assetId: string, variantId: string) => string,
  ): TilecastActiveBrandBug[];
}

export const tilecastBrandBug: TilecastBrandBugResolver = (() => {
  const CORNERS = [
    "top_left",
    "top_right",
    "bottom_left",
    "bottom_right",
  ] as const;

  function clamp(value: number, low: number, high: number, fallback: number) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(value, low), high);
  }

  /**
   * An unset bound is open-ended; an unparsable one is treated as unset rather
   * than hiding the mark, so a malformed date cannot silently blank a logo an
   * installation expects to be permanent.
   */
  function withinWindow(
    startsAt: string | null | undefined,
    endsAt: string | null | undefined,
    now: number,
  ): boolean {
    const start = Date.parse(startsAt ?? "");
    if (Number.isFinite(start) && now < start) return false;
    const end = Date.parse(endsAt ?? "");
    if (Number.isFinite(end) && now >= end) return false;
    return true;
  }

  return Object.freeze({
    resolve(
      plugins: readonly TilecastBrandBugPlugin[] | null | undefined,
      localNow: Date,
      clockOffsetMs = 0,
      mediaUrl: (assetId: string, variantId: string) => string = (
        assetId,
        variantId,
      ) => `tcmedia://variant/${assetId}/${variantId}`,
    ): TilecastActiveBrandBug[] {
      const now = localNow.getTime() + clockOffsetMs;
      const byCorner = new Map<string, TilecastActiveBrandBug>();
      for (const plugin of plugins ?? []) {
        if (plugin.type !== "brand_bug" || plugin.version !== 1) continue;
        const config = plugin.config;
        if ((CORNERS as readonly string[]).indexOf(config.corner) < 0) continue;
        if (!withinWindow(config.startsAt, config.endsAt, now)) continue;
        // Without a resolved variant there is no cached file to draw, so the
        // mark falls back to its text exactly as a text-only mark would.
        const imageSrc =
          config.imageAssetId &&
          config.imageVariantId &&
          withinWindow(config.imageAvailableFrom, config.imageExpiresAt, now)
            ? mediaUrl(config.imageAssetId, config.imageVariantId)
            : null;
        const text = (config.text ?? "").trim();
        if (!imageSrc && text.length === 0) continue;
        const candidate: TilecastActiveBrandBug = {
          id: plugin.id,
          corner: config.corner as TilecastActiveBrandBug["corner"],
          imageSrc,
          text,
          widthPercent: clamp(config.widthPercent, 2, 40, 12),
          textSizePercent: clamp(config.textSizePercent, 1, 12, 3),
          opacityPercent: clamp(config.opacityPercent, 10, 100, 100),
          marginPercent: clamp(config.marginPercent, 0, 20, 3),
          textColor: /^#[0-9a-fA-F]{6}$/.test(config.textColor)
            ? config.textColor
            : "#ffffff",
          backgroundStyle:
            config.backgroundStyle === "scrim" ? "scrim" : "none",
          priority: Number.isFinite(config.priority) ? config.priority : 0,
        };
        const held = byCorner.get(candidate.corner);
        if (
          !held ||
          candidate.priority > held.priority ||
          (candidate.priority === held.priority &&
            candidate.id.localeCompare(held.id) < 0)
        ) {
          byCorner.set(candidate.corner, candidate);
        }
      }
      // Corner order rather than input order, so the surface and its tests see
      // one stable sequence regardless of how the manifest was assembled.
      const active: TilecastActiveBrandBug[] = [];
      for (const corner of CORNERS) {
        const mark = byCorner.get(corner);
        if (mark) active.push(mark);
      }
      return active;
    },
  });
})();
