#!/usr/bin/env node
/**
 * Widgets V2 performance runs (docs/widgets-v2.md). Real time, Electron,
 * one sample of every process's CPU and memory each second.
 *
 *   node conformance/widget-perf.mjs --out DIR [--seconds 60]
 *
 * Scenarios:
 *   widget-compat-clock    the compatibility RenderNode clock with seconds
 *                          (the renderer Clock V2 replaces), fullscreen
 *   widget-clock           Clock V2 with seconds, fullscreen
 *   widget-layout          a Layout with four Clock V2 zones (two with seconds)
 *   widget-rotation        a one-second rotation of Clock V2, a compatibility
 *                          clock and an image, for rotation seconds
 *
 * Reported: renderer CPU after warm-up, working set over the run, and the
 * Widget elements, media elements and pending state left at the end.
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
const out = path.resolve(args.get("out") ?? "widget-perf-results");
const seconds = Number(args.get("seconds") ?? 60);

const item = (id, overrides = {}) => ({
  id,
  kind: "widget",
  src: "",
  durationMs: null,
  fitMode: "contain",
  audioEnabled: false,
  volume: 1,
  videoStartOffsetMs: null,
  videoEndOffsetMs: null,
  ...overrides,
});
const playing = (items) => ({
  state: "playing",
  items,
  generation: 1,
  takeover: false,
  synchronized: false,
});
const component = (config) => ({
  component: {
    type: "tilecast.clock",
    version: 1,
    config: {
      timeZone: "",
      format: "24",
      showSeconds: true,
      style: "standard",
      showDate: true,
      background: "",
      foreground: "",
      ...config,
    },
    dataSources: [],
    media: [],
  },
  documents: {},
  media: {},
  regional: { locale: "en-US", timeZone: "UTC", hourCycle: "locale" },
});
const compatClock = {
  background: "#0E141B",
  root: {
    t: "box",
    style: {
      width: 100,
      height: 100,
      direction: "column",
      justify: "center",
      align: "center",
    },
    children: [
      {
        t: "clock",
        timezone: "UTC",
        locale: "en-US",
        hour12: false,
        showSeconds: true,
        style: { color: "#F5F7FA", fontSize: 96, fontWeight: 700 },
      },
    ],
  },
};
const zone = (id, x, y, width, height, config) => ({
  id,
  x,
  y,
  width,
  height,
  layer: 1,
  opacity: 1,
  component: component(config),
});
const base = {
  realtime: true,
  wallClock: "2026-09-01T16:00:00.000Z",
  viewport: { width: 1280, height: 720 },
};
const hold = (evidence, itemId) => [
  { waitForEvidence: { kind: evidence, itemId } },
  { hold: seconds * 1_000 },
  { checkpoint: "end" },
];

export const widgetPerfScenarios = () => [
  {
    ...base,
    name: "widget-compat-clock",
    steps: [
      {
        present: {
          presentation: playing([item("compat", { widget: compatClock })]),
        },
      },
      ...hold("widget-shown", "compat"),
    ],
  },
  {
    ...base,
    name: "widget-clock",
    steps: [
      {
        present: {
          presentation: playing([item("v2", { widget: component({}) })]),
        },
      },
      ...hold("widget-shown", "v2"),
    ],
  },
  {
    ...base,
    name: "widget-layout",
    steps: [
      {
        present: {
          presentation: playing([
            item("layout", {
              kind: "layout",
              layout: {
                canvasWidth: 1920,
                canvasHeight: 1080,
                background: "#0B1220",
                zones: [
                  zone("a", 0, 0, 960, 540, { style: "analog" }),
                  zone("b", 960, 0, 960, 540, { showSeconds: false }),
                  zone("c", 0, 540, 960, 540, { timeZone: "Asia/Tokyo" }),
                  zone("d", 960, 540, 960, 540, {
                    style: "minimal",
                    showSeconds: false,
                  }),
                ],
              },
            }),
          ]),
        },
      },
      ...hold("layout-shown", "layout"),
    ],
  },
  {
    ...base,
    name: "widget-rotation",
    steps: [
      {
        present: {
          presentation: playing([
            item("r1", { widget: component({}), durationMs: 1_000 }),
            item("r2", { widget: compatClock, durationMs: 1_000 }),
            item("r3", {
              widget: component({ style: "analog" }),
              durationMs: 1_000,
            }),
            item("r4", {
              kind: "image",
              src: "media:landscape",
              durationMs: 1_000,
            }),
          ]),
        },
      },
      { waitForEvidence: { kind: "widget-shown", itemId: "r1" } },
      { hold: seconds * 1_000 },
      { checkpoint: "end" },
    ],
  },
];

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
  const renderer = (sample) =>
    sample.processes.filter((p) => p.type === "Tab" || p.type === "Renderer");
  const report = {};
  for (const { name } of widgetPerfScenarios()) {
    const result = read(name, "result.json");
    const metrics = read(name, "metrics.json");
    if (!result || !metrics) {
      report[name] = { failure: result?.failure ?? "no result" };
      continue;
    }
    const shown = result.timeline?.find((e) => /-shown:/.test(e.entry))?.t ?? 0;
    const settled = metrics.samples.filter((s) => s.t >= shown + 5_000);
    const rss = settled.map(
      (s) => renderer(s).reduce((sum, p) => sum + p.workingSetKb, 0) / 1024,
    );
    report[name] = {
      failure: result.failure,
      cpuPercent: round(
        mean(
          settled.map((s) => renderer(s).reduce((sum, p) => sum + p.cpu, 0)),
        ),
        2,
      ),
      rssMb: {
        start: round(rss[0]),
        end: round(rss.at(-1)),
        max: round(rss.length ? Math.max(...rss) : null),
      },
      items: result.timeline.filter((e) => e.entry.startsWith("item-started"))
        .length,
      end: result.checkpoints.at(-1)?.state?.document ?? null,
    };
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(here, "run.mjs"),
      "--engine",
      "electron",
      "--out",
      out,
      "--perf",
      "1",
      "--suite",
      "widget-perf",
      "--seconds",
      String(seconds),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0)
    console.error("widget-perf: the run reported failures");
  const report = { seconds, electron: analyse(path.join(out, "electron")) };
  fs.writeFileSync(
    path.join(out, "widget-perf-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
