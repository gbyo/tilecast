/**
 * The queue of saved Widgets waiting for a library thumbnail. It is a
 * module-level store so a job survives the editor route that queued it:
 * the host in the Studio shell (WidgetSnapshotQueue) renders it.
 */
import type { Asset } from "@/api/types";
import type { PreviewFrame } from "@/content/WidgetPreviewHost";

export type WidgetSnapshotJob = {
  /** The Widget as the Server saved it. */
  readonly asset: Asset;
  /**
   * The geometry the Widget is designed for, when its definition declares
   * one. The Widget renders at it and is then fitted into the canonical
   * thumbnail frame.
   */
  readonly renderFrame?: PreviewFrame;
  /** Called once when the thumbnail could not be captured or stored. */
  readonly onFailed: () => void;
};

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

/** Remove a finished (or abandoned) job. */
export function finishWidgetSnapshot(job: WidgetSnapshotJob) {
  publish(jobs.filter((entry) => entry !== job));
}

export function subscribeToWidgetSnapshots(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function widgetSnapshotJobs() {
  return jobs;
}

/** Test seam: forget queued work between tests. */
export function resetWidgetSnapshotQueue() {
  publish([]);
}
