/**
 * Alert Banner V2: an urgent message designed for a shallow horizontal strip.
 *
 * The component is intentionally height-driven. A 1920x160 Layout band is its
 * recommended frame, but it progressively removes optional label/severity chrome
 * before shrinking the message when a Layout makes the band shorter.
 */
import { css, html, nothing, type TemplateResult } from "lit";
import {
  empty,
  failure,
  parseHexColor,
  ready,
  type ConfigResult,
  type WidgetField,
  type WidgetResources,
  type WidgetResolution,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import {
  badge,
  boundText,
  firstObjectValues,
  formatWidgetValue,
  TilecastWidgetElement,
  type Tone,
} from "@tilecast/widget-kit";

export const ALERT_BANNER_SPEEDS = ["slow", "normal", "fast"] as const;
export type AlertBannerSpeed = (typeof ALERT_BANNER_SPEEDS)[number];

export interface AlertBannerConfig {
  readonly dataSourceId: string;
  readonly messageField: string;
  readonly severityField: string;
  readonly labelField: string;
  readonly showSeverity: boolean;
  readonly speed: AlertBannerSpeed;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface AlertBannerData {
  readonly values: Readonly<Record<string, WidgetValue>>;
  readonly fields: Readonly<Record<string, WidgetField>>;
}

function fieldRef(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  return typeof value === "string" && value.length <= 120 ? value : null;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

export function parseAlertBannerConfig(
  value: unknown,
): ConfigResult<AlertBannerConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const dataSourceId = fieldRef(raw["dataSourceId"]);
  const messageField = fieldRef(raw["messageField"]);
  const severityField = fieldRef(raw["severityField"]);
  const labelField = fieldRef(raw["labelField"]);
  if (
    dataSourceId === null ||
    messageField === null ||
    severityField === null ||
    labelField === null
  ) {
    return {
      ok: false,
      problem: "Data Source and mapped fields must be field names",
    };
  }
  const speed = raw["speed"] ?? "normal";
  if (!ALERT_BANNER_SPEEDS.includes(speed as AlertBannerSpeed)) {
    return { ok: false, problem: "speed must be slow, normal, or fast" };
  }
  const showSeverity = optionalBoolean(raw["showSeverity"], true);
  if (showSeverity === null) {
    return { ok: false, problem: "showSeverity must be a boolean" };
  }
  return {
    ok: true,
    config: {
      dataSourceId,
      messageField,
      severityField,
      labelField,
      showSeverity,
      speed: speed as AlertBannerSpeed,
      emptyText: boundText(raw["emptyText"] ?? "No active alerts", 300),
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

export function resolveAlertBannerData(
  config: AlertBannerConfig,
  resources: WidgetResources,
): WidgetResolution<AlertBannerData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const object = firstObjectValues(document);
  if (!object) return failure("incompatible_source");
  if (Object.keys(object.values).length === 0) return empty("no_values");
  return ready(object);
}

/** Bounded normalization shared conceptually with Status, without coupling modules. */
export function alertSeverityTone(value: string): Tone {
  switch (value.trim().toLowerCase()) {
    case "normal":
      return "positive";
    case "minor":
    case "notice":
    case "informational":
      return "accent";
    case "moderate":
    case "warning":
      return "warning";
    case "severe":
    case "extreme":
    case "critical":
      return "critical";
    default:
      return "neutral";
  }
}

export class TilecastAlertBannerWidget extends TilecastWidgetElement<
  AlertBannerConfig,
  AlertBannerData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .alert-banner {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        min-width: 0;
        overflow: hidden;
        gap: clamp(6px, 8cqh, 18px);
        padding: clamp(4px, 10cqh, 16px) clamp(8px, 2cqw, 40px);
      }
      .severity,
      .label {
        flex: none;
      }
      .severity .tc-badge {
        gap: 0.35em;
        padding: 0.22em 0.58em;
        font-size: clamp(9px, 21cqh, 26px);
        line-height: 1;
      }
      .label {
        max-width: min(24cqw, 16ch);
        overflow: hidden;
        color: var(--tc-color-fg);
        font-size: clamp(10px, 25cqh, 34px);
        font-weight: 700;
        line-height: 1;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .message-viewport {
        flex: 1 1 0;
        min-width: 0;
        overflow: hidden;
      }
      .message-track {
        display: flex;
        width: max-content;
        align-items: center;
        animation: alert-banner-scroll 30s linear infinite;
        will-change: transform;
      }
      .message-track[data-speed="slow"] {
        animation-duration: 45s;
      }
      .message-track[data-speed="fast"] {
        animation-duration: 18s;
      }
      .message-copy {
        display: block;
        flex: none;
        min-width: 100cqw;
        padding-right: 5cqw;
        color: var(--tc-color-fg);
        font-size: clamp(11px, 34cqh, 56px);
        font-weight: 600;
        line-height: 1.04;
        letter-spacing: -0.015em;
        white-space: nowrap;
      }
      .alert-banner--empty {
        justify-content: center;
      }
      .empty-message {
        max-width: 100%;
        overflow: hidden;
        color: var(--tc-color-fg-muted);
        font-size: clamp(11px, 30cqh, 44px);
        font-weight: 550;
        line-height: 1.05;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      @keyframes alert-banner-scroll {
        to {
          transform: translateX(-50%);
        }
      }
      :host([data-reduced-motion]) .message-track {
        width: 100%;
        animation: none;
      }
      :host([data-reduced-motion]) .message-copy {
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        padding-right: 0;
        text-overflow: ellipsis;
      }
      :host([data-reduced-motion]) .message-copy[aria-hidden="true"] {
        display: none;
      }
      @container tc-widget (aspect-ratio < 3) {
        .label {
          display: none;
        }
      }
      @container tc-widget (max-height: 96px) {
        .alert-banner {
          gap: clamp(4px, 6cqh, 10px);
          padding-block: clamp(3px, 8cqh, 8px);
        }
      }
      @container tc-widget (max-height: 64px), (max-width: 520px) {
        .label {
          display: none;
        }
        .alert-banner {
          gap: clamp(3px, 5cqh, 8px);
          padding-inline: clamp(6px, 1.5cqw, 18px);
        }
      }
      @container tc-widget (max-height: 48px), (max-width: 360px) {
        .severity {
          display: none;
        }
        .message-copy {
          font-size: clamp(10px, 42cqh, 20px);
        }
      }
    `,
  ];

  protected override themeOverrides(config: AlertBannerConfig) {
    return {
      background: config.background,
      foreground: config.foreground,
    };
  }

  protected override presentationState() {
    if (this.empty !== null || !this.config || !this.data) {
      return super.presentationState();
    }
    const message = this.text(this.data, this.config.messageField, 1600);
    const label = this.text(this.data, this.config.labelField, 120);
    return message || label
      ? { state: "ready" as const }
      : { state: "empty" as const, reason: "no_message" };
  }

  protected override renderEmpty(_reason: string): TemplateResult {
    const title = this.config?.emptyText || "No active alerts";
    return html`<div class="alert-banner alert-banner--empty">
      <span class="empty-message">${title}</span>
    </div>`;
  }

  protected override renderContent(
    data: AlertBannerData | null,
  ): TemplateResult {
    if (!data) return html``;
    const message = this.text(data, this.config.messageField, 1600);
    const rawLabel = this.text(data, this.config.labelField, 120);
    const severity = this.text(data, this.config.severityField, 80);
    const label =
      rawLabel &&
      (!severity ||
        rawLabel.toLocaleLowerCase() !== severity.toLocaleLowerCase())
        ? rawLabel
        : "";
    const bannerText = message || rawLabel;
    if (!bannerText) return this.renderEmpty("no_message");
    return html`<div class="alert-banner">
      ${
        this.config.showSeverity && severity
          ? html`<span class="severity">${badge(
              severity,
              alertSeverityTone(severity),
            )}</span>`
          : nothing
      }
      ${label ? html`<span class="label">${label}</span>` : nothing}
      <div class="message-viewport">
        <div class="message-track" data-speed=${this.config.speed}>
          <span class="message-copy">${bannerText}</span>
          <span class="message-copy" aria-hidden="true">${bannerText}</span>
        </div>
      </div>
    </div>`;
  }

  private text(data: AlertBannerData, key: string, maximum: number): string {
    if (key === "") return "";
    return boundText(
      formatWidgetValue(data.values[key], data.fields[key], {
        locale: this.context.locale,
        timeZone: this.context.timeZone,
      }),
      maximum,
    );
  }
}
