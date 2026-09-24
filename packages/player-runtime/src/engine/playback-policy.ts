/**
 * Renderer playback policy — the decisions, with none of the DOM.
 *
 * Keeping the rules here means they are unit-testable without a DOM and, more
 * importantly, that there is exactly one place that decides who is allowed to
 * change the current playlist occurrence. The playback machines and the video
 * surface call these helpers; nothing else re-implements them.
 */

// ------------------------------------------------------- playback authority
//
// A grouped (synchronized) presentation is driven by the shared timeline in the
// preload: it schedules the occurrence boundaries and pushes a freshly projected
// presentation at each one. Local completion signals — the fixed-duration timer,
// a video's `ended` event, a video end offset — describe the same boundary and
// must therefore never act on it, or the renderer advances locally and is then
// restarted milliseconds later by the timeline. That double advancement is what
// makes a video briefly rewind, repeat frames, or restart after a switch.
//
// An ungrouped presentation has no shared timeline, so the renderer keeps full
// local authority and behaves exactly as before.

export type PlaybackAuthority = "local" | "shared";

/** Why an item is reporting that it is done. */
export type CompletionSource =
  "ended" | "duration-timer" | "end-offset" | "skip" | "failure";

export type CompletionOutcome = "ignore" | "restart" | "advance";

export function playbackAuthorityOf(
  synchronized: boolean | undefined,
): PlaybackAuthority {
  return synchronized === true ? "shared" : "local";
}

/**
 * One-shot arbiter for a single playlist occurrence.
 *
 * Several signals can describe the same completion (a video's `ended` event and
 * a fixed `durationMs` timer routinely fire within a frame of each other on a
 * single-video playlist, restarting it twice). The first signal wins; every
 * later one is ignored until the next occurrence has genuinely started.
 */
export class ItemCompletion {
  private settled = false;

  constructor(
    private readonly authority: PlaybackAuthority,
    /** A single-item local playlist restarts in place instead of advancing. */
    private readonly loop: boolean,
  ) {}

  complete(source: CompletionSource): CompletionOutcome {
    if (this.settled) {
      return "ignore";
    }
    if (this.authority === "shared") {
      // The group timeline owns occurrence changes. This includes `skip` and
      // `failure`: advancing one screen of a group locally would desync it
      // until the next shared boundary snapped it back.
      void source;
      return "ignore";
    }
    this.settled = true;
    return this.loop ? "restart" : "advance";
  }

  /**
   * Reopen the guard. Called only once the restarted occurrence is genuinely
   * playing again — reopening it earlier would let the losing signal through
   * and restart the item a second time.
   *
   * Ignored unless this item loops in place: an item that advanced has no next
   * occurrence on the same element, and reopening its guard would let a trailing
   * `ended` event advance the playlist twice.
   */
  occurrenceStarted(): void {
    if (this.loop) {
      this.settled = false;
    }
  }

  get settledForOccurrence(): boolean {
    return this.settled;
  }
}

// ---------------------------------------------------------- stale callbacks
//
// Delayed work (a failure back-off, the advance macrotask, a layout zone timer)
// can land after the presentation generation changed or after the item it was
// created for was replaced. Both identities have to match, not just the
// generation: two items of the same presentation share a generation.

export interface PlaybackToken {
  generation: number;
  /** Bumped every time the renderer mounts an item. */
  render: number;
}

export function isCurrentPlayback(
  captured: PlaybackToken,
  current: PlaybackToken,
): boolean {
  return (
    captured.generation === current.generation &&
    captured.render === current.render
  );
}

// ------------------------------------------------------ layout zone loops
//
// A layout playlist zone rotates on its own timers. Once its layout is no
// longer the active item the container is detached, and neither a pending timer
// nor a media event on a detached element may keep the loop running.

export interface ZoneStep {
  /** The layout that owns the zone is still the current item. */
  alive: boolean;
  /** The zone has already shown something (so it should be on screen). */
  mounted: boolean;
  /** The zone container is currently in the document. */
  connected: boolean;
}

export function zoneStepAllowed(step: ZoneStep): boolean {
  if (!step.alive) {
    return false;
  }
  // The first item mounts while the layout canvas is still detached, so the
  // container is legitimately not connected yet; every later step must prove it.
  return !step.mounted || step.connected;
}

// ------------------------------------------------- synchronized video drift
//
// Correction bands. Below the ignore threshold the difference is inside normal
// decode/scheduling jitter and correcting it is what produces the visible
// "plays five frames then jumps backward" artefact. In the middle band a small
// playback-rate nudge converges invisibly. Only a genuinely large gap justifies
// a seek, and a seek is not repeated while the previous one is still settling.
export const SYNC_IGNORE_DRIFT_MS = 80;
export const SYNC_RATE_DRIFT_MS = 250;
export const SYNC_SEEK_COOLDOWN_MS = 1_000;
export const SYNC_FAST_RATE = 1.02;
export const SYNC_SLOW_RATE = 0.98;

