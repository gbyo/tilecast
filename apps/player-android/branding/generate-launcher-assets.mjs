#!/usr/bin/env node
// Generates the Android Player launcher artwork from the two authoritative
// Tilecast SVGs. Nothing here redraws the logo: path data and transforms are
// read from the source files and only repositioned.
//
// Inputs:
//   branding/source/tilecast-mark.svg      standalone mark   -> launcher icon
//   branding/source/tilecast-wordmark.svg  full wordmark     -> TV banner
//   app/src/main/res/values/colors.xml     tilecast_signal_background
// Outputs:
//   app/src/main/res/drawable/ic_launcher_foreground.xml   adaptive foreground
//   app/src/main/res/mipmap-*dpi/ic_launcher.png           pre-API-26 fallback
//   app/src/main/res/drawable-{xhdpi,xxhdpi}/tilecast_banner.png
//   branding/play-store/tilecast-play-icon-512.png         Play listing icon
//
// Usage:
//   npm run android:branding:generate
//   npm run android:branding:check                  fail when outputs drifted
//   node generate-launcher-assets.mjs --preview DIR write inspection sheets
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const res = join(here, "../app/src/main/res");

const MARK_COLOR = "#FFFFFF";

// Adaptive icon geometry, in dp. Layers are 108dp; launchers show a 72dp
// window and guarantee only the central 66dp circle. The mark's farthest ink
// point must stay inside MARK_MAX_RADIUS so no OEM mask can crop it.
const LAYER = 108;
const WINDOW = 72;
const SAFE_RADIUS = 33;
const MARK_MAX_RADIUS = 26;

// TV banner, in px at xhdpi (320x180, 16:9). The wordmark is sized by width
// and centered on its ink bounds, leaving the same side margin on both edges.
const BANNER = { width: 320, height: 180, wordmarkWidth: 204 };
const BANNER_DENSITIES = { "drawable-xhdpi": 1, "drawable-xxhdpi": 1.5 };

const LEGACY_DENSITIES = {
  "mipmap-mdpi": 48,
  "mipmap-hdpi": 72,
  "mipmap-xhdpi": 96,
  "mipmap-xxhdpi": 144,
  "mipmap-xxxhdpi": 192,
};
const PLAY_ICON_SIZE = 512;

// ---------------------------------------------------------------------------
// SVG reading. The sources use only <g transform="matrix(...)">, <path> with
// absolute M/L/C/Z commands, and <rect>; anything else is rejected rather
// than approximated.

const multiply = (p, c) => [
  p[0] * c[0] + p[2] * c[1],
  p[1] * c[0] + p[3] * c[1],
  p[0] * c[2] + p[2] * c[3],
  p[1] * c[2] + p[3] * c[3],
  p[0] * c[4] + p[2] * c[5] + p[4],
  p[1] * c[4] + p[3] * c[5] + p[5],
];
const IDENTITY = [1, 0, 0, 1, 0, 0];

function parseMatrix(value) {
  if (!value) return IDENTITY;
  const match = /^matrix\(([^)]+)\)$/.exec(value.trim());
  if (!match) throw new Error(`Unsupported transform: ${value}`);
  const numbers = match[1].split(/[\s,]+/).map(Number);
  if (numbers.length !== 6 || numbers.some(Number.isNaN))
    throw new Error(`Malformed matrix: ${value}`);
  return numbers;
}

function parsePathData(d) {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens || d.replace(/[MLCZ\s,.\d+\-e]/gi, "") !== "")
    throw new Error(`Unsupported path data: ${d.slice(0, 60)}`);
  const arity = { M: 2, L: 2, C: 6, Z: 0 };
  const commands = [];
  for (let i = 0; i < tokens.length;) {
    const op = tokens[i++];
    if (!(op in arity)) throw new Error(`Unsupported path command ${op}`);
    const args = tokens.slice(i, i + arity[op]).map(Number);
    if (args.length !== arity[op] || args.some(Number.isNaN))
      throw new Error(`Truncated ${op} command`);
    i += arity[op];
    commands.push({ op, args });
  }
  return commands;
}

function rectPathData(attrs) {
  const [x, y, w, h] = ["x", "y", "width", "height"].map((k) =>
    Number(attrs[k] ?? 0),
  );
  return `M${x},${y}L${x + w},${y}L${x + w},${y + h}L${x},${y + h}Z`;
}

