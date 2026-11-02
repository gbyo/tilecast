/**
 * The card push of the startup reveal, as plain numbers.
 *
 * The front tile is a flat card in front of a camera at the centre of the
 * screen (CSS `perspective` on the logo box, which is centred). The plan
 * moves the card toward the camera until its edges pass every edge of the
 * viewport, so the last frame is the card's white and nothing else.
 *
 * Nothing here touches the DOM, so tests can prove the last frame covers the
 * screen and no frame puts part of the card behind the camera.
 */

export interface Point {
  x: number;
  y: number;
}

export interface CardGeometry {
  viewport: { width: number; height: number };
  /** The card box at rest, in viewport pixels. */
  card: { left: number; top: number; width: number; height: number };
  /** A convex polygon inside the tile, in card-box pixels. */
  polygon: readonly Point[];
}

/** One instant of the push. Translation and depth are in pixels. */
export interface CardSample {
  offset: number;
  dx: number;
  dy: number;
  z: number;
  rotateX: number;
  rotateY: number;
  shade: number;
}

export interface CardPlan {
  /** Transform origin, in card-box pixels: the tile's centroid. */
  origin: Point;
  /** CSS `perspective` of the logo box, in pixels. */
  perspective: number;
  /** Apparent scale of the card in the last frame. */
  finalScale: number;
  samples: CardSample[];
}

/** The tile's straight-edge end points (SVG units of the logo). */
const TILE_POLYGON: readonly Point[] = [
  { x: 75.36, y: 130.23 },
  { x: 89.25, y: 113.7 },
  { x: 237, y: 72.05 },
  { x: 257.49, y: 85.27 },
  { x: 257.49, y: 184.76 },
  { x: 243.28, y: 201.29 },
  { x: 96.19, y: 241.62 },
  { x: 75.36, y: 228.4 },
];
/** The card box's viewBox (index.html). */
const CARD_VIEWBOX = { x: 74.36, y: 67.42, width: 184.13, height: 178.83 };

/** Peak tilt: the near edge leads, enough to read as depth and no more. */
const PEAK_ROTATE_Y = -11;
const PEAK_ROTATE_X = 5;
/** Lift at the start, as a fraction of the card height. */
const LIFT = 0.12;
/** Camera distance as a multiple of the card width. */
const PERSPECTIVE_PER_CARD = 8;
/** Scale beyond the smallest one that covers the viewport. */
const COVER_MARGIN = 1.1;
/** Part of the depth gap that the tilted card may use. */
const DEPTH_BUDGET = 0.3;
const SAMPLES = 48;
const DEG = Math.PI / 180;

/** The tile polygon in card-box pixels for a card box of this size. */
export function tilePolygon(card: { width: number; height: number }): Point[] {
  const sx = card.width / CARD_VIEWBOX.width;
  const sy = card.height / CARD_VIEWBOX.height;
  return TILE_POLYGON.map((p) => ({
    x: (p.x - CARD_VIEWBOX.x) * sx,
    y: (p.y - CARD_VIEWBOX.y) * sy,
  }));
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function smoothstep(from: number, to: number, value: number): number {
  const t = clamp01((value - from) / (to - from));
  return t * t * (3 - 2 * t);
}

/** Lift and tilt: in early, held through the push, gone before the fill. */
export function tiltEnvelope(u: number): number {
  return smoothstep(0, 0.3, u) * (1 - smoothstep(0.6, 0.93, u));
}

/** Share of the way from the rest position to the screen centre. */
function centring(u: number): number {
  return smoothstep(0.04, 0.82, u);
}

/** Share of the logarithmic scale: a slow start that keeps accelerating. */
function push(u: number): number {
  return Math.pow(u, 2.6);
}

function centroid(polygon: readonly Point[]): Point {
  let area = 0;
  let x = 0;
  let y = 0;
  polygon.forEach((a, index) => {
    const b = polygon[(index + 1) % polygon.length]!;
    const cross = a.x * b.y - b.x * a.y;
    area += cross;
    x += (a.x + b.x) * cross;
    y += (a.y + b.y) * cross;
  });
  return { x: x / (3 * area), y: y / (3 * area) };
}

/** Point-in-convex-polygon; the polygon winds clockwise on screen. */
export function contains(polygon: readonly Point[], point: Point): boolean {
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross < 0) return false;
  }
  return true;
}

function corners(viewport: CardGeometry["viewport"]): Point[] {
  return [
    { x: 0, y: 0 },
    { x: viewport.width, y: 0 },
    { x: viewport.width, y: viewport.height },
    { x: 0, y: viewport.height },
  ];
}

/**
 * The smallest scale about `origin` at which the polygon, centred on the
 * screen, contains every viewport corner.
 */
