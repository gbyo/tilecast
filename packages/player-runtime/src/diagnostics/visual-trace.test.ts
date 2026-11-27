import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installVisualTraceForTest,
  isVisualTraceSink,
  traceValue,
  TRACE_LIMITS,
  VISUAL_TRACE_GLOBAL,
  VISUAL_TRACE_SCHEMA,
  visualTrace,
  type TraceBatch,
  type VisualTraceSink,
} from "./visual-trace";

function sink(deep = false) {
  const batches: TraceBatch[] = [];
  const value: VisualTraceSink = {
    schema: VISUAL_TRACE_SCHEMA,
    deep,
    emit: (batch) => batches.push(structuredClone(batch)),
  };
  return { value, batches };
}

/** A clock whose timers run only when the test says so. */
function manualClock() {
  let now = 1000;
  const timers: (() => void)[] = [];
  const frames: ((time: number) => void)[] = [];
  return {
    clock: {
      now: () => now,
      setTimeout: (callback: () => void) => timers.push(callback),
      requestAnimationFrame: (callback: (time: number) => void) =>
        frames.push(callback),
      getComputedStyle: () => ({ opacity: "0.5", transform: "none" }),
    },
    advance: (ms: number) => (now += ms),
    runTimers: () => timers.splice(0).forEach((timer) => timer()),
    runFrame: () => frames.splice(0).forEach((frame) => frame(now)),
    frames,
    timers,
  };
}

afterEach(() => {
  installVisualTraceForTest(null);
  delete (globalThis as Record<string, unknown>)[VISUAL_TRACE_GLOBAL];
});

describe("visual trace is off by default", () => {
  it("is disabled without an injected sink and does nothing", () => {
    installVisualTraceForTest(null);
    const trace = visualTrace();
    expect(trace.enabled).toBe(false);
    expect(trace.deep).toBe(false);
    expect(trace.nextId("transition")).toBe(0);
    const animation = { ready: Promise.resolve() } as unknown as Animation;
    expect(
      trace.watchAnimation({ scope: "stage", fields: {} }, "x", animation),
    ).toBe(0);
    expect(
      trace.sample({ scope: "stage", fields: {} }, "x", {} as Element),
    ).toBeTypeOf("function");
    trace.record("stage", "stage.swap", { tx: 1 });
    trace.flush();
  });

  it("reads the host global once, and ignores a malformed one", () => {
    for (const malformed of [
      null,
      1,
      "x",
      { schema: "tilecast-visual-v0", deep: false, emit() {} },
      { schema: VISUAL_TRACE_SCHEMA, deep: "no", emit() {} },
      { schema: VISUAL_TRACE_SCHEMA, deep: false, emit: "no" },
    ]) {
      expect(isVisualTraceSink(malformed)).toBe(false);
    }
    const { value, batches } = sink();
    expect(isVisualTraceSink(value)).toBe(true);
    // Without a reset the cached disabled trace stays: the global must exist
    // before the Runtime starts.
    installVisualTraceForTest(null);
    (globalThis as Record<string, unknown>)[VISUAL_TRACE_GLOBAL] = value;
    expect(visualTrace().enabled).toBe(false);
    expect(batches).toEqual([]);
  });
});

describe("records", () => {
  it("keeps only bounded tokens, finite numbers, booleans and null", () => {
    expect(traceValue("stage.swap")).toBe("stage.swap");
    expect(traceValue("video")).toBe("video");
    expect(traceValue(1.23456789)).toBe(1.235);
    expect(traceValue(Number.NaN)).toBeNull();
    expect(traceValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(traceValue(true)).toBe(true);
    expect(traceValue(null)).toBeNull();
    // Anything that could carry content is refused.
    expect(traceValue("https://example.com/a.mp4")).toBeUndefined();
    expect(traceValue("two words")).toBeUndefined();
    expect(traceValue("x".repeat(TRACE_LIMITS.string + 1))).toBeUndefined();
    expect(traceValue({})).toBeUndefined();
    expect(traceValue(undefined)).toBeUndefined();
  });

  it("drops unsafe fields and reserved or malformed keys", () => {
    const { value, batches } = sink();
    const time = manualClock();
    const trace = installVisualTraceForTest(value, time.clock);
    trace.record("stage", "stage.swap", {
      tx: 1,
      layer: "a",
      url: "tcmedia://cap/0123",
      t: 5,
      ev: "other",
      "bad key": 1,
      title: "Lobby screen",
    });
    trace.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.records).toEqual([
      { t: 1000, scope: "stage", ev: "stage.swap", tx: 1, layer: "a" },
    ]);
  });

  it("caps the number of keys in one record", () => {
    const { value, batches } = sink();
    const trace = installVisualTraceForTest(value, manualClock().clock);
    const fields: Record<string, number> = {};
    for (let i = 0; i < 40; i++) fields[`k${i}`] = i;
    trace.record("stage", "many", fields);
    trace.flush();
    expect(Object.keys(batches[0]!.records[0]!)).toHaveLength(
      TRACE_LIMITS.keys,
    );
  });
});

