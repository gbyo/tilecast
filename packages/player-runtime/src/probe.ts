/**
 * `globalThis.__tilecastRuntime`: a read-only description of what the runtime
 * is showing, for field diagnostics and the conformance suite.
 *
 * `settled()` resolves once the view has rendered, fonts are loaded, every
 * image in the visible layer has decoded and two frames have painted — the
 * explicit readiness the conformance suite waits on instead of sleeping.
 * Clock control (`advance`) exists only when the host asked for a conformance
 * run; a production runtime cannot be driven through the probe.
 */
import type { TilecastRuntimeHostV1 } from "./host/contract";
import type { ManualClock } from "./clock/scheduler";
import type { PlaybackController } from "./engine/controller";
import type { PluginOverlayController } from "./compat/plugins/overlay-controller";
import type { PlayerRoot } from "./views/player-root";

export interface ProbeOptions {
  version: string;
  host: TilecastRuntimeHostV1;
  controller: PlaybackController;
  overlay: PluginOverlayController;
  view: PlayerRoot;
  manual: ManualClock | null;
}

const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

function text(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function visibleLayer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".layer.visible");
}

function describeLayer(layer: HTMLElement | null): Record<string, unknown> {
  if (!layer) return { kind: null };
  const video = layer.querySelector("video");
  const webview = layer.querySelector("webview");
  const images = layer.querySelectorAll("img").length;
  return {
    kind: video
      ? "video"
      : webview
        ? "website"
        : images
          ? "image-or-tree"
          : "tree",
    itemId: video?.dataset["tilecastItemId"] ?? null,
    images,
    videos: layer.querySelectorAll("video").length,
    text: text(layer).slice(0, 400),
  };
}

export function installProbe(options: ProbeOptions): void {
  const { controller, overlay, view, manual } = options;
  const probe = {
    version: options.version,
    contractVersion: options.host.contractVersion,
    host: { ...options.host.info },
    capabilities: { ...options.host.capabilities },
    describe() {
      const state = controller.state;
      const model = overlay.current;
      const message = document.getElementById("message");
      const outside = document.getElementById("outside-hours-overlay");
      return {
        view: state.mode,
        state:
          state.mode === "status" || state.mode === "sleep"
            ? state.presentation.state
            : state.mode === "playing"
              ? "playing"
              : null,
        item:
          state.mode === "playing" && state.stage
            ? {
                id: state.stage.item.id,
                kind: state.stage.item.kind,
                phase: state.stage.phase,
                transition: state.stage.transition,
              }
            : null,
        engine: controller.describe(),
        stage: view.describeStage(),
        front: describeLayer(visibleLayer()),
        message: {
          visible: message?.classList.contains("visible") ?? false,
          text: text(message),
        },
        overlay: {
          strip: model.strip,
          push: model.push,
          marks: model.marks.map((mark) => mark.corner),
          confetti: model.confettiKey !== null,
          stripText:
            model.strip === "countdown_bar"
              ? text(document.getElementById("countdown-bar"))
              : model.strip === "alert_ticker"
                ? text(document.getElementById("alert-ticker"))
                : model.strip === "noise_meter"
                  ? text(document.getElementById("noise-meter"))
                  : "",
        },
        identify: document
          .getElementById("identify")
          ?.classList.contains("visible")
          ? text(document.getElementById("identify"))
          : null,
        outsideHours: outside?.classList.contains("visible")
          ? outside.classList.contains("custom-text")
            ? "custom_text"
            : "bouncing_logo"
          : null,
      };
    },
    async settled(): Promise<void> {
      // An incoming occurrence prepares on the hidden layer; wait (bounded)
      // until the engine has shown or failed it.
      const deadline = performance.now() + 10_000;
      while (
        controller.describe()["presentation"] === "preparing" &&
        performance.now() < deadline
      ) {
        await frames();
      }
      await view.updateComplete;
      await document.fonts?.ready;
      const layer = visibleLayer();
      const images = Array.from(
        document.querySelectorAll<HTMLImageElement>(
          "#message img, #brand-bugs img[src], #outside-hours-overlay img",
        ),
      );
      if (layer) images.push(...Array.from(layer.querySelectorAll("img")));
      await Promise.all(
        images.map((image) =>
          image.complete
            ? image.decode().catch(() => undefined)
            : new Promise((r) => {
                image.addEventListener("load", r, { once: true });
                image.addEventListener("error", r, { once: true });
              }),
        ),
      );
      await frames();
    },
    advance(milliseconds: number): void {
      if (!manual)
        throw new Error("clock control is only available in conformance runs");
      manual.advance(Math.max(0, Number(milliseconds) || 0));
    },
    stepWall(milliseconds: number): void {
      if (!manual)
        throw new Error("clock control is only available in conformance runs");
      manual.stepWall(Number(milliseconds) || 0);
    },
  };
  Object.defineProperty(globalThis, "__tilecastRuntime", {
    value: Object.freeze(probe),
    configurable: false,
  });
}
