#!/usr/bin/env node
/**
 * Generates the conformance fixtures' media deterministically and lays it out
 * as a content-addressed store (<dir>/cas/sha256/<ab>/<hex>), the same shape
 * the Edge CAS and the WPE media source use. Writes <dir>/media.json mapping
 * each media name to its tcmedia://sha256/<hex> URI.
 *
 * Images are drawn in code (pngjs), so they are byte-identical on every
 * machine. The video clip needs FFmpeg; without it, video fixtures are skipped
 * and the run says so.
 *
 * Usage: media.mjs <dir>
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: media.mjs <dir>");
  process.exit(2);
}
fs.mkdirSync(dir, { recursive: true });

function png(width, height, paint) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const offset = (width * y + x) << 2;
      image.data[offset] = r;
      image.data[offset + 1] = g;
      image.data[offset + 2] = b;
      image.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(image, { colorType: 6, deflateLevel: 9 });
}

// Four flat quadrants and a white frame: contain shows bars, cover crops the
// frame, and a wrong fit or rotation is obvious in a diff.
const quadrants = (w, h) => (x, y) => {
  if (x < 6 || y < 6 || x >= w - 6 || y >= h - 6) return [255, 255, 255];
  const left = x < w / 2;
  const top = y < h / 2;
  if (top && left) return [220, 38, 38];
  if (top) return [37, 99, 235];
  if (left) return [22, 163, 74];
  return [234, 179, 8];
};

const outputs = {
  "landscape.png": png(640, 360, quadrants(640, 360)),
  "portrait.png": png(360, 640, quadrants(360, 640)),
  "square.png": png(400, 400, (x, y) =>
    ((x >> 5) + (y >> 5)) % 2 ? [15, 23, 42] : [148, 163, 184],
  ),
  "logo.png": png(240, 80, (x, y) =>
    x < 80 ? [76, 139, 245] : y < 40 ? [245, 247, 250] : [14, 20, 27],
  ),
};

let video = false;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  const clip = path.join(dir, "clip.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=4",
      "-c:v",
      "libx264",
      "-profile:v",
      "baseline",
      "-pix_fmt",
      "yuv420p",
      "-bitexact",
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      clip,
    ],
    { stdio: "inherit" },
  );
  outputs["clip.mp4"] = fs.readFileSync(clip);
  video = true;
} catch {
  console.warn(
    "media: FFmpeg is not available; video fixtures will be skipped",
  );
}

const map = {};
for (const [name, bytes] of Object.entries(outputs)) {
  const hex = crypto.createHash("sha256").update(bytes).digest("hex");
  const target = path.join(dir, "cas", "sha256", hex.slice(0, 2), hex);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  map[name.replace(/\.[a-z0-9]+$/, "")] = {
    uri: `tcmedia://sha256/${hex}`,
    file: path.relative(dir, target),
    mimeType: name.endsWith(".mp4") ? "video/mp4" : "image/png",
    bytes: bytes.length,
  };
}
fs.writeFileSync(
  path.join(dir, "media.json"),
  JSON.stringify({ video, media: map }, null, 2) + "\n",
);
console.log(`media: ${Object.keys(map).length} objects in ${dir}`);
