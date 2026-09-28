/**
 * Playback transitions, owned by the Web Animations API.
 *
 * A transition has one clock (the animation's own) and one completion signal
 * (`finished`), so cleanup no longer depends on a CSS duration being mirrored
 * by a JavaScript timer. A transition interrupted by a takeover or a newer
 * swap is cancelled, which jumps both layers to their resting state at once.
 */

export const CROSSFADE_MS = 300;

export type TransitionOutcome = "finished" | "cancelled";

export interface RunningTransition {
  readonly finished: Promise<TransitionOutcome>;
  /** Jump to the end state now. Idempotent. */
  cancel(): void;
}

export interface TransitionTiming {
  /** Scale for every transition duration; 0 makes them instant (snapshots). */
  durationScale: number;
}

const VISIBLE = "visible";

function settle(incoming: HTMLElement, outgoing: HTMLElement | null): void {
  incoming.classList.add(VISIBLE);
  outgoing?.classList.remove(VISIBLE);
}

/**
 * Swap `incoming` in over `outgoing`. `kind` is the item's transition:
 * "fade" and "crossfade" dissolve for 300 ms; anything else cuts.
 */
export function swapLayers(
  incoming: HTMLElement,
  outgoing: HTMLElement | null,
  kind: string,
  timing: TransitionTiming,
): RunningTransition {
  const duration =
    kind === "none" ? 0 : Math.round(CROSSFADE_MS * timing.durationScale);
  if (duration <= 0 || typeof incoming.animate !== "function") {
    settle(incoming, outgoing);
    return { finished: Promise.resolve("finished"), cancel() {} };
  }

  const options: KeyframeAnimationOptions = {
    duration,
    easing: "ease",
    fill: "both",
  };
  // The resting state is expressed by the `visible` class; the animations
  // only carry the layers between resting states and are removed afterwards.
  const fadeIn = incoming.animate([{ opacity: 0 }, { opacity: 1 }], options);
  const fadeOut = outgoing?.animate([{ opacity: 1 }, { opacity: 0 }], options);
  settle(incoming, outgoing);

  let outcome: TransitionOutcome | null = null;
  let resolve!: (value: TransitionOutcome) => void;
  const finished = new Promise<TransitionOutcome>((r) => (resolve = r));
  const end = (value: TransitionOutcome) => {
    if (outcome) return;
    outcome = value;
    fadeIn.cancel();
    fadeOut?.cancel();
    resolve(value);
  };
  Promise.all([fadeIn.finished, fadeOut?.finished]).then(
    () => end("finished"),
    () => end("cancelled"),
  );
  return { finished, cancel: () => end("cancelled") };
}
