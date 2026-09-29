/**
 * Status V2: one visual purpose for any prepared object Data Document.
 *
 * Field mapping is explicit and source-neutral. Effective and expiry times
 * are evaluated against WidgetContext.clock; the component never fetches,
 * polls, or branches on a Data Source provider.
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
  emptyState,
  firstObjectValues,
  formatWidgetValue,
  TilecastWidgetElement,
  ClockController,
  type Tone,
} from "@tilecast/widget-kit";

export const STATUS_STYLES = ["panel", "banner"] as const;
export type StatusStyle = (typeof STATUS_STYLES)[number];
export const STATUS_SPEEDS = ["slow", "normal", "fast"] as const;
export type StatusSpeed = (typeof STATUS_SPEEDS)[number];

export interface StatusConfig {
  readonly dataSourceId: string;
  readonly style: StatusStyle;
  readonly heading: string;
  readonly statusField: string;
  readonly messageField: string;
  readonly severityField: string;
  readonly updatedAtField: string;
  readonly effectiveAtField: string;
  readonly expiresAtField: string;
  readonly showSeverity: boolean;
  readonly showUpdatedTime: boolean;
  readonly speed: StatusSpeed;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
  readonly accent: string | null;
}

export interface StatusData {
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

export function parseStatusConfig(value: unknown): ConfigResult<StatusConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const dataSourceId = fieldRef(raw["dataSourceId"]);
  if (dataSourceId === null || dataSourceId.length > 200) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  const fields = {
    statusField: fieldRef(raw["statusField"]),
    messageField: fieldRef(raw["messageField"]),
    severityField: fieldRef(raw["severityField"]),
    updatedAtField: fieldRef(raw["updatedAtField"]),
    effectiveAtField: fieldRef(raw["effectiveAtField"]),
    expiresAtField: fieldRef(raw["expiresAtField"]),
  };
  if (Object.values(fields).some((field) => field === null)) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const style = raw["style"] ?? "panel";
  if (!STATUS_STYLES.includes(style as StatusStyle)) {
    return { ok: false, problem: "style must be panel or banner" };
  }
  const speed = raw["speed"] ?? "normal";
  if (!STATUS_SPEEDS.includes(speed as StatusSpeed)) {
    return { ok: false, problem: "speed must be slow, normal, or fast" };
  }
  const showSeverity = optionalBoolean(raw["showSeverity"], true);
  const showUpdatedTime = optionalBoolean(raw["showUpdatedTime"], false);
  if (showSeverity === null || showUpdatedTime === null) {
    return { ok: false, problem: "visibility options must be booleans" };
  }
  return {
    ok: true,
    config: {
      dataSourceId,
      style: style as StatusStyle,
      heading: boundText(raw["heading"] ?? "", 120),
      statusField: fields.statusField as string,
      messageField: fields.messageField as string,
      severityField: fields.severityField as string,
      updatedAtField: fields.updatedAtField as string,
      effectiveAtField: fields.effectiveAtField as string,
      expiresAtField: fields.expiresAtField as string,
      showSeverity,
      showUpdatedTime,
      speed: speed as StatusSpeed,
      emptyText: boundText(raw["emptyText"] ?? "Status is unavailable", 200),
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
      accent: parseHexColor(raw["accent"]),
    },
  };
}

export function resolveStatusData(
  config: StatusConfig,
  resources: WidgetResources,
): WidgetResolution<StatusData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const object = firstObjectValues(document);
  if (!object) return failure("incompatible_source");
  if (Object.keys(object.values).length === 0) return empty("no_values");
  return ready(object);
}

/** Read a date or datetime value without treating unfamiliar text as time. */
export function statusInstant(
  value: WidgetValue | null | undefined,
): number | null {
  if (!value) return null;
  const raw =
    typeof value.datetime === "string"
      ? value.datetime
      : typeof value.date === "string"
        ? value.date
        : null;
  if (raw === null) return null;
  const instant = Date.parse(raw);
  return Number.isFinite(instant) ? instant : null;
}

