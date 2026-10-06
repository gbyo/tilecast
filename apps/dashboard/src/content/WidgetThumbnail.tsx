// Catalog previews for the Widget gallery.
//
// A gallery of twenty-eight lucide icons tells an author almost nothing: a Metric, a
// Progress, and a Stat Grid all reduce to a vaguely numeric glyph. These previews instead
// draw each Widget's actual arrangement — where the heading sits, whether content is one
// large value or many rows, whether it fills the screen or runs as a band across it — so
// the shape on the card matches the shape that reaches a screen.
//
// They are deliberately wireframes rather than screenshots. Real screenshots would go
// stale, imply data the author has not connected, and would have to ship as binary assets;
// these are inline SVG that inherits the current theme, adds no network request, and
// carries no fabricated content.
//
// Every preview is drawn from the same small shape vocabulary against a 160x90 screen, so
// adding one for a new Widget is a short data entry rather than new drawing code.

const WIDTH = 160;
const HEIGHT = 90;

type Shape =
  | {
      t: "r";
      x: number;
      y: number;
      w: number;
      h: number;
      o?: number;
      a?: boolean;
      rx?: number;
    }
  | { t: "c"; cx: number; cy: number; r: number; o?: number; a?: boolean }
  | { t: "l"; x1: number; y1: number; x2: number; y2: number; o?: number }
  | { t: "p"; d: string; o?: number; a?: boolean; fill?: boolean };

/** A horizontal bar standing in for a line of text. */
const bar = (x: number, y: number, w: number, h: number, o = 0.35): Shape => ({
  t: "r",
  x,
  y,
  w,
  h,
  o,
  rx: h / 2,
});

/** The same, drawn in the accent color to mark the Widget's focal element. */
const accent = (x: number, y: number, w: number, h: number): Shape => ({
  t: "r",
  x,
  y,
  w,
  h,
  a: true,
  rx: h / 2,
});

/** A filled block standing in for an image, card, or panel. */
const block = (
  x: number,
  y: number,
  w: number,
  h: number,
  o = 0.16,
): Shape => ({ t: "r", x, y, w, h, o, rx: 2 });

/** Rows of evenly spaced bars, the common shape for list-like Widgets. */
function rows(
  count: number,
  top: number,
  gap: number,
  widths: number[],
  x = 14,
  h = 5,
): Shape[] {
  return Array.from({ length: count }, (_, index) =>
    bar(x, top + index * gap, widths[index % widths.length]!, h),
  );
}

