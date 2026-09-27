/**
 * MotionController: bounded motion that clarifies a change.
 *
 * Motion runs on the Web Animations API, so the compositor animates it and
 * Lit never rerenders per frame. Every animation has a fixed, short
 * duration; there are no infinite animations. Reduced motion (from the
 * Widget context, which a conformance run also sets) skips animation and
 * shows the final state immediately. Running animations are cancelled when
 * the host disconnects.
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { WidgetContext } from "@tilecast/widget-sdk";

export const MOTION_DURATIONS = {
  quick: 160,
  standard: 320,
  slow: 640,
} as const;

export const MOTION_EASING = "cubic-bezier(0.2, 0, 0, 1)";

type MotionHost = ReactiveControllerHost &
  HTMLElement & { context?: WidgetContext };

export class MotionController implements ReactiveController {
  private readonly running = new Set<Animation>();

  constructor(private readonly host: MotionHost) {
    host.addController(this);
  }

  get reduced(): boolean {
    return this.host.context?.motion.reduced ?? true;
  }

  hostConnected(): void {}

  hostDisconnected(): void {
    for (const animation of this.running) animation.cancel();
    this.running.clear();
  }

  /** Animate once with a bounded duration, or do nothing when reduced. */
  animate(
    element: Element,
    keyframes: Keyframe[],
    duration: keyof typeof MOTION_DURATIONS = "standard",
  ): Animation | null {
    if (this.reduced || typeof element.animate !== "function") return null;
    const animation = element.animate(keyframes, {
      duration: MOTION_DURATIONS[duration],
      easing: MOTION_EASING,
      iterations: 1,
    });
    this.running.add(animation);
    const forget = () => this.running.delete(animation);
    animation.addEventListener("finish", forget);
    animation.addEventListener("cancel", forget);
    return animation;
  }

  /** New content arriving: a short fade and rise. */
  enter(element: Element): Animation | null {
    return this.animate(element, [
      { opacity: 0, transform: "translateY(0.6em)" },
      { opacity: 1, transform: "none" },
    ]);
  }

  /** A value changed in place: a brief emphasis without movement. */
  emphasize(element: Element): Animation | null {
    return this.animate(element, [{ opacity: 0.35 }, { opacity: 1 }], "quick");
  }

  get active(): number {
    return this.running.size;
  }
}
