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
  /** Real-time fixtures only (performance runs): wait on the real clock. */
  | { hold: number };

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
        failure: String((error as Error)?.stack ?? error),
      }),
  );
}
