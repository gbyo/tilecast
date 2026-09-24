#!/usr/bin/env node
/**
 * Compares two engines' conformance results fixture by fixture.
 *
 *   node conformance/compare.mjs --a DIR/electron --b DIR/wpe --report DIR/report
 *
 * Semantic: every checkpoint's runtime state, evidence, playback errors and
 * presentation results must be identical. Visual: checkpoints marked visual
 * are compared perceptually (pixelmatch, anti-aliasing tolerant) and fail
 * above a small mismatch budget, since two engines rasterize text and edges
 * slightly differently. Active video and remote web content are never
 * pixel-compared (fixtures do not mark them visual).
 *
 * On a failure the report directory keeps both screenshots, the diff, the
 * fixture input and the engine versions.
 */
import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
}
const a = path.resolve(args.get("a") ?? "");
const b = path.resolve(args.get("b") ?? "");
const reportDir = path.resolve(args.get("report") ?? "conformance-report");
/**
 * `--subset legacy` compares a run against the pre-migration renderer: only
 * what that renderer can express (the DOM-derived state and the evidence it
 * reported), and screenshots are reported without failing, since the new
 * runtime bundles its own UI font where the old one used system-ui.
 */
const LEGACY = args.get("subset") === "legacy";
/** Share of pixels allowed to differ in a visual checkpoint. */
const BUDGET = Number(args.get("budget") ?? 0.015);
fs.rmSync(reportDir, { recursive: true, force: true });
fs.mkdirSync(reportDir, { recursive: true });

function readImage(dir, name) {
  const png = path.join(dir, `${name}.png`);
  if (fs.existsSync(png)) return PNG.sync.read(fs.readFileSync(png));
  const raw = path.join(dir, `${name}.raw`);
  const meta = path.join(dir, `${name}.json`);
  if (!fs.existsSync(raw) || !fs.existsSync(meta)) return null;
  // WebKitImage snapshots are premultiplied BGRA rows with a stride.
  const { width, height, stride } = JSON.parse(fs.readFileSync(meta, "utf8"));
  const bytes = fs.readFileSync(raw);
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const from = y * stride + x * 4;
      const to = (y * width + x) * 4;
      const alpha = bytes[from + 3];
      const unpremultiply = (value) =>
        alpha === 0 ? 0 : Math.min(255, Math.round((value * 255) / alpha));
      image.data[to] = unpremultiply(bytes[from + 2]);
      image.data[to + 1] = unpremultiply(bytes[from + 1]);
      image.data[to + 2] = unpremultiply(bytes[from]);
      image.data[to + 3] = alpha;
    }
  }
  return image;
}

const stable = (value) =>
  JSON.stringify(value, Object.keys(flatKeys(value)).sort());
function flatKeys(value, keys = {}) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      keys[key] = true;
      flatKeys(value[key], keys);
    }
  }
  return keys;
}

function version(dir) {
  const file = path.join(path.dirname(dir), "wpe-engine-versions.txt");
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n")
    : null;
}

const report = {
  a: { dir: a, versions: version(a) },
  b: { dir: b, versions: version(b) },
  budget: BUDGET,
  fixtures: [],
};
let failures = 0;
const names = fs
  .readdirSync(a, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "media")
  .map((entry) => entry.name)
  .sort();

