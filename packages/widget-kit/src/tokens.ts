/**
 * Display tokens: the signage design system. These are not Studio's control
 * sizes. A Widget is read across a room, so type and spacing scale with the
 * Widget's own box (container units on the host, which is a size
 * container), clamped so a small Layout zone stays legible and a 4K
 * fullscreen Widget does not grow without bound.
 *
 * Colors come from the bounded WidgetTheme. They are derived here, in code,
 * rather than with color-mix(), so every engine computes identical values.
 */
import { css } from "lit";
import { luminance, type WidgetTheme } from "@tilecast/widget-sdk";

/** Mix two `#rrggbb` colors; `amount` 0 is `from`, 1 is `to`. */
export function mixColors(from: string, to: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  const channel = (hex: string, offset: number) =>
    parseInt(hex.slice(offset, offset + 2), 16);
  const out = [1, 3, 5].map((offset) =>
    Math.round(channel(from, offset) * (1 - t) + channel(to, offset) * t)
      .toString(16)
      .padStart(2, "0"),
  );
  return `#${out.join("")}`;
}

const STATUS = {
  dark: { positive: "#3ecf8e", warning: "#f5b83d", critical: "#ff6b6b" },
  light: { positive: "#16794a", warning: "#8f5b00", critical: "#c0262d" },
} as const;

const INK = "#0b0f14";

/** Readable text on a color: whichever of ink or white contrasts more. */
function onColor(hex: string): string {
  const background = luminance(hex) + 0.05;
  const withWhite = 1.05 / background;
  const withInk = background / (luminance(INK) + 0.05);
  return withInk >= withWhite ? INK : "#ffffff";
}

/**
 * Custom properties a theme defines on a Widget host. Applied through the
 * CSSOM (style.setProperty), never as a style attribute or a stylesheet.
 */
export function themeProperties(theme: WidgetTheme): Record<string, string> {
  const { background: bg, foreground: fg, accent } = theme;
  const status = STATUS[theme.scheme];
  return {
    "--tc-color-bg": bg,
    "--tc-color-fg": fg,
    "--tc-color-fg-muted": mixColors(fg, bg, 0.36),
    "--tc-color-fg-subtle": mixColors(fg, bg, 0.58),
    "--tc-color-surface": mixColors(bg, fg, 0.055),
    "--tc-color-surface-raised": mixColors(bg, fg, 0.1),
    "--tc-color-separator": mixColors(bg, fg, 0.16),
    "--tc-color-accent": accent,
    "--tc-color-on-accent": onColor(accent),
    "--tc-color-positive": status.positive,
    "--tc-color-warning": status.warning,
    "--tc-color-critical": status.critical,
  };
}

/**
 * Typography roles, spacing, radii and motion. Declared on the host so
 * every Widget shares one scale. `cqmin` is 1 % of the smaller side of the
 * Widget's box, so a strip and a sidebar get type that fits their short
 * side while a fullscreen Widget gets display-sized type.
 */
