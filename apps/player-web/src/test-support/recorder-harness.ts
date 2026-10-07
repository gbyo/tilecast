import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { openDatabase } from "../storage/database";
import { ActivityOutbox } from "../activity/outbox";
import { ActivityRecorder } from "../activity/recorder";

// The Host uses the browser global, so the test supplies the same one.
(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange ??= IDBKeyRange;

/** A recorder over a real (fake) IndexedDB, with a clock the test advances. */
export async function recorderHarness(
  options: { slot?: string; limit?: number } = {},
) {
  const factory = new IDBFactory();
  const database = await openDatabase(factory);
  const clock = {
    wall: Date.parse("2026-10-01T12:00:00Z"),
    mono: 1_000,
    offset: 0,
  };
  let counter = 0;
  const uuid = () =>
    `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  const outbox = new ActivityOutbox(
    database,
    options.slot ?? "slot",
    options.limit,
  );
  const recorder = new ActivityRecorder(
    outbox,
    {
      wallNow: () => clock.wall,
      monotonicNow: () => clock.mono,
      offsetMs: () => clock.offset,
    },
    uuid,
    "UTC",
    await outbox.nextSequence(),
  );
  return {
    factory,
    database,
    clock,
    outbox,
    recorder,
    advance(ms: number) {
      clock.wall += ms;
      clock.mono += ms;
    },
    async records() {
      await recorder.idle();
      return (await outbox.batch(1_000)).map((entry) => entry.record);
    },
  };
}
