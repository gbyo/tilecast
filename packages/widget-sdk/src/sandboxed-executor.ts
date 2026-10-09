/**
 * Production external Widget execution in a sandboxed frame.
 *
 * Docs/content-extension-model.md §12 requires isolation measured on
 * Electron, WPE, and the Android shared-runtime WebView before any
 * runtime-installed Widget code executes. This executor runs a verified
 * bundle in an opaque-origin `allow-scripts` iframe behind the
 * `./sandbox-bridge.ts` protocol, and the harness in `spike/`
 * measures it in a real browser.
 *
 * Production execution is hosted-frame only: the Server assembles the
 * frame document over verified package Widget bytes
 * (`apps/server/internal/extensions/sandbox`), and Players verify and
 * cache that exact document. `srcdoc` and `blob` stay only as
 * negative/security fixtures proving why they are unsuitable; no
 * production Player path may select them.
 *
 * Open follow-ups, recorded in `docs/widget-sandbox-spike.md`:
 *
 * - The frame bootstrap is a template string. A built frame entry
 *   would let both sides share the SDK's event and revision helpers
 *   instead of reimplementing them.
 * - The bundle contract is a classic script assigning
 *   `__tilecastWidgetDefinition`. The module format (ESM vs classic,
 *   SDK linkage) is still open.
 */
