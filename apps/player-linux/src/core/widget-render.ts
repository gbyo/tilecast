/**
 * Native widget → render-tree projection.
 *
 * Covers the release widget catalog (clock, date, qrcode, countdown, ticker,
 * metric, cards, weather, menu/list/table/agenda). Data-driven widgets read
 * their referenced data source through the normalizer, so schema 11/12/13 all
 * flow through one path. When a widget carries a v13 declarative
 * `presentation`, that path takes over (see presentation-render).
 *
 * Output is the fully-resolved render-tree IR; no data logic reaches the
 * renderer.
 */

import {
  formatValue,
  resolveRegionalFormatting,
  safeColor,
  type RegionalFormatting,
  type ValueFormat,
} from "./format";
import type { CountdownRecurrence } from "./countdown";
import { normalizeSource, type NormalizedSource } from "./datasource";
import { qrDataUri } from "./qr";
import {
  presentationSignalsEmpty,
  renderPresentation,
} from "./presentation-render";
import type { ManifestDataSource, ManifestWidget } from "./content-types";
import type { ManifestAsset } from "./types";
import type { RenderNode, WidgetRenderPayload } from "./render-tree";

const DEFAULT_FG = "#F5F7FA";
const DEFAULT_BG = "#0E141B";

export interface WidgetRenderContext {
  dataSources: Map<string, ManifestDataSource>;
  assets?: readonly ManifestAsset[];
  at: Date;
  regionalFormat?: RegionalFormatting;
  /** Pixel height available, used to scale font sizes sensibly. */
  zoneHeight?: number;
}

function num(
  config: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = Number(config[key]);
  return Number.isFinite(v) ? v : fallback;
}

function str(
  config: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const v = config[key];
  return v === undefined || v === null ? fallback : String(v);
}

function bool(
  config: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const v = config[key];
  return typeof v === "boolean" ? v : fallback;
}

/** textScale is an author percentage (25–500), not a raw multiplier. */
function scale(base: number, config: Record<string, unknown>): number {
  const textScale = Number(config["textScale"]);
  if (!Number.isFinite(textScale) || textScale <= 0) {
    return base;
  }
  return (base * Math.min(500, Math.max(25, textScale))) / 100;
}

/**
 * contentPadding is an author percentage of each edge (10 gives the content
 * the center 80 percent), so it becomes a percentage-sized inset rather than
 * pixels. Returns the inset box's width/height as a percentage of the widget.
 */
function contentInset(config: Record<string, unknown>): number {
  return 100 - 2 * Math.min(40, Math.max(0, num(config, "contentPadding", 10)));
}

