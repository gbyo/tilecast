import type { TFunction } from "i18next";
import type { Screen, ScreenStatus } from "../api/types";
import type { WireScreenPreview as ScreenPreview } from "../api/domains/screens";

type ScreensT = TFunction<"screens"> | undefined;

export type LivePreviewState =
  "loading" | "live" | "offline" | "stale" | "unavailable" | "capture-error";

export type PreviewAgeTone = "fresh" | "aging" | "old";

const offlineStatuses = new Set<ScreenStatus>([
  "offline",
  "disabled",
  "revoked",
]);

export function livePreviewState(
  screen: Screen | undefined,
  preview: ScreenPreview | undefined,
  now = Date.now(),
): LivePreviewState {
  if (!screen || !preview) return "loading";
  if (offlineStatuses.has(screen.status)) return "offline";
  if (screen.status === "stale" && !preview.imageAvailable) return "offline";
  // A known-safe transient failure can retain the last successful image.
  // Never call that image live: the attempted refresh failed.
  if (preview.status === "capture_error")
    return preview.imageAvailable && preview.capturedAt
      ? "stale"
      : "capture-error";
  if (preview.status === "unavailable") return "unavailable";
  if (!preview.imageAvailable || !preview.capturedAt) return "loading";
  const captureAge = now - new Date(preview.capturedAt).getTime();
  if (
    screen.status === "stale" ||
    !Number.isFinite(captureAge) ||
    captureAge > 45_000
  )
    return "stale";
  return "live";
}

export function previewAge(
  capturedAt: string,
  now = Date.now(),
  t?: ScreensT,
): { label: string; tone: PreviewAgeTone } | null {
  const capturedAtMillis = new Date(capturedAt).getTime();
  if (!Number.isFinite(capturedAtMillis)) return null;

  const ageMillis = Math.max(0, now - capturedAtMillis);
  const ageSeconds = Math.floor(ageMillis / 1_000);
  let label: string;

  if (ageSeconds < 60) {
    label =
      t?.("livePreview.age.seconds", { value: ageSeconds }) ??
      `${ageSeconds}s ago`;
  } else if (ageSeconds < 3_600) {
    const value = Math.floor(ageSeconds / 60);
    label = t?.("livePreview.age.minutes", { value }) ?? `${value}m ago`;
  } else if (ageSeconds < 86_400) {
    const value = Math.floor(ageSeconds / 3_600);
    label = t?.("livePreview.age.hours", { value }) ?? `${value}h ago`;
  } else {
    const value = Math.floor(ageSeconds / 86_400);
    label = t?.("livePreview.age.days", { value }) ?? `${value}d ago`;
  }

  const tone: PreviewAgeTone =
    ageMillis <= 45_000 ? "fresh" : ageMillis <= 120_000 ? "aging" : "old";
  return { label, tone };
}

/**
 * What the Screens grid shows at the seam between a preview and its details.
 * `none` covers every state that is healthy or that another indicator already
 * explains (loading, offline, protected/unavailable), so those stay quiet.
 */
export type PreviewRailState = "none" | "aging" | "overdue" | "error";

export function previewRailState(
  state: LivePreviewState,
  capturedAt: string | null | undefined,
  now = Date.now(),
): PreviewRailState {
  if (state === "capture-error") return "error";
  if (state !== "stale" || !capturedAt) return "none";
  const tone = previewAge(capturedAt, now)?.tone;
  if (tone === "aging") return "aging";
  if (tone === "old") return "overdue";
  return "none";
}

/**
 * Stable 0-1 fraction derived from the screen ID (FNV-1a). Cards that go stale
 * together use it to start their sweep at different points of the cycle.
 */
export function previewRailPhase(screenId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < screenId.length; index += 1) {
    hash ^= screenId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

export function previewUnavailableMessage(
  failureStatus?: string,
  t?: ScreensT,
) {
  if (failureStatus?.startsWith("sensitive_"))
    return (
      t?.("livePreview.unavailable.protected") ??
      "Preview is paused while a protected player screen is open."
    );
  return (
    t?.("livePreview.unavailable.notYet") ??
    "A preview is not available from this player yet."
  );
}
