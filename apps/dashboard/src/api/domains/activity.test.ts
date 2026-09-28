import { describe, expect, it } from "vitest";
import { normalizeScreenEvent } from "./activity";

function wireEvent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    timestamp: "2026-09-28T19:00:00.000Z",
    receivedAt: "2026-09-28T19:00:01.000Z",
    screenId: "22222222-2222-4222-8222-222222222222",
    screenName: "Lobby",
    sequence: 42,
    eventType: "heartbeat.gap_detected",
    category: "connectivity",
    severity: "warning",
    description: "Player stopped reporting",
    result: "unknown",
    details: {},
  } as const;
}

describe("normalizeScreenEvent", () => {
  it("preserves a device queue position", () => {
    const normalized = normalizeScreenEvent({ ...wireEvent() });
    expect(normalized.sequence).toBe(42);
    expect(normalized.eventType).toBe("heartbeat.gap_detected");
  });

  it("models a missing server-derived sequence as absent", () => {
    const normalized = normalizeScreenEvent({ ...wireEvent(), sequence: null });
    expect(normalized.sequence).toBeUndefined();
  });
});
