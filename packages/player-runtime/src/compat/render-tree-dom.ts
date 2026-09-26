/**
 * COMPATIBILITY CODE. Draws the server-compiled RenderNode tree
 * (compat/projection/render-tree.ts) as DOM: a dumb interpreter with no data
 * logic, moved unchanged from the Electron renderer so every host draws the
 * same boxes, text, images and charts.
 *
 * This is how today's widgets and layout zones render. It is not the future
 * widget API (see src/widgets/contract.ts); do not add node types here for new
 * widget work.
 */
import type { RuntimeClock } from "../clock/scheduler";
import type { TimerGroup } from "../clock/scheduler";
import { FIT_MODES } from "../engine/model";
import { tilecastCountdownDisplay } from "./plugins/countdown-display";

export interface AnyNode {
  t: string;
  [key: string]: unknown;
}

/**
 * What a mounted tree may use. Self-updating nodes (clock, countdown) tick on
 * `timers`, which the owning surface cancels when it is disposed, so a stale
 * ticker can never keep an old CPU warm.
 */
export interface RenderScope {
  clock: RuntimeClock;
  timers: TimerGroup;
}

function px(value: unknown, fallback = ""): string {
  return typeof value === "number" ? `${value}px` : fallback;
}

function applyBoxStyle(el: HTMLElement, style: Record<string, unknown>): void {
  const s = el.style;
  if (style["background"]) s.background = String(style["background"]);
  if (style["color"]) s.color = String(style["color"]);
  if (typeof style["padding"] === "number") s.padding = px(style["padding"]);
  if (typeof style["gap"] === "number") s.gap = px(style["gap"]);
  if (typeof style["radius"] === "number") s.borderRadius = px(style["radius"]);
  if (typeof style["opacity"] === "number")
    s.opacity = String(style["opacity"]);
  if (typeof style["borderWidth"] === "number" && style["borderWidth"]) {
    s.border = `${px(style["borderWidth"])} solid ${String(style["borderColor"] ?? "#000")}`;
  }
  if (style["columns"]) {
    s.display = "grid";
    s.gridTemplateColumns = String(style["columns"]);
  } else {
    s.display = "flex";
    s.flexDirection = style["direction"] === "row" ? "row" : "column";
  }
  const justifyMap: Record<string, string> = {
    start: "flex-start",
    center: "center",
    end: "flex-end",
    "space-between": "space-between",
    "space-around": "space-around",
  };
  const alignMap: Record<string, string> = {
    start: "flex-start",
    center: "center",
    end: "flex-end",
    stretch: "stretch",
  };
  if (style["justify"])
    s.justifyContent = justifyMap[String(style["justify"])] ?? "flex-start";
  if (style["align"])
    s.alignItems = alignMap[String(style["align"])] ?? "stretch";
  if (typeof style["grow"] === "number") s.flexGrow = String(style["grow"]);
  if (typeof style["width"] === "number")
    s.width = style["width"] <= 100 ? `${style["width"]}%` : px(style["width"]);
  if (typeof style["height"] === "number")
    s.height =
      style["height"] <= 100 ? `${style["height"]}%` : px(style["height"]);
  if (style["wrap"]) s.flexWrap = "wrap";
}

