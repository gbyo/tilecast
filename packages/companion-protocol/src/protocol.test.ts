import { describe, expect, it } from "vitest";
import {
  COMPANION_PROTOCOL,
  COMPANION_SOURCE,
  isPlayerUrl,
  originPattern,
  parseCompanionMessage,
} from "./protocol";

const base = {
  source: COMPANION_SOURCE,
  protocol: COMPANION_PROTOCOL,
  connectionId: "conn-1",
};

describe("companion protocol", () => {
  it("accepts a full handshake round trip", () => {
    expect(
      parseCompanionMessage({ ...base, kind: "companion-hello" }),
    ).toMatchObject({ kind: "companion-hello" });
    expect(
      parseCompanionMessage({
        ...base,
        kind: "companion-handshake",
        player: "tilecast-browser-player",
        hostVersion: "1.0",
      }),
    ).toMatchObject({ kind: "companion-handshake" });
    expect(
      parseCompanionMessage({ ...base, kind: "companion-bye" }),
    ).toMatchObject({ kind: "companion-bye" });
  });

  it("accepts describe and invoke shapes", () => {
    expect(
      parseCompanionMessage({ ...base, kind: "companion-describe", id: "r1" }),
    ).toMatchObject({ kind: "companion-describe", id: "r1" });
    expect(
      parseCompanionMessage({
        ...base,
        kind: "companion-described",
        id: "r1",
        capabilities: {
          "display.power": { version: 1, provider: "companion_test" },
        },
      }),
    ).toMatchObject({ kind: "companion-described" });
    expect(
      parseCompanionMessage({
        ...base,
        kind: "companion-invoke",
        id: "r2",
        operation: "display.power",
        input: { state: "off" },
      }),
    ).toMatchObject({ kind: "companion-invoke", operation: "display.power" });
    expect(
      parseCompanionMessage({
        ...base,
        kind: "companion-result",
        id: "r2",
        result: { success: true, code: "ok" },
      }),
    ).toMatchObject({ kind: "companion-result" });
  });

  it("rejects forgeries and malformed shapes", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "companion-hello",
      { ...base, kind: "companion-hello", source: "evil" },
      { ...base, kind: "companion-hello", protocol: 2 },
      { ...base, kind: "companion-hello", connectionId: "../x" },
      { ...base, kind: "companion-hello", extra: 1 },
      { ...base, kind: "companion-handshake" },
      { ...base, kind: "companion-exec", command: "id" },
      { ...base, kind: "companion-describe", id: "x".repeat(200) },
      {
        ...base,
        kind: "companion-described",
        id: "r1",
        capabilities: { "display.power": { version: 1 } },
      },
      {
        ...base,
        kind: "companion-described",
        id: "r1",
        capabilities: { power: { version: 1, provider: "x" } },
      },
      {
        ...base,
        kind: "companion-invoke",
        id: "r1",
        operation: "display.power",
        input: { blob: "x".repeat(5000) },
      },
      {
        ...base,
        kind: "companion-invoke",
        id: "r1",
        operation: "exec",
        input: {},
      },
      {
        ...base,
        kind: "companion-result",
        id: "r1",
        result: { success: true },
      },
      {
        ...base,
        kind: "companion-result",
        id: "r1",
        result: { success: true, code: "x".repeat(200) },
      },
    ];
    for (const value of bad) {
      expect(
        parseCompanionMessage(value),
        JSON.stringify(value),
      ).toBeUndefined();
    }
  });

  it("rejects oversized messages", () => {
    expect(
      parseCompanionMessage({
        ...base,
        kind: "companion-handshake",
        player: "tilecast-browser-player",
        hostVersion: "x".repeat(40 * 1024),
      }),
    ).toBeUndefined();
  });

  it("recognizes player URLs and origin patterns", () => {
    expect(isPlayerUrl("https://signage.example.org/player/")).toBe(true);
    expect(isPlayerUrl("http://192.168.1.10:8080/player/lobby")).toBe(true);
    expect(isPlayerUrl("https://signage.example.org/studio/")).toBe(false);
    expect(isPlayerUrl("ftp://signage.example.org/player/")).toBe(false);
    expect(isPlayerUrl("not a url")).toBe(false);
    expect(originPattern("https://signage.example.org/player/")).toBe(
      "https://signage.example.org/*",
    );
    expect(originPattern("http://192.168.1.10:8080/player/")).toBe(
      "http://192.168.1.10:8080/*",
    );
    expect(originPattern("not a url")).toBeUndefined();
  });
});