const THUMBNAILS: Record<string, Shape[]> = {
  // --- Web and video -------------------------------------------------------
  website: [
    block(12, 12, 136, 66, 0.1),
    bar(12, 12, 136, 10, 0.22),
    { t: "c", cx: 18, cy: 17, r: 2, o: 0.45 },
    { t: "c", cx: 25, cy: 17, r: 2, o: 0.45 },
    { t: "c", cx: 32, cy: 17, r: 2, o: 0.45 },
    bar(40, 15, 70, 4, 0.3),
    ...rows(3, 32, 12, [110, 92, 74], 20, 5),
  ],
  youtube: [
    block(12, 12, 136, 66, 0.14),
    { t: "r", x: 58, y: 32, w: 44, h: 26, a: true, rx: 5 },
    { t: "p", d: "M74 38 L88 45 L74 52 Z", o: 1, fill: true },
  ],
  // --- Essentials ----------------------------------------------------------
  clock: [accent(38, 32, 84, 20), bar(58, 58, 44, 5, 0.3)],
  date: [
    bar(52, 26, 56, 6, 0.3),
    accent(38, 38, 84, 18),
    bar(58, 62, 44, 5, 0.3),
  ],
  qrcode: [
    block(58, 18, 44, 44, 0.14),
    { t: "r", x: 63, y: 23, w: 10, h: 10, a: true, rx: 1 },
    { t: "r", x: 87, y: 23, w: 10, h: 10, a: true, rx: 1 },
    { t: "r", x: 63, y: 47, w: 10, h: 10, a: true, rx: 1 },
    { t: "r", x: 79, y: 39, w: 6, h: 6, o: 0.5, rx: 1 },
    { t: "r", x: 89, y: 49, w: 6, h: 6, o: 0.5, rx: 1 },
    bar(58, 68, 44, 4, 0.3),
  ],
  // The canonical V2 provider keeps the same schematic artwork as the
  // superseded provider it replaces in the gallery.
  "qr-code": [
    block(58, 18, 44, 44, 0.14),
    { t: "r", x: 63, y: 23, w: 10, h: 10, a: true, rx: 1 },
    { t: "r", x: 87, y: 23, w: 10, h: 10, a: true, rx: 1 },
    { t: "r", x: 63, y: 47, w: 10, h: 10, a: true, rx: 1 },
    { t: "r", x: 79, y: 39, w: 6, h: 6, o: 0.5, rx: 1 },
    { t: "r", x: 89, y: 49, w: 6, h: 6, o: 0.5, rx: 1 },
    bar(58, 68, 44, 4, 0.3),
  ],
  countdown: [
    bar(56, 22, 48, 5, 0.3),
    accent(20, 34, 26, 22),
    accent(50, 34, 26, 22),
    accent(80, 34, 26, 22),
    accent(110, 34, 26, 22),
    bar(20, 62, 26, 4, 0.28),
    bar(50, 62, 26, 4, 0.28),
    bar(80, 62, 26, 4, 0.28),
    bar(110, 62, 26, 4, 0.28),
  ],
  world_clock: [
    bar(18, 20, 34, 4, 0.3),
    accent(18, 28, 34, 14),
    bar(63, 20, 34, 4, 0.3),
    accent(63, 28, 34, 14),
    bar(108, 20, 34, 4, 0.3),
    accent(108, 28, 34, 14),
    ...rows(1, 54, 10, [124], 18, 5),
    bar(18, 66, 96, 5, 0.22),
  ],
  "text-notice": [
    accent(42, 18, 76, 11),
    bar(24, 38, 112, 7, 0.32),
    bar(34, 51, 92, 7, 0.32),
    bar(48, 64, 64, 7, 0.32),
  ],
  "image-notice": [
    block(24, 14, 112, 52, 0.18),
    { t: "c", cx: 52, cy: 34, r: 6, o: 0.4 },
    { t: "p", d: "M32 60 L60 38 L82 60 Z", o: 0.4, fill: true },
    { t: "p", d: "M76 60 L96 44 L112 60 Z", o: 0.3, fill: true },
    bar(46, 72, 68, 5, 0.35),
  ],
  "qr-call-to-action": [
    accent(46, 14, 68, 10),
    block(62, 30, 36, 36, 0.14),
    { t: "r", x: 66, y: 34, w: 8, h: 8, a: true, rx: 1 },
    { t: "r", x: 86, y: 34, w: 8, h: 8, a: true, rx: 1 },
    { t: "r", x: 66, y: 54, w: 8, h: 8, a: true, rx: 1 },
    bar(50, 72, 60, 5, 0.32),
  ],
  // --- Data-driven ---------------------------------------------------------
  ticker: [
    block(12, 12, 136, 44, 0.08),
    ...rows(2, 24, 12, [96, 72], 20, 5),
    { t: "r", x: 12, y: 62, w: 136, h: 16, a: true, rx: 2 },
    bar(20, 68, 40, 4, 0.85),
    bar(68, 68, 32, 4, 0.6),
    bar(108, 68, 28, 4, 0.4),
  ],
  menu: [
    accent(14, 14, 48, 8),
    ...[0, 1, 2, 3].flatMap((index) => [
      bar(14, 30 + index * 13, 64, 5),
      bar(120, 30 + index * 13, 26, 5, 0.55),
    ]),
  ],
  list: [
    ...[0, 1, 2, 3].flatMap((index) => [
      bar(14, 16 + index * 18, 92, 6, 0.42),
      bar(14, 26 + index * 18, 60, 4, 0.22),
    ]),
  ],
  table: [
    { t: "r", x: 12, y: 14, w: 136, h: 12, o: 0.22, rx: 2 },
    bar(18, 18, 28, 4, 0.6),
    bar(60, 18, 28, 4, 0.6),
    bar(104, 18, 28, 4, 0.6),
    ...[0, 1, 2, 3].flatMap((index) => [
      bar(18, 34 + index * 12, 28, 4),
      bar(60, 34 + index * 12, 28, 4),
      bar(104, 34 + index * 12, 28, 4),
    ]),
    { t: "l", x1: 52, y1: 14, x2: 52, y2: 78, o: 0.14 },
    { t: "l", x1: 96, y1: 14, x2: 96, y2: 78, o: 0.14 },
  ],
  agenda: [
    accent(14, 14, 42, 7),
    ...rows(2, 27, 12, [104, 84], 22, 5),
    accent(14, 50, 42, 7),
    ...rows(2, 63, 12, [96, 76], 22, 5),
  ],
  metric: [accent(34, 24, 92, 32), bar(50, 64, 60, 6, 0.32)],
  cards: [
    block(14, 14, 62, 30),
    block(84, 14, 62, 30),
    block(14, 50, 62, 30),
    block(84, 50, 62, 30),
    bar(20, 22, 36, 5, 0.45),
    bar(90, 22, 36, 5, 0.45),
    bar(20, 58, 36, 5, 0.45),
    bar(90, 58, 36, 5, 0.45),
  ],
  weather: [
    { t: "c", cx: 42, cy: 30, r: 12, a: true },
    { t: "p", d: "M56 38 a9 9 0 0 1 18 0 h-18 Z", o: 0.35, fill: true },
    accent(88, 20, 52, 20),
    ...[0, 1, 2].flatMap((index) => [
      bar(18 + index * 46, 56, 34, 5, 0.3),
      bar(18 + index * 46, 66, 24, 8, 0.2),
    ]),
  ],
  // --- Data Display --------------------------------------------------------
  spotlight: [
    block(12, 12, 66, 66, 0.2),
    { t: "p", d: "M20 70 L44 44 L64 70 Z", o: 0.4, fill: true },
    { t: "c", cx: 38, cy: 30, r: 6, o: 0.4 },
    accent(88, 20, 56, 12),
    ...rows(4, 40, 10, [56, 48, 52, 36], 88, 5),
  ],
  stat_grid: [
    accent(14, 16, 48, 16),
    bar(14, 36, 34, 4, 0.3),
    accent(84, 16, 48, 16),
    bar(84, 36, 34, 4, 0.3),
    accent(14, 50, 48, 16),
    bar(14, 70, 34, 4, 0.3),
    accent(84, 50, 48, 16),
    bar(84, 70, 34, 4, 0.3),
  ],
  chart: [
    { t: "l", x1: 16, y1: 14, x2: 16, y2: 70, o: 0.28 },
    { t: "l", x1: 16, y1: 70, x2: 146, y2: 70, o: 0.28 },
    {
      t: "p",
      d: "M22 60 L48 42 L72 50 L98 26 L124 34 L142 20",
      a: true,
    },
    { t: "c", cx: 48, cy: 42, r: 2.5, a: true },
    { t: "c", cx: 98, cy: 26, r: 2.5, a: true },
    { t: "c", cx: 142, cy: 20, r: 2.5, a: true },
    bar(22, 78, 120, 3, 0.18),
  ],
  progress: [
    bar(34, 20, 60, 6, 0.32),
    { t: "r", x: 20, y: 38, w: 120, h: 14, o: 0.16, rx: 7 },
    { t: "r", x: 20, y: 38, w: 78, h: 14, a: true, rx: 7 },
    bar(66, 62, 28, 6, 0.35),
  ],
  "fundraising-thermometer": [
    bar(52, 14, 56, 5, 0.32),
    accent(44, 24, 72, 18),
    { t: "r", x: 20, y: 50, w: 120, h: 12, o: 0.16, rx: 6 },
    { t: "r", x: 20, y: 50, w: 86, h: 12, a: true, rx: 6 },
    bar(62, 70, 36, 5, 0.32),
  ],
  // --- Schedules and information ------------------------------------------
  timeline: [
    { t: "l", x1: 26, y1: 14, x2: 26, y2: 78, o: 0.24 },
    ...[0, 1, 2].flatMap<Shape>((index) => [
      { t: "c", cx: 26, cy: 22 + index * 24, r: 4, a: index === 0 },
      bar(38, 18 + index * 24, 72, 5, 0.4),
      bar(38, 28 + index * 24, 48, 4, 0.22),
    ]),
  ],
  status: [
    bar(20, 17, 44, 5, 0.3),
    { t: "r", x: 20, y: 29, w: 32, h: 12, a: true, rx: 6 },
    accent(20, 48, 92, 12),
    bar(20, 66, 120, 5, 0.24),
  ],
  "now-and-next": [
    bar(14, 12, 22, 5, 0.3),
    accent(14, 21, 96, 16),
    bar(14, 41, 62, 4, 0.28),
    { t: "l", x1: 14, y1: 50, x2: 146, y2: 50, o: 0.18 },
    bar(14, 55, 24, 4, 0.3),
    ...[0, 1, 2].flatMap((index) => [
      bar(14, 63 + index * 8, 22, 4, 0.45),
      bar(42, 63 + index * 8, 72, 4, 0.25),
    ]),
  ],
  "schedule-board": [
    bar(14, 12, 28, 5, 0.3),
    accent(14, 22, 88, 14),
    bar(14, 42, 50, 6, 0.45),
    { t: "l", x1: 14, y1: 54, x2: 146, y2: 54, o: 0.18 },
    block(14, 61, 62, 18),
    bar(20, 66, 36, 4, 0.42),
    bar(20, 73, 22, 3, 0.25),
    block(84, 61, 62, 18),
    bar(90, 66, 34, 4, 0.42),
    bar(90, 73, 26, 3, 0.25),
  ],
  "recognition-board": [
    accent(14, 12, 44, 8),
    block(14, 26, 62, 24),
    bar(20, 32, 32, 5, 0.5),
    bar(20, 41, 44, 4, 0.25),
    block(84, 26, 62, 24),
    bar(90, 32, 32, 5, 0.5),
    bar(90, 41, 44, 4, 0.25),
    block(14, 54, 62, 24),
    bar(20, 60, 32, 5, 0.5),
    bar(20, 69, 44, 4, 0.25),
    block(84, 54, 62, 24),
    bar(90, 60, 32, 5, 0.5),
    bar(90, 69, 44, 4, 0.25),
  ],
  "school-status-banner": [
    bar(14, 13, 44, 5, 0.3),
    { t: "r", x: 14, y: 24, w: 34, h: 13, a: true, rx: 6 },
    bar(14, 44, 92, 14, 0.45),
    bar(14, 66, 120, 5, 0.24),
    bar(14, 76, 64, 4, 0.18),
  ],
  "alert-banner": [
    { t: "r", x: 10, y: 39, w: 140, h: 22, a: true, rx: 2 },
    { t: "r", x: 16, y: 45, w: 22, h: 10, o: 0.9, rx: 5 },
    bar(44, 46, 68, 5, 0.78),
    bar(116, 46, 26, 5, 0.4),
  ],
};

