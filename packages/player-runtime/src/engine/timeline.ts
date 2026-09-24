/**
 * Drives a synchronized group's shared timeline.
 *
 * At activation the wall clock (corrected by the host's server offset) is read
 * once to place this screen in the group's cycle; from then on position comes
 * from the monotonic clock. At each occurrence boundary the timeline reports
 * the outgoing item's transition and re-presents the playlist rotated to the
 * expected item with the remaining duration and video offset, so the playback
 * machine (which has no local authority under a shared timeline) mounts
 * exactly what the group is showing. Between boundaries it publishes the
 * expected position four times a second for video drift correction.
 *
 * The scheduler only wakes the timeline; every decision is re-evaluated from
 * the clock, so a late timer is corrected rather than trusted.
 */
import type {
  RuntimePresentation,
  SynchronizedTimingV1,
} from "../host/contract";
import {
  activateSynchronizedClock,
  rotateForSynchronizedPosition,
  synchronizedNowMs,
  synchronizedPlaybackPosition,
  type SynchronizedClockActivation,
  type SynchronizedPlaybackMetadata,
  type SynchronizedPlaybackPosition,
} from "../clock/synchronized";
import { TimerGroup, type RuntimeClock } from "../clock/scheduler";
import type { EngineReporter } from "./model";

export const DRIFT_INTERVAL_MS = 250;
/** Evaluate a boundary slightly after it, never slightly before. */
const BOUNDARY_SLACK_MS = 5;

export interface SyncPosition {
  itemId: string;
  kind: string;
  offsetMs: number;
  occurrence: number;
  videoStartOffsetMs: number;
}

type Playing = Extract<RuntimePresentation, { state: "playing" }>;

export class SynchronizedTimeline {
  private readonly timers: TimerGroup;
  private source: Playing | null = null;
  private metadata: SynchronizedPlaybackMetadata | null = null;
  private activation: SynchronizedClockActivation | null = null;
  private lastOccurrence: number | null = null;
  private lastItemId: string | null = null;

  constructor(
    private readonly clock: RuntimeClock,
    private readonly reporter: EngineReporter,
    private readonly present: (presentation: Playing) => void,
    private readonly publish: (position: SyncPosition | null) => void,
    private readonly nextGeneration: () => number,
  ) {
    this.timers = new TimerGroup(clock);
  }

  activate(source: Playing, timing: SynchronizedTimingV1): void {
    this.stop();
    this.source = source;
    this.metadata = {
      groupId: timing.groupId,
      anchorMs: timing.anchorMs,
      durationsMs: timing.durationsMs,
    };
    const offset = Number.isFinite(timing.clockOffsetMs)
      ? timing.clockOffsetMs
      : 0;
    // A fresh activation reads the wall clock once, so a late-joining screen
    // (or one whose schedule or takeover anchor just changed) still lands at
    // the right point in the shared cycle.
    this.activation = activateSynchronizedClock(
      this.clock.wallNow() + offset,
      this.clock.monotonicNow(),
    );
    this.emit(true);
    this.timers.every(DRIFT_INTERVAL_MS, () => this.drift());
  }

  stop(): void {
    this.timers.cancelAll();
    if (this.source) this.publish(null);
    this.source = null;
    this.metadata = null;
    this.activation = null;
    this.lastOccurrence = null;
    this.lastItemId = null;
  }

  get active(): boolean {
    return this.source !== null;
  }

  private position(): SynchronizedPlaybackPosition {
    return synchronizedPlaybackPosition(
      this.metadata!,
      synchronizedNowMs(this.activation!, this.clock.monotonicNow()),
    );
  }

  private event(position: SynchronizedPlaybackPosition): SyncPosition {
    const item = this.source!.items[position.index]!;
    return {
      itemId: item.id,
      kind: item.kind,
      offsetMs: position.offsetMs,
      occurrence: position.occurrence,
      videoStartOffsetMs: item.videoStartOffsetMs ?? 0,
    };
  }

  private emit(force: boolean): void {
    const source = this.source;
    if (!source || source.items.length === 0) return;
    const position = this.position();
    this.publish(this.event(position));
    if (!force && position.occurrence === this.lastOccurrence) {
      this.scheduleBoundary(position);
      return;
    }
    if (this.lastOccurrence !== null) {
      this.reporter.evidence("item-transition", this.lastItemId);
    }
    this.lastOccurrence = position.occurrence;
    this.lastItemId = source.items[position.index]?.id ?? null;
    this.present({
      ...source,
      items: rotateForSynchronizedPosition(source.items, position),
      generation: this.nextGeneration(),
      // The playback machine suppresses its own advancement on this flag.
      synchronized: true,
    });
    this.scheduleBoundary(position);
  }

  private boundary: { cancel(): void } | null = null;

  private scheduleBoundary(position: SynchronizedPlaybackPosition): void {
    this.boundary?.cancel();
    this.boundary = this.timers.at(
      this.clock.monotonicNow() + position.remainingMs + BOUNDARY_SLACK_MS,
      () => this.emit(false),
    );
  }

  private drift(): void {
    if (!this.source) return;
    const position = this.position();
    if (position.occurrence !== this.lastOccurrence) {
      this.emit(false);
    } else {
      this.publish(this.event(position));
    }
  }
}
