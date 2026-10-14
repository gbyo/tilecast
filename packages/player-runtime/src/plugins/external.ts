import type { SurfaceGrant, SurfaceSlot } from "@tilecast/plugin-sdk/runtime";
import type {
  ExternalRuntimePluginV1,
  PluginFrameBindingV1,
} from "../host/contract";
import { validateClaims, type ValidClaim, TIER_ORDER } from "./claims";

export const PLUGIN_SURFACE_PROTOCOL = "tilecast.plugin.surface/1";
const SLOTS: readonly string[] = [
  "strip.top",
  "strip.bottom",
  "corner.top-left",
  "corner.top-right",
  "corner.bottom-left",
  "corner.bottom-right",
  "overlay",
];
const HEX = /^[a-f0-9]{64}$/;
const PACKAGE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** Bound the clone before serialization, including depth and collection size. */
export function boundedPluginJSON(value: unknown, maxBytes: number): boolean {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (++nodes > 2048 || depth > 16) return false;
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || seen.has(item)) return false;
    seen.add(item);
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    const entries = Object.entries(item);
    if (entries.length > 2048) return false;
    return entries.every(([, child]) => visit(child, depth + 1));
  }
  try {
    return (
      visit(value, 0) &&
      new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes
    );
  } catch {
    return false;
  }
}

export function parseExternalEntry(
  value: unknown,
  now: number,
): ExternalRuntimePluginV1 | null {
  if (
    !boundedPluginJSON(value, 32 * 1024) ||
    !value ||
    typeof value !== "object"
  )
    return null;
  const entry = value as ExternalRuntimePluginV1;
  const pkg = entry.package;
  if (
    entry.type !== "external_plugin" ||
    entry.version !== 1 ||
    !Number.isInteger(entry.definitionVersion) ||
    entry.definitionVersion < 1 ||
    entry.definitionVersion > 1_000_000 ||
    !pkg ||
    typeof pkg.packageId !== "string" ||
    pkg.packageId.length > 128 ||
    !PACKAGE.test(pkg.packageId) ||
    !/^sha256:[a-f0-9]{64}$/.test(pkg.packageDigest) ||
    typeof entry.id !== "string" ||
    entry.id.length > 128 ||
    pkg.contributionId !== entry.id ||
    !entry.id.startsWith(`${pkg.packageId}.`) ||
    !/^[a-z][a-z0-9_]{0,79}$/.test(entry.id.slice(pkg.packageId.length + 1)) ||
    !pkg.frame ||
    !HEX.test(pkg.frame.sha256) ||
    !Number.isInteger(pkg.frame.fileSize) ||
    pkg.frame.fileSize < 1 ||
    pkg.frame.fileSize > 1_114_112 ||
    !entry.runtime ||
    !TIER_ORDER.includes(entry.runtime.tier) ||
    !Array.isArray(entry.runtime.surfaces) ||
    entry.runtime.surfaces.length < 1 ||
    entry.runtime.surfaces.length > 7 ||
    new Set(entry.runtime.surfaces).size !== entry.runtime.surfaces.length ||
    !entry.runtime.surfaces.every((slot) => SLOTS.includes(slot)) ||
    !entry.state ||
    typeof entry.state !== "object" ||
    Array.isArray(entry.state) ||
    !boundedPluginJSON(entry.state, 16 * 1024)
  )
    return null;
  const deadline = Date.parse(entry.validUntil);
  if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 300_000)
    return null;
  return entry;
}

export function pluginFrameURI(
  entry: ExternalRuntimePluginV1,
  frames: readonly PluginFrameBindingV1[],
): string | null {
  const matching = frames.filter(
    (frame) =>
      frame.packageId === entry.package.packageId &&
      frame.packageDigest.replace(/^sha256:/, "") ===
        entry.package.packageDigest.slice(7) &&
      frame.frameDigest === entry.package.frame.sha256,
  );
  if (matching.length !== 1) return null;
  const uri = matching[0]?.uri;
  if (typeof uri !== "string" || uri.length > 2048) return null;
  try {
    const url = new URL(uri);
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !["http:", "https:", "tcwidget:"].includes(url.protocol)
    )
      return null;
    return uri;
  } catch {
    return null;
  }
}

