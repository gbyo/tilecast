/**
 * A layout playlist zone: an independent loop of images and videos inside a
 * layout, with its own timing. The zone actor decides which entry is shown and
 * when to move on; the layout surface only mounts what it is told and reports
 * media events back. Stopping the actor (when its layout leaves the screen)
 * cancels its timers, so a detached zone never drives a dead loop or keeps a
 * decoder warm.
 */
import { assign, setup, type ActorRefFrom } from "xstate";
import type { RuntimeLayoutZonePlaylistItem } from "../host/contract";
import { TimerGroup, type RuntimeClock } from "../clock/scheduler";
import { positiveDurationMs } from "../clock/duration";
import {
  resolveNativeVideoLoop,
  resolvePlaylistAdvance,
} from "@tilecast/presentation-model";

/** A zone entry that failed to play is retried after this long. */
export const ZONE_RETRY_MS = 2_000;
export const ZONE_IMAGE_DEFAULT_MS = 10_000;
/**
 * The longest an image may stay up in a zone the host holds to continuing
 * render evidence. The host's tolerance for a quiet zone is five minutes, so
 * this keeps a healthy rotation well inside it.
 */
export const ZONE_ROTATION_MAX_ENTRY_MS = 120_000;

/**
 * Whether a playlist zone keeps producing render evidence for as long as it is
 * healthy. A zone that renders once and holds owes nothing more, like a still
 * image. A zone owes continuing evidence only when it advances on a bounded
 * cadence the Runtime itself controls: it loops, has more than one entry, and
 * every entry is an image with a short duration. A video entry ends when the
 * media ends, which no timer here bounds, so such a zone is not held to a
 * cadence it cannot promise.
 */
export function zoneOwesContinuingEvidence(zone: {
  loop?: boolean;
  playlistItems?: readonly Pick<
    RuntimeLayoutZonePlaylistItem,
    "kind" | "durationMs"
  >[];
}): boolean {
  const entries = zone.playlistItems ?? [];
  if (entries.length < 2 || (zone.loop ?? true) === false) return false;
  return entries.every(
    (entry) =>
      entry.kind === "image" &&
      (positiveDurationMs(entry.durationMs) ?? ZONE_IMAGE_DEFAULT_MS) <=
        ZONE_ROTATION_MAX_ENTRY_MS,
  );
}

export interface ZoneInput {
  items: RuntimeLayoutZonePlaylistItem[];
  loop?: boolean;
  clock: RuntimeClock;
  /** Called only when the selected media is ready and visible. */
  onReady: () => void;
}

export interface ZoneContext {
  items: RuntimeLayoutZonePlaylistItem[];
  loop: boolean;
  /** How many entries have been shown; the current one is `(shown-1) % n`. */
  shown: number;
  /** Distinguishes retries of one item from stale media callbacks. */
  epoch: number;
  ready: boolean;
  paused: boolean;
  failed: boolean;
  clock: RuntimeClock;
  deadline: number | null;
  remainingMs: number | null;
  timers: TimerGroup;
  onReady: () => void;
}

export type ZoneEvent =
  | { type: "MEDIA_READY"; epoch: number }
  | { type: "MEDIA_ENDED"; epoch: number }
  | { type: "MEDIA_FAILED"; epoch: number }
  | { type: "PAUSE"; epoch: number }
  | { type: "RESUME"; epoch: number }
  | { type: "NEXT"; epoch: number }
  | { type: "RETRY"; epoch: number };

export function zoneEntry(
  context: Pick<ZoneContext, "items" | "shown"> & { loop?: boolean },
): { entry: RuntimeLayoutZonePlaylistItem; loop: boolean } | null {
  if (context.items.length === 0 || context.shown === 0) return null;
  const entry = context.items[(context.shown - 1) % context.items.length]!;
  return {
    entry,
    loop: resolveNativeVideoLoop(
      entry,
      context.items.length,
      context.loop ?? true,
    ),
  };
}

function canAdvance(context: Pick<ZoneContext, "items" | "shown" | "loop">) {
  return resolvePlaylistAdvance(
    Math.max(0, context.shown - 1),
    context.items.length,
    context.loop,
  ).canAdvance;
}

