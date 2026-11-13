/**
 * Tilecast-owned full-screen surfaces: setup, pairing, idle and error states,
 * safe mode, the AirPlay ready page, and "bridge unavailable". Declarative;
 * the view decides nothing about playback.
 */
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { cssProps } from "./css-props";
import { pairingQrDataUri } from "./pairing-qr";
import type {
  DiscoveredServerV1,
  PhoneSetupStateV1,
  RuntimePresentation,
  SetupResultV1,
} from "../host/contract";

const HEX = /^#[0-9a-fA-F]{6}$/;
const SOURCE_ID = /^[0-9a-f]{64}$/;

export interface SetupBridge {
  submit(url: string): Promise<SetupResultV1>;
  /** Servers already known; later ones arrive through `servers`. */
  available: boolean;
  /** Present when the host can start a paused phone setup session. */
  resumePhoneSetup?: () => void;
}

export class StatusSurface extends LitElement {
  static override properties = {
    presentation: { attribute: false },
    problem: { attribute: false },
    servers: { attribute: false },
    setup: { attribute: false },
    presentVideo: { attribute: false },
    setupError: { state: true },
    videoFailed: { state: true },
    suppressed: { attribute: false },
  };

  declare presentation: RuntimePresentation | null;
  /** A reason the runtime could not start; shown instead of anything else. */
  declare problem: string | null;
  declare servers: DiscoveredServerV1[];
  declare setup: SetupBridge | null;
  declare setupError: string;
  /**
   * A presentation provider owns the screen, so this surface draws nothing.
   * The view sets it; the provider never touches this element.
   */
  declare suppressed: boolean;
  /**
   * The host relays AirPlay streams (`capabilities.externalPresentationVideo`).
   * The view decides from this capability, never from the host's name.
   */
  declare presentVideo: boolean;
  /**
   * The source ID whose stream the `<video>` could not open (the host's relay
   * is gone or never started). The ready page replaces it, also while a
   * sender is connected, so the screen never stays blank without a reason.
   */
  declare videoFailed: string | undefined;

  constructor() {
    super();
    this.presentation = null;
    this.problem = null;
    this.servers = [];
    this.setup = null;
    this.setupError = "";
    this.suppressed = false;
    this.presentVideo = false;
    this.videoFailed = undefined;
  }

