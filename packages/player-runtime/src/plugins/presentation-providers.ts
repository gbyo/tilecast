/**
 * `player.presentation.provide@1`: the controlled seam for a plugin that can
 * supply presentation behavior for an external presentation.
 *
 * A provider is a declared, named contribution. The host decides when it
 * runs: only for an `external-presentation` that names the provider as
 * `<plugin id>/<provider id>`. The host also owns:
 *
 * - the container (a host-created element inside the content stage);
 * - visibility: the provider's container is shown only while it owns the
 *   screen, and the host's own surface returns the moment it does not;
 * - lifecycle: one session at a time, stopped when the presentation changes,
 *   the plugin is disposed, or the document ends;
 * - evidence: `presenting()` is the provider's claim of a first frame, and
 *   the host reports evidence only after that claim and a paint;
 * - recovery: a provider that throws, fails, or is withdrawn stops, the host
 *   shows its own surface again, and the failure is reported as an error.
 *
 * The provider never receives playback control, the stage, a host global, or
 * any other plugin's state. Nothing here names a plugin, a provider, or a
 * platform.
 */
import type {
  PresentationProvider,
  PresentationProviderInstance,
  PresentationProviderSession,
  PresentationProvideService,
} from "@tilecast/plugin-sdk/player";
import type { RuntimePresentation } from "../host/contract";
import type { PlayerServiceProvider, ServiceBindingContext } from "./services";

/** How the view hears about a provider's session. */
export interface ProviderHooks {
  /** A provider took the screen, or gave it back. */
  owned(owned: boolean): void;
  /** The provider showed a first frame. The view reports evidence. */
  presenting(): void;
  /** The provider stopped without being asked to. The view recovers. */
  failed(reason: string): void;
}

interface Registered {
  readonly key: string;
  readonly provider: PresentationProvider;
  readonly context: ServiceBindingContext;
}

interface Run {
  readonly key: string;
  readonly signature: string;
  readonly container: HTMLElement;
  readonly entry: Registered;
  instance: PresentationProviderInstance | null;
  presented: boolean;
  stopped: boolean;
}

interface Pending {
  readonly presentation: ExternalPresentation;
  readonly mount: HTMLElement;
  readonly hooks: ProviderHooks;
}

type ExternalPresentation = Extract<
  RuntimePresentation,
  { state: "external-presentation" }
>;

const MAX_PARAMETERS = 16;
const MAX_TEXT = 256;

/** Scalar members of the presentation, bounded, for the provider to read. */
function parametersOf(
  presentation: ExternalPresentation,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(presentation)) {
    if (name === "state" || name === "provider" || name === "sessionId")
      continue;
    if (Object.keys(out).length >= MAX_PARAMETERS) break;
    if (typeof value === "string") out[name] = value.slice(0, MAX_TEXT);
    else if (typeof value === "boolean") out[name] = value;
    else if (typeof value === "number" && Number.isFinite(value))
      out[name] = value;
  }
  return out;
}

export interface PresentationProvidersOptions {
  diagnostic(pluginId: string, message: string): void;
  document?: Document;
}

export class PresentationProviders {
  private readonly registered = new Map<string, Registered>();
  private run: Run | null = null;
  private pending: Pending | null = null;
  private lastHooks: ProviderHooks | null = null;

  constructor(private readonly options: PresentationProvidersOptions) {}

  /** The Player service plugins ask for. */
  provider(): PlayerServiceProvider<PresentationProvideService> {
    return {
      name: "player.presentation.provide",
      version: 1,
      bind: (context) => {
        const mine = new Set<string>();
        let live = true;
        return {
          api: {
            provide: (providerId, provider) => {
              if (!live) return null;
              if (
                !context.declaration.providers.includes(providerId) ||
                !provider ||
                typeof provider.start !== "function"
              ) {
                context.report(`provider ${providerId} is not declared`);
                return null;
              }
              const key = `${context.pluginId}/${providerId}`;
              if (this.registered.has(key)) return null;
              this.registered.set(key, { key, provider, context });
              mine.add(key);
              // A presentation that named this provider before it existed.
              queueMicrotask(() => this.adopt(key));
              return () => this.withdraw(key, mine);
            },
          },
          dispose: () => {
            live = false;
            for (const key of [...mine]) this.withdraw(key, mine);
          },
        };
      },
    };
  }

