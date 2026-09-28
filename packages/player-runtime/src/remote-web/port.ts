/**
 * The runtime's side of a `host-view` remote web host: surface identifiers,
 * event dispatch, the bounded warm pool, and recovery after the host's
 * remote web process ended (a screen-wide fact no single surface sees).
 */
import type {
  RemoteWebCreateResultV1,
  RemoteWebEventV1,
  RemoteWebRenderTargetV1,
  RemoteWebSurfaceSpecV1,
  RemoteWebViewportV1,
  TilecastRuntimeHostV1,
} from "../host/contract";
import type { RuntimeClock, TimerHandle } from "../clock/scheduler";

type HostRemoteWeb = NonNullable<TilecastRuntimeHostV1["remoteWeb"]>;

export const MAX_WARM_SURFACES = 2;

/** What a live host surface has already told the runtime. */
export interface HostSurfaceState {
  surfaceId: string;
  target: RemoteWebRenderTargetV1 | null;
  loaded: boolean;
  streamReady: boolean;
  failed: string | null;
}

export type RemoteWebListener = (event: RemoteWebEventV1) => void;

interface WarmEntry {
  key: string;
  state: HostSurfaceState;
  expiry: TimerHandle;
}

export class RemoteWebPort {
  private next = 1;
  private readonly listeners = new Map<string, RemoteWebListener>();
  private readonly states = new Map<string, HostSurfaceState>();
  private readonly warm: WarmEntry[] = [];
  /** The host's remote web process ended since the last successful load. */
  private awaitingRecovery = false;

  constructor(
    private readonly host: HostRemoteWeb,
    private readonly clock: RuntimeClock,
  ) {}

  /** Host → runtime. Events for unknown surfaces (disposed) are dropped. */
  receive(event: RemoteWebEventV1): void {
    if (event.surfaceId === null) {
      if (event.kind === "process-terminated") {
        this.awaitingRecovery = true;
        for (const entry of this.warm.splice(0)) entry.expiry.cancel();
        for (const [id, listener] of [...this.listeners]) {
          const state = this.states.get(id);
          if (state) state.failed = "helper_terminated";
          listener({
            surfaceId: id,
            kind: "failed",
            code: "helper_terminated",
          });
        }
      }
      return;
    }
    const state = this.states.get(event.surfaceId);
    if (!state) return;
    if (event.kind === "loaded") state.loaded = true;
    if (event.kind === "stream-ready") state.streamReady = true;
    if (
      event.kind === "failed" ||
      event.kind === "navigation-blocked" ||
      event.kind === "process-terminated"
    ) {
      state.failed = event.code ?? event.kind;
      this.dropWarm(event.surfaceId);
    }
    this.listeners.get(event.surfaceId)?.(event);
  }

  /** True once after a load that follows the host's process ending. */
  takeRecovery(): boolean {
    const recovered = this.awaitingRecovery;
    this.awaitingRecovery = false;
    return recovered;
  }

  /** A warm surface with the same content, if one is waiting. */
  adopt(key: string, listener: RemoteWebListener): HostSurfaceState | null {
    const index = this.warm.findIndex((entry) => entry.key === key);
    if (index < 0) return null;
    const [entry] = this.warm.splice(index, 1);
    entry!.expiry.cancel();
    this.listeners.set(entry!.state.surfaceId, listener);
    return entry!.state;
  }

  async create(
    spec: Omit<RemoteWebSurfaceSpecV1, "surfaceId">,
    listener: RemoteWebListener,
  ): Promise<{ state: HostSurfaceState; result: RemoteWebCreateResultV1 }> {
    const surfaceId = `rw-${this.next++}`;
    const state: HostSurfaceState = {
      surfaceId,
      target: null,
      loaded: false,
      streamReady: false,
      failed: null,
    };
    this.states.set(surfaceId, state);
    this.listeners.set(surfaceId, listener);
    let result: RemoteWebCreateResultV1;
    try {
      result = await this.host.create!({ ...spec, surfaceId });
    } catch {
      result = { ok: false, code: "unavailable" };
    }
    if (result.ok) state.target = result.target;
    else this.forget(surfaceId);
    return { state, result };
  }

  updateViewport(surfaceId: string, viewport: RemoteWebViewportV1): void {
    if (this.states.has(surfaceId))
      this.host.updateViewport!(surfaceId, viewport);
  }

  setVisible(surfaceId: string, visible: boolean): void {
    if (this.states.has(surfaceId)) this.host.setVisible!(surfaceId, visible);
  }

  setMuted(surfaceId: string, muted: boolean): void {
    if (this.states.has(surfaceId)) this.host.setMuted!(surfaceId, muted);
  }

  reload(surfaceId: string): void {
    if (this.states.has(surfaceId)) this.host.reload!(surfaceId);
  }

  /**
   * The surface is done with its host surface. A `keep_warm` surface that
   * loaded stays alive, muted and hidden, for at most `warmMs`, and at most
   * MAX_WARM_SURFACES at a time; anything else is destroyed now.
   */
  release(
    surfaceId: string,
    warm: { key: string; warmMs: number } | null,
  ): void {
    const state = this.states.get(surfaceId);
    if (!state) return;
    this.listeners.delete(surfaceId);
    this.host.setMuted!(surfaceId, true);
    this.host.setVisible!(surfaceId, false);
    if (warm && warm.warmMs > 0 && state.loaded && !state.failed) {
      while (this.warm.length >= MAX_WARM_SURFACES) {
        const oldest = this.warm.shift()!;
        oldest.expiry.cancel();
        this.destroy(oldest.state.surfaceId);
      }
      const expiry = this.clock.at(
        this.clock.monotonicNow() + warm.warmMs,
        () => this.dropWarm(surfaceId),
      );
      this.warm.push({ key: warm.key, state, expiry });
      return;
    }
    this.destroy(surfaceId);
  }

  /** Live and warm host surfaces, for diagnostics and tests. */
  describe(): { live: number; warm: number } {
    return { live: this.states.size, warm: this.warm.length };
  }

  private dropWarm(surfaceId: string): void {
    const index = this.warm.findIndex((e) => e.state.surfaceId === surfaceId);
    if (index < 0) return;
    const [entry] = this.warm.splice(index, 1);
    entry!.expiry.cancel();
    this.destroy(surfaceId);
  }

  private destroy(surfaceId: string): void {
    if (!this.states.has(surfaceId)) return;
    this.host.destroy!(surfaceId);
    this.forget(surfaceId);
  }

  private forget(surfaceId: string): void {
    this.states.delete(surfaceId);
    this.listeners.delete(surfaceId);
  }
}
