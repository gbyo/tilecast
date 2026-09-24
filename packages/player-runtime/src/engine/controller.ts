/**
 * The playback engine's single entry point.
 *
 * Takes host presentation messages, projects widget and layout references when
 * the host sent a projection context, hands synchronized presentations to the
 * shared timeline, and runs everything else through the player machine. It
 * publishes a small view state (which surface, which stage entry) that the
 * Lit views render; views send surface events back through `surface()`.
 *
 * Nothing here touches the DOM, and nothing here reads a timer except through
 * the injected clock.
 */
import { createActor, type Actor } from "xstate";
import type {
  ActivationRefV1,
  EvidenceKind,
  PresentationMessage,
  PresentationResultV1,
  RuntimePresentation,
} from "../host/contract";
import { TimerGroup, type RuntimeClock } from "../clock/scheduler";
import {
  createProjector,
  presentationNeedsProjection,
  PROJECTION_INTERVAL_MS,
  type Projector,
} from "../compat/projector";
import type { EngineReporter, StageEntry } from "./model";
import {
  PRESENTATION_ACTOR_ID,
  playerMachine,
  type StageMemory,
} from "./player-machine";
import type { SurfaceEvent } from "./presentation-machine";
import { SynchronizedTimeline, type SyncPosition } from "./timeline";

export type RuntimeViewState =
  | { mode: "waiting" }
  | { mode: "status"; presentation: RuntimePresentation; key: number }
  | {
      mode: "sleep";
      presentation: Extract<RuntimePresentation, { state: "sleep" }>;
      key: number;
    }
  | { mode: "playing"; stage: StageEntry | null; key: number };

/** What the engine tells the host. Activation tagging happens here. */
export interface HostReports {
  evidence(
    activation: ActivationRefV1 | null,
    kind: EvidenceKind,
    itemId: string | null,
    zoneId?: string,
  ): void;
  playbackError(
    activation: ActivationRefV1 | null,
    itemId: string | null,
    message: string,
  ): void;
  presentationResult(result: PresentationResultV1): void;
  websiteRecovered(): void;
}

export interface ControllerOptions {
  clock: RuntimeClock;
  reports: HostReports;
  /** Whether the host supplies synchronized timing (a capability). */
  synchronizedPlayback: boolean;
}

type Playing = Extract<RuntimePresentation, { state: "playing" }>;

export class PlaybackController {
  private readonly clock: RuntimeClock;
  private readonly reports: HostReports;
  private readonly player: Actor<typeof playerMachine>;
  private readonly memory: StageMemory = { nextMount: 1, lastItemId: null };
  private readonly timeline: SynchronizedTimeline;
  private readonly projectionTimers: TimerGroup;
  private readonly listeners = new Set<(state: RuntimeViewState) => void>();
  private readonly syncListeners = new Set<(p: SyncPosition | null) => void>();
  private activation: ActivationRefV1 | null = null;
  private generation = 0;
  private presentKey = 0;
  private view: RuntimeViewState = { mode: "waiting" };
  private childSubscription: { unsubscribe(): void } | null = null;
  private childRef: unknown = null;
  private lastSync: SyncPosition | null = null;

  constructor(private readonly options: ControllerOptions) {
    this.clock = options.clock;
    this.reports = options.reports;
    const reporter: EngineReporter = {
      evidence: (kind, itemId, zoneId) =>
        this.reports.evidence(this.activation, kind, itemId, zoneId),
      playbackError: (itemId, message) =>
        this.reports.playbackError(this.activation, itemId, message),
      websiteRecovered: () => this.reports.websiteRecovered(),
    };
    this.player = createActor(playerMachine, {
      input: { clock: this.clock, reporter, memory: this.memory },
    });
    this.timeline = new SynchronizedTimeline(
      this.clock,
      reporter,
      (presentation) => this.run(presentation),
      (position) => {
        this.lastSync = position;
        for (const listener of this.syncListeners) listener(position);
      },
      () => ++this.generation,
    );
    this.projectionTimers = new TimerGroup(this.clock);
    this.player.subscribe(() => this.onPlayerSnapshot());
    this.player.start();
  }

