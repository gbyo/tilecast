// @vitest-environment jsdom
// Saving never waits for a thumbnail, and a thumbnail never decides a save.
// The queue captures after the Server accepted the save, gives each job one
// deadline, and abandons a job a newer save of the same Widget replaced.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import type { Asset } from "@/api/types";
import { captureWidgetPreview } from "@/content/widgetPreviewCapture";
import {
  enqueueWidgetSnapshot,
  resetWidgetSnapshotQueue,
  widgetSnapshotJobs,
  type WidgetSnapshotJob,
} from "./snapshotQueue";
import { WidgetSnapshotQueue } from "./WidgetSnapshotQueue";

const preview = vi.hoisted(() => ({ settles: true }));
const realSetTimeout = globalThis.setTimeout;

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ status: { csrfToken: "csrf" } }),
}));
vi.mock("@/settings/regionalProfile", () => ({
  useOrganizationRegionalProfile: () => ({ ready: true }),
}));
vi.mock("@/components/layout-editor/V2ZonePreview", async () => {
  const { useEffect } = await import("react");
  return {
    V2ZonePreview: ({
      asset,
      onState,
    }: {
      asset: Asset;
      onState: (state: { state: "ready" }) => void;
    }) => {
      useEffect(() => {
        if (preview.settles) onState({ state: "ready" });
      }, [onState]);
      return <div data-updated={asset.updatedAt} />;
    },
  };
});
vi.mock("@/content/widgetPreviewCapture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/content/widgetPreviewCapture")>()),
  captureWidgetPreview: vi.fn(),
}));

const asset = (id: string, updatedAt: string) =>
  ({
    id,
    updatedAt,
    type: "widget",
    widget: { provider: "clock", configVersion: 1, configuration: {} },
  }) as unknown as Asset;

const job = (
  id: string,
  updatedAt: string,
  renderFrame?: WidgetSnapshotJob["renderFrame"],
) => ({
  asset: asset(id, updatedAt),
  renderFrame,
  onFailed: vi.fn(),
});

function mount() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <WidgetSnapshotQueue />
    </QueryClientProvider>,
  );
  return { invalidate };
}

/** The capture result names the job that was rendered, so uploads can be told apart. */
const tagged = (element: HTMLElement) =>
  ({
    updatedAt: element
      .querySelector("[data-updated]")
      ?.getAttribute("data-updated"),
  }) as unknown as Blob;

