/**
 * Canonical library thumbnails for Widgets that were just saved.
 *
 * Saving never waits for a thumbnail. After the Server accepts a save, the
 * editor queues the saved Widget here and this host, mounted once in the
 * Studio shell, renders the real component at the canonical 960x540 frame,
 * captures it, and uploads it. Living in the shell keeps a capture alive
 * when the editor route changes right after saving (a new Widget's route
 * becomes /widgets/<id>, or the author goes back).
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import { useAuth } from "@/auth/AuthProvider";
import { V2ZonePreview } from "@/components/layout-editor/V2ZonePreview";
import { contentKeys } from "@/data/content";
import { useOrganizationRegionalProfile } from "@/settings/regionalProfile";
import {
  captureWidgetPreview,
  WIDGET_THUMBNAIL_FRAME,
} from "@/content/widgetPreviewCapture";
import {
  finishWidgetSnapshot,
  subscribeToWidgetSnapshots,
  widgetSnapshotJobs,
  type WidgetSnapshotJob,
} from "./snapshotQueue";

// A capture that never settles must not hold the queue forever.
const CAPTURE_TIMEOUT_MS = 30_000;

export function WidgetSnapshotQueue() {
  const queued = useSyncExternalStore(
    subscribeToWidgetSnapshots,
    widgetSnapshotJobs,
  );
  const job = queued[0];
  if (!job) return null;
  // The key restarts the capture when a newer save of the same Widget
  // takes this job's place, so a stale capture never reaches the Server.
  return (
    <SnapshotCapture key={`${job.asset.id}:${job.asset.updatedAt}`} job={job} />
  );
}

function SnapshotCapture({ job }: { job: WidgetSnapshotJob }) {
  const { t } = useTranslation("content");
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const queryClient = useQueryClient();
  const regional = useOrganizationRegionalProfile();
  const frameRef = useRef<HTMLDivElement>(null);
  const frame = job.renderFrame ?? WIDGET_THUMBNAIL_FRAME;
  const [state, setState] = useState<"pending" | "settled" | "failed">(
    "pending",
  );

  // The language and session token can change while a capture runs; the
  // capture reads them when it needs them without restarting.
  const storeThumbnail = useEffectEvent(
    async (element: HTMLElement, signal: AbortSignal) => {
      const image = await captureWidgetPreview(element, t, frame);
      if (signal.aborted) return;
      await api.uploadWidgetPreview(job.asset.id, image, csrf, signal);
      if (signal.aborted) return;
      void queryClient.invalidateQueries({ queryKey: contentKeys.assets });
    },
  );

  // One deadline covers the whole job, rendering and upload included, so a
  // capture that never settles cannot hold the queue.
  useEffect(() => {
    const timer = window.setTimeout(
      () => setState("failed"),
      CAPTURE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (state === "pending") return;
    if (state === "failed") {
      job.onFailed();
      finishWidgetSnapshot(job);
      return;
    }
    const abort = new AbortController();
    // Two frames, so the browser has laid out and painted the Widget.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void (async () => {
          try {
            const element = frameRef.current;
            if (!element) throw new Error("Preview is not ready yet.");
            await storeThumbnail(element, abort.signal);
          } catch {
            if (!abort.signal.aborted) job.onFailed();
          } finally {
            if (!abort.signal.aborted) finishWidgetSnapshot(job);
          }
        })();
      }),
    );
    return () => {
      abort.abort();
      cancelAnimationFrame(raf);
    };
  }, [state, job]);

  // Locale, time zone, and hour cycle shape the rendered Widget, so the
  // capture waits for the organization's regional settings.
  if (!regional.ready) return null;
  return (
    <div
      className="widget-snapshot-backfill"
      aria-hidden="true"
      // The Widget renders at the width it is designed for, so its own
      // container queries see the geometry it was built to handle.
      style={{ width: frame.width }}
    >
      <div ref={frameRef}>
        <V2ZonePreview
          provider={job.asset.widget?.provider ?? ""}
          asset={job.asset}
          width={frame.width}
          height={frame.height}
          onState={(next) => {
            if (next.state === "ready" || next.state === "empty")
              setState((current) =>
                current === "pending" ? "settled" : current,
              );
            else if (next.state === "error")
              setState((current) =>
                current === "pending" ? "failed" : current,
              );
          }}
        />
      </div>
    </div>
  );
}
