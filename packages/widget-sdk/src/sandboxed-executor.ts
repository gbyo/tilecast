/**
 * SPIKE (stage 5c gate): external Widget execution in a sandboxed frame.
 *
 * Docs/content-extension-model.md §12 requires an isolation spike measured
 * on Electron, WPE, and the Android shared-runtime WebView before any
 * runtime-installed Widget code executes. This executor is that spike: it
 * runs a verified bundle in an opaque-origin `allow-scripts` iframe behind
 * the `./sandbox-bridge.ts` protocol, and the harness in
 * `test/sandbox-harness/` measures it in a real browser.
 *
 * Deliberately spike-grade, with production follow-ups recorded in
 * `docs/widget-sandbox-spike.md`:
 *
 * - The frame bootstrap is a template string. Production needs a built
 *   frame entry so both sides share the SDK's event and revision
 *   helpers instead of reimplementing them.
 * - The bundle contract is a classic script assigning
 *   `__tilecastWidgetDefinition`. The 5c module format (ESM vs classic,
 *   SDK linkage) is still open.
 * - The frame skips input-revision tracking, so a slow element could
 *   misreport after an update. The harness only covers synchronous
 *   fixtures until the shared-frame-bundle follow-up lands.
 * - No `csp` attribute on the frame yet: the sandbox token is the
 *   isolation boundary under test. Attribute hardening is a follow-up
 *   measurement, not a spike blocker.
 */
import type { WidgetContext } from "./context.ts";
import {
  assertBridgeMessageSize,
  createBridgeNonce,
  parseFrameMessage,
  SANDBOX_BRIDGE_PROTOCOL,
  SANDBOX_FRAME_TOKENS,
  snapshotDeclaredResources,
  type DeclaredWidgetInputs,
  type ParentToFrameMessage,
  type SandboxSnapshot,
} from "./sandbox-bridge.ts";
import { DEFAULT_READY_TIMEOUT_MS, type WidgetMountState } from "./mount.ts";
import type {
  WidgetExecution,
  WidgetExecutionRequest,
  WidgetExecutor,
} from "./executor.ts";
import {
  WIDGET_EMPTY_EVENT,
  WIDGET_ERROR_EVENT,
  WIDGET_READY_EVENT,
} from "./events.ts";

/**
 * How the frame document reaches the iframe.
 *
 * The spike measured `srcdoc` and `blob` against the real runtime CSP:
 * srcdoc inherits `script-src 'self'`, which can never match an opaque
 * origin, so its scripts never run; `blob:` is refused by
 * `frame-src https: http:`. Both stay as explicit options so the harness
 * keeps proving the negative, but the viable design is `hosted`: the
 * host serves the frame document (bootstrap plus verified bundle) from
 * a second origin, which neither inherits the parent CSP nor needs a
 * policy change (`frame-src` already allows `https:` and `http:`).
 */
export type SandboxEmbedding = "srcdoc" | "blob" | "hosted";

/** Verified bytes from the package pipeline; the CAS is the authority. */
export interface SandboxedWidgetBundle {
  readonly javaScript: string;
  readonly sha256: string;
}

export interface SandboxedWidgetRequest extends WidgetExecutionRequest {
  readonly bundle: SandboxedWidgetBundle;
  readonly declared: DeclaredWidgetInputs;
  readonly embedding?: SandboxEmbedding;
  /**
   * Required for `hosted`: the host-served frame document URL. The host
   * builds it with `buildSandboxFrameDocument` over verified bytes, on
   * an origin that is not the application origin.
   */
  readonly frameUrl?: string;
}

export interface SandboxedWidgetExecutorOptions {
  readonly defaultEmbedding?: SandboxEmbedding;
  /** Seams for environments without blob URLs (jsdom). */
  readonly createObjectURL?: (document: string) => string;
  readonly revokeObjectURL?: (url: string) => void;
}

/** The global a bundle assigns. Classic script, deterministic shape. */
export const SANDBOX_DEFINITION_GLOBAL = "__tilecastWidgetDefinition";

/** Escape a bundle for inlining: no script block may break out. */
export function escapeInlineScript(javaScript: string): string {
  return javaScript.replace(/<\/script/gi, "<\\/script");
}

/**
 * The frame bootstrap. Kept dependency-free ES2017: it runs from a
 * template string, not from the SDK bundle (see the spike note above).
 * Every interpolated value is a frozen protocol constant.
 */
