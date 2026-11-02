import {
  PREPARATION_OWNER_PREFIX,
  type ObjectIndex,
  type ResourceClaim,
  type VerifiedStore,
} from "./verified-store";

/** Holds each prepared object through the atomic activation commit. */
export async function prepareResources(
  store: VerifiedStore,
  index: ObjectIndex,
  claims: ResourceClaim[],
  download: (claim: ResourceClaim) => Promise<Response>,
): Promise<() => Promise<void>> {
  const distinct = new Map<string, ResourceClaim>();
  let total = 0;
  for (const claim of claims) {
    const previous = distinct.get(claim.digest);
    if (
      previous &&
      (previous.size !== claim.size || previous.mimeType !== claim.mimeType)
    ) {
      throw new Error("Conflicting media integrity claims");
    }
    if (!previous) {
      distinct.set(claim.digest, claim);
      total += claim.size;
    }
  }
  if (!Number.isSafeInteger(total) || total > store.limitBytes)
    throw new Error("Presentation exceeds the Browser Player cache limit");
  const owner = `${PREPARATION_OWNER_PREFIX}${crypto.randomUUID()}`;
  const release = async () => {
    for (const digest of distinct.keys()) {
      const object = await index.get(digest);
      if (object?.pins.includes(owner)) {
        await index.put({
          ...object,
          pins: object.pins.filter((pin) => pin !== owner),
        });
      }
    }
  };
  try {
    for (const claim of distinct.values()) {
      await store.prepare(claim, () => download(claim));
      const object = await index.get(claim.digest);
      if (!object) throw new Error("Prepared object disappeared");
      await index.put({ ...object, pins: [...object.pins, owner] });
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
