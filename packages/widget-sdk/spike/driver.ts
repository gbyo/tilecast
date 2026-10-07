/**
 * Sandbox spike driver. Bundled with esbuild and executed in a real
 * browser by `run.mjs`. Each case mounts one placement through the
 * SandboxedWidgetExecutor and records the observed states and timing.
 * Fixture bundles arrive as inert JSON script blocks (see run.mjs):
 * the harness CSP forbids fetching them.
 */
import {
  SandboxedWidgetExecutor,
  type SandboxedWidgetRequest,
  type SandboxEmbedding,
} from "../src/sandboxed-executor.ts";
import type { WidgetMountState } from "../src/mount.ts";
import { createWidgetResources } from "../src/resources.ts";
import type {
  WidgetClock,
  WidgetContext,
  WidgetTimer,
} from "../src/context.ts";
import { TILECAST_DISPLAY_THEME } from "../src/context.ts";

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
  ms?: number;
}

const results: CaseResult[] = [];

function frameBase(): string {
  const port = new URLSearchParams(window.location.search).get("frames");
  if (!port) throw new Error("missing ?frames= port");
  return `http://127.0.0.1:${port}`;
}

function fixture(name: string): string {
  const node = document.getElementById(`fixture-${name}`);
  if (!node) throw new Error(`missing fixture ${name}`);
  return node.textContent ?? "";
}

function realClock(): WidgetClock {
  return {
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    after: (delayMs: number, run: () => void): WidgetTimer => {
      const id = window.setTimeout(run, delayMs);
      return { cancel: () => window.clearTimeout(id) };
    },
  };
}

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function resourcesFor() {
  return createWidgetResources(
    {
      documents: new Map([
        [
          "schedule",
          {
            schemaVersion: 1 as const,
            // Two datasets so the screenshot proves the document crossed
            // the bridge (a missing document would render sets:-1).
            datasets: [
              {
                id: "now",
                kind: "scalar" as const,
                scalar: "morning",
                cache: { usingCachedData: false, unavailable: false },
              },
              {
                id: "next",
                kind: "scalar" as const,
                scalar: "noon",
                cache: { usingCachedData: false, unavailable: false },
              },
            ],
          },
        ],
      ]),
      media: new Map([["hero/full", PIXEL]]),
    },
    {
      dataSources: ["schedule"],
      media: [{ assetId: "hero", variantId: "full" }],
    },
  );
}

function contextFor(clock: WidgetClock): WidgetContext {
  return {
    clock,
    locale: "en-US",
    timeZone: "America/Chicago",
    hourCycle: "locale",
    theme: TILECAST_DISPLAY_THEME,
    motion: { reduced: false },
    mode: "playback",
  };
}

function row(title: string): HTMLElement {
  const wrap = document.createElement("section");
  const head = document.createElement("h2");
  head.textContent = title;
  head.style.cssText =
    "font:12px system-ui;color:#fff;background:#333;padding:2px 6px;margin:0";
  const box = document.createElement("div");
  box.style.cssText = "width:640px;height:120px;background:#000";
  wrap.appendChild(head);
  wrap.appendChild(box);
  document.getElementById("stage")!.appendChild(wrap);
  return box;
}

function waitFor(
  states: WidgetMountState[],
  terminal: (state: WidgetMountState) => boolean,
  timeoutMs: number,
): Promise<WidgetMountState> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = window.setInterval(() => {
      const last = states[states.length - 1];
      if (last && terminal(last)) {
        window.clearInterval(timer);
        resolve(last);
      } else if (performance.now() - started > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error(`timed out waiting, saw ${JSON.stringify(states)}`));
      }
    }, 25);
  });
}

const settled = (state: WidgetMountState) => state.state !== "pending";

