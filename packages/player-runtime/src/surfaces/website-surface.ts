/**
 * The legacy Electron adapter for remote web: an Electron `<webview>`, an
 * isolated guest in its own partitioned, sandboxed session (the host enforces
 * the session policy when the guest attaches). The page never runs in the
 * trusted runtime document.
 *
 * Used only when the host advertises `remoteWeb: "electron-webview"`. It
 * reads the same normalized remote web spec as HostRemoteWebSurface, the
 * permanent surface, so Electron keeps working while it migrates to a
 * host-owned view behind the `host-view` contract.
 */
import type { RemoteWebPresentationV1, RuntimeItem } from "../host/contract";
import { TimerGroup } from "../clock/scheduler";
import { remoteWebSpecOf, youtubeEmbedUrl } from "../remote-web/spec";
import type { MediaSurface, SurfaceEnvironment } from "./surface";

interface WebviewElement extends HTMLElement {
  setZoomFactor?(factor: number): void;
  executeJavaScript?(code: string): Promise<unknown>;
  reload?(): void;
}

export class WebviewWebsiteSurface implements MediaSurface {
  readonly element: HTMLDivElement;
  private readonly webview: WebviewElement;
  private readonly presentation: RemoteWebPresentationV1;
  private readonly src: string;
  private readonly zoomPercent: number;
  private readonly scroll: [number, number];
  private readonly timers: TimerGroup;
  /** The load deadline, cancelled separately from the refresh interval. */
  private readonly loadTimer: TimerGroup;
  private loaded = false;
  private failed = false;
  private disposed = false;
  private resolveReady: (() => void) | null = null;

  constructor(
    private readonly item: RuntimeItem,
    private readonly env: SurfaceEnvironment,
    mount: number,
  ) {
    const spec = remoteWebSpecOf(item);
    if (!spec) throw new Error("website configuration missing");
    const content = spec.content;
    const page = content.kind === "page" ? content : null;
    this.presentation = spec.presentation;
    this.src = page ? page.url : youtubeEmbedUrl(content as never);
    this.zoomPercent = page?.zoomPercent ?? 100;
    this.scroll = [page?.scrollX ?? 0, page?.scrollY ?? 0];
    this.timers = new TimerGroup(env.clock);
    this.loadTimer = new TimerGroup(env.clock);
    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.height = "100%";
    const webview = document.createElement("webview") as WebviewElement;
    const policy = page?.cookiePolicy ?? "first_party";
    const partition =
      policy === "disabled"
        ? `tilecast-websites-disabled-${item.id}-${mount}`
        : policy === "first_and_third_party"
          ? "persist:tilecast-websites-all"
          : "persist:tilecast-websites-first-party";
    webview.setAttribute("partition", partition);
    webview.setAttribute("allowpopups", "false");
    webview.setAttribute(
      "webpreferences",
      [
        `javascript=${page?.javascriptEnabled === false ? "no" : "yes"}`,
        `webSecurity=yes`,
        `domStorage=${page?.domStorageEnabled === false ? "no" : "yes"}`,
      ].join(","),
    );
    if (page?.userAgent) {
      webview.setAttribute("useragent", page.userAgent);
    }
    webview.style.backgroundColor = page?.backgroundColor || "#000";
    container.appendChild(webview);
    this.webview = webview;
    this.element = container;
  }

  prepare(): Promise<void> {
    const webview = this.webview;
    const ready = new Promise<void>((resolve) => (this.resolveReady = resolve));
    this.loadTimer.after(this.presentation.loadTimeoutSeconds * 1_000, () =>
      this.fail("load timeout"),
    );
    this.scheduleRefresh();
    webview.addEventListener("did-finish-load", () => {
      if (this.disposed || this.failed) return;
      if (!this.loaded) {
        this.loaded = true;
        this.loadTimer.cancelAll();
        if (this.zoomPercent !== 100) {
          try {
            webview.setZoomFactor?.(this.zoomPercent / 100);
          } catch {
            /* zoom is cosmetic */
          }
        }
        const [scrollX, scrollY] = this.scroll;
        if (scrollX || scrollY) {
          webview
            .executeJavaScript?.(
              `window.scrollTo(${Math.trunc(scrollX)},${Math.trunc(scrollY)})`,
            )
            .catch(() => undefined);
        }
        this.resolveReady?.();
      } else {
        this.env.sink.websiteRecovered();
      }
    });
    webview.addEventListener("did-fail-load", (event) => {
      const e = event as unknown as { errorCode: number; isMainFrame: boolean };
      if (e.isMainFrame && e.errorCode !== -3 /* aborted */) {
        this.fail("error " + e.errorCode);
      }
    });
    webview.addEventListener("crashed", () => this.fail("renderer crashed"));
    webview.setAttribute("src", this.src);
    return ready;
  }

  activate(): Promise<void> {
    return Promise.resolve();
  }

  pause(): void {}

  seek(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timers.cancelAll();
    this.loadTimer.cancelAll();
  }

  private scheduleRefresh(): void {
    const interval = this.presentation.reloadIntervalSeconds;
    if (!interval) {
      return;
    }
    this.timers.every(interval * 1_000, () => {
      try {
        this.webview.reload?.();
      } catch {
        /* reload is best-effort */
      }
    });
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.loadTimer.cancelAll();
    const config = this.presentation;
    const fallback = config.failureBehavior !== "skip" && !!config.fallbackSrc;
    this.env.sink.websiteFailed(reason, fallback);
    if (!fallback) return;
    const image = document.createElement("img");
    image.alt = "";
    image.style.objectFit = "contain";
    image.onload = () => {
      if (!this.disposed) this.env.sink.fallbackShown();
    };
    image.src = config.fallbackSrc!;
    this.element.replaceChildren(image);
  }
}
