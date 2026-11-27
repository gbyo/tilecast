/**
 * The startup layer in the document (`#tc-startup` in index.html) and the
 * reveal choreography. Timing decisions belong to the sequence
 * (sequence.ts); this file only moves pixels.
 *
 * The reveal, after the sequence allows it:
 *   1. the pulse settles: the front tile comes to full brightness at its
 *      rest position, and the wordmark and rear tiles fade and recede;
 *   2. the front tile, now a card, lifts, tilts and is pushed toward the
 *      camera until it covers the screen (motion.ts);
 *   3. the layer becomes a plain white sheet in the same frame, then fades
 *      away over the presentation, and is removed from the document.
 *
 * Everything runs on the Web Animations API with transform and opacity only,
 * so the compositor keeps it smooth while the presentation starts beneath.
 */
import {
  planCardMotion,
  tilePolygon,
  transformOf,
  type CardPlan,
} from "./motion";
import { visualTrace, type TraceTag } from "../diagnostics/visual-trace";

const STARTUP_TAG: TraceTag = { scope: "startup", fields: {} };

/** The pulse in runtime.css: one loop, and the front tile's peak in it. */
export const PULSE_CYCLE_MS = 1500;
const FRONT_DELAY_MS = 360;
const FRONT_PEAK_MS = 0.25 * PULSE_CYCLE_MS;
/** A front-tile peak this close is worth waiting for: the beat lands. */
export const PULSE_CATCH_MS = 450;

const SETTLE_MS = 220;
const RECEDE_MS = 420;
const PUSH_DELAY_MS = 60;
const PUSH_MS = 900;
const WHITE_HOLD_MS = 60;
const RESOLVE_MS = 380;
const REDUCED_MS = 320;
/** The glide from another logo's position to the centre, before the pulse. */
export const GLIDE_MS = 800;
const GLIDE_CROSSFADE_MS = 300;

/** The colour of the card, and of the sheet it becomes. */
export const CANVAS_COLOR = "#ffffff";

export interface RevealHandle {
  /** The screen is entirely the white sheet. */
  readonly covered: Promise<void>;
  /** The sheet has faded; the layer can go. */
  readonly finished: Promise<void>;
}

/** A logo already on screen that the startup logo takes over from. */
export interface GlideOrigin {
  /** Its box, in viewport pixels. */
  rect: { left: number; top: number; width: number; height: number };
  /** Image address of that logo, shown fading out while the pulse fades in. */
  src: string | null;
}

export interface RevealOptions {
  reducedMotion: boolean;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Milliseconds until the front tile next peaks, given time since the pulse began. */
export function untilFrontPeak(elapsedMs: number): number {
  const phase =
    (((elapsedMs - FRONT_DELAY_MS) % PULSE_CYCLE_MS) + PULSE_CYCLE_MS) %
    PULSE_CYCLE_MS;
  return (FRONT_PEAK_MS - phase + PULSE_CYCLE_MS) % PULSE_CYCLE_MS;
}

function animations(element: Element): Animation[] {
  return typeof element.getAnimations === "function"
    ? element.getAnimations()
    : [];
}

export class StartupView {
  private readonly logo: HTMLElement;
  private readonly mark: SVGSVGElement;
  private readonly card: HTMLElement;
  private readonly front: SVGPathElement;
  private readonly shade: SVGPathElement;

  constructor(readonly root: HTMLElement) {
    this.logo = root.querySelector<HTMLElement>(".tc-startup__logo")!;
    this.mark = root.querySelector<SVGSVGElement>(".tc-startup__mark")!;
    this.card = root.querySelector<HTMLElement>(".tc-startup__card")!;
    this.front = root.querySelector<SVGPathElement>(
      ".tc-startup__tile--front",
    )!;
    this.shade = root.querySelector<SVGPathElement>(".tc-startup__shade")!;
  }

  /** The layer from index.html, if this document still has it. */
  static find(doc: Document): StartupView | null {
    const root = doc.getElementById("tc-startup");
    if (!root || !root.querySelector(".tc-startup__card")) return null;
    return new StartupView(root);
  }