/** Resolve one widget into a render payload, or null if it cannot render. */
export function renderWidget(
  widget: ManifestWidget,
  ctx: WidgetRenderContext,
): WidgetRenderPayload | null {
  const regionalFormat =
    ctx.regionalFormat ?? resolveRegionalFormatting(undefined);
  // v13 declarative presentation takes precedence.
  if (widget.presentation?.kind === "native" && widget.presentation.native) {
    const datasets = new Map<string, NormalizedSource>();
    for (const [id, source] of ctx.dataSources) {
      datasets.set(id, normalizeSource(source, ctx.at, regionalFormat));
    }
    const root = renderPresentation(widget.presentation.native.root, {
      datasets,
      at: ctx.at,
      assets: ctx.assets,
      regionalFormat,
    });
    // The surface carries the author's background, so the payload reports it rather than
    // letting the default show through wherever the payload background is used.
    const background =
      (root?.t === "box" ? root.style.background : undefined) ?? DEFAULT_BG;
    const autoSkip = presentationSignalsEmpty(widget.presentation.native.root, {
      datasets,
      at: ctx.at,
      regionalFormat,
    });
    return { background, root: root ?? emptyNode(""), autoSkip };
  }

  const config = widget.configuration ?? {};
  const fg = safeColor(str(config, "foregroundColor"), DEFAULT_FG);
  const bg = safeColor(str(config, "backgroundColor"), DEFAULT_BG);

  const inset = contentInset(config);

  const centered = (root: RenderNode): WidgetRenderPayload => ({
    background: bg,
    root: {
      t: "box",
      style: {
        width: 100,
        height: 100,
        direction: "column",
        justify: "center",
        align: "center",
        background: bg,
        color: fg,
      },
      children: [
        {
          t: "box",
          style: {
            width: inset,
            height: inset,
            direction: "column",
            justify: "center",
            align: "center",
            color: fg,
            gap: 12,
          },
          children: [root],
        },
      ],
    },
  });

  switch (widget.provider) {
    case "clock":
      return centered({
        t: "clock",
        timezone: str(config, "timezone") || regionalFormat.timezone,
        locale: regionalFormat.locale,
        hour12:
          str(config, "format", "locale") === "12"
            ? true
            : str(config, "format", "locale") === "24"
              ? false
              : regionalFormat.timeFormat === "locale"
                ? undefined
                : regionalFormat.timeFormat === "12-hour",
        showSeconds: bool(config, "showSeconds", false),
        style: {
          color: fg,
          fontSize: scale(96, config),
          fontWeight: 700,
          align: "center",
        },
      });

    case "date":
      return centered({
        t: "text",
        value: formatValue(ctx.at.toISOString(), {
          format: dateFormatFor(str(config, "format", "full")),
          timezone: str(config, "timezone") || regionalFormat.timezone,
          regionalFormat,
        }),
        style: {
          color: fg,
          fontSize: scale(64, config),
          fontWeight: 600,
          align: "center",
        },
      });

    case "qrcode":
      return centered({
        t: "qr",
        src: qrDataUri(
          str(config, "value"),
          safeColor(str(config, "foregroundColor"), "#000000"),
          safeColor(str(config, "backgroundColor"), "#FFFFFF"),
          str(config, "errorCorrection", "medium"),
        ),
        label: str(config, "label") || undefined,
      });

    case "countdown": {
      const target = str(config, "target");
      if (!target) {
        return centered(
          textNode(str(config, "label") || "Countdown", fg, scale(48, config)),
        );
      }
      const completion = str(config, "completionAction", "completed_text");
      const recurrence = str(
        config,
        "recurrence",
        "none",
      ) as CountdownRecurrence;
      const layout = str(config, "layout", "stacked");
      const label =
        layout !== "countdown_only" && str(config, "label")
          ? [textNode(str(config, "label"), fg, scale(40, config))]
          : [];
      const countdown: RenderNode = {
        t: "countdown",
        target,
        timezone: str(config, "timezone", "UTC"),
        recurrence,
        countUp: str(config, "mode", "countdown") === "count_up",
        showDays: bool(config, "showDays", true),
        showHours: bool(config, "showHours", true),
        showMinutes: bool(config, "showMinutes", true),
        showSeconds: bool(config, "showSeconds", false),
        completionText: str(config, "completionText"),
        completionAction:
          completion === "hide" || completion === "count_up"
            ? completion
            : "completed_text",
        style: {
          color: fg,
          fontSize: scale(88, config),
          fontWeight: 700,
          align: "center",
          autoFit: true,
          minFontSize: 8,
        },
      };
      return {
        background: bg,
        root: {
          t: "box",
          style: {
            width: 100,
            height: 100,
            direction: "column",
            justify: "center",
            align: "center",
            background: bg,
            color: fg,
          },
          children: [
            {
              t: "box",
              style: {
                width: inset,
                height: inset,
                direction: layout === "horizontal" ? "row" : "column",
                justify: "center",
                align: "center",
                gap: 12,
                color: fg,
              },
              children: [...label, countdown],
            },
          ],
        },
      };
    }

    case "ticker":
      return renderTicker(widget, config, ctx, fg, bg);

    case "metric":
      return renderMetric(widget, config, ctx, fg, bg);

    case "cards":
      return renderCards(widget, config, ctx, fg, bg);

    case "weather":
      return renderWeather(widget, config, ctx, fg, bg);

    case "menu":
    case "list":
    case "table":
    case "agenda":
      return renderDisplay(widget, config, ctx, fg, bg);

    default:
      return null;
  }
}

