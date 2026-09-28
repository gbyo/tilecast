/**
 * Progress V2: advancement toward a numeric target as a bar, ring, or
 * thermometer.
 *
 * The author picks a records or single-object source, a current-value
 * field, and either a target field or a fixed positive target. A valid
 * target field wins over the fixed target. Values below zero are shown;
 * percentages above one hundred display honestly while the visual fill
 * clamps to its drawable range. The Widget never branches on the source
 * provider and never divides by zero.
 *
 * Layout is container queries only. Bars fill horizontally and suit
 * strips; rings center the value; thermometers rise vertically. Small
 * zones keep the value and drop supporting text first.
 */
import { css, html, nothing, svg, type TemplateResult } from "lit";
import {
  empty,
  failure,
  firstRecordsDataset,
  parseHexColor,
  ready,
  type ConfigResult,
  type WidgetDataDocument,
  type WidgetField,
  type WidgetResources,
  type WidgetResolution,
  type WidgetValue,
} from "@tilecast/widget-sdk";
import {
  boundText,
  formatDisplayNumber,
  formatWidgetValue,
  TilecastWidgetElement,
  emptyState,
  toFiniteNumber,
  type NumericDisplayStyle,
} from "@tilecast/widget-kit";

export const PROGRESS_STYLES = ["bar", "ring", "thermometer"] as const;
export type ProgressStyle = (typeof PROGRESS_STYLES)[number];

export const PROGRESS_FORMATS = [
  "number",
  "integer",
  "percent",
  "currency",
] as const;
export type ProgressFormat = (typeof PROGRESS_FORMATS)[number];

export interface ProgressConfig {
  readonly dataSourceId: string;
  readonly valueField: string;
  readonly targetField: string;
  readonly staticTarget: number | null;
  readonly label: string;
  readonly labelField: string;
  readonly format: ProgressFormat;
  readonly precision: number;
  readonly showPercent: boolean;
  readonly completionText: string;
  readonly style: ProgressStyle;
  readonly emptyText: string;
  readonly background: string | null;
  readonly foreground: string | null;
}

export interface ProgressData {
  readonly current: number;
  readonly valueField: WidgetField | undefined;
  readonly labelValue: WidgetValue | null;
  readonly labelField: WidgetField | undefined;
  readonly percent: number;
  readonly complete: boolean;
  readonly style: ProgressStyle;
}

const MAX_FIELD_LENGTH = 120;

function fieldRef(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_FIELD_LENGTH) return null;
  return value;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") return undefined;
  return value;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean | null {
  if (value === undefined) return fallback;
  return typeof value === "boolean" ? value : null;
}

export function parseProgressConfig(
  value: unknown,
): ConfigResult<ProgressConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, problem: "configuration must be an object" };
  }
  const raw = value as Record<string, unknown>;
  const source = fieldRef(raw["dataSourceId"]);
  const valueField = fieldRef(raw["valueField"]);
  const targetField = fieldRef(raw["targetField"]);
  if (source === null || source.length > 200) {
    return { ok: false, problem: "dataSourceId must be a Data Source id" };
  }
  if (valueField === null || targetField === null) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const staticTarget = optionalNumber(raw["staticTarget"]);
  if (staticTarget === undefined) {
    return { ok: false, problem: "staticTarget must be numeric" };
  }
  const label = boundText(raw["label"] ?? "", 120);
  const labelField = fieldRef(raw["labelField"]);
  if (labelField === null) {
    return { ok: false, problem: "mapped fields must be field names" };
  }
  const format = raw["format"] ?? "number";
  if (!PROGRESS_FORMATS.includes(format as never)) {
    return { ok: false, problem: "format is not a Progress format" };
  }
  const precision = raw["precision"] ?? 1;
  if (
    typeof precision !== "number" ||
    !Number.isInteger(precision) ||
    precision < 0 ||
    precision > 6
  ) {
    return { ok: false, problem: "precision must be an integer from 0 to 6" };
  }
  const showPercent = optionalBoolean(raw["showPercent"], true);
  if (showPercent === null) {
    return { ok: false, problem: "showPercent must be a boolean" };
  }
  const completionText = boundText(raw["completionText"] ?? "", 160);
  const style = raw["style"] ?? "bar";
  if (!PROGRESS_STYLES.includes(style as never)) {
    return { ok: false, problem: "style is not a Progress style" };
  }
  const emptyText = boundText(raw["emptyText"] ?? "", 200);
  return {
    ok: true,
    config: {
      dataSourceId: source,
      valueField,
      targetField,
      staticTarget,
      label,
      labelField,
      format: format as ProgressFormat,
      precision,
      showPercent,
      completionText,
      style: style as ProgressStyle,
      emptyText,
      // Author colors are optional; an invalid one is ignored, not fatal.
      background: parseHexColor(raw["background"]),
      foreground: parseHexColor(raw["foreground"]),
    },
  };
}

