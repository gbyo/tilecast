import { activeGrant, type PreparedActivation } from "./storage/activation";

/** Only the live owning Host can authorize its service worker's media read. */
export function installMediaAuthorization(
  database: IDBDatabase,
  current: () => PreparedActivation | undefined,
  valid: () => boolean,
  container: ServiceWorkerContainer = navigator.serviceWorker,
): () => void {
  const receive = async (event: MessageEvent) => {
    const request = event.data as {
      type?: string;
      uri?: string;
      requestId?: string;
    };
    if (
      request?.type !== "authorize-media" ||
      !request.requestId ||
      !request.uri ||
      !event.source
    )
      return;
    if (event.source !== container.controller) return;
    const activation = current();
    const grant =
      valid() && activation
        ? await activeGrant(database, request.uri)
        : undefined;
    const allowed =
      !!grant &&
      grant.bindingId === activation?.bindingId &&
      grant.activationId === activation.activationId &&
      grant.slotId === activation.slotId;
    event.source.postMessage({
      type: "media-authorization",
      requestId: request.requestId,
      allowed,
    });
  };
  container.addEventListener("message", receive);
  return () => {
    container.removeEventListener("message", receive);
  };
}