// Integration definitions name their own previews in the Server catalog. Most can reuse
// an established signage composition: the preview communicates the rendered result while
// the adjacent card carries the provider identity, without bundling trademark artwork or
// creating a second provider registry in Studio.
const newsPreview: Shape[] = [
  accent(14, 12, 48, 7),
  block(14, 25, 132, 20, 0.12),
  bar(20, 31, 92, 6, 0.5),
  bar(20, 39, 64, 3, 0.24),
  ...rows(3, 54, 10, [118, 102, 110], 14, 5),
];
Object.assign(THUMBNAILS, {
  news: newsPreview,
  "news-feed": newsPreview,
  espn: newsPreview,
  "bbc-news": newsPreview,
  "sky-news": newsPreview,
  "the-guardian": newsPreview,
  rss: newsPreview,
  "google-sheets": THUMBNAILS.table,
  "google-slides": THUMBNAILS["image-notice"],
  canva: THUMBNAILS["image-notice"],
  grafana: THUMBNAILS.chart,
  "power-bi": THUMBNAILS.stat_grid,
  tableau: THUMBNAILS.chart,
  "looker-studio": THUMBNAILS.chart,
  airtable: THUMBNAILS.table,
  smartsheet: THUMBNAILS.table,
});

/** The preview used when a definition names no thumbnail, or names an unknown one. */
const FALLBACK: Shape[] = [
  block(20, 18, 120, 54, 0.12),
  bar(32, 30, 96, 6, 0.3),
  bar(32, 44, 72, 6, 0.24),
  bar(32, 58, 84, 6, 0.18),
];

