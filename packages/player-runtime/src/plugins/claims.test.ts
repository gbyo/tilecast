import { describe, expect, it } from "vitest";
import type { SurfaceSlot, SurfaceTier } from "@tilecast/plugin-sdk/runtime";
import {
  arbitrate,
  compareContenders,
  geometry,
  validateClaims,
  type Contender,
} from "./claims";

const surfaces: SurfaceSlot[] = ["strip.bottom", "corner.top-left", "overlay"];

describe("claim validation", () => {
  it("accepts well-formed claims and defaults a strip to overlay", () => {
    const check = validateClaims(surfaces, [
      { slot: "strip.bottom", priority: 5, heightPx: 72 },
      { slot: "corner.top-left", priority: -3 },
      { slot: "overlay", priority: 0 },
    ]);
    expect(check.problems).toEqual([]);
    expect(check.claims).toEqual([
      {
        slot: "strip.bottom",
        priority: 5,
        heightPx: 72,
        displayMode: "overlay",
      },
      {
        slot: "corner.top-left",
        priority: -3,
        heightPx: 0,
        displayMode: "overlay",
      },
      { slot: "overlay", priority: 0, heightPx: 0, displayMode: "overlay" },
    ]);
  });

  it.each([
    ["not an array", { slot: "overlay" }],
    ["an undeclared slot", [{ slot: "strip.top", priority: 1, heightPx: 40 }]],
    ["an unknown slot", [{ slot: "middle", priority: 1 }]],
    ["a claimed tier", [{ slot: "overlay", priority: 1, tier: "emergency" }]],
    ["an infinite priority", [{ slot: "overlay", priority: Infinity }]],
    ["a NaN priority", [{ slot: "overlay", priority: Number.NaN }]],
    ["a priority out of range", [{ slot: "overlay", priority: 1_000_001 }]],
    ["a string priority", [{ slot: "overlay", priority: "9" }]],
    ["a missing strip height", [{ slot: "strip.bottom", priority: 1 }]],
    [
      "a zero strip height",
      [{ slot: "strip.bottom", priority: 1, heightPx: 0 }],
    ],
    [
      "a negative strip height",
      [{ slot: "strip.bottom", priority: 1, heightPx: -5 }],
    ],
    [
      "a strip taller than allowed",
      [{ slot: "strip.bottom", priority: 1, heightPx: 541 }],
    ],
    [
      "an unknown display mode",
      [
        {
          slot: "strip.bottom",
          priority: 1,
          heightPx: 40,
          displayMode: "float",
        },
      ],
    ],
    [
      "strip fields on a corner",
      [{ slot: "corner.top-left", priority: 1, heightPx: 40 }],
    ],
    [
      "strip fields on the overlay",
      [{ slot: "overlay", priority: 1, displayMode: "push" }],
    ],
    ["a null claim", [null]],
  ])("refuses %s without throwing", (_name, returned) => {
    const check = validateClaims(surfaces, returned);
    expect(check.claims).toEqual([]);
    expect(check.problems).toHaveLength(1);
  });

  it("keeps the first claim for a slot and refuses a duplicate", () => {
    const check = validateClaims(surfaces, [
      { slot: "overlay", priority: 1 },
      { slot: "overlay", priority: 9 },
    ]);
    expect(check.claims.map((claim) => claim.priority)).toEqual([1]);
    expect(check.problems).toEqual(["more than one claim for overlay"]);
  });
});

const contender = (
  pluginId: string,
  tier: SurfaceTier,
  priority: number,
  slot: SurfaceSlot = "strip.bottom",
  heightPx = 72,
  displayMode: "overlay" | "push" = "overlay",
): Contender => ({
  pluginId,
  tier,
  claim: { slot, priority, heightPx, displayMode },
});

describe("arbitration", () => {
  it("compares the declared tier before any priority", () => {
    const winners = arbitrate([
      contender("countdown", "scheduled", 1_000_000),
      contender("alerts", "emergency", -1_000_000),
      contender("meter", "live", 999_999),
    ]);
    expect(winners.get("strip.bottom")?.pluginId).toBe("alerts");
  });

  it("orders emergency, live, scheduled, ambient", () => {
    const tiers: SurfaceTier[] = ["ambient", "scheduled", "live", "emergency"];
    const sorted = tiers
      .map((tier) => contender(tier, tier, 0))
      .sort(compareContenders)
      .map((item) => item.tier);
    expect(sorted).toEqual(["emergency", "live", "scheduled", "ambient"]);
  });

  it("uses priority within a tier, then the plugin identifier", () => {
    expect(
      arbitrate([
        contender("b", "scheduled", 1),
        contender("a", "scheduled", 2),
      ]).get("strip.bottom")?.pluginId,
    ).toBe("a");
    expect(
      arbitrate([
        contender("b", "scheduled", 3),
        contender("a", "scheduled", 3),
      ]).get("strip.bottom")?.pluginId,
    ).toBe("a");
  });

  it("is independent of input order", () => {
    const items = [
      contender("z", "ambient", 5, "corner.top-left"),
      contender("y", "ambient", 5, "corner.top-left"),
      contender("x", "live", 0),
      contender("w", "live", 0),
    ];
    const forward = arbitrate(items);
    const backward = arbitrate([...items].reverse());
    for (const slot of ["corner.top-left", "strip.bottom"] as const) {
      expect(forward.get(slot)?.pluginId).toBe(backward.get(slot)?.pluginId);
    }
    expect(forward.get("corner.top-left")?.pluginId).toBe("y");
    expect(forward.get("strip.bottom")?.pluginId).toBe("w");
  });

  it("arbitrates each slot on its own", () => {
    const winners = arbitrate([
      contender("alerts", "emergency", 0, "strip.bottom"),
      contender("marks", "ambient", 0, "corner.top-left"),
      contender("countdown", "scheduled", 0, "overlay"),
    ]);
    expect([...winners.values()].map((item) => item.pluginId).sort()).toEqual([
      "alerts",
      "countdown",
      "marks",
    ]);
  });
});

describe("geometry", () => {
  it("insets the stage only for pushing strips and lifts corners for any strip", () => {
    const layout = geometry(
      arbitrate([
        contender("top", "live", 0, "strip.top", 40, "push"),
        contender("bottom", "live", 0, "strip.bottom", 96, "overlay"),
      ]),
    );
    expect(layout).toEqual({
      topInsetPx: 40,
      bottomInsetPx: 0,
      topLiftPx: 40,
      bottomLiftPx: 96,
      stripHeights: { "strip.top": 40, "strip.bottom": 96 },
    });
  });

  it("is empty without strips", () => {
    expect(geometry(new Map())).toEqual({
      topInsetPx: 0,
      bottomInsetPx: 0,
      topLiftPx: 0,
      bottomLiftPx: 0,
      stripHeights: {},
    });
  });
});