function dateFormatFor(format: string): ValueFormat {
  return format === "short" || format === "medium" || format === "locale"
    ? "date-short"
    : "date-long";
}

function textNode(value: string, color: string, fontSize: number): RenderNode {
  return {
    t: "text",
    value,
    style: { color, fontSize, align: "center", autoFit: true, minFontSize: 8 },
  };
}

function emptyNode(message: string): RenderNode {
  return {
    t: "text",
    value: message,
    style: { color: "#8A94A6", fontSize: 32, align: "center" },
  };
}

function resolveSource(
  config: Record<string, unknown>,
  ctx: WidgetRenderContext,
): NormalizedSource | null {
  const id = str(config, "dataSourceId");
  const source = id ? ctx.dataSources.get(id) : undefined;
  return source
    ? normalizeSource(
        source,
        ctx.at,
        ctx.regionalFormat ?? resolveRegionalFormatting(undefined),
      )
    : null;
}

function renderTicker(
  _widget: ManifestWidget,
  config: Record<string, unknown>,
  ctx: WidgetRenderContext,
  fg: string,
  bg: string,
): WidgetRenderPayload {
  const source = resolveSource(config, ctx);
  const fields = (Array.isArray(config["fields"])
    ? (config["fields"] as string[])
    : null) ?? [str(config, "field", "title")];
  const fieldSep = str(config, "fieldSeparator", " — ");
  const sep = str(config, "separator", " • ");
  const items = (source?.records ?? []).map((r) =>
    fields
      .map((f) => r.fields[f] ?? "")
      .filter(Boolean)
      .join(fieldSep),
  );
  const text =
    items.filter(Boolean).join(sep) ||
    str(config, "emptyState", "No items available");
  const speed = str(config, "speed", "normal");
  const durationMs =
    speed === "slow" ? 30_000 : speed === "fast" ? 10_000 : 18_000;
  return {
    background: bg,
    root: {
      t: "box",
      style: {
        width: 100,
        height: 100,
        background: bg,
        align: "center",
        justify: "center",
      },
      children: [
        {
          t: "marquee",
          text,
          durationMs,
          direction:
            str(config, "direction", "left") === "right" ? "right" : "left",
          style: { color: fg, fontSize: scale(48, config), fontWeight: 600 },
        },
      ],
    },
  };
}

function renderMetric(
  _widget: ManifestWidget,
  config: Record<string, unknown>,
  ctx: WidgetRenderContext,
  fg: string,
  bg: string,
): WidgetRenderPayload {
  const source = resolveSource(config, ctx);
  const record = source?.records[0];
  const valueField = str(config, "valueField");
  const raw = record?.rawFields[valueField] ?? record?.fields[valueField];
  const value =
    raw === undefined
      ? str(config, "emptyState", "No value available")
      : formatValue(raw, {
          format: str(config, "format", "number") as ValueFormat,
          precision: num(config, "precision", 0),
          prefix: str(config, "prefix"),
          suffix: str(config, "suffix"),
          currency: source?.fieldCurrencies[valueField],
          regionalFormat: ctx.regionalFormat,
        });
  const label =
    str(config, "label") ||
    (record && str(config, "labelField")
      ? (record.fields[str(config, "labelField")] ?? "")
      : "");
  return {
    background: bg,
    root: {
      t: "box",
      style: {
        width: 100,
        height: 100,
        direction: "column",
        justify: "center",
        align: "center",
        background: bg,
      },
      children: [
        {
          t: "box",
          style: {
            width: contentInset(config),
            height: contentInset(config),
            direction: "column",
            justify: "center",
            align: "center",
            gap: 8,
          },
          children: [
            {
              t: "text",
              value,
              style: {
                color: fg,
                fontSize: scale(120, config),
                fontWeight: 800,
                align: "center",
                autoFit: true,
                minFontSize: 8,
              },
            },
            ...(label ? [textNode(label, fg, scale(40, config))] : []),
          ],
        },
      ],
    },
  };
}

