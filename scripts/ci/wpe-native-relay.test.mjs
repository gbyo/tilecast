import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const relay = fs.readFileSync(
  new URL(
    "../../apps/edge/renderer-wpe/web/tilecast-native-relay.js",
    import.meta.url,
  ),
  "utf8",
);
const bridge = fs.readFileSync(
  new URL(
    "../../apps/edge/renderer-wpe/web/tilecast-bridge.js",
    import.meta.url,
  ),
  "utf8",
);
class Document {
  handlers = new Map();
  addEventListener(name, callback) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]);
  }
  dispatchEvent(event) {
    event.target = this;
    for (const handler of this.handlers.get(event.type) ?? []) handler(event);
  }
}
class Event {
  constructor(type, options) {
    this.type = type;
    this.detail = options.detail;
  }
}
function world(document, extras = {}) {
  const context = vm.createContext({
    document,
    location: { href: "tilecast://runtime/index.html" },
    navigator: { userAgent: "AppleWebKit/2.54.1" },
    CustomEvent: Event,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    ...extras,
  });
  vm.runInContext(
    "globalThis.window = globalThis; window.parent = window;",
    context,
  );
  return context;
}
function fixture(
  reply = (message) =>
    Promise.resolve(message.type === "discovery.list" ? [] : { ok: true }),
) {
  const document = new Document();
  const reports = [];
  const requests = [];
  const native = world(document, {
    webkit: {
      messageHandlers: {
        tilecast: {
          postMessage: (message) =>
            reports.push(JSON.parse(JSON.stringify(message))),
        },
        tilecastRequest: {
          postMessage: (message) => {
            requests.push(message);
            return reply(message);
          },
        },
      },
    },
  });
  vm.runInContext(relay, native);
  const page = world(document);
  vm.runInContext(bridge, page);
  return { document, native, page, reports, requests };
}

test("Runtime reports and async requests cross the isolated relay without native handlers in the page", async () => {
  const { page, reports, requests } = fixture();
  assert.equal(page.webkit, undefined);
  vm.runInContext(
    "tilecastRuntimeHost.ready({ contractVersion:1, runtimeVersion:'test', support:{ presentationSchemas:[1], declarativeCapabilities:{}, widgetComponents:{} } })",
    page,
  );
  assert.equal(reports[0].type, "runtime.ready");
  const servers = await vm.runInContext(
    "tilecastRuntimeHost.discovery.list()",
    page,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(servers)), []);
  assert.equal(requests[0].type, "discovery.list");
});

test("a child document gets neither the page adapter nor the native relay", () => {
  const { reports } = fixture();
  const child = world(new Document());
  vm.runInContext("window.parent = {};", child);
  vm.runInContext(relay, child);
  vm.runInContext(bridge, child);
  assert.equal(child.webkit, undefined);
  assert.equal(child.tilecastRuntimeHost, undefined);
  child.document.dispatchEvent(
    new Event("tilecast-native-report", { detail: '{"type":"runtime.ready"}' }),
  );
  assert.equal(reports.length, 0);
});

test("foreign top documents, malformed reports, and oversized requests are refused", () => {
  const foreign = world(new Document());
  foreign.location.href = "tcwidget://cap/fixture";
  vm.runInContext(relay, foreign);
  vm.runInContext(bridge, foreign);
  assert.equal(foreign.tilecastRuntimeHost, undefined);
  const { document, reports } = fixture();
  for (const detail of ["{", "x".repeat(65537), 12])
    document.dispatchEvent(new Event("tilecast-native-report", { detail }));
  assert.equal(reports.length, 0);
});

test("asynchronous host refusal reaches the existing typed unavailable result", async () => {
  const { page } = fixture(() =>
    Promise.reject(new Error("internal host failure")),
  );
  const result = await vm.runInContext(
    "tilecastRuntimeHost.setup.submitServerUrl('https://tilecast.test')",
    page,
  );
  assert.equal(result.ok, false);
  assert.ok(!JSON.stringify(result).includes("internal host failure"));
});