beforeEach(() => {
  preview.settles = true;
  vi.mocked(captureWidgetPreview).mockImplementation((element) =>
    Promise.resolve(tagged(element)),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWidgetSnapshotQueue();
});

describe("the Widget snapshot host", () => {
  it("captures a saved Widget, uploads it, and releases the queue", async () => {
    const upload = vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue();
    const { invalidate } = mount();
    const saved = job("w1", "t1");
    act(() => enqueueWidgetSnapshot(saved));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]![0]).toBe("w1");
    expect(upload.mock.calls[0]![2]).toBe("csrf");
    await waitFor(() => expect(widgetSnapshotJobs()).toEqual([]));
    expect(saved.onFailed).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
  });

  it("renders the job at its recommended geometry and hands that frame to the capture", async () => {
    vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue();
    mount();
    act(() =>
      enqueueWidgetSnapshot(job("w1", "t1", { width: 1920, height: 200 })),
    );
    await waitFor(() => expect(captureWidgetPreview).toHaveBeenCalledTimes(1));
    expect(vi.mocked(captureWidgetPreview).mock.calls[0]![2]).toEqual({
      width: 1920,
      height: 200,
    });
  });

  it("reports a failed capture without uploading and moves on", async () => {
    vi.mocked(captureWidgetPreview).mockRejectedValueOnce(
      new Error("no canvas"),
    );
    const upload = vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue();
    mount();
    const failing = job("w1", "t1");
    const next = job("w2", "t1");
    act(() => {
      enqueueWidgetSnapshot(failing);
      enqueueWidgetSnapshot(next);
    });
    await waitFor(() => expect(failing.onFailed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0]![0]).toBe("w2");
    expect(next.onFailed).not.toHaveBeenCalled();
  });

  it("reports a failed upload and still releases the queue", async () => {
    vi.spyOn(api, "uploadWidgetPreview").mockRejectedValue(
      new Error("offline"),
    );
    mount();
    const failing = job("w1", "t1");
    act(() => enqueueWidgetSnapshot(failing));
    await waitFor(() => expect(failing.onFailed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(widgetSnapshotJobs()).toEqual([]));
  });

  it("gives a Widget that never settles one deadline, then releases the queue", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    preview.settles = false;
    const upload = vi.spyOn(api, "uploadWidgetPreview").mockResolvedValue();
    mount();
    const stuck = job("w1", "t1");
    act(() => enqueueWidgetSnapshot(stuck));
    expect(widgetSnapshotJobs()).toEqual([stuck]);
    await act(() => vi.advanceTimersByTimeAsync(29_000));
    expect(stuck.onFailed).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(stuck.onFailed).toHaveBeenCalledTimes(1);
    expect(widgetSnapshotJobs()).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
  });

  it("releases the queue when an upload outlives the one deadline", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(api, "uploadWidgetPreview").mockImplementation(
      (_id, _image, _csrf, requestSignal) => {
        signal = requestSignal;
        return new Promise(() => undefined);
      },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount();
    const slow = job("w1", "t1");
    act(() => enqueueWidgetSnapshot(slow));
    // Animation frames run on real time; wait for the upload to begin.
    await act(async () => {
      for (let tries = 0; tries < 50 && !signal; tries += 1)
        await new Promise((resolve) => realSetTimeout(resolve, 10));
    });
    expect(signal).toBeDefined();
    await act(() => vi.advanceTimersByTimeAsync(30_500));
    expect(slow.onFailed).toHaveBeenCalledTimes(1);
    expect(widgetSnapshotJobs()).toEqual([]);
    expect(signal!.aborted).toBe(true);
  });

  describe("when a newer save of the same Widget arrives", () => {
    it("drops a queued older job without capturing it or calling it a failure", async () => {
      let releaseBlocker: () => void = () => undefined;
      const uploaded: string[] = [];
      vi.spyOn(api, "uploadWidgetPreview").mockImplementation((id, image) => {
        if (id === "w0")
          return new Promise<void>((resolve) => {
            releaseBlocker = resolve;
          });
        uploaded.push(
          `${id}:${(image as unknown as { updatedAt: string }).updatedAt}`,
        );
        return Promise.resolve();
      });
      mount();
      const blocker = job("w0", "t1");
      const older = job("w1", "t1");
      const newer = job("w1", "t2");
      act(() => enqueueWidgetSnapshot(blocker));
      await waitFor(() =>
        expect(api.uploadWidgetPreview).toHaveBeenCalledTimes(1),
      );
      act(() => {
        enqueueWidgetSnapshot(older);
        enqueueWidgetSnapshot(newer);
      });
      expect(widgetSnapshotJobs()).toEqual([blocker, newer]);
      act(() => releaseBlocker());
      await waitFor(() => expect(uploaded).toEqual(["w1:t2"]));
      await waitFor(() => expect(widgetSnapshotJobs()).toEqual([]));
      const captured = vi.mocked(captureWidgetPreview).mock.results.length;
      expect(captured).toBe(2);
      expect(older.onFailed).not.toHaveBeenCalled();
      expect(newer.onFailed).not.toHaveBeenCalled();
    });

    it("aborts the older job's upload so a stale thumbnail cannot overwrite the newer one", async () => {
      const signals: AbortSignal[] = [];
      const abortedAtStart: boolean[] = [];
      const uploaded: string[] = [];
      vi.spyOn(api, "uploadWidgetPreview").mockImplementation(
        (_id, image, _csrf, signal) => {
          const version = (image as unknown as { updatedAt: string }).updatedAt;
          signals.push(signal!);
          abortedAtStart.push(signal!.aborted);
          // The first upload hangs until it is aborted, like a slow request.
          if (version === "t1")
            return new Promise((_resolve, reject) =>
              signal!.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              ),
            );
          uploaded.push(version);
          return Promise.resolve();
        },
      );
      const { invalidate } = mount();
      const older = job("w1", "t1");
      const newer = job("w1", "t2");
      act(() => enqueueWidgetSnapshot(older));
      await waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]!.aborted).toBe(false);

      act(() => enqueueWidgetSnapshot(newer));
      await waitFor(() => expect(signals).toHaveLength(2));
      // The superseded request was cancelled before the newer one began.
      expect(signals[0]!.aborted).toBe(true);
      expect(abortedAtStart).toEqual([false, false]);
      await waitFor(() => expect(uploaded).toEqual(["t2"]));
      await waitFor(() => expect(widgetSnapshotJobs()).toEqual([]));
      // Neither the abort nor the replaced job counts as a failure, and the
      // abandoned job never refreshed the library.
      expect(older.onFailed).not.toHaveBeenCalled();
      expect(newer.onFailed).not.toHaveBeenCalled();
      expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it("ignores an older upload that finishes after it was superseded", async () => {
      let finishOlder: () => void = () => undefined;
      const uploaded: string[] = [];
      vi.spyOn(api, "uploadWidgetPreview").mockImplementation((_id, image) => {
        const version = (image as unknown as { updatedAt: string }).updatedAt;
        if (version === "t1")
          return new Promise<void>((resolve) => {
            finishOlder = () => {
              uploaded.push("t1-late");
              resolve();
            };
          });
        uploaded.push(version);
        return Promise.resolve();
      });
      const { invalidate } = mount();
      const older = job("w1", "t1");
      const newer = job("w1", "t2");
      act(() => enqueueWidgetSnapshot(older));
      await waitFor(() => expect(uploaded).toEqual([]));
      await waitFor(() =>
        expect(vi.mocked(api.uploadWidgetPreview)).toHaveBeenCalledTimes(1),
      );
      act(() => enqueueWidgetSnapshot(newer));
      await waitFor(() => expect(uploaded).toEqual(["t2"]));
      await waitFor(() => expect(widgetSnapshotJobs()).toEqual([]));
      const refreshes = invalidate.mock.calls.length;
      act(() => finishOlder());
      // The late result changes nothing: no failure, no refresh, no new job.
      expect(older.onFailed).not.toHaveBeenCalled();
      expect(invalidate.mock.calls.length).toBe(refreshes);
      expect(widgetSnapshotJobs()).toEqual([]);
    });
  });
});
