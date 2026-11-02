import type {
  PresentationMessage,
  PluginsMessage,
} from "@tilecast/player-runtime/host-contract";
import type { SelectionFacts } from "@tilecast/player-runtime/projection";
import { completed, read, result } from "./database";
import type { ResourceClaim, VerifiedObject } from "./verified-store";

export interface ActivationResource extends ResourceClaim {
  assetId: string;
  variantId: string;
}

export interface ActivationFrameResource extends ResourceClaim {
  packageId: string;
  packageDigest: string;
  frameDigest: string;
}

/**
 * What a restarted browser needs to behave correctly without the server: the
 * server's own selection facts for the content, and the few accepted
 * configuration values the rest policy reads. It commits and is discarded
 * with its activation, so it can never describe different content.
 */
export interface ActivationPolicy {
  configRevision: number;
  manifestVersion: number | undefined;
  /** The server's selection facts. Null when nothing is selected. */
  selection: SelectionFacts | null;
  /** Only the `power` values the active-hours policy reads. */
  power: Record<string, unknown>;
  /** Only the `branding` values the rest surface uses. */
  branding: Record<string, unknown>;
  /** Corrected-minus-device wall offset when the policy was accepted. */
  clockOffsetMs: number;
}

export interface PreparedActivation {
  slotId: string;
  bindingId: string;
  serverInstallationId: string;
  generation: number;
  activationId: string;
  resources: ActivationResource[];
  /**
   * Exactly the sandbox frames the activation's Widgets requested.
   * Absent only on an activation committed before frames existed.
   */
  frames?: ActivationFrameResource[];
  presentation: PresentationMessage;
  plugins: PluginsMessage;
  /** Absent only on an activation committed before the policy existed. */
  policy?: ActivationPolicy;
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
  /**
   * Which route may serve this grant. Absent only on a grant minted
   * before frames existed, which is always media. A media grant never
   * serves the frame route and a frame grant never serves media: the
   * usage is pinned at mint time, not negotiated per request.
   */
  kind?: "media" | "frame";
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
 * Required-object pins, media and frame grants, and active metadata
 * commit together.
 */
export async function commitActivation(
  database: IDBDatabase,
  activation: PendingActivation,
  publish?: (
    media: NonNullable<PresentationMessage["projection"]>["media"],
    frames: Exclude<
      NonNullable<PresentationMessage["projection"]>["widgetFrames"],
      undefined
    >,
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
    const frames = activation.frames ?? [];
    for (const claim of frames) {
      const object = byDigest.get(claim.digest);
      if (
        !object ||
        object.size !== claim.size ||
        object.mimeType !== claim.mimeType
      ) {
        throw new Error("Activation requires an unprepared frame");
      }
    }
    const pin = `active:${activation.slotId}`;
    const required = new Set(
      [...activation.resources, ...frames].map((resource) => resource.digest),
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
    const mint = (
      route: "media" | "widget-frame",
      digest: string,
      size: number,
      mimeType: string,
    ): string => {
      const capability = crypto.randomUUID();
      const uri = `/player/${route}/${activation.generation}/${capability}`;
      const grant: MediaGrant = {
        slotId: activation.slotId,
        bindingId: activation.bindingId,
        activationId: activation.activationId,
        generation: activation.generation,
        digest,
        size,
        mimeType,
        kind: route === "media" ? "media" : "frame",
        // Every resource was downloaded and hashed, or rehashed, under the
        // CAS lock immediately before this transaction.
        trustedAt: Date.now(),
      };
      grants.put(grant, uri);
      return uri;
    };
    const media = activation.resources.map((resource) => ({
      assetId: resource.assetId,
      variantId: resource.variantId,
      uri: mint("media", resource.digest, resource.size, resource.mimeType),
    }));
    const widgetFrames = frames.map((resource) => ({
      packageId: resource.packageId,
      packageDigest: resource.packageDigest,
      frameDigest: resource.frameDigest,
      uri: mint(
        "widget-frame",
        resource.digest,
        resource.size,
        resource.mimeType,
      ),
    }));
    // Projection and plugins receive the same authorized table. Top-level
    // media item sources are mapped by the shared projection adapter at boot.
    const { presentation, plugins } = activation;
    if (!publish && (!presentation || !plugins))
      throw new Error("Activation has nothing to publish");
    const messages: PublishedMessages = publish
      ? publish(media, widgetFrames)
      : {
          presentation: {
            ...presentation!,
            ...(presentation!.projection
              ? {
                  projection: {
                    ...presentation!.projection,
                    media,
                    ...(widgetFrames.length ? { widgetFrames } : {}),
                  },
                }
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
