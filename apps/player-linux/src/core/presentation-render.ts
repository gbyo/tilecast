/**
 * Declarative (v13) presentation → render-tree projection.
 *
 * Walks a PresentationNode tree, resolving data bindings, repeats,
 * conditionals, and typed formatting against normalized datasets. This is the
 * forward-looking rendering path: new release-defined widgets ship as node
 * trees and render here with no player update. Unknown node types degrade to
 * an empty box rather than failing the whole presentation.
 */

import {
  formatValue,
  resolveRegionalFormatting,
  safeColor,
  type RegionalFormatting,
  type ValueFormat,
} from "./format";
import { parseCountdownFormat } from "./countdown";
import { qrDataUri } from "./qr";
import type { NormalizedSource } from "./datasource";
import type {
  PresentationBinding,
  PresentationCondition,
  PresentationNode,
} from "./content-types";
import type { BoxStyle, RenderNode, TextStyle } from "./render-tree";
import { isAvailableAt } from "./content-availability";
import type { ManifestAsset } from "./types";

export interface PresentationContext {
  datasets: Map<string, NormalizedSource>;
  at: Date;
  /** Manifest assets available to the runtime presentation. */
  assets?: readonly ManifestAsset[];
  /** Current repeat record and index, set while expanding a repeat. */
  record?: Record<string, string>;
  recordRaw?: Record<string, string>;
  repeatIndex?: number;
  recordCurrencies?: Record<string, string>;
  recordTypes?: Record<string, string>;
  regionalFormat?: RegionalFormatting;
}

function styleFromProps(props: Record<string, unknown>): BoxStyle {
  const style: BoxStyle = {};
  if (typeof props["background"] === "string")
    style.background = safeColor(props["background"], "#0E141B");
  if (typeof props["color"] === "string")
    style.color = safeColor(props["color"], "#F5F7FA");
  if (Number.isFinite(Number(props["padding"])))
    style.padding = Number(props["padding"]);
  if (Number.isFinite(Number(props["gap"]))) style.gap = Number(props["gap"]);
  if (Number.isFinite(Number(props["radius"])))
    style.radius = Number(props["radius"]);
  if (Number.isFinite(Number(props["opacity"])))
    style.opacity = Number(props["opacity"]);
  const justify = props["justify"];
  if (typeof justify === "string")
    style.justify = justify as BoxStyle["justify"];
  const align = props["align"];
  if (typeof align === "string") style.align = align as BoxStyle["align"];
  return style;
}

/**
 * Base typography per text role, in px against the widget's own box. The
 * author's `textScale` multiplies these and `autoFit` shrinks whatever still
 * overflows, so the content always lands inside the surface's margins.
 */
const ROLE_FONT_PX: Record<string, number> = {
  metric: 88,
  title: 44,
  subtitle: 30,
  label: 30,
  body: 24,
  caption: 20,
};

function clampNumber(value: number, low: number, high: number): number {
  return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low;
}

function textStyleFromProps(
  props: Record<string, unknown>,
  textScale = 1,
): TextStyle {
  const style: TextStyle = {};
  if (typeof props["color"] === "string")
    style.color = safeColor(props["color"], "#F5F7FA");
  const role = typeof props["role"] === "string" ? props["role"] : "body";
  const base = Number.isFinite(Number(props["fontSize"]))
    ? Number(props["fontSize"])
    : (ROLE_FONT_PX[role] ?? ROLE_FONT_PX["body"]!);
  style.fontSize = base * textScale;
  // Fit-to-bounds is the final guard: an enlarged scale may overflow the
  // content area, and the renderer shrinks it back rather than clipping.
  style.autoFit = true;
  style.minFontSize = 8;
  if (
    props["fontWeight"] === undefined &&
    (role === "metric" || role === "title")
  )
    style.fontWeight = 700;
  if (Number.isFinite(Number(props["fontWeight"])))
    style.fontWeight = Number(props["fontWeight"]);
  const align = props["align"] ?? props["textAlign"];
  if (align === "left" || align === "center" || align === "right")
    style.align = align;
  if (Number.isFinite(Number(props["maxLines"])))
    style.maxLines = Number(props["maxLines"]);
  return style;
}

