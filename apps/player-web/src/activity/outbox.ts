import { completed, read, result } from "../storage/database";

/**
 * The durable queue between what the Player observed and what the server has
 * accepted. An event is appended here before any transport is attempted, so a
 * lost connection or a closed browser never loses a generated event. The queue
 * is bounded, ordered by a per-installation sequence, and idempotent: a retry
 * sends the same event ID.
 */
export const OUTBOX_LIMIT = 2_000;
/** The server accepts between 1 and 200 events in one batch. */
export const BATCH_LIMIT = 200;

export interface OutboxEntry {
  slotId: string;
  sequence: number;
  record: Record<string, unknown>;
}

const counterKey = (slotId: string) => `activity-sequence:${slotId}`;
const range = (slotId: string) =>
  IDBKeyRange.bound([slotId, 0], [slotId, Number.MAX_SAFE_INTEGER]);

export class ActivityOutbox {
  constructor(
    private readonly database: IDBDatabase,
    readonly slotId: string,
    private readonly limit = OUTBOX_LIMIT,
  ) {}

  /** The next sequence number: past both the saved counter and every queued event. */
  async nextSequence(): Promise<number> {
    const saved =
      (await read<number>(
        this.database,
        "identity",
        counterKey(this.slotId),
      )) ?? 1;
    const store = this.database.transaction("outbox").objectStore("outbox");
    const last = await new Promise<number>((resolve, reject) => {
      const request = store.openCursor(range(this.slotId), "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor ? (cursor.value as OutboxEntry).sequence : 0);
      };
      request.onerror = () => reject(request.error);
    });
    return Math.max(saved, last + 1);
  }

  /** Persists one event and the counter together, then enforces the bound. */
  async append(record: Record<string, unknown>): Promise<void> {
    const sequence = Number(record["sequence"]);
    const transaction = this.database.transaction(
      ["outbox", "identity"],
      "readwrite",
      {
        durability: "strict",
      },
    );
    const done = completed(transaction);
    const outbox = transaction.objectStore("outbox");
    outbox.put(
      { slotId: this.slotId, sequence, record } satisfies OutboxEntry,
      [this.slotId, sequence],
    );
    transaction
      .objectStore("identity")
      .put(sequence + 1, counterKey(this.slotId));
    const count = await result(outbox.count(range(this.slotId)));
    if (count > this.limit) {
      // Keep the newest events. The server closes a session whose end never
      // arrives, so an overflow costs precision, not correctness.
      let excess = count - this.limit;
      await new Promise<void>((resolve, reject) => {
        const request = outbox.openCursor(range(this.slotId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor || excess <= 0) return resolve();
          cursor.delete();
          excess -= 1;
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    }
    await done;
  }

  /** The oldest events, in sequence order. */
  async batch(limit = BATCH_LIMIT): Promise<OutboxEntry[]> {
    const store = this.database.transaction("outbox").objectStore("outbox");
    return result(store.getAll(range(this.slotId), limit)) as Promise<
      OutboxEntry[]
    >;
  }

  async count(): Promise<number> {
    const store = this.database.transaction("outbox").objectStore("outbox");
    return result(store.count(range(this.slotId)));
  }

  /** Removes the events the server acknowledged. */
  async remove(entries: readonly OutboxEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const transaction = this.database.transaction("outbox", "readwrite", {
      durability: "strict",
    });
    const done = completed(transaction);
    const store = transaction.objectStore("outbox");
    for (const entry of entries) store.delete([this.slotId, entry.sequence]);
    await done;
  }

  /** The server's high-water mark is authoritative after a lost local counter. */
  async healSequence(highest: number): Promise<void> {
    const saved =
      (await read<number>(
        this.database,
        "identity",
        counterKey(this.slotId),
      )) ?? 1;
    if (highest + 1 <= saved) return;
    const transaction = this.database.transaction("identity", "readwrite", {
      durability: "strict",
    });
    const done = completed(transaction);
    transaction
      .objectStore("identity")
      .put(highest + 1, counterKey(this.slotId));
    await done;
  }

  /** Drops every queued event: this Player no longer speaks for its Screen. */
  async clear(): Promise<void> {
    const transaction = this.database.transaction("outbox", "readwrite", {
      durability: "strict",
    });
    const done = completed(transaction);
    transaction.objectStore("outbox").delete(range(this.slotId));
    await done;
  }
}
