/**
 * Electron/Chromium runner for the Player Runtime conformance suite.
 *
 * Loads the shared runtime through the player's own tilecast://runtime/
 * protocol module (dist/main/runtime-protocol.js) — the same origin, the same
 * path validation, the same scheme privileges as the product — and injects
 * the shared conformance fixture host instead of the product preload. Media is
 * served from the fixture's content-addressed store. The WPE runner
 * (apps/edge/renderer-wpe/tests/conformance.c) does the same under WebKit.
 *
 *   electron conformance/runner.cjs --fixture FILE --runtime-dir DIR
 *     --host-script FILE --cas-root DIR --out DIR
 */
const { app, BrowserWindow, ipcMain, net, protocol } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  loadRuntimeFiles,
  serveRuntimeRequest,
  RUNTIME_ENTRY_URL,
  RUNTIME_SCHEME,
  RUNTIME_SCHEME_PRIVILEGES,
} = require("../dist/main/runtime-protocol.js");

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) {
    console.error(`conformance: missing --${name}`);
    process.exit(64);
  }
  return path.resolve(process.argv[index + 1]);
}

const fixturePath = option("fixture");
const runtimeDir = option("runtime-dir");
const hostScript = option("host-script");
const casRoot = option("cas-root");
const outDir = option("out");
// --legacy-dir: drive the pre-migration renderer instead (parity baseline).
const legacyIndex = process.argv.indexOf("--legacy-dir");
const legacyDir =
  legacyIndex > 0 ? path.resolve(process.argv[legacyIndex + 1]) : null;
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

// Normalized rendering: one device pixel per CSS pixel, a fixed locale and
// the software rasterizer so screenshots do not depend on the GPU.
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("lang", "en-US");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("hide-scrollbars");
// Screenshots are compared in sRGB; never the host display's colour profile.
app.commandLine.appendSwitch("force-color-profile", "srgb");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "tcmedia",
    privileges: { standard: true, stream: true, supportFetchAPI: true },
  },
  RUNTIME_SCHEME_PRIVILEGES,
]);

// --perf: sample every process's CPU and memory once a second.
const perf = process.argv.includes("--perf");
const startedAt = Date.now();
const samples = [];
// --perf also records the renderer's JS heap and DOM node count after a
// forced garbage collection every 10 seconds, which separates a leak from
// ordinary heap growth that the working set cannot.
const heap = [];
let finished = false;
function finish(code, result) {
  if (finished) return;
  finished = true;
  if (result) {
    fs.writeFileSync(
      path.join(outDir, "result.json"),
      JSON.stringify(result, null, 2),
    );
  }
  if (perf) {
    fs.writeFileSync(
      path.join(outDir, "metrics.json"),
      JSON.stringify({ startedAt, samples, heap }, null, 2),
    );
  }
  app.exit(code);
}

