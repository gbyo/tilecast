import type {
  DeviceMetadata,
  Identity,
  PairingCreated,
  PairingPollResult,
} from "@tilecast/player-runtime/projection";
import type { PresentationMessage } from "@tilecast/player-runtime/host-contract";
import { PlayerAPI, PlayerAPIError } from "./api";
import { signChallenge, type BrowserIdentity } from "./identity";
import { write } from "./storage/database";

export interface BrowserSession {
  slotId: string;
  bindingId: string;
  screenId: string;
  screenName: string;
  epoch: number;
  expiresAt: string;
}

/** The server will not accept this binding again: stop trusting local content. */
export class IdentityMismatch extends Error {}

/** A rejected, expired or already-claimed pairing. A new page load starts over. */
export class PairingEnded extends Error {}

/** What the server returns for a device-key challenge. */
export interface BrowserChallenge {
  nonce: string;
  /** The complete text the device key signs. The server rebuilds and checks it. */
  message: string;
  expiresAt: string;
}

/** The text the server asks this installation to sign, rebuilt locally. */
export function challengeMessage(
  slotId: string,
  bindingId: string,
  nonce: string,
): string {
  return `tilecast-browser-player-v1:${slotId}:${bindingId}:${nonce}`;
}

/** Fetches public installation identity. A failure here means "unreachable". */
export function fetchServerIdentity(api: PlayerAPI): Promise<Identity> {
  return api.request<Identity>("/api/v1/system/identity");
}

/** Refuses to adopt a server other than the one this browser was bound to. */
export function assertSameServer(
  identity: BrowserIdentity,
  server: Identity,
): void {
  if (
    identity.serverInstallationId &&
    identity.serverInstallationId !== server.installationId
  ) {
    throw new IdentityMismatch(
      "The server identity changed. Reset this Browser Player explicitly before reconnecting.",
    );
  }
}

/** Uses existing pairing and the browser-only credential boundary. No bearer is returned. */
export async function authenticate(
  api: PlayerAPI,
  database: IDBDatabase,
  server: Identity,
  identity: BrowserIdentity,
  identitySlot: string,
  recovery: string | null,
  metadata: DeviceMetadata,
  present: (message: PresentationMessage) => void,
  signal: AbortSignal,
): Promise<{
  identity: BrowserIdentity;
  session: BrowserSession;
  server: Identity;
}> {
  // The server's identity is read first and must match before any request that
  // could carry a session cookie or a signature.
  assertSameServer(identity, server);
  api.slotId =
    identity.slotId ??
    (identitySlot === "unmanaged" ? undefined : identitySlot);
  const registration = {
    installationId: identity.installationId,
    publicKey: identity.publicKey,
  };
  let session: BrowserSession | undefined;
  if (api.slotId) {
    try {
      session = await api.request<BrowserSession>(
        "/api/v1/player/browser/session",
      );
      if (identity.bindingId && session.bindingId !== identity.bindingId) {
        // Another installation replaced us; do not adopt its profile cookie.
        throw new IdentityMismatch(
          "This Browser Player binding was replaced. Open a current managed launch link to reconnect.",
        );
      }
    } catch (error) {
      if (!(error instanceof PlayerAPIError) || error.status !== 401)
        throw error;
    }
  }
  if (!session && identity.slotId && identity.bindingId) {
    try {
      const challenge = await api.request<BrowserChallenge>(
        "/api/v1/player/browser/challenge",
        { slotId: identity.slotId, bindingId: identity.bindingId },
      );
      // The device key signs only the exact message the server issued, and
      // only when it names this installation's own slot and binding.
      if (
        challenge.message !==
        challengeMessage(identity.slotId, identity.bindingId, challenge.nonce)
      )
        throw new Error("The server issued an unexpected signing challenge.");
      session = await api.request<BrowserSession>(
        "/api/v1/player/browser/renew",
        {
          slotId: identity.slotId,
          bindingId: identity.bindingId,
          nonce: challenge.nonce,
          signature: await signChallenge(identity, challenge.message),
        },
      );
    } catch (error) {
      if (!(error instanceof PlayerAPIError) || error.status !== 401)
        throw error;
    }
  }
  if (!session && recovery && api.slotId) {
    session = await api.request<BrowserSession>(
      "/api/v1/player/browser/recover",
      {
        slotId: api.slotId,
        serverInstallationId: server.installationId,
        recoverySecret: recovery,
        registration,
        metadata,
      },
    );
  }
  // The provisioning secret lives only in this call's memory and is never
  // retained for an automatic rebind after another machine replaces us.
  recovery = null;
  if (!session) {
    if (identity.bindingId || identitySlot !== "unmanaged") {
      throw new IdentityMismatch(
        "This Browser Player cannot reconnect. Open a current managed launch link or pair from /player.",
      );
    }
    if (!server.pairingEnabled)
      throw new Error("Screen pairing is disabled on this server.");
    const pairing = await api.request<PairingCreated>(
      "/api/v1/player/pairing-sessions",
      { installationId: server.installationId, metadata },
    );
    present({
      type: "presentation",
      presentation: {
        state: "pairing",
        code: pairing.code,
        approvalUrl: pairing.approvalUrl,
        organizationName: pairing.organizationName,
      },
    });
    while (!signal.aborted) {
      await pause(Math.max(1, pairing.pollingIntervalSeconds) * 1000, signal);
      const poll = await api.request<PairingPollResult>(
        `/api/v1/player/pairing-sessions/${pairing.id}`,
        undefined,
        `Pairing ${pairing.pollSecret}`,
      );
      // The first approved private poll atomically claims the session and
      // returns the one-time enrollment token with status `claimed`.
      if (poll.status === "claimed") {
        if (!poll.enrollmentToken)
          throw new PairingEnded(
            "Pairing was claimed but its enrollment was lost. Reload this Browser Player to request a new code.",
          );
        session = await api.request<BrowserSession>(
          "/api/v1/player/browser/enroll",
          {
            pairingSessionId: pairing.id,
            enrollmentToken: poll.enrollmentToken,
            registration,
          },
        );
        break;
      }
      if (["rejected", "expired"].includes(poll.status))
        throw new PairingEnded(
          "Pairing ended. Reload this Browser Player to request a new code.",
        );
    }
  }
  if (!session || signal.aborted)
    throw new DOMException("Player closed", "AbortError");
  const bound = {
    ...identity,
    serverInstallationId: server.installationId,
    slotId: session.slotId,
    bindingId: session.bindingId,
  };
  // Only a changed binding is persisted; a routine renewal writes nothing.
  if (
    bound.serverInstallationId !== identity.serverInstallationId ||
    bound.slotId !== identity.slotId ||
    bound.bindingId !== identity.bindingId
  ) {
    await write(database, "identity", `device:${identitySlot}`, bound);
    await write(database, "identity", `device:${session.slotId}`, bound);
  }
  api.slotId = session.slotId;
  return { identity: bound, session, server };
}

export function pause(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
  });
}