export function sandboxFrameBootstrap(): string {
  return `(function () {
  "use strict";
  var PROTOCOL = ${JSON.stringify(SANDBOX_BRIDGE_PROTOCOL)};
  var READY_EVENT = ${JSON.stringify(WIDGET_READY_EVENT)};
  var EMPTY_EVENT = ${JSON.stringify(WIDGET_EMPTY_EVENT)};
  var ERROR_EVENT = ${JSON.stringify(WIDGET_ERROR_EVENT)};
  var DEFINITION_GLOBAL = ${JSON.stringify(SANDBOX_DEFINITION_GLOBAL)};
  var nonce = null;
  var parentSource = null;
  var element = null;
  var definition = null;
  var resources = null;
  var frameContext = null;
  var disposed = false;

  function post(state) {
    if (parentSource === null || nonce === null || disposed) return;
    parentSource.postMessage({ protocol: PROTOCOL, nonce: nonce, state: state }, "*");
  }
  function fail(code) { post({ state: "error", code: code }); }

  function validTagName(value) {
    return typeof value === "string" && /^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(value);
  }

  function frameClock(context) {
    var offset = context.wallClockOffsetMs;
    return {
      now: function () { return Date.now() + offset; },
      monotonicNow: function () { return performance.now(); },
      after: function (delayMs, run) {
        var id = setTimeout(run, delayMs);
        return { cancel: function () { clearTimeout(id); } };
      }
    };
  }

  function toContext(context) {
    return {
      clock: frameClock(context),
      locale: context.locale,
      timeZone: context.timeZone,
      hourCycle: context.hourCycle,
      theme: context.theme,
      motion: { reduced: context.reducedMotion },
      mode: context.mode
    };
  }

  function toResources(snapshot) {
    var documents = snapshot.documents || {};
    var grants = snapshot.media || [];
    function has(map, key) {
      return Object.prototype.hasOwnProperty.call(map, key);
    }
    function mediaUri(assetId, variantId) {
      for (var i = 0; i < grants.length; i++) {
        if (grants[i].assetId === assetId && grants[i].variantId === variantId) {
          return grants[i].uri;
        }
      }
      return null;
    }
    return {
      dataDocument: function (id) { return has(documents, id) ? documents[id] : null; },
      dataset: function (id, datasetId) {
        var document = has(documents, id) ? documents[id] : null;
        if (!document || !document.datasets) return null;
        return has(document.datasets, datasetId) ? document.datasets[datasetId] : null;
      },
      media: mediaUri,
      mediaVariant: function (assetId) {
        var found = null;
        for (var i = 0; i < grants.length; i++) {
          if (grants[i].assetId !== assetId) continue;
          if (found !== null) return null;
          found = grants[i].uri;
        }
        return found;
      }
    };
  }

  function applyInputs(component, version) {
    var parsed;
    try {
      parsed = definition.parseConfig
        ? definition.parseConfig(component.config, version)
        : { ok: true, config: component.config };
    } catch (err) {
      parsed = { ok: false };
    }
    if (!parsed || parsed.ok !== true) {
      fail("widget_config_invalid");
      return null;
    }
    var resolution = null;
    try {
      resolution = definition.resolveData
        ? definition.resolveData(parsed.config, resources)
        : { state: "ready", data: null };
    } catch (err) {
      resolution = { state: "error", code: "widget_resolve_failed" };
    }
    if (!resolution || resolution.state === "error") {
      fail(resolution && resolution.code ? resolution.code : "widget_error");
      return null;
    }
    element.context = frameContext;
    element.config = parsed.config;
    element.data = resolution.state === "ready" ? resolution.data : null;
    element.empty = resolution.state === "empty" ? resolution.reason : null;
    return resolution.state;
  }

  function boot(snapshot) {
    var candidate = window[DEFINITION_GLOBAL];
    if (!candidate || typeof candidate !== "object") { fail("frame_error"); return; }
    if (typeof candidate.type !== "string" || typeof candidate.version !== "number") {
      fail("frame_error");
      return;
    }
    if (candidate.type !== snapshot.component.type || candidate.version !== snapshot.component.version) {
      fail("frame_error");
      return;
    }
    if (!validTagName(candidate.tagName) || typeof candidate.element !== "function") {
      fail("frame_error");
      return;
    }
    definition = candidate;
    try {
      window.customElements.define(definition.tagName, definition.element);
    } catch (err) {
      fail("frame_error");
      return;
    }
    resources = toResources(snapshot);
    frameContext = toContext(snapshot.context);
    element = document.createElement(definition.tagName);
    element.addEventListener(READY_EVENT, function () { post({ state: "ready" }); });
    element.addEventListener(EMPTY_EVENT, function (event) {
      post({ state: "empty", reason: event.detail && event.detail.reason });
    });
    element.addEventListener(ERROR_EVENT, function (event) {
      post({ state: "error", code: event.detail && event.detail.code });
    });
    if (!applyInputs(snapshot.component, snapshot.component.version)) return;
    document.body.appendChild(element);
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || message.protocol !== PROTOCOL) return;
    if (message.kind === "init") {
      if (nonce !== null) return;
      if (typeof message.nonce !== "string" || message.nonce === "") return;
      nonce = message.nonce;
      parentSource = event.source;
      try {
        boot(message.snapshot);
      } catch (err) {
        fail("frame_error");
      }
      return;
    }
    if (message.nonce !== nonce) return;
    if (disposed) return;
    if (message.kind === "update") {
      try {
        resources = toResources(message.snapshot);
        frameContext = toContext(message.snapshot.context);
        var outcome = applyInputs(message.snapshot.component, message.snapshot.component.version);
        // The element reports its own boot; on update the frame stands in
        // for input-revision tracking (a recorded spike follow-up) and
        // reports the resolution outcome.
        if (outcome === "ready") {
          post({ state: "ready" });
        } else if (outcome === "empty") {
          post({ state: "empty", reason: element.empty });
        }
      } catch (err) {
        fail("frame_error");
      }
    } else if (message.kind === "dispose") {
      disposed = true;
      if (element && element.parentNode) element.parentNode.removeChild(element);
      element = null;
    }
  });
})();`;
}

