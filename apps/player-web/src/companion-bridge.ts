import {
  COMPANION_PLAYER_PATH,
  COMPANION_PROTOCOL,
  COMPANION_SOURCE,
  parseCompanionMessage,
  type CompanionCapabilities,
  type CompanionMessage,
} from "@tilecast/companion-protocol";
import type {
  BrowserCapabilityProvider,
  CapabilityProviderRegistry,
  TypedCapabilityResult,
} from "./capability-providers";

/** A Browser Player identifies itself exactly once, on handshake. */
const PLAYER_IDENTITY = "tilecast-browser-player";

/** Invoke round-trip budget before the provider answers failure. */
const INVOKE_TIMEOUT_MS = 10_000;

interface Pending {
  resolve: (result: TypedCapabilityResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The Browser Player side of the Companion bridge. Listens for the
 * content bridge's hello on a top-level /player/* page, negotiates
 * protocol 1, and exposes the Companion as one capability provider.
 * Everything is validated: same-window sender, same origin, top-level
 * frame, player path, protocol version, connection identity, message
 * shape, and payload bounds. Without a Companion the bridge stays
 * silent and normal playback is untouched; when the Companion
 * disconnects (or a permission is revoked and its messages stop
 * validating) the provider is removed and its capabilities disappear
 * on the next heartbeat.
 */
export class CompanionBridge {
  private connection: string | undefined;
  private described: CompanionCapabilities = {};
  private pending = new Map<string, Pending>();
  private counter = 0;
  private readonly provider: BrowserCapabilityProvider;
  private registered = false;

  constructor(
    private readonly registry: CapabilityProviderRegistry,
    private readonly hostVersion: string,
    private readonly postMessage: (
      message: CompanionMessage,
      origin: string,
    ) => void = (message, origin) => window.postMessage(message, origin),
  ) {
    this.provider = {
      id: "companion",
      describe: () => ({ ...this.described }),
      invoke: (operation, input) => this.invoke(operation, input),
    };
  }

  get connected(): boolean {
    return this.connection !== undefined;
  }

  /** Starts listening. Safe to call once per page. */
  attach(): void {
    window.addEventListener("message", (event: MessageEvent) => {
      this.onMessage(event);
    });
  }

  private eligible(event: MessageEvent): boolean {
    return (
      event.source === window &&
      event.origin === window.location.origin &&
      window === window.top &&
      window.location.pathname.startsWith(COMPANION_PLAYER_PATH)
    );
  }

  private onMessage(event: MessageEvent): void {
    if (!this.eligible(event)) return;
    const parsed = parseCompanionMessage(event.data);
    if (!parsed || parsed.protocol !== COMPANION_PROTOCOL) return;
    if (parsed.kind === "companion-hello") {
      if (this.connection !== undefined) return;
      this.connection = parsed.connectionId;
      this.postMessage(
        {
          source: COMPANION_SOURCE,
          kind: "companion-handshake",
          protocol: COMPANION_PROTOCOL,
          connectionId: parsed.connectionId,
          player: PLAYER_IDENTITY,
          hostVersion: this.hostVersion.slice(0, 128),
        },
        window.location.origin,
      );
      return;
    }
    if (parsed.connectionId !== this.connection) return;
    switch (parsed.kind) {
      case "companion-described":
        // Described answers update the provider whether or not they
        // match a refresh: the handshake answer carries the first set
        // unsolicited.
        this.described = parsed.capabilities;
        if (!this.registered) {
          this.registry.add(this.provider);
          this.registered = true;
        }
        break;
      case "companion-result":
        this.resolveInvoke(parsed);
        break;
      case "companion-bye":
        this.disconnect();
        break;
      default:
        break;
    }
  }

  private nextId(): string {
    this.counter += 1;
    return `page-${this.counter}`;
  }

  /** Asks the Companion for its current set; the provider updates on answer. */
  refresh(): void {
    if (this.connection === undefined) return;
    this.postMessage(
      {
        source: COMPANION_SOURCE,
        kind: "companion-describe",
        protocol: COMPANION_PROTOCOL,
        connectionId: this.connection,
        id: this.nextId(),
      },
      window.location.origin,
    );
  }

  private invoke(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<TypedCapabilityResult> {
    if (this.connection === undefined) {
      return Promise.resolve({
        success: false,
        code: "companion_disconnected",
        message: "The Companion is not connected.",
      });
    }
    const id = this.nextId();
    return new Promise<TypedCapabilityResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          success: false,
          code: "companion_timeout",
          message: "The Companion did not answer in time.",
        });
      }, INVOKE_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      this.postMessage(
        {
          source: COMPANION_SOURCE,
          kind: "companion-invoke",
          protocol: COMPANION_PROTOCOL,
          connectionId: this.connection as string,
          id,
          operation,
          input,
        },
        window.location.origin,
      );
    });
  }

  private resolveInvoke(
    parsed: Extract<CompanionMessage, { kind: "companion-result" }>,
  ): void {
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    clearTimeout(pending.timer);
    pending.resolve({
      success: parsed.result.success,
      code: parsed.result.code,
      ...(parsed.result.message !== undefined
        ? { message: parsed.result.message }
        : {}),
    });
  }

  /** Drops the connection: pending invokes fail, the provider leaves. */
  disconnect(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        success: false,
        code: "companion_disconnected",
        message: "The Companion disconnected.",
      });
    }
    this.pending.clear();
    this.connection = undefined;
    this.described = {};
    if (this.registered) {
      this.registry.remove("companion");
      this.registered = false;
    }
  }
}
