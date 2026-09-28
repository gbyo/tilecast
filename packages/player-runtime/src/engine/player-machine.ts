/**
 * The top-level player lifecycle: which kind of surface owns the display, and,
 * while content plays, which presentation actor runs it.
 *
 * Every new presentation replaces the previous one outright. Re-entering the
 * `playing` state stops the invoked presentation actor (cancelling all of its
 * deadlines) and invokes a fresh one, which is how a takeover, a manifest
 * change, a synchronized boundary or a re-projection interrupts whatever was
 * running. The stage keeps the outgoing frame on screen until the incoming
 * occurrence is ready, so replacement never exposes black.
 */
import { assign, sendTo, setup } from "xstate";
import type { RuntimePresentation } from "../host/contract";
import type { RuntimeClock } from "../clock/scheduler";
import type { EngineReporter } from "./model";
import {
  presentationMachine,
  type PresentationEvent,
  type SurfaceEvent,
} from "./presentation-machine";

/** Mount numbering and the last shown item survive presentation changes. */
export interface StageMemory {
  nextMount: number;
  lastItemId: string | null;
}

export interface PlayerInput {
  clock: RuntimeClock;
  reporter: EngineReporter;
  memory: StageMemory;
}

export interface PlayerContext extends PlayerInput {
  presentation: RuntimePresentation | null;
}

export type PlayerEvent =
  | { type: "PRESENT"; presentation: RuntimePresentation }
  | { type: "RETRY" }
  | { type: "SKIP" }
  | SurfaceEvent;

export const PRESENTATION_ACTOR_ID = "presentation";

export const playerMachine = setup({
  types: {
    context: {} as PlayerContext,
    input: {} as PlayerInput,
    events: {} as PlayerEvent,
  },
  actors: { presentation: presentationMachine },
  guards: {
    playing: ({ context }) => context.presentation?.state === "playing",
    sleeping: ({ context }) => context.presentation?.state === "sleep",
  },
  actions: {
    store: assign({
      presentation: ({ event }) =>
        event.type === "PRESENT" ? event.presentation : null,
    }),
    forward: sendTo(
      PRESENTATION_ACTOR_ID,
      ({ event }) => event as PresentationEvent,
    ),
  },
}).createMachine({
  id: "player",
  context: ({ input }) => ({ ...input, presentation: null }),
  initial: "waiting",
  on: {
    PRESENT: { target: ".routing", reenter: true, actions: "store" },
  },
  states: {
    waiting: {},
    routing: {
      always: [
        { guard: "playing", target: "playing" },
        { guard: "sleeping", target: "sleep" },
        { target: "status" },
      ],
    },
    /** A Tilecast-owned surface: setup, pairing, idle, error, safe mode. */
    status: {},
    /** Outside active hours: true black or the configured overlay. */
    sleep: {},
    playing: {
      invoke: {
        id: PRESENTATION_ACTOR_ID,
        src: "presentation",
        input: ({ context }) => {
          const presentation = context.presentation as Extract<
            RuntimePresentation,
            { state: "playing" }
          >;
          return {
            items: presentation.items,
            generation: presentation.generation,
            synchronized: presentation.synchronized === true,
            previousItemId: context.memory.lastItemId,
            firstMount: context.memory.nextMount,
            clock: context.clock,
            reporter: context.reporter,
          };
        },
      },
      on: {
        RETRY: { actions: "forward" },
        SKIP: { actions: "forward" },
        SURFACE_READY: { actions: "forward" },
        SURFACE_ENDED: { actions: "forward" },
        SURFACE_FAILED: { actions: "forward" },
        SURFACE_RESUMED: { actions: "forward" },
        SURFACE_EVIDENCE: { actions: "forward" },
        WEBSITE_FAILED: { actions: "forward" },
        WEBSITE_RECOVERED: { actions: "forward" },
        FALLBACK_SHOWN: { actions: "forward" },
      },
    },
  },
});