function applyTextStyle(el: HTMLElement, style: Record<string, unknown>): void {
  const s = el.style;
  if (style["color"]) s.color = String(style["color"]);
  if (style["background"]) s.background = String(style["background"]);
  if (typeof style["fontSize"] === "number") s.fontSize = px(style["fontSize"]);
  if (typeof style["fontWeight"] === "number")
    s.fontWeight = String(style["fontWeight"]);
  if (style["fontFamily"])
    s.fontFamily = `${String(style["fontFamily"])}, system-ui, sans-serif`;
  if (style["align"]) s.textAlign = String(style["align"]);
  if (typeof style["lineHeight"] === "number")
    s.lineHeight = String(style["lineHeight"]);
  if (typeof style["letterSpacing"] === "number")
    s.letterSpacing = px(style["letterSpacing"]);
  if (typeof style["padding"] === "number") s.padding = px(style["padding"]);
  if (typeof style["grow"] === "number") s.flexGrow = String(style["grow"]);
  if (typeof style["maxLines"] === "number" && style["maxLines"]) {
    s.display = "-webkit-box";
    s.webkitBoxOrient = "vertical";
    (s as unknown as Record<string, string>)["WebkitLineClamp"] = String(
      style["maxLines"],
    );
    s.overflow = "hidden";
  }
  const va = style["verticalAlign"];
  if (va === "top") s.alignSelf = "flex-start";
  else if (va === "bottom") s.alignSelf = "flex-end";
  if (style["autoFit"]) {
    el.dataset["autofitMin"] = String(
      typeof style["minFontSize"] === "number" ? style["minFontSize"] : 8,
    );
    el.dataset["autofitBase"] = String(
      typeof style["fontSize"] === "number" ? style["fontSize"] : 16,
    );
    s.maxWidth = "100%";
  }
}

/**
 * Shrink one auto-fit text node until it sits inside its parent box, starting
 * over from the authored size so a value that got shorter can grow back. The
 * author's scale sets that starting size; this is the fit-to-bounds guard that
 * keeps an enlarged or unusually long value from spilling past the margins.
 */
export function fitTextElement(el: HTMLElement): void {
  const parent = el.parentElement;
  const base = Number(el.dataset["autofitBase"]);
  if (!parent || !Number.isFinite(base)) return;
  const minimum = Number(el.dataset["autofitMin"]) || 8;
  let size = base;
  el.style.fontSize = `${size}px`;
  let guard = 0;
  while (
    guard++ < 80 &&
    size > minimum &&
    (el.scrollWidth > parent.clientWidth + 1 ||
      el.scrollHeight > parent.clientHeight + 1)
  ) {
    size = Math.max(minimum, size * 0.92);
    el.style.fontSize = `${size}px`;
  }
}

/** Fit every auto-fit node in a mounted subtree. Needs real measurements. */
export function applyAutoFit(container: HTMLElement): void {
  container
    .querySelectorAll<HTMLElement>("[data-autofit-base]")
    .forEach(fitTextElement);
}

function formatClock(node: AnyNode, nowMs: number): string {
  const now = new Date(nowMs);
  const locale = String(node["locale"] ?? "en-US");
  const options: Intl.DateTimeFormatOptions = {
    timeZone: String(node["timezone"] ?? "UTC"),
    hour: "numeric",
    minute: "2-digit",
    second: node["showSeconds"] ? "2-digit" : undefined,
  };
  if (typeof node["hour12"] === "boolean") {
    options.hour12 = node["hour12"];
  } else if (!node["locale"]) {
    // Preserve the original en-US 12-hour output for clock nodes compiled by
    // older Servers, which do not carry an organization profile.
    options.hour12 = true;
  }
  try {
    return new Intl.DateTimeFormat(locale, options).format(now);
  } catch {
    return new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: "UTC",
    }).format(now);
  }
}

function formatCountdown(node: AnyNode, now: number): string {
  const recurrence = String(node["recurrence"] ?? "none");
  const target = resolveCountdownTarget(
    String(node["target"] ?? ""),
    String(node["timezone"] ?? "UTC"),
    recurrence,
    now,
  );
  let remaining = target - now;
  if (node["compact"] === true) {
    const body = tilecastCountdownDisplay.compact(remaining);
    return `${String(node["prefix"] ?? "")}${body}${String(node["suffix"] ?? "")}`;
  }
  const countUp = node["countUp"] === true;
  if (remaining <= 0 && !countUp && recurrence === "none") {
    const action = String(node["completionAction"] ?? "completed_text");
    if (action === "hide") return "";
    if (action === "count_up") remaining = now - target;
    else return String(node["completionText"] ?? "");
  } else if (remaining <= 0) {
    remaining = now - target;
  }
  const abs = Math.abs(remaining);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1_000);
  const parts: string[] = [];
  if (node["showDays"] !== false && days > 0) parts.push(`${days}d`);
  if (node["showHours"] !== false)
    parts.push(`${String(hours).padStart(2, "0")}h`);
  if (node["showMinutes"] !== false)
    parts.push(`${String(minutes).padStart(2, "0")}m`);
  if (node["showSeconds"] === true)
    parts.push(`${String(seconds).padStart(2, "0")}s`);
  return parts.join(" ");
}

