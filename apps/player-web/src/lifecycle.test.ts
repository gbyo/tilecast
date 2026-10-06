import { describe, expect, it } from "vitest";
import {
  clockDiscontinuity,
  initialHostState,
  mayShowLocalActivation,
  meaningfulEvidence,
  requireReconfirmation,
  revokeLocalAuthority,
  type HostState,
} from "./lifecycle";

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

  it("suppresses evidence unless every independent fact holds", () => {
    const valid: HostState = {
      ...initialHostState(true),
      serverBindingConfirmed: true,
      selectionCurrent: true,
      localActivationAuthorized: true,
      runtimeActivationAccepted: true,
    };
    expect(meaningfulEvidence(valid)).toBe(true);
    for (const key of [
      "visible",
      "serverBindingConfirmed",
      "selectionCurrent",
      "localActivationAuthorized",
      "runtimeActivationAccepted",
    ] as const) {
      expect(meaningfulEvidence({ ...valid, [key]: false })).toBe(false);
    }
    expect(meaningfulEvidence({ ...valid, frozen: true })).toBe(false);
  });

  it("keeps showing a local activation while the server is unconfirmed", () => {
    const state: HostState = {
      ...initialHostState(true),
      localActivationAuthorized: true,
      runtimeActivationAccepted: true,
    };
    expect(mayShowLocalActivation(state)).toBe(true);
    expect(meaningfulEvidence(state)).toBe(false);
    state.serverBindingConfirmed = true;
    state.selectionCurrent = true;
    expect(meaningfulEvidence(state)).toBe(true);
    requireReconfirmation(state);
    expect(mayShowLocalActivation(state)).toBe(true);
    expect(meaningfulEvidence(state)).toBe(false);
  });

  it("stops trusting local content when the server withdraws the binding", () => {
    const state: HostState = {
      ...initialHostState(true),
      serverBindingConfirmed: true,
      selectionCurrent: true,
      localActivationAuthorized: true,
      runtimeActivationAccepted: true,
    };
    revokeLocalAuthority(state);
    expect(mayShowLocalActivation(state)).toBe(false);
    expect(meaningfulEvidence(state)).toBe(false);
  });
});