export interface ExternalSurfaceContext {
  wallClockOffsetMs: number;
  reducedMotion: boolean;
  theme: "dark";
  locale: "en";
  awake: boolean;
  validUntil: string;
}
export interface ExternalSurfaceOptions {
  document: Document;
  wallNow(): number;
  monotonicNow(): number;
  changed(): void;
  diagnostic(message: string): void;
  createChannel?(): MessageChannel;
}

/** One stable opaque document; surface changes never reparent its iframe. */
export class ExternalSurface {
  readonly container: HTMLElement;
  readonly frame: HTMLIFrameElement;
  private readonly token: string;
  private readonly nonce: string;
  private readonly view: Window;
  private port: MessagePort | null = null;
  private revision = 1;
  private stopped = false;
  private loads = 0;
  private claim: ValidClaim | null = null;
  private context: ExternalSurfaceContext;
  private fingerprint = "";
  private grantFingerprint = "";
  private budget = 24;
  private budgetAt: number;
  private readonly createdAt: number;

  constructor(
    public entry: ExternalRuntimePluginV1,
    readonly uri: string,
    private readonly options: ExternalSurfaceOptions,
  ) {
    const view = options.document.defaultView;
    if (!view) throw new Error("frame window is unavailable");
    this.view = view;
    const random = () =>
      [...view.crypto.getRandomValues(new Uint8Array(16))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    this.token = random();
    this.nonce = random();
    this.context = {
      wallClockOffsetMs: 0,
      reducedMotion: true,
      theme: "dark",
      locale: "en",
      awake: false,
      validUntil: entry.validUntil,
    };
    this.budgetAt = this.createdAt = options.monotonicNow();
    this.container = options.document.createElement("div");
    this.container.className = "tc-surface tc-external-surface";
    this.container.dataset["plugin"] = entry.id;
    this.container.style.visibility = "hidden";
    this.container.style.zIndex = String(
      29 - TIER_ORDER.indexOf(entry.runtime.tier),
    );
    this.frame = options.document.createElement("iframe");
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.setAttribute("referrerpolicy", "no-referrer");
    this.frame.setAttribute(
      "allow",
      "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
    );
    this.frame.tabIndex = -1;
    this.frame.title = "";
    this.frame.addEventListener("load", this.loaded);
    this.view.addEventListener("message", this.hello);
    this.frame.src = `${uri}#${this.token}`;
    this.container.appendChild(this.frame);
  }

  update(
    entry: ExternalRuntimePluginV1,
    context: ExternalSurfaceContext,
  ): void {
    if (this.stopped) return;
    this.entry = entry;
    this.context = context;
    const fingerprint = JSON.stringify([
      entry.state,
      entry.definitionVersion,
      context,
    ]);
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    // Every new input invalidates a delayed claim from the preceding input.
    this.claim = null;
    if (this.port) {
      this.revision++;
      this.send("state", { state: entry.state, context });
    }
  }

  claims(): ValidClaim[] {
    if (
      !this.port &&
      !this.stopped &&
      this.options.monotonicNow() - this.createdAt > 5000
    )
      this.fail("frame attach timed out");
    if (
      this.stopped ||
      !this.context.awake ||
      Date.parse(this.entry.validUntil) <=
        this.options.wallNow() + this.context.wallClockOffsetMs
    )
      return [];
    return this.claim ? [this.claim] : [];
  }

  render(grant: SurfaceGrant): void {
    const slot = this.claim?.slot;
    const shown =
      !this.stopped &&
      !!slot &&
      grant.shown.has(slot) &&
      this.claims().length > 0;
    this.container.style.visibility = shown ? "visible" : "hidden";
    if (slot) {
      this.container.dataset["slot"] = slot;
      this.container.dataset["kind"] = slot.startsWith("corner.")
        ? "corner"
        : slot.startsWith("strip.")
          ? "strip"
          : "overlay";
      this.container.style.setProperty(
        "--tc-strip-height",
        `${this.claim?.heightPx ?? 0}px`,
      );
    }
    const value = {
      shown,
      slot: shown ? slot : null,
      topLiftPx: grant.topLiftPx,
      bottomLiftPx: grant.bottomLiftPx,
    };
    const fingerprint = JSON.stringify([this.revision, value]);
    if (this.port && fingerprint !== this.grantFingerprint) {
      this.grantFingerprint = fingerprint;
      this.send("grant", { value });
    }
  }

  dispose(): void {
    if (this.stopped) return;
    if (this.port) this.send("dispose", {});
    this.stopped = true;
    this.claim = null;
    this.container.style.visibility = "hidden";
    this.view.removeEventListener("message", this.hello);
    this.frame.removeEventListener("load", this.loaded);
    if (this.port) {
      this.port.onmessage = null;
      this.port.onmessageerror = null;
      this.port.close();
      this.port = null;
    }
    this.container.remove();
  }

  private readonly loaded = () => {
    if (++this.loads > 1) this.fail("frame navigated after its initial load");
  };
  private readonly hello = (event: MessageEvent) => {
    if (
      this.stopped ||
      event.source !== this.frame.contentWindow ||
      event.origin !== "null" ||
      !boundedPluginJSON(event.data, 512)
    )
      return;
    const message = event.data as Record<string, unknown>;
    if (
      message.protocol !== PLUGIN_SURFACE_PROTOCOL ||
      message.kind !== "frame-hello" ||
      message.helloToken !== this.token
    )
      return;
    if (this.port) {
      this.fail("frame announced another document");
      return;
    }
    try {
      const channel = this.options.createChannel?.() ?? new MessageChannel();
      this.port = channel.port1;
      this.port.onmessage = this.receive;
      this.port.onmessageerror = () =>
        this.fail("frame sent an unreadable message");
      this.port.start();
      this.frame.contentWindow?.postMessage(
        {
          protocol: PLUGIN_SURFACE_PROTOCOL,
          kind: "init",
          helloToken: this.token,
          nonce: this.nonce,
          revision: this.revision,
          state: this.entry.state,
          context: this.context,
        },
        "*",
        [channel.port2],
      );
      this.view.removeEventListener("message", this.hello);
    } catch {
      this.fail("frame channel could not attach");
    }
  };
  private readonly receive = (event: MessageEvent) => {
    if (this.stopped) return;
    const now = this.options.monotonicNow();
    this.budget = Math.min(
      24,
      this.budget + Math.max(0, now - this.budgetAt) * 0.012,
    );
    this.budgetAt = now;
    if (--this.budget < 0) {
      this.fail("frame exceeded its message rate");
      return;
    }
    if (!boundedPluginJSON(event.data, 32 * 1024)) {
      this.fail("frame message exceeds its bound");
      return;
    }
    const message = event.data as Record<string, unknown> | null;
    if (
      !message ||
      message.protocol !== PLUGIN_SURFACE_PROTOCOL ||
      message.nonce !== this.nonce ||
      message.revision !== this.revision ||
      message.kind !== "claim"
    )
      return;
    const check = validateClaims(
      this.entry.runtime.surfaces,
      message.value === null ? [] : [message.value],
    );
    this.claim = check.claims[0] ?? null;
    for (const problem of check.problems) this.options.diagnostic(problem);
    this.options.changed();
  };
  private send(kind: string, payload: Record<string, unknown>): void {
    try {
      this.port?.postMessage({
        protocol: PLUGIN_SURFACE_PROTOCOL,
        nonce: this.nonce,
        revision: this.revision,
        kind,
        ...payload,
      });
    } catch {
      this.fail("frame channel delivery failed");
    }
  }
  private fail(message: string): void {
    this.options.diagnostic(message);
    this.dispose();
    this.options.changed();
  }
}
