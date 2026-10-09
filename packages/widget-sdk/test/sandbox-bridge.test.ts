import { describe, expect, it } from "vitest";
import {
  assertBridgeMessageSize,
  createBridgeNonce,
  MAX_BRIDGE_MESSAGE_BYTES,
  parseFrameHello,
  parseFrameMessage,
  parseFrameReport,
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
      revision: 2,
      state: { state: "ready" },
    };
    expect(parseFrameMessage({ origin: "null", data: good }, nonce, 2)).toEqual(
      {
        protocol: SANDBOX_BRIDGE_PROTOCOL,
        nonce,
        revision: 2,
        state: { state: "ready" },
      },
    );
    // Wrong origin: a page, the host itself, or anything else.
    for (const origin of [
      "https://studio.example",
      "http://localhost:4173",
      "",
    ]) {
      expect(parseFrameMessage({ origin, data: good }, nonce, 2)).toBeNull();
    }
    // Wrong protocol, wrong nonce, stale revision, missing state.
    expect(
      parseFrameMessage(
        {
          origin: "null",
          data: { ...good, protocol: "tilecast.widget.bridge/2" },
        },
        nonce,
        2,
      ),
    ).toBeNull();
    expect(
      parseFrameMessage(
        { origin: "null", data: { ...good, nonce: createBridgeNonce() } },
        nonce,
        2,
      ),
    ).toBeNull();
    // A slow frame's report for a superseded input never settles state.
    expect(
      parseFrameMessage({ origin: "null", data: good }, nonce, 3),
    ).toBeNull();
    expect(
      parseFrameMessage({ origin: "null", data: { ...good } }, nonce, 1),
    ).toBeNull();
    expect(
      parseFrameMessage({ origin: "null", data: null }, nonce, 2),
    ).toBeNull();
    expect(
      parseFrameMessage(
        { origin: "null", data: { ...good, state: { state: "melting" } } },
        nonce,
        2,
      ),
    ).toBeNull();
  });

  it("parses hellos by shape; the executor checks source and origin", () => {
    expect(
      parseFrameHello({
        protocol: SANDBOX_BRIDGE_PROTOCOL,
        kind: "frame-hello",
        helloToken: "token-1",
      }),
    ).toEqual({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      kind: "frame-hello",
      helloToken: "token-1",
    });
    for (const data of [
      null,
      undefined,
      "frame-hello",
      { protocol: SANDBOX_BRIDGE_PROTOCOL },
      {
        protocol: SANDBOX_BRIDGE_PROTOCOL,
        kind: "frame-hello",
      },
      {
        protocol: SANDBOX_BRIDGE_PROTOCOL,
        kind: "frame-hello",
        helloToken: 42,
      },
      {
        protocol: "tilecast.widget.bridge/2",
        kind: "frame-hello",
        helloToken: "token-1",
      },
      {
        protocol: SANDBOX_BRIDGE_PROTOCOL,
        kind: "init",
        helloToken: "token-1",
      },
    ]) {
      expect(parseFrameHello(data)).toBeNull();
    }
  });

  it("parses port reports without an origin check", () => {
    const nonce = createBridgeNonce();
    expect(
      parseFrameReport(
        {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          revision: 1,
          state: { state: "ready" },
        },
        nonce,
        1,
      ),
    ).toEqual({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce,
      revision: 1,
      state: { state: "ready" },
    });
    // The port is the authentication, but the body rules still hold:
    // wrong protocol, wrong nonce, stale revision, and malformed
    // states stay dropped.
    expect(
      parseFrameReport(
        {
          protocol: "tilecast.widget.bridge/2",
          nonce,
          revision: 1,
          state: { state: "ready" },
        },
        nonce,
        1,
      ),
    ).toBeNull();
    expect(
      parseFrameReport(
        {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce: createBridgeNonce(),
          revision: 1,
          state: { state: "ready" },
        },
        nonce,
        1,
      ),
    ).toBeNull();
    expect(
      parseFrameReport(
        {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          revision: 1,
          state: { state: "ready" },
        },
        nonce,
        2,
      ),
    ).toBeNull();
    expect(parseFrameReport(null, nonce, 1)).toBeNull();
    expect(
      parseFrameReport(
        {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          revision: 1,
          state: { state: "melting" },
        },
        nonce,
        1,
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
          revision: 1,
          state: { state: "empty", reason: "<img src=x>" },
        },
      },
      nonce,
      1,
    );
    expect(empty?.state).toEqual({ state: "empty", reason: "unspecified" });
    const error = parseFrameMessage(
      {
        origin: "null",
        data: {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          revision: 1,
          state: { state: "error", code: "../../etc/passwd" },
        },
      },
      nonce,
      1,
    );
    expect(error?.state).toEqual({ state: "error", code: "frame_error" });
    const clean = parseFrameMessage(
      {
        origin: "null",
        data: {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          revision: 1,
          state: { state: "error", code: "bad_input" },
        },
      },
      nonce,
      1,
    );
    expect(clean?.state).toEqual({ state: "error", code: "bad_input" });
  });

  it("refuses to encode messages over the byte ceiling", () => {
    const message: ParentToFrameMessage = {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: createBridgeNonce(),
      kind: "init",
      revision: 1,
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
