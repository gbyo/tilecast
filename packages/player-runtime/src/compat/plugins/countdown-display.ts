/**
 * Compact countdown vocabulary shared by temporal cards in Studio, Android,
 * and the Linux renderer. Kept as a tiny global because renderer scripts run
 * directly in the sandboxed page without module imports.
 */
export interface TilecastCountdownDisplay {
  compact(remainingMilliseconds: number): string;
}

export const tilecastCountdownDisplay: TilecastCountdownDisplay = Object.freeze(
  {
    compact(remainingMilliseconds: number): string {
      if (remainingMilliseconds <= 0) return "Now";
      const totalSeconds = Math.floor(remainingMilliseconds / 1_000);
      const days = Math.floor(totalSeconds / 86_400);
      const hours = Math.floor((totalSeconds % 86_400) / 3_600);
      const minutes = Math.floor((totalSeconds % 3_600) / 60);
      const seconds = totalSeconds % 60;
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m ${seconds}s`;
      return `${seconds}s`;
    },
  },
);
