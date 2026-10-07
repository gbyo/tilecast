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
 * Independent facts decide whether this Host may report playback. They change
 * for different reasons and must never be folded into one flag:
 *
 * - `serverBindingConfirmed`: since the last discontinuity, the server
 *   accepted this browser's session for its own installation and binding.
 * - `localActivationAuthorized`: the committed activation on disk belongs to
 *   this server, slot and binding and every resource was revalidated.
 * - `runtimeActivationAccepted`: the Runtime accepted the activation the Host
 *   most recently sent.
 * - `foregroundEligible`: derived from `visible` and `frozen`.
 * - `selectionCurrent`: this activation was reconciled with the server's
 *   authoritative selection after the last discontinuity.
 *
 * Two more describe the browser rather than the server:
 *
 * - `clockAnchored`: no wall-clock or monotonic-clock discontinuity (sleep, a
 *   clock correction) has been seen since the last reconciliation. While it is
 *   false the Host measures no playback, because durations across the gap are
 *   not trustworthy.
 * - `recovering`: the browser discarded this page and the Host has not yet
 *   reconciled since it came back.
 * - `resting`: the screen is outside active hours with nothing outranking
 *   rest. The Runtime shows the rest surface, so nothing is playing.
 */
export interface HostState {
  serverBindingConfirmed: boolean;
  selectionCurrent: boolean;
  localActivationAuthorized: boolean;
  runtimeActivationAccepted: boolean;
  visible: boolean;
  frozen: boolean;
  clockAnchored: boolean;
  recovering: boolean;
  resting: boolean;
}

export function initialHostState(
  visible: boolean,
  wasDiscarded = false,
): HostState {
  return {
    serverBindingConfirmed: false,
    selectionCurrent: false,
    localActivationAuthorized: false,
    runtimeActivationAccepted: false,
    visible,
    frozen: false,
    clockAnchored: true,
    recovering: wasDiscarded,
    resting: false,
  };
}

export function foregroundEligible(
  state: Pick<HostState, "visible" | "frozen">,
): boolean {
  return state.visible && !state.frozen;
}

/** The generic `foregroundState` a Browser Player reports. */
export type ForegroundState =
  "foreground" | "background" | "frozen" | "recovering";

export function foregroundStateOf(
  state: Pick<HostState, "visible" | "frozen" | "recovering">,
): ForegroundState {
  if (state.frozen) return "frozen";
  if (!state.visible) return "background";
  return state.recovering ? "recovering" : "foreground";
}

/**
 * Whether what the viewer is shown can be counted as played: the page is in
 * the foreground, the activation is one this Host verified, the Runtime
 * accepted it, and no clock discontinuity is waiting to be re-anchored. It
 * does not need the server. Such a play is recorded as it happens and held
 * until the server relationship is confirmed again.
 */
export function proofEligible(state: HostState): boolean {
  return (
    foregroundEligible(state) &&
    state.localActivationAuthorized &&
    state.runtimeActivationAccepted &&
    state.clockAnchored &&
    !state.resting
  );
}

/** Offline playback is allowed; offline healthy reporting is not. */
export function meaningfulEvidence(state: HostState): boolean {
  return (
    proofEligible(state) &&
    state.serverBindingConfirmed &&
    state.selectionCurrent
  );
}

/** A local activation may be shown whether or not the server is reachable. */
export function mayShowLocalActivation(state: HostState): boolean {
  return state.localActivationAuthorized;
}

/** A frozen page or a lost connection requires fresh server contact. */
export function requireReconfirmation(state: HostState): void {
  state.serverBindingConfirmed = false;
  state.selectionCurrent = false;
}

/**
 * Sleep or a clock correction also invalidates the timing anchor. Nothing is
 * measured, and nothing is healthy, until the Host reconciles and anchors a
 * fresh server offset.
 */
export function markClockDiscontinuity(state: HostState): void {
  requireReconfirmation(state);
  state.clockAnchored = false;
}

/** The Host reconciled with the server selection and anchored its offset. */
export function markReconciled(state: HostState): void {
  state.selectionCurrent = true;
  state.clockAnchored = true;
  state.recovering = false;
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
