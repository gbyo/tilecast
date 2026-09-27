/**
 * What a Widget knows about where it runs. The same context shape is built
 * by the Player Runtime, the Studio preview host and Storybook, so a Widget
 * cannot tell them apart except through `mode`.
 *
 * The context carries no size: a Widget lays itself out with container
 * queries on its own box, so a resize never has to rerender it.
 */

export interface WidgetTimer {
  cancel(): void;
}

/**
 * Corrected Tilecast time. `now()` is the only wall-clock authority a Widget
 * may use; `after()` schedules on the host's scheduler so a manual
 * conformance or preview clock drives Widgets exactly like playback.
 */
export interface WidgetClock {
  /** Corrected (server) Unix milliseconds. */
  now(): number;
  /** Monotonic milliseconds, for elapsed time and motion. */
  monotonicNow(): number;
  /** Run once after `delayMs` of monotonic time. */
  after(delayMs: number, run: () => void): WidgetTimer;
}

export type ThemeScheme = "dark" | "light";

/**
 * The bounded Widget theme. Every value is a validated `#rrggbb` color; the
 * visual system derives surfaces, muted text and separators from them so a
 * host cannot inject arbitrary CSS through the theme.
 */
export interface WidgetTheme {
  readonly scheme: ThemeScheme;
  readonly background: string;
  readonly foreground: string;
  readonly accent: string;
}

/** The deterministic Tilecast display theme. */
export const TILECAST_DISPLAY_THEME: WidgetTheme = Object.freeze({
  scheme: "dark",
  background: "#0e141b",
  foreground: "#f5f7fa",
  accent: "#4f9dff",
});

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Normalize `#rgb`/`#rrggbb` to lowercase `#rrggbb`, or null. */
export function parseHexColor(value: unknown): string | null {
  if (typeof value !== "string" || !HEX_COLOR.test(value.trim())) return null;
  const hex = value.trim().slice(1).toLowerCase();
  return hex.length === 3
    ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`
    : `#${hex}`;
}

/** Relative luminance of a `#rrggbb` color (WCAG definition). */
export function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Tilecast accents that keep contrast on each scheme's backgrounds. */
const SCHEME_ACCENT: Record<ThemeScheme, string> = {
  dark: "#4f9dff",
  light: "#1f5fbf",
};

/**
 * Build a theme from untrusted parts. Invalid colors fall back to the base
 * theme; the scheme follows the resulting background so contrast-dependent
 * tokens stay correct when an author picks a light background. When that
 * flips the scheme and no accent is given, the scheme's own accent replaces
 * the base accent.
 */
export function resolveTheme(
  overrides: Partial<Record<"background" | "foreground" | "accent", unknown>>,
  base: WidgetTheme = TILECAST_DISPLAY_THEME,
): WidgetTheme {
  const background = parseHexColor(overrides.background) ?? base.background;
  const foreground = parseHexColor(overrides.foreground) ?? base.foreground;
  const scheme: ThemeScheme = luminance(background) > 0.4 ? "light" : "dark";
  const accent =
    parseHexColor(overrides.accent) ??
    (scheme === base.scheme ? base.accent : SCHEME_ACCENT[scheme]);
  return Object.freeze({ scheme, background, foreground, accent });
}

export interface WidgetContext {
  readonly clock: WidgetClock;
  /** BCP 47 locale for formatting. */
  readonly locale: string;
  /** IANA time zone of the screen's organization. */
  readonly timeZone: string;
  /**
   * The organization's regional time format: the locale's convention, or a
   * forced 12- or 24-hour clock.
   */
  readonly hourCycle: "locale" | "h12" | "h23";
  readonly theme: WidgetTheme;
  readonly motion: {
    /** Avoid non-essential motion (platform preference or a frozen run). */
    readonly reduced: boolean;
  };
  /** On a screen, or in a Studio or Storybook preview. */
  readonly mode: "playback" | "preview";
}

/** A syntactically valid IANA zone this engine knows, or null. */
export function validTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    return null;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

/** A BCP 47 locale this engine accepts, or null. */
export function validLocale(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 35) {
    return null;
  }
  try {
    return Intl.getCanonicalLocales(value)[0] ?? null;
  } catch {
    return null;
  }
}