describe("bounds", () => {
  it("batches records and flushes a partial batch after a delay", () => {
    const { value, batches } = sink();
    const time = manualClock();
    const trace = installVisualTraceForTest(value, time.clock);
    trace.record("stage", "a");
    trace.record("stage", "b");
    expect(batches).toEqual([]);
    expect(time.timers).toHaveLength(1);
    time.advance(5);
    time.runTimers();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      schema: VISUAL_TRACE_SCHEMA,
      seq: 1,
      sentAt: 1005,
      dropped: 0,
    });
    expect(batches[0]!.records.map((r) => r.ev)).toEqual(["a", "b"]);
  });

  it("sends a full batch at once and never more than the batch bound", () => {
    const { value, batches } = sink();
    const trace = installVisualTraceForTest(value, manualClock().clock);
    for (let i = 0; i < TRACE_LIMITS.batch * 2 + 3; i++)
      trace.record("stage", "e");
    expect(batches).toHaveLength(2);
    trace.flush();
    expect(batches.map((b) => b.records.length)).toEqual([
      TRACE_LIMITS.batch,
      TRACE_LIMITS.batch,
      3,
    ]);
    expect(batches.map((b) => b.seq)).toEqual([1, 2, 3]);
  });

  it("counts records dropped while the host does not drain", () => {
    const { batches } = sink();
    let accept = false;
    const blocked: VisualTraceSink = {
      schema: VISUAL_TRACE_SCHEMA,
      deep: false,
      emit: (batch) => {
        if (!accept) throw new Error("host busy");
        batches.push(structuredClone(batch));
      },
    };
    const trace = installVisualTraceForTest(blocked, manualClock().clock);
    // A sink that throws loses that batch; tracing never throws to playback.
    for (let i = 0; i < TRACE_LIMITS.batch; i++) trace.record("stage", "e");
    accept = true;
    trace.record("stage", "after");
    trace.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.records.map((r) => r.ev)).toEqual(["after"]);
  });

  it("holds at most the pending bound and reports the overflow", () => {
    const { value, batches } = sink();
    const time = manualClock();
    // A batch size larger than pending would never flush on size alone; the
    // pending bound is what stops growth between timer flushes.
    const trace = installVisualTraceForTest(value, time.clock);
    const internal = trace as unknown as { pending: unknown[] };
    for (let i = 0; i < TRACE_LIMITS.pending; i++)
      internal.pending.push({ t: 0, scope: "stage", ev: "x" });
    trace.record("stage", "overflow");
    trace.record("stage", "overflow");
    expect(internal.pending).toHaveLength(TRACE_LIMITS.pending);
    trace.flush();
    const total = batches.reduce((n, b) => n + b.records.length, 0);
    expect(total).toBe(TRACE_LIMITS.pending);
    expect(batches[0]!.dropped).toBe(2);
  });

  it("stops for good after the per-document limit", () => {
    const { value, batches } = sink();
    const trace = installVisualTraceForTest(value, manualClock().clock);
    for (let i = 0; i < TRACE_LIMITS.total + 10; i++)
      trace.record("stage", "e");
    trace.flush();
    const records = batches.flatMap((b) => b.records);
    expect(records).toHaveLength(TRACE_LIMITS.total + 1);
    expect(records.at(-1)).toMatchObject({ scope: "trace", ev: "limit" });
  });
});

