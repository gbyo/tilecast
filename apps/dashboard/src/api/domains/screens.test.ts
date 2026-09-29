import { describe, expect, it } from "vitest";
import { normalizePlayerCommand } from "./screens";

describe("normalizePlayerCommand", () => {
  it("maps wire nulls to absent optionals", () => {
    const normalized = normalizePlayerCommand({
      id: "11111111-1111-4111-8111-111111111111",
      type: "sync_now",
      payload: {},
      state: "pending",
      createdAt: "2026-09-28T19:00:00.000Z",
      expiresAt: "2026-09-28T19:05:00.000Z",
      deliveredAt: null,
      acknowledgedAt: null,
      completedAt: null,
      resultCode: null,
      resultMessage: null,
    });
    expect(normalized.deliveredAt).toBeUndefined();
    expect(normalized.acknowledgedAt).toBeUndefined();
    expect(normalized.completedAt).toBeUndefined();
    expect(normalized.resultCode).toBeUndefined();
    expect(normalized.resultMessage).toBeUndefined();
    expect(normalized.state).toBe("pending");
  });

  it("preserves completed legs and results", () => {
    const normalized = normalizePlayerCommand({
      id: "11111111-1111-4111-8111-111111111111",
      type: "display_probe",
      payload: { input: "HDMI1" },
      state: "succeeded",
      createdAt: "2026-09-28T19:00:00.000Z",
      expiresAt: "2026-09-28T19:05:00.000Z",
      deliveredAt: "2026-09-28T19:00:01.000Z",
      acknowledgedAt: "2026-09-28T19:00:02.000Z",
      completedAt: "2026-09-28T19:00:03.000Z",
      resultCode: "ok",
      resultMessage: "probe complete",
    });
    expect(normalized.completedAt).toBe("2026-09-28T19:00:03.000Z");
    expect(normalized.resultCode).toBe("ok");
  });
});
