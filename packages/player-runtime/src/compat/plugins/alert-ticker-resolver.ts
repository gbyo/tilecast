import type { TilecastManifestPluginEntry } from "./countdown-bar-resolver";
/**
 * Emergency Alerts ticker resolution: whether a live alert bar should be on
 * screen right now, and how fast its text should travel. Kept as a tiny global
 * beside the Countdown Bar resolver because renderer scripts run directly in the
 * sandboxed page without module imports.
 *
 * Unlike a Countdown Bar, there is no schedule to evaluate — the server only
 * publishes a ticker while an alert is being answered. What is evaluated locally
 * is the expiry, so a player running on a cached manifest takes the bar down on
 * its own rather than keeping an alert on screen that may already be over.
 */
export interface TilecastAlertTickerPlugin {
  id: string;
  type: string;
  version: number;
  config: {
    name?: string;
    message: string;
    severity?: string;
    event?: string;
    displayMode: "overlay" | "push";
    heightPx: number;
    speed: "slow" | "medium" | "fast";
    priority: number;
    expiresAt: string;
  };
}

export interface TilecastActiveAlertTicker {
  id: string;
  message: string;
  severity: string;
  displayMode: "overlay" | "push";
  heightPx: number;
  priority: number;
  /** Travel rate of the scrolling message, in CSS pixels per second. */
  pixelsPerSecond: number;
  expiresAt: string;
}

export interface TilecastAlertTickerResolver {
  resolve(
    plugins: TilecastManifestPluginEntry[] | null | undefined,
    localNow: Date,
    clockOffsetMs?: number,
  ): TilecastActiveAlertTicker | null;
}

export const tilecastAlertTicker: TilecastAlertTickerResolver = (() => {
  // Named speeds rather than a pixel rate in the manifest: the same alert has to
  // read at the same pace on displays of different widths and densities.
  const RATES = { slow: 60, medium: 120, fast: 200 } as const;

  return Object.freeze({
    resolve(
      plugins: TilecastManifestPluginEntry[] | null | undefined,
      localNow: Date,
      clockOffsetMs = 0,
    ): TilecastActiveAlertTicker | null {
      const now = localNow.getTime() + clockOffsetMs;
      const active: TilecastActiveAlertTicker[] = [];
      for (const entry of plugins ?? []) {
        if (entry.type !== "alert_ticker" || entry.version !== 1) continue;
        const plugin = entry as TilecastAlertTickerPlugin;
        const expires = Date.parse(plugin.config.expiresAt ?? "");
        // An unreadable or passed expiry hides the bar. An emergency surface has
        // to fail toward showing nothing rather than toward showing something
        // stale as though it were current.
        if (!Number.isFinite(expires) || expires <= now) continue;
        const message = plugin.config.message?.trim() ?? "";
        if (message.length === 0) continue;
        active.push({
          id: plugin.id,
          message,
          severity: plugin.config.severity?.trim() ?? "",
          displayMode: plugin.config.displayMode,
          heightPx: Math.min(Math.max(plugin.config.heightPx, 40), 320),
          priority: plugin.config.priority,
          pixelsPerSecond:
            RATES[plugin.config.speed as keyof typeof RATES] ?? RATES.medium,
          expiresAt: new Date(expires).toISOString(),
        });
      }
      active.sort(
        (left, right) =>
          right.priority - left.priority ||
          Date.parse(right.expiresAt) - Date.parse(left.expiresAt) ||
          left.id.localeCompare(right.id),
      );
      return active[0] ?? null;
    },
  });
})();
