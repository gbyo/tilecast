/**
 * The conformance fixture host: a TilecastRuntimeHostV1 that plays a
 * deterministic fixture script into the shared Player Runtime and records
 * what the runtime shows and reports.
 *
 * Every engine runner (Electron/Chromium, WPE/WebKit, and any future host)
 * injects this same script before the runtime starts, plus a small runner
 * object for the two things only the engine can do: take a screenshot and
 * hand back the results. The runtime runs on a manual clock with instant
 * transitions, so the same fixture produces the same sequence of states on
 * every engine; the runner compares them.
 */
import type {
  EvidenceReportV1,
  HostMessageV1,
  PlaybackErrorReportV1,
  PresentationResultV1,
  RuntimeCapabilitiesV1,
  TilecastRuntimeHostV1,
} from "../../src/host/contract";

export type FixtureStep =
  | { present: Record<string, unknown> }
  | { plugins: { plugins: unknown[]; clockOffsetMs?: number } }
  | { identify: { name: string; durationSeconds: number } }
  | { command: "retry-item" | "skip-item" }
  | { discovered: { name: string; serverUrl: string } }
  | { noise: number | null }
  | { advance: number }
  | { stepWall: number }
  | { waitForEvidence: { kind: string; itemId?: string; timeoutMs?: number } }
  | { checkpoint: string; visual?: boolean }
  /**
   * The Widgets V2 release gate (docs/widgets-v2.md §9): every first-class
   * Widget on screen renders in its own shadow root with adopted
   * stylesheets only, container units and queries resolve, no CSP
   * violation occurred, and the engine still enforces the runtime CSP.
   */
  | { assertWidgets: WidgetAssertion[] }
  /** Real-time fixtures only (performance runs): wait on the real clock. */
  | { hold: number };

export interface WidgetAssertion {
  type: string;
  textIncludes?: string[];
  /** Computed styles of elements inside the Widget's shadow root. */
  styles?: { selector: string; property: string; value: string }[];
}

export interface Fixture {
  name: string;
  description?: string;
  wallClock: string;
  viewport: { width: number; height: number };
  capabilities?: Partial<RuntimeCapabilitiesV1>;
  /** Media name → URI the runner resolved (content-addressed). */
  media?: Record<string, string>;
  steps: FixtureStep[];
  /**
   * Performance runs: the runtime keeps real time (no manual clock, real
   * transitions) and every evidence report is timestamped.
   */
  realtime?: boolean;
}

export interface CheckpointResult {
  name: string;
  visual: boolean;
  state: unknown;
  evidence: string[];
  errors: string[];
  results: string[];
}

export interface ConformanceResult {
  fixture: string;
  engine: { userAgent: string };
  checkpoints: CheckpointResult[];
  failure: string | null;
  /** Real-time runs: Unix-millisecond timestamps of every report. */
  timeline?: { t: number; entry: string }[];
}

interface Runner {
  fixture: Fixture;
  snapshot(name: string): Promise<void>;
  finish(result: ConformanceResult): void;
}

interface Probe {
  describe(): unknown;
  settled(): Promise<void>;
  advance(ms: number): void;
  stepWall(ms: number): void;
}

const runner = (
  globalThis as unknown as { __tilecastConformanceRunner?: Runner }
).__tilecastConformanceRunner;

function substituteMedia(
  value: unknown,
  media: Record<string, string>,
): unknown {
  if (typeof value === "string" && value.startsWith("media:")) {
    const uri = media[value.slice("media:".length)];
    if (!uri) throw new Error(`fixture names unknown media ${value}`);
    return uri;
  }
  if (Array.isArray(value))
    return value.map((entry) => substituteMedia(entry, media));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = substituteMedia(entry, media);
    }
    return out;
  }
  return value;
}

/**
 * Every CSP violation the document reports. Registered before the runtime
 * starts, so nothing a Widget does can escape it.
 */
const cspViolations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) => {
  cspViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
});

const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => setTimeout(resolve, 0)),
  );

/**
 * Prove the engine enforces the runtime policy: an inline stylesheet must
 * be refused and reported. If anyone adds 'unsafe-inline' to style-src
 * (or drops the policy), this fails on every engine.
 */
