import type { PlayerAPI } from "../api";
import { ActivityOutbox } from "./outbox";
import { ProofOfPlay } from "./proof";
import { ActivityRecorder, type RecorderClock } from "./recorder";
import { flushActivity, type FlushResult } from "./uploader";

/**
 * One Screen's Activity: the durable outbox, the recorder that fills it, the
 * proof-of-play mapping that decides what counts, and the upload that empties
 * it. It carries no policy of its own.
 */
export class ActivityEngine {
  private constructor(
    readonly outbox: ActivityOutbox,
    readonly recorder: ActivityRecorder,
    readonly proof: ProofOfPlay,
  ) {}

  static async open(
    database: IDBDatabase,
    slotId: string,
    clock: RecorderClock,
    options: {
      /** Whether what is on screen counts as played right now. */
      eligible: () => boolean;
      uuid?: () => string;
      timezone?: string;
      onStorageError?: (error: unknown) => void;
    },
  ): Promise<ActivityEngine> {
    const outbox = new ActivityOutbox(database, slotId);
    const recorder = new ActivityRecorder(
      outbox,
      clock,
      options.uuid ?? (() => crypto.randomUUID()),
      options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      await outbox.nextSequence(),
      options.onStorageError,
    );
    const proof = new ProofOfPlay(recorder, options.eligible, () =>
      clock.monotonicNow(),
    );
    return new ActivityEngine(outbox, recorder, proof);
  }

  /** Sends what is queued while `allowed()` says the server relationship holds. */
  async flush(api: PlayerAPI, allowed: () => boolean): Promise<FlushResult> {
    await this.recorder.idle();
    return flushActivity(api, this.outbox, allowed);
  }

  /** This Player no longer speaks for its Screen. Nothing queued is sent. */
  async discard(): Promise<void> {
    this.proof.shutdown("process_exit");
    await this.recorder.idle();
    await this.outbox.clear();
  }

  pending(): Promise<number> {
    return this.outbox.count();
  }
}
