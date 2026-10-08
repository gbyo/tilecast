/**
 * Authenticated player WebSocket (protocol version 1).
 *
 * The server sends `server.ping` every 30 seconds; a healthy player answers
 * `player.pong`. TCP alone cannot detect a half-open connection — a dead
 * peer with buffered writes looks "open" forever while delivering nothing —
 * so this client runs its own liveness watchdog: if no message of any kind
 * arrives within 95 seconds (three missed server pings) the socket is
 * terminated and the reconnect path takes over, which immediately reconciles
 * the manifest, config, and commands. Content updates therefore cannot be
 * stranded behind a silently dead socket.
 */

import WebSocket from "ws";
import { logger } from "./log";
import type { DisconnectReason } from "./telemetry";
import type { Heartbeat, SocketEnvelope } from "./types";

const log = logger("socket");

export const PROTOCOL_VERSION = 1;
/** Three missed 30-second server pings ⇒ the peer is gone. */
const LIVENESS_TIMEOUT_MS = 95_000;

/**
 * Turns the close reason into one of the categories telemetry reports. The
 * text itself stays in this player's log: an operator needs to know which class
 * of failure it was, and a fleet-wide table is the wrong place for an error
 * string that can contain an address.
 */
export function classifyDisconnectReason(
  reason: string,
  policyViolation: boolean,
  closedLocally: boolean,
): DisconnectReason {
  // A revoked credential or a disabled screen is the one case the server tells
  // us outright, and it is not a network fault.
  if (policyViolation) return "credential_rejected";
  if (closedLocally) return "client_closed";
  const text = reason.toLowerCase();
  if (text.includes("liveness") || text.includes("etimedout")) return "timeout";
  if (
    text.includes("certificate") ||
    text.includes("tls") ||
    text.includes("ssl") ||
    text.includes("self-signed")
  ) {
    return "tls_failure";
  }
  if (
    text.includes("enetunreach") ||
    text.includes("enetdown") ||
    text.includes("ehostunreach")
  ) {
    return "network_lost";
  }
  if (
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("econnrefused") ||
    text.includes("econnreset")
  ) {
    return "server_unreachable";
  }
  if (text.startsWith("close ")) return "server_closed";
  return "unknown";
}

export interface SocketEvents {
  onOpen(): void;
  /**
   * Fired exactly once per connection, after open. `category` is the same fact
   * as `reason`, reduced to something safe to report.
   */
  onClose(
    reason: string,
    policyViolation: boolean,
    category: DisconnectReason,
  ): void;
  onManifestChanged(manifestVersion: number): void;
  onConfigChanged(configRevision: number): void;
  onCommandsAvailable(): void;
  onPreviewSessionChanged(): void;
  onLiveStreamSessionChanged(): void;
}

export class PlayerSocket {
  private ws: WebSocket | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private closeReported = false;

  constructor(
    private readonly socketUrl: string,
    private readonly credential: string,
    private readonly playerVersion: string,
    private readonly events: SocketEvents,
  ) {}

  connect(): void {
    const ws = new WebSocket(this.socketUrl, {
      headers: { Authorization: `Bearer ${this.credential}` },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on("open", () => {
      this.send({
        type: "player.hello",
        protocolVersion: PROTOCOL_VERSION,
        playerVersion: this.playerVersion,
      });
      this.armLiveness();
      this.events.onOpen();
    });

    ws.on("message", (data) => {
      this.armLiveness();
      let message: SocketEnvelope;
      try {
        message = JSON.parse(data.toString()) as SocketEnvelope;
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    ws.on("close", (code, reasonBuf) => {
      this.reportClose(
        `close ${code} ${reasonBuf.toString()}`,
        code === 1008, // StatusPolicyViolation: revoked or disabled
      );
    });

    ws.on("error", (err) => {
      this.reportClose(`error ${String(err)}`, false);
    });
  }

  private handleMessage(message: SocketEnvelope): void {
    switch (message.type) {
      case "server.hello":
        log.info("socket established", {
          screenName: message["screenName"],
        });
        break;
      case "server.ping":
        this.send({ type: "player.pong", timestamp: new Date().toISOString() });
        break;
      case "manifest.changed": {
        const version = Number(message["manifestVersion"]);
        if (Number.isFinite(version)) {
          this.events.onManifestChanged(version);
        }
        break;
      }
      case "config.changed": {
        const revision = Number(message["configRevision"]);
        if (Number.isFinite(revision)) {
          this.events.onConfigChanged(revision);
        }
        break;
      }
      case "commands.available":
        this.events.onCommandsAvailable();
        break;
      case "preview.session_changed":
        this.events.onPreviewSessionChanged();
        break;
      case "live_stream.session_changed":
        this.events.onLiveStreamSessionChanged();
        break;
      default:
        log.debug("ignoring unknown socket message", { type: message.type });
    }
  }

  /** Push the current status over the socket as `player.status`. */
  sendStatus(heartbeat: Heartbeat): boolean {
    return this.send({
      type: "player.status",
      protocolVersion: PROTOCOL_VERSION,
      playerVersion: this.playerVersion,
      payload: heartbeat,
    });
  }

  sendLiveStreamFrame(
    sessionId: string,
    capturedAtMs: number,
    width: number,
    height: number,
    jpeg: Buffer,
  ): boolean {
    return this.sendBinary(
      encodeLiveStreamFrame(sessionId, capturedAtMs, width, height, jpeg),
    );
  }

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    this.disarmLiveness();
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        // already gone
      }
    }
  }

  private send(message: SocketEnvelope): boolean {
    if (!this.isOpen) {
      return false;
    }
    try {
      this.ws!.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private sendBinary(message: Buffer): boolean {
    if (!this.isOpen) return false;
    try {
      this.ws!.send(message, { binary: true });
      return true;
    } catch {
      return false;
    }
  }

  private armLiveness(): void {
    this.disarmLiveness();
    if (this.closed) {
      return;
    }
    this.livenessTimer = setTimeout(() => {
      log.warn("socket silent past liveness window; terminating", {
        timeoutMs: LIVENESS_TIMEOUT_MS,
      });
      try {
        this.ws?.terminate();
      } catch {
        // fall through to close event
      }
      // terminate() emits 'close'; report defensively in case it does not.
      this.reportClose("liveness timeout", false);
    }, LIVENESS_TIMEOUT_MS);
  }

  private disarmLiveness(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  private reportClose(reason: string, policyViolation: boolean): void {
    this.disarmLiveness();
    if (this.closeReported) {
      return;
    }
    this.closeReported = true;
    this.events.onClose(
      reason,
      policyViolation,
      classifyDisconnectReason(reason, policyViolation, this.closed),
    );
  }
}

export function encodeLiveStreamFrame(
  sessionId: string,
  capturedAtMs: number,
  width: number,
  height: number,
  jpeg: Buffer,
): Buffer {
  const id = Buffer.from(sessionId.replaceAll("-", ""), "hex");
  if (id.length !== 16) throw new Error("invalid live stream session id");
  const header = Buffer.alloc(33);
  header.write("TCLS", 0, "ascii");
  header.writeUInt8(1, 4);
  id.copy(header, 5);
  header.writeBigInt64BE(BigInt(Math.trunc(capturedAtMs)), 21);
  header.writeUInt16BE(width, 29);
  header.writeUInt16BE(height, 31);
  return Buffer.concat([header, jpeg]);
}
