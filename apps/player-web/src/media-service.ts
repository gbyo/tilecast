import type { MediaGrant } from "./storage/activation";
import { mediaResponse } from "./storage/range";

export interface MediaServiceDependencies {
  /** The live owning Host authorizes this client to read local media. */
  authorized(request: Request): Promise<boolean>;
  /** The grant for this URI, only while its activation and binding are active. */
  grant(uri: string): Promise<MediaGrant | undefined>;
  /** The stored bytes for a granted object. Never hashes the whole object. */
  read(grant: MediaGrant): Promise<Blob | undefined>;
}

const notFound = () =>
  new Response(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/**
 * Serves one activation-bound media request. The object was hashed when it
 * was committed or restored; a request authorized against a current grant
 * reads only the bytes it asks for. Frame grants never serve media.
 */
export async function serveLocalMedia(
  request: Request,
  dependencies: MediaServiceDependencies,
): Promise<Response> {
  const uri = new URL(request.url).pathname;
  if (!(await dependencies.authorized(request))) return notFound();
  const grant = await dependencies.grant(uri);
  if (!grant || grant.kind === "frame") return notFound();
  const file = await dependencies.read(grant);
  if (!file) return notFound();
  // Activation replacement and revocation can race with the read.
  const again = await dependencies.grant(uri);
  if (!again || again.kind === "frame") return notFound();
  return mediaResponse(request, file, grant.mimeType);
}

/**
 * The response policy for served sandbox frames. Passive subresources load
 * only from the Player media route on this origin (path-prefixed, so no
 * other same-origin document qualifies) plus data:; everything else the
 * frame could use to exfiltrate is denied. The service worker builds it
 * per origin; the values mirror the Server frame policy.
 */
export function frameResponsePolicy(origin: string): string {
  const media = `${origin}/player/media/`;
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: ${media}`,
    `media-src data: ${media}`,
    `font-src data: ${media}`,
    "connect-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * Serves one activation-bound sandbox frame. Like media, the object was
 * hashed at commit or restore and the grant must still be current after
 * the read; unlike media, the response carries the frame policy and an
 * HTML MIME, media grants never serve this route, and any Range answers
 * 416: a partial frame can never execute, so frames serve whole
 * documents only, on every host.
 */
export async function serveLocalFrame(
  request: Request,
  dependencies: MediaServiceDependencies,
): Promise<Response> {
  const uri = new URL(request.url).pathname;
  if (!(await dependencies.authorized(request))) return notFound();
  const grant = await dependencies.grant(uri);
  if (!grant || grant.kind !== "frame") return notFound();
  const file = await dependencies.read(grant);
  if (!file) return notFound();
  // Activation replacement and revocation can race with the read.
  const again = await dependencies.grant(uri);
  if (!again || again.kind !== "frame") return notFound();
  const headers = new Headers({
    "Accept-Ranges": "none",
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": frameResponsePolicy(new URL(request.url).origin),
    "X-Frame-Options": "SAMEORIGIN",
  });
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD");
    return new Response(null, { status: 405, headers });
  }
  if (request.method === "GET" && request.headers.get("Range") !== null) {
    headers.set("Content-Range", `bytes */${file.size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(request.method === "HEAD" ? null : file, {
    status: 200,
    headers,
  });
}

/** The activation-bound sandbox-frame route, shared with the worker. */
export const FRAME_ROUTE_PATTERN =
  /^\/player\/widget-frame\/\d+\/[a-f0-9-]{36}$/;

/**
 * Frame-aware media authorization for sandbox-frame clients. Asking the
 * requesting client cannot work for an untrusted external Widget iframe,
 * so the worker resolves the frame itself: the frame's own URL must name
 * a currently active frame grant, the media URI must name a currently
 * active media grant, and both grants must name the same
 * slot, binding, activation, and generation. A frame can neither reach
 * another activation's media nor launder a media grant through a frame
 * grant. The grants come from `activeGrant`, so currency (trusted
 * bytes, live activation) is already enforced on both sides.
 */
export async function authorizeFrameMedia(
  clientUrl: string,
  mediaUri: string,
  grant: (uri: string) => Promise<MediaGrant | undefined>,
): Promise<boolean> {
  let framePath: string;
  try {
    framePath = new URL(clientUrl).pathname;
  } catch {
    return false;
  }
  if (!FRAME_ROUTE_PATTERN.test(framePath)) return false;
  const frame = await grant(framePath);
  if (!frame || frame.kind !== "frame") return false;
  const media = await grant(mediaUri);
  // Absent kind is a media grant minted before kinds existed.
  if (!media || media.kind === "frame") return false;
  return (
    frame.slotId === media.slotId &&
    frame.bindingId === media.bindingId &&
    frame.activationId === media.activationId &&
    frame.generation === media.generation
  );
}