function renderCards(
  _widget: ManifestWidget,
  config: Record<string, unknown>,
  ctx: WidgetRenderContext,
  fg: string,
  bg: string,
): WidgetRenderPayload {
  const source = resolveSource(config, ctx);
  const max = num(config, "maximumItems", 6);
  const columns = Math.min(Math.max(num(config, "columns", 2), 1), 4);
  const records = (source?.records ?? []).slice(0, max);
  const titleField = str(config, "titleField", "title");
  const cards: RenderNode[] = records.map((r) => ({
    t: "box",
    style: {
      direction: "column",
      gap: 6,
      padding: 20,
      radius: 12,
      background: "#1B2530",
      grow: 1,
    },
    children: [
      textLeft(r.fields[titleField] ?? "", fg, scale(36, config), 700),
      ...(str(config, "subtitleField") && r.fields[str(config, "subtitleField")]
        ? [
            textLeft(
              r.fields[str(config, "subtitleField")]!,
              "#B7C0CC",
              scale(28, config),
            ),
          ]
        : []),
      ...(str(config, "bodyField") && r.fields[str(config, "bodyField")]
        ? [
            textLeft(
              r.fields[str(config, "bodyField")]!,
              "#8A94A6",
              scale(24, config),
            ),
          ]
        : []),
    ],
  }));
  return {
    background: bg,
    root: {
      t: "box",
      style: {
        width: 100,
        height: 100,
        background: bg,
        padding: 32,
        gap: 16,
        columns: `repeat(${columns}, 1fr)`,
      },
      children:
        cards.length > 0
          ? cards
          : [emptyNode(str(config, "emptyState", "No items available"))],
    },
  };
}

function renderWeather(
  _widget: ManifestWidget,
  config: Record<string, unknown>,
  ctx: WidgetRenderContext,
  fg: string,
  bg: string,
): WidgetRenderPayload {
  const source = resolveSource(config, ctx);
  const days = Math.min(Math.max(num(config, "forecastDays", 5), 0), 7);
  const records = (source?.records ?? []).slice(0, days || 1);
  const columns: RenderNode[] = records.map((r) => ({
    t: "box",
    style: {
      direction: "column",
      align: "center",
      gap: 6,
      grow: 1,
      padding: 12,
    },
    children: [
      textNode(r.fields["date"] ?? "", "#B7C0CC", scale(26, config)),
      textNode(r.fields["condition"] ?? "", fg, scale(30, config)),
      textNode(
        `${r.fields["high"] ?? ""}° / ${r.fields["low"] ?? ""}°`,
        fg,
        scale(34, config),
      ),
    ],
  }));
  return {
    background: bg,
    root: {
      t: "box",
      style: {
        width: 100,
        height: 100,
        background: bg,
        padding: 24,
        gap: 12,
        justify: "space-around",
        align: "center",
      },
      children:
        columns.length > 0 ? columns : [emptyNode("Weather unavailable")],
    },
  };
}

