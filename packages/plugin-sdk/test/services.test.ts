import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAYER_PLUGIN_HOST_CAPABILITY,
  PLAYER_PLUGIN_HOST_VERSION,
  PLAYER_SERVICES,
  parseServiceReference,
  serviceAvailable,
  serviceReferenceProblem,
} from "../src/services";

const canonical = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "player-services.json"), "utf8"),
);

describe("Player service vocabulary", () => {
  // The Go SDK and Player Core replay the same file.
  it("mirrors player-services.json exactly", () => {
    expect(canonical.schemaVersion).toBe(1);
    expect(canonical.host.capability).toBe(PLAYER_PLUGIN_HOST_CAPABILITY);
    expect(canonical.host.version).toBe(PLAYER_PLUGIN_HOST_VERSION);
    expect(canonical.services).toEqual(PLAYER_SERVICES);
  });

  it("uses unique, capability-shaped names", () => {
    const names = PLAYER_SERVICES.map((service) => service.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.startsWith("player.")).toBe(true);
    }
  });

  it("parses name@version references", () => {
    expect(parseServiceReference("player.presentation.observe@1")).toEqual({
      name: "player.presentation.observe",
      version: 1,
    });
    for (const bad of ["player.clock", "clock@1", "player.clock@0", "@1"]) {
      expect(parseServiceReference(bad)).toBeNull();
    }
  });

  it("refuses unknown, too-new, and wrong-execution references", () => {
    expect(serviceReferenceProblem("player.clock@1", "runtime")).toBeNull();
    expect(serviceReferenceProblem("player.clock@2", "runtime")).toMatch(
      /no version 2/,
    );
    expect(serviceReferenceProblem("player.warp@1", "runtime")).toMatch(
      /not a Player plugin service/,
    );
    expect(serviceReferenceProblem("player.surface@1", "native")).toMatch(
      /runtime service/,
    );
  });

  it("treats a reported version as covering every lower version", () => {
    expect(serviceAvailable({ "player.clock": 3 }, "player.clock@1")).toBe(
      true,
    );
    expect(serviceAvailable({ "player.clock": 1 }, "player.clock@2")).toBe(
      false,
    );
    expect(serviceAvailable({}, "player.clock@1")).toBe(false);
  });
});
