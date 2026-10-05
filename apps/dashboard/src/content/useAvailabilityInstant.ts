import { useEffect, useState } from "react";
import {
  nextAvailabilityTransition,
  type AvailabilityWindow,
} from "@tilecast/presentation-model";

/** Studio clock only; the Presentation Model decides each window boundary. */
export function useAvailabilityInstant(
  windows: ReadonlyArray<AvailabilityWindow | null | undefined>,
  fixedAt?: number | null,
): number {
  const [liveAt, setLiveAt] = useState(Date.now);
  useEffect(() => {
    if (fixedAt != null) return;
    let active = true;
    let timer: number | undefined;
    const refresh = () => {
      if (!active) return;
      if (timer !== undefined) window.clearTimeout(timer);
      const now = Date.now();
      setLiveAt(now);
      const next = nextAvailabilityTransition(windows, new Date(now));
      if (next)
        timer = window.setTimeout(
          refresh,
          Math.min(2_147_483_647, Math.max(0, next.getTime() - now) + 1),
        );
    };
    const visible = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [windows, fixedAt]);
  return fixedAt ?? liveAt;
}
