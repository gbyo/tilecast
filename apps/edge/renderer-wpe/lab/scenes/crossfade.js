/*
 * The Player Runtime's stage crossfade, reduced to DOM primitives
 * (packages/player-runtime/src/transitions/crossfade.ts and
 * surfaces/stage.ts):
 *
 *   two absolute full-screen layers with black backdrops, opacity 0 unless
 *   they have the `visible` class; the incoming layer is filled while hidden,
 *   stacked above the outgoing one (z-index 1 over 0), pinned at an inline
 *   opacity of 0, faded 0 -> 1 with element.animate (300 ms, ease,
 *   fill: both) and given `visible` in the same task. When `finished`
 *   resolves, in one task: the pin is removed, the animation cancelled, the
 *   outgoing layer loses `visible`, and its content is released.
 *
 * `crossfade.html` runs exactly that. `crossfade-cleanup-variants.html` runs
 * it with the completion steps changed one at a time (variants below); they
 * are experiments, not product behavior.
 *
 *   retain-animation  do not cancel the finished animation
 *   keep-pin          do not remove the inline opacity (implies retain-animation)
 *   no-pin            never pin the incoming layer at opacity 0
 *   commit-final      set inline opacity 1 before cancelling, remove it a frame later
 *   outgoing-1f       release the outgoing layer one animation frame later
 *   outgoing-2f       ... two animation frames later
 *   keep-outgoing     remove `visible` from the outgoing layer but keep its content
 *   image             layer content is a decoded <img>, not a colored <div>
 *   busy-end          block the main thread for 120 ms around the end
 */
"use strict";
const COLORS = { a: [200, 40, 30], b: [30, 90, 200], black: [0, 0, 0] };
const DURATION = 300;

function crossfadeScene({ variants }) {
  const has = (name) => variants && Lab.has(name);
  const layers = [
    document.getElementById("layer-a"),
    document.getElementById("layer-b"),
  ];
  Lab.palette(COLORS);

  const images = {};
  async function imageOf(name) {
    if (images[name]) return images[name].cloneNode();
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    context.fillStyle = Lab.rgb(COLORS[name]);
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    const image = new Image();
    image.src = URL.createObjectURL(blob);
    await image.decode();
    images[name] = image;
    return image.cloneNode();
  }

  async function fill(layer, name) {
    let content;
    if (has("image")) {
      content = await imageOf(name);
      await content.decode();
    } else {
      content = document.createElement("div");
      content.className = "content";
      content.style.background = Lab.rgb(COLORS[name]);
    }
    layer.replaceChildren(content);
  }

  let front = 0;
  async function swap(toName, fromName) {
    const incoming = layers[1 - front];
    const outgoing = layers[front];
    await fill(incoming, toName);
    await Lab.sleep(50);
    Lab.marker("arm");
    await Lab.sleep(100);

    incoming.style.zIndex = "1";
    outgoing.style.zIndex = "0";
    if (!has("no-pin")) incoming.style.opacity = "0";
    Lab.marker("transition-start", {
      path: `${fromName}:${toName}`,
      rules: "reversal:foreign:uniform",
    });
    const animation = incoming.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: DURATION,
      easing: "ease",
      fill: "both",
    });
    incoming.classList.add("visible");
    Lab.stallAtEnd(animation, DURATION);
    await animation.finished;
    Lab.marker("transition-end");

    const keepPin = has("keep-pin");
    const retain = keepPin || has("retain-animation");
    if (has("commit-final")) incoming.style.opacity = "1";
    else if (!keepPin) incoming.style.removeProperty("opacity");
    if (!retain) animation.cancel();
    incoming.classList.add("visible");
    if (has("outgoing-1f")) await Lab.frames(1);
    if (has("outgoing-2f")) await Lab.frames(2);
    outgoing.classList.remove("visible");
    if (!has("keep-outgoing")) outgoing.replaceChildren();
    Lab.marker("settled", { color: toName });
    if (has("commit-final")) {
      await Lab.frame();
      incoming.style.removeProperty("opacity");
    }
    front = 1 - front;
    await Lab.sleep(500);
    if (retain) {
      // The next swap reuses this layer; leave nothing running on it.
      animation.cancel();
      if (keepPin) incoming.style.removeProperty("opacity");
    }
  }

  Lab.run(async (iteration) => {
    if (iteration === 0) {
      await fill(layers[0], "a");
      layers[0].classList.add("visible");
      Lab.marker("settled", { color: "a" });
      await Lab.sleep(300);
    }
    await swap("b", "a");
    await swap("a", "b");
  });
}
