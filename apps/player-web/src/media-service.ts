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
 * reads only the bytes it asks for.
 */
export async function serveLocalMedia(
  request: Request,
  dependencies: MediaServiceDependencies,
): Promise<Response> {
  const uri = new URL(request.url).pathname;
  if (!(await dependencies.authorized(request))) return notFound();
  const grant = await dependencies.grant(uri);
  if (!grant) return notFound();
  const file = await dependencies.read(grant);
  if (!file) return notFound();
  // Activation replacement and revocation can race with the read.
  if (!(await dependencies.grant(uri))) return notFound();
  return mediaResponse(request, file, grant.mimeType);
}
