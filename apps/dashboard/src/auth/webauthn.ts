import type { PublicKeyOptions } from "../api/types";

/**
 * The WebAuthn browser API speaks ArrayBuffers while the server speaks
 * base64url JSON. These helpers translate in both directions by hand rather
 * than relying on `PublicKeyCredential.parseCreationOptionsFromJSON`, which is
 * not yet available in every browser Studio supports.
 */

function decode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encode(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function passkeysSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    Boolean(navigator.credentials)
  );
}

type ConditionalCapableCredential = typeof PublicKeyCredential & {
  isConditionalMediationAvailable?: () => Promise<boolean>;
};

/**
 * Autofill-assisted sign-in ("conditional mediation") offers passkeys from the
 * browser's own autofill UI on the username field instead of behind a button.
 * It has to be feature-detected: where it is unsupported, passing
 * `mediation: "conditional"` throws instead of degrading.
 */
export async function conditionalMediationAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  const api = window.PublicKeyCredential as ConditionalCapableCredential;
  if (typeof api.isConditionalMediationAvailable !== "function") return false;
  try {
    return await api.isConditionalMediationAvailable();
  } catch {
    return false;
  }
}

type SignalCapableCredential = typeof PublicKeyCredential & {
  signalAllAcceptedCredentials?: (options: {
    rpId: string;
    userId: string;
    allAcceptedCredentialIds: string[];
  }) => Promise<void>;
  signalUnknownCredential?: (options: {
    rpId: string;
    credentialId: string;
  }) => Promise<void>;
};

/**
 * Tells the user's passkey provider which credentials this server still
 * accepts, so one removed in Studio stops being offered at sign-in instead of
 * lingering as an entry that always fails. Unsupported browsers simply ignore
 * it — this is a courtesy signal, never a correctness requirement.
 */
export async function signalAcceptedCredentials(
  rpId: string,
  userId: string,
  credentialIds: string[],
): Promise<void> {
  if (!passkeysSupported() || !rpId || !userId) return;
  const api = window.PublicKeyCredential as SignalCapableCredential;
  if (typeof api.signalAllAcceptedCredentials !== "function") return;
  try {
    await api.signalAllAcceptedCredentials({
      rpId,
      userId,
      allAcceptedCredentialIds: credentialIds,
    });
  } catch {
    // A provider that rejects the signal changes nothing about our state.
  }
}

/** Reports a credential the server does not recognize, so it stops being offered. */
export async function signalUnknownCredential(
  rpId: string,
  credentialId: string,
): Promise<void> {
  if (!passkeysSupported() || !rpId || !credentialId) return;
  const api = window.PublicKeyCredential as SignalCapableCredential;
  if (typeof api.signalUnknownCredential !== "function") return;
  try {
    await api.signalUnknownCredential({ rpId, credentialId });
  } catch {
    // Best effort only.
  }
}

/** A passkey ceremony the user dismissed is not an error worth reporting. */
export function isPasskeyCancellation(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "AbortError")
  );
}

type CredentialDescriptorJSON = { id: string; [key: string]: unknown };

function toDescriptors(
  value: unknown,
): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return (value as CredentialDescriptorJSON[]).map((descriptor) => ({
    ...descriptor,
    id: decode(descriptor.id),
  })) as unknown as PublicKeyCredentialDescriptor[];
}

export function toCreationOptions(
  options: PublicKeyOptions,
): PublicKeyCredentialCreationOptions {
  const user = options.user as { id: string; [key: string]: unknown };
  return {
    ...options,
    challenge: decode(options.challenge as string),
    user: { ...user, id: decode(user.id) },
    excludeCredentials: toDescriptors(options.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
}

export function toRequestOptions(
  options: PublicKeyOptions,
): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: decode(options.challenge as string),
    allowCredentials: toDescriptors(options.allowCredentials),
  };
}

/**
 * A PublicKeyCredential always carries type "public-key" and, when present,
 * a platform/cross-platform attachment. Narrow here so the wire shapes
 * below match the WebAuthn contract schemas exactly.
 */
function wireAttachment(
  credential: PublicKeyCredential,
): "platform" | "cross-platform" | undefined {
  const attachment = credential.authenticatorAttachment;
  return attachment === "platform" || attachment === "cross-platform"
    ? attachment
    : undefined;
}

export function serializeRegistration(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: "public-key" as const,
    authenticatorAttachment: wireAttachment(credential),
    clientExtensionResults: { ...credential.getClientExtensionResults() },
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      attestationObject: encode(response.attestationObject),
      // The server needs the transports to build an efficient allow list on
      // the next sign-in; not every authenticator reports them.
      transports: response.getTransports?.() ?? [],
    },
  };
}

export function serializeAssertion(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: encode(credential.rawId),
    type: "public-key" as const,
    authenticatorAttachment: wireAttachment(credential),
    clientExtensionResults: { ...credential.getClientExtensionResults() },
    response: {
      clientDataJSON: encode(response.clientDataJSON),
      authenticatorData: encode(response.authenticatorData),
      signature: encode(response.signature),
      userHandle: response.userHandle ? encode(response.userHandle) : undefined,
    },
  };
}