export interface VideoSyncState {
  /**
   * When the last corrective seek was issued, on a monotonic clock. A fresh
   * element has never seeked for correction — the one intentional seek that
   * starts it at a nonzero synchronized offset is done at creation time, before
   * any correction runs.
   */
  lastSeekAtMs: number | null;
}

export interface VideoSyncInput {
  /** Where the shared timeline says this video should be, in media time. */
  expectedMs: number;
  /** Where it actually is, in media time. */
  actualMs: number;
  /** Monotonic now, used only for the seek cooldown. */
  nowMs: number;
  state: VideoSyncState;
}

export interface VideoSyncCorrection {
  action: "hold" | "rate" | "seek";
  playbackRate: number;
  seekToMs: number | null;
}

export function newVideoSyncState(): VideoSyncState {
  return { lastSeekAtMs: null };
}

/**
 * Decide how to pull a video back onto the shared timeline.
 *
 * Deliberately not a function of the occurrence number: a changed occurrence
 * means a new item started, and the renderer already mounted that item at the
 * right offset. Seeking merely because the occurrence changed threw away those
 * first frames on every single boundary.
 */
export function videoSyncCorrection(
  input: VideoSyncInput,
): VideoSyncCorrection {
  const driftMs = input.expectedMs - input.actualMs;
  const absolute = Math.abs(driftMs);
  const rate = driftMs > 0 ? SYNC_FAST_RATE : SYNC_SLOW_RATE;

  if (absolute <= SYNC_IGNORE_DRIFT_MS) {
    return { action: "hold", playbackRate: 1, seekToMs: null };
  }
  if (absolute <= SYNC_RATE_DRIFT_MS) {
    return { action: "rate", playbackRate: rate, seekToMs: null };
  }

  const converging =
    input.state.lastSeekAtMs !== null &&
    input.nowMs - input.state.lastSeekAtMs < SYNC_SEEK_COOLDOWN_MS;
  if (converging) {
    // A seek has just been issued; the decoder is still catching up. Seeking
    // again every 250 ms would keep restarting playback instead of settling.
    return { action: "rate", playbackRate: rate, seekToMs: null };
  }

  return {
    action: "seek",
    playbackRate: 1,
    seekToMs: Math.max(0, input.expectedMs),
  };
}

export function recordVideoSyncSeek(
  state: VideoSyncState,
  nowMs: number,
): void {
  state.lastSeekAtMs = nowMs;
}

// ------------------------------------------------------- crossfade decision
//
// Nothing needs to dissolve into itself. A shared timeline re-delivers the
// same item every time a grouped playlist loops it — a single video looping on
// a display group is the ordinary case — and each of those swaps mounts a
// second decoder for the same file and fades it over the first. That is the
// decoder contention the crossfade window exists to bound, spent on a
// transition with nothing to show: both layers hold the same frame. An
// ungrouped screen never pays it, because a looping single video restarts in
// place on one element, which is why the same playlist judders in a group and
// not out of it.

export function transitionForSwap(
  configured: string | undefined,
  outgoingItemId: string | null,
  incomingItemId: string,
): string {
  if (outgoingItemId !== null && outgoingItemId === incomingItemId) {
    return "none";
  }
  return configured || "fade";
}

// ------------------------------------------------------- crossfade cleanup
//
// The delayed teardown after a crossfade must act on the layer that actually
// faded out, and only if that layer has not been refilled in the meantime.
// Reading the mutable `backLayer` later, as the renderer used to, cleared
// whatever happened to be in the back at that moment — including a layer that
// had already been refilled for the next item.

export interface OutgoingLayerCleanup {
  /** The captured layer is now the visible one again (a fast swap back). */
  outgoingIsFront: boolean;
  /** Fill counter captured when the crossfade started. */
  capturedFill: number;
  /** Fill counter of that same layer now. */
  currentFill: number;
}

export function shouldClearOutgoingLayer(input: OutgoingLayerCleanup): boolean {
  return !input.outgoingIsFront && input.capturedFill === input.currentFill;
}

/**
 * Whether the outgoing video may be paused now that the incoming one is up.
 * Pausing while the fade is still running would freeze a half-faded frame, so
 * it waits for the transition to finish; the incoming layer is fully opaque by
 * then, so nothing black can be exposed.
 */
export function shouldPauseOutgoingLayer(input: OutgoingLayerCleanup): boolean {
  return shouldClearOutgoingLayer(input);
}

/** The whole policy as one object, as the playback tests address it. */
export const tilecastPlaybackPolicy = {
  ItemCompletion,
  isCurrentPlayback,
  newVideoSyncState,
  playbackAuthorityOf,
  recordVideoSyncSeek,
  shouldClearOutgoingLayer,
  shouldPauseOutgoingLayer,
  transitionForSwap,
  videoSyncCorrection,
  zoneStepAllowed,
  SYNC_IGNORE_DRIFT_MS,
  SYNC_RATE_DRIFT_MS,
  SYNC_SEEK_COOLDOWN_MS,
};
