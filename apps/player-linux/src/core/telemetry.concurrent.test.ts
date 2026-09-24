import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "./api";
import { TelemetryReporter } from "./telemetry";

function interval(sample: Record<string, unknown>) {
  return sample["interval"] as Record<string, unknown>;
}

describe("TelemetryReporter flush serialization", () => {
  it("keeps counters for the next sample while a flush is in flight", async () => {
    const sent: Record<string, unknown>[] = [];
    let releaseFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const postTelemetry = vi.fn(async (sample: unknown) => {
      sent.push(sample as Record<string, unknown>);
      if (sent.length === 1) await firstRequest;
    });
    const client = { postTelemetry } as unknown as ApiClient;
    let clock = 1_000_000;
    const subject = new TelemetryReporter(client, () => ({}), () => clock);

    subject.addCount("droppedFrames", 1);
    clock += 60_000;
    const firstFlush = subject.flush();
    await Promise.resolve();

    subject.addCount("droppedFrames", 2);
    clock += 60_000;
    await subject.flush();

    expect(postTelemetry).toHaveBeenCalledTimes(1);

    releaseFirst();
    await firstFlush;
    await subject.flush();

    expect(postTelemetry).toHaveBeenCalledTimes(2);
    expect(interval(sent[0]!)["droppedFrames"]).toBe(1);
    expect(interval(sent[1]!)["droppedFrames"]).toBe(2);
    expect(interval(sent[1]!)["seconds"]).toBe(60);
  });
});
