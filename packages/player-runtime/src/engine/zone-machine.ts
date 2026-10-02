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

/** A zone entry that failed to play is retried after this long. */
export const ZONE_RETRY_MS = 2_000;
export const ZONE_IMAGE_DEFAULT_MS = 10_000;

export interface ZoneInput {
  items: RuntimeLayoutZonePlaylistItem[];
  loop?: boolean;
  clock: RuntimeClock;
  /** Every advance is fresh evidence that the zone is alive. */
  onAdvance: () => void;
}

export interface ZoneContext {
  items: RuntimeLayoutZonePlaylistItem[];
  loop: boolean;
  /** How many entries have been shown; the current one is `(shown-1) % n`. */
  shown: number;
  /** Distinguishes retries of one item from stale media callbacks. */
  epoch: number;
  timers: TimerGroup;
  onAdvance: () => void;
}

export type ZoneEvent =
  | { type: "MEDIA_ENDED"; epoch: number }
  | { type: "MEDIA_FAILED"; epoch: number }
  | { type: "NEXT"; epoch: number }
  | { type: "RETRY"; epoch: number };

export function zoneEntry(
  context: Pick<ZoneContext, "items" | "shown"> & { loop?: boolean },
): { entry: RuntimeLayoutZonePlaylistItem; loop: boolean } | null {
  if (context.items.length === 0 || context.shown === 0) return null;
  const entry = context.items[(context.shown - 1) % context.items.length]!;
  return {
    entry,
    loop:
      entry.kind === "video" &&
      (entry.loop || ((context.loop ?? true) && context.items.length === 1)),
  };
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
    canAdvance: ({ context }) =>
      context.loop || context.shown < context.items.length,
  },
  actions: {
    advance: assign(({ context }) => ({
      shown: context.shown + 1,
      epoch: context.epoch + 1,
    })),
    retryCurrent: assign(({ context }) => ({ epoch: context.epoch + 1 })),
    announce: ({ context }) => context.onAdvance(),
    schedule: ({ context, self }) => {
      context.timers.cancelAll();
      const current = zoneEntry(context);
      if (!current || current.entry.kind !== "image") return;
      if (!(context.loop || context.shown < context.items.length)) return;
      const epoch = context.epoch;
      context.timers.after(
        // Zero reads as unset, so two zero-length images do not swap at
        // timer speed.
        positiveDurationMs(current.entry.durationMs) ?? ZONE_IMAGE_DEFAULT_MS,
        () => self.send({ type: "NEXT", epoch }),
      );
    },
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
    timers: new TimerGroup(input.clock),
    onAdvance: input.onAdvance,
  }),
  initial: "start",
  states: {
    start: {
      always: [{ guard: "nonEmpty", target: "showing" }, { target: "idle" }],
    },
    idle: {},
    showing: {
      entry: ["advance", "announce", "schedule"],
      exit: "stopTimers",
      on: {
        NEXT: {
          guard: ({ context, event }) =>
            event.epoch === context.epoch &&
            (context.loop || context.shown < context.items.length),
          target: "showing",
          reenter: true,
        },
        RETRY: {
          guard: "current",
          actions: ["retryCurrent", "schedule"],
        },
        MEDIA_ENDED: {
          guard: ({ context, event }) =>
            event.epoch === context.epoch &&
            !zoneEntry(context)?.loop &&
            (context.loop || context.shown < context.items.length),
          target: "showing",
          reenter: true,
        },
        MEDIA_FAILED: [
          {
            guard: ({ context, event }) =>
              event.epoch === context.epoch &&
              (context.loop || context.shown < context.items.length),
            target: "showing",
            reenter: true,
          },
          { guard: "current", actions: "retryLater" },
        ],
      },
    },
  },
});

export type ZoneActor = ActorRefFrom<typeof zoneMachine>;
