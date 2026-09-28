import { describe, expect, it } from "vitest";
import { normalizeOAuthGrant, normalizePersonalAccessToken } from "./auth";

describe("normalizeOAuthGrant", () => {
  it("maps wire nulls to absent optionals", () => {
    const normalized = normalizeOAuthGrant({
      id: "11111111-1111-4111-8111-111111111111",
      client: "Studio CLI",
      scopes: ["read"],
      createdAt: "2026-09-28T19:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(normalized.lastUsedAt).toBeUndefined();
    expect(normalized.revokedAt).toBeUndefined();
    expect(normalized.client).toBe("Studio CLI");
  });

  it("preserves populated timestamps", () => {
    const normalized = normalizeOAuthGrant({
      id: "11111111-1111-4111-8111-111111111111",
      client: "Studio CLI",
      scopes: ["admin"],
      createdAt: "2026-09-28T19:00:00.000Z",
      lastUsedAt: "2026-09-28T20:00:00.000Z",
      revokedAt: "2026-09-28T21:00:00.000Z",
    });
    expect(normalized.lastUsedAt).toBe("2026-09-28T20:00:00.000Z");
    expect(normalized.revokedAt).toBe("2026-09-28T21:00:00.000Z");
  });
});

describe("normalizePersonalAccessToken", () => {
  it("maps wire nulls to absent optionals", () => {
    const normalized = normalizePersonalAccessToken({
      id: "22222222-2222-4222-8222-222222222222",
      name: "Lobby kiosk",
      scopes: ["read", "write"],
      createdAt: "2026-09-28T19:00:00.000Z",
      expiresAt: "2026-10-28T19:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(normalized.lastUsedAt).toBeUndefined();
    expect(normalized.revokedAt).toBeUndefined();
    expect(normalized.name).toBe("Lobby kiosk");
  });
});
