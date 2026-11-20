/**
 * TilecastWidgetElement: the Lit base class for Widgets V2 elements.
 *
 * It declares the typed inputs every Widget receives (config, data, empty,
 * context), adopts the display tokens, applies the bounded theme through
 * the CSSOM, and announces ready or empty after each change of inputs. A
 * clock tick is not a change of inputs, so a ticking Widget announces once.
 *
 * Subclasses implement renderContent() and, optionally, renderEmpty(),
 * themeOverrides(), backgroundOpacity() and libraryFont(). They never touch
 * the host object, storage or network.
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
  LIBRARY_FONT_FAMILY,
  resolveTheme,
  type WidgetContext,
  type WidgetElementInputs,
  type WidgetTheme,
} from "@tilecast/widget-sdk";
import { emptyState, statusStyles } from "./templates.ts";
import {
  BUNDLED_FONT_STACK,
  displayTokens,
  hostStyles,
  surfaceStyles,
  themeProperties,
  withAlpha,
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
  private appliedFont: string | null = null;
  private lastPresentationState = "";

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

  /**
   * How opaque the Widget paints its own background, from 0 (transparent,
   * so the Layout shows through) to 1. Only the paint changes: the theme
   * background stays opaque, so derived surfaces and text contrast do not.
   * Override when the authoring schema declares a background opacity.
   */
  protected backgroundOpacity(_config: Config): number {
    return 1;
  }

  /**
   * A library family that resolveData() received from
   * `resources.font()`, or null for the bundled face. Only generated
   * `tcf-<id>` names are applied; the bundled stack stays the fallback.
   */
  protected libraryFont(): string | null {
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
    if (changed.has("config") || changed.has("data")) this.applyFont();
  }

  protected override render(): TemplateResult {
    return html`<div class="tc-root" part="root">
      ${this.empty !== null ? this.renderEmpty(this.empty) : this.renderContent(this.data)}
    </div>`;
  }

  protected override updated(changed: PropertyValues): void {
    const inputsChanged = INPUTS.some((input) => changed.has(input));
    const state = this.presentationState();
    const stateKey =
      state.state === "ready"
        ? "ready"
        : state.state === "empty"
          ? `empty:${state.reason}`
          : `error:${state.code}`;
    // ClockController calls requestUpdate at presentation boundaries. A
    // time-sensitive Widget can therefore report a changed ready/empty state
    // without repeating the same event at every clock tick.
    if (!inputsChanged && stateKey === this.lastPresentationState) return;
    this.lastPresentationState = stateKey;
    if (state.state === "empty") announceEmpty(this, state.reason);
    else if (state.state === "error") announceError(this, state.code);
    else announceReady(this);
  }

  private applyFont(): void {
    const family = this.libraryFont();
    const font =
      typeof family === "string" && LIBRARY_FONT_FAMILY.test(family)
        ? family
        : null;
    if (font === this.appliedFont) return;
    this.appliedFont = font;
    if (font) {
      this.style.setProperty(
        "--tc-font-family",
        `"${font}", ${BUNDLED_FONT_STACK}`,
      );
    } else {
      this.style.removeProperty("--tc-font-family");
    }
  }

  private applyTheme(): void {
    const theme = this.theme;
    const raw = this.config ? this.backgroundOpacity(this.config) : 1;
    const opacity = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
    const key = `${theme.scheme}${theme.background}${theme.foreground}${theme.accent}${this.context.motion.reduced}${opacity}`;
    if (key === this.appliedTheme) return;
    this.appliedTheme = key;
    const properties = themeProperties(theme);
    for (const [name, value] of Object.entries(properties)) {
      this.style.setProperty(name, value);
    }
    if (opacity < 1) {
      this.style.setProperty(
        "--tc-color-bg-fill",
        withAlpha(theme.background, opacity),
      );
    } else {
      this.style.removeProperty("--tc-color-bg-fill");
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
