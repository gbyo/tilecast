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
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { Asset } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { V2ZonePreview } from "@/components/layout-editor/V2ZonePreview";
import { contentKeys } from "@/data/content";
import { useOrganizationRegionalProfile } from "@/settings/regionalProfile";
import {
  captureWidgetPreview,
  WIDGET_THUMBNAIL_FRAME,
} from "@/content/widgetPreviewCapture";

export type WidgetSnapshotJob = {
  /** The Widget as the Server saved it. */
  readonly asset: Asset;
  /** Called once when the thumbnail could not be captured or stored. */
  readonly onFailed: () => void;
};

// A capture that never settles must not hold the queue forever.
const CAPTURE_TIMEOUT_MS = 30_000;

let jobs: readonly WidgetSnapshotJob[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly WidgetSnapshotJob[]) {
  jobs = next;
  for (const listener of listeners) listener();
}

/** Queue a saved Widget's thumbnail. A newer save of the same Widget replaces an older one. */
export function enqueueWidgetSnapshot(job: WidgetSnapshotJob) {
  publish([...jobs.filter((entry) => entry.asset.id !== job.asset.id), job]);
}

function finish(job: WidgetSnapshotJob) {
  publish(jobs.filter((entry) => entry !== job));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test seam: forget queued work between tests. */
export function resetWidgetSnapshotQueue() {
  publish([]);
}

export function WidgetSnapshotQueue() {
  const queued = useSyncExternalStore(subscribe, () => jobs);
  const job = queued[0];
  if (!job) return null;
  return (
    <SnapshotCapture
      key={`${job.asset.id}:${job.asset.updatedAt}`}
      job={job}
      onDone={() => finish(job)}
    />
  );
}

function SnapshotCapture({
  job,
  onDone,
}: {
  job: WidgetSnapshotJob;
  onDone: () => void;
}) {
  const { t } = useTranslation("content");
  const auth = useAuth();
  const queryClient = useQueryClient();
  const regional = useOrganizationRegionalProfile();
  const frameRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"pending" | "settled" | "failed">(
    "pending",
  );
  const latest = useRef({ t, csrf: auth.status?.csrfToken ?? "", onDone });
  latest.current = { t, csrf: auth.status?.csrfToken ?? "", onDone };

  useEffect(() => {
    const timer = window.setTimeout(
      () => setState((current) => (current === "pending" ? "failed" : current)),
      CAPTURE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (state === "pending") return;
    if (state === "failed") {
      job.onFailed();
      latest.current.onDone();
      return;
    }
    let cancelled = false;
    // Two frames, so the browser has laid out and painted the Widget.
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void (async () => {
          try {
            const element = frameRef.current;
            if (!element) throw new Error("Preview is not ready yet.");
            const image = await captureWidgetPreview(element, latest.current.t);
            if (cancelled) return;
            await api.uploadWidgetPreview(
              job.asset.id,
              image,
              latest.current.csrf,
            );
            void queryClient.invalidateQueries({
              queryKey: contentKeys.assets,
            });
          } catch {
            if (!cancelled) job.onFailed();
          } finally {
            if (!cancelled) latest.current.onDone();
          }
        })();
      }),
    );
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [state, job, queryClient]);

  // Locale, time zone, and hour cycle shape the rendered Widget, so the
  // capture waits for the organization's regional settings.
  if (!regional.ready) return null;
  return (
    <div className="widget-snapshot-backfill" aria-hidden="true">
      <div ref={frameRef}>
        <V2ZonePreview
          provider={job.asset.widget?.provider ?? ""}
          asset={job.asset}
          width={WIDGET_THUMBNAIL_FRAME.width}
          height={WIDGET_THUMBNAIL_FRAME.height}
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