function firstObjectValues(document: WidgetDataDocument): {
  values: Readonly<Record<string, WidgetValue>>;
  fields: Readonly<Record<string, WidgetField>>;
} | null {
  for (const dataset of document.datasets) {
    if (dataset.kind !== "object") continue;
    const object = dataset.value?.object;
    if (!object) return null;
    const fields: Record<string, WidgetField> = {};
    for (const field of dataset.fields ?? []) fields[field.key] = field;
    return { values: object, fields };
  }
  return null;
}

export function resolveProgressData(
  config: ProgressConfig,
  resources: WidgetResources,
): WidgetResolution<ProgressData> {
  if (config.dataSourceId === "") return empty("no_source");
  const document = resources.dataDocument(config.dataSourceId);
  if (!document) return empty("no_source");
  const records = firstRecordsDataset(document);
  const object = records ? null : firstObjectValues(document);
  if (!records && !object) return failure("incompatible_source");
  const usable = records
    ? (records.records ?? []).length > 0
      ? {
          values: records.records![0]!.values,
          fields: Object.fromEntries(
            (records.fields ?? []).map((field) => [field.key, field]),
          ) as Readonly<Record<string, WidgetField>>,
        }
      : null
    : object;
  if (!usable) return empty("no_records");
  const current = toFiniteNumber(usable.values[config.valueField]);
  if (current === null) return empty("no_value");
  // A valid target field wins over the fixed target. Neither may be
  // missing, non-finite, or non-positive: there is no honest percentage
  // without one, so this is a configuration failure, not an empty state.
  let target: number | null = null;
  if (config.targetField !== "") {
    target = toFiniteNumber(usable.values[config.targetField]);
  }
  if (target === null && config.staticTarget !== null) {
    target = Number.isFinite(config.staticTarget) ? config.staticTarget : null;
  }
  if (target === null || target <= 0) return failure("invalid_target");
  const percent = (current / target) * 100;
  return ready({
    current,
    valueField: usable.fields[config.valueField],
    labelValue:
      config.labelField !== ""
        ? (usable.values[config.labelField] ?? null)
        : null,
    labelField:
      config.labelField !== "" ? usable.fields[config.labelField] : undefined,
    percent,
    complete: current >= target,
    style: config.style,
  });
}

/**
 * Render the resolved values with the Widget locale. Kept outside the
 * element so tests assert the same strings Players show.
 */
export function progressDisplay(
  config: ProgressConfig,
  data: { percent: number },
  values: {
    current: number;
    valueField: WidgetField | undefined;
    labelValue: WidgetValue | null;
    labelField: WidgetField | undefined;
  },
  locale: string,
): { label: string; valueText: string; percentText: string } {
  const style: NumericDisplayStyle = config.format;
  const valueText = formatDisplayNumber(values.current, {
    locale,
    style,
    currency: values.valueField?.currency,
    precision: config.precision,
  });
  let label = config.label;
  if (values.labelValue) {
    const mapped = formatWidgetValue(values.labelValue, values.labelField, {
      locale,
    }).trim();
    if (mapped !== "") label = mapped;
  }
  const percentText = config.showPercent
    ? formatDisplayNumber(data.percent, {
        locale,
        style: "percent",
        precision: config.precision,
      })
    : "";
  return { label, valueText, percentText };
}

export class TilecastProgressWidget extends TilecastWidgetElement<
  ProgressConfig,
  ProgressData