export const displayTokens = css`
  :host {
    /*
     * The Player Runtime registers its bundled Geist as "Tilecast UI"; Studio
     * and Storybook load the same face as "Geist Variable".
     */
    --tc-font-family:
      "Tilecast UI", "Geist Variable", "Geist", ui-sans-serif, sans-serif;

    /* One dominant value per Widget. */
    --tc-type-display: clamp(28px, 24cqmin, 560px);
    --tc-type-headline: clamp(20px, 10cqmin, 240px);
    --tc-type-title: clamp(16px, 6.4cqmin, 140px);
    --tc-type-body: clamp(14px, 4.6cqmin, 96px);
    --tc-type-label: clamp(12px, 3.4cqmin, 64px);
    --tc-type-caption: clamp(11px, 2.8cqmin, 48px);

    --tc-weight-display: 600;
    --tc-weight-strong: 600;
    --tc-weight-body: 440;

    --tc-leading-tight: 1.02;
    --tc-leading-snug: 1.18;
    --tc-leading-body: 1.35;
    --tc-tracking-display: -0.035em;
    --tc-tracking-label: 0.08em;

    --tc-space-1: clamp(2px, 0.8cqmin, 16px);
    --tc-space-2: clamp(4px, 1.6cqmin, 32px);
    --tc-space-3: clamp(6px, 2.6cqmin, 52px);
    --tc-space-4: clamp(8px, 4cqmin, 80px);
    --tc-space-5: clamp(12px, 6cqmin, 120px);
    --tc-space-6: clamp(16px, 9cqmin, 180px);
    /* The safe inset from the Widget's edge. */
    --tc-gutter: clamp(8px, 6cqmin, 120px);

    --tc-radius-s: clamp(2px, 0.6cqmin, 10px);
    --tc-radius-m: clamp(4px, 1.4cqmin, 22px);
    --tc-radius-l: clamp(6px, 2.4cqmin, 36px);

    --tc-stroke: clamp(1px, 0.25cqmin, 4px);

    --tc-duration-quick: 160ms;
    --tc-duration-standard: 320ms;
    --tc-duration-slow: 640ms;
    --tc-ease: cubic-bezier(0.2, 0, 0, 1);
  }
`;

/**
 * The host box every Widget shares: a size container that fills whatever
 * the mount gives it, clips, and paints the theme background.
 */
export const hostStyles = css`
  :host {
    display: block;
    position: relative;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    overflow: hidden;
    container: tc-widget / size;
    background: var(--tc-color-bg);
    color: var(--tc-color-fg);
    font-family: var(--tc-font-family);
    font-weight: var(--tc-weight-body);
    line-height: var(--tc-leading-body);
    font-synthesis: none;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  /*
   * Container units resolve against the nearest container ancestor, which
   * for the host itself is outside the Widget. Everything that sizes with
   * the Widget therefore lives inside this root.
   */
  .tc-root {
    position: absolute;
    inset: 0;
    font-size: var(--tc-type-body);
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  .tc-numeric {
    font-variant-numeric: tabular-nums lining-nums;
    font-feature-settings:
      "tnum" 1,
      "lnum" 1;
  }
  .tc-display {
    font-size: var(--tc-type-display);
    font-weight: var(--tc-weight-display);
    line-height: var(--tc-leading-tight);
    letter-spacing: var(--tc-tracking-display);
  }
  .tc-headline {
    font-size: var(--tc-type-headline);
    font-weight: var(--tc-weight-strong);
    line-height: var(--tc-leading-snug);
    letter-spacing: -0.02em;
  }
  .tc-title {
    font-size: var(--tc-type-title);
    font-weight: var(--tc-weight-strong);
    line-height: var(--tc-leading-snug);
  }
  .tc-body {
    font-size: var(--tc-type-body);
  }
  .tc-label {
    font-size: var(--tc-type-label);
    font-weight: var(--tc-weight-strong);
    letter-spacing: var(--tc-tracking-label);
    text-transform: uppercase;
    color: var(--tc-color-fg-muted);
  }
  .tc-caption {
    font-size: var(--tc-type-caption);
    color: var(--tc-color-fg-muted);
  }
  .tc-muted {
    color: var(--tc-color-fg-muted);
  }
  .tc-truncate {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
`;

/**
 * Surfaces for grouping supporting information. Deliberately few: a flat
 * surface, a raised card and a responsive grid. No shadows or gradients.
 */
export const surfaceStyles = css`
  .tc-surface {
    background: var(--tc-color-surface);
    border-radius: var(--tc-radius-l);
  }
  .tc-card {
    background: var(--tc-color-surface-raised);
    border-radius: var(--tc-radius-m);
    padding: var(--tc-space-3) var(--tc-space-4);
  }
  .tc-grid {
    display: grid;
    gap: var(--tc-space-3);
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 22cqi), 1fr));
  }
  .tc-separator {
    border: 0;
    height: var(--tc-stroke);
    background: var(--tc-color-separator);
    margin: 0;
  }
`;