function coveringScale(geometry: CardGeometry, origin: Point): number {
  const { viewport, polygon } = geometry;
  const covered = (scale: number) =>
    corners(viewport).every((corner) =>
      contains(polygon, {
        x: origin.x + (corner.x - viewport.width / 2) / scale,
        y: origin.y + (corner.y - viewport.height / 2) / scale,
      }),
    );
  let low = 1;
  let high = 2;
  while (!covered(high)) {
    high *= 2;
    if (high > 1e5) throw new Error("the card cannot cover this viewport");
  }
  for (let step = 0; step < 40; step++) {
    const middle = (low + high) / 2;
    if (covered(middle)) high = middle;
    else low = middle;
  }
  return high;
}

/** Where a card-box point lands on screen at one sample, or null if behind the camera. */
export function project(
  geometry: CardGeometry,
  plan: CardPlan,
  sample: CardSample,
  point: Point,
): Point | null {
  const x = point.x - plan.origin.x;
  const y = point.y - plan.origin.y;
  // transform: translate3d(...) rotateX(...) rotateY(...), right to left.
  const ry = sample.rotateY * DEG;
  const x1 = x * Math.cos(ry);
  const z1 = -x * Math.sin(ry);
  const rx = sample.rotateX * DEG;
  const y2 = y * Math.cos(rx) - z1 * Math.sin(rx);
  const z2 = y * Math.sin(rx) + z1 * Math.cos(rx);
  const wx = geometry.card.left + plan.origin.x + sample.dx + x1;
  const wy = geometry.card.top + plan.origin.y + sample.dy + y2;
  const wz = sample.z + z2;
  const gap = plan.perspective - wz;
  if (gap <= 0) return null;
  const k = plan.perspective / gap;
  const cx = geometry.viewport.width / 2;
  const cy = geometry.viewport.height / 2;
  return { x: cx + (wx - cx) * k, y: cy + (wy - cy) * k };
}

/** True when the card covers the whole viewport at this sample. */
export function coversViewport(
  geometry: CardGeometry,
  plan: CardPlan,
  sample: CardSample,
): boolean {
  const projected = geometry.polygon.map((point) =>
    project(geometry, plan, sample, point),
  );
  if (projected.some((point) => point === null)) return false;
  return corners(geometry.viewport).every((corner) =>
    contains(projected as Point[], corner),
  );
}

export function planCardMotion(geometry: CardGeometry): CardPlan {
  const { card, viewport, polygon } = geometry;
  const origin = centroid(polygon);
  const perspective = Math.max(400, card.width * PERSPECTIVE_PER_CARD);
  const finalScale = coveringScale(geometry, origin) * COVER_MARGIN;
  const rest = {
    x: card.left + origin.x - viewport.width / 2,
    y: card.top + origin.y - viewport.height / 2,
  };
  // How far the tilted card reaches toward and away from the camera, per
  // unit of tilt, so the tilt can be limited to a share of the depth gap.
  const reach = Math.max(
    ...polygon.map(
      (p) =>
        Math.abs(p.x - origin.x) * Math.sin(Math.abs(PEAK_ROTATE_Y) * DEG) +
        Math.abs(p.y - origin.y) * Math.sin(Math.abs(PEAK_ROTATE_X) * DEG),
    ),
  );

  const samples: CardSample[] = [];
  for (let index = 0; index <= SAMPLES; index++) {
    const u = index / SAMPLES;
    const scale = Math.exp(Math.log(finalScale) * push(u));
    const z = perspective * (1 - 1 / scale);
    const gap = perspective - z;
    const tilt = Math.min(
      tiltEnvelope(u),
      reach > 0 ? (DEPTH_BUDGET * gap) / reach : 1,
    );
    const share = 1 - centring(u);
    const lift = -LIFT * card.height * tiltEnvelope(u);
    // Screen offset of the origin is (rest + d) * scale; choose d so the
    // origin travels from rest to the centre, lifted a little on the way.
    const screen = { x: rest.x * share, y: rest.y * share + lift };
    samples.push({
      offset: u,
      dx: screen.x / scale - rest.x,
      dy: screen.y / scale - rest.y,
      z,
      // `|| 0` keeps an untilted frame at +0 rather than -0.
      rotateX: PEAK_ROTATE_X * tilt || 0,
      rotateY: PEAK_ROTATE_Y * tilt || 0,
      shade: tilt || 0,
    });
  }
  return { origin, perspective, finalScale, samples };
}

const fixed = (value: number) => Number(value.toFixed(3));

export function transformOf(sample: CardSample): string {
  return (
    `translate3d(${fixed(sample.dx)}px, ${fixed(sample.dy)}px, ${fixed(sample.z)}px) ` +
    `rotateX(${fixed(sample.rotateX)}deg) rotateY(${fixed(sample.rotateY)}deg)`
  );
}
