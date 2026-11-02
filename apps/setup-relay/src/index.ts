import {
  MAX_ENVELOPE_BYTES,
  parseEnvelope,
  rendezvousId,
  slotName,
} from "./protocol";
import { Rendezvous } from "./rendezvous";

export { Rendezvous };

const RENDEZVOUS_PATH = "/v1/rendezvous";

// Studio sends the envelope from whatever origin the installation uses. No
// cookies are involved, so any origin may call it.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PUT",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
};

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz" && request.method === "GET") {
      return json(200, { data: { status: "ok" } });
    }
    if (pathname !== RENDEZVOUS_PATH) {
      return error(404, "not_found", "No route matches this request.");
    }

    switch (request.method) {
      case "OPTIONS":
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      case "GET":
        return connect(request, env);
      case "PUT":
        return withCors(await deliver(request, env));
      default:
        return error(405, "method_not_allowed", "Use GET or PUT.", {
          Allow: "GET, PUT, OPTIONS",
        });
    }
  },
} satisfies ExportedHandler<Env>;

async function connect(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return error(426, "upgrade_required", "Open a WebSocket connection.");
  }
  const id = rendezvousId(request.headers.get("Authorization"));
  if (id === null) return invalidRendezvous();
  if (!(await allowed(env.CONNECT_LIMITER, request))) return rateLimited();

  const response = await slot(env, await slotName(id)).fetch(request);
  if (response.status === 410) return rendezvousClosed();
  return response;
}

async function deliver(request: Request, env: Env): Promise<Response> {
  const id = rendezvousId(request.headers.get("Authorization"));
  if (id === null) return invalidRendezvous();
  if (!(await allowed(env.DELIVER_LIMITER, request))) return rateLimited();

  const text = await readCapped(request, MAX_ENVELOPE_BYTES);
  if (text === null) {
    return error(413, "envelope_too_large", "The envelope is too large.");
  }
  const envelope = parseEnvelope(text);
  if (envelope === null) {
    return error(400, "invalid_envelope", "The envelope is not valid.");
  }

  const result = await slot(env, await slotName(id)).deliver(
    JSON.stringify(envelope),
  );
  switch (result) {
    case "delivered":
      return json(202, { data: { delivered: true } });
    case "stored":
      return json(202, { data: { delivered: false } });
    case "occupied":
      return error(
        409,
        "rendezvous_occupied",
        "This setup code already has an envelope.",
      );
    case "closed":
      return rendezvousClosed();
  }
}

function slot(env: Env, name: string): DurableObjectStub<Rendezvous> {
  return env.RENDEZVOUS.get(env.RENDEZVOUS.idFromName(name));
}

async function allowed(limiter: RateLimit, request: Request) {
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  return (await limiter.limit({ key })).success;
}

// Returns null when the body is larger than the limit. A missing or false
// Content-Length cannot make the Worker read more than the limit.
async function readCapped(
  request: Request,
  limit: number,
): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > limit) return null;
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function invalidRendezvous(): Response {
  return error(
    401,
    "invalid_rendezvous",
    "Send the setup code in the Authorization header.",
  );
}

function rendezvousClosed(): Response {
  return error(
    410,
    "rendezvous_closed",
    "This setup code has expired or was already used.",
  );
}

function rateLimited(): Response {
  return error(429, "rate_limited", "Too many requests. Try again later.", {
    "Retry-After": "60",
  });
}

function withCors(response: Response): Response {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function error(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { error: { code, message } }, headers);
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
