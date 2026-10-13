/**
 * The runtime surface host: the generic half of every Player plugin surface.
 *
 * It owns everything around a plugin's drawing: one long-lived container per
 * declared surface, one coalescing evaluation scheduler, claim validation,
 * arbitration by declared tier then priority then identifier, the geometry
 * of the content stage and the corners, the corrected clock, per-plugin
 * timers, reduced motion, sleep and wake, and disposal. It never looks at a
 * plugin's identity to decide what to draw. A plugin that throws or returns
 * malformed claims loses its slots with a diagnostic; playback continues.
 *
 * This channel never touches playback: a strip can appear, change, and go
 * while the same media element or Layout stays mounted.
 */
import type {
  RuntimeManifestEntry,
  RuntimePluginContext,
  RuntimePluginInstance,
  SurfaceGrant,
  SurfaceSlot,
  SurfaceTier,
} from "@tilecast/plugin-sdk/runtime";
import {
  TimerGroup,
  type RuntimeClock,
  type TimerHandle,
} from "../clock/scheduler";
import {
  arbitrate,
  geometry,
  isStripSlot,
  TIER_ORDER,
  validateClaims,
  type Contender,
  type SurfaceGeometry,
  type ValidClaim,
} from "./claims";
import type { DiscoveredRuntimePlugin } from "./discovery";
import type {
  ExternalRuntimePluginV1,
  PluginFrameBindingV1,
  RuntimePluginV1,
} from "../host/contract";
import {
  ExternalSurface,
  parseExternalEntry,
  pluginFrameURI,
} from "./external";

/** How often the host evaluates when nothing else asks it to. */
export const SURFACE_TICK_MS = 1_000;

/** Containers are created in this order, which is also paint order. */
const SLOT_ORDER: readonly SurfaceSlot[] = [
  "strip.top",
  "strip.bottom",
  "corner.top-left",
  "corner.top-right",
  "corner.bottom-left",
  "corner.bottom-right",
  "overlay",
];

const MAX_DIAGNOSTICS = 100;

/**
 * Passes that may follow one another because plugins invalidated during
 * evaluation. Beyond this, the plugins that keep asking wait for the next
 * tick, so one plugin cannot keep the renderer busy.
 */
const MAX_CHAINED_PASSES = 4;

export interface SurfaceHostOptions {
  clock: RuntimeClock;
  plugins: readonly DiscoveredRuntimePlugin[];
  /** 0 freezes motion at a deterministic frame (conformance snapshots). */
  animationScale: number;
  reducedMotion(): boolean;
  mediaUrl(assetId: string, variantId: string): string;
  /** The content stage. Only the host changes its geometry. */
  stage(): HTMLElement | null;
  diagnostic(pluginId: string, message: string): void;
  document?: Document;
  externalPluginFrames?: boolean;
  /** Test seam; production uses the browser's private MessageChannel. */
  createPluginChannel?(): MessageChannel;
}

interface Hosted {
  id: string;
  tier: SurfaceTier;
  surfaces: readonly SurfaceSlot[];
  types: ReadonlySet<string>;
  instance: RuntimePluginInstance | null;
  timers: TimerGroup;
  containers: Map<SurfaceSlot, HTMLElement>;
  claims: ValidClaim[];
}

export interface SurfaceHostDescription {
  /** The plugin holding each slot and the text it shows there. */
  surfaces: Partial<Record<SurfaceSlot, { plugin: string; text: string }>>;
  /** Content-stage insets from pushing strips, in CSS pixels. */
  insets: { top: number; bottom: number };
  diagnostics: string[];
}

