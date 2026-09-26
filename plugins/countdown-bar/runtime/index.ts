/**
 * Countdown Bar in the shared Player runtime: a bottom bar that counts down
 * to a weekly or one-time target, with urgency stages, a draining fill,
 * completion text, and a confetti burst in the overlay slot.
 *
 * The bar is a scheduled surface. The host decides whether it holds the
 * bottom strip and whether it pushes content; the bar only draws itself.
 */
import {
  defineRuntimePlugin,
  element,
  setStyles,
  type SurfaceClaim,
  type TimerHandle,
} from "@tilecast/plugin-sdk/runtime";
import { CONFETTI_MS, confettiPieces } from "./confetti";
import {
  tilecastCountdownBar,
  type TilecastActiveCountdownBar,
} from "./resolver";

const words = (...nodes: (Element | null)[]) =>
  nodes
    .map((node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");

export default defineRuntimePlugin({
  id: "countdown_bar",
  tier: "scheduled",
  manifestTypes: ["countdown_bar"],
  surfaces: ["strip.bottom", "overlay"],
  create(context) {
    let bar: HTMLElement | null = null;
    let fill: HTMLElement | null = null;
    let urgency: HTMLElement | null = null;
    let message: HTMLElement | null = null;
    let value: HTMLElement | null = null;
    let confetti: HTMLElement | null = null;

    let selected: TilecastActiveCountdownBar | null = null;
    let lastConfettiKey = "";
    let confettiKey: string | null = null;
    let confettiTimer: TimerHandle | null = null;
    let drawnConfettiKey: string | null = null;

    /** A completed instance stops holding the strip but still owes its burst. */
    const triggerConfetti = (active: TilecastActiveCountdownBar | null) => {
      if (!active?.showConfetti) return;
      const key = `${active.id}:${active.targetAt}`;
      if (key === lastConfettiKey) return;
      lastConfettiKey = key;
      confettiTimer?.cancel();
      confettiKey = context.reducedMotion() ? null : key;
      confettiTimer = context.clock.after(CONFETTI_MS, () => {
        if (lastConfettiKey === key) {
          confettiKey = null;
          context.invalidate();
        }
      });
    };

    const drawConfetti = (key: string | null) => {
      if (!confetti || key === drawnConfettiKey) return;
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

    return {
      mount(slot, container) {
        if (slot === "strip.bottom") {
          bar = element("div", "tc-countdown-bar");
          bar.setAttribute("role", "status");
          bar.setAttribute("aria-live", "polite");
          bar.dataset["urgency"] = "normal";
          fill = element("span", "tc-countdown-bar__fill");
          fill.setAttribute("aria-hidden", "true");
          urgency = element("span", "tc-countdown-bar__urgency");
          message = element("span", "tc-countdown-bar__message");
          value = element("span", "tc-countdown-bar__value");
          bar.append(fill, urgency, message, value);
          container.appendChild(bar);
        } else if (slot === "overlay") {
          confetti = element("div", "tc-countdown-bar__confetti");
          confetti.setAttribute("aria-hidden", "true");
          container.appendChild(confetti);
        }
      },

      update(entries) {
        selected = tilecastCountdownBar.resolve(
          entries,
          new Date(context.clock.now()),
        );
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
        if (confettiKey) claims.push({ slot: "overlay", priority: 0 });
        return claims;
      },

      render(grant) {
        const shown = grant.shown.has("strip.bottom");
        const countdown = shown ? selected : null;
        if (bar && fill && urgency && message && value) {
          bar.classList.toggle("tc-countdown-bar--visible", shown);
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
        }
        drawConfetti(grant.shown.has("overlay") ? confettiKey : null);
      },

      describe(slot) {
        return slot === "strip.bottom" ? words(urgency, message, value) : "";
      },

      dispose() {
        confetti?.replaceChildren();
      },
    };
  },
});
