import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import { PlaybackDiagnostics } from "./diagnostics";

function setup(options: { minLogIntervalMs?: number; ringSize?: number } = {}) {
  const clock = new ManualClock({ wallMs: 0 });
  const lines: string[] = [];
  const diagnostics = new PlaybackDiagnostics({
    clock,
    log: (line) => lines.push(line),
    ...options,
  });
  return { clock, lines, diagnostics };
}

describe("playback diagnostics", () => {
  it("counts without logging", () => {
    const { diagnostics, lines } = setup();
    for (let i = 0; i < 1_000; i += 1) {
      diagnostics.count("decoders-reused");
      diagnostics.drift(i % 400);
    }
    const snapshot = diagnostics.snapshot();
    expect(snapshot.counters["decoders-reused"]).toBe(1_000);
    expect(snapshot.drift.samples).toBe(1_000);
    expect(snapshot.drift.maxAbsMs).toBe(399);
    expect(lines).toEqual([]);
    expect(snapshot.recent).toEqual([]);
  });

  it("aggregates drift into bands", () => {
    const { diagnostics } = setup();
    for (const drift of [10, -90, 120, -300, 80, 251]) diagnostics.drift(drift);
    expect(diagnostics.snapshot().drift).toEqual({
      samples: 6,
      maxAbsMs: 300,
      lastMs: 251,
      overRateBand: 4,
      overSeekBand: 2,
    });
  });

  it("logs a kind at most once per interval", () => {
    const { diagnostics, lines, clock } = setup();
    diagnostics.note("seeks-correction", { driftMs: 300 });
    diagnostics.note("seeks-correction", { driftMs: 310 });
    clock.advance(4_999);
    diagnostics.note("seeks-correction", { driftMs: 320 });
    expect(lines).toEqual(["playback seeks-correction driftMs=300"]);
    clock.advance(1);
    diagnostics.note("seeks-correction", { driftMs: 330 });
    expect(lines).toHaveLength(2);
    // Every one was still counted and kept for the probe.
    const snapshot = diagnostics.snapshot();
    expect(snapshot.counters["seeks-correction"]).toBe(4);
    expect(snapshot.suppressedLogs).toBe(2);
  });

  it("caps the lines logged per minute across kinds", () => {
    const { diagnostics, lines, clock } = setup({ minLogIntervalMs: 0 });
    for (let i = 0; i < 100; i += 1) {
      diagnostics.note("stalls", { i });
      clock.advance(10);
    }
    expect(lines).toHaveLength(12);
    clock.advance(60_000);
    diagnostics.note("stalls", { i: 100 });
    expect(lines).toHaveLength(13);
  });

  it("keeps a bounded ring of recent entries", () => {
    const { diagnostics } = setup({ ringSize: 4 });
    for (let i = 0; i < 20; i += 1) diagnostics.note("stalls", { i });
    const recent = diagnostics.snapshot().recent;
    expect(recent).toHaveLength(4);
    expect(recent.map((entry) => entry.detail)).toEqual([
      "i=16",
      "i=17",
      "i=18",
      "i=19",
    ]);
  });

  it("bounds the distinct rejection reasons it remembers", () => {
    const { diagnostics } = setup();
    for (let i = 0; i < 500; i += 1) diagnostics.reuseRejected(`reason-${i}`);
    for (let i = 0; i < 3; i += 1) diagnostics.reuseRejected("reason-0");
    const rejected = diagnostics.snapshot().reuseRejected;
    expect(Object.keys(rejected)).toHaveLength(32);
    expect(rejected["reason-0"]).toBe(4);
  });

  it("logs nothing when no sink was given", () => {
    const diagnostics = new PlaybackDiagnostics({
      clock: new ManualClock({ wallMs: 0 }),
    });
    diagnostics.note("stalls", { a: 1 });
    expect(diagnostics.snapshot().counters["stalls"]).toBe(1);
    expect(diagnostics.snapshot().suppressedLogs).toBe(0);
  });

  it("hands out copies", () => {
    const { diagnostics } = setup();
    const snapshot = diagnostics.snapshot();
    snapshot.counters["stalls"] = 99;
    expect(diagnostics.snapshot().counters["stalls"]).toBe(0);
  });
});
