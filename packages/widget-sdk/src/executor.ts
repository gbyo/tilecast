/**
 * WidgetExecutor: the one way any host runs a Widget, trusted or external.
 *
 * Docs/content-extension-model.md §12 defines the two security classes.
 * A trusted Widget is compiled into the release and mounts directly into
 * the host document through the shared WidgetMount. An external Widget
 * arrives as verified bytes in an installed package and must never be
 * imported into a trusted document; it runs in a sandboxed browsing
 * context behind the narrow bridge in `./sandbox-bridge.ts`.
 *
 * Both executors take the same request and report the same bounded
 * WidgetMountState, so the Player Runtime and Studio previews share one
 * execution contract and one set of lifecycle semantics.
 */
import type { WidgetContext } from "./context.ts";
import type { WidgetRegistry } from "./definition.ts";
import {
  DEFAULT_READY_TIMEOUT_MS,
  WidgetMount,
  type WidgetComponentRef,
  type WidgetMountState,
} from "./mount.ts";
import type { WidgetResources } from "./resources.ts";

/** Everything an executor needs to mount one Widget placement. */
export interface WidgetExecutionRequest {
  readonly component: WidgetComponentRef;
  readonly resources: WidgetResources;
  readonly context: WidgetContext;
  /** Called on every state change, never twice for the same state. */
  readonly onState?: (state: WidgetMountState) => void;
  /** Clock time a Widget has to announce its first state. */
  readonly readyTimeoutMs?: number;
}

/** One live placement. The executor owns everything it created for it. */
export interface WidgetExecution {
  readonly state: WidgetMountState;
  /**
   * New inputs for the same placement. A different component type or
   * version remounts; anything else updates in place.
   */
  update(request: WidgetExecutionRequest): void;
  dispose(): void;
}

export interface WidgetExecutor {
  /**
   * Run the request, filling `container`. The executor owns only what it
   * appends to the container.
   */
  mount(
    container: HTMLElement,
    request: WidgetExecutionRequest,
  ): WidgetExecution;
}

export interface TrustedWidgetExecutorOptions {
  readonly registry: WidgetRegistry;
  /**
   * Refuse to mount when the engine cannot adopt constructed stylesheets.
   * The Player Runtime sets this: its CSP refuses the `<style>` fallback,
   * so a Widget would render unstyled instead of failing visibly.
   */
  readonly requireAdoptedStyleSheets?: boolean;
}

/** Trusted execution: a WidgetMount over the release's own registry. */
export class TrustedWidgetExecutor implements WidgetExecutor {
  constructor(private readonly options: TrustedWidgetExecutorOptions) {}

  mount(
    container: HTMLElement,
    request: WidgetExecutionRequest,
  ): WidgetExecution {
    return new TrustedWidgetExecution(container, request, this.options);
  }
}

class TrustedWidgetExecution implements WidgetExecution {
  private readonly mount: WidgetMount;

  constructor(
    container: HTMLElement,
    request: WidgetExecutionRequest,
    options: TrustedWidgetExecutorOptions,
  ) {
    this.mount = new WidgetMount({
      registry: options.registry,
      container,
      component: request.component,
      resources: request.resources,
      context: request.context,
      onState: request.onState,
      requireAdoptedStyleSheets: options.requireAdoptedStyleSheets,
      readyTimeoutMs: request.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    });
  }

  get state(): WidgetMountState {
    return this.mount.state;
  }

  update(request: WidgetExecutionRequest): void {
    this.mount.update({
      component: request.component,
      resources: request.resources,
      context: request.context,
    });
  }

  dispose(): void {
    this.mount.dispose();
  }
}
