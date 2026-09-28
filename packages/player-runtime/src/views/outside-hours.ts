/**
 * Outside active hours (`sleep`): true black, a bouncing Tilecast logo, or the
 * organization's custom text. All media is torn down while this shows.
 */
import { LitElement, html, nothing } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { cssProps } from "./css-props";
import type { RuntimePresentation } from "../host/contract";

type Sleep = Extract<RuntimePresentation, { state: "sleep" }>;

export class OutsideHours extends LitElement {
  static override properties = { presentation: { attribute: false } };

  declare presentation: Sleep | null;

  constructor() {
    super();
    this.presentation = null;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override render() {
    const p = this.presentation;
    const display = p?.display;
    const visible = display === "bouncing_logo" || display === "custom_text";
    return html`<div
      id="outside-hours-overlay"
      class=${classMap({ visible, "custom-text": display === "custom_text" })}
    >
      ${
        display === "bouncing_logo"
          ? html`<div class="outside-hours-logo-x">
              <img
                class="outside-hours-logo-y"
                src="tilecast-logo-white.svg"
                alt="Tilecast"
              />
            </div>`
          : display === "custom_text"
            ? html`<div
                class="outside-hours-text"
                style=${cssProps({ color: p?.textColor || "#F5F7FA" })}
              >
                ${p?.text?.trim() || "Powered by Tilecast"}
              </div>`
            : nothing
      }
    </div>`;
  }
}

customElements.define("tc-outside-hours", OutsideHours);
