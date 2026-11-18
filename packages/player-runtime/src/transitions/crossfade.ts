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
 * Fade `element` in from transparent over whatever is beneath it.
 *
 * The element is pinned at opacity 0 by an inline style before the animation
 * is created, and the pin comes off only in the same task as the animation
 * ends. An engine that composites the animation asynchronously (WebKit does)
 * can show the element at its underlying style for a frame before the
 * animation applies. Without the pin that style is the opaque resting state:
 * the incoming item's black backdrop flashes over the outgoing one, which
 * then reappears under the dissolve.
 */
export function fadeIn(
  element: HTMLElement,
  duration: number,
): RunningTransition {
  element.style.opacity = "0";
  const animation = element.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration,
    easing: "ease",
    fill: "both",
  });

  let outcome: TransitionOutcome | null = null;
  let resolve!: (value: TransitionOutcome) => void;
  const finished = new Promise<TransitionOutcome>((r) => (resolve = r));
  const end = (value: TransitionOutcome) => {
    if (outcome) return;
    outcome = value;
    element.style.removeProperty("opacity");
    animation.cancel();
    resolve(value);
  };
  animation.finished.then(
    () => end("finished"),
    () => end("cancelled"),
  );
  return { finished, cancel: () => end("cancelled") };
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

  // The resting state is expressed by the `visible` class; the fade only
  // carries the incoming layer to it. The outgoing layer keeps its `visible`
  // class, and so full opacity, until the end.
  const fade = fadeIn(incoming, duration);
  incoming.classList.add(VISIBLE);

  let outcome: TransitionOutcome | null = null;
  let resolve!: (value: TransitionOutcome) => void;
  const finished = new Promise<TransitionOutcome>((r) => (resolve = r));
  const end = (value: TransitionOutcome) => {
    if (outcome) return;
    outcome = value;
    settle(incoming, outgoing);
    fade.cancel();
    resolve(value);
  };
  void fade.finished.then(end);
  return { finished, cancel: () => end("cancelled") };
}