function readSvg(file) {
  const text = readFileSync(file, "utf8");
  const viewBox = /viewBox="([^"]+)"/.exec(text)?.[1].split(/\s+/).map(Number);
  if (viewBox?.length !== 4) throw new Error(`${file}: missing viewBox`);
  const rootRule = /fill-rule:\s*(evenodd|nonzero)/.exec(
    /<svg\b[^>]*>/.exec(text)[0],
  )?.[1];
  const shapes = [];
  const stack = [IDENTITY];
  for (const tag of text.matchAll(/<(\/?)(\w+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, rest, selfClosing] = tag;
    const attrs = Object.fromEntries(
      [...rest.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
    if (name === "svg") continue;
    if (name === "g") {
      if (closing) stack.pop();
      else if (selfClosing) continue;
      else stack.push(multiply(stack.at(-1), parseMatrix(attrs.transform)));
      continue;
    }
    if (name !== "path" && name !== "rect")
      throw new Error(`${file}: unsupported element <${name}>`);
    if (attrs.fill || attrs.stroke)
      throw new Error(`${file}: explicit paint is not supported`);
    const d = name === "rect" ? rectPathData(attrs) : attrs.d;
    const ownRule = /fill-rule:\s*(evenodd|nonzero)/.exec(
      attrs.style ?? "",
    )?.[1];
    shapes.push({
      commands: parsePathData(d),
      matrix: multiply(stack.at(-1), parseMatrix(attrs.transform)),
      fillRule: ownRule ?? rootRule ?? "nonzero",
    });
  }
  if (!shapes.length) throw new Error(`${file}: no shapes`);
  return { viewBox, shapes };
}

// ---------------------------------------------------------------------------
// Geometry. Curves are flattened once into world-space polylines; ink bounds,
// the farthest ink point, and the area centroid are measured on those.

const apply = (m, x, y) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

function flatten(shape) {
  const rings = [];
  let ring = null;
  let at = null;
  for (const { op, args } of shape.commands) {
    if (op === "M") {
      ring = [apply(shape.matrix, args[0], args[1])];
      rings.push(ring);
      at = ring[0];
    } else if (op === "L") {
      at = apply(shape.matrix, args[0], args[1]);
      ring.push(at);
    } else if (op === "C") {
      const p = [0, 2, 4].map((i) => apply(shape.matrix, args[i], args[i + 1]));
      const [p0, [x1, y1], [x2, y2], [x3, y3]] = [at, ...p];
      for (let i = 1; i <= 256; i++) {
        const t = i / 256;
        const u = 1 - t;
        const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        ring.push([
          b[0] * p0[0] + b[1] * x1 + b[2] * x2 + b[3] * x3,
          b[0] * p0[1] + b[1] * y1 + b[2] * y2 + b[3] * y3,
        ]);
      }
      at = p[2];
    } else if (op === "Z") {
      at = ring[0];
    }
  }
  return rings;
}

function measure(shapes) {
  const points = shapes.flatMap((s) => flatten(s).flat());
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const bounds = {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (const ring of shapes.flatMap(flatten)) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
  }
  return {
    ...bounds,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    centroid: [cx / (3 * area), cy / (3 * area)],
    points,
  };
}

const fmt = (n) => String(Number(n.toFixed(3)));
const fmtMatrix = (m) => m.map((n) => Number(n.toFixed(8))).join(",");

// Source path data exactly as written; its transform goes on the element.
const sourcePathData = (shape) =>
  shape.commands.map(({ op, args }) => op + args.join(",")).join("");
const rasterPath = (shape, place) =>
  `<path fill-rule="${shape.fillRule}" d="${sourcePathData(shape)}" transform="matrix(${fmtMatrix(multiply(place, shape.matrix))})"/>`;

// A path in final coordinates: source transform composed with `place`.
function placedPathData(shape, place) {
  const m = multiply(place, shape.matrix);
  return shape.commands
    .map(({ op, args }) => {
      const out = [];
      for (let i = 0; i < args.length; i += 2)
        out.push(
          apply(m, args[i], args[i + 1])
            .map(fmt)
            .join(","),
        );
      return op + out.join(" ");
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Layout.

function backgroundColor() {
  const colors = readFileSync(join(res, "values/colors.xml"), "utf8");
  const match = /name="tilecast_signal_background">(#[0-9A-Fa-f]{6})</.exec(
    colors,
  );
  if (!match) throw new Error("tilecast_signal_background missing");
  return match[1].toUpperCase();
}

function layoutMark(mark) {
  const m = measure(mark.shapes);
  // Center on ink bounds. The area centroid is reported by --preview so the
  // optical offset stays visible, but the bounds center is the stable choice.
  const cx = (m.minX + m.maxX) / 2;
  const cy = (m.minY + m.maxY) / 2;
  const farthest = Math.max(
    ...m.points.map(([x, y]) => Math.hypot(x - cx, y - cy)),
  );
  const scale = MARK_MAX_RADIUS / farthest;
  const half = LAYER / 2;
  const place = [scale, 0, 0, scale, half - cx * scale, half - cy * scale];
  const placed = measure(
    mark.shapes.map((s) => ({ ...s, matrix: multiply(place, s.matrix) })),
  );
  const radius = Math.max(
    ...placed.points.map(([x, y]) => Math.hypot(x - half, y - half)),
  );
  if (radius > SAFE_RADIUS - 3)
    throw new Error(`Mark radius ${radius} leaves no safe-zone margin`);
  return { place, placed, radius };
}

function foregroundVector(mark, place) {
  const paths = mark.shapes
    .map(
      (s) =>
        `    <path\n        android:fillColor="${MARK_COLOR}"\n        android:fillType="${s.fillRule === "evenodd" ? "evenOdd" : "nonZero"}"\n        android:pathData="${placedPathData(s, place)}" />`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by branding/generate-launcher-assets.mjs from
     branding/source/tilecast-mark.svg. Do not edit. Single-color so the same
     layer serves as the adaptive foreground and the monochrome layer. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${LAYER}dp"
    android:height="${LAYER}dp"
    android:viewportWidth="${LAYER}"
    android:viewportHeight="${LAYER}">
${paths}
</vector>
`;
}

// An SVG of the mark layer composed over the background, cropped to the
// `window` rectangle (in dp) and rendered at `size` px square.
function markSvg(mark, place, background, size, window) {
  const paths = mark.shapes.map((s) => rasterPath(s, place)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${window.join(" ")}"><rect x="0" y="0" width="${LAYER}" height="${LAYER}" fill="${background}"/><g fill="${MARK_COLOR}">${paths}</g></svg>`;
}
function bannerSvg(wordmark, background, scaleFactor) {
  const m = measure(wordmark.shapes);
  const scale = BANNER.wordmarkWidth / m.width;
  const tx = (BANNER.width - m.width * scale) / 2 - m.minX * scale;
  const ty = (BANNER.height - m.height * scale) / 2 - m.minY * scale;
  const place = [scale, 0, 0, scale, tx, ty];
  const paths = wordmark.shapes.map((s) => rasterPath(s, place)).join("");
  const w = Math.round(BANNER.width * scaleFactor);
  const h = Math.round(BANNER.height * scaleFactor);
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${BANNER.width} ${BANNER.height}"><rect width="${BANNER.width}" height="${BANNER.height}" fill="${background}"/><g fill="${MARK_COLOR}">${paths}</g></svg>`,
    ink: { width: m.width * scale, height: m.height * scale },
  };
}

const png = (svg) =>
  sharp(Buffer.from(svg), { density: 72 })
    .png({ compressionLevel: 9 })
    .toBuffer();

// ---------------------------------------------------------------------------
// Outputs.

async function build() {
  const mark = readSvg(join(here, "source/tilecast-mark.svg"));
  const wordmark = readSvg(join(here, "source/tilecast-wordmark.svg"));
  const background = backgroundColor();
  const { place, placed, radius } = layoutMark(mark);
  const half = LAYER / 2;
  const window = [(LAYER - WINDOW) / 2, (LAYER - WINDOW) / 2, WINDOW, WINDOW];

  const files = new Map();
  files.set(
    join(res, "drawable/ic_launcher_foreground.xml"),
    foregroundVector(mark, place),
  );
  for (const [dir, size] of Object.entries(LEGACY_DENSITIES))
    files.set(
      join(res, dir, "ic_launcher.png"),
      await png(markSvg(mark, place, background, size, window)),
    );
  files.set(
    join(here, "play-store/tilecast-play-icon-512.png"),
    await png(markSvg(mark, place, background, PLAY_ICON_SIZE, window)),
  );
  let ink;
  for (const [dir, factor] of Object.entries(BANNER_DENSITIES)) {
    const banner = bannerSvg(wordmark, background, factor);
    ink = banner.ink;
    files.set(join(res, dir, "tilecast_banner.png"), await png(banner.svg));
  }
  const report = {
    background,
    markRadiusDp: Number(radius.toFixed(2)),
    markBoundsDp: [placed.minX, placed.maxX, placed.minY, placed.maxY].map(
      (n) => Number(n.toFixed(2)),
    ),
    markCentroidOffsetDp: placed.centroid.map((n) =>
      Number((n - half).toFixed(2)),
    ),
    bannerInkPx: [ink.width, ink.height].map((n) => Number(n.toFixed(1))),
  };
  return { files, report, mark, place, wordmark, background, window };
}

async function pixelDrift(file, expected) {
  let actual;
  try {
    actual = readFileSync(file);
  } catch {
    return "missing";
  }
  const a = await sharp(actual).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(expected).raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height)
    return `size ${a.info.width}x${a.info.height}, expected ${b.info.width}x${b.info.height}`;
  if (a.info.channels !== b.info.channels) return "channel count differs";
  let total = 0;
  for (let i = 0; i < a.data.length; i++)
    total += Math.abs(a.data[i] - b.data[i]);
  const mean = total / a.data.length;
  // Tolerate anti-aliasing differences between libvips builds.
  return mean > 0.5 ? `pixels differ (mean ${mean.toFixed(2)})` : null;
}

// Inspection sheets: the adaptive icon under common launcher masks with the
// safe-zone circle drawn, the legacy icon, and the banner at reduced size.
async function writePreviews(dir, built) {
  mkdirSync(dir, { recursive: true });
  const { mark, place, background, wordmark } = built;
  const cell = 324; // 3 px per dp
  const k = cell / WINDOW;
  const masks = {
    circle: `<circle cx="${cell / 2}" cy="${cell / 2}" r="${cell / 2}"/>`,
    squircle: (() => {
      const n = 4;
      const pts = Array.from({ length: 180 }, (_, i) => {
        const t = (i / 180) * Math.PI * 2;
        const c = Math.cos(t);
        const s = Math.sin(t);
        return `${(cell / 2 + (cell / 2) * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(1)},${(cell / 2 + (cell / 2) * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(1)}`;
      });
      return `<polygon points="${pts.join(" ")}"/>`;
    })(),
    "rounded-square": `<rect width="${cell}" height="${cell}" rx="${cell * 0.22}"/>`,
    "full-window": `<rect width="${cell}" height="${cell}"/>`,
  };
  const layer = await png(
    markSvg(mark, place, background, Math.round(LAYER * k), [
      0,
      0,
      LAYER,
      LAYER,
    ]),
  );
  const inset = Math.round(((LAYER - WINDOW) / 2) * k);
  const safe = `<circle cx="${cell / 2}" cy="${cell / 2}" r="${SAFE_RADIUS * k}" fill="none" stroke="#FF3B7F" stroke-width="2" stroke-dasharray="6 5"/>`;
  const items = [];
  let x = 0;
  for (const [name, shape] of Object.entries(masks)) {
    const windowed = await sharp(layer)
      .extract({ left: inset, top: inset, width: cell, height: cell })
      .toBuffer();
    const masked = await sharp(windowed)
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${cell}"><g fill="#fff">${shape}</g></svg>`,
          ),
          blend: "dest-in",
        },
      ])
      .png()
      .toBuffer();
    for (const [row, overlay] of [
      [0, null],
      [1, safe],
    ]) {
      let tile = masked;
      if (overlay)
        tile = await sharp(masked)
          .composite([
            {
              input: Buffer.from(
                `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${cell}">${overlay}</svg>`,
              ),
            },
          ])
          .toBuffer();
      items.push({
        input: tile,
        left: 20 + x * (cell + 20),
        top: 20 + row * (cell + 20),
      });
    }
    x++;
  }
  const sheetWidth = 20 + x * (cell + 20);
  await sharp({
    create: {
      width: sheetWidth,
      height: 20 + 2 * (cell + 20),
      channels: 3,
      background: "#5B6470",
    },
  })
    .composite(items)
    .png()
    .toFile(join(dir, "adaptive-masks.png"));

  // Banner: native size, then 50% and 25% to judge couch-distance legibility.
  const full = await png(bannerSvg(wordmark, background, 1).svg);
  const half = await sharp(full)
    .resize(160, 90, { kernel: "lanczos3" })
    .toBuffer();
  const quarter = await sharp(full)
    .resize(80, 45, { kernel: "lanczos3" })
    .toBuffer();
  await sharp({
    create: {
      width: 320 + 160 + 80 + 80,
      height: 180 + 40,
      channels: 3,
      background: "#5B6470",
    },
  })
    .composite([
      { input: full, left: 20, top: 20 },
      { input: half, left: 360, top: 20 },
      { input: quarter, left: 540, top: 20 },
    ])
    .png()
    .toFile(join(dir, "banner-sizes.png"));
}

const args = process.argv.slice(2);
const built = await build();
if (args.includes("--check")) {
  const problems = [];
  for (const [file, expected] of built.files) {
    const label = file.slice(join(here, "..").length + 1);
    if (typeof expected === "string") {
      let actual = null;
      try {
        actual = readFileSync(file, "utf8");
      } catch {}
      if (actual !== expected) problems.push(`${label}: out of date`);
    } else {
      const drift = await pixelDrift(file, expected);
      if (drift) problems.push(`${label}: ${drift}`);
    }
  }
  if (problems.length) {
    console.error(
      `Android launcher assets are stale:\n  ${problems.join("\n  ")}\nRun: npm run android:branding:generate`,
    );
    process.exit(1);
  }
  console.log("Android launcher assets are current.");
} else {
  for (const [file, content] of built.files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  console.log(`Wrote ${built.files.size} files.`, built.report);
  const previewAt = args.indexOf("--preview");
  if (previewAt >= 0) await writePreviews(args[previewAt + 1], built);
}
