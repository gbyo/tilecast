/**
 * WidgetMount: the one way any host puts a Widget on screen.
 *
 * The Player Runtime uses it for fullscreen Widgets and for Layout zones;
 * Studio and Storybook use it for previews. It looks up the definition,
 * validates configuration, resolves prepared resources, creates the
 * element, assigns typed properties, supplies context, and turns the
 * element's lifecycle events into one bounded state. It never reports
 * evidence: the host decides what a state means.
 */
import type { WidgetContext, WidgetTimer } from "./context.ts";
import type {
  AnyWidgetDefinition,
  WidgetElement,
  WidgetRegistry,
} from "./definition.ts";
import {
  setWidgetInputRevision,
  WIDGET_EMPTY_EVENT,
  WIDGET_ERROR_EVENT,
  WIDGET_READY_EVENT,
} from "./events.ts";
import { boundedCode } from "./identity.ts";
import type { WidgetResources } from "./resources.ts";

/** The component reference a presentation carries. */
export interface WidgetComponentRef {
  readonly type: string;
  readonly version: number;
  readonly config: unknown;
}

export type WidgetMountState =
  | { readonly state: "pending" }
  | { readonly state: "ready" }
  | { readonly state: "empty"; readonly reason: string }
  | { readonly state: "error"; readonly code: string };

export interface WidgetMountOptions {
  readonly registry: WidgetRegistry;
  /** The element the Widget fills. The mount owns only its own child. */
  readonly container: HTMLElement;
  readonly component: WidgetComponentRef;
  readonly resources: WidgetResources;
  readonly context: WidgetContext;
  /** Called on every state change, never twice for the same state. */
  readonly onState?: (state: WidgetMountState) => void;
  /**
   * Refuse to mount when the engine cannot adopt constructed stylesheets.
   * The Player Runtime sets this: its CSP refuses the `<style>` fallback,
   * so a Widget would render unstyled instead of failing visibly.
   */
  readonly requireAdoptedStyleSheets?: boolean;
  /** Clock time a Widget has to announce its first state. */
  readonly readyTimeoutMs?: number;
}

export const DEFAULT_READY_TIMEOUT_MS = 10_000;

export function supportsAdoptedStyleSheets(): boolean {
  return (
    typeof Document !== "undefined" &&
    typeof ShadowRoot !== "undefined" &&
    typeof CSSStyleSheet !== "undefined" &&
    "adoptedStyleSheets" in Document.prototype &&
    "adoptedStyleSheets" in ShadowRoot.prototype &&
    "replaceSync" in CSSStyleSheet.prototype
  );
}

function sameState(a: WidgetMountState, b: WidgetMountState): boolean {
  if (a.state !== b.state) return false;
  if (a.state === "empty" && b.state === "empty") return a.reason === b.reason;
  if (a.state === "error" && b.state === "error") return a.code === b.code;
  return true;
}

export class WidgetMount {
  private current: WidgetMountState = { state: "pending" };
  private definition: AnyWidgetDefinition | null = null;
  private node: WidgetElement<unknown, unknown> | null = null;
  private timer: WidgetTimer | null = null;
  private component: WidgetComponentRef;
  private resources: WidgetResources;
  private context: WidgetContext;
  private disposed = false;
  private generation = 0;

  private readonly onReady = (event: Event) =>
    this.settleEvent(event, { state: "ready" });
  private readonly onEmpty = (event: Event) =>
    this.settleEvent(event, {
      state: "empty",
      reason: boundedCode(
        (event as CustomEvent<{ reason?: unknown }>).detail?.reason,
        "no_content",
      ),
    });
  private readonly onError = (event: Event) =>
    this.settleEvent(event, {
      state: "error",
      code: boundedCode(
        (event as CustomEvent<{ code?: unknown }>).detail?.code,
        "widget_error",
      ),
    });

  constructor(private readonly options: WidgetMountOptions) {
    this.component = options.component;
    this.resources = options.resources;
    this.context = options.context;
    this.mount(this.beginRevision());
  }

  get state(): WidgetMountState {
    return this.current;
  }

  /** The mounted element, for hosts that inspect it (probes, previews). */
  get element(): HTMLElement | null {
    return this.node;
  }

  /**
   * New inputs for the same placement. A different component type or
   * version remounts; anything else updates the element in place so its
   * controllers and animations survive.
   */
  update(next: {
    component?: WidgetComponentRef;
    resources?: WidgetResources;
    context?: WidgetContext;
  }): void {
    if (this.disposed) return;
    const revision = this.beginRevision();
    const component = next.component ?? this.component;
    const remount =
      component.type !== this.component.type ||
      component.version !== this.component.version ||
      !this.node;
    this.component = component;
    this.resources = next.resources ?? this.resources;
    this.context = next.context ?? this.context;
    if (remount) {
      this.teardownElement();
      this.mount(revision);
      return;
    }
    this.assign(revision);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardownElement();
  }

