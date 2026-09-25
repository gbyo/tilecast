import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api";
import {
  percentile,
  TelemetryReporter,
  type TelemetryGauges,
} from "./telemetry";

function reporter(gauges: TelemetryGauges = {}) {
  const sent: Record<string, unknown>[] = [];
  let clock = 1_000_000;
  const client = {
    postTelemetry: async (sample: unknown) => {
      sent.push(sample as Record<string, unknown>);
    },
  } as unknown as ApiClient;
  return {
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
    subject: new TelemetryReporter(
      client,
      () => gauges,
      () => clock,
    ),
  };
}

function interval(sample: Record<string, unknown>) {
  return sample["interval"] as Record<string, unknown>;
}

describe("telemetry sampling", () => {
  it("sends the latest gauges and the accumulated counters", async () => {
    const { sent, subject, advance } = reporter({
      currentItemId: "poster",
      cacheUsedBytes: 900,
      cacheLimitBytes: 1000,
      rendererResponding: true,
    });

    subject.addSeconds("connectedSeconds", 60);
    subject.addSeconds("healthyPlaybackSeconds", 55);
    subject.addCount("downloadedBytes", 4096);
    advance(60_000);
    await subject.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.["currentItemId"]).toBe("poster");
    expect(interval(sent[0]!)["connectedSeconds"]).toBe(60);
    expect(interval(sent[0]!)["healthyPlaybackSeconds"]).toBe(55);
    expect(interval(sent[0]!)["downloadedBytes"]).toBe(4096);
    expect(interval(sent[0]!)["seconds"]).toBe(60);
  });

  it("resets the counters so the next sample is a delta, not a total", async () => {
    const { sent, subject, advance } = reporter();

    subject.addCount("droppedFrames", 10);
    advance(60_000);
    await subject.flush();
    advance(60_000);
    await subject.flush();

    // Sending cumulative totals would make every rollup double-count.
    expect(interval(sent[0]!)["droppedFrames"]).toBe(10);
    expect(interval(sent[1]!)["droppedFrames"]).toBe(0);
  });

  it("reports sync drift as percentiles rather than raw samples", async () => {
    const { sent, subject, advance } = reporter();

    for (const drift of [10, 20, 30, 40, 500]) {
      subject.recordSample("syncDrift", drift);
    }
    advance(60_000);
    await subject.flush();

    const values = interval(sent[0]!);
    expect(values["syncDriftP50Ms"]).toBe(30);
    expect(values["syncDriftP95Ms"]).toBe(500);
    expect(values["syncDriftMaxMs"]).toBe(500);
    // The raw samples never leave the player.
    expect(JSON.stringify(sent[0])).not.toContain("syncDriftSamples");
  });

  it("treats drift as a magnitude, so early and late are equally bad", async () => {
    const { sent, subject, advance } = reporter();
    subject.recordSample("syncDrift", -400);
    advance(60_000);
    await subject.flush();
    expect(interval(sent[0]!)["syncDriftMaxMs"]).toBe(400);
  });

  it("keeps the in-memory sample set bounded", async () => {
    const { sent, subject, advance } = reporter();

    // A player that cannot reach the server for hours must not grow without
    // limit; the oldest samples are dropped instead.
    for (let index = 0; index < 5_000; index++) {
      subject.recordSample("memory", index);
    }
    advance(60_000);
    await subject.flush();

    const peak = interval(sent[0]!)["peakMemoryBytes"] as number;
    expect(peak).toBe(4_999);
    // Only the most recent window survived, so the mean reflects it.
    expect(interval(sent[0]!)["averageMemoryBytes"]).toBeGreaterThan(4_000);
  });

  it("omits a measurement the player cannot take", async () => {
    const { sent, subject, advance } = reporter();
    advance(60_000);
    await subject.flush();

    const values = interval(sent[0]!);
    // Absent, not zero: a zero average CPU would be a claim, and a zero
    // luminance would read as a black screen.
    expect(values["averageCpuPercent"]).toBeUndefined();
    expect(values["syncDriftP50Ms"]).toBeUndefined();
    expect(sent[0]?.["averageLuminance"]).toBeUndefined();
  });

  it("accumulates thermal seconds per state", async () => {
    const { sent, subject, advance } = reporter();
    subject.recordThermalSeconds("nominal", 40);
    subject.recordThermalSeconds("serious", 20);
    subject.recordThermalSeconds("nominal", 10);
    advance(60_000);
    await subject.flush();

    expect(interval(sent[0]!)["thermalSeconds"]).toEqual({
      nominal: 50,
      serious: 20,
    });
  });

  it("drops a sample the server rejects rather than buffering it", async () => {
    const failing = {
      postTelemetry: vi.fn().mockRejectedValue(new Error("offline")),
    } as unknown as ApiClient;
    const subject = new TelemetryReporter(
      failing,
      () => ({}),
      () => 1_000_000,
    );

    // Telemetry is not proof of play. Buffering it would trade a minute of
    // lost detail for unbounded memory on a player offline for hours.
    await expect(subject.flush()).resolves.toBeUndefined();
  });

  it("stops sending once stopped", async () => {
    const { sent, subject } = reporter();
    subject.stop();
    await subject.flush();
    expect(sent).toHaveLength(0);
  });
});

