/**
 * Capture readiness for Layout thumbnails
 * (Widget Preview Parity Fixes, Bug 2).
 *
 * Layout thumbnail generation must wait until embedded V2 Widgets have
 * reached a settled lifecycle state instead of capturing after an arbitrary
 * delay. The coordinator is owned by the Layout editor: live zone previews
 * register by placement id and report their WidgetMountState through it, and
 * each capture trigger waits for the capture-relevant set before rasterizing.
 *
 * Failure and timeout never produce a capture: a zone that cannot settle
 * would otherwise be stored as a blank/half-rendered rectangle. Skipping is
 * always safe because the draft save has already succeeded and the next
 * save retries the thumbnail.
 */
import { LAYOUT_PREVIEW_CAPTURE_VERSION } from "../../content/widgetPreviewCapture";

export type CaptureZoneStatus = "pending" | "settled" | "failed";

export interface LayoutCaptureWaitResult {
  /** True only when every relevant zone settled without failure or timeout. */
  readonly ok: boolean;
  /** Zone ids that failed or were still pending when the wait gave up. */
  readonly failedIds: readonly string[];
}

/** Upper bound for one thumbnail wait. WidgetMount gives up after 10s. */
export const LAYOUT_CAPTURE_SETTLE_TIMEOUT_MS = 10_000;

/**
 * Whether the editor should (re)generate a Layout thumbnail on this visit.
 * A missing preview, or one stored by an older capture pipeline, is stale:
 * it may show blank or half-rendered Widget zones. Regeneration happens at
 * most once per editor session (see the editor's attempt guard), never on
 * list loads, and always under the server's revision check.
 */
export function layoutPreviewNeedsCapture(
  previewImageUrl: string | undefined,
  captureVersion: number | undefined | null,
): boolean {
  return !previewImageUrl || captureVersion !== LAYOUT_PREVIEW_CAPTURE_VERSION;
}

const POLL_INTERVAL_MS = 100;

export class LayoutCaptureCoordinator {
  private readonly zones = new Map<string, CaptureZoneStatus>();
  private readonly seen = new Set<string>();

  /** A live V2 zone preview starts out pending. Unknown ids stay unknown. */
  register(id: string): void {
    this.seen.add(id);
    if (!this.zones.has(id)) this.zones.set(id, "pending");
  }

  /** Map one Widget lifecycle report onto capture readiness. */
  reportMountState(
    id: string,
    state: "ready" | "empty" | "error" | "pending",
  ): void {
    if (!this.zones.has(id)) return;
    this.zones.set(
      id,
      state === "error"
        ? "failed"
        : state === "pending"
          ? "pending"
          : "settled",
    );
  }

  /** A zone that unmounts (or stops being a V2 Widget) leaves the set. */
  unregister(id: string): void {
    this.zones.delete(id);
  }

  /** Observe one zone, for tests and debugging. */
  status(id: string): CaptureZoneStatus | undefined {
    return this.zones.get(id);
  }

  /**
   * Resolve when every relevant zone is settled. Zones registered at
   * wait-start beyond the expected set (playlist zones currently showing a
   * V2 Widget) join the wait so a half-loaded rotation cannot be captured.
   * Any failure — or the timeout — resolves ok:false so the caller skips
   * the capture instead of storing a partial thumbnail.
   */
  async waitForSettled(
    expected: readonly string[],
    timeoutMs: number = LAYOUT_CAPTURE_SETTLE_TIMEOUT_MS,
  ): Promise<LayoutCaptureWaitResult> {
    const wanted = new Set(expected);
    const relevant = [...new Set([...expected, ...this.zones.keys()])];
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const failed = relevant.filter((id) => this.zones.get(id) === "failed");
      if (failed.length > 0) return { ok: false, failedIds: failed };
      const outstanding = relevant.filter((id) => {
        const status = this.zones.get(id);
        if (status === "settled") return false;
        if (status === "pending") return true;
        // Unregistered: a zone that was seen and left (deleted placement,
        // rotated playlist item) has nothing capturable. An expected zone
        // that never registered may still mount (definitions in flight),
        // so it stays outstanding until the timeout.
        return wanted.has(id) && !this.seen.has(id);
      });
      if (outstanding.length === 0) return { ok: true, failedIds: [] };
      if (Date.now() >= deadline) return { ok: false, failedIds: outstanding };
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}