function renderDisplay(
  widget: ManifestWidget,
  config: Record<string, unknown>,
  ctx: WidgetRenderContext,
  fg: string,
  bg: string,
): WidgetRenderPayload {
  const source = resolveSource(config, ctx);
  const max = num(config, "maximumItems", 20);
  const records = (source?.records ?? []).slice(0, max);
  const spacing =
    str(config, "rowSpacing", "comfortable") === "compact" ? 6 : 14;

  if (source?.hidden) {
    return {
      background: bg,
      root: { t: "box", style: { background: bg }, children: [] },
    };
  }
  if (records.length === 0) {
    return {
      background: bg,
      root: centeredEmpty(str(config, "emptyState", "No items available"), bg),
    };
  }

  // Table has explicit columns; menu/list/agenda use primary/secondary fields.
  if (widget.provider === "table") {
    return renderTable(
      config,
      records,
      fg,
      bg,
      spacing,
      source?.fieldTypes ?? {},
      source?.fieldCurrencies ?? {},
      ctx.regionalFormat,
    );
  }

  const primaryField =
    str(config, "primaryField") || str(config, "titleField") || "title";
  const secondaryField =
    str(config, "secondaryField") || str(config, "subtitleField");
  const rows: RenderNode[] = records.map((r) => ({
    t: "box",
    style: { direction: "column", gap: 2, padding: spacing },
    children: [
      textLeft(r.fields[primaryField] ?? "", fg, scale(38, config), 600),
      ...(secondaryField && r.fields[secondaryField]
        ? [textLeft(r.fields[secondaryField]!, "#B7C0CC", scale(28, config))]
        : []),
    ],
  }));
  return {
    background: bg,
    root: {
      t: "box",
      style: {
        width: 100,
        height: 100,
        direction: "column",
        background: bg,
        padding: 32,
        gap: bool(config, "showDividers", false) ? 0 : 4,
      },
      children: rows,
    },
  };
}

function renderTable(
  config: Record<string, unknown>,
  records: NormalizedSource["records"],
  fg: string,
  bg: string,
  spacing: number,
  fieldTypes: Record<string, string>,
  fieldCurrencies: Record<string, string>,
  regionalFormat?: RegionalFormatting,
): WidgetRenderPayload {
  const columns = Array.isArray(config["columns"])
    ? (config["columns"] as Record<string, unknown>[])
    : [];
  const header: RenderNode | null = bool(config, "showHeader", false)
    ? {
        t: "box",
        style: {
          direction: "row",
          gap: 16,
          padding: spacing,
          borderColor: "#2A3644",
          borderWidth: 0,
        },
        children: columns.map((c) =>
          textLeftGrow(str(c, "label") || str(c, "field"), "#8A94A6", 26),
        ),
      }
    : null;
  const rows: RenderNode[] = records.map((r) => ({
    t: "box",
    style: { direction: "row", gap: 16, padding: spacing },
    children: columns.map((c) => {
      const field = str(c, "field");
      const format = str(c, "format", fieldTypes[field] ?? "text");
      const raw =
        format === "text"
          ? (r.fields[field] ?? r.rawFields[field] ?? "")
          : (r.rawFields[field] ?? r.fields[field] ?? "");
      const value = formatValue(raw, {
        format: format as ValueFormat,
        precision: num(c, "precision", 0),
        prefix: str(c, "prefix"),
        suffix: str(c, "suffix"),
        currency: fieldCurrencies[str(c, "field")],
        regionalFormat,
      });
      const align = str(c, "alignment", "left");
      return {
        t: "text",
        value,
        style: {
          color: fg,
          fontSize: 30,
          grow: 1,
          align: align === "right" || align === "center" ? align : "left",
        },
      } as RenderNode;
    }),
  }));
  return {
    background: bg,
    root: {
      t: "box",
      style: {
        width: 100,
        height: 100,
        direction: "column",
        background: bg,
        padding: 32,
      },
      children: header ? [header, ...rows] : rows,
    },
  };
}

function textLeft(
  value: string,
  color: string,
  fontSize: number,
  fontWeight = 400,
): RenderNode {
  return {
    t: "text",
    value,
    style: { color, fontSize, fontWeight, align: "left" },
  };
}

function textLeftGrow(
  value: string,
  color: string,
  fontSize: number,
): RenderNode {
  return {
    t: "text",
    value,
    style: { color, fontSize, align: "left", ...({} as object) },
  };
}

function centeredEmpty(message: string, bg: string): RenderNode {
  return {
    t: "box",
    style: {
      width: 100,
      height: 100,
      justify: "center",
      align: "center",
      background: bg,
    },
    children: [emptyNode(message)],
  };
}
