/**
 * Tilecast-owned full-screen surfaces: setup, pairing, idle and error states,
 * safe mode, the AirPlay ready page, and "bridge unavailable". Declarative;
 * the view decides nothing about playback.
 */
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { cssProps } from "./css-props";
import type {
  DiscoveredServerV1,
  RuntimePresentation,
  SetupResultV1,
} from "../host/contract";

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface SetupBridge {
  submit(url: string): Promise<SetupResultV1>;
  /** Servers already known; later ones arrive through `servers`. */
  available: boolean;
}

export class StatusSurface extends LitElement {
  static override properties = {
    presentation: { attribute: false },
    problem: { attribute: false },
    servers: { attribute: false },
    setup: { attribute: false },
    setupError: { state: true },
  };

  declare presentation: RuntimePresentation | null;
  /** A reason the runtime could not start; shown instead of anything else. */
  declare problem: string | null;
  declare servers: DiscoveredServerV1[];
  declare setup: SetupBridge | null;
  declare setupError: string;

  constructor() {
    super();
    this.presentation = null;
    this.problem = null;
    this.servers = [];
    this.setup = null;
    this.setupError = "";
  }

  // Light DOM: the display is one document and ordinary CSS applies.
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /** Whether this surface currently covers the playback layers. */
  get visible(): boolean {
    if (this.problem) return true;
    const state = this.presentation?.state;
    return state !== undefined && state !== "playing";
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("presentation") && this.presentation?.state === "setup") {
      this.querySelector<HTMLInputElement>("#setup-input")?.focus();
    }
    if (changed.has("presentation")) this.setupError = "";
  }

  override render() {
    const surface = this.surface();
    return html`<div
      id="message"
      class=${classMap({ visible: this.visible })}
      style=${cssProps(surface.style)}
      role=${surface.role ?? nothing}
    >
      ${surface.content}
    </div>`;
  }

  private surface(): {
    content: unknown;
    style: Record<string, string>;
    role?: string;
  } {
    const none = { style: {} as Record<string, string> };
    if (this.problem) {
      return {
        ...none,
        role: "alert",
        content: html`<h1>Display bridge unavailable</h1>
          <p>
            The player UI could not connect to the runtime. The device will keep
            trying; if this persists, check the player logs.
          </p>`,
      };
    }
    const p = this.presentation;
    if (!p) return { ...none, content: nothing };
    switch (p.state) {
      case "setup":
        return { ...none, content: this.renderSetup() };
      case "pairing":
        return {
          ...none,
          content: html`<img
              class="brand-logo"
              src="tilecast-logo-white.svg"
              alt="Tilecast"
            />
            <h1>${p.organizationName ?? "Tilecast"}</h1>
            <p>Approve this screen in Tilecast Studio with the code below.</p>
            <div class="code">${p.code ?? ""}</div>
            <p>${p.approvalUrl ?? ""}</p>`,
        };
      case "idle":
      case "disabled":
      case "unavailable": {
        const background = HEX.test(p.backgroundColor ?? "")
          ? p.backgroundColor!
          : "#0E141B";
        const color = HEX.test(p.textColor ?? "") ? p.textColor! : "#F5F7FA";
        return {
          style: { background, color },
          content: html`<div class="branded-fallback">
            ${
              p.logoSrc
                ? html`<img
                    class="branded-fallback__logo"
                    src=${p.logoSrc}
                    alt=""
                  />`
                : nothing
            }
            <h1>${p.title ?? ""}</h1>
            <p>${p.message ?? ""}</p>
            ${
              p.status
                ? html`<p class="branded-fallback__status">
                    ${p.status.replaceAll("_", " ")}
                  </p>`
                : nothing
            }
            ${
              p.footerText
                ? html`<p class="branded-fallback__footer">${p.footerText}</p>`
                : nothing
            }
          </div>`,
        };
      }
      case "safe-mode":
        return {
          ...none,
          content: html`<h1>Safe mode</h1>
            <p>${p.reason ?? ""}</p>
            <p>
              The player remains connected and accepts commands from Tilecast
              Studio.
            </p>`,
        };
      case "sleep":
        // Outside active hours: true black; the overlay draws any display.
        return { ...none, content: nothing };
      case "external-presentation":
        return { ...none, content: this.renderExternal(p) };
      default:
        return { ...none, content: nothing };
    }
  }

  private renderSetup() {
    const submit = (url: string) => {
      if (!this.setup?.available) {
        this.setupError = "Setup is not available on this display.";
        return;
      }
      void this.setup.submit(url).then(
        (result) => {
          if (!result.ok) this.setupError = result.error ?? "Invalid address";
        },
        () => {
          this.setupError = "The player is not reachable.";
        },
      );
    };
    return html`<img
        class="brand-logo"
        src="tilecast-logo-white.svg"
        alt="Tilecast"
      />
      <p>Choose your Tilecast server, or enter its address.</p>
      <div id="discovered">
        ${this.servers.map(
          (server) =>
            html`<button
              class="setup-server"
              type="button"
              @click=${() => submit(server.serverUrl)}
            >
              ${server.name} — ${server.serverUrl}
            </button>`,
        )}
      </div>
      <input
        id="setup-input"
        type="url"
        placeholder="https://signage.example.org"
        autofocus
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter") {
            submit((event.target as HTMLInputElement).value);
          }
        }}
      />
      <div id="setup-error" role="status">${this.setupError}</div>`;
  }

  private renderExternal(
    p: Extract<RuntimePresentation, { state: "external-presentation" }>,
  ) {
    // Once connected, the external receiver owns the screen: nothing of ours
    // may cover it.
    if (p.connected) return nothing;
    const receiver = p.receiverName ?? "Tilecast AirPlay";
    // Deliberately generic copy: neither the network's name, its SSID, nor
    // anything resembling a credential belongs on a screen a room can see.
    if (p.presentationNetwork === "joining") {
      return html`<h1>Preparing to Present</h1>
        <h2>${receiver}</h2>
        <p>Connecting to the presentation network…</p>
        <p>This display will appear in Screen Mirroring shortly.</p>`;
    }
    if (p.presentationNetwork === "failed") {
      return html`<h1>Cannot Present</h1>
        <h2>${receiver}</h2>
        <p>This display could not join the presentation network.</p>
        <p>
          Ask an administrator to check Presentation Networks in Tilecast
          Studio.
        </p>`;
    }
    const expires = p.expiresAt
      ? new Date(p.expiresAt).toLocaleString()
      : "the scheduled end time";
    return html`<h1>Ready to Present</h1>
      <h2>${receiver}</h2>
      <div class="code">${p.pin ?? ""}</div>
      <p>
        On iPhone, iPad, or Mac, choose Screen Mirroring and select this
        receiver.
      </p>
      <p>Available until ${expires}.</p>
      <p>Waiting for a presenter…</p>`;
  }
}

customElements.define("tc-status-surface", StatusSurface);