  private mount(revision: number): void {
    const { registry, container } = this.options;
    const definition = registry.lookup(
      this.component.type,
      this.component.version,
    );
    if (!definition) return this.settle(error("widget_unsupported"), revision);
    if (
      this.options.requireAdoptedStyleSheets &&
      !supportsAdoptedStyleSheets()
    ) {
      return this.settle(error("widget_styles_unsupported"), revision);
    }
    const defined = customElements.get(definition.tagName);
    if (defined && defined !== definition.element) {
      return this.settle(error("widget_tag_conflict"), revision);
    }
    if (!defined) customElements.define(definition.tagName, definition.element);
    this.definition = definition;
    const node = document.createElement(definition.tagName) as WidgetElement<
      unknown,
      unknown
    >;
    // Diagnostics (the runtime probe, previews) find mounted Widgets by it.
    node.setAttribute("data-tilecast-widget", definition.type);
    node.style.setProperty("display", "block");
    node.style.setProperty("width", "100%");
    node.style.setProperty("height", "100%");
    node.addEventListener(WIDGET_READY_EVENT, this.onReady);
    node.addEventListener(WIDGET_EMPTY_EVENT, this.onEmpty);
    node.addEventListener(WIDGET_ERROR_EVENT, this.onError);
    this.node = node;
    setWidgetInputRevision(node, revision);
    if (!this.assign(revision)) return;
    container.appendChild(node);
  }

  /** Validate, resolve and assign. Returns false when the mount failed. */
  private assign(revision: number): boolean {
    const definition = this.definition!;
    const node = this.node!;
    let parsed;
    try {
      parsed = definition.parseConfig(
        this.component.config,
        this.component.version,
      );
    } catch {
      parsed = { ok: false as const, problem: "parseConfig threw" };
    }
    if (!parsed.ok) {
      this.teardownElement();
      this.settle(error("widget_config_invalid"), revision);
      return false;
    }
    let resolution;
    try {
      resolution = definition.resolveData(parsed.config, this.resources);
    } catch {
      resolution = { state: "error" as const, code: "widget_resolve_failed" };
    }
    if (resolution.state === "error") {
      this.teardownElement();
      this.settle(
        error(boundedCode(resolution.code, "widget_error")),
        revision,
      );
      return false;
    }
    node.context = this.context;
    node.config = parsed.config;
    node.data = resolution.state === "ready" ? resolution.data : null;
    node.empty =
      resolution.state === "empty"
        ? boundedCode(resolution.reason, "no_content")
        : null;
    this.armTimeout(revision);
    return true;
  }

  private armTimeout(revision: number): void {
    this.timer?.cancel();
    if (revision !== this.generation || this.current.state !== "pending")
      return;
    this.timer = this.context.clock.after(
      this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      () => {
        this.timer = null;
        if (revision === this.generation && this.current.state === "pending") {
          this.settle(error("widget_ready_timeout"), revision);
        }
      },
    );
  }

  private beginRevision(): number {
    const revision = ++this.generation;
    this.timer?.cancel();
    this.timer = null;
    if (this.node) setWidgetInputRevision(this.node, revision);
    this.settle({ state: "pending" }, revision);
    return revision;
  }

  private settleEvent(event: Event, next: WidgetMountState): void {
    const revision = (event as CustomEvent<{ revision?: unknown }>).detail
      ?.revision;
    if (!Number.isSafeInteger(revision) || revision !== this.generation) return;
    this.settle(next, revision);
  }

  private settle(next: WidgetMountState, revision?: number): void {
    if (this.disposed) return;
    if (revision !== undefined && revision !== this.generation) return;
    if (next.state !== "pending") {
      this.timer?.cancel();
      this.timer = null;
    }
    if (sameState(this.current, next)) return;
    this.current = next;
    this.options.onState?.(next);
  }

  private teardownElement(): void {
    this.timer?.cancel();
    this.timer = null;
    const node = this.node;
    this.node = null;
    this.definition = null;
    if (!node) return;
    node.removeEventListener(WIDGET_READY_EVENT, this.onReady);
    node.removeEventListener(WIDGET_EMPTY_EVENT, this.onEmpty);
    node.removeEventListener(WIDGET_ERROR_EVENT, this.onError);
    // Disconnecting runs the element's controllers' hostDisconnected, which
    // cancels their clock timers and observers.
    node.remove();
  }
}

const error = (code: string): WidgetMountState => ({ state: "error", code });