> {
  static override styles = [
    ...(TilecastWidgetElement.styles as never[]),
    css`
      .progress-wrap {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 0;
        min-width: 0;
        padding: var(--tc-gutter);
        overflow: hidden;
      }
      .progress-label {
        font-size: clamp(11px, min(4.5cqh, 3.4cqw), 44px);
        font-weight: 600;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: var(--tc-color-fg-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
      }
      .progress-main {
        font-size: clamp(18px, min(10cqh, 8cqw), 180px);
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.15;
        font-variant-numeric: tabular-nums;
        text-align: center;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .progress-sub {
        font-size: clamp(11px, min(4cqh, 3cqw), 36px);
        color: var(--tc-color-fg-muted);
        text-align: center;
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .bar-track {
        margin-top: min(2cqh, 2cqw);
        height: clamp(10px, 4cqh, 40px);
        border-radius: 999px;
        background: var(--tc-color-surface);
        overflow: hidden;
      }
      .bar-fill {
        height: 100%;
        border-radius: 999px;
        background: var(--tc-color-accent, currentColor);
      }
      .ring-wrap {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: min(3cqh, 3cqw);
        min-height: 0;
      }
      .ring-svg {
        height: min(46cqh, 60cqw, 420px);
        aspect-ratio: 1;
        flex: none;
      }
      .ring-center {
        font-size: clamp(14px, min(7cqh, 6cqw), 120px);
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .thermo-wrap {
        display: flex;
        align-items: stretch;
        justify-content: center;
        gap: min(4cqh, 4cqw);
        min-height: 0;
        flex: 1;
      }
      .thermo-tube {
        width: clamp(14px, 5cqw, 48px);
        border-radius: 999px;
        background: var(--tc-color-surface);
        position: relative;
        overflow: hidden;
        align-self: stretch;
        min-height: 60px;
      }
      .thermo-fill {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--tc-color-accent, currentColor);
      }
      .thermo-side {
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-width: 0;
      }
      @container tc-widget (max-height: 170px) {
        .progress-label,
        .progress-sub {
          display: none;
        }
      }
      @container tc-widget (max-width: 240px) {
        .progress-sub {
          display: none;
        }
        .ring-wrap {
          gap: min(2cqh, 2cqw);
        }
      }
    `,
  ];

  protected override themeOverrides(config: ProgressConfig) {
    return { background: config.background, foreground: config.foreground };
  }

  protected override renderEmpty(reason: string): TemplateResult {
    if (this.config?.emptyText) {
      return emptyState({ title: this.config.emptyText });
    }
    return super.renderEmpty(reason);
  }

  protected override renderContent(data: ProgressData | null): TemplateResult {
    if (!data || !this.config) return html``;
    const display = progressDisplay(
      this.config,
      data,
      {
        current: data.current,
        valueField: data.valueField,
        labelValue: data.labelValue,
        labelField: data.labelField,
      },
      this.context.locale,
    );
    const view = {
      label: display.label,
      valueText: display.valueText,
      percentText: display.percentText,
      percent: data.percent,
      complete: data.complete,
      completionText: this.config.completionText,
      style: data.style,
    };
    return html`<div class="progress-wrap">
      ${
        view.style === "ring"
          ? this.renderRing(view)
          : view.style === "thermometer"
            ? this.renderThermometer(view)
            : this.renderBar(view)
      }
    </div>`;
  }

  private renderBar(view: {
    label: string;
    valueText: string;
    percentText: string;
    percent: number;
    complete: boolean;
    completionText: string;
  }): TemplateResult {
    const fill = Math.max(0, Math.min(100, view.percent));
    return html`${
        view.label
          ? html`<div class="progress-label">${view.label}</div>`
          : nothing
      }
      <div class="progress-main">${view.valueText}</div>
      ${
        view.percentText
          ? html`<div class="progress-sub">${view.percentText}</div>`
          : nothing
      }
      ${
        view.complete && view.completionText
          ? html`<div class="progress-sub">${view.completionText}</div>`
          : nothing
      }
      <div
        class="bar-track"
        role="img"
        aria-label=${`${view.valueText}, ${view.percentText}`}
      >
        <div class="bar-fill" style="width:${fill}%"></div>
      </div>`;
  }

  private renderRing(view: {
    label: string;
    valueText: string;
    percentText: string;
    percent: number;
    complete: boolean;
    completionText: string;
  }): TemplateResult {
    const fill = Math.max(0, Math.min(100, view.percent));
    const radius = 44;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - fill / 100);
    const label = `${view.valueText}${view.percentText ? `, ${view.percentText}` : ""}`;
    return html`${
        view.label
          ? html`<div class="progress-label">${view.label}</div>`
          : nothing
      }
      <div class="ring-wrap">
        <svg
          class="ring-svg"
          viewBox="0 0 100 100"
          role="img"
          aria-label=${label}
        >
          <circle
            cx="50"
            cy="50"
            r=${radius}
            fill="none"
            stroke="var(--tc-color-surface)"
            stroke-width="10"
          ></circle>
          <circle
            cx="50"
            cy="50"
            r=${radius}
            fill="none"
            stroke="currentColor"
            stroke-width="10"
            stroke-linecap="round"
            stroke-dasharray=${circumference.toFixed(2)}
            stroke-dashoffset=${offset.toFixed(2)}
            transform="rotate(-90 50 50)"
          ></circle>
        </svg>
        <div>
          <div class="ring-center">${view.valueText}</div>
          ${
            view.percentText
              ? html`<div class="progress-sub">${view.percentText}</div>`
              : nothing
          }
          ${
            view.complete && view.completionText
              ? html`<div class="progress-sub">${view.completionText}</div>`
              : nothing
          }
        </div>
      </div>`;
  }

  private renderThermometer(view: {
    label: string;
    valueText: string;
    percentText: string;
    percent: number;
    complete: boolean;
    completionText: string;
  }): TemplateResult {
    const fill = Math.max(0, Math.min(100, view.percent));
    const label = `${view.valueText}${view.percentText ? `, ${view.percentText}` : ""}`;
    return html`${
        view.label
          ? html`<div class="progress-label">${view.label}</div>`
          : nothing
      }
      <div class="thermo-wrap">
        <div class="thermo-tube" role="img" aria-label=${label}>
          <div class="thermo-fill" style="height:${fill}%"></div>
        </div>
        <div class="thermo-side">
          <div class="progress-main">${view.valueText}</div>
          ${
            view.percentText
              ? html`<div class="progress-sub">${view.percentText}</div>`
              : nothing
          }
          ${
            view.complete && view.completionText
              ? html`<div class="progress-sub">${view.completionText}</div>`
              : nothing
          }
        </div>
      </div>`;
  }
}
