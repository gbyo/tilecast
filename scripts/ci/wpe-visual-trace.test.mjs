import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";

const sinkSource = fs.readFileSync(
  new URL(
    "../../apps/edge/renderer-wpe/web/tilecast-visual-trace.js",
    import.meta.url,
  ),
  "utf8",
);
const relaySource = fs.readFileSync(
  new URL(
    "../../apps/edge/renderer-wpe/web/tilecast-native-relay.js",
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

function world(document, href = "tilecast://runtime/index.html", extras = {}) {
  const context = vm.createContext({
    document,
    location: { href },
    CustomEvent: Event,
    TextEncoder,
    console,
    ...extras,
  });
  vm.runInContext(
    "globalThis.window = globalThis; window.parent = window;",
    context,
  );
  return context;
}

function fixture({ deep = false, href } = {}) {
  const document = new Document();
  const reports = [];
  const native = world(document, undefined, {
    webkit: {
      messageHandlers: {
        tilecast: {
          postMessage: (message) =>
            reports.push(JSON.parse(JSON.stringify(message))),
        },
        tilecastRequest: { postMessage: () => Promise.resolve(null) },
      },
    },
  });
  vm.runInContext(relaySource, native);
  const page = world(document, href);
  if (deep) {
    vm.runInContext(
      "Object.defineProperty(globalThis, '__tilecastVisualTraceDeep', { value: true, configurable: true });",
      page,
    );
  }
  vm.runInContext(sinkSource, page);
  return { page, reports };
}

const batch = (records) => ({
  schema: "tilecast-visual-v1",
  seq: 1,
  sentAt: 10,
  dropped: 3,
  records,
});

test("a document without the injected sink has no trace global", () => {
  const document = new Document();
  const page = world(document);
  assert.equal(
    vm.runInContext("typeof __tilecastVisualTrace", page),
    "undefined",
  );
});

test("installs a frozen sink in the trusted top document only", () => {
  const { page } = fixture();
  const sink = vm.runInContext("globalThis.__tilecastVisualTrace", page);
  assert.equal(sink.schema, "tilecast-visual-v1");
  assert.equal(sink.deep, false);
  assert.ok(Object.isFrozen(sink));
  vm.runInContext("globalThis.__tilecastVisualTrace = null", page);
  assert.ok(vm.runInContext("globalThis.__tilecastVisualTrace", page));

  const other = fixture({ href: "tilecast://runtime/other.html" });
  assert.equal(
    vm.runInContext("typeof __tilecastVisualTrace", other.page),
    "undefined",
  );
});

test("deep mode comes only from the host's constant, which is then removed", () => {
  const { page } = fixture({ deep: true });
  assert.equal(vm.runInContext("__tilecastVisualTrace.deep", page), true);
  assert.equal(
    vm.runInContext("typeof __tilecastVisualTraceDeep", page),
    "undefined",
  );
});

test("forwards a batch through the native relay unchanged", () => {
  const { page, reports } = fixture();
  page.batch = batch([{ t: 1, scope: "stage", ev: "stage.swap", tx: 1 }]);
  vm.runInContext("__tilecastVisualTrace.emit(batch)", page);
  assert.deepEqual(reports, [
    { type: "diagnostics.visual_trace", batch: page.batch },
  ]);
});

test("the renderer's stop() at the end of its window silences the sink", () => {
  const { page, reports } = fixture();
  assert.equal(vm.runInContext("__tilecastVisualTrace.active()", page), true);
  // The renderer's fixed STOP_PAGE_SCRIPT (src/visual-trace.c).
  vm.runInContext(
    "(() => { const sink = globalThis.__tilecastVisualTrace;" +
      " if (sink && typeof sink.stop === 'function') sink.stop(); })();",
    page,
  );
  assert.equal(vm.runInContext("__tilecastVisualTrace.active()", page), false);
  page.batch = batch([{ t: 1, scope: "stage", ev: "after" }]);
  vm.runInContext("__tilecastVisualTrace.emit(batch)", page);
  assert.deepEqual(reports, []);
});

test("splits a batch that is over the relay bound and never truncates", () => {
  const { page, reports } = fixture();
  const records = Array.from({ length: 128 }, (_, i) => {
    const record = { t: i, scope: "stage", ev: "e" };
    for (let k = 0; k < 21; k++) record[`k${k}`] = "x".repeat(24);
    return record;
  });
  page.batch = batch(records);
  vm.runInContext("__tilecastVisualTrace.emit(batch)", page);
  assert.ok(reports.length > 1);
  const forwarded = reports.flatMap((report) => report.batch.records);
  assert.deepEqual(forwarded, records);
  // The page's drop count is reported once.
  assert.equal(
    reports.reduce((sum, report) => sum + report.batch.dropped, 0),
    3,
  );
});

test("a malformed batch never throws into the Runtime", () => {
  const { page, reports } = fixture();
  assert.doesNotThrow(() =>
    vm.runInContext(
      "__tilecastVisualTrace.emit({ records: 'x'.repeat(70000) })",
      page,
    ),
  );
  assert.deepEqual(reports, []);
});
