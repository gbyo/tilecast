#!/usr/bin/env node
/**
 * Sandbox spike runner. Serves the harness over loopback HTTP, drives it
 * in headless Chrome, and reports the measured cases.
 *
 * Usage: node spike/run.mjs [--chrome /path/to/chrome] [--keep]
 *
 * The harness CSP must stay byte-identical to the Player Runtime policy;
 * the run refuses to start when they drift, so a permissive stand-in can
 * never quietly substitute for the real measurement.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const spike = join(root, "packages", "widget-sdk", "spike");
const out = join(spike, "dist");

const RUNTIME_HTML = join(
  root,
  "packages",
  "player-runtime",
  "static",
  "index.html",
);
const FIXTURES = ["ok", "hostile", "empty", "error", "silent", "bad-shape"];

function runtimeCSP() {
  const html = readFileSync(RUNTIME_HTML, "utf8");
  const match = html.match(
    /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/s,
  );
  if (!match) throw new Error("runtime CSP meta tag not found");
  return match[1];
}

function chromeBinary(flag) {
  if (flag && existsSync(flag)) return flag;
  const env = process.env.CHROME_BIN;
  if (env && existsSync(env)) return env;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no Chrome/Chromium found (pass --chrome or set CHROME_BIN)");
}

function build() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // Bundle the driver: browsers cannot import the SDK's TypeScript sources.
  const esbuild = join(root, "node_modules", ".bin", "esbuild");
  const bundled = spawnSync(
    esbuild,
    [
      join(spike, "driver.ts"),
      "--bundle",
      "--format=iife",
      `--outfile=${join(out, "driver.bundle.js")}`,
      "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (bundled.status !== 0) throw new Error("driver bundle failed");
  // Bundle the frame builder so hosted frame documents come from the
  // same builder the executor uses, never a copy.
  const framed = spawnSync(
    esbuild,
    [
      join(spike, "frame-entry.ts"),
      "--bundle",
      "--format=cjs",
      "--platform=node",
      `--outfile=${join(out, "frame-entry.cjs")}`,
      "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  if (framed.status !== 0) throw new Error("frame entry bundle failed");
  // Inline fixtures as inert JSON blocks: the harness CSP forbids fetching.
  let html = readFileSync(join(spike, "harness.html"), "utf8");
  const csp = runtimeCSP();
  if (!html.includes("__RUNTIME_CSP__")) {
    throw new Error("harness template lost its CSP placeholder");
  }
  html = html.replace("__RUNTIME_CSP__", csp);
  const blocks = FIXTURES.map((name) => {
    const text = readFileSync(join(spike, "fixtures", `${name}.js`), "utf8");
    if (text.includes("</script")) {
      throw new Error(`fixture ${name} breaks out of its script block`);
    }
    return `<script type="application/json" id="fixture-${name}">${text}</script>`;
  }).join("\n");
  html = html.replace("<!--FIXTURES-->", blocks);
  writeFileSync(join(out, "harness.html"), html);
  cpSync(join(spike, "harness.css"), join(out, "harness.css"));
  cpSync(join(spike, "fixtures"), join(out, "fixtures"), { recursive: true });
  return csp;
}

async function frameDocuments() {
  const { buildSandboxFrameDocument } = await import(
    join(out, "frame-entry.cjs")
  );
  const frames = new Map();
  for (const name of FIXTURES) {
    const bundle = readFileSync(join(spike, "fixtures", `${name}.js`), "utf8");
    frames.set(`/frames/${name}.html`, buildSandboxFrameDocument(bundle));
  }
  return frames;
}

function serve(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function appHandler(request, response) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
  };
  const path = new URL(request.url ?? "/", "http://loopback").pathname;
  const file = join(
    out,
    path === "/" ? "harness.html" : path.split("?")[0].slice(1),
  );
  if (!file.startsWith(out) || !existsSync(file)) {
    response.writeHead(404).end("not found");
    return;
  }
  const extension = file.slice(file.lastIndexOf("."));
  response.writeHead(200, {
    "content-type": types[extension] ?? "text/plain",
  });
  response.end(readFileSync(file));
}

/**
 * The second origin: frame documents only. A different port is a
 * different origin, so frames neither inherit the app CSP nor need a
 * policy change. Production hosts serve the same documents from their
 * own frame origin.
 */
function frameHandler(frames) {
  return (request, response) => {
    const path = new URL(request.url ?? "/", "http://loopback").pathname;
    const document = frames.get(path);
    if (document === undefined) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(document);
  };
}