export function statusActive(
  config: StatusConfig,
  data: StatusData,
  nowMs: number,
): { active: true } | { active: false; reason: "not_yet_active" | "expired" } {
  const effectiveAt =
    config.effectiveAtField === ""
      ? null
      : statusInstant(data.values[config.effectiveAtField]);
  const expiresAt =
    config.expiresAtField === ""
      ? null
      : statusInstant(data.values[config.expiresAtField]);
  if (effectiveAt !== null && nowMs < effectiveAt) {
    return { active: false, reason: "not_yet_active" };
  }
  if (expiresAt !== null && nowMs >= expiresAt) {
    return { active: false, reason: "expired" };
  }
  return { active: true };
}

/** Bounded semantic normalization; unfamiliar values stay neutral. */
export function severityTone(value: string): Tone {
  switch (value.trim().toLowerCase()) {
    case "normal":
      return "positive";
    case "notice":
    case "informational":
      return "accent";
    case "warning":
      return "warning";
    case "critical":
      return "critical";
    default:
      return "neutral";
  }
}

export class TilecastStatusWidget extends TilecastWidgetElement<
  StatusConfig,
  StatusData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .status-panel,
      .status-banner {
        position: absolute;
        inset: 0;
        overflow: hidden;
      }
      .status-panel {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: min(2.4cqh, 2.4cqw);
        padding: var(--tc-gutter);
      }
      .heading {
        max-width: 100%;
        overflow: hidden;
        color: var(--tc-color-fg-muted);
        font-size: clamp(12px, min(5cqh, 3.5cqw), 64px);
        font-weight: 650;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .panel-meta,
      .banner-meta {
        display: flex;
        align-items: center;
        gap: min(2cqw, 2cqh);
        min-width: 0;
      }
      .banner-meta {
        flex: 0 0 auto;
      }
      .status-value {
        min-width: 0;
        color: var(--tc-color-fg);
        font-size: clamp(22px, min(16cqh, 12cqw), 220px);
        font-weight: 700;
        line-height: 1.05;
        overflow-wrap: anywhere;
      }
      .message {
        max-width: 72ch;
        color: var(--tc-color-fg-muted);
        font-size: clamp(13px, min(7cqh, 4.8cqw), 84px);
        line-height: 1.35;
        overflow: hidden;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 5;
        overflow-wrap: anywhere;
      }
      .updated {
        color: var(--tc-color-fg-subtle);
        font-size: clamp(10px, min(3.8cqh, 2.6cqw), 44px);
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .status-banner {
        display: flex;
        align-items: center;
        gap: clamp(8px, 1.2cqw, 24px);
        padding: min(2cqh, 2cqw) var(--tc-gutter);
      }
      .banner-status {
        flex: 0 1 auto;
        min-width: 0;
        max-width: 28cqw;
        color: var(--tc-color-fg);
        font-size: clamp(13px, min(8cqh, 5cqw), 76px);
        font-weight: 700;
        line-height: 1.1;
        overflow: hidden;
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
        animation: status-marquee 30s linear infinite;
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
        font-size: clamp(14px, min(9cqh, 6cqw), 86px);
        font-weight: 550;
        line-height: 1.15;
        white-space: nowrap;
      }
      @keyframes status-marquee {
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
        text-overflow: ellipsis;
      }
      :host([data-reduced-motion]) .message-copy[aria-hidden="true"] {
        display: none;
      }
      @container tc-widget (aspect-ratio < 0.75) {
        .status-panel {
          gap: min(1.8cqh, 2cqw);
        }
        .message {
          -webkit-line-clamp: 4;
        }
        .status-banner {
          flex-wrap: wrap;
          align-content: center;
          gap: 1cqh 2cqw;
        }
        .banner-status {
          max-width: 100%;
        }
        .message-viewport {
          flex-basis: 100%;
        }
      }
      @container tc-widget (max-height: 150px) or (max-width: 200px) {
        .heading,
        .updated,
        .panel-meta .tc-badge {
          display: none;
        }
        .status-panel {
          justify-content: center;
          gap: 0.35em;
        }
        .status-value {
          font-size: clamp(17px, min(18cqh, 14cqw), 56px);
        }
        .message {
          font-size: clamp(11px, min(8cqh, 7cqw), 32px);
          -webkit-line-clamp: 2;
        }
        .status-banner {
          gap: 1.5cqw;
        }
        .banner-status {
          max-width: 30cqw;
          font-size: clamp(11px, 7cqh, 28px);
        }
        .message-copy {
          font-size: clamp(11px, 7cqh, 28px);
        }
      }
    `,
  ];

  private readonly ticks = new ClockController(this, {
    granularity: () => "minute",
    nextBoundary: (now) => this.nextStatusBoundary(now),
  });

  protected override themeOverrides(config: StatusConfig) {
    return {
      background: config.background,
      foreground: config.foreground,
      accent: config.accent,
    };
  }

  protected override presentationState() {
    if (this.empty !== null || !this.config || !this.data) {
      return super.presentationState();
    }
    const state = statusActive(
      this.config,
      this.data,
      this.context.clock.now(),
    );
    return state.active
      ? { state: "ready" as const }
      : { state: "empty" as const, reason: state.reason };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    const title = this.config?.emptyText || "Status is unavailable";
    return this.config ? emptyState({ title }) : super.renderEmpty(reason);
  }

  protected override renderContent(data: StatusData | null): TemplateResult {
    if (!data) return html``;
    const state = statusActive(this.config, data, this.context.clock.now());
    if (!state.active)
      return emptyState({
        title: this.config.emptyText || "Status is unavailable",
      });
    const status = this.text(data, this.config.statusField, 240);
    const message = this.text(data, this.config.messageField, 1600);
    const severity = this.text(data, this.config.severityField, 80);
    const updated = this.config.showUpdatedTime
      ? this.text(data, this.config.updatedAtField, 120)
      : "";
    if (this.config.style === "banner") {
      const bannerText = message || status;
      const bannerStatus =
        message &&
        status &&
        (!severity ||
          status.toLocaleLowerCase() !== severity.toLocaleLowerCase())
          ? status
          : "";
      return html`<div class="status-banner" data-style="banner">
        ${
          this.config.showSeverity && severity
            ? html`<span class="banner-meta"
                >${badge(severity, severityTone(severity))}</span
              >`
            : nothing
        }
        ${
          bannerStatus
            ? html`<span class="banner-status">${bannerStatus}</span>`
            : nothing
        }
        <div class="message-viewport">
          ${
            bannerText
              ? html`<div class="message-track" data-speed=${this.config.speed}>
                  <span class="message-copy">${bannerText}</span>
                  <span class="message-copy" aria-hidden="true"
                    >${bannerText}</span
                  >
                </div>`
              : nothing
          }
        </div>
      </div>`;
    }
    return html`<div class="status-panel" data-style="panel">
      ${this.config.heading ? html`<div class="heading">${this.config.heading}</div>` : nothing}
      <div class="panel-meta">
        ${
          this.config.showSeverity && severity
            ? badge(severity, severityTone(severity))
            : nothing
        }
      </div>
      ${status ? html`<div class="status-value">${status}</div>` : nothing}
      ${message ? html`<div class="message">${message}</div>` : nothing}
      ${updated ? html`<div class="updated">${updated}</div>` : nothing}
    </div>`;
  }

  private text(data: StatusData, key: string, maximum: number): string {
    if (key === "") return "";
    return boundText(
      formatWidgetValue(data.values[key], data.fields[key], {
        locale: this.context.locale,
        timeZone: this.context.timeZone,
      }),
      maximum,
    );
  }

  private nextStatusBoundary(now: number): number | null {
    if (!this.config || !this.data) return null;
    const times = [
      this.config.effectiveAtField === ""
        ? null
        : statusInstant(this.data.values[this.config.effectiveAtField]),
      this.config.expiresAtField === ""
        ? null
        : statusInstant(this.data.values[this.config.expiresAtField]),
    ].filter((value): value is number => value !== null && value > now);
    return times.length ? Math.min(...times) : null;
  }
}
