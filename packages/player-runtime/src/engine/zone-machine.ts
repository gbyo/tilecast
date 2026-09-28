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

/** A zone entry that failed to play is retried after this long. */
export const ZONE_RETRY_MS = 2_000;
export const ZONE_IMAGE_DEFAULT_MS = 10_000;

export interface ZoneInput {
  items: RuntimeLayoutZonePlaylistItem[];
  clock: RuntimeClock;
  /** Every advance is fresh evidence that the zone is alive. */
  onAdvance: () => void;
}

export interface ZoneContext {
  items: RuntimeLayoutZonePlaylistItem[];
  /** How many entries have been shown; the current one is `(shown-1) % n`. */
  shown: number;
  timers: TimerGroup;
  onAdvance: () => void;
}

export type ZoneEvent =
  | { type: "MEDIA_ENDED"; shown: number }
  | { type: "MEDIA_FAILED"; shown: number }
  | { type: "NEXT"; shown: number };

export function zoneEntry(
  context: Pick<ZoneContext, "items" | "shown">,
): { entry: RuntimeLayoutZonePlaylistItem; loop: boolean } | null {
  if (context.items.length === 0 || context.shown === 0) return null;
  const entry = context.items[(context.shown - 1) % context.items.length]!;
  return {
    entry,
    loop: entry.kind === "video" && (entry.loop || context.items.length === 1),
  };
}

export const zoneMachine = setup({
  types: {
    context: {} as ZoneContext,
    input: {} as ZoneInput,
    events: {} as ZoneEvent,
  },
  guards: {
    current: ({ context, event }) => event.shown === context.shown,
    nonEmpty: ({ context }) => context.items.length > 0,
  },
  actions: {
    advance: assign(({ context }) => ({ shown: context.shown + 1 })),
    announce: ({ context }) => context.onAdvance(),
    schedule: ({ context, self }) => {
      context.timers.cancelAll();
      const current = zoneEntry(context);
      if (!current || current.entry.kind !== "image") return;
      if (context.items.length <= 1) return;
      const shown = context.shown;
      context.timers.after(
        current.entry.durationMs ?? ZONE_IMAGE_DEFAULT_MS,
        () => self.send({ type: "NEXT", shown }),
      );
    },
    retryLater: ({ context, self }) => {
      context.timers.cancelAll();
      const shown = context.shown;
      context.timers.after(ZONE_RETRY_MS, () =>
        self.send({ type: "NEXT", shown }),
      );
    },
    stopTimers: ({ context }) => context.timers.cancelAll(),
  },
}).createMachine({
  id: "zone",
  context: ({ input }) => ({
    items: input.items,
    shown: 0,
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
        NEXT: { guard: "current", target: "showing", reenter: true },
        MEDIA_ENDED: {
          guard: ({ context, event }) =>
            event.shown === context.shown && !zoneEntry(context)?.loop,
          target: "showing",
          reenter: true,
        },
        MEDIA_FAILED: { guard: "current", actions: "retryLater" },
      },
    },
  },
});

export type ZoneActor = ActorRefFrom<typeof zoneMachine>;
