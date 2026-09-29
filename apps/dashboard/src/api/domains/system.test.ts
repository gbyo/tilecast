import { describe, expect, it } from "vitest";
import { normalizeSettingsExport, normalizeTakeover } from "./system";
import type { SettingsExportDocument, Takeover } from "../types";

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

describe("normalizeSettingsExport", () => {
  it("fills the stripped definitions with an empty list", () => {
    const normalized: SettingsExportDocument = normalizeSettingsExport({
      schemaVersion: 1,
      exportedAt: "2026-09-28T20:00:00.000Z",
      tilecastVersion: "0.8.0",
      organization: {
        schemaVersion: 1,
        revision: 7,
        values: {},
        updatedAt: "2026-09-28T20:00:00.000Z",
      },
      groupPolicies: [],
    });
    expect(normalized.organization.definitions).toEqual([]);
    expect(normalized.organization.revision).toBe(7);
  });
});
