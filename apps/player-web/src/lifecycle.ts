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

export interface EvidenceEnvironment {
  visible: boolean;
  frozen: boolean;
  reconciled: boolean;
  bindingValid: boolean;
  activationValid: boolean;
}

export function meaningfulEvidence(environment: EvidenceEnvironment): boolean {
  return (
    environment.visible &&
    !environment.frozen &&
    environment.reconciled &&
    environment.bindingValid &&
    environment.activationValid
  );
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