/** Resolve a binding to a display string in the current context. */
export function resolveBinding(
  binding: PresentationBinding | null | undefined,
  ctx: PresentationContext,
): string {
  if (!binding) {
    return "";
  }
  let raw: string | number | null | undefined;
  let source: NormalizedSource | undefined;
  let currency: string | undefined;
  let inferredFormat = "";
  switch (binding.source) {
    case "literal":
      raw = binding.value ?? "";
      break;
    case "repeat":
      inferredFormat = ctx.recordTypes?.[binding.path ?? ""] ?? "";
      raw =
        ctx.recordRaw?.[binding.path ?? ""] ??
        ctx.record?.[binding.path ?? ""] ??
        "";
      currency = ctx.recordCurrencies?.[binding.path ?? ""];
      break;
    case "repeat_index":
      raw = (ctx.repeatIndex ?? 0) + 1;
      break;
    case "environment": {
      // A time or date spec lives entirely in the format string, and formatValue knows
      // nothing about those compound formats, so it is resolved and returned here.
      const environment = parseEnvironmentFormat(binding.format ?? "");
      if (environment) {
        return formatEnvironment(
          environment,
          ctx.at,
          ctx.regionalFormat ?? resolveRegionalFormatting(undefined),
        );
      }
      raw = resolveEnvironment(binding.path ?? "", ctx.at);
      break;
    }
    case "dataset": {
      source = ctx.datasets.get(datasetId(binding.dataset ?? ""));
      const resolved = resolveDatasetPath(source, binding, ctx.at);
      raw = resolved.raw;
      inferredFormat = resolved.type;
      const field = binding.path?.split(".").at(-1) ?? "";
      currency = source?.fieldCurrencies[field];
      break;
    }
    default:
      raw = "";
  }
  const formatted = formatValue(raw ?? "", {
    format: (binding.format || inferredFormat || "text") as ValueFormat,
    precision: binding.precision ?? 0,
    prefix: binding.prefix,
    suffix: binding.suffix,
    timezone: ctx.regionalFormat?.timezone,
    currency,
    regionalFormat: ctx.regionalFormat,
  });
  return formatted === "" ? (binding.fallback ?? "") : formatted;
}

function datasetId(ref: string): string {
  return ref.includes(":") ? ref.slice(0, ref.indexOf(":")) : ref;
}

function resolveDatasetPath(
  source: NormalizedSource | undefined,
  binding: PresentationBinding,
  at: Date,
): { raw: string; type: string } {
  if (!source) {
    return { raw: "", type: "" };
  }
  // A path like "0.title" or "title" (first record). Repeats bind via record.
  const path = binding.path ?? "";
  const parts = path.split(".");
  let index = 0;
  let field = path;
  if (parts.length === 2 && /^\d+$/.test(parts[0]!)) {
    index = Number(parts[0]);
    field = parts[1]!;
  }
  // Object Data Sources expose one value map instead of records. It takes precedence so
  // an object binding resolves even when the same source also carries records.
  const objectValue = source.objectValues[field];
  if (objectValue !== undefined && objectValue !== "") {
    return {
      raw: source.rawObjectValues[field] ?? objectValue,
      type: source.fieldTypes[field] ?? "",
    };
  }
  const record = temporalRecords(source.records, binding, at)[index];
  if (!record) {
    return { raw: "", type: source.fieldTypes[field] ?? "" };
  }
  if (binding.fields && binding.fields.length > 0) {
    return {
      raw: binding.fields
        .map((f) => record.fields[f] ?? "")
        .filter(Boolean)
        .join(binding.separator || " "),
      type: "text",
    };
  }
  return {
    raw: record.rawFields[field] ?? record.fields[field] ?? "",
    type: source.fieldTypes[field] ?? "",
  };
}

function temporalRecords(
  records: NormalizedSource["records"],
  selection: Pick<PresentationBinding, "selector" | "startField" | "endField">,
  at: Date,
): NormalizedSource["records"] {
  const selector = selection.selector ?? "all";
  if (selector === "all") return records;
  const startField = selection.startField ?? "";
  if (!startField) return [];
  const now = at.getTime();
  const timed = records
    .map((record) => {
      const start = Date.parse(
        record.rawFields[startField] ?? record.fields[startField] ?? "",
      );
      const end = Date.parse(
        record.rawFields[selection.endField ?? ""] ??
          record.fields[selection.endField ?? ""] ??
          "",
      );
      return { record, start, end };
    })
    .filter((entry) => Number.isFinite(entry.start))
    .sort((left, right) => left.start - right.start);
  const current = timed
    .filter(
      (entry) =>
        entry.start <= now && Number.isFinite(entry.end) && entry.end > now,
    )
    .map((entry) => entry.record);
  const upcoming = timed
    .filter((entry) => entry.start > now)
    .map((entry) => entry.record);
  switch (selector) {
    case "current":
      return current;
    case "next":
      return upcoming.slice(0, 1);
    case "upcoming":
      return upcoming;
    case "current_or_next":
      return current.length > 0 ? current : upcoming.slice(0, 1);
    default:
      return [];
  }
}