import type { WidgetContext } from "./context.ts";
import {
  assertBridgeMessageSize,
  createBridgeNonce,
  parseFrameHello,
  parseFrameReport,
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
 * keeps proving the negative, but production is `hosted` only: the
 * host serves the frame document (bootstrap plus verified bundle) from
 * a second origin, which neither inherits the parent CSP nor needs a
 * policy change (`frame-src` already allows `https:` and `http:`).
 * `blob` embeds caller-supplied verified frame bytes as a blob URL.
 * Blob and srcdoc documents inherit the embedding context's policy,
 * so they only execute where that policy already permits the frame's
 * inline scripts; the Browser instead navigates its grants and takes
 * the sandbox from the response (see docs/widget-sandbox-spike.md).
 * `srcdoc` stays a harness negative proof: it inherits the parent
 * CSP, whose `script-src 'self'` can never match the frame's opaque
 * origin.
 */
export type SandboxEmbedding = "srcdoc" | "blob" | "hosted";

/** Verified bytes from the package pipeline; the CAS is the authority. */
export interface SandboxedWidgetBundle {
  readonly javaScript: string;
  readonly sha256: string;
}

export interface SandboxedWidgetRequest extends WidgetExecutionRequest {
  /**
   * Required for `srcdoc`, and for `blob` without `frameDocument`: the
   * verified bundle the executor assembles into a frame document with
   * the per-attach token interpolated. `hosted` frames are served by
   * URL, so hosts that never inline may omit it.
   */
  readonly bundle?: SandboxedWidgetBundle;
  /**
   * Alternate `blob` input: a complete verified frame document, built
   * by `buildSandboxFrameDocument` over verified bytes. The executor
   * embeds it unchanged and binds the attach with a URL-fragment
   * token, exactly like `hosted`. `srcdoc` cannot take it: srcdoc
   * documents have no fragment to carry the token.
   */
  readonly frameDocument?: string;
  readonly declared: DeclaredWidgetInputs;
  readonly embedding?: SandboxEmbedding;
  /**
   * Required for `hosted`: the host-served frame document URL. The host
   * builds it with `buildSandboxFrameDocument` over verified bytes.
   * Second-origin serving keeps ambient authority away from the frame;
   * same-origin serving (a browser service worker grant) is safe
   * because the sandbox — attribute or response directive — forces an
   * opaque origin either way.
   */
  readonly frameUrl?: string;
  /**
   * Where a `hosted` frame's sandbox comes from. `attribute` (the
   * default) sets the iframe sandbox attribute; `response` navigates
   * bare and takes the sandbox from the response `sandbox` directive.
   * The Browser needs `response`: a service worker never sees a
   * sandboxed iframe's navigation, so the attribute would bypass the
   * verified store. Other embeddings fail closed with `response`.
   */
  readonly frameSandbox?: "attribute" | "response";
}

export interface SandboxedWidgetExecutorOptions {
  /**
   * Embedding when the request names none. Production is hosted-only,
   * so the default is `hosted` (which fails closed without a frame
   * URL); the harness opts into `srcdoc`/`blob` explicitly for its
   * negative proofs.
   */
  readonly defaultEmbedding?: SandboxEmbedding;
  /** Seams for environments without blob URLs (jsdom). */
  readonly createObjectURL?: (document: string) => string;
  readonly revokeObjectURL?: (url: string) => void;
  /** Seam for instrumenting the per-attach channel in tests. */
  readonly createChannel?: () => MessageChannel;
}

/** The global a bundle assigns. Classic script, deterministic shape. */
export const SANDBOX_DEFINITION_GLOBAL = "__tilecastWidgetDefinition";

/**
 * Bundle slot in the server-generated frame template. widgetctl builds
 * `frame.gen.go` from `buildSandboxFrameDocument` over this token, and
 * the Server replaces its single occurrence with the escaped verified
 * bundle. The token must never appear in the bootstrap itself.
 */
export const SANDBOX_BUNDLE_PLACEHOLDER = "__TILECAST_SANDBOX_BUNDLE__";

/**
 * The frame document's own policy, delivered as a `<meta>` tag so it
 * applies however the bytes are embedded — navigated with response
 * headers, or embedded as a blob URL, which carries no headers.
 *
 * This meta policy is NOT the exfiltration barrier. The Widget's own
 * bytes choose it, and the scheme-wide `https:`/`http:` passive sources
 * below exist only because the serving host, not this static document,
 * knows the one media route a frame may load from (the Browser Player's
 * `/player/media/` path, Edge's loopback `/media/` route, or the native
 * `tcmedia:` scheme). Content-Security-Policies intersect, so each
 * host's frame response header, built from the shared contract in
 * `packages/player-contracts` (`responsePolicy`), narrows passive loads
 * to exactly that route. A host that serves a frame without such a
 * header is not secure for untrusted packages. Studio preview serves
 * this document with the broader policy because its media grants are
 * same-origin server URLs; see the threat model.
 */
export const SANDBOX_FRAME_META_POLICY =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: https: http: tcmedia:; " +
  "media-src data: https: http: tcmedia:; " +
  "font-src data: https: http: tcmedia:; " +
  "connect-src 'none'; worker-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none';";

/** Escape a bundle for inlining: no script block may break out. */
export function escapeInlineScript(javaScript: string): string {
  return javaScript.replace(/<\/script/gi, "<\\/script");
}

/**
 * The frame bootstrap. Kept dependency-free ES2017: it runs from a
 * template string, not from the SDK bundle (see the note above). Every
 * interpolated value is a frozen protocol constant except the fallback
 * hello token, which binds an inline document to its placement.
 *
 * Hosted documents interpolate no token: the parent appends its
 * per-attach token to the frame URL as a fragment, which never reaches
 * the server or the frame cache, and the bootstrap reads it back from
 * `location.hash`. Inline (`srcdoc`) documents have no URL to carry
 * one, so they fall back to the interpolated token.
 *
 * The bootstrap announces its document with a hello on the window bus,
 * then speaks only through the port the parent's `init` transfers. A
 * reloaded or navigated document holds no port, so it can neither
 * report nor receive: the connection dies with the original document.
 *
 * Input revisions mirror WidgetMount: every `init`/`update` carries
 * one, the frame assigns it to the element under the same `Symbol.for`
 * key SDK-built Widgets announce with, element events from an older
 * revision are dropped, and every report echoes the current revision
 * so the parent can drop a slow frame's stale report after an update.
 */
export function sandboxFrameBootstrap(interpolatedToken = ""): string {
  return `(function () {
  "use strict";
  var PROTOCOL = ${JSON.stringify(SANDBOX_BRIDGE_PROTOCOL)};
  var READY_EVENT = ${JSON.stringify(WIDGET_READY_EVENT)};
  var EMPTY_EVENT = ${JSON.stringify(WIDGET_EMPTY_EVENT)};
  var ERROR_EVENT = ${JSON.stringify(WIDGET_ERROR_EVENT)};
  var DEFINITION_GLOBAL = ${JSON.stringify(SANDBOX_DEFINITION_GLOBAL)};
  var INTERPOLATED_TOKEN = ${JSON.stringify(interpolatedToken)};
  var REVISION_KEY = "tilecast.widget.inputRevision";
  var nonce = null;
  var port = null;
  var revision = 0;
  var element = null;
  var definition = null;
  var resources = null;
  var frameContext = null;
  var disposed = false;

  function tokenFromFragment() {
    try {
      var hash = window.location.hash;
      if (typeof hash === "string" && hash.charAt(0) === "#") return hash.slice(1);
    } catch (err) {}
    return "";
  }
  var HELLO_TOKEN = tokenFromFragment() || INTERPOLATED_TOKEN;

  function post(state) {
    if (port === null || nonce === null || disposed) return;
    port.postMessage({ protocol: PROTOCOL, nonce: nonce, revision: revision, state: state });
  }
  function fail(code) { post({ state: "error", code: code }); }

  function validRevision(value) {
    return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 1;
  }

  function assignRevision(value) {
    revision = value;
    if (element === null) return;
    try {
      Object.defineProperty(element, Symbol.for(REVISION_KEY), { configurable: true, value: value });
    } catch (err) {}
  }

  function eventRevision(event) {
    var detail = event.detail;
    if (!detail || typeof detail.revision !== "number") return -1;
    return detail.revision;
  }

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
    element.addEventListener(READY_EVENT, function (event) {
      if (eventRevision(event) === revision) post({ state: "ready" });
    });
    element.addEventListener(EMPTY_EVENT, function (event) {
      if (eventRevision(event) !== revision) return;
      post({ state: "empty", reason: event.detail && event.detail.reason });
    });
    element.addEventListener(ERROR_EVENT, function (event) {
      if (eventRevision(event) !== revision) return;
      post({ state: "error", code: event.detail && event.detail.code });
    });
    assignRevision(revision);
    if (!applyInputs(snapshot.component, snapshot.component.version)) return;
    document.body.appendChild(element);
  }

  function onPortMessage(event) {
    var message = event.data;
    if (!message || message.protocol !== PROTOCOL) return;
    if (message.nonce !== nonce) return;
    if (disposed) return;
    if (message.kind === "update") {
      if (!validRevision(message.revision)) return;
      try {
        assignRevision(message.revision);
        resources = toResources(message.snapshot);
        frameContext = toContext(message.snapshot.context);
        var outcome = applyInputs(message.snapshot.component, message.snapshot.component.version);
        // The element reports its own boot; on update the frame also
        // reports the resolution outcome, tagged with the new revision.
        // A slow element's event for the previous input carries the old
        // revision and is dropped above.
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
  }

  // The window bus carries exactly one message per document: the init
  // that transfers the port. Everything after it travels the port.
  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || message.protocol !== PROTOCOL) return;
    if (message.kind !== "init") return;
    if (nonce !== null) return;
    if (typeof message.nonce !== "string" || message.nonce === "") return;
    if (!validRevision(message.revision)) return;
    var framePort = event.ports && event.ports[0];
    if (!framePort) return;
    nonce = message.nonce;
    revision = message.revision;
    port = framePort;
    port.onmessage = onPortMessage;
    try {
      boot(message.snapshot);
    } catch (err) {
      fail("frame_error");
    }
  });
  window.parent.postMessage({ protocol: PROTOCOL, kind: "frame-hello", helloToken: HELLO_TOKEN }, "*");
})();`;
}

/**
 * The complete frame document: bootstrap first, verified bundle second.
 * Inline documents interpolate the per-attach hello token as a fallback;
 * hosted/server documents interpolate none and read it from the frame
 * URL fragment the parent appends (see `withHelloFragment`), so one
 * cached document serves every attach.
 */
export function buildSandboxFrameDocument(
  bundleJavaScript: string,
  helloToken = "",
): string {
  // The policy meta tag leads the document so it governs the inline
  // bootstrap and bundle scripts that follow it.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SANDBOX_FRAME_META_POLICY}"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff;font:12px/1.4 monospace}</style></head><body><script>${sandboxFrameBootstrap(helloToken)}</script><script>${escapeInlineScript(bundleJavaScript)}</script></body></html>`;
}

/**
 * Bind one attach to its hosted frame document: the per-attach hello
 * token rides the URL fragment, so it is never part of the resource
 * request or the cached frame identity. Any existing fragment is
 * replaced. Native `tcwidget:` grant resolvers must likewise resolve
 * the capability with the fragment stripped.
 */
export function withHelloFragment(
  frameUrl: string,
  helloToken: string,
): string {
  const hash = frameUrl.indexOf("#");
  const base = hash === -1 ? frameUrl : frameUrl.slice(0, hash);
  return `${base}#${helloToken}`;
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
  private readonly createChannel: () => MessageChannel;

  constructor(options: SandboxedWidgetExecutorOptions = {}) {
    this.defaultEmbedding = options.defaultEmbedding ?? "hosted";
    this.createObjectURL =
      options.createObjectURL ??
      ((document: string) =>
        URL.createObjectURL(new Blob([document], { type: "text/html" })));
    this.revokeObjectURL =
      options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
    this.createChannel = options.createChannel ?? (() => new MessageChannel());
  }

  mount(
    container: HTMLElement,
    request: SandboxedWidgetRequest,
  ): WidgetExecution {
    return new SandboxedWidgetExecution(container, request, {
      defaultEmbedding: this.defaultEmbedding,
      createObjectURL: this.createObjectURL,
      revokeObjectURL: this.revokeObjectURL,
      createChannel: this.createChannel,
    });
  }
}

interface ExecutionOptions {
  defaultEmbedding: SandboxEmbedding;
  createObjectURL: (document: string) => string;
  revokeObjectURL: (url: string) => void;
  createChannel: () => MessageChannel;
}

class SandboxedWidgetExecution implements WidgetExecution {
  private current: WidgetMountState = { state: "pending" };
  private request: SandboxedWidgetRequest;
  private iframe: HTMLIFrameElement | null = null;
  private blobURL: string | null = null;
  private nonce = "";
  private helloToken = "";
  private revision = 0;
  private hosted = false;
  private handshake = false;
  private loadCount = 0;
  private channel: MessageChannel | null = null;
  private timer: { cancel(): void } | null = null;
  private disposed = false;
  private readonly onMessage: (event: MessageEvent) => void;
  private readonly onPortMessage: (event: MessageEvent) => void;
  private readonly container: HTMLElement;
  private readonly options: ExecutionOptions;

  constructor(
    container: HTMLElement,
    request: SandboxedWidgetRequest,
    options: ExecutionOptions,
  ) {
    this.container = container;
    this.options = options;
    this.request = request;
    this.onMessage = (event: MessageEvent) => this.handleMessage(event);
    this.onPortMessage = (event: MessageEvent) => this.handlePortMessage(event);
    window.addEventListener("message", this.onMessage);
    this.report({ state: "pending" });
    this.attach();
  }

  get state(): WidgetMountState {
    return this.current;
  }

  update(request: SandboxedWidgetRequest): void {
    if (this.disposed) return;
    const embedding = request.embedding ?? this.options.defaultEmbedding;
    const identityChanged =
      request.component.type !== this.request.component.type ||
      request.component.version !== this.request.component.version ||
      embedding !== (this.request.embedding ?? this.options.defaultEmbedding) ||
      (request.frameSandbox ?? "attribute") !==
        (this.request.frameSandbox ?? "attribute") ||
      (embedding === "hosted" && request.frameUrl !== this.request.frameUrl) ||
      (embedding !== "hosted" &&
        (request.bundle?.javaScript !== this.request.bundle?.javaScript ||
          request.frameDocument !== this.request.frameDocument));
    // The mount reports through its latest request; an update that omits
    // the optional callback keeps the previous one instead of going silent.
    this.request =
      request.onState === undefined && this.request.onState !== undefined
        ? { ...request, onState: this.request.onState }
        : request;
    if (!identityChanged && this.channel === null && this.handshake) {
      // The connection died and this update does not remount: the
      // placement stays failed instead of reporting a pending that can
      // never settle. A remount re-handshakes a fresh document.
      return;
    }
    if (identityChanged || this.iframe === null) {
      this.detach();
      this.report({ state: "pending" });
      this.attach();
      return;
    }
    // A new input revision: the frame assigns it before applying the
    // snapshot, and reports for any older revision are dropped.
    this.revision += 1;
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
    const embedding = this.request.embedding ?? this.options.defaultEmbedding;
    const hosted = embedding === "hosted";
    if (hosted) {
      if (
        typeof this.request.frameUrl !== "string" ||
        this.request.frameUrl === ""
      ) {
        this.settle({ state: "error", code: "frame_error" });
        return;
      }
    } else {
      if (this.request.frameSandbox === "response") {
        // Only a navigated response can carry the sandbox directive.
        this.settle({ state: "error", code: "frame_error" });
        return;
      }
      const inline = this.request.bundle?.javaScript;
      const document = this.request.frameDocument;
      // A blob may embed a complete verified frame document; srcdoc
      // cannot, because srcdoc documents have no fragment to carry the
      // per-attach token.
      const ok =
        (typeof inline === "string" && inline !== "") ||
        (embedding === "blob" &&
          typeof document === "string" &&
          document !== "");
      if (!ok) {
        this.settle({ state: "error", code: "frame_error" });
        return;
      }
    }
    this.nonce = createBridgeNonce();
    this.helloToken = createBridgeNonce();
    this.revision = 1;
    this.hosted = hosted;
    this.handshake = false;
    this.loadCount = 0;
    if (hosted) {
      try {
        // Validation only: the sandbox never grants allow-same-origin,
        // so the frame posts from the opaque origin "null" and the
        // hello token — not the frame origin — authenticates it.
        new URL(this.request.frameUrl!, window.location.href);
      } catch {
        this.settle({ state: "error", code: "frame_error" });
        return;
      }
    }
    const frame = document.createElement("iframe");
    // A response-sandboxed navigation goes bare so the serving worker
    // sees it; the response sandbox directive sandboxes the document.
    // Every other attach carries the attribute.
    if (!(hosted && this.request.frameSandbox === "response")) {
      frame.setAttribute("sandbox", SANDBOX_FRAME_TOKENS);
    }
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", "External widget");
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.border = "0";
    if (hosted) {
      // The token rides the fragment: the server never sees it and the
      // cached document stays identical across attaches.
      frame.src = withHelloFragment(this.request.frameUrl!, this.helloToken);
    } else if (
      embedding === "blob" &&
      typeof this.request.frameDocument === "string" &&
      this.request.frameDocument !== ""
    ) {
      // Verified bytes, embedded unchanged: the token rides the blob
      // URL fragment, exactly like hosted.
      this.blobURL = this.options.createObjectURL(this.request.frameDocument);
      frame.src = withHelloFragment(this.blobURL, this.helloToken);
    } else {
      // Validated above: every other inline embedding carries bundle
      // bytes, assembled here with the per-attach token interpolated.
      const documentText = buildSandboxFrameDocument(
        this.request.bundle!.javaScript,
        this.helloToken,
      );
      if (embedding === "blob") {
        this.blobURL = this.options.createObjectURL(documentText);
        frame.src = this.blobURL;
      } else {
        frame.srcdoc = documentText;
      }
    }
    const channel = this.options.createChannel();
    channel.port1.onmessage = this.onPortMessage;
    this.channel = channel;
    this.iframe = frame;
    this.container.appendChild(frame);
    // The initial navigation fires exactly one load. A second load means
    // the original document went away — reloaded or navigated — so the
    // connection dies with it. In particular, init is never reposted:
    // the replacement document must not receive the channel.
    frame.addEventListener("load", () => {
      if (this.disposed || this.iframe !== frame) return;
      this.loadCount += 1;
      if (this.loadCount > 1) this.connectionDied();
    });
    // No proactive init: the frame's hello answers when its bootstrap
    // runs, however asynchronously the document navigated. A frame that
    // never hellos trips the ready timeout below.
    try {
      // Fail fast on a host bug: an unserializable config or an
      // oversize snapshot errors the placement at mount instead of
      // waiting for a hello that can never be answered.
      assertBridgeMessageSize({
        protocol: SANDBOX_BRIDGE_PROTOCOL,
        nonce: this.nonce,
        kind: "init",
        revision: this.revision,
        snapshot: this.snapshot(this.request),
      });
    } catch {
      this.settle({ state: "error", code: "frame_error" });
      return;
    }
    this.armTimeout();
  }

  private detach(): void {
    this.timer?.cancel();
    this.timer = null;
    if (this.channel !== null) {
      this.channel.port1.onmessage = null;
      this.channel.port1.close();
      this.channel = null;
    }
    this.handshake = false;
    if (this.iframe !== null) {
      this.iframe.remove();
      this.iframe = null;
    }
    if (this.blobURL !== null) {
      this.options.revokeObjectURL(this.blobURL);
      this.blobURL = null;
    }
  }

  /**
   * The original document went away after the channel bound to it. Close
   * the host port and fail the placement: anything the replacement
   * document sends — over the window bus or a hello — is ignored from
   * here on, and nothing is ever sent to it.
   */
  private connectionDied(): void {
    if (this.channel !== null) {
      this.channel.port1.onmessage = null;
      this.channel.port1.close();
      this.channel = null;
    }
    // The handshake stays spent: a hello from the replacement document
    // must not mint a fresh channel for it.
    this.handshake = true;
    this.settle({ state: "error", code: "frame_error" });
  }

  private post(
    kind: ParentToFrameMessage["kind"],
    snapshot?: SandboxSnapshot,
  ): void {
    const channel = this.channel;
    // Before the handshake there is no document to address: the init
    // answers the hello with the latest snapshot, so early updates wait
    // for it instead of racing the navigation.
    if (channel === null || !this.handshake) return;
    const message: ParentToFrameMessage = {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: this.nonce,
      kind,
      revision: this.revision,
      ...(snapshot === undefined ? {} : { snapshot }),
    };
    assertBridgeMessageSize(message);
    channel.port1.postMessage(message);
  }

  /**
   * Answer the frame bootstrap's hello with `init` and the frame's port,
   * exactly once per attach. The hello must come from the placement's
   * own frame window, from the opaque origin `"null"` every sandboxed
   * frame posts as, with the exact protocol and the exact per-attach
   * token; anything else is dropped.
   */
  private handleMessage(event: MessageEvent): void {
    if (this.disposed || this.iframe === null || this.handshake) return;
    if (event.source === null || event.source !== this.iframe.contentWindow) {
      return;
    }
    if (event.origin !== "null") return;
    const hello = parseFrameHello(event.data);
    if (hello === null) return;
    if (hello.helloToken !== this.helloToken) return;
    this.handshake = true;
    const message: ParentToFrameMessage = {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: this.nonce,
      kind: "init",
      revision: this.revision,
      snapshot: this.snapshot(this.request),
    };
    try {
      assertBridgeMessageSize(message);
    } catch {
      // An unserializable config or an oversize snapshot is a host bug,
      // reported as a placement error rather than thrown.
      this.settle({ state: "error", code: "frame_error" });
      return;
    }
    const channel = this.channel;
    if (channel === null) {
      this.settle({ state: "error", code: "frame_error" });
      return;
    }
    // Every sandboxed frame runs opaque, and the platform only
    // delivers to an opaque target with "*": the hello checks above
    // already authenticated this single-shot transfer, and every later
    // message travels the transferred port instead.
    event.source.postMessage(message, "*", [channel.port2]);
  }

  private handlePortMessage(event: MessageEvent): void {
    if (this.disposed || this.channel === null || !this.handshake) return;
    const report = parseFrameReport(event.data, this.nonce, this.revision);
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
