/**
 * Countdown Bar in the shared Player runtime: a bottom bar that counts down
 * to a weekly or one-time target, with urgency stages, a draining fill,
 * completion text, and a confetti burst in the overlay slot.
 *
 * It is a Plugin API v2 Player plugin with two visual contributions on the
 * scheduled tier: the bar and the confetti. The host decides whether the bar
 * holds the bottom strip and whether it pushes content; the bar only draws
 * itself. Time comes from the clock service: a one-second tick while the
 * plugin has state, and one timer for the end of a confetti burst.
 *
 * Players that host Plugin API v2 send `plugin_state`; other Players send
 * the v1 `countdown_bar` entry. Both arrive here as the same state.
 */
import { definePlayerPlugin } from "@tilecast/plugin-sdk/player";
import {
  element,
  setStyles,
  type RuntimeManifestEntry,
  type SurfaceClaim,
  type SurfaceGrant,
  type TimerHandle,
} from "@tilecast/plugin-sdk/runtime";
import { CONFETTI_MS, confettiPieces } from "./confetti";
import {
  tilecastCountdownBar,
  type TilecastActiveCountdownBar,
} from "./resolver";

/** The bar re-resolves the schedule this often while it has state. */
export const TICK_MS = 1_000;

const words = (...nodes: (Element | null)[]) =>
  nodes
    .map((node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");

export default definePlayerPlugin({
  id: "countdown_bar",
  services: {
    required: ["player.clock@1", "player.surface@1"],
    optional: [],
  },
  activate(context) {
    const clock = context.services["player.clock@1"];
    const surface = context.services["player.surface@1"];

    let entries: RuntimeManifestEntry[] = [];
    let selected: TilecastActiveCountdownBar | null = null;
    let barShown = false;
    let lastConfettiKey = "";
    let confettiKey: string | null = null;
    let confettiTimer: TimerHandle | null = null;
    let drawnConfettiKey: string | null = null;

    const bar = element("div", "tc-countdown-bar");
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");
    bar.dataset["urgency"] = "normal";
    const fill = element("span", "tc-countdown-bar__fill");
    fill.setAttribute("aria-hidden", "true");
    const urgency = element("span", "tc-countdown-bar__urgency");
    const message = element("span", "tc-countdown-bar__message");
    const value = element("span", "tc-countdown-bar__value");
    bar.append(fill, urgency, message, value);
    const confetti = element("div", "tc-countdown-bar__confetti");
    confetti.setAttribute("aria-hidden", "true");

    const drawBar = (grant: SurfaceGrant) => {
      barShown = grant.shown.has("strip.bottom");
      const countdown = barShown ? selected : null;
      bar.classList.toggle("tc-countdown-bar--visible", barShown);
      bar.classList.toggle("tc-countdown-bar--pulse", !!countdown?.pulse);
      bar.dataset["urgency"] = countdown?.urgencyStage ?? "normal";
      setStyles(fill, {
        width:
          countdown && countdown.remainingFraction !== null
            ? `${countdown.remainingFraction * 100}%`
            : "0",
      });
      urgency.textContent = countdown?.urgencyLabel ?? "";
      message.textContent = countdown?.message ?? "";
      value.textContent = countdown?.value ?? "";
      if (countdown) {
        // Padding and type size are resolved centrally so every player
        // agrees on what a contentPadding and textScale mean.
        setStyles(bar, {
          "--tc-countdown-bar-padding": `${countdown.contentPadding}%`,
          "--tc-countdown-bar-font-size": `${countdown.fontSizePx}px`,
        });
      }
    };

    const drawConfetti = (grant: SurfaceGrant) => {
      const key = grant.shown.has("overlay") ? confettiKey : null;
      if (key === drawnConfettiKey) return;
      drawnConfettiKey = key;
      confetti.replaceChildren();
      if (!key) return;
      for (const piece of confettiPieces(key)) {
        const node = element("span", "tc-countdown-bar__confetti-piece");
        setStyles(node, {
          "--tc-countdown-bar-confetti-x": piece.x,
          "--tc-countdown-bar-confetti-drift": piece.drift,
          "--tc-countdown-bar-confetti-spin": piece.spin,
          "--tc-countdown-bar-confetti-delay": piece.delay,
          "--tc-countdown-bar-confetti-duration": piece.duration,
          "--tc-countdown-bar-confetti-color": piece.color,
          "--tc-countdown-bar-confetti-width": piece.width,
          "--tc-countdown-bar-confetti-height": piece.height,
          "--tc-countdown-bar-confetti-radius": piece.radius,
        });
        confetti.appendChild(node);
      }
    };

    const barSurface = surface.open("bar", drawBar, (slot) =>
      slot === "strip.bottom" && barShown ? words(urgency, message, value) : "",
    );
    const confettiSurface = surface.open("confetti", drawConfetti);
    barSurface?.container("strip.bottom").appendChild(bar);
    confettiSurface?.container("overlay").appendChild(confetti);

    /** A completed instance stops holding the strip but still owes its burst. */
    const triggerConfetti = (active: TilecastActiveCountdownBar | null) => {
      if (!active?.showConfetti) return;
      const key = `${active.id}:${active.targetAt}`;
      if (key === lastConfettiKey) return;
      lastConfettiKey = key;
      confettiTimer?.cancel();
      confettiKey = surface.reducedMotion() ? null : key;
      confettiTimer = clock.after(CONFETTI_MS, () => {
        if (lastConfettiKey === key) {
          confettiKey = null;
          evaluate();
        }
      });
    };

    /** Resolve the schedule now and claim what it needs. */
    const evaluate = () => {
      selected = tilecastCountdownBar.resolve(entries, new Date(clock.now()));
      triggerConfetti(selected);
      const claims: SurfaceClaim[] = [];
      if (selected?.showBar) {
        claims.push({
          slot: "strip.bottom",
          priority: selected.priority,
          heightPx: selected.heightPx,
          displayMode: selected.displayMode,
        });
      }
      barSurface?.claim(claims);
      confettiSurface?.claim(
        confettiKey ? [{ slot: "overlay", priority: 0 }] : [],
      );
    };

    clock.every(TICK_MS, evaluate);

    return {
      stateChanged(next) {
        entries = next.map((entry) => ({
          id: entry.id,
          type: entry.type,
          version: entry.version,
          config: entry.state,
        }));
        evaluate();
      },
      describe: () => words(urgency, message, value),
      dispose() {
        confetti.replaceChildren();
      },
    };
  },
});