function resolveEnvironment(path: string, at: Date): string {
  switch (path) {
    case "date":
      return at.toISOString().slice(0, 10);
    case "time":
      return at.toISOString().slice(11, 16);
    // The compiler names the clock "currentTime" and packs the rest of the spec into the
    // format string; a binding that asks for it without one still gets the instant.
    case "currentTime":
    case "datetime":
      return at.toISOString();
    default:
      return "";
  }
}

/**
 * The time and date halves of the environment format vocabulary the Server compiles
 * Clock, Date, and World Clock into: "time:<12|24>:<seconds>:<zone>" and
 * "date:<short|medium|long|full>:<zone>". Countdown formats are parsed separately, in
 * countdown.ts, because they project to a self-updating node rather than to a string.
 */
type EnvironmentFormat =
  | { kind: "time"; hour12?: boolean; showSeconds: boolean; timezone: string }
  | { kind: "date"; format: ValueFormat; timezone: string };

export function parseEnvironmentFormat(
  format: string,
): EnvironmentFormat | null {
  const parts = format.split(":");
  if (parts[0] === "time") {
    return {
      kind: "time",
      hour12: parts[1] === "locale" ? undefined : parts[1] !== "24",
      showSeconds: parts[2] === "true",
      timezone: parts[3] || "",
    };
  }
  if (parts[0] === "date") {
    const style = parts[1] ?? "full";
    return {
      kind: "date",
      format:
        style === "locale"
          ? "date"
          : style === "short" || style === "medium"
            ? "date-short"
            : "date-long",
      timezone: parts[2] || "",
    };
  }
  return null;
}

function formatEnvironment(
  format: EnvironmentFormat,
  at: Date,
  regional: RegionalFormatting,
): string {
  if (format.kind === "date") {
    return formatValue(at.toISOString(), {
      format: format.format,
      timezone: format.timezone || regional.timezone,
      regionalFormat: regional,
    });
  }
  try {
    return new Intl.DateTimeFormat(regional.locale, {
      timeZone: format.timezone || regional.timezone,
      hour: "numeric",
      minute: "2-digit",
      second: format.showSeconds ? "2-digit" : undefined,
      hour12:
        format.hour12 ??
        (regional.timeFormat === "locale"
          ? undefined
          : regional.timeFormat === "12-hour"),
    }).format(at);
  } catch {
    return at.toLocaleTimeString(regional.locale);
  }
}

function evaluateCondition(
  condition: PresentationCondition,
  ctx: PresentationContext,
): boolean {
  const left = resolveBinding(condition.binding, ctx);
  const right = condition.value ?? "";
  const ln = Number(left);
  const rn = Number(right);
  const numeric = Number.isFinite(ln) && Number.isFinite(rn);
  switch (condition.op) {
    case "equals":
      return left === right;
    case "not_equals":
      return left !== right;
    case "empty":
      return left === "";
    case "not_empty":
      return left !== "";
    case "greater_than":
      return numeric ? ln > rn : left > right;
    case "greater_or_equal":
      return numeric ? ln >= rn : left >= right;
    case "less_than":
      return numeric ? ln < rn : left < right;
    case "less_or_equal":
      return numeric ? ln <= rn : left <= right;
    case "before":
      return Date.parse(left) < Date.parse(right);
    case "after":
      return Date.parse(left) > Date.parse(right);
    default:
      return true;
  }
}

/** Evaluate the optional root-level empty signal used by fullscreen autoskip. */
export function presentationSignalsEmpty(
  root: PresentationNode,
  ctx: PresentationContext,
): boolean {
  if (root.props?.["autoSkipWhenEmpty"] !== true) return false;
  const candidate = root.props["emptyCondition"];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return false;
  const condition = candidate as unknown as PresentationCondition;
  return (
    typeof condition.op === "string" &&
    !!condition.binding &&
    evaluateCondition(condition, ctx)
  );
}

const MAX_NODES = 500;

