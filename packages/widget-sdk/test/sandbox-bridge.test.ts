import { describe, expect, it } from "vitest";
import {
  assertBridgeMessageSize,
  createBridgeNonce,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseFrameMessage,
  SANDBOX_BRIDGE_PROTOCOL,
  snapshotDeclaredResources,
  type ParentToFrameMessage,
} from "../src/sandbox-bridge.ts";
import { fixtureResources } from "../src/testing.ts";

describe("sandbox bridge", () => {
  it("mints unique url-safe nonces", () => {
    const nonces = new Set(
      Array.from({ length: 100 }, () => createBridgeNonce()),
    );
    expect(nonces.size).toBe(100);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("snapshots only declared documents and media", () => {
    const { documents, media } = snapshotDeclaredResources(fixtureResources(), {
      dataSources: ["schedule", "undeclared"],
      media: [
        { assetId: "hero", variantId: "full" },
        { assetId: "hero", variantId: "missing" },
      ],
    });
    // Whatever the fixtures answer, undeclared IDs never cross.
    expect(Object.keys(documents)).not.toContain("undeclared");
    expect(media.some((grant) => grant.variantId === "missing")).toBe(false);
  });

  it("drops every inbound message that is not an opaque-origin nonce match", () => {
    const nonce = createBridgeNonce();
    const good = {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce,
      state: { state: "ready" },
    };
    expect(parseFrameMessage({ origin: "null", data: good }, nonce)).toEqual({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce,
      state: { state: "ready" },
    });
    // Wrong origin: a page, the host itself, or anything else.
    for (const origin of [
      "https://studio.example",
      "http://localhost:4173",
      "",
    ]) {
      expect(parseFrameMessage({ origin, data: good }, nonce)).toBeNull();
    }
    // Wrong protocol, wrong nonce, missing state.
    expect(
      parseFrameMessage(
        {
          origin: "null",
          data: { ...good, protocol: "tilecast.widget.bridge/2" },
        },
        nonce,
      ),
    ).toBeNull();
    expect(
      parseFrameMessage(
        { origin: "null", data: { ...good, nonce: createBridgeNonce() } },
        nonce,
      ),
    ).toBeNull();
    expect(parseFrameMessage({ origin: "null", data: null }, nonce)).toBeNull();
    expect(
      parseFrameMessage(
        { origin: "null", data: { ...good, state: { state: "melting" } } },
        nonce,
      ),
    ).toBeNull();
  });

  it("bounds empty reasons and error codes from the frame", () => {
    const nonce = createBridgeNonce();
    const empty = parseFrameMessage(
      {
        origin: "null",
        data: {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          state: { state: "empty", reason: "<img src=x>" },
        },
      },
      nonce,
    );
    expect(empty?.state).toEqual({ state: "empty", reason: "unspecified" });
    const error = parseFrameMessage(
      {
        origin: "null",
        data: {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          state: { state: "error", code: "../../etc/passwd" },
        },
      },
      nonce,
    );
    expect(error?.state).toEqual({ state: "error", code: "frame_error" });
    const clean = parseFrameMessage(
      {
        origin: "null",
        data: {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          state: { state: "error", code: "bad_input" },
        },
      },
      nonce,
    );
    expect(clean?.state).toEqual({ state: "error", code: "bad_input" });
  });

  it("refuses to encode messages over the byte ceiling", () => {
    const message: ParentToFrameMessage = {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: createBridgeNonce(),
      kind: "init",
      snapshot: {
        component: { type: "acme.big", version: 1, config: null },
        documents: {
          bulk: { rows: "x".repeat(MAX_BRIDGE_MESSAGE_BYTES) } as never,
        },
        media: [],
        context: {
          wallClockOffsetMs: 0,
          locale: "en",
          timeZone: "UTC",
          hourCycle: "locale",
          theme: {
            scheme: "dark",
            background: "#000",
            foreground: "#fff",
            accent: "#0af",
          },
          reducedMotion: false,
          mode: "playback",
        },
      },
    };
    expect(() => assertBridgeMessageSize(message)).toThrow(/over the .* limit/);
    expect(() =>
      assertBridgeMessageSize({
        ...message,
        snapshot: undefined,
        kind: "dispose",
      }),
    ).not.toThrow();
  });
});