  // Light DOM: the display is one document and ordinary CSS applies.
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  /** Whether this surface currently covers the playback layers. */
  get visible(): boolean {
    if (this.suppressed && !this.problem) return false;
    if (this.problem) return true;
    const state = this.presentation?.state;
    return state !== undefined && state !== "playing";
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("presentation") && this.presentation?.state === "setup") {
      this.querySelector<HTMLInputElement>("#setup-input")?.focus();
    }
    if (changed.has("presentation")) this.setupError = "";
    // A failure belongs to one session's source.
    if (this.videoFailed !== undefined) {
      const p = this.presentation;
      if (
        p?.state !== "external-presentation" ||
        p.sourceId !== this.videoFailed
      ) {
        this.videoFailed = undefined;
      }
    }
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
        return { ...none, content: this.renderSetup(p.phoneSetup) };
      case "pairing": {
        // Grouped for viewing distance, as the Android player shows it.
        // The raw approval URL never displays: the code and the QR carry it.
        const code = p.code ?? "";
        const grouped =
          code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
        const qr = pairingQrDataUri(p.approvalUrl ?? "");
        return {
          ...none,
          content: html`<div class="pairing">
            <img
              class="brand-logo"
              src="tilecast-logo-white.svg"
              alt="Tilecast"
            />
            <p class="pairing__org">${p.organizationName ?? "Tilecast"}</p>
            <h1>Pair this screen</h1>
            <div class="pairing__body">
              <div class="pairing__code-block">
                <div class="code" aria-label=${code}>${grouped}</div>
                <p>
                  Enter this code in Tilecast Studio<br />or scan the QR code
                </p>
              </div>
              ${
                qr
                  ? html`<img
                      class="pairing__qr"
                      src=${qr}
                      alt="QR code: scan to approve this screen in Tilecast Studio"
                    />`
                  : nothing
              }
            </div>
            <p class="pairing__waiting">Waiting for approval…</p>
          </div>`,
        };
      }
      case "idle":
      case "disabled":
      case "unavailable": {
        const background = HEX.test(p.backgroundColor ?? "")
          ? p.backgroundColor!
          : "#0E141B";
        const color = HEX.test(p.textColor ?? "") ? p.textColor! : "#F5F7FA";
        return {
          style: { background, color },
          // `status` is a machine reason code for hosts and diagnostics. It is
          // exposed as an attribute and never drawn: a room can see this screen.
          content: html`<div
            class="branded-fallback"
            data-status=${p.status ?? nothing}
          >
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
            ${p.message ? html`<p>${p.message}</p>` : nothing}
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

  private renderPhoneSetup(phone: PhoneSetupStateV1 | undefined) {
    if (phone?.state === "ready") {
      const qr = pairingQrDataUri(phone.url ?? "");
      if (!qr) return nothing;
      return html`<div class="phone-setup">
        <img
          class="phone-setup__qr"
          src=${qr}
          alt="QR code: scan with your phone to set up this screen"
        />
        <div class="phone-setup__text">
          <h2>Set up with your phone</h2>
          <p>
            Scan this code with your phone's camera, then continue in Tilecast
            Studio.
          </p>
          ${
            phone.rejected
              ? html`<p class="phone-setup__notice" role="status">
                  The address from the phone could not be used. Scan the code
                  again to try once more.
                </p>`
              : nothing
          }
        </div>
      </div>`;
    }
    if (phone?.state === "paused" && this.setup?.resumePhoneSetup) {
      const resume = this.setup.resumePhoneSetup;
      return html`<div class="phone-setup phone-setup--paused">
        <p>Phone setup stopped after 30 minutes.</p>
        <button id="phone-setup-resume" type="button" @click=${() => resume()}>
          Show setup code
        </button>
      </div>`;
    }
    return nothing;
  }

  private renderSetup(phone?: PhoneSetupStateV1) {
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
      ${this.renderPhoneSetup(phone)}
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
      <form
        id="setup-manual"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          submit(
            (
              event.currentTarget as HTMLFormElement
            ).querySelector<HTMLInputElement>("#setup-input")?.value ?? "",
          );
        }}
      >
        <label for="setup-input">Server address</label>
        <input
          id="setup-input"
          name="server-address"
          type="url"
          placeholder="https://signage.example.org"
          autofocus
          autocomplete="url"
        />
        <button type="submit">Connect</button>
      </form>
      <div id="setup-error" role="status">${this.setupError}</div>`;
  }

  private renderExternal(
    p: Extract<RuntimePresentation, { state: "external-presentation" }>,
  ) {
    const failed = p.sourceId !== undefined && p.sourceId === this.videoFailed;
    const source =
      this.presentVideo && !failed && SOURCE_ID.test(p.sourceId ?? "")
        ? p.sourceId
        : undefined;
    if (source) {
      // The host relays the stream. One <video> stays mounted for the whole
      // session, under the ready page, so it already receives when a sender
      // connects: the sender's only keyframe arrives then.
      return html`<video
          class=${classMap({
            "external-presentation__video": true,
            "external-presentation__video--waiting": !p.connected,
          })}
          src=${`tcpresent://session/${source}`}
          @error=${() => {
            this.videoFailed = source;
          }}
          autoplay
          playsinline
          disablepictureinpicture
          aria-hidden=${p.connected ? "false" : "true"}
        ></video>
        ${
          p.connected
            ? nothing
            : html`<div class="external-presentation__ready">
                ${this.renderReady(p)}
              </div>`
        }`;
    }
    // Once connected, the external receiver owns the screen: nothing of ours
    // may cover it. A relayed stream that failed leaves nothing to show, so
    // the ready page stays.
    if (p.connected && !failed) return nothing;
    return this.renderReady(p);
  }

  private renderReady(
    p: Extract<RuntimePresentation, { state: "external-presentation" }>,
  ) {
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
