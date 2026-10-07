import {
  PlaybackSessionTracker,
  buildActivityRecord,
  type ActivityEventInput,
} from "@tilecast/player-activity";
import type { ActivityOutbox } from "./outbox";

export interface RecorderClock {
  /** The device wall clock, in epoch milliseconds. */
  wallNow(): number;
  /** A clock that cannot run backwards, in milliseconds. */
  monotonicNow(): number;
  /** Corrected-minus-device wall offset from the last reconciliation. */
  offsetMs(): number;
}

/**
 * Turns the shared session tracker's events into durable records. This class
 * adds persistence and identity, and nothing about what counts as a play: the
 * session semantics belong to `@tilecast/player-activity`.
 */
export class ActivityRecorder {
  readonly sessions: PlaybackSessionTracker;
  private next: number;
  private writes: Promise<void> = Promise.resolve();
  private readonly startedMonotonicMs: number;

  constructor(
    private readonly outbox: ActivityOutbox,
    private readonly clock: RecorderClock,
    private readonly uuid: () => string,
    private readonly timezone: string,
    firstSequence: number,
    /** Called with a write that could not be stored. Nothing else is lost. */
    private readonly onStorageError: (error: unknown) => void = () => undefined,
  ) {
    this.next = firstSequence;
    this.startedMonotonicMs = clock.monotonicNow();
    this.sessions = new PlaybackSessionTracker(
      (event) => this.record(event),
      () => clock.monotonicNow(),
      uuid,
    );
  }

  /**
   * Assigns the identity and sequence now, so ordering is the order of calls,
   * and queues the durable write behind the earlier ones.
   */
  record(input: ActivityEventInput): void {
    const nowMs = this.clock.wallNow() + this.clock.offsetMs();
    const record = buildActivityRecord(input, {
      id: this.uuid(),
      sequence: this.next++,
      nowMs,
      startMs: nowMs,
      timezone: this.timezone,
    });
    // `elapsedRealtimeMs` is the monotonic clock, so a wall-clock correction
    // cannot make it negative.
    record["elapsedRealtimeMs"] = Math.max(
      0,
      Math.round(this.clock.monotonicNow() - this.startedMonotonicMs),
    );
    this.writes = this.writes
      .then(() => this.outbox.append(record))
      .catch((error) => this.onStorageError(error));
  }

  /** Resolves when every recorded event is durable. */
  idle(): Promise<void> {
    return this.writes;
  }
}