/** Launch headless Chrome on a CDP port and wait for the driver signal. */
async function drive(chrome, url, shot) {
  const child = spawn(chrome, [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--window-size=700,2200",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "about:blank",
  ]);
  let endpoint = "";
  child.stderr.setEncoding("utf8");
  const endpointPromise = new Promise((resolve, reject) => {
    let text = "";
    child.stderr.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) resolve(match[1]);
    });
    child.on("error", reject);
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 180000);
  try {
    endpoint = await endpointPromise;
    const socket = new WebSocket(endpoint, []);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.id !== undefined && pending.has(payload.id)) {
        pending.get(payload.id)(payload);
        pending.delete(payload.id);
      }
    });
    const send = (method, params = {}, sessionId = undefined) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        );
      });
    const targets = await send("Target.getTargets");
    const page = targets.result.targetInfos.find(
      (target) => target.type === "page",
    );
    if (!page) throw new Error("no page target");
    const attached = await send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    const sessionId = attached.result.sessionId;
    const pageSend = (method, params = {}) => send(method, params, sessionId);
    const evaluate = async (expression) => {
      const response = await pageSend("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      return response.result?.result?.value ?? "";
    };
    await pageSend("Page.enable");
    await pageSend("Page.navigate", { url });
    const deadline = Date.now() + 150000;
    let title = "";
    for (;;) {
      title = String(await evaluate("document.title"));
      if (title.startsWith("SPIKE_DONE")) break;
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const results = title.startsWith("SPIKE_DONE")
      ? String(
          await evaluate(
            'document.getElementById("results")?.textContent ?? ""',
          ),
        )
      : "";
    const shotResponse = await pageSend("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    });
    if (!shotResponse.result) {
      console.log(
        `screenshot failed: ${JSON.stringify(shotResponse).slice(0, 300)}`,
      );
    } else {
      writeFileSync(shot, Buffer.from(shotResponse.result.data, "base64"));
    }
    socket.close();
    return { title, results };
    return { title: "SPIKE_RUNNING", results: "" };
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const chromeFlag = args.includes("--chrome")
    ? args[args.indexOf("--chrome") + 1]
    : undefined;
  const keep = args.includes("--keep");
  const csp = build();
  const frames = await frameDocuments();
  if (keep) {
    // Per-target runs serve these from a second origin; the driver takes
    // its port from ?frames=. See docs/records/widget-sandbox-spike.md.
    const dir = join(out, "frames");
    mkdirSync(dir, { recursive: true });
    for (const [path, document] of frames) {
      writeFileSync(join(dir, path.slice("/frames/".length)), document);
    }
  }
  const chrome = chromeBinary(chromeFlag);
  const app = await serve(appHandler);
  const frameServer = await serve(frameHandler(frames));
  const url = `http://127.0.0.1:${app.port}/harness.html?frames=${frameServer.port}`;
  const shot = join(out, "spike.png");
  try {
    // Real-time CDP drive: --virtual-time-budget fast-forwards virtual
    // timers past real network loads, so hosted-frame load events land
    // after the ready timeout and latency numbers come out meaningless.
    // Polling document.title over CDP keeps the clock honest.
    const { title, results } = await drive(chrome, url, shot);
    let report = null;
    try {
      report = results ? JSON.parse(results) : null;
    } catch {
      report = null;
    }
    console.log(`csp: ${csp}`);
    console.log(`title: ${title}`);
    if (!report) {
      console.log("no results: the driver never finished");
      console.log(`screenshot: ${shot}`);
      process.exitCode = 1;
      return;
    }
    for (const kase of report.cases) {
      console.log(
        `${kase.pass ? "PASS" : "FAIL"} ${kase.name} ${kase.detail ?? ""}${kase.ms === undefined ? "" : ` (${kase.ms.toFixed(0)}ms)`}`,
      );
    }
    console.log(
      `cases: ${report.passed}/${report.total} ua: ${report.userAgent}`,
    );
    console.log(`screenshot: ${shot}`);
    if (report.passed !== report.total) process.exitCode = 1;
  } finally {
    app.server.close();
    frameServer.server.close();
    if (!keep) {
      // Keep the screenshot for the spike record; drop the rest.
      for (const name of [
        "driver.bundle.js",
        "frame-entry.cjs",
        "harness.html",
        "harness.css",
      ]) {
        rmSync(join(out, name), { force: true });
      }
      rmSync(join(out, "fixtures"), { recursive: true, force: true });
    }
  }
}

await main();
