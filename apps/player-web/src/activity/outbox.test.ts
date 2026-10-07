import { describe, expect, it } from "vitest";
import { openDatabase } from "../storage/database";
import { ActivityOutbox } from "./outbox";
import { recorderHarness } from "../test-support/recorder-harness";

const record = (sequence: number) => ({
  id: `event-${sequence}`,
  sequence,
  eventType: "content.started",
});

describe("durable Activity outbox", () => {
  it("keeps events in sequence order and across a restart", async () => {
    const h = await recorderHarness();
    for (const sequence of [3, 1, 2]) await h.outbox.append(record(sequence));
    h.database.close();
    // A new page load reads the same queue from the same database.
    const reopened = await openDatabase(h.factory);
    const outbox = new ActivityOutbox(reopened, "slot");
    expect((await outbox.batch()).map((entry) => entry.sequence)).toEqual([
      1, 2, 3,
    ]);
    // The counter moves past everything that was ever queued.
    expect(await outbox.nextSequence()).toBe(4);
  });

  it("holds a bounded queue and drops the oldest events when it is full", async () => {
    const h = await recorderHarness({ limit: 5 });
    for (let sequence = 1; sequence <= 8; sequence++)
      await h.outbox.append(record(sequence));
    expect((await h.outbox.batch()).map((entry) => entry.sequence)).toEqual([
      4, 5, 6, 7, 8,
    ]);
  });

  it("removes only what the server acknowledged", async () => {
    const h = await recorderHarness();
    for (const sequence of [1, 2, 3]) await h.outbox.append(record(sequence));
    const entries = await h.outbox.batch();
    await h.outbox.remove(entries.slice(0, 2));
    expect((await h.outbox.batch()).map((entry) => entry.sequence)).toEqual([
      3,
    ]);
  });

  it("scopes the queue to its slot and clears only its own events", async () => {
    const h = await recorderHarness();
    const other = new ActivityOutbox(h.database, "other-slot");
    await h.outbox.append(record(1));
    await other.append(record(1));
    await h.outbox.clear();
    expect(await h.outbox.count()).toBe(0);
    expect(await other.count()).toBe(1);
  });

  it("heals a lost counter from the server's high-water mark", async () => {
    const h = await recorderHarness();
    await h.outbox.healSequence(40);
    expect(await h.outbox.nextSequence()).toBe(41);
    await h.outbox.healSequence(10);
    expect(await h.outbox.nextSequence()).toBe(41);
  });
});