  /**
   * When the pulse began, on the document timeline (the same origin as
   * `performance.now()`), or null when the engine cannot say.
   */
  pulseStartedAt(): number | null {
    for (const animation of animations(this.front)) {
      const start = animation.startTime;
      if (typeof start === "number") return start;
    }
    return null;
  }

  /**
   * Resolves when the pulse is actually running on screen, with its start
   * time; null when the engine has no running pulse to report (reduced
   * motion, no Web Animations).
   */
  pulseStarted(): Promise<number | null> {
    const pulse = animations(this.front)[0];
    if (!pulse) return Promise.resolve(null);
    return pulse.ready.then(
      () => (typeof pulse.startTime === "number" ? pulse.startTime : null),
      () => null,
    );
  }

  /**
   * Begin where `origin` is and glide to the centre, where the pulse
   * plays. Returns the glide's length in milliseconds (0 when nothing moves).
   * The old logo fades out and the pulse fades in while it travels.
   */
  glideFrom(origin: GlideOrigin): number {
    if (
      typeof this.logo.animate !== "function" ||
      origin.rect.width <= 0 ||
      origin.rect.height <= 0
    ) {
      return 0;
    }
    const rest = this.logo.getBoundingClientRect();
    if (rest.width <= 0 || rest.height <= 0) return 0;
    const dx =
      origin.rect.left + origin.rect.width / 2 - (rest.left + rest.width / 2);
    const dy =
      origin.rect.top + origin.rect.height / 2 - (rest.top + rest.height / 2);
    const scale = origin.rect.width / rest.width;
    this.logo.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
        { transform: "translate(0px, 0px) scale(1)" },
      ],
      { duration: GLIDE_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    );
    const crossfade: KeyframeAnimationOptions = {
      duration: GLIDE_CROSSFADE_MS,
      easing: "ease-in-out",
      fill: "both",
    };
    this.mark.animate([{ opacity: 0 }, { opacity: 1 }], crossfade);
    if (origin.src) {
      const ghost = this.root.ownerDocument.createElement("img");
      ghost.src = origin.src;
      ghost.alt = "";
      ghost.setAttribute("aria-hidden", "true");
      ghost.className = "tc-startup__ghost";
      this.logo.appendChild(ghost);
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], crossfade);
    }
    return GLIDE_MS;
  }

  setPhase(phase: string): void {
    this.root.dataset["phase"] = phase;
  }

  remove(): void {
    const trace = visualTrace();
    if (trace.enabled) trace.record("startup", "startup.remove");
    for (const element of [this.root, ...this.root.querySelectorAll("*")]) {
      for (const animation of animations(element)) animation.cancel();
    }
    this.root.remove();
  }

  reveal(options: RevealOptions): RevealHandle {
    if (typeof this.root.animate !== "function") {
      // No Web Animations: nothing can move, so the layer just goes.
      return { covered: Promise.resolve(), finished: Promise.resolve() };
    }
    if (options.reducedMotion) {
      const fade = this.root.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: REDUCED_MS,
        easing: "ease-out",
        fill: "forwards",
      });
      const trace = visualTrace();
      if (trace.enabled) {
        trace.watchAnimation(STARTUP_TAG, "reduced-fade", fade, this.root);
      }
      const finished = fade.finished.then(() => undefined);
      return { covered: finished, finished };
    }

    let markCovered!: () => void;
    const covered = new Promise<void>((resolve) => (markCovered = resolve));
    const finished = this.choreograph(markCovered);
    return { covered, finished };
  }

  private async choreograph(markCovered: () => void): Promise<void> {
    const trace = visualTrace();
    // Ride a beat that is about to land on the front tile; otherwise settle
    // from wherever the pulse is now.
    const started = this.pulseStartedAt();
    if (started !== null) {
      const untilPeak = untilFrontPeak(performance.now() - started);
      if (trace.enabled) {
        trace.record("startup", "startup.pulse", {
          pulseStart: started,
          untilPeak,
          waits: untilPeak <= PULSE_CATCH_MS,
        });
      }
      if (untilPeak <= PULSE_CATCH_MS) await wait(untilPeak);
    } else if (trace.enabled) {
      trace.record("startup", "startup.pulse", { pulseStart: null });
    }
    const plan = this.plan();
    if (trace.enabled) trace.record("startup", "startup.settle");
    this.settle();
    if (trace.enabled) {
      trace.record("startup", "startup.push", {
        perspective: plan.perspective,
        samples: plan.samples.length,
        duration: PUSH_MS,
        delay: PUSH_DELAY_MS,
      });
    }
    await this.push(plan);
    if (trace.enabled) trace.record("startup", "startup.push-end");
    // The card covers every pixel: become the plain sheet in the same frame.
    this.root.style.background = CANVAS_COLOR;
    this.logo.style.visibility = "hidden";
    if (trace.enabled) trace.record("startup", "startup.covered");
    markCovered();
    await wait(WHITE_HOLD_MS);
    const resolve = this.root.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: RESOLVE_MS,
      easing: "cubic-bezier(0.25, 0.1, 0.25, 1)",
      fill: "forwards",
    });
    if (trace.enabled) {
      trace.record("startup", "startup.resolve", { duration: RESOLVE_MS });
      trace.watchAnimation(STARTUP_TAG, "resolve", resolve, this.root);
    }
    await resolve.finished.then(() => undefined);
    if (trace.enabled) trace.record("startup", "startup.resolve-end");
  }

  private plan(): CardPlan {
    const rect = this.card.getBoundingClientRect();
    const viewport = {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    };
    const card = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    return planCardMotion({ viewport, card, polygon: tilePolygon(card) });
  }

  /** Freeze each tile where the pulse left it, then ease to the reveal. */
  private settle(): void {
    for (const tile of this.root.querySelectorAll<SVGElement>(
      ".tc-startup__tile",
    )) {
      const computed = getComputedStyle(tile);
      const from = {
        opacity: computed.opacity,
        transform: computed.transform === "none" ? "none" : computed.transform,
      };
      for (const animation of animations(tile)) animation.cancel();
      tile.style.animation = "none";
      if (tile === this.front) {
        const settle = tile.animate(
          [from, { opacity: "1", transform: "translate(0px, 0px)" }],
          {
            duration: SETTLE_MS,
            easing: "cubic-bezier(0.2, 0.7, 0.3, 1)",
            fill: "forwards",
          },
        );
        const trace = visualTrace();
        if (trace.enabled) {
          trace.watchAnimation(STARTUP_TAG, "front-settle", settle, tile);
        }
      } else {
        tile.style.opacity = from.opacity;
        tile.style.transform = from.transform;
      }
    }
    const recede = this.mark.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.97)" },
      ],
      {
        duration: RECEDE_MS,
        easing: "cubic-bezier(0.3, 0, 0.2, 1)",
        fill: "forwards",
      },
    );
    const trace = visualTrace();
    if (trace.enabled) {
      trace.watchAnimation(STARTUP_TAG, "mark-recede", recede, this.mark);
    }
  }

  private push(plan: CardPlan): Promise<unknown> {
    this.logo.style.perspective = `${plan.perspective.toFixed(1)}px`;
    this.card.style.transformOrigin = `${plan.origin.x.toFixed(2)}px ${plan.origin.y.toFixed(2)}px`;
    this.card.style.willChange = "transform";
    const timing: KeyframeAnimationOptions = {
      duration: PUSH_MS,
      delay: PUSH_DELAY_MS,
      easing: "linear",
      fill: "forwards",
    };
    const card = this.card.animate(
      plan.samples.map((sample) => ({
        offset: sample.offset,
        transform: transformOf(sample),
      })),
      timing,
    );
    const shade = this.shade.animate(
      plan.samples.map((sample) => ({
        offset: sample.offset,
        opacity: sample.shade,
      })),
      timing,
    );
    const trace = visualTrace();
    if (trace.enabled) {
      trace.watchAnimation(STARTUP_TAG, "card-push", card, this.card);
      trace.watchAnimation(STARTUP_TAG, "shade", shade, this.shade);
    }
    return card.finished;
  }
}
