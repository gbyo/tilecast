/**
 * COMPATIBILITY VIEW. Draws the built-in plugin surfaces from the overlay
 * model. Elements are long-lived and keyed, so a watermark logo is never
 * re-decoded and a scrolling alert never restarts on the one-second tick.
 */
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { repeat } from "lit/directives/repeat.js";
import { cssProps } from "./css-props";
import {
  confettiPieces,
  type OverlayModel,
} from "../compat/plugins/overlay-controller";
import type { TilecastActiveBrandBug } from "../compat/plugins/brand-bug-resolver";
import {
  browserClock,
  type RuntimeClock,
  type TimerHandle,
} from "../clock/scheduler";

const CORNERS: TilecastActiveBrandBug["corner"][] = [
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
];

export class PluginSurfaces extends LitElement {
  static override properties = {
    model: { attribute: false },
    animationScale: { attribute: false },
    clock: { attribute: false },
  };

  declare model: OverlayModel | null;
  /** 0 freezes motion at a deterministic frame (snapshot conformance runs). */
  declare animationScale: number;
  declare clock: RuntimeClock;

  private tickerKey = "";
  private tickerAnimation: Animation | null = null;
  private meterSignature = "";
  private meterEntering = false;
  private meterEnterTimer: TimerHandle | null = null;
  /** A hidden mark keeps its last content, so its logo is never re-decoded. */
  private readonly lastMarks = new Map<
    TilecastActiveBrandBug["corner"],
    TilecastActiveBrandBug
  >();

