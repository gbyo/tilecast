import { describe, expect, it } from "vitest";
import { normalizeTakeover } from "./system";
import type { Takeover } from "../types";

function wireTakeover(): Parameters<typeof normalizeTakeover>[0] {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Evening takeover",
    description: "",
    playlistId: "22222222-2222-4222-8222-222222222222",
    playlistName: "Lobby loop",
    status: "active",
    activatedAt: "2026-09-28T19:00:00.000Z",
    expiresAt: "2026-09-28T23:00:00.000Z",
    cancelledAt: null,
    cancellationReason: "",
    affectedCount: 3,
    activeCount: 2,
    preparingCount: 1,
    failedCount: 0,
  };
}

describe("normalizeTakeover", () => {
  it("maps wire nulls to absent optionals", () => {
    const normalized: Takeover = normalizeTakeover({
      ...wireTakeover(),
      activatedAt: null,
    });
    expect(normalized.activatedAt).toBeUndefined();
    expect(normalized.cancelledAt).toBeUndefined();
    expect(normalized.expiresAt).toBe("2026-09-28T23:00:00.000Z");
  });

  it("preserves populated timestamps and counts", () => {
    const normalized: Takeover = normalizeTakeover(wireTakeover());
    expect(normalized.activatedAt).toBe("2026-09-28T19:00:00.000Z");
    expect(normalized.affectedCount).toBe(3);
    expect(normalized.activeCount).toBe(2);
  });
});