async function assertInlineStylesRefused(): Promise<void> {
  const before = cspViolations.length;
  const style = document.createElement("style");
  style.textContent = ":root { --tc-csp-probe: applied; }";
  document.head.appendChild(style);
  await nextFrame();
  await nextFrame();
  const applied = getComputedStyle(document.documentElement)
    .getPropertyValue("--tc-csp-probe")
    .trim();
  style.remove();
  const reported = cspViolations
    .splice(before)
    .some((entry) => entry.startsWith("style-src"));
  if (applied !== "" || !reported) {
    throw new Error(
      "the runtime CSP no longer refuses inline styles (style-src must stay 'self')",
    );
  }
}

async function assertWidgets(expected: WidgetAssertion[]): Promise<void> {
  const mounted = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".layer.visible [data-tilecast-widget]",
    ),
  );
  const fail = (message: string) => {
    throw new Error(`assertWidgets: ${message}`);
  };
  if (mounted.length !== expected.length) {
    fail(`expected ${expected.length} widgets, found ${mounted.length}`);
  }
  expected.forEach((want, index) => {
    const element = mounted[index]!;
    const where = `widget ${index} (${want.type})`;
    if (element.getAttribute("data-tilecast-widget") !== want.type) {
      fail(`${where} is ${element.getAttribute("data-tilecast-widget")}`);
    }
    const shadow = element.shadowRoot;
    if (!shadow) return fail(`${where} has no shadow root`);
    if ((shadow.adoptedStyleSheets?.length ?? 0) === 0) {
      fail(`${where} has no adopted stylesheets`);
    }
    if (shadow.querySelector("style")) {
      fail(`${where} fell back to a <style> element`);
    }
    if (getComputedStyle(element).containerType !== "size") {
      fail(`${where} is not a size container`);
    }
    const text = (shadow.textContent ?? "").replace(/\s+/g, " ");
    for (const part of want.textIncludes ?? []) {
      if (!text.includes(part)) fail(`${where} text lacks "${part}": ${text}`);
    }
    for (const check of want.styles ?? []) {
      const target = shadow.querySelector(check.selector);
      if (!target) return fail(`${where} has no ${check.selector}`);
      const value = getComputedStyle(target).getPropertyValue(check.property);
      // Engines serialize computed lengths with different precision.
      const px = (text: string) =>
        /^-?[\d.]+px$/.test(text) ? Number.parseFloat(text) : Number.NaN;
      const same =
        value === check.value || Math.abs(px(value) - px(check.value)) < 0.01;
      if (!same) {
        fail(
          `${where} ${check.selector} ${check.property} is ${value}, expected ${check.value}`,
        );
      }
    }
  });
  if (cspViolations.length > 0) {
    fail(`CSP violations: ${cspViolations.join(", ")}`);
  }
  await assertInlineStylesRefused();
}