function resolveCountdownTarget(
  target: string,
  timezone: string,
  recurrence: string,
  now: number,
): number {
  const zone = validCountdownTimezone(timezone);
  const original = parseCountdownTarget(target, zone);
  if (original === null || recurrence === "none") return original ?? now;

  const seed = countdownDateParts(original, zone);
  const current = countdownDateParts(now, zone);
  let date = countdownRecurringDate(seed, current, recurrence);
  let candidate = countdownZonedEpoch(
    { ...date, ...countdownTime(seed) },
    zone,
  );
  if (candidate <= now) {
    date = advanceCountdownDate(date, seed, recurrence);
    candidate = countdownZonedEpoch({ ...date, ...countdownTime(seed) }, zone);
  }
  return candidate;
}

interface CountdownDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

type CountdownDate = Pick<CountdownDateParts, "year" | "month" | "day">;

function validCountdownTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    return "UTC";
  }
}

function parseCountdownTarget(target: string, timezone: string): number | null {
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(target)) {
    const parsed = Date.parse(target);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(
      target,
    );
  if (!match) return null;
  return countdownZonedEpoch(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] ?? 0),
    },
    timezone,
  );
}

function countdownDateParts(
  epochMs: number,
  timezone: string,
): CountdownDateParts {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values["year"]!,
    month: values["month"]!,
    day: values["day"]!,
    hour: values["hour"]!,
    minute: values["minute"]!,
    second: values["second"]!,
  };
}

function countdownZonedEpoch(
  parts: CountdownDateParts,
  timezone: string,
): number {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = countdownDateParts(candidate, timezone);
    const rendered = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const adjustment = desired - rendered;
    if (adjustment === 0) break;
    candidate += adjustment;
  }
  return candidate;
}

function countdownRecurringDate(
  seed: CountdownDateParts,
  current: CountdownDateParts,
  recurrence: string,
): CountdownDate {
  if (recurrence === "daily")
    return countdownDate(current.year, current.month, current.day);
  if (recurrence === "weekly") {
    const currentDay = countdownUTCDate(current).getUTCDay();
    const seedDay = countdownUTCDate(seed).getUTCDay();
    return addCountdownDays(
      countdownDate(current.year, current.month, current.day),
      (seedDay - currentDay + 7) % 7,
    );
  }
  if (recurrence === "monthly") {
    return countdownDate(
      current.year,
      current.month,
      Math.min(seed.day, countdownDaysInMonth(current.year, current.month)),
    );
  }
  return countdownDate(
    current.year,
    seed.month,
    Math.min(seed.day, countdownDaysInMonth(current.year, seed.month)),
  );
}

function advanceCountdownDate(
  date: CountdownDate,
  seed: CountdownDateParts,
  recurrence: string,
): CountdownDate {
  if (recurrence === "daily") return addCountdownDays(date, 1);
  if (recurrence === "weekly") return addCountdownDays(date, 7);
  if (recurrence === "monthly") {
    const next = new Date(Date.UTC(date.year, date.month, 1));
    return countdownDate(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      Math.min(
        seed.day,
        countdownDaysInMonth(next.getUTCFullYear(), next.getUTCMonth() + 1),
      ),
    );
  }
  return countdownDate(
    date.year + 1,
    seed.month,
    Math.min(seed.day, countdownDaysInMonth(date.year + 1, seed.month)),
  );
}

function countdownDate(
  year: number,
  month: number,
  day: number,
): CountdownDate {
  return { year, month, day };
}

