/**
 * A Player plugin driver for a plugin's own tests. Time moves only when a
 * test advances it, services are small fakes with the real contracts, and
 * the test decides every surface grant, so a plugin's tests can run its
 * lifecycle without the Player runtime.
 */
import type {
  AnyPlayerPluginDefinition,
  PlayerPluginInstance,
  PlayerServiceId,
  PlayerStateEntry,
  PlayerSurfaceClaim,
  PresentationObservation,
} from "./player.ts";
import type { SurfaceGrant, SurfaceSlot } from "./runtime.ts";
import { createTestRuntime, grant as surfaceGrant } from "./runtime-testing.ts";

/** A visual contribution, as the manifest's `player.runtime.surfaces` declares it. */
export interface TestSurface {
  id: string;
  slots: readonly SurfaceSlot[];
}

export interface TestPlayerOptions {
  /** Corrected (server) wall time, Unix milliseconds. */
  now?: number;
  clockOffsetMs?: number;
  animationScale?: number;
  reducedMotion?: boolean;
  /** Visual contributions the manifest declares. */
  surfaces?: readonly TestSurface[];
  /** Services this test Player offers. Default: every service requested. */
  services?: readonly PlayerServiceId[];
}

interface OpenSurface {
  containers: Map<SurfaceSlot, HTMLElement>;
  claims: PlayerSurfaceClaim[];
  render(grant: SurfaceGrant): void;
  describe?: (slot: SurfaceSlot) => string;
}

export interface TestPlayer {
  /** Deliver the plugin's complete current state, as the host does. */
  setState(entries: readonly PlayerStateEntry[]): void;
  setAwake(awake: boolean): void;
  /** Move both clocks forward, firing due timers in order. */
  advance(milliseconds: number): void;
  /** Publish a presentation observation to subscribers. */
  present(observation: PresentationObservation): void;
  /** The last claims of an open surface contribution. */
  claims(contribution: string): PlayerSurfaceClaim[];
  /** Grant slots to a contribution and let it render. */
  grant(
    contribution: string,
    shown: readonly SurfaceSlot[],
    lift?: { topLiftPx?: number; bottomLiftPx?: number },
  ): void;
  container(contribution: string, slot: SurfaceSlot): HTMLElement;
  describe(contribution: string, slot: SurfaceSlot): string;
  /** True while the plugin is activated. */
  readonly active: boolean;
  /** Times the plugin was disposed. */
  readonly disposals: number;
  readonly pendingTimers: number;
}

export function createTestPlayer(
  definition: AnyPlayerPluginDefinition,
  options: TestPlayerOptions = {},
): TestPlayer {
  const runtime = createTestRuntime(options);
  const requested = [
    ...definition.services.required,
    ...definition.services.optional,
  ];
  const offered = new Set(options.services ?? requested);
  const surfaces = new Map<string, OpenSurface>();
  const listeners = new Set<(value: PresentationObservation) => void>();
  let observation: PresentationObservation = { mode: "waiting", item: null };
  let entries: readonly PlayerStateEntry[] = [];
  let instance: PlayerPluginInstance | null = null;
  let disposals = 0;
  let awake = true;

  // Timers belong to the plugin and end with it, as in the Player host.
  const timers = new Set<{ cancel(): void }>();
  const own = (handle: { cancel(): void }) => {
    timers.add(handle);
    return handle;
  };
  const implementations: Record<PlayerServiceId, () => unknown> = {
    "player.clock@1": () => ({
      now: () => runtime.context.clock.now(),
      localNow: () => runtime.context.clock.localNow(),
      monotonicNow: () => runtime.context.clock.monotonicNow(),
      after: (delay: number, callback: () => void) =>
        own(runtime.context.clock.after(delay, callback)),
      every: (interval: number, callback: () => void) =>
        own(runtime.context.clock.every(interval, callback)),
    }),
    "player.media@1": () => ({
      url: (ref: { assetId: string; variantId: string }) =>
        entries.some((entry) =>
          entry.media.some(
            (media) =>
              media.assetId === ref.assetId &&
              media.variantId === ref.variantId,
          ),
        )
          ? `tcmedia://variant/${ref.assetId}/${ref.variantId}`
          : null,
    }),
    "player.presentation.observe@1": () => ({
      current: () => observation,
      subscribe: (listener: (value: PresentationObservation) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    "player.surface@1": () => ({
      open(
        id: string,
        render: (grant: SurfaceGrant) => void,
        describe?: (slot: SurfaceSlot) => string,
      ) {
        const declared = options.surfaces?.find((surface) => surface.id === id);
        if (!declared || surfaces.has(id)) return null;
        const open: OpenSurface = {
          containers: new Map(
            declared.slots.map((slot) => [slot, document.createElement("div")]),
          ),
          claims: [],
          render,
          ...(describe ? { describe } : {}),
        };
        surfaces.set(id, open);
        return {
          container: (slot: SurfaceSlot) => {
            const container = open.containers.get(slot);
            if (!container) throw new Error(`${id} does not declare ${slot}`);
            return container;
          },
          claim: (claims: readonly PlayerSurfaceClaim[]) =>
            void (open.claims = [...claims]),
          release: () => void (open.claims = []),
          close: () => void surfaces.delete(id),
        };
      },
      reducedMotion: () => runtime.context.reducedMotion(),
      animationScale: runtime.context.animationScale,
    }),
  };

  const activate = () => {
    if (!definition.services.required.every((id) => offered.has(id))) return;
    const services: Record<string, unknown> = {};
    for (const id of requested) {
      services[id] = offered.has(id) ? implementations[id]() : null;
    }
    instance =
      definition.activate({
        pluginId: definition.id,
        services: services as never,
        awake: () => awake,
      }) ?? {};
  };

  const deactivate = () => {
    if (!instance) return;
    instance.dispose?.();
    instance = null;
    disposals += 1;
    for (const timer of timers) timer.cancel();
    timers.clear();
    surfaces.clear();
    listeners.clear();
  };

  const open = (contribution: string) => {
    const surface = surfaces.get(contribution);
    if (!surface) throw new Error(`surface ${contribution} is not open`);
    return surface;
  };

  return {
    setState(next) {
      entries = next;
      if (next.length === 0) return deactivate();
      if (!instance) activate();
      instance?.stateChanged?.(next);
    },
    setAwake(value) {
      awake = value;
      runtime.setAwake(value);
      instance?.awakeChanged?.(value);
    },
    advance: (milliseconds) => runtime.advance(milliseconds),
    present(value) {
      observation = value;
      for (const listener of [...listeners]) listener(value);
    },
    claims: (contribution) => [...open(contribution).claims],
    grant(contribution, shown, lift = {}) {
      open(contribution).render(surfaceGrant(shown, lift));
    },
    container(contribution, slot) {
      const container = open(contribution).containers.get(slot);
      if (!container)
        throw new Error(`${contribution} does not declare ${slot}`);
      return container;
    },
    describe(contribution, slot) {
      const surface = open(contribution);
      return (
        surface.describe?.(slot) ??
        (surface.containers.get(slot)?.textContent ?? "").trim()
      );
    },
    get active() {
      return instance !== null;
    },
    get disposals() {
      return disposals;
    },
    get pendingTimers() {
      return runtime.pendingTimers;
    },
  };
}
