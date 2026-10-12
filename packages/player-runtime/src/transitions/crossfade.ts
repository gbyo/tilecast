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
 * The incoming layer always paints above the outgoing one. Layers are
 * opaque (each has a black backdrop), so a dissolve needs the outgoing layer
 * to stay at full opacity underneath while the incoming one fades in over it.
 * Fading both at once exposes the black backdrops and dips the picture dark
 * for the middle of every transition.
 */
function stack(incoming: HTMLElement, outgoing: HTMLElement | null): void {
  incoming.style.zIndex = "1";
  if (outgoing) outgoing.style.zIndex = "0";
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
  stack(incoming, outgoing);
  if (duration <= 0 || typeof incoming.animate !== "function") {
    settle(incoming, outgoing);
    return { finished: Promise.resolve("finished"), cancel() {} };
  }

  const options: KeyframeAnimationOptions = {
    duration,
    easing: "ease",
    fill: "both",
  };
  // The resting state is expressed by the `visible` class; the animation only
  // carries the incoming layer to it and is removed afterwards. The outgoing
  // layer keeps its `visible` class, and so full opacity, until the end.
  const fadeIn = incoming.animate([{ opacity: 0 }, { opacity: 1 }], options);
  incoming.classList.add(VISIBLE);

  let outcome: TransitionOutcome | null = null;
  let resolve!: (value: TransitionOutcome) => void;
  const finished = new Promise<TransitionOutcome>((r) => (resolve = r));
  const end = (value: TransitionOutcome) => {
    if (outcome) return;
    outcome = value;
    settle(incoming, outgoing);
    fadeIn.cancel();
    resolve(value);
  };
  fadeIn.finished.then(
    () => end("finished"),
    () => end("cancelled"),
  );
  return { finished, cancel: () => end("cancelled") };
}