  constructor() {
    super();
    this.model = null;
    this.animationScale = 1;
    this.clock = browserClock();
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /** Move the noise marker without a render: this runs ~16 times a second. */
  setNoiseLevel(level: number): void {
    const marker = this.querySelector<HTMLElement>(".noise-meter__marker");
    if (marker && this.model?.strip === "noise_meter") {
      marker.style.left = `${level}%`;
    }
  }

  override render() {
    const m = this.model;
    const countdown = m?.countdown ?? null;
    const ticker = m?.ticker ?? null;
    const meter = m?.noiseMeter ?? null;
    const marks = new Map((m?.marks ?? []).map((mark) => [mark.corner, mark]));
    return html`
      <div
        id="countdown-bar"
        role="status"
        aria-live="polite"
        data-urgency=${countdown?.urgencyStage ?? "normal"}
        class=${classMap({
          visible: m?.strip === "countdown_bar",
          "countdown-pulse": m?.strip === "countdown_bar" && !!countdown?.pulse,
        })}
      >
        <span
          class="countdown-fill"
          aria-hidden="true"
          style=${cssProps({
            width:
              countdown && countdown.remainingFraction !== null
                ? `${countdown.remainingFraction * 100}%`
                : "0",
          })}
        ></span>
        <span class="countdown-urgency">${countdown?.urgencyLabel ?? ""}</span>
        <span class="countdown-message">${countdown?.message ?? ""}</span>
        <span class="countdown-value">${countdown?.value ?? ""}</span>
      </div>
      <div id="countdown-confetti" aria-hidden="true">
        ${
          m?.confettiKey
            ? repeat(
                confettiPieces(m.confettiKey),
                (_piece, index) => `${m.confettiKey}:${index}`,
                (piece) =>
                  html`<span
                    class="countdown-confetti__piece"
                    style=${cssProps({
                      "--confetti-x": piece.x,
                      "--confetti-drift": piece.drift,
                      "--confetti-spin": piece.spin,
                      "--confetti-delay": piece.delay,
                      "--confetti-duration": piece.duration,
                      "--confetti-color": piece.color,
                      "--confetti-width": piece.width,
                      "--confetti-height": piece.height,
                      "--confetti-radius": piece.radius,
                    })}
                  ></span>`,
              )
            : nothing
        }
      </div>
      <div
        id="alert-ticker"
        role="alert"
        aria-live="assertive"
        class=${classMap({ visible: m?.strip === "alert_ticker" })}
      >
        <span class="ticker-severity" ?hidden=${!ticker?.severity}
          >${ticker?.severity ?? ""}</span
        >
        <span class="ticker-viewport">
          <span class="ticker-track"
            ><span class="ticker-message">${ticker?.message ?? ""}</span></span
          >
        </span>
      </div>
      <div
        id="noise-meter"
        role="status"
        class=${classMap({
          visible: m?.strip === "noise_meter",
          "noise-meter--entering": this.meterEntering,
        })}
        style=${cssProps(
          meter
            ? {
                "--noise-warning": `${meter.warningLevel}%`,
                "--noise-loud": `${meter.loudLevel}%`,
              }
            : {},
        )}
      >
        <span class="noise-meter__label">Noise level</span>
        <span class="noise-meter__scale" aria-hidden="true">
          <span class="noise-meter__zone noise-meter__zone--normal"></span>
          <span class="noise-meter__zone noise-meter__zone--warning"></span>
          <span class="noise-meter__zone noise-meter__zone--loud"></span>
          <span class="noise-meter__marker"></span>
        </span>
        <span class="noise-meter__warning"
          >${meter ? meter.message || "TOO LOUD" : "Too loud"}</span
        >
      </div>
      <div id="brand-bugs" aria-hidden="true">
        ${repeat(
          CORNERS,
          (corner) => corner,
          (corner) => {
            const shown = marks.get(corner);
            if (shown) this.lastMarks.set(corner, shown);
            return this.renderMark(
              corner,
              shown ?? this.lastMarks.get(corner),
              !!shown,
              m?.markLiftPx ?? 0,
            );
          },
        )}
      </div>
    `;
  }

  private renderMark(
    corner: TilecastActiveBrandBug["corner"],
    mark: TilecastActiveBrandBug | undefined,
    shown: boolean,
    lift: number,
  ) {
    return html`<div
      class=${classMap({
        "brand-bug": true,
        [`brand-bug--${corner.replace("_", "-")}`]: true,
        visible: shown,
        "brand-bug--scrim": mark?.backgroundStyle === "scrim",
      })}
      style=${cssProps(
        mark
          ? {
              opacity: String(mark.opacityPercent / 100),
              "max-width": `${Math.max(mark.widthPercent, 12)}vw`,
              "--brand-bug-margin": `${mark.marginPercent}vmin`,
              "--brand-bug-lift": `${lift}px`,
            }
          : { "--brand-bug-lift": `${lift}px` },
      )}
    >
      <img
        class="brand-bug__logo"
        alt=""
        src=${mark?.imageSrc ?? nothing}
        style=${cssProps(
          mark?.imageSrc
            ? { width: `${mark.widthPercent}vw` }
            : { display: "none" },
        )}
      />
      <span
        class="brand-bug__text"
        style=${cssProps(
          mark?.text
            ? {
                color: mark.textColor,
                "font-size": `${mark.textSizePercent}vh`,
              }
            : { display: "none" },
        )}
        >${mark?.text ?? ""}</span
      >
    </div>`;
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (!changed.has("model")) return;
    const m = this.model;
    const root = document.documentElement.style;
    const stage = document.getElementById("content-stage");
    if (m?.stripHeightPx != null) {
      root.setProperty("--plugin-height", `${m.stripHeightPx}px`);
    }
    if (m?.countdown) {
      // Padding and type size are resolved centrally so every player agrees
      // on what a contentPadding and textScale mean.
      root.setProperty(
        "--plugin-bar-padding",
        `${m.countdown.contentPadding}%`,
      );
      root.setProperty("--plugin-bar-font-size", `${m.countdown.fontSizePx}px`);
    }
    stage?.classList.toggle("plugin-push", m?.strip !== null && !!m?.push);
    this.syncTicker();
    this.syncMeterEntrance();
  }

  private syncTicker(): void {
    const ticker =
      this.model?.strip === "alert_ticker" ? this.model.ticker : null;
    if (!ticker) {
      this.tickerKey = "";
      this.tickerAnimation?.cancel();
      this.tickerAnimation = null;
      return;
    }
    // Rewriting the scroll on each tick would restart it from the right edge
    // once a second and the message would never be read.
    const key = `${ticker.id}${ticker.message}${ticker.severity}${ticker.pixelsPerSecond}${ticker.heightPx}`;
    if (key === this.tickerKey) return;
    this.tickerKey = key;
    this.tickerAnimation?.cancel();
    this.tickerAnimation = null;
    const viewport = this.querySelector<HTMLElement>(".ticker-viewport");
    const track = this.querySelector<HTMLElement>(".ticker-track");
    const text = this.querySelector<HTMLElement>(".ticker-message");
    if (!viewport || !track || !text || typeof track.animate !== "function") {
      return;
    }
    // A reader who cannot follow motion still has to receive the alert: the
    // message stops moving and is clipped instead (see runtime.css).
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // The message travels its own width plus the bar's, so a long alert
    // scrolls for longer instead of scrolling faster.
    const distance = viewport.clientWidth + text.scrollWidth;
    const seconds = Math.max(6, distance / ticker.pixelsPerSecond);
    if (this.animationScale === 0) {
      // Motion frozen for deterministic frames: the message's start sits at a
      // fixed point of the bar, independent of the engine's text metrics.
      track.style.transform = `translateX(${-viewport.clientWidth * 0.95}px)`;
      return;
    }
    track.style.removeProperty("transform");
    const animation = track.animate(
      [
        { transform: "translateX(0)" },
        { transform: `translateX(${-distance}px)` },
      ],
      { duration: seconds * 1_000, iterations: Infinity, easing: "linear" },
    );
    this.tickerAnimation = animation;
  }

  private syncMeterEntrance(): void {
    const m = this.model;
    const meter = m?.strip === "noise_meter" ? m.noiseMeter : null;
    if (!meter) {
      this.meterSignature = "";
      return;
    }
    const signature = `${meter.id}`;
    if (signature === this.meterSignature) return;
    this.meterSignature = signature;
    // A brief emphasis on the warning label when the bar arrives, and nothing
    // after that: a bar that keeps flashing stops being read.
    this.meterEntering = true;
    this.meterEnterTimer?.cancel();
    this.meterEnterTimer = this.clock.at(
      this.clock.monotonicNow() + 1_400,
      () => {
        this.meterEntering = false;
        this.requestUpdate();
      },
    );
    this.requestUpdate();
  }
}

customElements.define("tc-plugin-surfaces", PluginSurfaces);
