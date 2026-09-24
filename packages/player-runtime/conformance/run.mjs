#!/usr/bin/env node
/**
 * Runs the Player Runtime conformance fixtures on one engine.
 *
 *   node conformance/run.mjs --engine electron --out DIR [--only a,b]
 *   node conformance/run.mjs --engine wpe --out DIR --wpe-runner BIN \
 *     --gst-plugin-dir DIR [--only a,b]
 *
 * Results land in DIR/<engine>/<fixture>/ (result.json and screenshots). The
 * environment is normalized for every engine: UTC, en-US, a fixed viewport,
 * device scale 1, the bundled font, a manual clock and instant transitions.
 * Compare two engines with conformance/compare.mjs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtures as conformanceFixtures } from "./fixtures.mjs";
import { perfScenarios } from "./perf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");
const repo = path.join(pkg, "..", "..");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1]);
}
const engine = args.get("engine");
const out = path.resolve(args.get("out") ?? "conformance-results");
const only = args.get("only")?.split(",") ?? null;
const perf = args.has("perf");
const fixtures =
  args.get("suite") === "perf"
    ? perfScenarios(Number(args.get("rotation-seconds") ?? 90))
    : conformanceFixtures;
if (!["electron", "electron-legacy", "wpe"].includes(engine)) {
  console.error("run: --engine electron|electron-legacy|wpe is required");
  process.exit(64);
}

const runtimeDir = path.join(pkg, "dist", "runtime");
const hostScript = path.join(pkg, "dist", "conformance", "conformance-host.js");
for (const required of [
  path.join(runtimeDir, "runtime-manifest.json"),
  hostScript,
]) {
  if (!fs.existsSync(required)) {
    console.error(
      `run: ${required} is missing; run npm run build in packages/player-runtime`,
    );
    process.exit(66);
  }
}

const engineDir = path.join(out, engine);
fs.rmSync(engineDir, { recursive: true, force: true });
const mediaDir = path.join(engineDir, "media");
const media = spawnSync(
  process.execPath,
  [path.join(here, "media.mjs"), mediaDir],
  {
    stdio: "inherit",
  },
);
if (media.status !== 0) process.exit(media.status ?? 1);
const { video, media: objects } = JSON.parse(
  fs.readFileSync(path.join(mediaDir, "media.json"), "utf8"),
);
const mediaMap = Object.fromEntries(
  Object.entries(objects).map(([name, entry]) => [name, entry.uri]),
);

const env = {
  ...process.env,
  TZ: "UTC",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LANGUAGE: "en_US",
};

const summary = [];
for (const fixture of fixtures) {
  if (only && !only.includes(fixture.name)) continue;
  if (engine === "electron-legacy" && fixture.legacy === false) {
    summary.push({
      fixture: fixture.name,
      status: "skipped",
      reason: "not expressible through the legacy bridge",
    });
    continue;
  }
  if (fixture.video && !video) {
    summary.push({
      fixture: fixture.name,
      status: "skipped",
      reason: "no FFmpeg for the video clip",
    });
    continue;
  }
  const dir = path.join(engineDir, fixture.name);
  fs.mkdirSync(dir, { recursive: true });
  const fixtureFile = path.join(dir, "fixture.json");
  fs.writeFileSync(
    fixtureFile,
    JSON.stringify({ ...fixture, media: mediaMap }, null, 2),
  );
  const started = Date.now();
  let child;
  if (engine === "electron" || engine === "electron-legacy") {
    const electron =
      process.env.TILECAST_ELECTRON ??
      path.join(repo, "node_modules", ".bin", "electron");
    const runner = path.join(
      repo,
      "apps",
      "player-linux",
      "conformance",
      "runner.cjs",
    );
    const command = [
      // Chromium refuses to start as root (CI containers) without this.
      // Test harness only; the player never runs as root.
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      runner,
      "--fixture",
      fixtureFile,
      "--runtime-dir",
      runtimeDir,
      "--host-script",
      hostScript,
      "--cas-root",
      path.join(mediaDir, "cas"),
      "--out",
      dir,
      ...(engine === "electron-legacy"
        ? ["--legacy-dir", path.resolve(args.get("legacy-dir") ?? "")]
        : []),
      ...(perf ? ["--perf"] : []),
    ];
    // Linux CI has no display: run under a virtual framebuffer when present.
    const xvfb = process.platform === "linux" && !process.env.DISPLAY;
    child = xvfb
      ? spawnSync(
          "xvfb-run",
          ["-a", "-s", "-screen 0 1920x1080x24", electron, ...command],
          { env, stdio: "inherit" },
        )
      : spawnSync(electron, command, { env, stdio: "inherit" });
  } else {
    const runner = args.get("wpe-runner");
    const gst = args.get("gst-plugin-dir");
    if (!runner || !gst) {
      console.error(
        "run: --wpe-runner and --gst-plugin-dir are required for wpe",
      );
      process.exit(64);
    }
    child = spawnSync(
      runner,
      [
        "--runtime-dir",
        runtimeDir,
        "--host-script",
        hostScript,
        "--fixture",
        fixtureFile,
        "--cas-root",
        path.join(mediaDir, "cas"),
        "--out",
        dir,
        `--size=${fixture.viewport.width}x${fixture.viewport.height}`,
      ],
      {
        env: {
          ...env,
          GST_PLUGIN_PATH: gst,
          WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1",
          WPE_PLATFORM: "headless",
        },
        stdio: "inherit",
      },
    );
  }
  const resultFile = path.join(dir, "result.json");
  const result = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, "utf8"))
    : null;
  const status =
    child.status === 0 && result && !result.failure ? "completed" : "failed";
  summary.push({
    fixture: fixture.name,
    status,
    exitCode: child.status,
    failure: result?.failure ?? (result ? null : "no result"),
    seconds: (Date.now() - started) / 1000,
  });
  console.log(`run: ${engine} ${fixture.name}: ${status}`);
}
fs.writeFileSync(
  path.join(engineDir, "summary.json"),
  JSON.stringify(summary, null, 2),
);
const failed = summary.filter((entry) => entry.status === "failed");
if (failed.length) {
  console.error(`run: ${failed.length} fixture(s) failed on ${engine}`);
  for (const entry of failed)
    console.error(`  ${entry.fixture}: ${entry.failure}`);
  process.exit(1);
}