function renderShape(shape: Shape, index: number) {
  const stroke = "var(--tc-action-primary)";
  switch (shape.t) {
    case "r":
      return (
        <rect
          key={index}
          x={shape.x}
          y={shape.y}
          width={shape.w}
          height={shape.h}
          rx={shape.rx ?? 1}
          fill={shape.a ? stroke : "currentColor"}
          opacity={shape.a ? 1 : (shape.o ?? 0.35)}
        />
      );
    case "c":
      return (
        <circle
          key={index}
          cx={shape.cx}
          cy={shape.cy}
          r={shape.r}
          fill={shape.a ? stroke : "currentColor"}
          opacity={shape.a ? 1 : (shape.o ?? 0.35)}
        />
      );
    case "l":
      return (
        <line
          key={index}
          x1={shape.x1}
          y1={shape.y1}
          x2={shape.x2}
          y2={shape.y2}
          stroke="currentColor"
          strokeWidth={1}
          opacity={shape.o ?? 0.25}
        />
      );
    case "p":
      return (
        <path
          key={index}
          d={shape.d}
          fill={shape.fill ? (shape.a ? stroke : "currentColor") : "none"}
          stroke={shape.fill ? "none" : shape.a ? stroke : "currentColor"}
          strokeWidth={shape.fill ? 0 : 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={shape.a ? 1 : (shape.o ?? 0.35)}
        />
      );
  }
}

/**
 * Draws the catalog preview for a Widget. `name` is the definition's thumbnail identifier
 * or, for the Widgets built into the release, its provider id. An unknown name renders the
 * generic preview rather than nothing.
 */
export function WidgetThumbnail({
  name,
  label,
}: {
  name: string | undefined;
  label: string;
}) {
  const shapes = (name && THUMBNAILS[name]) || FALLBACK;
  return (
    <svg
      className="widget-thumbnail"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`${label} preview`}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect
        x={0.5}
        y={0.5}
        width={WIDTH - 1}
        height={HEIGHT - 1}
        rx={3}
        fill="var(--tc-bg-subtle)"
        stroke="var(--tc-border-default)"
      />
      {shapes.map(renderShape)}
    </svg>
  );
}

/** Exposed so tests can assert every catalog entry resolves to a drawn preview. */
export function hasWidgetThumbnail(name: string | undefined) {
  return Boolean(name && THUMBNAILS[name]);
}