app.whenReady().then(async () => {
  const runtime = await loadRuntimeFiles(runtimeDir);
  protocol.handle(RUNTIME_SCHEME, (request) =>
    serveRuntimeRequest(runtime, request.url),
  );
  protocol.handle("tcmedia", (request) => {
    const match = /^tcmedia:\/\/sha256\/([0-9a-f]{64})$/.exec(request.url);
    if (!match) return new Response("not found", { status: 404 });
    const hex = match[1];
    const file = path.join(casRoot, "sha256", hex.slice(0, 2), hex);
    const headers = new Headers();
    const range = request.headers.get("Range");
    if (range) headers.set("Range", range);
    return net.fetch(pathToFileURL(file).toString(), { headers });
  });

  const { width, height } = fixture.viewport;
  const win = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    frame: false,
    show: true,
    resizable: false,
    backgroundColor: "#000000",
    webPreferences: {
      // Test harness only: the fixture host must live in the page's world,
      // so this window runs its preload without isolation.
      preload: path.join(
        __dirname,
        legacyDir ? "legacy-preload.cjs" : "runner-preload.cjs",
      ),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: [
        `--tc-fixture=${fixturePath}`,
        `--tc-host-script=${hostScript}`,
      ],
    },
  });
  ipcMain.handle("conformance-snapshot", async (_event, name) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(name))) {
      throw new Error("invalid checkpoint name");
    }
    let image = await win.webContents.capturePage();
    // A high-density display captures at its own scale; compare at the
    // fixture's CSS size, as the WebKit runner does.
    const size = image.getSize();
    if (size.width !== width || size.height !== height) {
      image = image.resize({ width, height, quality: "best" });
    }
    fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG());
    return null;
  });
  ipcMain.on("conformance-finish", (_event, result) => finish(0, result));
  if (perf) {
    setInterval(() => {
      samples.push({
        t: Date.now(),
        processes: app.getAppMetrics().map((metric) => ({
          type: metric.type,
          cpu: metric.cpu.percentCPUUsage,
          workingSetKb: metric.memory.workingSetSize,
        })),
      });
    }, 1_000).unref();
    const cdp = win.webContents.debugger;
    try {
      cdp.attach("1.3");
    } catch {
      // Another debugger is attached; heap samples are then absent.
    }
    setInterval(async () => {
      if (!cdp.isAttached()) return;
      try {
        await cdp.sendCommand("HeapProfiler.collectGarbage");
        const usage = await cdp.sendCommand("Runtime.getHeapUsage");
        const counters = await cdp.sendCommand("Memory.getDOMCounters");
        // Live first-class Widget element instances, found through each
        // bundled Widget's prototype: a retained, removed Widget shows here.
        const widgets = {};
        const tags = await cdp.sendCommand("Runtime.evaluate", {
          expression:
            "Object.keys(globalThis.__tilecastRuntime?.widgetCapabilities ?? {}).map((c) => 'tc-widget-' + c.split('.').pop())",
          returnByValue: true,
        });
        for (const tag of tags.result.value ?? []) {
          const proto = await cdp.sendCommand("Runtime.evaluate", {
            expression: `customElements.get(${JSON.stringify(tag)})?.prototype`,
            objectGroup: "tc-perf",
          });
          if (!proto.result.objectId) continue;
          const found = await cdp.sendCommand("Runtime.queryObjects", {
            prototypeObjectId: proto.result.objectId,
            objectGroup: "tc-perf",
          });
          const size = await cdp.sendCommand("Runtime.callFunctionOn", {
            objectId: found.objects.objectId,
            functionDeclaration: "function () { return this.length; }",
            returnByValue: true,
          });
          widgets[tag] = size.result.value;
        }
        // The inspector holds every object it returned until the group is
        // released; without this the measurement itself retains Widgets.
        await cdp.sendCommand("Runtime.releaseObjectGroup", {
          objectGroup: "tc-perf",
        });
        heap.push({
          t: Date.now(),
          usedKb: Math.round(usage.usedSize / 1024),
          nodes: counters.nodes,
          listeners: counters.jsEventListeners,
          documents: counters.documents,
          widgets,
        });
      } catch {
        // The page is navigating or closing; skip this sample.
      }
    }, 10_000).unref();
  }
  win.webContents.on("console-message", (details) => {
    const message = details?.message ?? "";
    if (message) console.log(`[page] ${message}`);
  });
  win.webContents.on("render-process-gone", () =>
    finish(3, {
      fixture: fixture.name,
      checkpoints: [],
      failure: "renderer process gone",
    }),
  );
  setTimeout(
    () =>
      finish(2, {
        fixture: fixture.name,
        checkpoints: [],
        failure: "timed out",
      }),
    180_000,
  ).unref();
  if (legacyDir) {
    await win.loadFile(path.join(legacyDir, "static", "index.html"));
  } else {
    await win.loadURL(RUNTIME_ENTRY_URL);
  }
});
