/**
 * The playlist lifecycle of one playing presentation, as an explicit state
 * machine.
 *
 * One actor runs per presentation generation. It decides which occurrence is
 * mounted, when it is shown, when it completes, how a failure is isolated and
 * when the rotation advances. It never touches the DOM: it publishes a
 * `StageEntry` that the stage renders, and it receives typed events back from
 * the item surfaces (ready, ended, failed, evidence).
 *
 * Time comes only from the injected `RuntimeClock`. Deadlines (an item's
 * duration, a failure back-off, the one-task advance hand-off) are scheduled
 * through a TimerGroup owned by the current occurrence and arrive as events;
 * mounting the next occurrence cancels the group, so nothing scheduled for a
 * replaced item can act on its successor.
 *
 * Under a shared (synchronized) timeline this machine never changes the
 * occurrence on its own: the group timeline re-presents at each boundary.
 */
import { and, assign, enqueueActions, setup, type ActorRefFrom } from "xstate";
import type { EvidenceKind, RuntimeItem } from "../host/contract";
import { TimerGroup, type RuntimeClock } from "../clock/scheduler";
import {
  ItemCompletion,
  playbackAuthorityOf,
  transitionForSwap,
  type CompletionOutcome,
  type CompletionSource,
  type PlaybackAuthority,
} from "./playback-policy";
import {
  layoutPayload,
  widgetPayload,
  type EngineReporter,
  type StageEntry,
} from "./model";

/** How long a still item stays up when the item has no duration. */
export const IMAGE_DEFAULT_MS = 10_000;
export const WEBSITE_DEFAULT_MS = 60_000;
/** Healthy long-lived content re-reports on this cadence. */
export const ALIVE_INTERVAL_MS = 30_000;
/** A playlist of nothing but empty widgets pauses this long per lap. */
export const EMPTY_LAP_PAUSE_MS = 30_000;

export interface PresentationInput {
  items: RuntimeItem[];
  generation: number;
  synchronized: boolean;
  /** The item on screen when this presentation took over, if any. */
  previousItemId: string | null;
  /** First mount number to use; mounts stay unique across presentations. */
  firstMount: number;
  clock: RuntimeClock;
  reporter: EngineReporter;
}

export interface PresentationContext {
  items: RuntimeItem[];
  generation: number;
  authority: PlaybackAuthority;
  index: number;
  consecutiveFailures: number;
  consecutiveEmptySkips: number;
  nextMount: number;
  previousItemId: string | null;
  stage: StageEntry | null;
  completion: ItemCompletion;
  timers: TimerGroup;
  clock: RuntimeClock;
  reporter: EngineReporter;
}

type OnMount<T extends string, E = object> = { type: T; mount: number } & E;

/** Events a surface sends about the occurrence it renders. */
export type SurfaceEvent =
  | OnMount<"SURFACE_READY">
  | OnMount<"SURFACE_ENDED", { source: "ended" | "end-offset" }>
  | OnMount<"SURFACE_FAILED", { message: string }>
  | OnMount<"SURFACE_RESUMED">
  | OnMount<"SURFACE_EVIDENCE", { kind: EvidenceKind; zoneId?: string }>
  | OnMount<"WEBSITE_FAILED", { reason: string; fallback: boolean }>
  | OnMount<"WEBSITE_RECOVERED">
  | OnMount<"FALLBACK_SHOWN">;

export type PresentationEvent =
  | SurfaceEvent
  | OnMount<"DURATION_DUE">
  | OnMount<"ADVANCE_DUE">
  | OnMount<"BACKOFF_DUE">
  | OnMount<"EMPTY_SKIP_DUE", { exhausted: boolean }>
  | OnMount<"OUTCOME", { outcome: Exclude<CompletionOutcome, "ignore"> }>
  | { type: "RETRY" }
  | { type: "SKIP" }
  | { type: "STOP" };

function currentItem(context: PresentationContext): RuntimeItem | null {
  return context.stage?.item ?? null;
}

export function missingPayloadReason(item: RuntimeItem): string | null {
  if (item.kind === "widget" && !widgetPayload(item)) {
    return "widget payload missing";
  }
  if (item.kind === "layout" && !layoutPayload(item)) {
    return "layout payload missing";
  }
  if ((item.kind === "website" || item.kind === "youtube") && !item.website) {
    return "website configuration missing";
  }
  return null;
}

function isAutoSkipWidget(
  item: RuntimeItem,
  authority: PlaybackAuthority,
): boolean {
  return (
    item.kind === "widget" &&
    widgetPayload(item)?.autoSkip === true &&
    authority === "local"
  );
}

