/**
 * TilecastWidgetElement: the Lit base class for Widgets V2 elements.
 *
 * It declares the typed inputs every Widget receives (config, data, empty,
 * context), adopts the display tokens, applies the bounded theme through
 * the CSSOM, and announces ready or empty after each change of inputs. A
 * clock tick is not a change of inputs, so a ticking Widget announces once.
 *
 * Subclasses implement renderContent() and, optionally, renderEmpty() and
 * themeOverrides(). They never touch the host object, storage or network.
 */
import {
  LitElement,
  html,
  type CSSResultGroup,
  type PropertyDeclarations,
  type PropertyValues,
  type TemplateResult,
} from "lit";
import {
  announceEmpty,
  announceError,
  announceReady,
  resolveTheme,
  type WidgetContext,
  type WidgetElementInputs,
  type WidgetTheme,
} from "@tilecast/widget-sdk";
import { emptyState, statusStyles } from "./templates.ts";
import {
  displayTokens,
  hostStyles,
  surfaceStyles,
  themeProperties,
} from "./tokens.ts";

const INPUTS = ["config", "data", "empty", "context"] as const;

export abstract class TilecastWidgetElement<Config, Data>
  extends LitElement
  implements WidgetElementInputs<Config, Data>
{
  static override properties: PropertyDeclarations = {
    config: { attribute: false },
    data: { attribute: false },
    empty: { attribute: false },
    context: { attribute: false },
  };

  static override styles: CSSResultGroup = [
    displayTokens,
    hostStyles,
    surfaceStyles,
    statusStyles,
  ];

  declare config: Config;
  declare data: Data | null;
  declare empty: string | null;
  declare context: WidgetContext;

  private appliedTheme = "";

  /** The theme after this Widget's permitted author overrides. */
  protected get theme(): WidgetTheme {
    const overrides = this.config ? this.themeOverrides(this.config) : null;
    return overrides
      ? resolveTheme(overrides, this.context.theme)
      : this.context.theme;
  }

  /**
   * Author colors this Widget's authoring schema explicitly permits. Values
   * are validated by resolveTheme(); anything invalid is ignored.
   */
  protected themeOverrides(
    _config: Config,
  ): Partial<Record<"background" | "foreground" | "accent", unknown>> | null {
    return null;
  }

  protected abstract renderContent(data: Data | null): TemplateResult;

  /** The expected-empty presentation. Override for a Widget-specific one. */
  protected renderEmpty(_reason: string): TemplateResult {
    return emptyState({ title: "Nothing to show right now" });
  }

  /**
   * Ready unless the Widget knows better for its current inputs, for
   * example a schedule whose last event has ended.
   */
  protected presentationState():
    | { state: "ready" }
    | { state: "empty"; reason: string }
    | { state: "error"; code: string } {
    return this.empty !== null
      ? { state: "empty", reason: this.empty }
      : { state: "ready" };
  }

  protected override shouldUpdate(changed: PropertyValues): boolean {
    // Nothing meaningful can render before the mount assigns every input.
    return (
      this.context !== undefined &&
      this.config !== undefined &&
      super.shouldUpdate(changed)
    );
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("context") || changed.has("config")) this.applyTheme();
  }

  protected override render(): TemplateResult {
    return html`<div class="tc-root" part="root">
      ${this.empty !== null ? this.renderEmpty(this.empty) : this.renderContent(this.data)}
    </div>`;
  }

  protected override updated(changed: PropertyValues): void {
    if (!INPUTS.some((input) => changed.has(input))) return;
    const state = this.presentationState();
    if (state.state === "empty") announceEmpty(this, state.reason);
    else if (state.state === "error") announceError(this, state.code);
    else announceReady(this);
  }

  private applyTheme(): void {
    const theme = this.theme;
    const key = `${theme.scheme}${theme.background}${theme.foreground}${theme.accent}${this.context.motion.reduced}`;
    if (key === this.appliedTheme) return;
    this.appliedTheme = key;
    const properties = themeProperties(theme);
    for (const [name, value] of Object.entries(properties)) {
      this.style.setProperty(name, value);
    }
    this.style.setProperty("color-scheme", theme.scheme);
    const still = this.context.motion.reduced;
    for (const name of [
      "--tc-duration-quick",
      "--tc-duration-standard",
      "--tc-duration-slow",
    ]) {
      if (still) this.style.setProperty(name, "0ms");
      else this.style.removeProperty(name);
    }
    this.toggleAttribute("data-reduced-motion", still);
    this.setAttribute("data-scheme", theme.scheme);
  }
}
