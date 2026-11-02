import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { slotName } from "../src/protocol";

const ORIGIN = "https://relay.test";

const envelope = {
  v: 1,
  epk: `B${"A".repeat(86)}`,
  iv: "A".repeat(16),
  ct: "C".repeat(40),
};

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function put(id: string | null, body: string, ip = "198.51.100.1") {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": ip,
  };
  if (id !== null) headers.Authorization = `Rendezvous ${id}`;
  return exports.default.fetch(`${ORIGIN}/v1/rendezvous`, {
    method: "PUT",
    headers,
    body,
  });
}

interface PlayerSocket {
  socket: WebSocket;
  messages: string[];
  closed: Promise<{ code: number; reason: string }>;
}

async function connect(id: string): Promise<PlayerSocket> {
  const response = await exports.default.fetch(`${ORIGIN}/v1/rendezvous`, {
    headers: { Upgrade: "websocket", Authorization: `Rendezvous ${id}` },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("no WebSocket in response");
  const messages: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    );
  });
  socket.addEventListener("message", (event) => {
    messages.push(String(event.data));
  });
  socket.accept();
  return { socket, messages, closed };
}

async function stub(id: string) {
  return env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(await slotName(id)));
}

describe("routing", () => {
  it("reports health", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: "ok" } });
  });

  it("returns a JSON error for an unknown path", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/other`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("answers the CORS preflight", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/rendezvous`, {
      method: "OPTIONS",
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
  });

  it("refuses other methods", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/rendezvous`, {
      method: "DELETE",
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, PUT, OPTIONS");
  });

  it("requires a WebSocket upgrade for the Player", async () => {
    const response = await exports.default.fetch(`${ORIGIN}/v1/rendezvous`, {
      headers: { Authorization: `Rendezvous ${newId()}` },
    });
    expect(response.status).toBe(426);
  });
});

describe("delivery validation", () => {
  it("requires the setup code in the Authorization header", async () => {
    const response = await put(null, JSON.stringify(envelope));
    expect(response.status).toBe(401);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("rejects a malformed setup code", async () => {
    const response = await put("short", JSON.stringify(envelope));
    expect(response.status).toBe(401);
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["an unknown field", JSON.stringify({ ...envelope, extra: 1 })],
    ["a missing field", JSON.stringify({ ...envelope, ct: undefined })],
    ["another version", JSON.stringify({ ...envelope, v: 2 })],
    ["a compressed key", JSON.stringify({ ...envelope, epk: "A".repeat(44) })],
    ["a short nonce", JSON.stringify({ ...envelope, iv: "A".repeat(15) })],
    ["padding", JSON.stringify({ ...envelope, ct: `${"C".repeat(38)}==` })],
  ])("rejects %s", async (_, body) => {
    const response = await put(newId(), body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_envelope" },
    });
  });

  it("rejects an envelope larger than the limit", async () => {
    const response = await put(newId(), "x".repeat(2049));
    expect(response.status).toBe(413);
  });
});

describe("rendezvous", () => {
  it("holds an envelope until the Player connects", async () => {
    const id = newId();
    const stored = await put(id, JSON.stringify(envelope));
    expect(stored.status).toBe(202);
    expect(await stored.json()).toEqual({ data: { delivered: false } });

    const player = await connect(id);
    expect(await player.closed).toEqual({ code: 1000, reason: "Delivered." });
    expect(player.messages.map((message) => JSON.parse(message))).toEqual([
      envelope,
    ]);
  });

  it("sends an envelope to a Player that is already waiting", async () => {
    const id = newId();
    const player = await connect(id);

    const response = await put(id, JSON.stringify(envelope));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { delivered: true } });
    expect((await player.closed).code).toBe(1000);
    expect(player.messages).toEqual([JSON.stringify(envelope)]);
  });

  it("refuses a second envelope while one is waiting", async () => {
    const id = newId();
    expect((await put(id, JSON.stringify(envelope))).status).toBe(202);
    const second = await put(id, JSON.stringify(envelope));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: { code: "rendezvous_occupied" },
    });
  });

  it("closes the slot after delivery", async () => {
    const id = newId();
    await put(id, JSON.stringify(envelope));
    await (
      await connect(id)
    ).closed;

    const again = await put(id, JSON.stringify(envelope));
    expect(again.status).toBe(410);
    const reconnect = await exports.default.fetch(`${ORIGIN}/v1/rendezvous`, {
      headers: { Upgrade: "websocket", Authorization: `Rendezvous ${id}` },
    });
    expect(reconnect.status).toBe(410);
    expect(await reconnect.json()).toMatchObject({
      error: { code: "rendezvous_closed" },
    });
  });

  it("replaces an older Player connection", async () => {
    const id = newId();
    const first = await connect(id);
    const second = await connect(id);
    expect((await first.closed).code).toBe(4409);

    await put(id, JSON.stringify(envelope));
    expect((await second.closed).code).toBe(1000);
    expect(second.messages).toHaveLength(1);
  });

  it("closes a Player that sends a data message", async () => {
    const player = await connect(newId());
    player.socket.send("ping");
    expect((await player.closed).code).toBe(1003);
  });

  it("closes the Player socket and forgets the slot when it expires", async () => {
    const id = newId();
    const player = await connect(id);
    expect(await runDurableObjectAlarm(await stub(id))).toBe(true);
    expect(await player.closed).toEqual({ code: 4408, reason: "Expired." });
  });

  it("refuses a slot whose time has passed before the alarm runs", async () => {
    const id = newId();
    const slot = await stub(id);
    await put(id, JSON.stringify(envelope));
    await runInSlot(slot, (storage) =>
      storage.put("expiresAt", Date.now() - 1),
    );
    expect((await put(id, JSON.stringify(envelope))).status).toBe(410);
  });
});

describe("rate limiting", () => {
  it("limits deliveries from one address", async () => {
    const ip = "203.0.113.9";
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      statuses.push((await put(newId(), "{}", ip)).status);
    }
    expect(statuses).toContain(429);
  });
});

async function runInSlot(
  slot: DurableObjectStub,
  action: (storage: DurableObjectStorage) => Promise<void>,
) {
  await runInDurableObject(slot, (_, state) => action(state.storage));
}
