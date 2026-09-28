/**
 * QR Code V2: a scannable code as the focal point of the Widget.
 *
 * Two styles:
 * - standard: heading, code, instruction and short label arranged for the
 *   container;
 * - code: the code alone, for small zones.
 *
 * Layout is container queries only. A wide strip sets the code beside its
 * text, a tall sidebar stacks them, and a small Layout zone drops the text
 * and shows the code alone, without measuring anything.
 *
 * The component owns QR encoding, the quiet zone and contrast: colors the
 * author picks are validated, and anything unusable falls back to a dark
 * code on a light background so the code always scans.
 */
import { css, html, nothing, svg, type TemplateResult } from "lit";
import qrcode from "qrcode-generator";
import { parseHexColor, type ConfigResult } from "@tilecast/widget-sdk";
import { empty, ready, type WidgetResolution } from "@tilecast/widget-sdk";
import { TilecastWidgetElement } from "@tilecast/widget-kit";

export const QR_CODE_STYLES = ["standard", "code"] as const;
export type QrCodeStyle = (typeof QR_CODE_STYLES)[number];

export interface QrCodeConfig {
  /** What the code opens or says. Empty renders the empty state. */
  readonly payload: string;
  readonly heading: string;
  readonly instruction: string;
  readonly shortLabel: string;
  readonly style: QrCodeStyle;
  /** Validated author colors; null follows the display theme. */
  readonly background: string | null;
  readonly foreground: string | null;
}

/** Compat parity: the legacy QR compiler encodes at most this much text. */
export const MAX_PAYLOAD_LENGTH = 2048;

/** Quiet-zone width in modules; the component always reserves it. */
const QUIET_ZONE = 4;

function boundedText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) return null;
  return value;
}

export function parseQrCodeConfig(value: unknown): ConfigResult<QrCodeConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const payload = boundedText(raw["payload"], MAX_PAYLOAD_LENGTH);
  if (payload === null)
    return {
      ok: false,
      problem: "payload must be text of at most 2048 characters",
    };
  const heading = boundedText(raw["heading"], 120);
  const instruction = boundedText(raw["instruction"], 300);
  const shortLabel = boundedText(raw["shortLabel"], 60);
  if (heading === null || instruction === null || shortLabel === null) {
    return {
      ok: false,
      problem:
        "heading, instruction and short label must fit their length limits",
    };
  }
  const style = raw["style"] ?? "standard";
  if (!QR_CODE_STYLES.includes(style as never)) {
    return { ok: false, problem: "style is not a QR Code style" };
  }
  // Author colors are optional; an invalid one is ignored, not fatal. When
  // both resolve to the same color the code could not scan, so both are
  // ignored and the theme supplies the contrast instead.
  const background = parseHexColor(raw["background"]);
  const foreground = parseHexColor(raw["foreground"]);
  const usable =
    background !== null && foreground !== null && background === foreground
      ? { background: null, foreground: null }
      : { background, foreground };
  return {
    ok: true,
    config: {
      payload,
      heading,
      instruction,
      shortLabel,
      style: style as QrCodeStyle,
      ...usable,
    },
  };
}

export function resolveQrCodeData(
  config: QrCodeConfig,
): WidgetResolution<null> {
  if (config.payload === "") return empty("no_payload");
  return ready(null);
}

interface QrMatrix {
  readonly count: number;
  readonly dark: (row: number, col: number) => boolean;
}

export function encodeQrCode(payload: string): QrMatrix | null {
  if (payload === "") return null;
  const code = qrcode(0, "M");
  code.addData(payload);
  code.make();
  return {
    count: code.getModuleCount(),
    dark: (row, col) => code.isDark(row, col),
  };
}

