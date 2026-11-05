/**
 * The wake animation: the startup layer played again when the screen leaves
 * its outside-hours state and active hours begin.
 *
 * The startup layer in index.html is removed once it has played, so the
 * runtime keeps an unused copy of its markup from before that (`capture`) and
 * mounts a fresh one here. From there it is the same sequence as startup:
 * the pulse runs, the first presentation prepares beneath, and the card
 * pushes through to it. When the screen was showing the bouncing logo, the
 * layer begins where that logo is and glides to the centre first, and the
 * pulse's minimum time starts when it arrives.
 *
 * A wake is a visual gate only, like startup: the engine and the host see
 * nothing different. Without a copy of the layer (conformance runs, a
 * document without startup markup) there is nothing to play, and the
 * presentation simply replaces the outside-hours screen.
 */
import type { RuntimeClock } from "../clock/scheduler";
import { StartupSequence, type StartupSignals } from "./sequence";
import { StartupView, type GlideOrigin } from "./view";

export interface WakeOptions {
  clock: RuntimeClock;
  /** A copy of the startup layer (`captureStartupLayer`), or null. */
  template: HTMLElement | null;
  reducedMotion: () => boolean;
  /**
   * True while the document's first startup still covers the screen; a wake
   * then adds nothing to it.
   */
  startupCovering: () => boolean;
  /** The layer starts and stops hiding the presentation. */
  covering?: (covering: boolean) => void;
  document?: Document;
}

/** A copy of the startup layer as the document first has it, or null. */
export function captureStartupLayer(doc: Document): HTMLElement | null {
  const root = doc.getElementById("tc-startup");
  if (!root || !root.querySelector(".tc-startup__card")) return null;
  return root.cloneNode(true) as HTMLElement;
}

export class WakeAnimation {
  private active: StartupSequence | null = null;

  constructor(private readonly options: WakeOptions) {}

  /**
   * Start a wake over the screen that just ended. Returns the signals the
   * views send, or null when no animation plays.
   */
  begin(origin: GlideOrigin | null): StartupSignals | null {
    const { template, clock } = this.options;
    if (!template || this.active || this.options.startupCovering()) return null;
    const doc = this.options.document ?? document;
    const root = template.cloneNode(true) as HTMLElement;
    doc.body.appendChild(root);
    const view = new StartupView(root);
    const glide =
      origin && !this.options.reducedMotion() ? view.glideFrom(origin) : 0;
    const sequence = new StartupSequence({
      clock,
      surface: view,
      reducedMotion: this.options.reducedMotion,
      introStartedAt: clock.monotonicNow() + glide,
    });
    this.active = sequence;
    this.options.covering?.(true);
    sequence.onUncovered(() => {
      if (this.active === sequence) this.active = null;
      this.options.covering?.(false);
    });
    return sequence;
  }

  /** The screen went back to outside hours: drop a wake still playing. */
  abort(): void {
    this.active?.skip();
  }
}
