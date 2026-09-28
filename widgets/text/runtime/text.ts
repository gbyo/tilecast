/**
 * Text V2: an authored message, sized to fill the Widget's box.
 *
 * Three styles:
 * - standard: an optional heading over the message;
 * - headline: the message as display type, the heading as a small eyebrow
 *   label above it, for short messages read from across a room;
 * - callout: heading and message marked with an accent rule, always
 *   aligned to the start edge.
 *
 * The author chooses words, a style, an alignment and colors, never type
 * sizes or padding. Each size is the largest the design allows for the
 * box; a FitController scales type down until the text fits, with a
 * 12px floor so a long message in a small zone stays legible. A wide
 * strip sets the heading and message on one line.
 */
import { css, html, nothing, type TemplateResult } from "lit";
import {
  empty,
  parseHexColor,
  ready,
  type ConfigResult,
  type WidgetResolution,
} from "@tilecast/widget-sdk";
import { FitController, TilecastWidgetElement } from "@tilecast/widget-kit";

export const TEXT_STYLES = ["standard", "headline", "callout"] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];

export const TEXT_ALIGNMENTS = ["left", "center"] as const;
export type TextAlignment = (typeof TEXT_ALIGNMENTS)[number];

export const MAX_HEADING_LENGTH = 120;
export const MAX_BODY_LENGTH = 1000;

export interface TextConfig {
  readonly heading: string;
  readonly body: string;
  readonly style: TextStyle;
  readonly align: TextAlignment;
  readonly background: string | null;
  readonly foreground: string | null;
}

function boundedText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value;
}