for (const name of names) {
  const resultA = path.join(a, name, "result.json");
  const resultB = path.join(b, name, "result.json");
  if (LEGACY && !fs.existsSync(resultB)) continue;
  const entry = { fixture: name, status: "passed", problems: [], visual: [] };
  report.fixtures.push(entry);
  if (!fs.existsSync(resultA) || !fs.existsSync(resultB)) {
    entry.status = "missing";
    entry.problems.push("a result is missing on one engine");
    failures += 1;
    continue;
  }
  const ra = JSON.parse(fs.readFileSync(resultA, "utf8"));
  const rb = JSON.parse(fs.readFileSync(resultB, "utf8"));
  entry.engines = { a: ra.engine, b: rb.engine };
  if (ra.failure || rb.failure) {
    entry.problems.push(
      `run failure: ${ra.failure ?? ""} ${rb.failure ?? ""}`.trim(),
    );
  }
  const checkpoints = Math.max(ra.checkpoints.length, rb.checkpoints.length);
  for (let index = 0; index < checkpoints; index += 1) {
    const ca = ra.checkpoints[index];
    const cb = rb.checkpoints[index];
    if (!ca || !cb || ca.name !== cb.name) {
      entry.problems.push(
        `checkpoint ${index} differs: ${ca?.name} vs ${cb?.name}`,
      );
      continue;
    }
    const project = (checkpoint, field) => {
      if (!LEGACY) return checkpoint[field];
      if (field === "state") {
        // Only what the old DOM can say: whitespace between text nodes and
        // the new probe's item id are not behavior.
        const { message, front, identify, document } = checkpoint.state ?? {};
        const { itemId: _itemId, ...layer } = front ?? {};
        return {
          message: message && {
            visible: message.visible,
            text: String(message.text).replace(/\s+/g, ""),
          },
          front: {
            ...layer,
            text: String(layer.text ?? "").replace(/\s+/g, ""),
          },
          identify,
          document,
        };
      }
      if (field === "evidence") {
        // The legacy baseline runs in real time, so evidence that races
        // (two zones finishing in the same frame) is compared as a set.
        return (checkpoint.evidence ?? [])
          .filter((e) => !e.startsWith("surface-shown"))
          .sort();
      }
      return field === "results" ? [] : checkpoint[field];
    };
    for (const field of ["state", "evidence", "errors", "results"]) {
      if (stable(project(ca, field)) !== stable(project(cb, field))) {
        entry.problems.push(`${ca.name}: ${field} differs`);
        entry.semanticDiff ??= [];
        entry.semanticDiff.push({
          checkpoint: ca.name,
          field,
          a: project(ca, field),
          b: project(cb, field),
        });
      }
    }
    if (!ca.visual) continue;
    const ia = readImage(path.join(a, name), ca.name);
    const ib = readImage(path.join(b, name), ca.name);
    if (!ia || !ib) {
      entry.problems.push(`${ca.name}: screenshot missing`);
      continue;
    }
    if (ia.width !== ib.width || ia.height !== ib.height) {
      entry.problems.push(`${ca.name}: screenshot sizes differ`);
      continue;
    }
    const diff = new PNG({ width: ia.width, height: ia.height });
    const mismatched = pixelmatch(
      ia.data,
      ib.data,
      diff.data,
      ia.width,
      ia.height,
      {
        threshold: 0.12,
        includeAA: false,
      },
    );
    const ratio = mismatched / (ia.width * ia.height);
    const passed = LEGACY || ratio <= BUDGET;
    entry.visual.push({
      checkpoint: ca.name,
      mismatchRatio: Number(ratio.toFixed(5)),
      passed,
    });
    const keep = path.join(reportDir, name);
    fs.mkdirSync(keep, { recursive: true });
    fs.writeFileSync(
      path.join(keep, `${ca.name}.chromium.png`),
      PNG.sync.write(ia),
    );
    fs.writeFileSync(
      path.join(keep, `${ca.name}.webkit.png`),
      PNG.sync.write(ib),
    );
    fs.writeFileSync(
      path.join(keep, `${ca.name}.diff.png`),
      PNG.sync.write(diff),
    );
    if (!passed) {
      entry.problems.push(
        `${ca.name}: ${(ratio * 100).toFixed(2)}% of pixels differ`,
      );
    }
  }
  if (entry.problems.length) {
    entry.status = "failed";
    failures += 1;
    const keep = path.join(reportDir, name);
    fs.mkdirSync(keep, { recursive: true });
    fs.copyFileSync(
      path.join(a, name, "fixture.json"),
      path.join(keep, "fixture.json"),
    );
  }
}

fs.writeFileSync(
  path.join(reportDir, "report.json"),
  JSON.stringify(report, null, 2),
);
const lines = [
  "| Fixture | Result | Visual checkpoints (mismatch) |",
  "| --- | --- | --- |",
];
for (const entry of report.fixtures) {
  const visual = entry.visual
    .map((v) => `${v.checkpoint} ${(v.mismatchRatio * 100).toFixed(2)}%`)
    .join(", ");
  lines.push(`| ${entry.fixture} | ${entry.status} | ${visual || "—"} |`);
}
fs.writeFileSync(path.join(reportDir, "report.md"), lines.join("\n") + "\n");
console.log(lines.join("\n"));
for (const entry of report.fixtures.filter((e) => e.problems.length)) {
  console.error(`\n${entry.fixture}:\n  ${entry.problems.join("\n  ")}`);
}
process.exit(failures ? 1 : 0);
