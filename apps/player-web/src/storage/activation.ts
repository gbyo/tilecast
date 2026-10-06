import type {
  PresentationMessage,
  PluginsMessage,
} from "@tilecast/player-runtime/host-contract";
import { completed, read, result } from "./database";
import type { ResourceClaim, VerifiedObject } from "./verified-store";

export interface ActivationResource extends ResourceClaim {
  assetId: string;
  variantId: string;
}

export interface PreparedActivation {
  slotId: string;
  bindingId: string;
  serverInstallationId: string;
  generation: number;
  activationId: string;
  resources: ActivationResource[];
  presentation: PresentationMessage;
  plugins: PluginsMessage;
}

export interface MediaGrant {
  slotId: string;
  bindingId: string;
  activationId: string;
  generation: number;
  digest: string;
  size: number;
  mimeType: string;
}

/**
 * Runs under the profile CAS Web Lock after all files are reverified.
 * Required-object pins, media grants and active metadata commit together.
 */
export async function commitActivation(
  database: IDBDatabase,
  activation: PreparedActivation,
  publish?: (
    media: NonNullable<PresentationMessage["projection"]>["media"],
  ) => PresentationMessage,
): Promise<PreparedActivation> {
  const transaction = database.transaction(
    ["objects", "activations", "grants"],
    "readwrite",
    { durability: "strict" },
  );
  const done = completed(transaction);
  try {
    const objects = transaction.objectStore("objects");
    const stored: VerifiedObject[] = await result(objects.getAll());
    const byDigest = new Map(stored.map((object) => [object.digest, object]));
    for (const claim of activation.resources) {
      const object = byDigest.get(claim.digest);
      if (
        !object ||
        object.size !== claim.size ||
        object.mimeType !== claim.mimeType
      ) {
        throw new Error("Activation requires unprepared media");
      }
    }
    const pin = `active:${activation.slotId}`;
    const required = new Set(
      activation.resources.map((resource) => resource.digest),
    );
    for (const object of stored) {
      const pins = object.pins.filter((owner) => owner !== pin);
      if (required.has(object.digest)) pins.push(pin);
      objects.put({ ...object, pins }, object.digest);
    }
    const grants = transaction.objectStore("grants");
    const oldGrants: IDBValidKey[] = await result(grants.getAllKeys());
    for (const key of oldGrants) {
      const grant: MediaGrant = await result(grants.get(key));
      if (grant.slotId === activation.slotId) grants.delete(key);
    }
    const media = activation.resources.map((resource) => {
      const capability = crypto.randomUUID();
      const uri = `/player/media/${activation.generation}/${capability}`;
      const grant: MediaGrant = {
        slotId: activation.slotId,
        bindingId: activation.bindingId,
        activationId: activation.activationId,
        generation: activation.generation,
        digest: resource.digest,
        size: resource.size,
        mimeType: resource.mimeType,
      };
      grants.put(grant, uri);
      return { assetId: resource.assetId, variantId: resource.variantId, uri };
    });
    // Projection and plugins receive the same authorized table. Top-level
    // media item sources are mapped by the shared projection adapter at boot.
    const published: PreparedActivation = {
      ...activation,
      presentation: publish
        ? publish(media)
        : {
            ...activation.presentation,
            ...(activation.presentation.projection
              ? {
                  projection: { ...activation.presentation.projection, media },
                }
              : {}),
          },
      plugins: { ...activation.plugins, media },
    };
    transaction.objectStore("activations").put(published, activation.slotId);
    await done;
    return published;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      /* Already aborted by IndexedDB. */
    }
    await done.catch(() => undefined);
    throw error;
  }
}

/** Binding validity is also checked by the request's live Browser Host. */
export async function activeGrant(
  database: IDBDatabase,
  uri: string,
): Promise<MediaGrant | undefined> {
  const transaction = database.transaction(["grants", "activations"]);
  const grant: MediaGrant | undefined = await result(
    transaction.objectStore("grants").get(uri),
  );
  if (!grant) return undefined;
  const active: PreparedActivation | undefined = await result(
    transaction.objectStore("activations").get(grant.slotId),
  );
  if (
    active?.activationId !== grant.activationId ||
    active.generation !== grant.generation ||
    active.bindingId !== grant.bindingId
  )
    return undefined;
  return grant;
}

export function loadActivation(
  database: IDBDatabase,
  slotId: string,
): Promise<PreparedActivation | undefined> {
  return read(database, "activations", slotId);
}
