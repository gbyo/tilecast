import { describe, expect, it } from "vitest";
import {
  clockDiscontinuity,
  foregroundStateOf,
  initialHostState,
  markClockDiscontinuity,
  markReconciled,
  mayShowLocalActivation,
  meaningfulEvidence,
  proofEligible,
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

  it("keeps proof local to the browser and separate from the server", () => {
    const state: HostState = {
      ...initialHostState(true),
      localActivationAuthorized: true,
      runtimeActivationAccepted: true,
    };
    // Offline: a play is real and is recorded, but it is not yet confirmed.
    expect(proofEligible(state)).toBe(true);
    expect(meaningfulEvidence(state)).toBe(false);
    state.visible = false;
    expect(proofEligible(state)).toBe(false);
    state.visible = true;
    state.frozen = true;
    expect(proofEligible(state)).toBe(false);
  });

  it("measures nothing across a clock discontinuity until it is re-anchored", () => {
    const state: HostState = {
      ...initialHostState(true),
      serverBindingConfirmed: true,
      selectionCurrent: true,
      localActivationAuthorized: true,
      runtimeActivationAccepted: true,
    };
    markClockDiscontinuity(state);
    // Playback may continue, but it is neither proof nor healthy.
    expect(mayShowLocalActivation(state)).toBe(true);
    expect(proofEligible(state)).toBe(false);
    expect(meaningfulEvidence(state)).toBe(false);
    // Reconnecting alone does not restore it. Reconciling does.
    state.serverBindingConfirmed = true;
    expect(meaningfulEvidence(state)).toBe(false);
    markReconciled(state);
    expect(proofEligible(state)).toBe(true);
    expect(meaningfulEvidence(state)).toBe(true);
  });

  it("does not treat a network outage as a clock discontinuity", () => {
    const state: HostState = {
      ...initialHostState(true),
      serverBindingConfirmed: true,
      selectionCurrent: true,
      localActivationAuthorized: true,
      runtimeActivationAccepted: true,
    };
    requireReconfirmation(state);
    expect(state.clockAnchored).toBe(true);
    expect(proofEligible(state)).toBe(true);
  });

  it("counts nothing while the screen rests outside active hours", () => {
    const state: HostState = {
      ...initialHostState(true),
      serverBindingConfirmed: true,
      selectionCurrent: true,
      localActivationAuthorized: true,
      runtimeActivationAccepted: true,
    };
    expect(meaningfulEvidence(state)).toBe(true);
    state.resting = true;
    expect(proofEligible(state)).toBe(false);
    expect(meaningfulEvidence(state)).toBe(false);
    // The activation is still the verified one, ready for the morning.
    expect(mayShowLocalActivation(state)).toBe(true);
  });

  it("names the page's foreground state", () => {
    const state = initialHostState(true, true);
    expect(foregroundStateOf(state)).toBe("recovering");
    markReconciled(state);
    expect(foregroundStateOf(state)).toBe("foreground");
    state.visible = false;
    expect(foregroundStateOf(state)).toBe("background");
    state.frozen = true;
    expect(foregroundStateOf(state)).toBe("frozen");
  });
});