function countdownTime(
  parts: CountdownDateParts,
): Pick<CountdownDateParts, "hour" | "minute" | "second"> {
  return { hour: parts.hour, minute: parts.minute, second: parts.second };
}

function addCountdownDays(parts: CountdownDate, days: number): CountdownDate {
  const value = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return countdownDate(
    value.getUTCFullYear(),
    value.getUTCMonth() + 1,
    value.getUTCDate(),
  );
}

function countdownUTCDate(parts: CountdownDate): Date {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

function countdownDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function buildRenderNode(
  node: AnyNode,
  scope: RenderScope,
): HTMLElement {
  switch (node["t"]) {
    case "box": {
      const el = document.createElement("div");
      applyBoxStyle(el, (node["style"] as Record<string, unknown>) ?? {});
      for (const child of (node["children"] as AnyNode[]) ?? []) {
        el.appendChild(buildRenderNode(child, scope));
      }
      return el;
    }
    case "text": {
      const el = document.createElement("div");
      el.textContent = String(node["value"] ?? "");
      applyTextStyle(el, (node["style"] as Record<string, unknown>) ?? {});
      return el;
    }
    case "image": {
      const el = document.createElement("img");
      el.style.objectFit = FIT_MODES[String(node["fit"])] ?? "contain";
      el.style.width = "100%";
      el.style.height = "100%";
      if (typeof node["radius"] === "number")
        el.style.borderRadius = px(node["radius"]);
      el.src = String(node["src"] ?? "");
      return el;
    }
    case "qr": {
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.alignItems = "center";
      wrap.style.gap = "8px";
      const img = document.createElement("img");
      img.style.width = "min(70vh, 70vw)";
      img.style.height = "auto";
      img.src = String(node["src"] ?? "");
      wrap.appendChild(img);
      if (node["label"]) {
        const label = document.createElement("div");
        label.textContent = String(node["label"]);
        label.style.fontSize = "28px";
        wrap.appendChild(label);
      }
      return wrap;
    }
    case "shape": {
      const el = document.createElement("div");
      const style = (node["style"] as Record<string, unknown>) ?? {};
      el.style.width = "100%";
      el.style.height = "100%";
      if (node["shape"] === "circle") el.style.borderRadius = "50%";
      else if (typeof style["radius"] === "number")
        el.style.borderRadius = px(style["radius"]);
      if (style["fill"]) el.style.background = String(style["fill"]);
      if (style["strokeWidth"] && Number(style["strokeWidth"]) > 0) {
        el.style.border = `${px(style["strokeWidth"])} solid ${String(style["stroke"] ?? "#fff")}`;
      }
      if (node["shape"] === "line") {
        el.style.height = px(style["strokeWidth"] ?? 1);
        el.style.background = String(style["stroke"] ?? "#fff");
        el.style.border = "none";
      }
      return el;
    }
    case "progress": {
      const track = document.createElement("div");
      track.style.width = "80%";
      track.style.height = "20px";
      track.style.borderRadius = "10px";
      track.style.background = String(node["track"] ?? "#333");
      track.style.overflow = "hidden";
      const bar = document.createElement("div");
      bar.style.height = "100%";
      bar.style.width = `${Math.round(Number(node["ratio"] ?? 0) * 100)}%`;
      bar.style.background = String(node["color"] ?? "#4C8BF5");
      track.appendChild(bar);
      return track;
    }
    case "divider": {
      const el = document.createElement("div");
      if (node["vertical"]) {
        el.style.width = "1px";
        el.style.alignSelf = "stretch";
      } else {
        el.style.height = "1px";
        el.style.width = "100%";
      }
      el.style.background = String(node["color"] ?? "#2A3644");
      return el;
    }
    case "spacer": {
      const el = document.createElement("div");
      el.style.flexGrow = String(node["grow"] ?? 1);
      return el;
    }
    case "marquee":
      return buildMarquee(node);
    case "chart":
      return buildChart(node);
    case "clock": {
      const el = document.createElement("div");
      applyTextStyle(el, (node["style"] as Record<string, unknown>) ?? {});
      const tick = () => {
        el.textContent = formatClock(node, scope.clock.wallNow());
        if (el.isConnected) fitTextElement(el);
      };
      tick();
      scope.timers.every(node["showSeconds"] ? 1_000 : 15_000, tick);
      return el;
    }
    case "countdown": {
      const el = document.createElement("div");
      applyTextStyle(el, (node["style"] as Record<string, unknown>) ?? {});
      const tick = () => {
        el.textContent = formatCountdown(node, scope.clock.wallNow());
        if (el.isConnected) fitTextElement(el);
      };
      tick();
      scope.timers.every(node["showSeconds"] ? 1_000 : 30_000, tick);
      return el;
    }
    default: {
      const el = document.createElement("div");
      for (const child of (node["children"] as AnyNode[]) ?? []) {
        el.appendChild(buildRenderNode(child, scope));
      }
      return el;
    }
  }
}

function buildMarquee(node: AnyNode): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.overflow = "hidden";
  wrap.style.whiteSpace = "nowrap";
  wrap.style.width = "100%";
  const track = document.createElement("div");
  track.textContent = String(node["text"] ?? "");
  applyTextStyle(track, (node["style"] as Record<string, unknown>) ?? {});
  track.style.display = "inline-block";
  track.style.paddingLeft = "100%";
  track.style.willChange = "transform";
  const dur = Math.max(Number(node["durationMs"] ?? 18_000), 4_000);
  const dir =
    node["direction"] === "right" ? "tc-marquee-right" : "tc-marquee-left";
  track.style.animation = `${dir} ${dur}ms linear infinite`;
  wrap.appendChild(track);
  return wrap;
}

