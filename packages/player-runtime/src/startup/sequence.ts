/**
 * The startup sequence: the branded first experience of a runtime document.
 *
 * The document opens on the pulsing logo (static index.html). The reveal may
 * begin only when both are true:
 *
 *   - the first presentation is on screen beneath the layer
 *     (`presentationShown`), and
 *   - the pulse has played for one full loop (`STARTUP_MIN_INTRO_MS`).
 *
 * Until then the pulse loops for as long as startup takes. The sequence is a
 * visual gate only: the runtime reports `host.ready()`, accepts
 * presentations and reports evidence exactly as it would without it.
 *
 * The state lives in this document and nowhere else, so a new runtime
 * document (process start, service restart, update, recovery reload) plays
 * the sequence again, and nothing that happens inside a live document
 * (presentation changes, takeovers, a reconnected host) replays it.
 */
import type { RuntimeClock, TimerHandle } from "../clock/scheduler";
import { PULSE_CYCLE_MS, StartupView, type RevealHandle } from "./view";

/** One full loop of the pulse: the shortest visible startup. */
export const STARTUP_MIN_INTRO_MS = PULSE_CYCLE_MS;

/**
 * A presentation that was accepted but never reached the screen (its first
 * items failing, for example) does not hide the display indefinitely.
 */
export const STARTUP_SHOWN_CEILING_MS = 10_000;

/** A suspended compositor must not keep an accepted presentation covered. */
export const STARTUP_REVEAL_CEILING_MS = 4_000;

export type StartupPhase =
  /** The pulsing logo; the presentation may prepare beneath. */
  | "intro"
  /** The card is moving toward the camera. */
  | "revealing"
  /** The screen is the white sheet, fading into the presentation. */
  | "resolving"
  /** The layer is gone. */
  | "done";

/** What the sequence needs from the layer; `StartupView` in production. */
export interface StartupSurface {
  /** When the pulse began on screen (performance.now() time base). */
  pulseStarted(): Promise<number | null>;
  setPhase(phase: StartupPhase): void;
  reveal(options: { reducedMotion: boolean }): RevealHandle;
  remove(): void;
}

/** The signals the views send. */
export interface StartupSignals {
  /** The host sent something to show. */
  presentationAccepted(): void;
  /** The first presentation has painted beneath the layer. */
  presentationShown(): void;
}

export interface StartupOptions {
  clock: RuntimeClock;
  surface: StartupSurface | null;
  reducedMotion: () => boolean;
  /**
   * Monotonic time the pulse began. By default the surface reports it once
   * the pulse is running, so time with no frames on screen never counts.
   */
  introStartedAt?: number;
}

export interface StartupDescription {
  phase: StartupPhase;
  presentationShown: boolean;
  minimumIntroComplete: boolean;
}

export class StartupSequence implements StartupSignals {
  private phaseValue: StartupPhase = "intro";
  private shown = false;
  private introComplete = false;
  private readonly timers: TimerHandle[] = [];
  private ceiling: TimerHandle | null = null;
  private readonly uncoveredListeners: (() => void)[] = [];
  private readonly phaseListeners = new Set<(phase: StartupPhase) => void>();

  constructor(private readonly options: StartupOptions) {
    const { clock, surface } = options;
    if (!surface) {
      this.enter("done");
      return;
    }
    if (options.introStartedAt !== undefined) {
      this.introFrom(options.introStartedAt);
    } else {
      void surface.pulseStarted().then(
        (startedAt) => this.introFrom(startedAt ?? clock.monotonicNow()),
        () => this.introFrom(clock.monotonicNow()),
      );
    }
  }

  private introFrom(startedAt: number): void {
    if (this.phaseValue !== "intro") return;
    this.timers.push(
      this.options.clock.at(startedAt + STARTUP_MIN_INTRO_MS, () => {
        this.introComplete = true;
        this.evaluate();
      }),
    );
  }

  get phase(): StartupPhase {
    return this.phaseValue;
  }

  /** True while the layer hides the presentation. */
  get covering(): boolean {
    return this.phaseValue === "intro" || this.phaseValue === "revealing";
  }

  presentationAccepted(): void {
    if (this.phaseValue !== "intro" || this.ceiling) return;
    const clock = this.options.clock;
    this.ceiling = clock.at(
      clock.monotonicNow() + STARTUP_SHOWN_CEILING_MS,
      () => {
        // Animation.ready can remain pending on a suspended renderer.
        this.introComplete = true;
        this.presentationShown();
        this.evaluate();
      },
    );
    this.timers.push(this.ceiling);
  }

  presentationShown(): void {
    if (this.shown) return;
    this.presentationAccepted();
    this.shown = true;
    this.evaluate();
  }

  /** Remove the layer now, without a reveal (conformance runs). */
  skip(): void {
    if (this.phaseValue === "done") return;
    this.finish();
  }

  /** Called once when the presentation is no longer hidden. */
  onUncovered(listener: () => void): void {
    if (!this.covering) listener();
    else this.uncoveredListeners.push(listener);
  }

  onPhase(listener: (phase: StartupPhase) => void): () => void {
    this.phaseListeners.add(listener);
    return () => this.phaseListeners.delete(listener);
  }

  describe(): StartupDescription {
    return {
      phase: this.phaseValue,
      presentationShown: this.shown,
      minimumIntroComplete: this.introComplete,
    };
  }

  private evaluate(): void {
    if (this.phaseValue !== "intro" || !this.shown || !this.introComplete) {
      return;
    }
    const surface = this.options.surface!;
    this.enter("revealing");
    this.ceiling?.cancel();
    const clock = this.options.clock;
    this.timers.push(
      clock.at(clock.monotonicNow() + STARTUP_REVEAL_CEILING_MS, () =>
        this.finish(),
      ),
    );
    let handle: RevealHandle;
    try {
      handle = surface.reveal({ reducedMotion: this.options.reducedMotion() });
    } catch (error) {
      console.error("tilecast runtime: startup reveal failed", error);
      this.finish();
      return;
    }
    void handle.covered.then(
      () => {
        if (this.phaseValue === "revealing") this.enter("resolving");
      },
      () => this.finish(),
    );
    void handle.finished.then(
      () => this.finish(),
      (error: unknown) => {
        console.error("tilecast runtime: startup reveal failed", error);
        this.finish();
      },
    );
  }

  private finish(): void {
    if (this.phaseValue === "done") return;
    for (const timer of this.timers.splice(0)) timer.cancel();
    this.options.surface?.remove();
    this.enter("done");
  }

  private enter(phase: StartupPhase): void {
    this.phaseValue = phase;
    this.options.surface?.setPhase(phase);
    if (!this.covering) {
      for (const listener of this.uncoveredListeners.splice(0)) listener();
    }
    for (const listener of this.phaseListeners) listener(phase);
  }
}

/**
 * The sequence for this document. Conformance runs remove the layer before
 * the runtime reports ready, so every engine snapshots the same frames.
 */
export function startupFor(
  doc: Document,
  options: {
    clock: RuntimeClock;
    conformance: boolean;
    reducedMotion: () => boolean;
  },
): StartupSequence {
  const sequence = new StartupSequence({
    clock: options.clock,
    surface: StartupView.find(doc),
    reducedMotion: options.reducedMotion,
  });
  if (options.conformance) sequence.skip();
  return sequence;
}