async function mountCase(options: {
  name: string;
  type: string;
  embedding: SandboxEmbedding;
  bundle: string;
  config?: unknown;
  readyTimeoutMs?: number;
  keep?: boolean;
}): Promise<{ states: WidgetMountState[]; ms: number; dispose: () => void }> {
  const executor = new SandboxedWidgetExecutor({
    defaultEmbedding: options.embedding,
  });
  const states: WidgetMountState[] = [];
  const started = performance.now();
  const request: SandboxedWidgetRequest = {
    component: {
      type: options.type,
      version: 1,
      config: options.config ?? { label: options.name },
    },
    resources: resourcesFor(),
    context: contextFor(realClock()),
    onState: (state) => void states.push(state),
    bundle: { javaScript: fixture(options.bundle), sha256: "spike" },
    declared: {
      dataSources: ["schedule"],
      media: [{ assetId: "hero", variantId: "full" }],
    },
    embedding: options.embedding,
    readyTimeoutMs: options.readyTimeoutMs,
  };
  if (options.embedding === "hosted") {
    (request as { frameUrl?: string }).frameUrl =
      `${frameBase()}/frames/${options.bundle}.html`;
  }
  const execution = executor.mount(row(options.name), request);
  const last = await waitFor(states, settled, 10000);
  void last;
  return {
    states,
    ms: performance.now() - started,
    dispose: () => execution.dispose(),
  };
}

function record(result: CaseResult): void {
  // The runner scrapes #results from dumped DOM: keep it markup-free.
  const clean = {
    ...result,
    detail: result.detail.replace(/[<>&]/g, "?"),
  };
  results.push(clean);
  const line = document.createElement("div");
  line.textContent = `${clean.pass ? "PASS" : "FAIL"} ${clean.name} ${clean.detail}`;
  document.getElementById("log")!.appendChild(line);
}

function expectStates(
  name: string,
  states: WidgetMountState[],
  want: WidgetMountState[],
  ms: number,
): void {
  const pass = JSON.stringify(states) === JSON.stringify(want);
  record({
    name,
    pass,
    detail: pass ? `${ms.toFixed(0)}ms` : `saw ${JSON.stringify(states)}`,
    ms,
  });
}

