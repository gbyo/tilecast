import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeOAuthApproval,
  normalizeOAuthGrant,
  normalizePersonalAccessToken,
} from "./auth";

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

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (input instanceof Request) return input.url;
  return input instanceof URL ? input.href : (input ?? "");
}

describe("describeOAuthApproval", () => {
  afterEach(() => vi.restoreAllMocks());

  const authorize = (method: string) =>
    new URLSearchParams({
      client_id: "tilecast-cli",
      redirect_uri: "http://127.0.0.1:7788/callback",
      scope: "read",
      state: "s1",
      code_challenge: "abc",
      code_challenge_method: method,
    });

  it("forwards an unsupported PKCE method so the Server rejects it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "invalid_challenge", message: "Bad challenge." },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(describeOAuthApproval(authorize("plain"))).rejects.toThrow(
      "Bad challenge.",
    );
    const url = new URL(requestUrl(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("code_challenge_method")).toBe("plain");
  });

  it("omits the method when the request has none", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );
    const params = authorize("S256");
    params.delete("code_challenge_method");
    await describeOAuthApproval(params);
    const url = new URL(requestUrl(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
  });
});