export function parseTextConfig(value: unknown): ConfigResult<TextConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const heading = boundedText(raw["heading"], MAX_HEADING_LENGTH);
  const body = boundedText(raw["body"], MAX_BODY_LENGTH);
  if (heading === null || body === null) {
    return {
      ok: false,
      problem: "heading and message must fit their length limits",
    };
  }
  const style = raw["style"] ?? "standard";
  if (!TEXT_STYLES.includes(style as never)) {
    return { ok: false, problem: "style is not a Text style" };
  }
  const align = raw["align"] ?? "center";
  if (!TEXT_ALIGNMENTS.includes(align as never)) {
    return { ok: false, problem: "align must be left or center" };
  }
  return {
    ok: true,
    config: {
      heading: heading.trim(),
      body: body.trim(),
      style: style as TextStyle,
      align: align as TextAlignment,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

/** Text is standalone. Without any words it is expectedly empty. */
export function resolveTextData(config: TextConfig): WidgetResolution<null> {
  if (config.heading === "" && config.body === "") return empty("no_text");
  return ready(null);
}

export class TilecastTextWidget extends TilecastWidgetElement<
  TextConfig,
  null
> {
  // Every type size is max(12px, fit × size): type never shrinks below
  // 12px, whatever the fit.
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .text {
        position: absolute;
        inset: 0;
        display: flex;
        padding: var(--tc-gutter);
      }
      .frame {
        --tc-fit: 1;
        flex: 1 1 auto;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }
      [data-align="left"] .frame,
      [data-style="callout"] .frame {
        align-items: flex-start;
        text-align: start;
      }
      [data-align="center"]:not([data-style="callout"]) .frame {
        align-items: center;
        text-align: center;
      }
      .content {
        display: flex;
        flex-direction: column;
        gap: calc(var(--tc-fit) * min(3.4cqh, 2.4cqw));
        max-width: 100%;
      }
      .heading,
      .body {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .heading {
        font-size: max(
          12px,
          calc(var(--tc-fit) * clamp(14px, min(9cqh, 5.4cqw), 220px))
        );
        font-weight: 650;
        line-height: 1.1;
        letter-spacing: -0.02em;
        text-wrap: balance;
      }
      .body {
        font-size: max(
          12px,
          calc(var(--tc-fit) * clamp(14px, min(7cqh, 4.4cqw), 170px))
        );
        font-weight: var(--tc-weight-body);
        line-height: 1.3;
        white-space: pre-line;
        text-wrap: pretty;
      }
      .heading + .body {
        color: var(--tc-color-fg-muted);
      }

      /* Headline: the message is the focal point. */
      [data-style="headline"] .content {
        gap: calc(var(--tc-fit) * min(2.6cqh, 1.8cqw));
      }
      [data-style="headline"] .heading {
        font-size: max(
          12px,
          calc(var(--tc-fit) * clamp(12px, min(4.6cqh, 2.6cqw), 84px))
        );
        font-weight: 650;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--tc-color-accent);
      }
      [data-style="headline"] .body,
      [data-style="headline"] .heading + .body {
        font-size: max(
          12px,
          calc(var(--tc-fit) * clamp(18px, min(22cqh, 11.5cqw), 520px))
        );
        font-weight: var(--tc-weight-display);
        line-height: 1.04;
        letter-spacing: -0.035em;
        color: var(--tc-color-fg);
        text-wrap: balance;
      }

      /* Callout: an accent rule marks the message. */
      [data-style="callout"] .content {
        border-inline-start: max(3px, calc(var(--tc-fit) * 1.1cqmin)) solid
          var(--tc-color-accent);
        padding-inline-start: calc(var(--tc-fit) * min(4cqh, 3cqw));
        padding-block: calc(var(--tc-fit) * min(1.2cqh, 0.8cqw));
      }

      /* Wide strip: heading and message on one line. */
      @container tc-widget (aspect-ratio > 3.2) {
        [data-style="standard"] .content,
        [data-style="callout"] .content {
          flex-direction: row;
          align-items: baseline;
          gap: calc(var(--tc-fit) * 4cqh);
        }
        .heading {
          flex: none;
          max-width: 40%;
          font-size: max(12px, calc(var(--tc-fit) * clamp(14px, 30cqh, 140px)));
        }
        .body {
          font-size: max(12px, calc(var(--tc-fit) * clamp(14px, 30cqh, 140px)));
        }
        [data-style="headline"] .heading {
          font-size: max(12px, calc(var(--tc-fit) * clamp(11px, 14cqh, 64px)));
        }
        [data-style="headline"] .body,
        [data-style="headline"] .heading + .body {
          font-size: max(12px, calc(var(--tc-fit) * clamp(16px, 48cqh, 220px)));
        }
      }

      /* Tall sidebar or portrait: more lines, so a little less size. */
      @container tc-widget (aspect-ratio < 0.75) {
        .heading {
          font-size: max(
            12px,
            calc(var(--tc-fit) * clamp(14px, 8.4cqw, 200px))
          );
        }
        .body {
          font-size: max(
            12px,
            calc(var(--tc-fit) * clamp(14px, 6.6cqw, 150px))
          );
        }
        [data-style="headline"] .body,
        [data-style="headline"] .heading + .body {
          font-size: max(12px, calc(var(--tc-fit) * clamp(18px, 15cqw, 360px)));
        }
      }
    `,
  ];

  private readonly fitter = new FitController(this, {
    target: () => this.renderRoot?.querySelector<HTMLElement>(".frame"),
    minimum: 0.2,
  });

  protected override themeOverrides(config: TextConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  /** The current fit scale; for tests and probes. */
  get fitScale(): number {
    return this.fitter.scale;
  }

  protected override renderContent(): TemplateResult {
    const { heading, body, style, align } = this.config;
    // A heading without a message reads as the message itself.
    const message = body || heading;
    const eyebrow = body ? heading : "";
    return html`<div class="text" data-style=${style} data-align=${align}>
      <div class="frame">
        <div class="content">
          ${eyebrow ? html`<p class="heading">${eyebrow}</p>` : nothing}
          <p class="body">${message}</p>
        </div>
      </div>
    </div>`;
  }
}