export class TilecastQrCodeWidget extends TilecastWidgetElement<
  QrCodeConfig,
  null
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .qr {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: var(--tc-gutter);
      }
      .stack {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: min(3cqh, 3cqw);
        min-width: 0;
        max-width: 100%;
        max-height: 100%;
        text-align: center;
      }
      .heading {
        font-size: clamp(12px, min(7cqh, 4.4cqw), 120px);
        font-weight: 600;
        line-height: 1.15;
        letter-spacing: -0.01em;
        max-width: 100%;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .code {
        flex: none;
        width: min(58cqh, 76cqw);
        height: auto;
        border-radius: min(1.2cqh, 1.2cqw);
      }
      .instruction {
        font-size: clamp(11px, min(4.6cqh, 3.2cqw), 72px);
        font-weight: 500;
        line-height: 1.3;
        color: var(--tc-color-fg-muted);
        max-width: 100%;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
      }
      .label {
        font-size: clamp(10px, min(3.8cqh, 2.6cqw), 56px);
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--tc-color-fg-subtle);
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Wide strip: code left, text right, sized by height. */
      @container tc-widget (aspect-ratio > 1.6) {
        .stack {
          flex-direction: row;
          gap: 4cqh;
          text-align: left;
        }
        .code {
          width: auto;
          height: min(86cqh, 200cqw);
        }
        .words {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 1.6cqh;
          min-width: 0;
          max-width: 60cqw;
        }
        .heading {
          font-size: clamp(12px, 8cqh, 120px);
        }
      }

      /* Tall sidebar: stack, code first. */
      @container tc-widget (aspect-ratio < 0.7) {
        .code {
          width: min(40cqh, 88cqw);
        }
      }

      /* Small Layout zone: the code alone. */
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .words {
          display: none;
        }
        .code {
          width: min(92cqh, 92cqw);
          height: auto;
        }
      }
    `,
  ];

  /**
   * The code always renders dark on light so it scans: unset author colors
   * fall back to the scannable default pair rather than the display theme,
   * which may be dark.
   */
  protected override themeOverrides(config: QrCodeConfig) {
    return {
      background: config.background ?? "#FFFFFF",
      foreground: config.foreground ?? "#101418",
    };
  }

  protected override presentationState():
    { state: "ready" } | { state: "empty"; reason: string } {
    if (this.empty !== null) return { state: "empty", reason: this.empty };
    // Belt and braces: the resolver already reports an empty payload, but
    // the element never renders a code with nothing encoded.
    if (this.config.payload === "")
      return { state: "empty", reason: "no_payload" };
    return { state: "ready" };
  }

  protected override renderContent(): TemplateResult {
    const matrix = encodeQrCode(this.config.payload);
    if (!matrix) return html``;
    const label = this.config.heading || this.config.shortLabel || "QR code";
    const code = this.renderCode(matrix, label);
    if (this.config.style === "code") {
      return html`<div class="qr"><div class="stack">${code}</div></div>`;
    }
    return html`<div class="qr">
      <div class="stack">
        ${code}
        <div class="words">
          ${
            this.config.heading
              ? html`<div class="heading">${this.config.heading}</div>`
              : nothing
          }
          ${
            this.config.instruction
              ? html`<div class="instruction">${this.config.instruction}</div>`
              : nothing
          }
          ${
            this.config.shortLabel
              ? html`<div class="label">${this.config.shortLabel}</div>`
              : nothing
          }
        </div>
      </div>
    </div>`;
  }

  private renderCode(matrix: QrMatrix, label: string): TemplateResult {
    const cells: string[] = [];
    for (let row = 0; row < matrix.count; row++) {
      for (let col = 0; col < matrix.count; col++) {
        if (matrix.dark(row, col)) {
          cells.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
        }
      }
    }
    const size = matrix.count + QUIET_ZONE * 2;
    return svg`<svg
      class="code"
      viewBox="0 0 ${size} ${size}"
      shape-rendering="crispEdges"
      role="img"
      aria-label=${label}
    >
      <rect width=${size} height=${size} fill="var(--tc-color-bg)" />
      <path d=${cells.join("")} fill="var(--tc-color-fg)" />
    </svg>`;
  }
}
