import { describe, expect, it, vi } from "vitest";
import { definePlayerPlugin, type PlayerStateEntry } from "../src/player";
import { createTestPlayer } from "../src/player-testing";

const state: PlayerStateEntry = {
  id: "fixture-1",
  type: "fixture",
  version: 1,
  state: {},
  media: [],
  validUntil: null,
};

describe("the Player test driver's service negotiation", () => {
  it("leaves a plugin inactive when a required service has no fake", () => {
    const activate = vi.fn();
    const definition = definePlayerPlugin({
      id: "fixture",
      services: { required: ["player.events@1"], optional: [] },
      activate,
    });
    for (const services of [undefined, ["player.events@1"] as const]) {
      const player = createTestPlayer(definition, { services });
      player.setState([state]);
      expect(player.active).toBe(false);
    }
    expect(activate).not.toHaveBeenCalled();
  });

  it("passes null for an optional service without a fake and keeps clock timers", () => {
    const tick = vi.fn();
    const definition = definePlayerPlugin({
      id: "fixture",
      services: {
        required: ["player.clock@1"],
        optional: ["player.presentation.provide@1"],
      },
      activate: ({ services }) => {
        expect(services["player.presentation.provide@1"]).toBeNull();
        services["player.clock@1"].every(100, tick);
      },
    });
    const player = createTestPlayer(definition);
    player.setState([state]);
    expect(player.active).toBe(true);
    player.advance(100);
    expect(tick).toHaveBeenCalledTimes(1);
    player.setState([]);
    player.advance(100);
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