const describeText = (node: Element | null) =>
  (node?.textContent ?? "").replace(/\s+/g, " ").trim();

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class RuntimeSurfaceHost {
  /** The host-owned layer that holds every surface container. */
  readonly element: HTMLElement;

  private readonly hosted: Hosted[] = [];
  private readonly external = new Map<string, ExternalSurface>();
  private readonly timers: TimerGroup;
  private entries: readonly RuntimeManifestEntry[] = [];
  private clockOffsetMs = 0;
  private awake = true;
  private tick: TimerHandle | null = null;
  private externalDeadline: TimerHandle | null = null;
  private scheduled: TimerHandle | null = null;
  private evaluating = false;
  private again = false;
  private readonly againBy = new Set<string>();
  private chained = 0;
  private stopped = false;
  private winners = new Map<SurfaceSlot, Contender>();
  private layout: SurfaceGeometry = geometry(new Map());
  private readonly diagnostics: string[] = [];

  constructor(private readonly options: SurfaceHostOptions) {
    const doc = options.document ?? document;
    this.timers = new TimerGroup(options.clock);
    this.element = doc.createElement("div");
    this.element.id = "plugin-surfaces";
    this.element.className = "tc-surfaces";

    for (const discovered of options.plugins) {
      const { definition } = discovered;
      const hosted: Hosted = {
        id: definition.id,
        tier: definition.tier,
        surfaces: definition.surfaces,
        types: new Set(definition.manifestTypes),
        instance: null,
        timers: new TimerGroup(options.clock),
        containers: new Map(),
        claims: [],
      };
      try {
        hosted.instance = definition.create(this.context(hosted));
      } catch (error) {
        this.report(hosted.id, `create failed: ${errorText(error)}`);
      }
      this.hosted.push(hosted);
    }

    // Weaker tiers first, so a stronger tier paints above them when two
    // containers of one slot are both animating.
    const paintOrder = [...this.hosted].sort(
      (left, right) =>
        TIER_ORDER.indexOf(right.tier) - TIER_ORDER.indexOf(left.tier) ||
        (left.id < right.id ? -1 : 1),
    );
    for (const slot of SLOT_ORDER) {
      for (const hosted of paintOrder) {
        if (!hosted.surfaces.includes(slot)) continue;
        const container = doc.createElement("div");
        const kind = isStripSlot(slot)
          ? "strip"
          : slot === "overlay"
            ? "overlay"
            : "corner";
        container.className = `tc-surface tc-surface--${kind} tc-surface--${slot.replace(".", "-")}`;
        container.dataset["plugin"] = hosted.id;
        container.dataset["slot"] = slot;
        this.element.appendChild(container);
        hosted.containers.set(slot, container);
        if (!hosted.instance) continue;
        try {
          hosted.instance.mount(slot, container);
        } catch (error) {
          this.report(hosted.id, `mount ${slot} failed: ${errorText(error)}`);
          this.fail(hosted);
        }
      }
    }
  }

  /** The Player manifest's plugin entries changed. Evaluates now. */
  setEntries(
    entries: readonly (RuntimePluginV1 | ExternalRuntimePluginV1)[],
    clockOffsetMs: number,
    frames: readonly PluginFrameBindingV1[] = [],
  ): void {
    if (this.stopped) return;
    this.entries = Array.isArray(entries)
      ? entries.filter(
          (entry): entry is RuntimePluginV1 =>
            entry.type !== "external_plugin" && "config" in entry,
        )
      : [];
    this.clockOffsetMs = Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0;
    this.reconcileExternal(entries, frames);
    this.scheduleExternalDeadline();
    this.tick?.cancel();
    this.tick = this.timers.every(SURFACE_TICK_MS, () =>
      this.requestEvaluation(),
    );
    this.chained = 0;
    this.evaluateNow();
  }

  /** The Player went to sleep (outside active hours) or woke up. */
  setAwake(awake: boolean): void {
    if (this.stopped || awake === this.awake) return;
    this.awake = awake;
    for (const hosted of this.hosted) {
      if (!hosted.instance?.setAwake) continue;
      try {
        hosted.instance.setAwake(awake);
      } catch (error) {
        this.report(hosted.id, `setAwake failed: ${errorText(error)}`);
      }
    }
    this.evaluateNow();
  }

  /**
   * Ask for one evaluation soon. Requests before it runs are coalesced; one
   * made while an evaluation is running schedules exactly one more.
   */
  requestEvaluation(): void {
    this.request(null);
  }

  describe(): SurfaceHostDescription {
    const surfaces: SurfaceHostDescription["surfaces"] = {};
    for (const slot of SLOT_ORDER) {
      const winner = this.winners.get(slot);
      if (!winner) continue;
      const hosted = this.hosted.find((item) => item.id === winner.pluginId);
      let text = "";
      try {
        text =
          hosted?.instance?.describe?.(slot) ??
          describeText(hosted?.containers.get(slot) ?? null);
      } catch (error) {
        this.report(winner.pluginId, `describe failed: ${errorText(error)}`);
      }
      surfaces[slot] = { plugin: winner.pluginId, text };
    }
    return {
      surfaces,
      insets: {
        top: this.layout.topInsetPx,
        bottom: this.layout.bottomInsetPx,
      },
      diagnostics: [...this.diagnostics],
    };
  }

  /** Dispose every plugin and cancel every timer. The page is going away. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.timers.cancelAll();
    for (const surface of this.external.values()) surface.dispose();
    this.external.clear();
    for (const hosted of this.hosted) {
      hosted.timers.cancelAll();
      try {
        hosted.instance?.dispose();
      } catch (error) {
        this.report(hosted.id, `dispose failed: ${errorText(error)}`);
      }
      hosted.instance = null;
    }
  }

  // ------------------------------------------------------------ evaluation

  private request(pluginId: string | null, chained = false): void {
    if (this.stopped) return;
    if (this.evaluating) {
      this.again = true;
      if (pluginId) this.againBy.add(pluginId);
      return;
    }
    if (!chained) this.chained = 0;
    if (this.scheduled) return;
    this.scheduled = this.timers.soon(() => {
      this.scheduled = null;
      this.evaluate();
    });
  }

  private evaluateNow(): void {
    if (this.evaluating) {
      this.again = true;
      return;
    }
    this.scheduled?.cancel();
    this.scheduled = null;
    this.evaluate();
  }

  private evaluate(): void {
    if (this.stopped) return;
    this.evaluating = true;
    this.again = false;
    this.againBy.clear();
    try {
      this.pass();
    } finally {
      this.evaluating = false;
      if (this.again) {
        this.again = false;
        if (this.chained < MAX_CHAINED_PASSES) {
          this.chained += 1;
          this.request(null, true);
        } else {
          for (const id of this.againBy) {
            this.report(
              id,
              "invalidates during every update; waiting for the next tick",
            );
          }
          this.chained = 0;
        }
      }
    }
  }

  private pass(): void {
    const contenders: Contender[] = [];
    for (const surface of this.external.values()) {
      surface.update(surface.entry, {
        wallClockOffsetMs: this.clockOffsetMs,
        reducedMotion:
          this.options.reducedMotion() || this.options.animationScale === 0,
        theme: "dark",
        locale: "en",
        awake: this.awake,
        validUntil: surface.entry.validUntil,
      });
      for (const claim of surface.claims())
        contenders.push({
          pluginId: surface.entry.id,
          tier: surface.entry.runtime.tier,
          claim,
        });
    }
    for (const hosted of this.hosted) {
      hosted.claims = [];
      if (!hosted.instance) continue;
      const entries = this.entries.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          hosted.types.has(entry.type),
      );
      let returned: unknown = [];
      try {
        returned = hosted.instance.update(entries);
      } catch (error) {
        this.report(hosted.id, `update failed: ${errorText(error)}`);
      }
      const check = validateClaims(hosted.surfaces, returned);
      for (const problem of check.problems) this.report(hosted.id, problem);
      hosted.claims = check.claims;
      for (const claim of check.claims) {
        contenders.push({ pluginId: hosted.id, tier: hosted.tier, claim });
      }
    }

    this.winners = arbitrate(contenders);
    this.layout = geometry(this.winners);
    this.applyGeometry(this.layout);
    for (const surface of this.external.values()) {
      const shown = new Set<SurfaceSlot>();
      for (const [slot, winner] of this.winners)
        if (winner.pluginId === surface.entry.id) shown.add(slot);
      surface.render({
        shown,
        topLiftPx: this.layout.topLiftPx,
        bottomLiftPx: this.layout.bottomLiftPx,
      });
    }

    for (const hosted of this.hosted) {
      const shown = new Set<SurfaceSlot>();
      for (const [slot, container] of hosted.containers) {
        const granted = this.winners.get(slot)?.pluginId === hosted.id;
        if (granted) shown.add(slot);
        container.classList.toggle("tc-surface--granted", granted);
        // A strip keeps the height its plugin last claimed, so a bar that
        // loses the strip slides away at its own size.
        const own = hosted.claims.find((claim) => claim.slot === slot);
        if (own && isStripSlot(slot)) {
          container.style.setProperty("--tc-strip-height", `${own.heightPx}px`);
        }
      }
      if (!hosted.instance) continue;
      const grant: SurfaceGrant = {
        shown,
        topLiftPx: this.layout.topLiftPx,
        bottomLiftPx: this.layout.bottomLiftPx,
      };
      try {
        hosted.instance.render(grant);
      } catch (error) {
        this.report(hosted.id, `render failed: ${errorText(error)}`);
      }
    }
  }

  private applyGeometry(layout: SurfaceGeometry): void {
    const stage = this.options.stage();
    stage?.style.setProperty("--tc-stage-top", `${layout.topInsetPx}px`);
    stage?.style.setProperty("--tc-stage-bottom", `${layout.bottomInsetPx}px`);
    this.element.style.setProperty(
      "--tc-corner-lift-top",
      `${layout.topLiftPx}px`,
    );
    this.element.style.setProperty(
      "--tc-corner-lift-bottom",
      `${layout.bottomLiftPx}px`,
    );
  }

  // ------------------------------------------------------------ plugins

  private reconcileExternal(
    entries: readonly (RuntimePluginV1 | ExternalRuntimePluginV1)[],
    frames: readonly PluginFrameBindingV1[],
  ): void {
    const wanted = new Map<
      string,
      { entry: ExternalRuntimePluginV1; uri: string }
    >();
    if (
      this.options.externalPluginFrames &&
      Array.isArray(entries) &&
      Array.isArray(frames) &&
      frames.length <= 32
    ) {
      for (const value of entries.slice(0, 64)) {
        if (value.type !== "external_plugin") continue;
        const entry = parseExternalEntry(
          value,
          this.options.clock.wallNow() + this.clockOffsetMs,
        );
        if (!entry) {
          this.report("external", "invalid or expired external plugin entry");
          continue;
        }
        const uri = pluginFrameURI(entry, frames);
        if (
          !uri ||
          wanted.has(entry.id) ||
          this.hosted.some((hosted) => hosted.id === entry.id)
        ) {
          this.report(
            entry.id,
            "external plugin frame grant is missing or ambiguous",
          );
          wanted.delete(entry.id);
          continue;
        }
        if (wanted.size < 32) wanted.set(entry.id, { entry, uri });
      }
    }
    for (const [id, surface] of this.external) {
      const next = wanted.get(id);
      if (
        !next ||
        next.uri !== surface.uri ||
        next.entry.package.packageDigest !==
          surface.entry.package.packageDigest ||
        next.entry.package.frame.sha256 !==
          surface.entry.package.frame.sha256 ||
        JSON.stringify(next.entry.runtime) !==
          JSON.stringify(surface.entry.runtime)
      ) {
        surface.dispose();
        this.external.delete(id);
      }
    }
    for (const [id, { entry, uri }] of wanted) {
      const existing = this.external.get(id);
      if (existing) {
        existing.entry = entry;
        continue;
      }
      try {
        const surface = new ExternalSurface(entry, uri, {
          document: this.options.document ?? document,
          wallNow: () => this.options.clock.wallNow(),
          monotonicNow: () => this.options.clock.monotonicNow(),
          changed: () => this.request(id),
          diagnostic: (message) => this.report(id, message),
          createChannel: this.options.createPluginChannel,
        });
        this.external.set(id, surface);
        this.element.appendChild(surface.container);
      } catch {
        this.report(id, "external plugin frame could not mount");
      }
    }
  }

  private scheduleExternalDeadline(): void {
    this.externalDeadline?.cancel();
    this.externalDeadline = null;
    const now = this.options.clock.wallNow() + this.clockOffsetMs;
    let next = Infinity;
    for (const surface of this.external.values()) {
      const deadline = Date.parse(surface.entry.validUntil);
      if (deadline > now) next = Math.min(next, deadline - now);
    }
    if (Number.isFinite(next))
      this.externalDeadline = this.timers.after(next, () => {
        this.externalDeadline = null;
        this.evaluateNow();
        this.scheduleExternalDeadline();
      });
  }

  private context(hosted: Hosted): RuntimePluginContext {
    const { clock } = this.options;
    const guard = (callback: () => void) => () => {
      try {
        callback();
      } catch (error) {
        this.report(hosted.id, `timer failed: ${errorText(error)}`);
      }
    };
    return {
      clock: {
        now: () => clock.wallNow() + this.clockOffsetMs,
        localNow: () => clock.wallNow(),
        monotonicNow: () => clock.monotonicNow(),
        after: (delayMs, callback) =>
          hosted.timers.after(Math.max(0, delayMs), guard(callback)),
        every: (intervalMs, callback) =>
          hosted.timers.every(Math.max(1, intervalMs), guard(callback)),
      },
      reducedMotion: () => this.options.reducedMotion(),
      animationScale: this.options.animationScale,
      invalidate: () => this.request(hosted.id),
      awake: () => this.awake,
      mediaUrl: (assetId, variantId) =>
        this.options.mediaUrl(assetId, variantId),
    };
  }

  private fail(hosted: Hosted): void {
    hosted.timers.cancelAll();
    try {
      hosted.instance?.dispose();
    } catch {
      // Already reported as failed; nothing more to say.
    }
    hosted.instance = null;
  }

  private report(pluginId: string, message: string): void {
    const line = `${pluginId}: ${message}`;
    if (this.diagnostics.includes(line)) return;
    if (this.diagnostics.length >= MAX_DIAGNOSTICS) this.diagnostics.shift();
    this.diagnostics.push(line);
    this.options.diagnostic(pluginId, message);
  }
}