export const zoneMachine = setup({
  types: {
    context: {} as ZoneContext,
    input: {} as ZoneInput,
    events: {} as ZoneEvent,
  },
  guards: {
    current: ({ context, event }) => event.epoch === context.epoch,
    nonEmpty: ({ context }) => context.items.length > 0,
    canAdvance: ({ context }) => canAdvance(context),
  },
  actions: {
    advance: assign(({ context }) => ({
      shown: context.shown + 1,
      epoch: context.epoch + 1,
      ready: false,
      failed: false,
      deadline: null,
      remainingMs: null,
    })),
    retryCurrent: assign(({ context }) => ({
      epoch: context.epoch + 1,
      ready: false,
      failed: false,
      deadline: null,
      remainingMs: null,
    })),
    markReady: assign({ ready: true }),
    markFailed: assign({ ready: false, failed: true }),
    pause: assign(({ context }) => ({
      paused: true,
      remainingMs:
        context.deadline === null
          ? context.remainingMs
          : Math.max(0, context.deadline - context.clock.monotonicNow()),
      deadline: null,
    })),
    resume: assign({ paused: false }),
    announce: ({ context }) => context.onReady(),
    schedule: assign(({ context, self }) => {
      context.timers.cancelAll();
      const current = zoneEntry(context);
      if (
        context.paused ||
        !context.ready ||
        !current ||
        current.entry.kind !== "image" ||
        !canAdvance(context)
      )
        return {};
      const epoch = context.epoch;
      const duration =
        context.remainingMs ??
        // Zero reads as unset, so two zero-length images do not swap at
        // timer speed.
        positiveDurationMs(current.entry.durationMs) ??
        ZONE_IMAGE_DEFAULT_MS;
      context.timers.after(duration, () => self.send({ type: "NEXT", epoch }));
      return {
        deadline: context.clock.monotonicNow() + duration,
        remainingMs: null,
      };
    }),
    retryLater: ({ context, self }) => {
      context.timers.cancelAll();
      const epoch = context.epoch;
      context.timers.after(ZONE_RETRY_MS, () =>
        self.send({ type: "RETRY", epoch }),
      );
    },
    stopTimers: ({ context }) => context.timers.cancelAll(),
  },
}).createMachine({
  id: "zone",
  context: ({ input }) => ({
    items: input.items,
    loop: input.loop ?? true,
    shown: 0,
    epoch: 0,
    ready: false,
    paused: false,
    failed: false,
    clock: input.clock,
    deadline: null,
    remainingMs: null,
    timers: new TimerGroup(input.clock),
    onReady: input.onReady,
  }),
  initial: "start",
  states: {
    start: {
      always: [{ guard: "nonEmpty", target: "showing" }, { target: "idle" }],
    },
    idle: {},
    showing: {
      entry: "advance",
      exit: "stopTimers",
      on: {
        PAUSE: { guard: "current", actions: ["pause", "stopTimers"] },
        RESUME: [
          {
            guard: ({ context, event }) =>
              event.epoch === context.epoch && context.failed,
            actions: ["resume", "retryLater"],
          },
          { guard: "current", actions: ["resume", "schedule"] },
        ],
        MEDIA_READY: {
          guard: ({ context, event }) =>
            event.epoch === context.epoch &&
            !context.ready &&
            !context.failed &&
            !context.paused,
          actions: ["markReady", "announce", "schedule"],
        },
        NEXT: {
          guard: ({ context, event }) =>
            event.epoch === context.epoch && canAdvance(context),
          target: "showing",
          reenter: true,
        },
        RETRY: {
          guard: "current",
          actions: "retryCurrent",
        },
        MEDIA_ENDED: {
          guard: ({ context, event }) =>
            event.epoch === context.epoch &&
            !zoneEntry(context)?.loop &&
            canAdvance(context),
          target: "showing",
          reenter: true,
        },
        MEDIA_FAILED: [
          {
            guard: ({ context, event }) =>
              event.epoch === context.epoch && canAdvance(context),
            target: "showing",
            reenter: true,
          },
          { guard: "current", actions: ["markFailed", "retryLater"] },
        ],
      },
    },
  },
});

export type ZoneActor = ActorRefFrom<typeof zoneMachine>;
