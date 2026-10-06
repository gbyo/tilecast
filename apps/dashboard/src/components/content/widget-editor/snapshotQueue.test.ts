import { afterEach, describe, expect, it, vi } from "vitest";
import type { Asset } from "@/api/types";
import {
  enqueueWidgetSnapshot,
  finishWidgetSnapshot,
  resetWidgetSnapshotQueue,
  subscribeToWidgetSnapshots,
  widgetSnapshotJobs,
  type WidgetSnapshotJob,
} from "./snapshotQueue";

afterEach(() => resetWidgetSnapshotQueue());

const job = (id: string, updatedAt: string): WidgetSnapshotJob => ({
  asset: { id, updatedAt } as Asset,
  onFailed: vi.fn(),
});

describe("the Widget snapshot queue", () => {
  it("runs different Widgets in the order they were saved", () => {
    const first = job("a", "1");
    const second = job("b", "1");
    enqueueWidgetSnapshot(first);
    enqueueWidgetSnapshot(second);
    expect(widgetSnapshotJobs()).toEqual([first, second]);
  });

  it("lets a newer save of the same Widget replace the older job", () => {
    const older = job("a", "1");
    const other = job("b", "1");
    const newer = job("a", "2");
    enqueueWidgetSnapshot(older);
    enqueueWidgetSnapshot(other);
    enqueueWidgetSnapshot(newer);
    expect(widgetSnapshotJobs()).toEqual([other, newer]);
    // A superseded job is dropped, not reported as a failure.
    expect(older.onFailed).not.toHaveBeenCalled();
  });

  it("never lets a finished older job remove its replacement", () => {
    const older = job("a", "1");
    const newer = job("a", "2");
    enqueueWidgetSnapshot(older);
    enqueueWidgetSnapshot(newer);
    finishWidgetSnapshot(older);
    expect(widgetSnapshotJobs()).toEqual([newer]);
    finishWidgetSnapshot(newer);
    expect(widgetSnapshotJobs()).toEqual([]);
  });

  it("tells subscribers about every change and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToWidgetSnapshots(listener);
    const queued = job("a", "1");
    enqueueWidgetSnapshot(queued);
    finishWidgetSnapshot(queued);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    enqueueWidgetSnapshot(job("b", "1"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