function buildChart(node: AnyNode): HTMLElement {
  // Lightweight inline SVG — no chart library, no animation (kind to old GPU).
  const series = (node["series"] as number[]) ?? [];
  const colors = (node["colors"] as string[]) ?? ["#4C8BF5"];
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 100 60");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.style.width = "100%";
  svg.style.height = "100%";
  const max = Math.max(1, ...series.map((v) => Math.abs(v)));
  if (node["chart"] === "donut") {
    const total = series.reduce((a, b) => a + Math.abs(b), 0) || 1;
    let angle = -Math.PI / 2;
    series.forEach((v, i) => {
      const slice = (Math.abs(v) / total) * Math.PI * 2;
      const path = document.createElementNS(svgNS, "path");
      const [cx, cy, r] = [50, 30, 25];
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(angle + slice);
      const y2 = cy + r * Math.sin(angle + slice);
      const large = slice > Math.PI ? 1 : 0;
      path.setAttribute(
        "d",
        `M${cx} ${cy} L${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`,
      );
      path.setAttribute("fill", colors[i % colors.length]!);
      svg.appendChild(path);
      angle += slice;
    });
  } else if (node["chart"] === "bar") {
    const w = 100 / Math.max(series.length, 1);
    series.forEach((v, i) => {
      const rect = document.createElementNS(svgNS, "rect");
      const h = (Math.abs(v) / max) * 58;
      rect.setAttribute("x", String(i * w + w * 0.15));
      rect.setAttribute("y", String(60 - h));
      rect.setAttribute("width", String(w * 0.7));
      rect.setAttribute("height", String(h));
      rect.setAttribute("fill", colors[i % colors.length]!);
      svg.appendChild(rect);
    });
  } else {
    const step = 100 / Math.max(series.length - 1, 1);
    const points = series
      .map((v, i) => `${i * step},${60 - (Math.abs(v) / max) * 58}`)
      .join(" ");
    const poly = document.createElementNS(svgNS, "polyline");
    poly.setAttribute("points", points);
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", colors[0]!);
    poly.setAttribute("stroke-width", "2");
    svg.appendChild(poly);
  }
  return svg as unknown as HTMLElement;
}
