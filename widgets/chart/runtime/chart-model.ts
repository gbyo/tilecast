/**
 * The Chart geometry model: pure functions from sanitized numbers to
 * stable vector geometry. No DOM, no locale, no clock. Every division is
 * guarded so the renderer can never produce NaN SVG attributes or an
 * infinite path.
 */

export const CHART_WIDTH = 400;
export const CHART_HEIGHT = 260;
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;

export const PLOT_LEFT = PAD_LEFT;
export const PLOT_RIGHT = CHART_WIDTH - PAD_RIGHT;
export const PLOT_TOP = PAD_TOP;
export const PLOT_BOTTOM = CHART_HEIGHT - PAD_BOTTOM;

export interface ChartDomain {
  readonly min: number;
  readonly max: number;
}

/**
 * Merge data extremes with optional explicit bounds. An invalid explicit
 * pair (minimum at or above maximum) is ignored rather than rendered;
 * a degenerate domain expands symmetrically so scaling never divides by
 * zero.
 */
export function computeDomain(
  values: readonly number[],
  minimum: number | null,
  maximum: number | null,
): ChartDomain {
  const finite = values.filter((value) => Number.isFinite(value));
  let min = finite.length > 0 ? Math.min(...finite) : 0;
  let max = finite.length > 0 ? Math.max(...finite) : 1;
  const explicitMin =
    minimum !== null && Number.isFinite(minimum) ? minimum : null;
  const explicitMax =
    maximum !== null && Number.isFinite(maximum) ? maximum : null;
  if (explicitMin !== null && explicitMax !== null) {
    if (explicitMin < explicitMax) {
      min = explicitMin;
      max = explicitMax;
    }
  } else {
    if (explicitMin !== null) min = Math.min(min, explicitMin);
    if (explicitMax !== null) max = Math.max(max, explicitMax);
  }
  if (!(min < max)) {
    const center = Number.isFinite(min) ? min : 0;
    const span = Math.abs(center) > 0 ? Math.abs(center) : 1;
    min = center - span;
    max = center + span;
  }
  return { min, max };
}

/** Map a value into plot coordinates. The domain never collapses. */
export function scaleY(value: number, domain: ChartDomain): number {
  const span = domain.max - domain.min;
  const clamped = Math.min(Math.max(value, domain.min), domain.max);
  if (!(span > 0)) return (PLOT_TOP + PLOT_BOTTOM) / 2;
  return PLOT_BOTTOM - ((clamped - domain.min) / span) * (PLOT_BOTTOM - PLOT_TOP);
}

/** Even point positions across the plot; one point centers. */
export function scaleX(index: number, count: number): number {
  if (count <= 1) return (PLOT_LEFT + PLOT_RIGHT) / 2;
  const bounded = Math.min(Math.max(index, 0), count - 1);
  return (
    PLOT_LEFT + (bounded / (count - 1)) * (PLOT_RIGHT - PLOT_LEFT)
  );
}

/** The bar baseline: zero when it belongs in the domain, else the edge. */
export function baselineY(domain: ChartDomain): number {
  return scaleY(Math.min(Math.max(0, domain.min), domain.max), domain);
}

export interface BarRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Grouped bar rectangles for one point across the visible series. Bars
 * grow from the baseline in either direction; missing values leave gaps.
 */
export function barRects(
  pointIndex: number,
  pointCount: number,
  series: readonly (number | null)[],
  domain: ChartDomain,
): (BarRect | null)[] {
  const slot =
    pointCount <= 1
      ? (PLOT_RIGHT - PLOT_LEFT) / 2
      : (PLOT_RIGHT - PLOT_LEFT) / pointCount;
  const width = Math.max(1, (slot / Math.max(1, series.length)) * 0.72);
  const base = baselineY(domain);
  return series.map((value, seriesIndex) => {
    if (value === null || !Number.isFinite(value)) return null;
    const center =
      pointCount <= 1
        ? (PLOT_LEFT + PLOT_RIGHT) / 2 +
          (seriesIndex - (series.length - 1) / 2) * width
        : PLOT_LEFT +
          ((pointIndex + 0.5) / pointCount) * (PLOT_RIGHT - PLOT_LEFT) +
          (seriesIndex - (series.length - 1) / 2) * width;
    const top = scaleY(value, domain);
    return {
      x: center - width / 2,
      y: Math.min(base, top),
      width,
      height: Math.max(1, Math.abs(top - base)),
    };
  });
}

function pathFrom(
  points: readonly { x: number; y: number }[],
  close: boolean,
  base: number,
): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  let path = `M${round(first.x)},${round(first.y)}`;
  for (const point of points.slice(1)) {
    path += `L${round(point.x)},${round(point.y)}`;
  }
  if (close) path += `L${round(points[points.length - 1]!.x)},${round(base)}L${round(first.x)},${round(base)}Z`;
  return path;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Line subpaths with gaps at missing values, or area subpaths closed to
 * the baseline. A lone point draws nothing rather than a degenerate path.
 */
export function seriesPaths(
  values: readonly (number | null)[],
  domain: ChartDomain,
  close: boolean,
): string[] {
  const base = baselineY(domain);
  const paths: string[] = [];
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length >= 2 || (close && run.length >= 1)) {
      // A lone area point still fills a sliver so single-point areas show.
      const shape =
        run.length === 1 && close
          ? [
              { x: run[0]!.x - 2, y: base },
              { x: run[0]!.x - 2, y: run[0]!.y },
              { x: run[0]!.x + 2, y: run[0]!.y },
              { x: run[0]!.x + 2, y: base },
            ]
          : run;
      paths.push(pathFrom(shape, close, base));
    } else if (run.length === 1 && !close) {
      paths.push("");
    }
    run = [];
  };
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      flush();
      return;
    }
    run.push({ x: scaleX(index, values.length), y: scaleY(value, domain) });
  });
  flush();
  return paths.filter((path) => path !== "");
}

/**
 * Bounded nice ticks for the value axis. Never more than five, always
 * finite, always inside the domain.
 */
export function niceTicks(domain: ChartDomain, count = 4): number[] {
  if (!(domain.min < domain.max)) return [domain.min];
  const target = Math.max(2, Math.min(5, count));
  const raw = (domain.max - domain.min) / (target - 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step =
    normalized <= 1
      ? magnitude
      : normalized <= 2.5
        ? 2 * magnitude
        : normalized <= 5
          ? 5 * magnitude
          : 10 * magnitude;
  const ticks: number[] = [];
  for (
    let tick = Math.ceil(domain.min / step) * step;
    tick <= domain.max && ticks.length < target + 1;
    tick += step
  ) {
    ticks.push(Math.round(tick * 100) / 100);
  }
  return ticks.length > 0 ? ticks : [domain.min];
}