describe("percentile", () => {
  it("returns nothing for an empty sample set", () => {
    expect(percentile([], 0.5)).toBeUndefined();
  });

  it("does not require the input to be sorted", () => {
    expect(percentile([50, 10, 30, 20, 40], 0.5)).toBe(30);
  });

  it("clamps to the available samples", () => {
    expect(percentile([7], 0.95)).toBe(7);
  });
});

describe("request accounting", () => {
  it("counts every request once and attributes failures to a class", async () => {
    const { sent, subject, advance } = reporter();

    subject.recordRequest({ status: 200 });
    subject.recordRequest({ status: 304 });
    subject.recordRequest({ status: 401 });
    subject.recordRequest({ status: 503 });
    // No status at all: the request never reached a response.
    subject.recordRequest({});
    advance(60_000);
    await subject.flush();

    const counters = interval(sent[0]!);
    expect(counters["httpRequestCount"]).toBe(5);
    // A 4xx, a 5xx, and a network failure — a 304 is not a failure.
    expect(counters["httpFailureCount"]).toBe(3);
    expect(counters["httpClientErrorCount"]).toBe(1);
    expect(counters["httpServerErrorCount"]).toBe(1);
  });

  it("counts a retry only when the previous attempt failed", async () => {
    const { sent, subject, advance } = reporter();

    subject.recordRequest({ status: 200 });
    subject.recordRequest({ status: 500 });
    subject.recordRequest({ status: 200, retry: true });
    advance(60_000);
    await subject.flush();

    expect(interval(sent[0]!)["requestRetryCount"]).toBe(1);
  });

  it("derives throughput from bytes and elapsed time", async () => {
    const { sent, subject, advance } = reporter();

    subject.recordRequest({ status: 200, bytes: 2_000_000, durationMs: 1_000 });
    subject.recordRequest({ status: 200, bytes: 1_000_000, durationMs: 1_000 });
    advance(60_000);
    await subject.flush();

    expect(interval(sent[0]!)["averageThroughputBytesPerSecond"]).toBe(
      1_500_000,
    );
  });

  it("ignores a transfer with no elapsed time rather than dividing by zero", async () => {
    const { sent, subject, advance } = reporter();

    subject.recordRequest({ status: 200, bytes: 5_000, durationMs: 0 });
    advance(60_000);
    await subject.flush();

    expect(
      interval(sent[0]!)["averageThroughputBytesPerSecond"],
    ).toBeUndefined();
  });

  it("reports connection timing as a percentile, not as raw samples", async () => {
    const { sent, subject, advance } = reporter();

    for (const ms of [10, 12, 14, 16, 900]) {
      subject.recordRequest({ status: 200, timeToFirstByteMs: ms });
    }
    advance(60_000);
    await subject.flush();

    // The outlier is what a p95 exists to surface.
    expect(interval(sent[0]!)["timeToFirstByteP95Ms"]).toBe(900);
  });
});

describe("frame timing", () => {
  it("reports p95 and p99 frame time and leaves them absent without samples", async () => {
    const { sent, subject, advance } = reporter();
    advance(60_000);
    await subject.flush();
    expect(interval(sent[0]!)["frameTimeP95Ms"]).toBeUndefined();

    for (let index = 0; index < 100; index += 1) {
      subject.recordSample("frameTime", index < 97 ? 16 : 120);
    }
    advance(60_000);
    await subject.flush();

    expect(interval(sent[1]!)["frameTimeP95Ms"]).toBe(16);
    expect(interval(sent[1]!)["frameTimeP99Ms"]).toBe(120);
  });

  it("ignores a non-finite sample instead of poisoning the percentile", () => {
    const { subject } = reporter();
    expect(() => subject.recordSample("frameTime", Number.NaN)).not.toThrow();
  });
});

describe("integer telemetry fields", () => {
  it("rounds what the server decodes as an integer and keeps the rest", async () => {
    const { integerFields } = await import("./telemetry");
    const sample = integerFields({
      observedAt: "2026-09-25T00:00:00Z",
      serverRoundTripMs: 12.6,
      displayRefreshHz: 59.94,
      interval: {
        averageThroughputBytesPerSecond: 105136.23,
        averageCpuPercent: 3.5,
        frameTimeP95Ms: 16.7,
      },
    });
    expect(sample.serverRoundTripMs).toBe(13);
    expect(sample.displayRefreshHz).toBe(59.94);
    expect(sample.interval).toEqual({
      averageThroughputBytesPerSecond: 105136,
      averageCpuPercent: 3.5,
      frameTimeP95Ms: 16.7,
    });
  });
});
