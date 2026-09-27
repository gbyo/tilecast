/**
 * Small Lit templates for states every Widget shares. They are helpers,
 * not custom elements, so they add no shadow roots and no lifecycle.
 *
 * Status is never color alone: every badge has text, and tones other than
 * neutral also have a shape.
 */
import { css, html, nothing, svg, type TemplateResult } from "lit";

export type Tone = "neutral" | "accent" | "positive" | "warning" | "critical";

export const statusStyles = css`
  .tc-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--tc-space-3);
    padding: var(--tc-gutter);
    text-align: center;
  }
  .tc-empty-mark {
    width: clamp(20px, 9cqmin, 160px);
    height: clamp(20px, 9cqmin, 160px);
    color: var(--tc-color-fg-subtle);
  }
  .tc-empty-title {
    font-size: var(--tc-type-title);
    font-weight: var(--tc-weight-strong);
    color: var(--tc-color-fg-muted);
    max-width: 28ch;
  }
  .tc-empty-detail {
    font-size: var(--tc-type-caption);
    color: var(--tc-color-fg-subtle);
    max-width: 40ch;
  }
  .tc-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.45em;
    padding: 0.28em 0.7em;
    border-radius: 999px;
    font-size: var(--tc-type-label);
    font-weight: var(--tc-weight-strong);
    letter-spacing: 0.04em;
    line-height: 1.1;
    background: var(--tc-color-surface-raised);
    color: var(--tc-color-fg);
    white-space: nowrap;
  }
  .tc-badge-mark {
    width: 0.62em;
    height: 0.62em;
    flex: none;
  }
  .tc-badge[data-tone="accent"] .tc-badge-mark {
    color: var(--tc-color-accent);
  }
  .tc-badge[data-tone="positive"] .tc-badge-mark {
    color: var(--tc-color-positive);
  }
  .tc-badge[data-tone="warning"] .tc-badge-mark {
    color: var(--tc-color-warning);
  }
  .tc-badge[data-tone="critical"] .tc-badge-mark {
    color: var(--tc-color-critical);
  }
`;

const EMPTY_MARK = svg`<svg class="tc-empty-mark" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5" />
  <path d="M8 12h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
</svg>`;

/** The expected-empty treatment: quiet, centered, clearly intentional. */
export function emptyState(options: {
  title: string;
  detail?: string;
}): TemplateResult {
  return html`<div class="tc-empty" role="status">
    ${EMPTY_MARK}
    <div class="tc-empty-title">${options.title}</div>
    ${
      options.detail
        ? html`<div class="tc-empty-detail">${options.detail}</div>`
        : nothing
    }
  </div>`;
}

/** Content that should exist but cannot be shown (for example no data yet). */
export function unavailableState(detail?: string): TemplateResult {
  return emptyState({ title: "Temporarily unavailable", detail });
}

const MARKS: Record<Exclude<Tone, "neutral">, TemplateResult> = {
  accent: svg`<circle cx="5" cy="5" r="4" fill="currentColor" />`,
  positive: svg`<path d="M1.5 5.2 4 7.6 8.6 2.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />`,
  warning: svg`<path d="M5 1 9.2 8.8H.8Z" fill="currentColor" />`,
  critical: svg`<rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />`,
};

/** A short status with text and, for non-neutral tones, a shape. */
export function badge(text: string, tone: Tone = "neutral"): TemplateResult {
  return html`<span class="tc-badge" data-tone=${tone}
    >${
      tone === "neutral"
        ? nothing
        : html`<svg
            class="tc-badge-mark"
            viewBox="0 0 10 10"
            aria-hidden="true"
          >
            ${MARKS[tone]}
          </svg>`
    }${text}</span
  >`;
}
