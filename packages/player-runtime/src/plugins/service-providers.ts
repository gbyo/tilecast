/**
 * The Shared Runtime's Player services. Each provider is narrow and binds
 * one plugin at a time; disposing the binding releases timers, listeners,
 * claims, and containers. Nothing here knows a plugin by identity.
 */
import type { SurfaceSlot } from "@tilecast/plugin-sdk/runtime";
import type {
  PlayerClockService,
  PlayerMediaRef,
  PlayerMediaService,
  PlayerSurfaceGrant,
  PlayerSurfaceHandle,
  PlayerSurfaceService,
  PresentationObservation,
  PresentationObserveService,
} from "@tilecast/plugin-sdk/player";
import { TimerGroup, type RuntimeClock } from "../clock/scheduler";
import type {
  SurfaceContributionBinding,
  SurfaceContributionSpec,
} from "./host";
import type { PlayerServiceProvider } from "./services";

/** `player.clock@1`: corrected time and plugin-owned timers. */
export function clockService(options: {
  clock: RuntimeClock;
  clockOffsetMs(): number;
}): PlayerServiceProvider<PlayerClockService> {
  const { clock } = options;
  return {
    name: "player.clock",
    version: 1,
    bind(context) {
      const timers = new TimerGroup(clock);
      const guarded = (callback: () => void) => () => context.guard(callback);
      return {
        api: {
          now: () => clock.wallNow() + options.clockOffsetMs(),
          localNow: () => clock.wallNow(),
          monotonicNow: () => clock.monotonicNow(),
          after: (delayMs, callback) =>
            timers.after(Math.max(0, delayMs), guarded(callback)),
          every: (intervalMs, callback) =>
            timers.every(Math.max(1, intervalMs), guarded(callback)),
        },
        dispose: () => timers.cancelAll(),
      };
    },
  };
}

/**
 * `player.media@1`: only media that one of the plugin's current state
 * entries declares, and only through the host's own grant.
 */
export function mediaService(options: {
  resolve(assetId: string, variantId: string): string;
}): PlayerServiceProvider<PlayerMediaService> {
  return {
    name: "player.media",
    version: 1,
    bind(context) {
      const declared = (ref: PlayerMediaRef) =>
        context
          .entries()
          .some((entry) =>
            entry.media.some(
              (media) =>
                media.assetId === ref.assetId &&
                media.variantId === ref.variantId,
            ),
          );
      return {
        api: {
          url(ref) {
            if (!ref || !declared(ref)) return null;
            try {
              return options.resolve(ref.assetId, ref.variantId);
            } catch {
              return null;
            }
          },
        },
        dispose: () => undefined,
      };
    },
  };
}

const sameObservation = (
  left: PresentationObservation,
  right: PresentationObservation,
) =>
  left.mode === right.mode &&
  left.item?.id === right.item?.id &&
  left.item?.kind === right.item?.kind &&
  left.item?.occurrence === right.item?.occurrence &&
  left.item?.audible === right.item?.audible;

/**
 * The source of `player.presentation.observe@1`. The engine publishes; each
 * plugin binding reads and subscribes. Observation is read-only: there is no
 * way back from a plugin to playback.
 */
export class PresentationObserver {
  private value: PresentationObservation = { mode: "waiting", item: null };
  private readonly listeners = new Set<
    (value: PresentationObservation) => void
  >();

  current(): PresentationObservation {
    return this.value;
  }

  publish(next: PresentationObservation): void {
    if (sameObservation(this.value, next)) return;
    this.value = Object.freeze({
      mode: next.mode,
      item: next.item ? Object.freeze({ ...next.item }) : null,
    });
    for (const listener of [...this.listeners]) listener(this.value);
  }

  listen(listener: (value: PresentationObservation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  provider(): PlayerServiceProvider<PresentationObserveService> {
    return {
      name: "player.presentation.observe",
      version: 1,
      bind: (context) => {
        const unsubscribers = new Set<() => void>();
        return {
          api: {
            current: () => this.value,
            subscribe: (listener) => {
              const unsubscribe = this.listen((value) =>
                context.guard(() => listener(value)),
              );
              unsubscribers.add(unsubscribe);
              return () => {
                unsubscribe();
                unsubscribers.delete(unsubscribe);
              };
            },
          },
          dispose: () => {
            for (const unsubscribe of unsubscribers) unsubscribe();
            unsubscribers.clear();
          },
        };
      },
    };
  }
}

/** The part of the surface host that `player.surface@1` needs. */
export interface SurfaceArbiter {
  attachContribution(
    spec: SurfaceContributionSpec,
    render: (grant: PlayerSurfaceGrant) => void,
    report: (message: string) => void,
    describe?: (slot: SurfaceSlot) => string,
  ): SurfaceContributionBinding | null;
}

/**
 * `player.surface@1`: declared visual contributions in the same
 * arbitration, geometry, and persistent containers as every other surface.
 */
export function surfaceService(options: {
  surfaces: SurfaceArbiter;
  reducedMotion(): boolean;
  animationScale: number;
}): PlayerServiceProvider<PlayerSurfaceService> {
  return {
    name: "player.surface",
    version: 1,
    bind(context) {
      const open = new Map<string, SurfaceContributionBinding>();
      return {
        api: {
          open(contributionId, render, describe) {
            const declared = context.declaration.surfaces.find(
              (surface) => surface.id === contributionId,
            );
            if (!declared) {
              context.report(`surface ${contributionId} is not declared`);
              return null;
            }
            if (open.has(contributionId)) return null;
            const binding = options.surfaces.attachContribution(
              {
                owner: context.pluginId,
                contribution: contributionId,
                tier: declared.tier,
                slots: declared.slots,
              },
              (grant) => context.guard(() => render(grant)),
              (message) =>
                context.report(`surface ${contributionId}: ${message}`),
              describe,
            );
            if (!binding) return null;
            open.set(contributionId, binding);
            const handle: PlayerSurfaceHandle = {
              container: (slot) => binding.container(slot),
              claim: (claims) => binding.claim(claims),
              release: () => binding.release(),
              close: () => {
                binding.close();
                open.delete(contributionId);
              },
            };
            return handle;
          },
          reducedMotion: () => options.reducedMotion(),
          animationScale: options.animationScale,
        },
        dispose: () => {
          for (const binding of open.values()) binding.close();
          open.clear();
        },
      };
    },
  };
}
