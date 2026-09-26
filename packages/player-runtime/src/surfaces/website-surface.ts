/**
 * A remote website in an Electron `<webview>`: an isolated guest in its own
 * partitioned, sandboxed session (the host enforces the session policy when
 * the guest attaches). The page never runs in the trusted runtime document.
 *
 * Used only when the host advertises `remoteWeb: "electron-webview"`. Hosts
 * without an isolated mechanism advertise no website capability and never
 * receive website items.
 */
import type { RuntimeItem, RuntimeWebsiteConfig } from "../host/contract";
import { TimerGroup } from "../clock/scheduler";
import type { MediaSurface, SurfaceEnvironment } from "./surface";

interface WebviewElement extends HTMLElement {
  setZoomFactor?(factor: number): void;
  executeJavaScript?(code: string): Promise<unknown>;
  reload?(): void;
}

export class WebviewWebsiteSurface implements MediaSurface {
  readonly element: HTMLDivElement;
  private readonly webview: WebviewElement;
  private readonly config: RuntimeWebsiteConfig;
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
    this.config = item.website!;
    this.timers = new TimerGroup(env.clock);
    this.loadTimer = new TimerGroup(env.clock);
    const container = document.createElement("div");
    container.style.width = "100%";
    container.style.height = "100%";
    const webview = document.createElement("webview") as WebviewElement;
    const policy = this.config.cookiePolicy;
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
        `javascript=${this.config.javascriptEnabled ? "yes" : "no"}`,
        `webSecurity=yes`,
        `domStorage=${this.config.domStorageEnabled ? "yes" : "no"}`,
      ].join(","),
    );
    if (this.config.customUserAgent.trim()) {
      webview.setAttribute("useragent", this.config.customUserAgent.trim());
    }
    webview.style.backgroundColor = this.config.backgroundColor || "#000";
    container.appendChild(webview);
    this.webview = webview;
    this.element = container;
  }

  prepare(): Promise<void> {
    const config = this.config;
    const webview = this.webview;
    const ready = new Promise<void>((resolve) => (this.resolveReady = resolve));
    this.loadTimer.after(Math.max(config.loadTimeoutSeconds, 5) * 1_000, () =>
      this.fail("load timeout"),
    );
    this.scheduleRefresh();
    webview.addEventListener("did-finish-load", () => {
      if (this.disposed || this.failed) return;
      if (!this.loaded) {
        this.loaded = true;
        this.loadTimer.cancelAll();
        if (config.zoomPercent && config.zoomPercent !== 100) {
          try {
            webview.setZoomFactor?.(config.zoomPercent / 100);
          } catch {
            /* zoom is cosmetic */
          }
        }
        if (config.scrollX || config.scrollY) {
          webview
            .executeJavaScript?.(
              `window.scrollTo(${Math.trunc(config.scrollX)},${Math.trunc(config.scrollY)})`,
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
    webview.setAttribute("src", this.item.src);
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
    const config = this.config;
    if (config.reloadPolicy !== "interval" || !config.refreshIntervalSeconds) {
      return;
    }
    this.timers.every(
      Math.max(config.refreshIntervalSeconds, 30) * 1_000,
      () => {
        try {
          this.webview.reload?.();
        } catch {
          /* reload is best-effort */
        }
      },
    );
  }

  private fail(reason: string): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.loadTimer.cancelAll();
    const config = this.config;
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
