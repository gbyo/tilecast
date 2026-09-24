import { describe, expect, it } from "vitest";
import { parseExternalPresentationConfig } from "./external-presentation";

function validConfig() {
  return {
    provider: "airplay",
    sessionId: "session-1",
    receiverName: "Tilecast",
    pin: "1234",
    deviceId: "02:00:00:00:00:01",
    expiresAt: "2026-09-06T12:00:00Z",
    role: "single",
    targetType: "screen",
    targetId: "screen-1",
    gatewayScreenId: "screen-1",
    audioScreenId: "screen-1",
    transport: "unicast",
    videoPort: 42_000,
    destinations: [{ screenId: "screen-1", host: "192.0.2.10", port: 42_000 }],
    profile: "1080p30",
    audioMode: "gateway_only",
  };
}

describe("parseExternalPresentationConfig port validation", () => {
  it.each([0, -1, 65_536])("rejects destination port %s", (port) => {
    const config = validConfig();
    config.destinations[0]!.port = port;

    expect(() => parseExternalPresentationConfig(config)).toThrow(
      "AirPlay destination port is invalid",
    );
  });

  it.each([0, -1, 65_536])("rejects video port %s", (videoPort) => {
    const config = { ...validConfig(), videoPort };

    expect(() => parseExternalPresentationConfig(config)).toThrow(
      "AirPlay video port is invalid",
    );
  });

  it.each([1, 65_535])("accepts boundary port %s", (port) => {
    const config = validConfig();
    config.videoPort = port;
    config.destinations[0]!.port = port;

    expect(parseExternalPresentationConfig(config).videoPort).toBe(port);
  });
});