if (runner) {
  const fixture = runner.fixture;
  const media = fixture.media ?? {};
  const listeners = new Set<(message: HostMessageV1) => void>();
  let evidence: string[] = [];
  let errors: string[] = [];
  let results: string[] = [];
  const evidenceWaiters: (() => void)[] = [];
  const allEvidence: EvidenceReportV1[] = [];
  const timeline: { t: number; entry: string }[] = [];
  const mark = (entry: string) =>
    timeline.push({ t: performance.timeOrigin + performance.now(), entry });
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));

  const send = (message: HostMessageV1) => {
    for (const listener of listeners) listener(message);
  };

  const capabilities: RuntimeCapabilitiesV1 = {
    remoteWeb: null,
    synchronizedPlayback: true,
    setup: true,
    discovery: true,
    noiseMeter: "host-levels",
    ...fixture.capabilities,
  };

  const host: TilecastRuntimeHostV1 = {
    contractVersion: 1,
    info: {
      host: "conformance",
      hostVersion: "1",
      engine: "",
      engineVersion: navigator.userAgent,
    },
    capabilities,
    ...(fixture.realtime
      ? {}
      : {
          conformance: {
            wallClockMs: Date.parse(fixture.wallClock),
            animationScale: 0,
          },
        }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ready() {
      resolveReady();
    },
    presentationResult(result: PresentationResultV1) {
      results.push(
        `${result.activation?.activationId ?? "-"}:${result.outcome}${result.code ? `:${result.code}` : ""}`,
      );
    },
    reportEvidence(report: EvidenceReportV1) {
      allEvidence.push(report);
      timeline.push({
        t: performance.timeOrigin + performance.now(),
        entry: `${report.kind}:${report.itemId ?? "-"}`,
      });
      evidence.push(
        `${report.kind}:${report.itemId ?? "-"}${report.zoneId ? `/${report.zoneId}` : ""}`,
      );
      for (const wake of evidenceWaiters.splice(0)) wake();
    },
    reportPlaybackError(report: PlaybackErrorReportV1) {
      errors.push(`${report.itemId ?? "-"}:${report.message}`);
    },
    setup: {
      submitServerUrl: async (url) =>
        /^https?:\/\//.test(url)
          ? { ok: true }
          : { ok: false, error: "Invalid address" },
    },
    discovery: { list: async () => [] },
    noiseMeter: { report() {}, diagnostic() {} },
  };
  Object.defineProperty(globalThis, "tilecastRuntimeHost", {
    value: Object.freeze(host),
    configurable: false,
  });

  const probe = () =>
    (globalThis as unknown as { __tilecastRuntime: Probe }).__tilecastRuntime;

  const waitForEvidence = async (step: {
    kind: string;
    itemId?: string;
    timeoutMs?: number;
  }) => {
    const matches = () =>
      allEvidence.some(
        (report) =>
          report.kind === step.kind &&
          (step.itemId === undefined || report.itemId === step.itemId),
      );
    // Real media decoding runs on the engine's own clock; this waits on the
    // explicit evidence, bounded, never on a fixed sleep.
    const deadline = performance.now() + (step.timeoutMs ?? 20_000);
    while (!matches()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${step.kind} evidence`);
      }
      await new Promise<void>((resolve) => {
        evidenceWaiters.push(resolve);
        setTimeout(resolve, Math.min(remaining, 250));
      });
    }
  };

  const run = async (): Promise<ConformanceResult> => {
    await ready;
    mark("ready");
    const checkpoints: CheckpointResult[] = [];
    for (const step of fixture.steps) {
      if ("hold" in step) {
        await new Promise((resolve) => setTimeout(resolve, step.hold));
        continue;
      }
      if ("present" in step) {
        mark("present");
        const message = substituteMedia(
          { type: "presentation", ...step.present },
          media,
        ) as HostMessageV1 & { timing?: { anchorMs: unknown } };
        // Real-time runs anchor a shared timeline at the moment of sending.
        if (message.timing?.anchorMs === "now") {
          message.timing.anchorMs = Date.now();
          mark(`anchor:${message.timing.anchorMs}`);
        }
        send(message);
      } else if ("plugins" in step) {
        send(
          substituteMedia(
            {
              type: "plugins",
              plugins: step.plugins.plugins,
              clockOffsetMs: step.plugins.clockOffsetMs ?? 0,
            },
            media,
          ) as HostMessageV1,
        );
      } else if ("identify" in step) {
        send({ type: "identify", ...step.identify });
      } else if ("command" in step) {
        send({ type: "command", command: step.command });
      } else if ("discovered" in step) {
        send({ type: "discovered-server", server: step.discovered });
      } else if ("noise" in step) {
        send({ type: "noise-level", rms: step.noise });
      } else if ("advance" in step) {
        probe().advance(step.advance);
      } else if ("stepWall" in step) {
        probe().stepWall(step.stepWall);
      } else if ("waitForEvidence" in step) {
        await waitForEvidence(step.waitForEvidence);
      } else if ("assertWidgets" in step) {
        await probe().settled();
        await assertWidgets(step.assertWidgets);
      } else if ("checkpoint" in step) {
        await probe().settled();
        const checkpoint: CheckpointResult = {
          name: step.checkpoint,
          visual: step.visual === true,
          state: {
            ...(probe().describe() as object),
            // Everything mounted anywhere, to prove released surfaces are gone.
            document: {
              videos: document.querySelectorAll("video").length,
              images: document.querySelectorAll(".layer img").length,
            },
          },
          evidence,
          errors,
          results,
        };
        evidence = [];
        errors = [];
        results = [];
        if (checkpoint.visual) await runner.snapshot(step.checkpoint);
        checkpoints.push(checkpoint);
      }
      // Let the runtime's own tasks (surface events, renders) run between
      // steps, exactly as they would between host messages in production.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return {
      fixture: fixture.name,
      engine: { userAgent: navigator.userAgent },
      checkpoints,
      failure: null,
      ...(fixture.realtime ? { timeline } : {}),
    };
  };

  run().then(
    (result) => runner.finish(result),
    (error: unknown) =>
      runner.finish({
        fixture: fixture.name,
        engine: { userAgent: navigator.userAgent },
        checkpoints: [],
        // WebKit stacks omit the message; report both.
        failure: `${String((error as Error)?.message ?? error)}\n${String((error as Error)?.stack ?? "")}`,
      }),
  );
}
