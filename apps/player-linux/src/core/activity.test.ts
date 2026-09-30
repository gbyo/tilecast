import { describe, expect, it, vi } from "vitest";
import { ActivityReporter } from "./activity";
import { ApiError, type ApiClient } from "./api";
import type { StateStore } from "./storage";

/** In-memory StateStore stand-in. */
function fakeStore(): StateStore {
  const files = new Map<string, unknown>();
  return {
    async readJson<T>(name: string): Promise<T | null> {
      return (files.get(name) as T) ?? null;
    },
    async writeJson(name: string, value: unknown): Promise<void> {
      files.set(name, JSON.parse(JSON.stringify(value)));
    },
    async delete(name: string): Promise<void> {
      files.delete(name);
    },
  } as unknown as StateStore;
}

let counter = 0;
const uuid = () => `uuid-${++counter}`;
const clock = () => 1_000_000;

describe("ActivityReporter", () => {
  it("assigns monotonic sequences and flushes batches", async () => {
    const posted: unknown[][] = [];
    const client = {
      postActivityEvents: vi.fn(async (events: unknown[]) => {
        posted.push(events);
      }),
    } as unknown as ApiClient;

    const reporter = new ActivityReporter(
      fakeStore(),
      client,
      clock,
      uuid,
      "UTC",
    );
    await reporter.start();
    await reporter.record({
      eventType: "content.completed",
      result: "completed",
    });
    await reporter.record({ eventType: "content.failed", result: "failed" });
    await reporter.flush();

    expect(posted).toHaveLength(1);
    const batch = posted[0] as Array<{ sequence: number; eventType: string }>;
    expect(batch.map((e) => e.sequence)).toEqual([1, 2]);
    expect(batch[0]!.eventType).toBe("content.completed");
  });

  it("advances its sequence from a rebased server acknowledgement", async () => {
    const store = fakeStore();
    const client = {
      postActivityEvents: vi.fn(async (events: unknown[]) => ({
        accepted: events.length,
        duplicates: 0,
        highestSequence: 50,
        acknowledgedEventIds: (events as Array<{ id: string }>).map(
          (event) => event.id,
        ),
      })),
    } as unknown as ApiClient;
    const reporter = new ActivityReporter(store, client, clock, uuid, "UTC");
    await reporter.start();
    await reporter.record({ eventType: "connection.recovered" });
    await reporter.flush();
    await reporter.record({ eventType: "content.started" });

    const stored = (await store.readJson("activity-sequence.json")) as {
      next: number;
      buffered: Array<{ sequence: number }>;
    };
    expect(stored.buffered.map((event) => event.sequence)).toEqual([51]);
    expect(stored.next).toBe(52);
  });

  it("keeps the buffer when the upload fails, and drains it later", async () => {
    let failNext = true;
    const client = {
      postActivityEvents: vi.fn(async () => {
        if (failNext) {
          throw new Error("network down");
        }
      }),
    } as unknown as ApiClient;

    const reporter = new ActivityReporter(
      fakeStore(),
      client,
      clock,
      uuid,
      "UTC",
    );
    await reporter.start();
    await reporter.record({ eventType: "connection.lost" });
    await reporter.flush(); // fails, buffer retained
    expect(client.postActivityEvents).toHaveBeenCalledTimes(1);

    failNext = false;
    await reporter.flush(); // succeeds
    expect(client.postActivityEvents).toHaveBeenCalledTimes(2);
    await reporter.flush(); // nothing left to send
    expect(client.postActivityEvents).toHaveBeenCalledTimes(2);
  });

  it("persists the sequence across a restart", async () => {
    const store = fakeStore();
    const client = {
      postActivityEvents: vi.fn(async () => {
        throw new ApiError(401, "device_credential_revoked", "revoked");
      }),
    } as unknown as ApiClient;

    const first = new ActivityReporter(store, client, clock, uuid, "UTC");
    await first.start();
    await first.record({ eventType: "a" });
    await first.record({ eventType: "b" });
    await first.flush(); // rejected; buffer + sequence persisted

    // A fresh reporter (process restart) resumes the sequence and buffer.
    const second = new ActivityReporter(store, client, clock, uuid, "UTC");
    await second.start();
    await second.record({ eventType: "c" });
    // The third event's sequence continues from where it left off.
    const stored = (await store.readJson("activity-sequence.json")) as {
      next: number;
      buffered: Array<{ sequence: number }>;
    };
    expect(stored.next).toBe(4);
    expect(stored.buffered.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it("serializes records with flush and drains a concurrent shutdown", async () => {
    const posted: unknown[][] = [];
    let releaseUpload: (() => void) | undefined;
    const uploadBlocked = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const client = {
      postActivityEvents: vi.fn(async (events: unknown[]) => {
        posted.push(events);
        await uploadBlocked;
      }),
    } as unknown as ApiClient;
    const reporter = new ActivityReporter(
      fakeStore(),
      client,
      clock,
      uuid,
      "UTC",
    );
    await reporter.start();
    const first = reporter.record({ eventType: "first" });
    const flush = reporter.flush();
    const second = reporter.record({ eventType: "second" });
    const stop = reporter.stop();
    await Promise.resolve();
    releaseUpload!();
    await Promise.all([first, flush, second, stop]);

    expect(
      posted.flat().map((event) => (event as { eventType: string }).eventType),
    ).toEqual(["first", "second"]);
  });
});
