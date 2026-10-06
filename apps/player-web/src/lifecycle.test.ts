import { describe, expect, it } from "vitest";
import { clockDiscontinuity, meaningfulEvidence } from "./lifecycle";

describe("browser evidence lifecycle", () => {
  it("requires reconciliation after sleep or wall-clock correction", () => {
    const previous = { wallMs: 100_000, monotonicMs: 1000 };
    expect(
      clockDiscontinuity(previous, { wallMs: 200_000, monotonicMs: 2000 }),
    ).toBe(true);
    expect(
      clockDiscontinuity(previous, { wallMs: 90_000, monotonicMs: 2000 }),
    ).toBe(true);
    expect(
      clockDiscontinuity(previous, { wallMs: 110_000, monotonicMs: 0 }),
    ).toBe(true);
  });

  it("does not infer sleep from an ordinary delayed timer", () => {
    expect(
      clockDiscontinuity(
        { wallMs: 1000, monotonicMs: 0 },
        {
          wallMs: 121_000,
          monotonicMs: 120_000,
        },
      ),
    ).toBe(false);
  });

  it("suppresses evidence from hidden, frozen, unreconciled or replaced players", () => {
    const valid = {
      visible: true,
      frozen: false,
      reconciled: true,
      bindingValid: true,
      activationValid: true,
    };
    expect(meaningfulEvidence(valid)).toBe(true);
    for (const key of [
      "visible",
      "reconciled",
      "bindingValid",
      "activationValid",
    ] as const) {
      expect(meaningfulEvidence({ ...valid, [key]: false })).toBe(false);
    }
    expect(meaningfulEvidence({ ...valid, frozen: true })).toBe(false);
  });
});
