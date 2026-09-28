/**
 * Parity baseline: drives the pre-migration Electron renderer (the global
 * scripts under static/ and dist/renderer/ that the shared Player Runtime
 * replaced) with the same conformance fixtures, through its original
 * `window.tilecast` bridge.
 *
 * The legacy renderer keeps time with browser timers, so this driver runs in
 * real time: `advance` waits, and a checkpoint waits for the renderer's own
 * 300 ms crossfade to finish. It is a recorded baseline for the migration,
 * not a deterministic engine comparison. Fixtures that need features the
 * legacy bridge did not have (a shared timeline anchor, host noise levels,
 * projection references) are skipped by the runner.
 */
const { ipcRenderer } = require("electron");
const fs = require("node:fs");

const arg = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const fixture = JSON.parse(fs.readFileSync(arg("tc-fixture"), "utf8"));
const media = fixture.media ?? {};

const substitute = (value) => {
  if (typeof value === "string" && value.startsWith("media:"))
    return media[value.slice(6)];
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v)]),
    );
  }
  return value;
};

const listeners = {
  present: [],
  plugins: [],
  identify: [],
  retry: [],
  skip: [],
  discovered: [],
};
let evidence = [];
const timeline = [];
const mark = (entry) =>
  timeline.push({ t: performance.timeOrigin + performance.now(), entry });
let errors = [];
const emit = (list, value) => list.forEach((callback) => callback(value));

window.tilecast = {
  onPresent: (callback) => listeners.present.push(callback),
  onPlugins: (callback) => listeners.plugins.push(callback),
  onSyncPosition: (callback) => callback(null),
  onIdentify: (callback) => listeners.identify.push(callback),
  onRetryItem: (callback) => listeners.retry.push(callback),
  onSkipItem: (callback) => listeners.skip.push(callback),
  reportProgress: (itemId, kind, zoneId) => {
    evidence.push(`${kind}:${itemId ?? "-"}${zoneId ? `/${zoneId}` : ""}`);
    mark(`${kind}:${itemId ?? "-"}`);
  },
  reportPlaybackError: (itemId, message) =>
    errors.push(`${itemId ?? "-"}:${message}`),
  reportNoiseMeterDiagnostic() {},
  reportNoiseMeter() {},
  reportWebsiteRecovered() {},
  submitServerUrl: async () => ({ ok: true }),
  onDiscoveredServer: (callback) => listeners.discovered.push(callback),
  listDiscoveredServers: async () => [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frames = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
const text = (element) =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

function describe() {
  const layer = document.querySelector(".layer.visible");
  const video = layer?.querySelector("video");
  const message = document.getElementById("message");
  return {
    message: {
      visible: message?.classList.contains("visible") ?? false,
      text: text(message),
    },
    front: layer
      ? {
          kind: video
            ? "video"
            : layer.querySelector("webview")
              ? "website"
              : layer.querySelectorAll("img").length
                ? "image-or-tree"
                : "tree",
          images: layer.querySelectorAll("img").length,
          videos: layer.querySelectorAll("video").length,
          text: text(layer).slice(0, 400),
        }
      : { kind: null },
    document: {
      videos: document.querySelectorAll("video").length,
      images: document.querySelectorAll(".layer img").length,
    },
    identify: document.getElementById("identify")?.classList.contains("visible")
      ? text(document.getElementById("identify"))
      : null,
  };
}

async function settle() {
  await document.fonts.ready;
  // The legacy renderer's crossfade is a 300 ms CSS transition with cleanup
  // at 500 ms; let it finish so the frame is at rest.
  await sleep(600);
  await Promise.all(
    Array.from(
      document.querySelectorAll(".layer.visible img, #message img"),
    ).map((image) =>
      image.complete
        ? null
        : new Promise((resolve) => (image.onload = image.onerror = resolve)),
    ),
  );
  await frames();
}

async function waitForEvidence({ kind, itemId, timeoutMs = 20_000 }) {
  const deadline = performance.now() + timeoutMs;
  while (
    !evidence.some((entry) => entry.startsWith(`${kind}:${itemId ?? ""}`))
  ) {
    if (performance.now() > deadline)
      throw new Error(`timed out waiting for ${kind}`);
    await sleep(50);
  }
}

async function run() {
  const checkpoints = [];
  mark("ready");
  for (const step of fixture.steps) {
    if ("hold" in step) await sleep(step.hold);
    else if (step.present) {
      mark("present");
      emit(listeners.present, substitute(step.present.presentation));
    } else if (step.plugins)
      emit(listeners.plugins, {
        plugins: substitute(step.plugins.plugins),
        clockOffsetMs: 0,
      });
    else if (step.identify) emit(listeners.identify, step.identify);
    else if (step.command === "retry-item") emit(listeners.retry);
    else if (step.command === "skip-item") emit(listeners.skip);
    else if (step.discovered) emit(listeners.discovered, step.discovered);
    else if ("advance" in step) await sleep(step.advance);
    else if (step.waitForEvidence) await waitForEvidence(step.waitForEvidence);
    else if (step.checkpoint) {
      await settle();
      const checkpoint = {
        name: step.checkpoint,
        visual: !!step.visual,
        state: describe(),
        evidence,
        errors,
      };
      evidence = [];
      errors = [];
      if (checkpoint.visual)
        await ipcRenderer.invoke("conformance-snapshot", step.checkpoint);
      checkpoints.push(checkpoint);
    }
    await sleep(0);
  }
  return checkpoints;
}

window.addEventListener("DOMContentLoaded", () => {
  run().then(
    (checkpoints) =>
      ipcRenderer.send("conformance-finish", {
        fixture: fixture.name,
        engine: { userAgent: navigator.userAgent, renderer: "legacy" },
        checkpoints,
        failure: null,
        timeline,
      }),
    (error) =>
      ipcRenderer.send("conformance-finish", {
        fixture: fixture.name,
        engine: { userAgent: navigator.userAgent, renderer: "legacy" },
        checkpoints: [],
        failure: String(error?.stack ?? error),
      }),
  );
});
