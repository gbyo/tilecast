#!/usr/bin/env node
/**
 * Player Runtime performance runs: the same real-time scenarios under the
 * pre-migration Electron renderer and under the shared runtime, on the same
 * machine and Electron build, so before and after are directly comparable.
 *
 *   node conformance/perf.mjs --out DIR --legacy-dir DIR [--rotation-seconds 90]
 *
 * Measured (renderer process unless noted):
 *   startup       process start → first image evidence
 *   activation    presentation sent → image shown
 *   videoStart    presentation sent → first video progress evidence
 *   idleCpu       mean CPU % while one still image stays up
 *   videoCpu      mean CPU % while one video loops
 *   rotationRss   working set at the start and end of a long rotation
 *   cleanup       <video> and layer <img> elements left after the rotation
 *   syncError     |item start − shared boundary| (shared runtime only: the
 *                 legacy bridge needs the old preload's timeline)
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
}
const out = path.resolve(args.get("out") ?? "perf-results");
const legacyDir = args.get("legacy-dir");
const rotationSeconds = Number(args.get("rotation-seconds") ?? 90);

const item = (id, overrides = {}) => ({
  id,
  kind: "image",
  src: "",
  durationMs: 3_000,
  fitMode: "contain",
  audioEnabled: false,
  volume: 1,
  videoStartOffsetMs: null,
  videoEndOffsetMs: null,
  ...overrides,
});
const playing = (items, extra = {}) => ({
  state: "playing",
  items,
  generation: 1,
  takeover: false,
  synchronized: false,
  ...extra,
});
const base = {
  realtime: true,
  wallClock: "2026-09-01T16:00:00.000Z",
  viewport: { width: 1280, height: 720 },
};

export const perfScenarios = (rotationSeconds = 90) => [
  {
    ...base,
    name: "perf-still",
    steps: [
      {
        present: {
          presentation: playing([
            item("still", { src: "media:landscape", durationMs: null }),
          ]),
        },
      },
      { waitForEvidence: { kind: "image-shown", itemId: "still" } },
      { hold: 20_000 },
      { checkpoint: "end" },
    ],
  },
  {
    ...base,
    name: "perf-video",
    video: true,
    steps: [
      {
        present: {
          presentation: playing([
            item("clip", {
              kind: "video",
              src: "media:clip",
              durationMs: null,
            }),
          ]),
        },
      },
      { waitForEvidence: { kind: "video-progress", itemId: "clip" } },
      { hold: 20_000 },
      { checkpoint: "end" },
    ],
  },
  {
    ...base,
    name: "perf-rotation",
    video: true,
    steps: [
      {
        present: {
          presentation: playing([
            item("r1", { src: "media:landscape", transition: "fade" }),
            item("r2", { src: "media:square", transition: "fade" }),
            item("r3", {
              kind: "video",
              src: "media:clip",
              durationMs: null,
              videoEndOffsetMs: 3_000,
              transition: "fade",
            }),
            item("r4", { src: "media:portrait", transition: "fade" }),
          ]),
        },
      },
      { waitForEvidence: { kind: "image-shown", itemId: "r1" } },
      { hold: rotationSeconds * 1_000 },
      { checkpoint: "end" },
    ],
  },
  {
    ...base,
    name: "perf-sync",
    legacy: false,
    steps: [
      {
        present: {
          presentation: playing(
            ["s1", "s2", "s3", "s4"].map((id) =>
              item(id, { src: "media:square", durationMs: 2_000 }),
            ),
            { synchronized: true },
          ),
          timing: {
            groupId: "g",
            anchorMs: "now",
            durationsMs: [2_000, 2_000, 2_000, 2_000],
            clockOffsetMs: 0,
          },
        },
      },
      { hold: 20_000 },
      { checkpoint: "end" },
    ],
  },
];

const run = (engine) => {
  const dir = path.join(out, engine);
  const result = spawnSync(
    process.execPath,
    [
      path.join(here, "run.mjs"),
      "--engine",
      engine,
      "--out",
      out,
      "--perf",
      "1",
      "--suite",
      "perf",
      "--rotation-seconds",
      String(rotationSeconds),
      ...(engine === "electron-legacy" ? ["--legacy-dir", legacyDir] : []),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0)
    console.error(`perf: ${engine} run reported failures`);
  return dir;
};

const mean = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const round = (value, digits = 1) =>
  value === null || value === undefined ? null : Number(value.toFixed(digits));

function analyse(dir) {
  const read = (name, file) => {
    const target = path.join(dir, name, file);
    return fs.existsSync(target)
      ? JSON.parse(fs.readFileSync(target, "utf8"))
      : null;
  };
  const first = (timeline, prefix) =>
    timeline?.find((e) => e.entry.startsWith(prefix))?.t ?? null;
  const renderer = (sample) =>
    sample.processes.filter((p) => p.type === "Tab" || p.type === "Renderer");
  const cpuAfter = (metrics, from) =>
    mean(
      (metrics?.samples ?? [])
        .filter((sample) => sample.t >= from + 3_000)
        .map((sample) => renderer(sample).reduce((sum, p) => sum + p.cpu, 0)),
    );
  const out = {};

  const still = read("perf-still", "result.json");
  const stillMetrics = read("perf-still", "metrics.json");
  if (still?.timeline && stillMetrics) {
    const present = first(still.timeline, "present");
    const shown = first(still.timeline, "image-shown");
    out.startupMs = round(shown - stillMetrics.startedAt, 0);
    out.activationMs = round(shown - present, 0);
    out.idleCpuPercent = round(cpuAfter(stillMetrics, shown));
  }
  const video = read("perf-video", "result.json");
  const videoMetrics = read("perf-video", "metrics.json");
  if (video?.timeline && videoMetrics) {
    const present = first(video.timeline, "present");
    const progress = first(video.timeline, "video-progress");
    out.videoStartMs = round(progress - present, 0);
    out.videoCpuPercent = round(cpuAfter(videoMetrics, progress));
  }
  const rotation = read("perf-rotation", "result.json");
  const rotationMetrics = read("perf-rotation", "metrics.json");
  if (rotation?.checkpoints?.length && rotationMetrics) {
    const rss = rotationMetrics.samples.map(
      (sample) =>
        renderer(sample).reduce((sum, p) => sum + p.workingSetKb, 0) / 1024,
    );
    const shown = first(rotation.timeline, "image-shown");
    const settledAt = rotationMetrics.samples.findIndex(
      (sample) => sample.t >= shown + 5_000,
    );
    out.rotationRssMb = {
      start: round(rss[Math.max(settledAt, 0)]),
      end: round(rss.at(-1)),
      max: round(Math.max(...rss)),
    };
    out.rotationItems = rotation.timeline.filter((e) =>
      e.entry.startsWith("item-started"),
    ).length;
    out.cleanup = rotation.checkpoints.at(-1).state.document ?? null;
    out.rotationCpuPercent = round(cpuAfter(rotationMetrics, shown));
  }
  const sync = read("perf-sync", "result.json");
  if (sync?.timeline) {
    const anchor = Number(
      sync.timeline.find((e) => e.entry.startsWith("anchor:"))?.entry.slice(7),
    );
    const starts = sync.timeline
      .filter((e) => e.entry.startsWith("item-started"))
      .slice(1);
    const errors = starts.map((start) => {
      const offset = start.t - anchor;
      const boundary = Math.round(offset / 2_000) * 2_000;
      return Math.abs(offset - boundary);
    });
    out.syncBoundaryErrorMs = {
      boundaries: errors.length,
      mean: round(mean(errors)),
      max: round(errors.length ? Math.max(...errors) : null),
    };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!legacyDir) {
    console.error("perf: --legacy-dir is required");
    process.exit(64);
  }
  const legacy = analyse(run("electron-legacy"));
  const runtime = analyse(run("electron"));
  const report = { rotationSeconds, legacy, runtime };
  fs.writeFileSync(
    path.join(out, "perf-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
