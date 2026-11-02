import { DurableObject } from "cloudflare:workers";
import { CloseCode, SLOT_LIFETIME_MS } from "./protocol";

export type DeliveryResult = "delivered" | "stored" | "occupied" | "closed";

// One instance holds one rendezvous slot. A slot opens on first use, accepts
// one envelope, hands it to the waiting Player once, and is deleted when it
// expires. The Player socket hibernates while it waits. Players keep it open
// with WebSocket ping frames, which the runtime answers without waking the
// object and which are not billed.
export class Rendezvous extends DurableObject<Env> {
  // Only the Worker calls this, with a WebSocket upgrade from the Player.
  async fetch(): Promise<Response> {
    if (await this.isClosed()) return new Response(null, { status: 410 });

    for (const previous of this.ctx.getWebSockets()) {
      previous.close(CloseCode.replaced, "Replaced by a newer connection.");
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    const envelope = await this.ctx.storage.get<string>("envelope");
    if (envelope !== undefined) {
      server.send(envelope);
      server.close(CloseCode.delivered, "Delivered.");
      await this.markDelivered();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async deliver(envelope: string): Promise<DeliveryResult> {
    if (await this.isClosed()) return "closed";
    if ((await this.ctx.storage.get("envelope")) !== undefined) {
      return "occupied";
    }

    const [player] = this.ctx.getWebSockets();
    if (player === undefined) {
      await this.ctx.storage.put("envelope", envelope);
      return "stored";
    }
    player.send(envelope);
    player.close(CloseCode.delivered, "Delivered.");
    await this.markDelivered();
    return "delivered";
  }

  async alarm(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      socket.close(CloseCode.expired, "Expired.");
    }
    await this.ctx.storage.deleteAll();
  }

  // Players send no data messages; keepalive uses ping frames.
  webSocketMessage(socket: WebSocket): void {
    socket.close(CloseCode.unexpectedMessage, "Unexpected message.");
  }

  private async isClosed(): Promise<boolean> {
    const expiresAt = await this.ctx.storage.get<number>("expiresAt");
    if (expiresAt === undefined) {
      const at = Date.now() + SLOT_LIFETIME_MS;
      await this.ctx.storage.put("expiresAt", at);
      await this.ctx.storage.setAlarm(at);
      return false;
    }
    if (Date.now() >= expiresAt) return true;
    return (await this.ctx.storage.get("delivered")) === true;
  }

  // The slot stays until it expires so a second delivery is refused rather
  // than stored where no Player will read it.
  private async markDelivered(): Promise<void> {
    await this.ctx.storage.delete("envelope");
    await this.ctx.storage.put("delivered", true);
  }
}
