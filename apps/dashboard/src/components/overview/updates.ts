import type { UpdateDeployment } from "../../api/types";

export type UpdateSummary = {
  /** The deployment to show: the newest one that needs a person, else the newest. */
  deployment: UpdateDeployment;
  failed: number;
  waiting: number;
  needsAction: number;
};

const inProgress = new Set(["pending", "active", "paused"]);

type UpdateStatusKey =
  | "operations.updateStatuses.pending"
  | "operations.updateStatuses.active"
  | "operations.updateStatuses.paused"
  | "operations.updateStatuses.cancelled"
  | "operations.updateStatuses.completed"
  | "operations.updateStatuses.unknown";

const statusKeys: Record<string, UpdateStatusKey> = {
  pending: "operations.updateStatuses.pending",
  active: "operations.updateStatuses.active",
  paused: "operations.updateStatuses.paused",
  cancelled: "operations.updateStatuses.cancelled",
  completed: "operations.updateStatuses.completed",
};

/**
 * Deployment statuses are a closed server enum, so each maps to a translation
 * key. An unrecognized future value gets a neutral localized label instead of
 * a humanized English one.
 */
export function updateDeploymentStatusKey(status: string): UpdateStatusKey {
  return statusKeys[status] ?? "operations.updateStatuses.unknown";
}

/**
 * What the newest deployments ask of a person. Only the latest deployment and
 * any that is still moving count: a failure from a release two months ago that
 * a later release replaced is history, and summing every deployment ever made
 * would keep "needs action" lit forever.
 */
export function summarizeUpdates(
  deployments: UpdateDeployment[],
): UpdateSummary | undefined {
  if (deployments.length === 0) return undefined;
  const newestFirst = [...deployments].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  const latest = newestFirst[0]!;
  const relevant = newestFirst.filter(
    (deployment) => deployment === latest || inProgress.has(deployment.status),
  );
  const failed = relevant.reduce((sum, item) => sum + item.failedCount, 0);
  const waiting = relevant.reduce(
    (sum, item) => sum + item.waitingForUserCount,
    0,
  );
  const needing = relevant.find(
    (item) => item.failedCount + item.waitingForUserCount > 0,
  );
  return {
    deployment: needing ?? latest,
    failed,
    waiting,
    needsAction: failed + waiting,
  };
}
