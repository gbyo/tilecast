import {
  planPresentation,
  realizePresentation,
  type Manifest,
  type PlayerConfig,
  type PresentationPlan,
  type PresentationSelection,
} from "@tilecast/player-runtime/projection";
import type { RuntimeSupportV1 } from "@tilecast/player-runtime/host-contract";
import type { PlayerAPI } from "./api";
import { policyFromConfig } from "./policy";
import {
  commitActivation,
  type PreparedActivation,
} from "./storage/activation";
import { prepareResources } from "./storage/preparation";
import {
  VerifiedStore,
  type ObjectFiles,
  type ObjectIndex,
  type StoreOptions,
} from "./storage/verified-store";

/** The server's answer to what this Screen shows now. It is never evaluated here. */
export interface ServerSelection {
  at: string;
  current?: {
    selected?: PresentationSelection;
    nextEvaluationAt?: string;
  };
}

export interface ReconcileMemory {
  /** The last accepted inputs; an unchanged key needs no new activation. */
  key: string;
  generation: number;
  validUntilMs: number | null;
  clockOffsetMs: number;
  manifestVersion?: number;
  configRevision?: number;
  plan?: PresentationPlan;
}

export interface ReconcileDependencies {
  api: PlayerAPI;
  database: IDBDatabase;
  files: ObjectFiles;
  index: ObjectIndex;
  binding: { slotId: string; bindingId: string; serverInstallationId: string };
  support(): RuntimeSupportV1 | undefined;
  signal: AbortSignal;
  storeOptions: StoreOptions;
  /** The profile-wide lock that serializes preparation and restoration. */
  exclusively<T>(run: () => Promise<T>): Promise<T>;
  now?(): number;
}

export type ReconcileResult =
  | { changed: false; plan: PresentationPlan }
  | { changed: true; plan: PresentationPlan; activation: PreparedActivation };

/**
 * Fetches the server's current manifest, configuration and selection, plans
 * the presentation, downloads exactly the resources the plan requires, and
 * commits the activation atomically. Failure at any step leaves the previous
 * activation, its grants and its pins untouched.
 */
export async function reconcileSelection(
  dependencies: ReconcileDependencies,
  memory: ReconcileMemory,
): Promise<ReconcileResult> {
  const { api, binding } = dependencies;
  const now = dependencies.now ?? Date.now;
  const before = now();
  // The manifest request establishes the Screen's manifest state, which the
  // selection read depends on, so it cannot run in parallel with it.
  const manifest = await api.request<Manifest>("/api/v1/player/manifest");
  const [config, selection] = await Promise.all([
    api.request<PlayerConfig>("/api/v1/player/config"),
    api.request<ServerSelection>("/api/v1/player/browser/selection"),
  ]);
  const clockOffsetMs = Date.parse(manifest.serverTime) - (before + now()) / 2;
  const selected = selection.current?.selected ?? null;
  const next = selection.current?.nextEvaluationAt;
  const plan = planPresentation({
    manifest,
    config,
    selection: selected,
    at: new Date(selection.at),
    clockOffsetMs,
    nextEvaluationAt: next ? new Date(next) : null,
    support: dependencies.support(),
  });
  const key = JSON.stringify([
    manifest.manifestVersion,
    config.configRevision,
    selected,
    plan.requirements.map((requirement) => requirement.digest),
    plan.frameRequirements.map((requirement) => requirement.frameDigest),
  ]);
  const correctedNow = now() + clockOffsetMs;
  if (
    key === memory.key &&
    (memory.validUntilMs === null || correctedNow < memory.validUntilMs)
  ) {
    return { changed: false, plan };
  }
  const limit = Number(config.cache?.["maximumBytes"] ?? 2 * 1024 ** 3);
  const paths = new Map([
    ...plan.requirements.map(
      (requirement) => [requirement.digest, requirement.downloadPath] as const,
    ),
    ...plan.frameRequirements.map(
      (requirement) =>
        [requirement.frameDigest, requirement.downloadPath] as const,
    ),
  ]);
  const claims = [
    ...plan.requirements.map((requirement) => ({
      digest: requirement.digest,
      size: requirement.size,
      mimeType: requirement.mimeType,
    })),
    ...plan.frameRequirements.map((requirement) => ({
      digest: requirement.frameDigest,
      size: requirement.size,
      mimeType: "text/html",
    })),
  ];
  const result = await dependencies.exclusively(async () => {
    const store = new VerifiedStore(
      dependencies.index,
      dependencies.files,
      limit,
      now,
      dependencies.storeOptions,
    );
    await store.reconcile();
    const release = await prepareResources(
      store,
      dependencies.index,
      claims,
      (claim) => api.media(paths.get(claim.digest)!, dependencies.signal),
    );
    try {
      const generation = memory.generation + 1;
      const activationId = crypto.randomUUID();
      const activation = await commitActivation(
        dependencies.database,
        {
          ...binding,
          activationId,
          generation,
          // The accepted rest policy and the server's selection commit with
          // the activation, so a restart without the server reads both.
          policy: policyFromConfig(
            config,
            plan.selection,
            manifest.manifestVersion,
            clockOffsetMs,
          ),
          resources: plan.requirements.map((requirement) => ({
            assetId: requirement.assetId,
            variantId: requirement.variantId,
            digest: requirement.digest,
            size: requirement.size,
            mimeType: requirement.mimeType,
          })),
          frames: plan.frameRequirements.map((requirement) => ({
            packageId: requirement.packageId,
            packageDigest: requirement.packageDigest,
            frameDigest: requirement.frameDigest,
            digest: requirement.frameDigest,
            size: requirement.size,
            mimeType: "text/html",
          })),
        },
        (media, frames) =>
          realizePresentation(plan, media, frames, {
            activationId,
            generation,
          }),
      );
      memory.generation = generation;
      return { activation };
    } finally {
      await release();
    }
  });
  memory.key = key;
  memory.validUntilMs = plan.validUntil ? plan.validUntil.getTime() : null;
  memory.clockOffsetMs = clockOffsetMs;
  memory.manifestVersion = manifest.manifestVersion;
  memory.configRevision = config.configRevision;
  memory.plan = plan;
  return { changed: true, plan, ...result };
}
