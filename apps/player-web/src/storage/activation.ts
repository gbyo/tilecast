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

/**
 * `trustedAt` records that this page load verified the object behind the
 * grant. Restoration clears it before it rehashes and sets it afterward; a
 * grant without it authorizes nothing.
 */
export interface MediaGrant {
  slotId: string;
  bindingId: string;
  activationId: string;
  generation: number;
  digest: string;
  size: number;
  mimeType: string;
  trustedAt?: number;
}

/**
 * An activation before its media grants exist. Presentation and plugin
 * messages are produced inside the commit, once every grant has a URI.
 */
export type PendingActivation = Omit<
  PreparedActivation,
  "presentation" | "plugins"
> &
  Partial<Pick<PreparedActivation, "presentation" | "plugins">>;

/** What a commit publishes to the Runtime once every media grant exists. */
export interface PublishedMessages {
  presentation: PresentationMessage;
  plugins: PluginsMessage;
}

/**
 * Runs under the profile CAS Web Lock after all files are reverified.
 * Required-object pins, media grants and active metadata commit together.
 */
export async function commitActivation(
  database: IDBDatabase,
  activation: PendingActivation,
  publish?: (
    media: NonNullable<PresentationMessage["projection"]>["media"],
  ) => PublishedMessages,
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
        // Every resource was downloaded and hashed, or rehashed, under the
        // CAS lock immediately before this transaction.
        trustedAt: Date.now(),
      };
      grants.put(grant, uri);
      return { assetId: resource.assetId, variantId: resource.variantId, uri };
    });
    // Projection and plugins receive the same authorized table. Top-level
    // media item sources are mapped by the shared projection adapter at boot.
    const { presentation, plugins } = activation;
    if (!publish && (!presentation || !plugins))
      throw new Error("Activation has nothing to publish");
    const messages: PublishedMessages = publish
      ? publish(media)
      : {
          presentation: {
            ...presentation!,
            ...(presentation!.projection
              ? { projection: { ...presentation!.projection, media } }
              : {}),
          },
          plugins: { ...plugins!, media },
        };
    const published: PreparedActivation = {
      ...activation,
      ...messages,
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
    !grant.trustedAt ||
    active?.activationId !== grant.activationId ||
    active.generation !== grant.generation ||
    active.bindingId !== grant.bindingId
  )
    return undefined;
  return grant;
}

/**
 * Marks every grant of the slot's active activation trusted or untrusted. A
 * new page load untrusts first, rehashes each object, then trusts again.
 */
export async function setActivationTrust(
  database: IDBDatabase,
  slotId: string,
  activationId: string,
  trusted: boolean,
): Promise<void> {
  const transaction = database.transaction(["grants"], "readwrite", {
    durability: "strict",
  });
  const done = completed(transaction);
  const grants = transaction.objectStore("grants");
  const keys: IDBValidKey[] = await result(grants.getAllKeys());
  for (const key of keys) {
    const grant: MediaGrant = await result(grants.get(key));
    if (grant.slotId !== slotId || grant.activationId !== activationId)
      continue;
    const { trustedAt: _previous, ...rest } = grant;
    void _previous;
    grants.put(trusted ? { ...rest, trustedAt: Date.now() } : rest, key);
  }
  await done;
}

/**
 * Forgets a slot's active activation: the activation record, its grants and
 * its pins. Used when the server says the binding is no longer valid, so a
 * later offline start cannot show content the server withdrew.
 */
export async function discardActivation(
  database: IDBDatabase,
  slotId: string,
): Promise<void> {
  const transaction = database.transaction(
    ["objects", "activations", "grants"],
    "readwrite",
    { durability: "strict" },
  );
  const done = completed(transaction);
  const grants = transaction.objectStore("grants");
  const keys: IDBValidKey[] = await result(grants.getAllKeys());
  for (const key of keys) {
    const grant: MediaGrant = await result(grants.get(key));
    if (grant.slotId === slotId) grants.delete(key);
  }
  const objects = transaction.objectStore("objects");
  const stored: VerifiedObject[] = await result(objects.getAll());
  const pin = `active:${slotId}`;
  for (const object of stored)
    if (object.pins.includes(pin))
      objects.put(
        { ...object, pins: object.pins.filter((owner) => owner !== pin) },
        object.digest,
      );
  transaction.objectStore("activations").delete(slotId);
  await done;
}

export function loadActivation(
  database: IDBDatabase,
  slotId: string,
): Promise<PreparedActivation | undefined> {
  return read(database, "activations", slotId);
}