/** The complete frame document: bootstrap first, verified bundle second. */
export function buildSandboxFrameDocument(bundleJavaScript: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff;font:12px/1.4 monospace}</style></head><body><script>${sandboxFrameBootstrap()}</script><script>${escapeInlineScript(bundleJavaScript)}</script></body></html>`;
}

export function snapshotSandboxContext(
  context: WidgetContext,
): SandboxSnapshot["context"] {
  return {
    // The frame and the host share one device clock; the offset carries
    // the host's server correction across the bridge.
    wallClockOffsetMs: context.clock.now() - Date.now(),
    locale: context.locale,
    timeZone: context.timeZone,
    hourCycle: context.hourCycle,
    theme: {
      scheme: context.theme.scheme,
      background: context.theme.background,
      foreground: context.theme.foreground,
      accent: context.theme.accent,
    },
    reducedMotion: context.motion.reduced,
    mode: context.mode,
  };
}

export class SandboxedWidgetExecutor implements WidgetExecutor {
  private readonly defaultEmbedding: SandboxEmbedding;
  private readonly createObjectURL: (document: string) => string;
  private readonly revokeObjectURL: (url: string) => void;

  constructor(options: SandboxedWidgetExecutorOptions = {}) {
    this.defaultEmbedding = options.defaultEmbedding ?? "srcdoc";
    this.createObjectURL =
      options.createObjectURL ??
      ((document: string) =>
        URL.createObjectURL(new Blob([document], { type: "text/html" })));
    this.revokeObjectURL =
      options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  }

  mount(
    container: HTMLElement,
    request: SandboxedWidgetRequest,
  ): WidgetExecution {
    return new SandboxedWidgetExecution(container, request, {
      defaultEmbedding: this.defaultEmbedding,
      createObjectURL: this.createObjectURL,
      revokeObjectURL: this.revokeObjectURL,
    });
  }
}

interface ExecutionOptions {
  defaultEmbedding: SandboxEmbedding;
  createObjectURL: (document: string) => string;
  revokeObjectURL: (url: string) => void;
}

class SandboxedWidgetExecution implements WidgetExecution {
  private current: WidgetMountState = { state: "pending" };
  private request: SandboxedWidgetRequest;
  private iframe: HTMLIFrameElement | null = null;
  private blobURL: string | null = null;
  private nonce = "";
  private timer: { cancel(): void } | null = null;
  private disposed = false;
  private readonly onMessage: (event: MessageEvent) => void;

  constructor(
    private readonly container: HTMLElement,
    request: SandboxedWidgetRequest,
    private readonly options: ExecutionOptions,
  ) {
    this.request = request;
    this.onMessage = (event: MessageEvent) => this.handleMessage(event);
    window.addEventListener("message", this.onMessage);
    this.report({ state: "pending" });
    if (
      typeof request.bundle?.javaScript !== "string" ||
      request.bundle.javaScript === ""
    ) {
      this.settle({ state: "error", code: "frame_error" });
      return;
    }
    this.attach();
  }

  get state(): WidgetMountState {
    return this.current;
  }

  update(request: SandboxedWidgetRequest): void {
    if (this.disposed) return;
    const identityChanged =
      request.component.type !== this.request.component.type ||
      request.component.version !== this.request.component.version ||
      (request.embedding ?? this.options.defaultEmbedding) !==
        (this.request.embedding ?? this.options.defaultEmbedding) ||
      ((request.embedding ?? this.options.defaultEmbedding) === "hosted" &&
        request.frameUrl !== this.request.frameUrl);
    this.request = request;
    if (identityChanged || this.iframe === null) {
      this.detach();
      this.report({ state: "pending" });
      this.attach();
      return;
    }
    this.report({ state: "pending" });
    try {
      this.post("update", this.snapshot(request));
    } catch {
      this.settle({ state: "error", code: "frame_error" });
      return;
    }
    this.armTimeout();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.timer?.cancel();
    this.timer = null;
    window.removeEventListener("message", this.onMessage);
    try {
      this.post("dispose");
    } catch {
      // Best effort: the frame is going away regardless.
    }
    this.detach();
  }

  private snapshot(request: SandboxedWidgetRequest): SandboxSnapshot {
    const { documents, media } = snapshotDeclaredResources(
      request.resources,
      request.declared,
    );
    return {
      component: {
        type: request.component.type,
        version: request.component.version,
        config: request.component.config,
      },
      documents,
      media,
      context: snapshotSandboxContext(request.context),
    };
  }

  private attach(): void {
    this.nonce = createBridgeNonce();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", SANDBOX_FRAME_TOKENS);
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "External widget");
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.border = "0";
    const embedding = this.request.embedding ?? this.options.defaultEmbedding;
    if (embedding === "hosted") {
      if (
        typeof this.request.frameUrl !== "string" ||
        this.request.frameUrl === ""
      ) {
        this.settle({ state: "error", code: "frame_error" });
        return;
      }
      frame.src = this.request.frameUrl;
    } else {
      const documentText = buildSandboxFrameDocument(
        this.request.bundle.javaScript,
      );
      if (embedding === "blob") {
        this.blobURL = this.options.createObjectURL(documentText);
        frame.src = this.blobURL;
      } else {
        frame.srcdoc = documentText;
      }
    }
    this.iframe = frame;
    this.container.appendChild(frame);
    // A network-loaded frame navigates asynchronously: an init posted
    // before the document exists is dropped, so repost on load. The
    // bootstrap ignores the duplicate (the nonce is already set).
    frame.addEventListener("load", () => {
      if (this.disposed || this.iframe !== frame) return;
      try {
        this.post("init", this.snapshot(this.request));
      } catch {
        this.settle({ state: "error", code: "frame_error" });
      }
    });
    try {
      this.post("init", this.snapshot(this.request));
    } catch {
      // An unserializable config or an oversize snapshot is a host bug,
      // reported as a placement error rather than thrown.
      this.settle({ state: "error", code: "frame_error" });
      return;
    }
    this.armTimeout();
  }

  private detach(): void {
    this.timer?.cancel();
    this.timer = null;
    if (this.iframe !== null) {
      this.iframe.remove();
      this.iframe = null;
    }
    if (this.blobURL !== null) {
      this.options.revokeObjectURL(this.blobURL);
      this.blobURL = null;
    }
  }

  private post(
    kind: ParentToFrameMessage["kind"],
    snapshot?: SandboxSnapshot,
  ): void {
    if (this.iframe === null) return;
    const message: ParentToFrameMessage = {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: this.nonce,
      kind,
      ...(snapshot === undefined ? {} : { snapshot }),
    };
    assertBridgeMessageSize(message);
    const target = this.iframe.contentWindow;
    if (target === null) {
      throw new Error("sandbox frame has no window");
    }
    target.postMessage(message, "*");
  }

  private handleMessage(event: MessageEvent): void {
    if (this.disposed || this.iframe === null) return;
    const report = parseFrameMessage(
      { origin: event.origin, data: event.data },
      this.nonce,
    );
    if (report === null) return;
    this.settle(report.state);
  }

  private armTimeout(): void {
    this.timer?.cancel();
    if (this.current.state !== "pending") return;
    const clock = this.request.context.clock;
    const timeoutMs = this.request.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.timer = clock.after(timeoutMs, () => {
      this.timer = null;
      if (!this.disposed && this.current.state === "pending") {
        this.settle({ state: "error", code: "widget_ready_timeout" });
      }
    });
  }

  private report(state: WidgetMountState): void {
    this.current = state;
    this.request.onState?.(state);
  }

  private settle(state: WidgetMountState): void {
    if (
      this.current.state === state.state &&
      JSON.stringify(this.current) === JSON.stringify(state)
    ) {
      return;
    }
    if (state.state !== "pending") {
      this.timer?.cancel();
      this.timer = null;
    }
    this.report(state);
  }
}