async function main(): Promise<void> {
  // 1-2. srcdoc and blob prove the negative under the runtime CSP: the
  // frame never reports, so the ready timeout fires. Kept as regression
  // proofs, not happy paths.
  for (const embedding of ["srcdoc", "blob"] as const) {
    const run = await mountCase({
      name: `${embedding}-blocked`,
      type: "acme.spike.ok",
      embedding,
      bundle: "ok",
      readyTimeoutMs: 1000,
    });
    expectStates(
      `${embedding}-blocked`,
      run.states,
      [{ state: "pending" }, { state: "error", code: "widget_ready_timeout" }],
      run.ms,
    );
    run.dispose();
  }

  // 3. Happy path through the second origin.
  {
    const run = await mountCase({
      name: "hosted-ok",
      type: "acme.spike.ok",
      embedding: "hosted",
      bundle: "ok",
      keep: true,
    });
    expectStates(
      "hosted-ok",
      run.states,
      [{ state: "pending" }, { state: "ready" }],
      run.ms,
    );
  }

  // 4. Update in place over the hosted frame.
  {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const request: SandboxedWidgetRequest = {
      component: {
        type: "acme.spike.ok",
        version: 1,
        config: { label: "before" },
      },
      resources: resourcesFor(),
      context: contextFor(realClock()),
      onState: (state) => void states.push(state),
      bundle: { javaScript: fixture("ok"), sha256: "spike" },
      embedding: "hosted",
      declared: {
        dataSources: ["schedule"],
        media: [{ assetId: "hero", variantId: "full" }],
      },
    };
    const started = performance.now();
    (request as { frameUrl?: string }).frameUrl =
      `${frameBase()}/frames/ok.html`;
    const execution = executor.mount(row("update"), request);
    await waitFor(states, settled, 10000);
    execution.update({
      ...request,
      component: {
        type: "acme.spike.ok",
        version: 1,
        config: { label: "after" },
      },
    });
    await waitFor(
      states,
      (state) => states.length >= 4 && settled(state),
      10000,
    );
    const pass =
      states.length === 4 &&
      states[0]?.state === "pending" &&
      states[1]?.state === "ready" &&
      states[2]?.state === "pending" &&
      states[3]?.state === "ready";
    record({
      name: "update",
      pass,
      detail: pass ? "" : `saw ${JSON.stringify(states)}`,
      ms: performance.now() - started,
    });
  }

  // 5. The hostile bundle still only reports lifecycle over the bridge.
  {
    const run = await mountCase({
      name: "hostile-hosted",
      type: "acme.spike.hostile",
      embedding: "hosted",
      bundle: "hostile",
      keep: true,
    });
    expectStates(
      "hostile-hosted",
      run.states,
      [{ state: "pending" }, { state: "ready" }],
      run.ms,
    );
  }

  // 6-9. Empty, bounded error, timeout, malformed bundle.
  {
    const run = await mountCase({
      name: "empty",
      type: "acme.spike.empty",
      embedding: "hosted",
      bundle: "empty",
    });
    expectStates(
      "empty",
      run.states,
      [{ state: "pending" }, { state: "empty", reason: "nothing_today" }],
      run.ms,
    );
    run.dispose();
  }
  {
    const run = await mountCase({
      name: "error-bounded",
      type: "acme.spike.error",
      embedding: "hosted",
      bundle: "error",
    });
    expectStates(
      "error-bounded",
      run.states,
      [{ state: "pending" }, { state: "error", code: "frame_error" }],
      run.ms,
    );
    run.dispose();
  }
  {
    const run = await mountCase({
      name: "silent-timeout",
      type: "acme.spike.silent",
      embedding: "hosted",
      bundle: "silent",
      readyTimeoutMs: 500,
    });
    expectStates(
      "silent-timeout",
      run.states,
      [{ state: "pending" }, { state: "error", code: "widget_ready_timeout" }],
      run.ms,
    );
    run.dispose();
  }
  {
    const run = await mountCase({
      name: "bad-shape",
      type: "acme.spike.ok",
      embedding: "hosted",
      bundle: "bad-shape",
    });
    // The bundle's type disagrees with the placement: the bootstrap refuses.
    expectStates(
      "bad-shape",
      run.states,
      [{ state: "pending" }, { state: "error", code: "frame_error" }],
      run.ms,
    );
    run.dispose();
  }

  // 10. Mount latency: ten fresh placements, median mount-to-ready.
  {
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      const run = await mountCase({
        name: `latency-${i}`,
        type: "acme.spike.ok",
        embedding: "hosted",
        bundle: "ok",
      });
      samples.push(run.ms);
      run.dispose();
      document.getElementById("stage")!.lastElementChild?.remove();
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    record({
      name: "latency-median-ms",
      pass: median < 2000,
      detail: `${median.toFixed(0)}ms over 10 mounts`,
      ms: median,
    });
  }

  // 11. Eight concurrent placements (Phase F scale probe).
  {
    const started = performance.now();
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        mountCase({
          name: `scale-8-${index}`,
          type: "acme.spike.ok",
          embedding: "hosted",
          bundle: "ok",
        }),
      ),
    );
    const ready = runs.filter((run) =>
      run.states.some((state) => state.state === "ready"),
    ).length;
    const slowest = Math.max(...runs.map((run) => run.ms));
    for (const run of runs) run.dispose();
    record({
      name: "scale-8",
      pass: ready === 8,
      detail: `${ready}/8 ready, slowest ${slowest.toFixed(0)}ms`,
      ms: performance.now() - started,
    });
  }

  // 12. Layout resize: the frame follows its container by CSS alone, and
  // the placement reports nothing new.
  {
    const run = await mountCase({
      name: "resize",
      type: "acme.spike.ok",
      embedding: "hosted",
      bundle: "ok",
      keep: true,
    });
    const wraps = document.getElementById("stage")!.children;
    const box = wraps[wraps.length - 1]!.lastElementChild as HTMLElement;
    const frame = box.querySelector("iframe")!;
    const settledCount = run.states.length;
    box.style.width = "320px";
    box.style.height = "60px";
    await new Promise((resolve) => setTimeout(resolve, 250));
    const fills = frame.style.width === "100%" && frame.style.height === "100%";
    record({
      name: "resize-stable",
      pass: fills && run.states.length === settledCount,
      detail: fills ? "" : "frame does not fill its container",
      ms: run.ms,
    });
  }
}

function finish(): void {
  const passed = results.filter((result) => result.pass).length;
  document.getElementById("results")!.textContent = JSON.stringify({
    userAgent: navigator.userAgent,
    passed,
    total: results.length,
    cases: results,
  });
  document.title = `SPIKE_DONE:${passed}/${results.length}`;
}

window.addEventListener("error", (event) => {
  record({
    name: "window-error",
    pass: false,
    detail: String(event.message),
  });
});

main()
  .then(finish)
  .catch((error: unknown) => {
    record({
      name: "driver-crash",
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    finish();
  });

// Never leave the runner without a signal.
window.setTimeout(() => {
  if (!document.title.startsWith("SPIKE_DONE")) {
    record({ name: "driver-timeout", pass: false, detail: "60s watchdog" });
    finish();
  }
}, 60000);
