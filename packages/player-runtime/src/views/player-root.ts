/**
 * <tc-player>: the root of the trusted display document.
 *
 * It renders the document's fixed structure once and binds the declarative
 * surfaces to the engine's view state. The two playback layers carry no Lit
 * bindings at all: the Stage owns their contents and their `visible` class, so
 * a render here can never disturb media that is playing.
 */
import { LitElement, html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import type {
  DiscoveredServerV1,
  RuntimeCapabilitiesV1,
  RuntimePresentation,
} from "../host/contract";
import type { RuntimeClock } from "../clock/scheduler";
import type { RemoteWebPort } from "../remote-web/port";
import type {
  PlaybackController,
  RuntimeViewState,
} from "../engine/controller";
import type { RuntimeSurfaceHost } from "../plugins/host";
import type { PresentationProviders } from "../plugins/presentation-providers";
import type { RuntimeWidgetHost } from "../widgets/host";
import { Stage } from "../surfaces/stage";
import type { SetupBridge, StatusSurface } from "./status-surface";
import "./outside-hours";
import "./status-surface";

export interface PlayerRootBindings {
  controller: PlaybackController;
  /** Runtime plugin surfaces. Their layer is host-owned DOM. */
  surfaces: RuntimeSurfaceHost;
  clock: RuntimeClock;
  capabilities: RuntimeCapabilitiesV1;
  setup: SetupBridge;
  animationScale: number;
  /** Present when the host advertises `remoteWeb: "host-view"`. */
  remoteWeb: RemoteWebPort | null;
  widgets: RuntimeWidgetHost;
  /** Plugin API v2 presentation providers, when the plugin host runs. */
  providers?: PresentationProviders;
}

type Sleep = Extract<RuntimePresentation, { state: "sleep" }>;

const afterPaint = (callback: () => void) =>
  requestAnimationFrame(() => requestAnimationFrame(callback));

export class PlayerRoot extends LitElement {
  static override properties = {
    status: { state: true },
    sleep: { state: true },
    problem: { state: true },
    servers: { state: true },
    identifyName: { state: true },
    providerOwned: { state: true },
  };

  declare status: RuntimePresentation | null;
  declare sleep: Sleep | null;
  declare problem: string | null;
  declare servers: DiscoveredServerV1[];
  declare identifyName: string | null;
  /** A presentation provider holds the screen instead of the status surface. */
  declare providerOwned: boolean;

  private bindings: PlayerRootBindings | null = null;
  private stage: Stage | null = null;
  private identifyTimer: { cancel(): void } | null = null;
  private unsubscribers: (() => void)[] = [];

  constructor() {
    super();
    this.status = null;
    this.sleep = null;
    this.problem = null;
    this.servers = [];
    this.identifyName = null;
    this.providerOwned = false;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /** Connect to the engine. Called once by the runtime entry point. */
  bind(bindings: PlayerRootBindings): void {
    this.bindings = bindings;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const layerA = this.querySelector<HTMLDivElement>("#layer-a")!;
      const layerB = this.querySelector<HTMLDivElement>("#layer-b")!;
      this.stage = new Stage(layerA, layerB, {
        clock: bindings.clock,
        capabilities: bindings.capabilities,
        send: (event) => bindings.controller.surface(event),
        animationScale: bindings.animationScale,
        remoteWeb: bindings.remoteWeb,
        widgets: bindings.widgets,
        diagnostics: bindings.controller.diagnostics,
      });
      this.unsubscribers.push(
        bindings.controller.subscribe((view) => this.onView(view)),
        bindings.controller.onSyncPosition((position) =>
          this.stage?.correct(position),
        ),
      );
    });
  }

  showProblem(reason: string): void {
    this.problem = reason;
  }

  addServer(server: DiscoveredServerV1): void {
    if (this.servers.some((known) => known.serverUrl === server.serverUrl)) {
      return;
    }
    this.servers = [...this.servers, server];
  }

  identify(name: string, durationSeconds: number): void {
    const clock = this.bindings?.clock;
    this.identifyName = name;
    this.identifyTimer?.cancel();
    if (!clock) return;
    this.identifyTimer = clock.at(
      clock.monotonicNow() + Math.max(0, durationSeconds) * 1_000,
      () => (this.identifyName = null),
    );
  }

  /** Mounted state for diagnostics and the conformance probe. */
  describeStage(): Record<string, unknown> | null {
    return this.stage?.describe() ?? null;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  override render() {
    const b = this.bindings;
    return html`
      <div id="content-stage">
        <div id="layer-a" class="layer"></div>
        <div id="layer-b" class="layer"></div>
        <div
          id="provider-stage"
          class=${classMap({ visible: this.providerOwned })}
        ></div>
        <tc-status-surface
          .presentation=${this.status}
          .problem=${this.problem}
          .servers=${this.servers}
          .setup=${b?.setup ?? null}
          .suppressed=${this.providerOwned}
        ></tc-status-surface>
      </div>
      ${b?.surfaces.element ?? nothing}
      <div
        id="identify"
        class=${classMap({ visible: this.identifyName !== null })}
      >
        ${this.identifyName ?? ""}
      </div>
      <tc-outside-hours
        .presentation=${this.sleep}
        .logo=${b?.capabilities.outsideHoursLogo}
      ></tc-outside-hours>
    `;
  }

  private onView(view: RuntimeViewState): void {
    const controller = this.bindings!.controller;
    switch (view.mode) {
      case "waiting":
        return;
      case "status":
      case "sleep": {
        // A Tilecast surface takes the screen: no media keeps decoding
        // underneath it.
        this.stage?.clear();
        this.status = view.presentation;
        this.sleep = view.mode === "sleep" ? view.presentation : null;
        const key = view.key;
        const painted = () =>
          void this.updateComplete.then(() =>
            afterPaint(() => controller.statusPainted(key)),
          );
        const providers = this.bindings!.providers;
        const stage = this.querySelector<HTMLElement>("#provider-stage");
        // The host decides who owns the screen. A provider that holds it
        // reports its own first frame; otherwise the status surface paints.
        const owned =
          providers && stage
            ? providers.present(view.presentation, stage, {
                owned: (value) => {
                  this.providerOwned = value;
                },
                presenting: painted,
                failed: (reason) => {
                  controller.reportProviderFailure(reason);
                  painted();
                },
              })
            : false;
        this.providerOwned = owned;
        if (!owned) painted();
        return;
      }
      case "playing":
        this.bindings!.providers?.clear();
        this.providerOwned = false;
        if (this.status?.state !== "playing") {
          this.status = { state: "playing", items: [], generation: 0 };
        }
        this.sleep = null;
        this.stage?.update(view.stage);
        return;
    }
  }
}

customElements.define("tc-player", PlayerRoot);

export type { StatusSurface };