  /** Apply a host presentation message; reports accepted or rejected. */
  present(message: PresentationMessage): void {
    const activation = message.activation ?? null;
    const source = message.presentation;
    let projector: Projector | null = null;
    let projected: RuntimePresentation;
    try {
      projector = createProjector(message.projection);
      if (presentationNeedsProjection(source) && !projector) {
        throw new Error("widget or layout projection is unavailable");
      }
      // Project before accepting: an activation the runtime cannot render is
      // rejected, never shown partially.
      projected = projector
        ? projector.project(source, this.clock.wallNow())
        : source;
    } catch (error) {
      this.reports.presentationResult({
        activation,
        outcome: "rejected",
        code: "runtime_error",
        message: String((error as Error)?.message ?? error).slice(0, 240),
      });
      return;
    }

    this.activation = activation;
    // Accepted before anything plays, so no evidence for this activation can
    // reach the host ahead of its acceptance.
    this.reports.presentationResult({ activation, outcome: "accepted" });
    this.projectionTimers.cancelAll();
    this.timeline.stop();
    this.start(projected, message);
    if (projector && projected.state === "playing") {
      let key = JSON.stringify(projected);
      // Re-render on the reference player's selection cadence; only a changed
      // projection restarts playback.
      this.projectionTimers.every(PROJECTION_INTERVAL_MS, () => {
        const next = projector.project(source, this.clock.wallNow());
        const nextKey = JSON.stringify(next);
        if (nextKey === key) return;
        key = nextKey;
        this.timeline.stop();
        this.start(next, message);
      });
    }
  }

  retry(): void {
    this.player.send({ type: "RETRY" });
  }

  skip(): void {
    this.player.send({ type: "SKIP" });
  }

  /** Events from item surfaces. */
  surface(event: SurfaceEvent): void {
    this.player.send(event);
  }

  /**
   * A Tilecast status surface has painted. Status surfaces produce no item
   * evidence of their own, so this is the evidence that the screen is showing
   * what it was told to.
   */
  statusPainted(key: number): void {
    if (
      (this.view.mode === "status" || this.view.mode === "sleep") &&
      this.view.key === key
    ) {
      this.reports.evidence(this.activation, "surface-shown", null);
    }
  }

  subscribe(listener: (state: RuntimeViewState) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  onSyncPosition(
    listener: (position: SyncPosition | null) => void,
  ): () => void {
    this.syncListeners.add(listener);
    listener(this.lastSync);
    return () => this.syncListeners.delete(listener);
  }

  get state(): RuntimeViewState {
    return this.view;
  }

  /** Engine state for diagnostics and the conformance probe. */
  describe(): Record<string, unknown> {
    const snapshot = this.player.getSnapshot();
    const child = snapshot.children[PRESENTATION_ACTOR_ID] as
      | { getSnapshot(): { value: unknown; context: Record<string, unknown> } }
      | undefined;
    const childSnapshot = child?.getSnapshot();
    return {
      player: snapshot.value,
      presentation: childSnapshot?.value ?? null,
      index: childSnapshot?.context["index"] ?? null,
      synchronized: this.timeline.active,
      activation: this.activation,
    };
  }

  stop(): void {
    this.projectionTimers.cancelAll();
    this.timeline.stop();
    this.player.stop();
  }

  private start(
    presentation: RuntimePresentation,
    message: PresentationMessage,
  ) {
    if (
      presentation.state === "playing" &&
      presentation.synchronized === true &&
      message.timing &&
      this.options.synchronizedPlayback
    ) {
      this.timeline.activate(presentation, message.timing);
      return;
    }
    if (presentation.state === "playing") {
      this.run({ ...presentation, generation: ++this.generation });
    } else {
      this.run(presentation);
    }
  }

  private run(presentation: RuntimePresentation | Playing): void {
    this.presentKey += 1;
    this.player.send({ type: "PRESENT", presentation });
  }

  private onPlayerSnapshot(): void {
    const snapshot = this.player.getSnapshot();
    const child = snapshot.children[PRESENTATION_ACTOR_ID] as
      | Actor<typeof import("./presentation-machine").presentationMachine>
      | undefined;
    if (child !== this.childRef) {
      this.childSubscription?.unsubscribe();
      this.childSubscription = null;
      this.childRef = child ?? null;
      if (child) {
        this.childSubscription = child.subscribe(() => this.publishPlaying());
      }
    }
    const presentation = snapshot.context.presentation;
    if (!presentation) return;
    if (snapshot.matches("playing")) {
      this.publishPlaying();
    } else if (presentation.state === "sleep") {
      this.publish({ mode: "sleep", presentation, key: this.presentKey });
    } else {
      this.publish({ mode: "status", presentation, key: this.presentKey });
    }
  }

  private publishPlaying(): void {
    const child = this.childRef as {
      getSnapshot(): {
        context: { stage: StageEntry | null; nextMount: number };
      };
    } | null;
    const context = child?.getSnapshot().context;
    const stage = context?.stage ?? null;
    if (context) {
      this.memory.nextMount = Math.max(
        this.memory.nextMount,
        context.nextMount,
      );
    }
    if (stage) this.memory.lastItemId = stage.item.id;
    if (
      this.view.mode === "playing" &&
      this.view.key === this.presentKey &&
      this.view.stage === stage
    ) {
      return;
    }
    this.publish({ mode: "playing", stage, key: this.presentKey });
  }

  private publish(state: RuntimeViewState): void {
    this.view = state;
    for (const listener of this.listeners) listener(state);
  }
}
