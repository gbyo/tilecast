/**
 * MIGRATION ONLY. The Emergency Alerts ticker as a runtime plugin, kept in
 * this package until milestone 5 moves it to plugins/emergency-alerts. The
 * host treats it exactly like a discovered plugin: an emergency-tier claim
 * on the bottom strip while a live alert has not expired.
 */
import {
  defineRuntimePlugin,
  element,
  type SurfaceClaim,
} from "@tilecast/plugin-sdk/runtime";
import {
  tilecastAlertTicker,
  type TilecastActiveAlertTicker,
} from "./resolver";

const words = (...nodes: (Element | null)[]) =>
  nodes
    .map((node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");

export default defineRuntimePlugin({
  id: "emergency_alerts",
  tier: "emergency",
  manifestTypes: ["alert_ticker"],
  surfaces: ["strip.bottom"],
  create(context) {
    let root: HTMLElement | null = null;
    let severity: HTMLElement | null = null;
    let viewport: HTMLElement | null = null;
    let track: HTMLElement | null = null;
    let message: HTMLElement | null = null;
    let ticker: TilecastActiveAlertTicker | null = null;
    let key = "";
    let animation: Animation | null = null;

    const stopScroll = () => {
      animation?.cancel();
      animation = null;
    };

    const syncScroll = (active: TilecastActiveAlertTicker | null) => {
      if (!active) {
        key = "";
        stopScroll();
        return;
      }
      // Rewriting the scroll on each tick would restart it from the right
      // edge once a second and the message would never be read.
      const next = `${active.id}${active.message}${active.severity}${active.pixelsPerSecond}${active.heightPx}`;
      if (next === key) return;
      key = next;
      stopScroll();
      if (!viewport || !track || !message) return;
      // The message travels its own width plus the bar's, so a long alert
      // scrolls for longer instead of scrolling faster.
      const distance = viewport.clientWidth + message.scrollWidth;
      if (context.animationScale === 0) {
        // Motion frozen for deterministic frames: the message's start sits at
        // a fixed point of the bar, independent of the engine's text metrics.
        track.style.setProperty(
          "transform",
          `translateX(${-viewport.clientWidth * 0.95}px)`,
        );
        return;
      }
      // A reader who cannot follow motion still has to receive the alert:
      // the message stops moving and is clipped instead (see the stylesheet).
      if (context.reducedMotion()) return;
      if (typeof track.animate !== "function") return;
      track.style.removeProperty("transform");
      const seconds = Math.max(6, distance / active.pixelsPerSecond);
      animation = track.animate(
        [
          { transform: "translateX(0)" },
          { transform: `translateX(${-distance}px)` },
        ],
        { duration: seconds * 1_000, iterations: Infinity, easing: "linear" },
      );
    };

    return {
      mount(_slot, container) {
        root = element("div", "tc-emergency-alerts");
        root.setAttribute("role", "alert");
        root.setAttribute("aria-live", "assertive");
        severity = element("span", "tc-emergency-alerts__severity");
        severity.hidden = true;
        viewport = element("span", "tc-emergency-alerts__viewport");
        track = element("span", "tc-emergency-alerts__track");
        message = element("span", "tc-emergency-alerts__message");
        track.appendChild(message);
        viewport.appendChild(track);
        root.append(severity, viewport);
        container.appendChild(root);
      },

      update(entries) {
        ticker = tilecastAlertTicker.resolve(
          entries,
          new Date(context.clock.now()),
        );
        const claims: SurfaceClaim[] = [];
        if (ticker) {
          claims.push({
            slot: "strip.bottom",
            priority: ticker.priority,
            heightPx: ticker.heightPx,
            displayMode: ticker.displayMode,
          });
        }
        return claims;
      },

      render(grant) {
        const active = grant.shown.has("strip.bottom") ? ticker : null;
        if (!root || !severity || !message) return;
        root.classList.toggle("tc-emergency-alerts--visible", !!active);
        severity.hidden = !active?.severity;
        severity.textContent = active?.severity ?? "";
        message.textContent = active?.message ?? "";
        syncScroll(active);
      },

      describe() {
        return words(severity?.hidden ? null : severity, message);
      },

      dispose() {
        stopScroll();
      },
    };
  },
});
