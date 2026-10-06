export interface ClockSample {
  wallMs: number;
  monotonicMs: number;
}

/** Timer lateness alone is not sleep. A clock discontinuity needs a new anchor. */
export function clockDiscontinuity(
  previous: ClockSample,
  current: ClockSample,
): boolean {
  const wallElapsed = current.wallMs - previous.wallMs;
  const monotonicElapsed = current.monotonicMs - previous.monotonicMs;
  return (
    monotonicElapsed < 0 || Math.abs(wallElapsed - monotonicElapsed) > 5_000
  );
}

/**
 * Four independent facts decide whether this Host may report playback. They
 * change for different reasons and must never be folded into one flag:
 *
 * - `serverBindingConfirmed`: since the last discontinuity, the server
 *   accepted this browser's session for its own installation and binding.
 * - `localActivationAuthorized`: the committed activation on disk belongs to
 *   this server, slot and binding and every resource was revalidated.
 * - `runtimeActivationAccepted`: the Runtime accepted the activation the Host
 *   most recently sent.
 * - `foregroundEligible`: derived from `visible` and `frozen`.
 *
 * `selectionCurrent` is the fifth fact: this activation was reconciled with
 * the server's authoritative selection after the last discontinuity.
 */
export interface HostState {
  serverBindingConfirmed: boolean;
  selectionCurrent: boolean;
  localActivationAuthorized: boolean;
  runtimeActivationAccepted: boolean;
  visible: boolean;
  frozen: boolean;
}

export function initialHostState(visible: boolean): HostState {
  return {
    serverBindingConfirmed: false,
    selectionCurrent: false,
    localActivationAuthorized: false,
    runtimeActivationAccepted: false,
    visible,
    frozen: false,
  };
}

export function foregroundEligible(
  state: Pick<HostState, "visible" | "frozen">,
): boolean {
  return state.visible && !state.frozen;
}

/** Offline playback is allowed; offline proof of play is not. */
export function meaningfulEvidence(state: HostState): boolean {
  return (
    foregroundEligible(state) &&
    state.serverBindingConfirmed &&
    state.selectionCurrent &&
    state.localActivationAuthorized &&
    state.runtimeActivationAccepted
  );
}

/** A local activation may be shown whether or not the server is reachable. */
export function mayShowLocalActivation(state: HostState): boolean {
  return state.localActivationAuthorized;
}

/** Sleep, a frozen page or a clock correction require fresh server contact. */
export function requireReconfirmation(state: HostState): void {
  state.serverBindingConfirmed = false;
  state.selectionCurrent = false;
}

/** The server said this binding is revoked, replaced or disabled. */
export function revokeLocalAuthority(state: HostState): void {
  requireReconfirmation(state);
  state.localActivationAuthorized = false;
  state.runtimeActivationAccepted = false;
}

/** The lock is held until the host shuts down; a second tab never starts. */
export async function runExclusive(
  locks: LockManager,
  slot: string,
  run: () => Promise<void>,
  occupied: () => void,
): Promise<void> {
  await locks.request(
    `tilecast-player:${slot}`,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        occupied();
        return;
      }
      await run();
    },
  );
}