/** Project a presentation node tree into a render tree. */
export function renderPresentation(
  root: PresentationNode,
  ctx: PresentationContext,
): RenderNode | null {
  let budget = MAX_NODES;
  // The surface carries the author's sizing for the whole widget; text nodes
  // below it multiply their role typography by this.
  let textScale = 1;
  const project = (
    node: PresentationNode,
    local: PresentationContext,
  ): RenderNode[] => {
    if (budget-- <= 0) {
      return [];
    }
    // Conditional gate.
    if (node.condition && !evaluateCondition(node.condition, local)) {
      return [];
    }
    // Repeat expansion: emit one subtree per record.
    if (node.repeat) {
      const source = local.datasets.get(datasetId(node.repeat.dataset));
      const offset = Math.max(0, node.repeat.offset ?? 0);
      const records = temporalRecords(
        source?.records ?? [],
        node.repeat,
        local.at,
      ).slice(offset, offset + Math.max(1, node.repeat.limit));
      const out: RenderNode[] = [];
      records.forEach((record, i) => {
        const child = projectSelf(node, {
          ...local,
          record: record.fields,
          recordRaw: record.rawFields,
          repeatIndex: i,
          recordCurrencies: source?.fieldCurrencies,
          recordTypes: source?.fieldTypes,
        });
        if (child) {
          out.push(child);
        }
      });
      return out;
    }
    const self = projectSelf(node, local);
    return self ? [self] : [];
  };

  const projectSelf = (
    node: PresentationNode,
    local: PresentationContext,
  ): RenderNode | null => {
    const props = node.props ?? {};
    if (node.type === "surface") {
      // contentPadding/textScale reach the player as author percentages. The
      // padding is a fraction of each edge — 10 gives the content the center
      // 80 percent — so it becomes an inset child box rather than pixels.
      const padding = clampNumber(
        Number(props["paddingPercent"] ?? props["padding"] ?? 10),
        0,
        40,
      );
      textScale = clampNumber(Number(props["textScale"] ?? 100), 25, 500) / 100;
      const inset = 100 - padding * 2;
      const surfaceStyle = styleFromProps(props);
      delete surfaceStyle.padding;
      // The compiler names the surface colour "backgroundColor"; styleFromProps
      // only knows the generic "background" key, so it would otherwise be lost.
      if (typeof props["backgroundColor"] === "string")
        surfaceStyle.background = safeColor(
          props["backgroundColor"],
          "#0E141B",
        );
      const content = (node.children ?? []).flatMap((c) => project(c, local));
      return {
        t: "box",
        style: {
          ...surfaceStyle,
          width: 100,
          height: 100,
          direction: "column",
          justify: "center",
          align: "center",
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
              gap: surfaceStyle.gap,
            },
            children: content,
          },
        ],
      };
    }
    const children = (node.children ?? []).flatMap((c) => project(c, local));

    switch (node.type) {
      case "box":
      case "stack":
        return { t: "box", style: styleFromProps(props), children };
      case "row":
        return {
          t: "box",
          style: { ...styleFromProps(props), direction: "row" },
          children,
        };
      case "column":
      case "grouped_sections":
        return {
          t: "box",
          style: { ...styleFromProps(props), direction: "column" },
          children,
        };
      case "grid": {
        const cols = Number(props["columns"]) || 2;
        return {
          t: "box",
          style: { ...styleFromProps(props), columns: `repeat(${cols}, 1fr)` },
          children,
        };
      }
      case "repeat":
      case "conditional":
        // Wrapper node whose effect is its expanded children.
        return {
          t: "box",
          style: { ...styleFromProps(props), direction: "column" },
          children,
        };
      case "spacer":
        return { t: "spacer", grow: Number(props["grow"]) || 1 };
      case "divider":
        return {
          t: "divider",
          color: safeColor(String(props["color"] ?? ""), "#2A3644"),
          vertical: props["vertical"] === true,
        };
      case "text":
      case "badge": {
        if (node.binding?.format === "relative-countdown") {
          const target = resolveBinding(
            {
              ...node.binding,
              format: "text",
              prefix: undefined,
              suffix: undefined,
            },
            local,
          );
          if (!target) {
            return {
              t: "text",
              value: node.binding.fallback ?? "",
              style: textStyleFromProps(props, textScale),
            };
          }
          return {
            t: "countdown",
            target,
            timezone: "UTC",
            recurrence: "none",
            countUp: false,
            showDays: true,
            showHours: true,
            showMinutes: true,
            showSeconds: true,
            completionText: "Now",
            completionAction: "completed_text",
            compact: true,
            prefix: node.binding.prefix,
            suffix: node.binding.suffix,
            style: textStyleFromProps(props, textScale),
          };
        }
        const countdown = node.binding
          ? parseCountdownFormat(node.binding.format ?? "")
          : null;
        if (countdown) {
          return {
            t: "countdown",
            target: countdown.target,
            timezone: countdown.timezone,
            recurrence: countdown.recurrence,
            countUp: countdown.mode === "count_up",
            showDays: countdown.visibleUnits[0] === "1",
            showHours: countdown.visibleUnits[1] === "1",
            showMinutes: countdown.visibleUnits[2] === "1",
            showSeconds: countdown.visibleUnits[3] === "1",
            completionText: countdown.completionText,
            completionAction: countdown.completionAction,
            style: textStyleFromProps(props, textScale),
          };
        }
        // A clock has to keep ticking, so it becomes the self-updating clock node rather
        // than a string frozen at the moment the tree was projected. A date is left as
        // text: it changes once a day, which the next projection picks up.
        const environment =
          node.binding?.source === "environment"
            ? parseEnvironmentFormat(node.binding.format ?? "")
            : null;
        if (environment?.kind === "time") {
          return {
            t: "clock",
            timezone: environment.timezone,
            hour12: environment.hour12,
            showSeconds: environment.showSeconds,
            style: textStyleFromProps(props, textScale),
          };
        }
        const value = node.binding
          ? resolveBinding(node.binding, local)
          : String(props["text"] ?? "");
        return {
          t: "text",
          value,
          style: textStyleFromProps(props, textScale),
        };
      }
      case "icon":
        return {
          t: "text",
          value: String(props["glyph"] ?? "•"),
          style: textStyleFromProps(props, textScale),
        };
      case "asset_image": {
        const assetId = node.binding
          ? resolveBinding(node.binding, local)
          : String(props["assetId"] ?? "");
        const variantId = String(props["variantId"] ?? "");
        if (!assetId) {
          return null;
        }
        // Declarative widgets can reference assets through bindings. The
        // server validates the graph before publishing, but the player must
        // still enforce the same exact-variant and availability contract when
        // a cached manifest crosses an availability boundary.
        if (
          ctx.assets &&
          !ctx.assets.some(
            (asset) =>
              asset.assetId === assetId &&
              asset.variantId === variantId &&
              isAvailableAt(asset, local.at),
          )
        ) {
          return null;
        }
        return {
          t: "image",
          src: `tcmedia://variant/${assetId}/${variantId}`,
          fit: String(props["fit"] ?? "contain"),
        };
      }
      case "qr_code": {
        const value = node.binding
          ? resolveBinding(node.binding, local)
          : String(props["value"] ?? "");
        return {
          t: "qr",
          src: qrDataUri(
            value,
            safeColor(String(props["foreground"] ?? ""), "#000000"),
            safeColor(String(props["background"] ?? ""), "#FFFFFF"),
          ),
        };
      }
      case "progress": {
        const ratio = Math.min(Math.max(Number(props["value"]) || 0, 0), 1);
        return {
          t: "progress",
          ratio,
          color: safeColor(String(props["color"] ?? ""), "#4C8BF5"),
          track: safeColor(String(props["track"] ?? ""), "#2A3644"),
        };
      }
      case "marquee": {
        const value = node.binding
          ? resolveBinding(node.binding, local)
          : String(props["text"] ?? "");
        return {
          t: "marquee",
          text: value,
          durationMs: Number(props["durationMs"]) || 18_000,
          direction: props["direction"] === "right" ? "right" : "left",
          style: textStyleFromProps(props, textScale),
        };
      }
      case "line_chart":
      case "bar_chart":
      case "donut_chart":
        return renderChart(node, local, props);
      default:
        return { t: "box", style: {}, children };
    }
  };

  const result = project(root, ctx);
  return result[0] ?? null;
}

function renderChart(
  node: PresentationNode,
  ctx: PresentationContext,
  props: Record<string, unknown>,
): RenderNode {
  const chart =
    node.type === "bar_chart"
      ? "bar"
      : node.type === "donut_chart"
        ? "donut"
        : "line";
  const datasetRef = String(props["dataset"] ?? "");
  const source = ctx.datasets.get(
    datasetRef.includes(":")
      ? datasetRef.slice(0, datasetRef.indexOf(":"))
      : datasetRef,
  );
  const valueField = String(props["valueField"] ?? "value");
  const labelField = String(props["labelField"] ?? "label");
  const records = source?.records ?? [];
  const series = records.map(
    (r) => Number(r.rawFields[valueField] ?? r.fields[valueField]) || 0,
  );
  const labels = records.map((r) => r.fields[labelField] ?? "");
  const palette = Array.isArray(props["colors"])
    ? (props["colors"] as string[]).map((c) => safeColor(c, "#4C8BF5"))
    : ["#4C8BF5", "#34C759", "#FF9F0A", "#FF375F", "#BF5AF2"];
  return {
    t: "chart",
    chart,
    series,
    labels,
    colors: palette,
    style: styleFromProps(props),
  };
}