function completionSource(event: PresentationEvent): CompletionSource | null {
  switch (event.type) {
    case "SURFACE_ENDED":
      return event.source;
    case "DURATION_DUE":
      return "duration-timer";
    case "WEBSITE_FAILED":
      return "failure";
    default:
      return null;
  }
}

export const presentationMachine = setup({
  types: {
    context: {} as PresentationContext,
    input: {} as PresentationInput,
    events: {} as PresentationEvent,
  },
  guards: {
    noItems: ({ context }) => context.items.length === 0,
    hasStage: ({ context }) => context.stage !== null,
    isCurrent: ({ context, event }) =>
      "mount" in event && context.stage?.mount === event.mount,
    missingPayload: ({ context }) => {
      const item = currentItem(context);
      return item !== null && missingPayloadReason(item) !== null;
    },
    autoSkipWidget: ({ context }) => {
      const item = currentItem(context);
      return item !== null && isAutoSkipWidget(item, context.authority);
    },
    canSkip: ({ context }) =>
      context.stage !== null && context.authority === "local",
    advances: ({ event }) =>
      event.type === "OUTCOME" && event.outcome === "advance",
    restarts: ({ event }) =>
      event.type === "OUTCOME" && event.outcome === "restart",
    websiteFallback: ({ event }) =>
      event.type === "WEBSITE_FAILED" && event.fallback,
  },
  actions: {
    /** Mount the occurrence at `context.index`. */
    mount: assign(({ context }) => {
      const item = context.items[context.index]!;
      // Decided before the stage moves on: the item leaving the screen is
      // what says whether this swap has anything to dissolve.
      const outgoing = context.stage?.item.id ?? context.previousItemId;
      const stage: StageEntry = {
        mount: context.nextMount,
        generation: context.generation,
        item,
        transition: transitionForSwap(item.transition, outgoing, item.id),
        phase: "preparing",
        restarts: 0,
      };
      return {
        stage,
        nextMount: context.nextMount + 1,
        // Exactly one completion may act per occurrence. Only a single-video
        // local playlist restarts in place; everything else advances.
        completion: new ItemCompletion(
          context.authority,
          context.items.length === 1 && item.kind === "video",
        ),
        consecutiveEmptySkips: isAutoSkipWidget(item, context.authority)
          ? context.consecutiveEmptySkips
          : 0,
      };
    }),
    /** Evidence and deadlines that start with the occurrence itself. */
    startOccurrence: ({ context, self }) => {
      context.timers.cancelAll();
      const stage = context.stage!;
      const item = stage.item;
      // The host opens a child playback session on this signal.
      context.reporter.evidence("item-started", item.id);
      if (context.authority !== "local") return;
      const due = (delayMs: number) =>
        context.timers.after(delayMs, () =>
          self.send({ type: "DURATION_DUE", mount: stage.mount }),
        );
      if (item.kind === "video" && item.durationMs) {
        // A fixed duration (rare for video) also bounds the item.
        due(item.durationMs);
      } else if (item.kind === "website" || item.kind === "youtube") {
        due(item.durationMs ?? WEBSITE_DEFAULT_MS);
      }
    },
    nextIndex: assign(({ context }) => ({
      index: (context.index + 1) % context.items.length,
    })),
    showStage: assign(({ context }) => ({
      stage: context.stage
        ? { ...context.stage, phase: "shown" as const }
        : null,
      consecutiveFailures: 0,
    })),
    /** Evidence, heartbeats and completion once an occurrence is visible. */
    onShown: ({ context, self }) => {
      const stage = context.stage!;
      const item = stage.item;
      const report = context.reporter;
      const alive = (kind: EvidenceKind) =>
        context.timers.every(ALIVE_INTERVAL_MS, () =>
          report.evidence(kind, item.id),
        );
      const complete = (delayMs: number | null) => {
        if (context.authority !== "local" || !delayMs) return;
        context.timers.after(delayMs, () =>
          self.send({ type: "DURATION_DUE", mount: stage.mount }),
        );
      };
      switch (item.kind) {
        case "image":
          report.evidence("image-shown", item.id);
          alive("image-shown");
          complete(item.durationMs ?? IMAGE_DEFAULT_MS);
          break;
        case "widget":
          report.evidence("widget-shown", item.id);
          alive("widget-alive");
          complete(item.durationMs);
          break;
        case "layout":
          report.evidence("layout-shown", item.id);
          alive("layout-alive");
          complete(item.durationMs);
          break;
        case "website":
        case "youtube":
          report.evidence("website-loaded", item.id);
          alive("website-alive");
          break;
        case "video":
          break;
      }
    },
    /** Ask the arbiter what a completion signal means for this occurrence. */
    finish: enqueueActions(({ context, event, enqueue }) => {
      const source = completionSource(event);
      if (!source || !context.stage) return;
      // The arbiter is settled here, while the transition is computed, so a
      // second signal in the same macrostep already sees it settled.
      const outcome = context.completion.complete(source);
      if (outcome === "ignore") return;
      // One completion path won the occurrence; cancel the competing deadline
      // so it cannot fire into the restart or the next item.
      const timers = context.timers;
      enqueue(() => timers.cancelAll());
      enqueue.raise({ type: "OUTCOME", mount: context.stage.mount, outcome });
    }),
    restartInPlace: enqueueActions(({ context, enqueue }) => {
      const stage = context.stage!;
      const reporter = context.reporter;
      enqueue(() => reporter.evidence("item-transition", stage.item.id));
      // Single-item loop: the stage seeks and replays the same element.
      enqueue.assign({ stage: { ...stage, restarts: stage.restarts + 1 } });
    }),
    reportTransition: ({ context }) => {
      context.reporter.evidence(
        "item-transition",
        currentItem(context)?.id ?? null,
      );
    },
    scheduleAdvance: ({ context, self }) => {
      const mount = context.stage!.mount;
      context.timers.cancelAll();
      // The host may activate a pending manifest on this boundary and push a
      // fresh presentation; one task lets that land so the swap is seamless
      // rather than one item late.
      context.timers.soon(() => self.send({ type: "ADVANCE_DUE", mount }));
    },
    recordFailure: enqueueActions(({ context, event, enqueue }) => {
      const item = currentItem(context);
      const message =
        event.type === "SURFACE_FAILED"
          ? event.message
          : ((item && missingPayloadReason(item)) ?? "item failed");
      const reporter = context.reporter;
      enqueue(() => reporter.playbackError(item?.id ?? null, message));
      enqueue.assign({ consecutiveFailures: context.consecutiveFailures + 1 });
    }),
    scheduleBackoff: ({ context, self }) => {
      context.timers.cancelAll();
      if (context.authority === "shared") {
        // The group timeline moves this screen to the next occurrence.
        // Advancing locally would desync the group until the next boundary.
        return;
      }
      const mount = context.stage!.mount;
      // Isolate the failure and keep rotating; the pause grows when
      // everything is failing so a fully broken playlist does not spin.
      const delay = Math.min(
        2_000 *
          Math.max(context.consecutiveFailures - context.items.length, 0) +
          1_000,
        30_000,
      );
      context.timers.after(delay, () =>
        self.send({ type: "BACKOFF_DUE", mount }),
      );
    },
    startEmptySkip: enqueueActions(({ context, enqueue, self }) => {
      const skips = context.consecutiveEmptySkips + 1;
      enqueue.assign({ consecutiveEmptySkips: skips });
      const stage = context.stage!;
      const { reporter, timers } = context;
      const exhausted = skips >= context.items.length;
      enqueue(() => {
        reporter.evidence("widget-empty", stage.item.id);
        timers.after(exhausted ? EMPTY_LAP_PAUSE_MS : 0, () =>
          self.send({ type: "EMPTY_SKIP_DUE", mount: stage.mount, exhausted }),
        );
      });
    }),
    resetEmptySkipsIfExhausted: assign(({ context, event }) => ({
      consecutiveEmptySkips:
        event.type === "EMPTY_SKIP_DUE" && event.exhausted
          ? 0
          : context.consecutiveEmptySkips,
    })),
    reportSurfaceEvidence: ({ context, event }) => {
      if (event.type !== "SURFACE_EVIDENCE") return;
      context.reporter.evidence(
        event.kind,
        currentItem(context)?.id ?? null,
        event.zoneId,
      );
    },
    occurrenceStarted: ({ context }) => context.completion.occurrenceStarted(),
    websiteFailed: ({ context, event }) => {
      if (event.type !== "WEBSITE_FAILED") return;
      context.reporter.playbackError(
        currentItem(context)?.id ?? null,
        "website failed: " + event.reason,
      );
    },
    websiteRecovered: ({ context }) => {
      context.reporter.websiteRecovered();
      context.reporter.evidence(
        "website-loaded",
        currentItem(context)?.id ?? null,
      );
    },
    fallbackShown: ({ context, self }) => {
      const stage = context.stage!;
      context.reporter.evidence("image-shown", stage.item.id);
      if (context.authority !== "local") return;
      context.timers.after(stage.item.durationMs ?? WEBSITE_DEFAULT_MS, () =>
        self.send({ type: "DURATION_DUE", mount: stage.mount }),
      );
    },
    stopTimers: ({ context }) => context.timers.cancelAll(),
  },
}).createMachine({
  id: "presentation",
  context: ({ input }) => {
    const authority = playbackAuthorityOf(input.synchronized);
    return {
      items: input.items,
      generation: input.generation,
      authority,
      index: 0,
      consecutiveFailures: 0,
      consecutiveEmptySkips: 0,
      nextMount: input.firstMount,
      previousItemId: input.previousItemId,
      stage: null,
      completion: new ItemCompletion(authority, false),
      timers: new TimerGroup(input.clock),
      clock: input.clock,
      reporter: input.reporter,
    };
  },
  initial: "start",
  on: {
    STOP: { target: ".stopped" },
    // A retry command re-mounts the current occurrence from scratch.
    RETRY: { guard: "hasStage", target: ".routing", reenter: true },
    // A grouped screen cannot skip on its own: the shared timeline would snap
    // it back within milliseconds.
    SKIP: { guard: "canSkip", target: ".advancing", reenter: true },
    SURFACE_EVIDENCE: { guard: "isCurrent", actions: "reportSurfaceEvidence" },
  },
  states: {
    start: {
      always: [{ guard: "noItems", target: "empty" }, { target: "routing" }],
    },
    empty: {},
    stopped: {
      type: "final",
      entry: "stopTimers",
    },
    /** Mount the occurrence at `index` and decide how it is shown. */
    routing: {
      entry: ["mount", "startOccurrence"],
      always: [
        { guard: "missingPayload", target: "failed" },
        { guard: "autoSkipWidget", target: "skipping" },
        { target: "preparing" },
      ],
    },
    /** Staged on the hidden layer; the surface is loading. */
    preparing: {
      on: {
        SURFACE_READY: {
          guard: "isCurrent",
          target: "showing",
          actions: ["showStage", "onShown"],
        },
        FALLBACK_SHOWN: {
          guard: "isCurrent",
          target: "showing",
          actions: ["showStage", "fallbackShown"],
        },
        SURFACE_FAILED: { guard: "isCurrent", target: "failed" },
        DURATION_DUE: { guard: "isCurrent", actions: "finish" },
        WEBSITE_FAILED: [
          {
            guard: and(["isCurrent", "websiteFallback"]),
            actions: "websiteFailed",
          },
          { guard: "isCurrent", actions: ["websiteFailed", "finish"] },
        ],
        OUTCOME: { guard: "advances", target: "advancing" },
      },
    },
    /** On screen. */
    showing: {
      on: {
        SURFACE_ENDED: { guard: "isCurrent", actions: "finish" },
        DURATION_DUE: { guard: "isCurrent", actions: "finish" },
        SURFACE_RESUMED: { guard: "isCurrent", actions: "occurrenceStarted" },
        SURFACE_FAILED: { guard: "isCurrent", target: "failed" },
        WEBSITE_RECOVERED: { guard: "isCurrent", actions: "websiteRecovered" },
        WEBSITE_FAILED: [
          {
            guard: and(["isCurrent", "websiteFallback"]),
            actions: "websiteFailed",
          },
          { guard: "isCurrent", actions: ["websiteFailed", "finish"] },
        ],
        FALLBACK_SHOWN: { guard: "isCurrent", actions: "fallbackShown" },
        OUTCOME: [
          { guard: "advances", target: "advancing" },
          { guard: "restarts", actions: "restartInPlace" },
        ],
      },
    },
    /** The item-transition is reported; the next occurrence mounts next task. */
    advancing: {
      entry: ["reportTransition", "scheduleAdvance"],
      on: {
        ADVANCE_DUE: {
          guard: "isCurrent",
          target: "routing",
          actions: "nextIndex",
        },
      },
    },
    failed: {
      entry: ["recordFailure", "scheduleBackoff"],
      on: {
        SURFACE_FAILED: { guard: "isCurrent", target: "failed", reenter: true },
        BACKOFF_DUE: {
          guard: "isCurrent",
          target: "routing",
          actions: "nextIndex",
        },
      },
    },
    skipping: {
      entry: "startEmptySkip",
      on: {
        EMPTY_SKIP_DUE: {
          guard: "isCurrent",
          target: "advancing",
          actions: "resetEmptySkipsIfExhausted",
        },
      },
    },
  },
});

export type PresentationActor = ActorRefFrom<typeof presentationMachine>;
