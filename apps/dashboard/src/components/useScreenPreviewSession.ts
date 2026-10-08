import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";

/**
 * One lease/recovery policy for grid cards and Screen Detail. The server owns
 * capture deduplication; clients only nudge a stale session, never repeatedly
 * force a renderer capture.
 */
export function useScreenPreviewSession({
  screenId,
  csrfToken,
  enabled,
  capturedAt,
  protectedPreview = false,
}: {
  screenId: string;
  csrfToken: string | undefined;
  enabled: boolean;
  capturedAt?: string | null;
  protectedPreview?: boolean;
}) {
  const [error, setError] = useState<Error | null>(null);
  const lastNudge = useRef(0);

  useEffect(() => {
    if (!enabled || !csrfToken) return;
    let active = true;
    let inFlight = false;
    const renew = async (forceCapture: boolean) => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        await api.renewScreenPreview(screenId, forceCapture, csrfToken);
        if (active) setError(null);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause : new Error("Preview renewal failed"));
      } finally {
        inFlight = false;
      }
    };

    // A newly watched screen needs its first frame immediately.
    void renew(true);
    const lease = window.setInterval(() => void renew(false), 30_000);
    return () => {
      active = false;
      window.clearInterval(lease);
    };
  }, [screenId, csrfToken, enabled]);

  useEffect(() => {
    if (!enabled || !csrfToken || protectedPreview) return;
    const capturedMillis = capturedAt ? Date.parse(capturedAt) : NaN;
    const stale = !Number.isFinite(capturedMillis) || Date.now() - capturedMillis > 45_000;
    if (!stale) return;

    // The server guards the actual capture request. This local guard also
    // prevents metadata polling from creating excess HTTP traffic.
    const now = Date.now();
    if (now - lastNudge.current < 15_000) return;
    lastNudge.current = now;
    void api.renewScreenPreview(screenId, false, csrfToken).catch(() => {
      // Normal lease renewal reports session failures; the next poll retries.
    });
  }, [screenId, csrfToken, enabled, capturedAt, protectedPreview]);

  useEffect(() => {
    lastNudge.current = 0;
  }, [screenId]);

  return { error };
}
