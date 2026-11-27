/*
 * Shared by every compositor-lab scene. Plain browser APIs only: no Tilecast
 * code, so a scene that reproduces a defect can become a WebKit LayoutTest.
 *
 * A scene declares the colors it paints (palette) and tells the host what it
 * is about to do (markers). The host checks every presented frame against
 * the latest marker (lab/lab-detector.h):
 *   arm               a transition starts soon; stop checking the settled color
 *   transition-start  {path: "a:b" or "a:m:b", rules: "reversal:foreign:uniform",
 *                      optional probe px, py, pw, ph as fractions}
 *   settled           {color}: from two frames on, every point is that color
 *   iteration-end     {iteration}
 * Opened in an ordinary browser (no host), markers go to the console.
 */
"use strict";
const Lab = (() => {
  const params = new URLSearchParams(location.search);
  const parsed = Number.parseInt(params.get("iterations") ?? "", 10);
  const iterations =
    Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 10000) : 20;
  const variants = new Set(
    (params.get("variant") ?? "").split(":").filter(Boolean),
  );
  const handler = globalThis.webkit?.messageHandlers?.tclab;
  const post = (message) =>
    handler
      ? handler.postMessage(message)
      : console.log(JSON.stringify(message));
  let iteration = 0;
  const marker = (ev, fields = {}) =>
    post({
      type: "marker",
      record: { t: performance.now(), scope: "lab", ev, iteration, ...fields },
    });
  const palette = (colors, probe = { x: 0, y: 0, w: 1, h: 1 }) =>
    post({ type: "palette", colors, probe });
  const rgb = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const frames = async (n) => {
    for (let i = 0; i < n; i++) await frame();
  };
  /* Blocks the main thread: the compositor keeps presenting without it. */
  const busy = (ms) => {
    const end = performance.now() + ms;
    while (performance.now() < end) {}
  };
  /* Busy around `animation`'s end if the variant asks for it. The stall is
   * scheduled from the animation's own clock once it has started (its start
   * can trail animate() by frames), so it begins 20 ms before the effect ends
   * and runs past it. `duration` is the fallback when the effect has no end
   * time. Nothing runs if the animation ends or is cancelled first. */
  const stallAtEnd = (animation, duration, ms = 120) => {
    if (!variants.has("busy-end")) return;
    let ended = false;
    let timer = null;
    const end = () => {
      ended = true;
      if (timer !== null) clearTimeout(timer);
    };
    animation.finished.then(end, end);
    animation.ready.then(
      () => {
        if (ended) return;
        const computed = animation.effect?.getComputedTiming?.().endTime;
        const effectEnd = typeof computed === "number" ? computed : duration;
        const current =
          typeof animation.currentTime === "number" ? animation.currentTime : 0;
        timer = setTimeout(
          () => {
            timer = null;
            if (!ended) busy(ms);
          },
          Math.max(0, effectEnd - current - 20),
        );
      },
      () => undefined,
    );
  };
  const run = async (body) => {
    // Let the first frames settle before measuring anything.
    await sleep(500);
    try {
      for (iteration = 0; iteration < iterations; iteration++) {
        await body(iteration);
        marker("iteration-end");
      }
      post({ type: "done", iterations });
    } catch (error) {
      console.error(error);
      post({ type: "error", code: "scene_exception" });
    }
  };
  return {
    iterations,
    variants,
    has: (name) => variants.has(name),
    marker,
    palette,
    rgb,
    sleep,
    frame,
    frames,
    busy,
    stallAtEnd,
    run,
  };
})();