  /**
   * The view shows `presentation`. Returns true when a provider owns the
   * screen. The view calls this for every status presentation, so an
   * unrelated presentation ends any running session.
   */
  present(
    presentation: RuntimePresentation,
    mount: HTMLElement,
    hooks: ProviderHooks,
  ): boolean {
    this.lastHooks = hooks;
    if (
      presentation.state !== "external-presentation" ||
      typeof presentation.provider !== "string"
    ) {
      this.pending = null;
      this.stop(false);
      return false;
    }
    const key = presentation.provider;
    const signature = JSON.stringify([
      key,
      presentation.sessionId ?? null,
      parametersOf(presentation),
    ]);
    if (this.run && !this.run.stopped && this.run.signature === signature) {
      // The same session is presented again: keep it running, and let the
      // view report evidence for the new activation once it has presented.
      if (this.run.presented) hooks.presenting();
      return true;
    }
    this.stop(false);
    const entry = this.registered.get(key);
    if (!entry) {
      this.pending = { presentation, mount, hooks };
      return false;
    }
    this.pending = null;
    return this.start(entry, presentation, mount, hooks, signature);
  }

  /** The view no longer shows an external presentation. */
  clear(): void {
    this.pending = null;
    this.stop(false);
  }

  describe(): {
    registered: string[];
    active: string | null;
    presented: boolean;
  } {
    return {
      registered: [...this.registered.keys()].sort(),
      active: this.run && !this.run.stopped ? this.run.key : null,
      presented: this.run?.presented === true && !this.run.stopped,
    };
  }

  // ------------------------------------------------------------ lifecycle

  private start(
    entry: Registered,
    presentation: ExternalPresentation,
    mount: HTMLElement,
    hooks: ProviderHooks,
    signature: string,
  ): boolean {
    const document = this.options.document ?? mount.ownerDocument;
    const container = document.createElement("div");
    container.className = "tc-provider-session";
    mount.append(container);
    const run: Run = {
      key: entry.key,
      signature,
      container,
      entry,
      instance: null,
      presented: false,
      stopped: false,
    };
    this.run = run;
    const session: PresentationProviderSession = {
      container,
      sessionId: presentation.sessionId ?? null,
      parameters: Object.freeze(parametersOf(presentation)),
      presenting: () => {
        if (run.stopped || run.presented) return;
        run.presented = true;
        hooks.presenting();
      },
      fail: (reason) => {
        if (run.stopped) return;
        this.finish(run, hooks, String(reason).slice(0, 240) || "failed");
      },
    };
    hooks.owned(true);
    // A throw fails the plugin through the guard, which disposes its
    // bindings; that withdraws this provider and recovers the screen.
    entry.context.guard(() => {
      run.instance = entry.provider.start(session) ?? {};
    });
    return !run.stopped;
  }

  private adopt(key: string): void {
    const pending = this.pending;
    const entry = this.registered.get(key);
    if (
      !pending ||
      !entry ||
      pending.presentation.provider !== key ||
      (this.run && !this.run.stopped)
    )
      return;
    this.pending = null;
    const signature = JSON.stringify([
      key,
      pending.presentation.sessionId ?? null,
      parametersOf(pending.presentation),
    ]);
    this.start(
      entry,
      pending.presentation,
      pending.mount,
      pending.hooks,
      signature,
    );
  }

  private withdraw(key: string, mine: Set<string>): void {
    mine.delete(key);
    if (!this.registered.delete(key)) return;
    const run = this.run;
    if (run && !run.stopped && run.key === key) {
      this.finish(run, this.lastHooks, "the provider is no longer available");
    }
  }

  /** Stop the current session because the host asked. No failure report. */
  private stop(report: boolean): void {
    const run = this.run;
    if (run && !run.stopped) this.finish(run, report ? this.lastHooks : null);
  }

  /**
   * End a session. With `reason` and hooks it is a failure the view recovers
   * from; otherwise the host ended it.
   */
  private finish(run: Run, hooks: ProviderHooks | null, reason?: string): void {
    if (run.stopped) return;
    run.stopped = true;
    try {
      run.instance?.stop?.();
    } catch (error) {
      run.entry.context.report(
        `provider ${run.key} stop failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    run.container.remove();
    if (this.run === run) this.run = null;
    if (hooks) {
      hooks.owned(false);
      if (reason !== undefined) hooks.failed(reason);
    }
  }
}
