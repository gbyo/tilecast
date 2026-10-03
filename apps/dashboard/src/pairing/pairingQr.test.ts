import { describe, expect, it } from "vitest";
import {
  MAX_QR_PAYLOAD_LENGTH,
  normalizePairingCode,
  parsePairingQr,
} from "./pairingQr";

const ACTIVE = {
  origin: "http://192.168.1.50:8080",
  installationId: "8c7d4a52-6a1e-4c1a-9f2b-2f6f0e6d7a10",
};

describe("normalizePairingCode", () => {
  it.each([
    ["K7Q2XD", "K7Q2XD"],
    ["k7q2xd", "K7Q2XD"],
    ["K7Q 2XD", "K7Q2XD"],
    ["K7Q-2XD", "K7Q2XD"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizePairingCode(input)).toBe(expected);
  });

  it.each(["K7Q2X", "K7Q2XDD", "K7Q2X1", "K7Q2XO", "K7Q2XI", "K7Q2XL", ""])(
    "refuses %s",
    (input) => {
      expect(normalizePairingCode(input)).toBeNull();
    },
  );
});

describe("parsePairingQr", () => {
  it("accepts a new-server URL from the same origin", () => {
    expect(
      parsePairingQr(
        `http://192.168.1.50:8080/screens/pair/K7Q2XD?installation=${ACTIVE.installationId}`,
        ACTIVE,
      ),
    ).toEqual({ ok: true, code: "K7Q2XD" });
  });

  it("accepts a new-server URL from a hostname alias", () => {
    expect(
      parsePairingQr(
        `https://signage.example.org/screens/pair/K7Q2XD?installation=${ACTIVE.installationId}`,
        ACTIVE,
      ),
    ).toEqual({ ok: true, code: "K7Q2XD" });
  });

  it("matches installation ids case-insensitively", () => {
    expect(
      parsePairingQr(
        `https://signage.example.org/screens/pair/K7Q2XD?installation=${ACTIVE.installationId.toUpperCase()}`,
        ACTIVE,
      ),
    ).toEqual({ ok: true, code: "K7Q2XD" });
  });

  it("refuses a QR from another installation", () => {
    expect(
      parsePairingQr(
        "https://signage.example.org/screens/pair/K7Q2XD?installation=00000000-0000-4000-8000-000000000000",
        ACTIVE,
      ),
    ).toEqual({ ok: false, reason: "wrong_installation" });
  });

  it("accepts an old-server URL from the exact connected origin", () => {
    expect(
      parsePairingQr(
        "http://192.168.1.50:8080/screens/pair/K7Q2XD",
        ACTIVE,
      ),
    ).toEqual({ ok: true, code: "K7Q2XD" });
  });

  it("refuses an old-server URL from another origin", () => {
    expect(
      parsePairingQr(
        "https://signage.example.org/screens/pair/K7Q2XD",
        ACTIVE,
      ),
    ).toEqual({ ok: false, reason: "wrong_server" });
  });

  it.each([
    ["duplicate installation", `https://signage.example.org/screens/pair/K7Q2XD?installation=${ACTIVE.installationId}&installation=${ACTIVE.installationId}`],
    ["disguised installation key", `https://signage.example.org/screens/pair/K7Q2XD?Installation=${ACTIVE.installationId}`],
    ["invalid UUID", "https://signage.example.org/screens/pair/K7Q2XD?installation=not-a-uuid"],
    ["invalid code", `https://signage.example.org/screens/pair/111111?installation=${ACTIVE.installationId}`],
    ["short code", `https://signage.example.org/screens/pair/K7Q2X?installation=${ACTIVE.installationId}`],
    ["fragment", `https://signage.example.org/screens/pair/K7Q2XD?installation=${ACTIVE.installationId}#evil`],
    ["userinfo", `https://user:pass@signage.example.org/screens/pair/K7Q2XD?installation=${ACTIVE.installationId}`],
    ["non-HTTP scheme", `tilecast://pair/K7Q2XD?installation=${ACTIVE.installationId}`],
    ["javascript scheme", "javascript:alert(1)"],
    ["relative URL", `/screens/pair/K7Q2XD?installation=${ACTIVE.installationId}`],
    ["protocol-relative URL", `//signage.example.org/screens/pair/K7Q2XD?installation=${ACTIVE.installationId}`],
    ["dot segment", `https://signage.example.org/screens/pair/../pair/K7Q2XD?installation=${ACTIVE.installationId}`],
    ["trailing dot", "https://signage.example.org/screens/pair/K7Q2XD/."],
    ["malformed encoding", "https://signage.example.org/screens/pair/K7Q2XD%zz"],
    ["encoded path", "https://signage.example.org/screens%2fpair/K7Q2XD"],
    ["extra path", `https://signage.example.org/screens/pair/K7Q2XD/extra?installation=${ACTIVE.installationId}`],
    ["wrong path", `https://signage.example.org/screens/K7Q2XD?installation=${ACTIVE.installationId}`],
    ["backslash", `https://signage.example.org\\screens/pair/K7Q2XD?installation=${ACTIVE.installationId}`],
    ["whitespace", `https://signage.example.org/screens/pair/K7Q2XD ?installation=${ACTIVE.installationId}`],
    ["bare code", "K7Q2XD"],
    ["empty", ""],
    ["overly long", `https://signage.example.org/screens/pair/K7Q2XD?installation=${ACTIVE.installationId}&pad=${"x".repeat(MAX_QR_PAYLOAD_LENGTH)}`],
  ])("refuses %s as not a pairing URL", (_label, payload) => {
    expect(parsePairingQr(payload, ACTIVE)).toEqual({
      ok: false,
      reason: "not_pairing_url",
    });
  });
});