describe("animations", () => {
  function fakeAnimation() {
    let finish!: () => void;
    let fail!: (error: unknown) => void;
    const animation = {
      playState: "pending",
      startTime: null as number | null,
      currentTime: 0 as number | null,
      ready: Promise.resolve(),
      finished: new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    };
    return { animation, finish: () => finish(), fail: (e: unknown) => fail(e) };
  }

  it("records creation, readiness and end under one ordinal", async () => {
    const { value, batches } = sink();
    const trace = installVisualTraceForTest(value, manualClock().clock);
    const { animation, finish } = fakeAnimation();
    const anim = trace.watchAnimation(
      { scope: "stage", fields: { tx: 3 } },
      "fade-in",
      animation as unknown as Animation,
    );
    expect(anim).toBe(1);
    animation.playState = "running";
    animation.startTime = 1016.5;
    animation.currentTime = 0.25;
    await Promise.resolve();
    animation.playState = "finished";
    animation.currentTime = 300;
    finish();
    await animation.finished;
    await Promise.resolve();
    trace.flush();
    const records = batches.flatMap((b) => b.records);
    expect(records.map((r) => r.ev)).toEqual([
      "anim.create",
      "anim.ready",
      "anim.finish",
    ]);
    expect(records[1]).toMatchObject({
      tx: 3,
      anim: 1,
      label: "fade-in",
      playState: "running",
      startTime: 1016.5,
      currentTime: 0.25,
    });
    expect(records[2]).toMatchObject({
      playState: "finished",
      currentTime: 300,
    });
  });

  it("records a cancelled animation", async () => {
    const { value, batches } = sink();
    const trace = installVisualTraceForTest(value, manualClock().clock);
    const { animation, fail } = fakeAnimation();
    trace.watchAnimation(
      { scope: "zone", fields: {} },
      "fade-in",
      animation as unknown as Animation,
    );
    fail(new DOMException("aborted", "AbortError"));
    await animation.finished.catch(() => undefined);
    await Promise.resolve();
    trace.flush();
    expect(batches.flatMap((b) => b.records).at(-1)?.ev).toBe("anim.cancel");
  });

  it("samples every frame in deep mode only, and stops with the animation", async () => {
    const plain = manualClock();
    const plainSink = sink(false);
    const trace = installVisualTraceForTest(plainSink.value, plain.clock);
    const element = { getAnimations: () => [] } as unknown as Element;
    trace.watchAnimation(
      { scope: "stage", fields: {} },
      "fade-in",
      fakeAnimation().animation as unknown as Animation,
      element,
    );
    expect(plain.frames).toHaveLength(0);

    const deep = manualClock();
    const deepSink = sink(true);
    const deepTrace = installVisualTraceForTest(deepSink.value, deep.clock);
    const { animation, finish } = fakeAnimation();
    deepTrace.watchAnimation(
      { scope: "stage", fields: { tx: 1 } },
      "fade-in",
      animation as unknown as Animation,
      element,
    );
    expect(deep.frames).toHaveLength(1);
    deep.runFrame();
    deep.runFrame();
    finish();
    await animation.finished;
    await Promise.resolve();
    deep.runFrame();
    expect(deep.frames).toHaveLength(0);
    deepTrace.flush();
    const samples = deepSink.batches
      .flatMap((b) => b.records)
      .filter((r) => r.ev === "deep.sample");
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      tx: 1,
      opacity: 0.5,
      transformed: false,
    });
  });
});

describe("ending a trace", () => {
  const element = { getAnimations: () => [] } as unknown as Element;
  const pending = () =>
    ({
      ready: new Promise(() => undefined),
      finished: new Promise(() => undefined),
    }) as unknown as Animation;

  it("stops sampling and watching at the per-document limit", () => {
    const time = manualClock();
    const { value } = sink(true);
    const trace = installVisualTraceForTest(value, time.clock);
    trace.watchAnimation(
      { scope: "stage", fields: {} },
      "fade-in",
      pending(),
      element,
    );
    expect(time.frames).toHaveLength(1);
    const internal = trace as unknown as { total: number };
    internal.total = TRACE_LIMITS.total;
    trace.record("stage", "e");
    time.runFrame();
    expect(time.frames).toHaveLength(0);
    trace.watchAnimation(
      { scope: "stage", fields: {} },
      "fade-in",
      pending(),
      element,
    );
    expect(time.frames).toHaveLength(0);
    expect(trace.sample({ scope: "stage", fields: {} }, "x", element)).toBe(
      trace.sample({ scope: "stage", fields: {} }, "y", element),
    );
  });

  it("stops recording and sampling when the host's window ends", () => {
    const time = manualClock();
    const { value, batches } = sink(true);
    let active = true;
    const trace = installVisualTraceForTest(
      { ...value, active: () => active },
      time.clock,
    );
    trace.watchAnimation(
      { scope: "stage", fields: {} },
      "fade-in",
      pending(),
      element,
    );
    time.runFrame();
    trace.flush();
    expect(time.frames).toHaveLength(1);
    const before = batches.flatMap((b) => b.records).map((r) => r.ev);
    expect(before).toContain("deep.sample");
    active = false;
    time.runFrame();
    expect(time.frames).toHaveLength(0);
    trace.record("stage", "after");
    trace.flush();
    const after = batches.flatMap((b) => b.records).map((r) => r.ev);
    expect(after).toEqual(before);
  });

  it("accepts a sink with active() and refuses one where it is not a function", () => {
    const { value } = sink();
    expect(isVisualTraceSink({ ...value, active: () => true })).toBe(true);
    expect(isVisualTraceSink({ ...value, active: true })).toBe(false);
  });

  it("records the effect's end time when the animation is created", () => {
    const { value, batches } = sink();
    const trace = installVisualTraceForTest(value, manualClock().clock);
    const animation = {
      ...pending(),
      effect: { getComputedTiming: () => ({ endTime: 600 }) },
    } as unknown as Animation;
    trace.watchAnimation({ scope: "stage", fields: {} }, "fade-in", animation);
    trace.flush();
    expect(batches[0]!.records[0]).toMatchObject({
      ev: "anim.create",
      endTime: 600,
    });
  });
});

describe("sink failures", () => {
  it("never throws into the caller", () => {
    const failing: VisualTraceSink = {
      schema: VISUAL_TRACE_SCHEMA,
      deep: false,
      emit: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    const trace = installVisualTraceForTest(failing, manualClock().clock);
    expect(() => {
      for (let i = 0; i < TRACE_LIMITS.batch + 1; i++)
        trace.record("stage", "e");
      trace.flush();
    }).not.toThrow();
  });
});
