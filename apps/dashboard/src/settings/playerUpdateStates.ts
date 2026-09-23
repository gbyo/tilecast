import type {
  UpdateDeployment,
  UpdateDeploymentScreen,
  UpdateDeploymentScreenState,
} from "../api/types";
import { i18n, translateKnown } from "../i18n";
import { DEFAULT_LANGUAGE } from "../i18n/languages";
import enSettings from "../locales/en/settings.json";

export type ScreenUpdateTone =
  "success" | "info" | "warning" | "danger" | "neutral";

// Three buckets, because that is the only question an operator asks of a
// deployment: is anything waiting on me, is anything still moving, and is the
// rest finished. Every screen state maps into exactly one of them.
export type ScreenUpdateBucket = "attention" | "progress" | "done";

// The four visible stages of one screen's update. A screen that failed or was
// cancelled has no stage: it stopped somewhere, and saying which step it stopped
// on would read as progress it is not making. Keys resolve at render.
export const screenUpdateStages = [
  "updates.stages.queued",
  "updates.stages.downloading",
  "updates.stages.installing",
  "updates.stages.updated",
] as const;

export type ScreenUpdateMeaning = {
  label: string;
  // Plain language for what is happening, or what a person has to do about it.
  // Empty when the label already says everything and a second line would only
  // make healthy rows taller.
  detail: string;
  tone: ScreenUpdateTone;
  bucket: ScreenUpdateBucket;
  stage: number;
  // True when the deployment cannot move without a person: approving an
  // installer, granting a permission, retrying, or replacing hardware.
  actionable: boolean;
};

// English label/detail text lives in en/settings.json next to its translations
// (imported above as the translateKnown fallback). This map only pairs each
// server state with its non-text presentation: tone, bucket, stage, and
// whether the deployment is waiting on a person.
type MeaningConfig = Pick<
  ScreenUpdateMeaning,
  "tone" | "bucket" | "stage" | "actionable"
>;

const meaningConfigs: Record<UpdateDeploymentScreenState, MeaningConfig> = {
  held: { tone: "neutral", bucket: "progress", stage: 0, actionable: false },
  pending: { tone: "info", bucket: "progress", stage: 0, actionable: false },
  offline: { tone: "warning", bucket: "progress", stage: 0, actionable: false },
  downloading: {
    tone: "info",
    bucket: "progress",
    stage: 1,
    actionable: false,
  },
  downloaded: {
    tone: "info",
    bucket: "progress",
    stage: 1,
    actionable: false,
  },
  verifying: {
    tone: "info",
    bucket: "progress",
    stage: 1,
    actionable: false,
  },
  ready: { tone: "info", bucket: "progress", stage: 2, actionable: false },
  waiting_for_permission: {
    tone: "warning",
    bucket: "attention",
    stage: 2,
    actionable: true,
  },
  waiting_for_user: {
    tone: "warning",
    bucket: "attention",
    stage: 2,
    actionable: true,
  },
  installing: {
    tone: "info",
    bucket: "progress",
    stage: 2,
    actionable: false,
  },
  reconnecting: {
    tone: "info",
    bucket: "progress",
    stage: 2,
    actionable: false,
  },
  succeeded: {
    tone: "success",
    bucket: "done",
    stage: 3,
    actionable: false,
  },
  already_current: {
    tone: "success",
    bucket: "done",
    stage: 3,
    actionable: false,
  },
  failed: { tone: "danger", bucket: "attention", stage: -1, actionable: true },
  cancelled: {
    tone: "neutral",
    bucket: "done",
    stage: -1,
    actionable: false,
  },
  incompatible: {
    tone: "danger",
    bucket: "attention",
    stage: -1,
    actionable: true,
  },
};

const unknownConfig: MeaningConfig = {
  tone: "neutral",
  bucket: "progress",
  stage: 0,
  actionable: false,
};

type StateText = { label: string; detail?: string };

const stateTexts = enSettings.updates.states as Record<string, StateText>;

function stateText(key: string): StateText {
  return stateTexts[key] ?? { label: key };
}

export function screenUpdateMeaning(state: string): ScreenUpdateMeaning {
  const known = state in meaningConfigs;
  const key = known ? state : "unknown";
  const text = stateText(key);
  const config = known
    ? meaningConfigs[state as UpdateDeploymentScreenState]
    : unknownConfig;
  return {
    label: translateKnown(`settings:updates.states.${key}.label`, text.label),
    detail:
      text.detail != null
        ? translateKnown(`settings:updates.states.${key}.detail`, text.detail)
        : "",
    ...config,
  };
}

// The server's own error text wins over the generic sentence: it is the only
// thing that says why this particular screen stopped.
export function screenUpdateDetail(screen: UpdateDeploymentScreen) {
  const meaning = screenUpdateMeaning(screen.state);
  if (screen.state === "failed" && screen.safeError) return screen.safeError;
  return meaning.detail;
}

// Only a download reports real progress. Everything else is a step, not a
// percentage, and inventing one would be a fake progress bar.
export function screenDownloadPercent(
  screen: UpdateDeploymentScreen,
  artifactSizeBytes: number,
) {
  if (screen.state !== "downloading" || artifactSizeBytes <= 0) return null;
  const percent = Math.round(
    (screen.downloadedBytes / artifactSizeBytes) * 100,
  );
  return Math.min(100, Math.max(0, percent));
}

// How often the drawer re-reads a deployment. A download moves in seconds, so a
// rollout with a screen still working is polled at a rate a person watching it
// reads as live; one that has finished is not polled at all.
export function deploymentPollInterval(
  detail: { status: string; screens: UpdateDeploymentScreen[] } | undefined,
): number | false {
  if (!detail) return 5_000;
  if (detail.status !== "active" && detail.status !== "paused") return false;
  const moving = detail.screens.some(
    (screen) => screenUpdateMeaning(screen.state).bucket === "progress",
  );
  return moving ? 2_000 : 5_000;
}

export type DeploymentSegment = {
  key: "succeeded" | "attention" | "failed" | "remaining";
  label: string;
  count: number;
  tone: ScreenUpdateTone;
};

// One meter per deployment, built from the counts the list already returns so it
// needs no extra request. Remaining is whatever the other three do not claim.
export function deploymentSegments(
  item: Pick<
    UpdateDeployment,
    "targetCount" | "succeededCount" | "failedCount" | "waitingForUserCount"
  >,
): DeploymentSegment[] {
  const succeeded = Math.max(0, item.succeededCount);
  const failed = Math.max(0, item.failedCount);
  const waiting = Math.max(0, item.waitingForUserCount);
  const remaining = Math.max(
    0,
    item.targetCount - succeeded - failed - waiting,
  );
  const segmentText: Record<
    "succeeded" | "attention" | "failed" | "remaining",
    string
  > = enSettings.updates.segments;
  return [
    {
      key: "succeeded",
      label: translateKnown(
        "settings:updates.segments.succeeded",
        segmentText.succeeded,
      ),
      count: succeeded,
      tone: "success",
    },
    {
      key: "attention",
      label: translateKnown(
        "settings:updates.segments.attention",
        segmentText.attention,
      ),
      count: waiting,
      tone: "warning",
    },
    {
      key: "failed",
      label: translateKnown(
        "settings:updates.segments.failed",
        segmentText.failed,
      ),
      count: failed,
      tone: "danger",
    },
    {
      key: "remaining",
      label: translateKnown(
        "settings:updates.segments.remaining",
        segmentText.remaining,
      ),
      count: remaining,
      tone: "neutral",
    },
  ];
}

export function deploymentPercent(
  item: Pick<UpdateDeployment, "targetCount" | "succeededCount">,
) {
  if (item.targetCount <= 0) return 0;
  return Math.round((item.succeededCount / item.targetCount) * 100);
}

// The same four numbers the deployment list returns, recomputed from the screen
// rows so the drawer's meter matches the rows underneath it even when a scoped
// operator only sees part of the deployment.
export function screenStateCounts(screens: UpdateDeploymentScreen[]) {
  const counted = (states: UpdateDeploymentScreenState[]) =>
    screens.filter((screen) => states.includes(screen.state)).length;
  return {
    targetCount: screens.length,
    succeededCount: counted(["succeeded", "already_current"]),
    failedCount: counted(["failed", "incompatible"]),
    waitingForUserCount: counted([
      "waiting_for_user",
      "waiting_for_permission",
    ]),
  };
}

export type ScreenFilter = "all" | ScreenUpdateBucket;

export function bucketCounts(screens: UpdateDeploymentScreen[]) {
  const counts: Record<ScreenUpdateBucket, number> = {
    attention: 0,
    progress: 0,
    done: 0,
  };
  for (const screen of screens)
    counts[screenUpdateMeaning(screen.state).bucket] += 1;
  return counts;
}

// Attention first, then whatever is still moving: the rows a person can act on
// should never be below a hundred finished screens.
const bucketOrder: Record<ScreenUpdateBucket, number> = {
  attention: 0,
  progress: 1,
  done: 2,
};

export function sortedDeploymentScreens(screens: UpdateDeploymentScreen[]) {
  return [...screens].sort((left, right) => {
    const order =
      bucketOrder[screenUpdateMeaning(left.state).bucket] -
      bucketOrder[screenUpdateMeaning(right.state).bucket];
    return order || left.screenName.localeCompare(right.screenName);
  });
}

export function filterDeploymentScreens(
  screens: UpdateDeploymentScreen[],
  filter: ScreenFilter,
) {
  const sorted = sortedDeploymentScreens(screens);
  if (filter === "all") return sorted;
  return sorted.filter(
    (screen) => screenUpdateMeaning(screen.state).bucket === filter,
  );
}

// A single sentence for the whole deployment, so the history row says what to do
// rather than leaving four counts to be compared.
/**
 * `translateKnown` checks the exact key, so a plural base key would always
 * miss and return the fallback. The count branch resolves its own suffix with
 * the platform plural rules, then looks up that exact key.
 */
function pluralHeadline(base: "retry" | "waiting", count: number): string {
  const suffix = new Intl.PluralRules(
    i18n.resolvedLanguage ?? DEFAULT_LANGUAGE,
  ).select(count);
  const key = `settings:updates.headline.${base}_${suffix}`;
  const fallback =
    (enSettings.updates.headline as Record<string, string | undefined>)[
      `${base}_${suffix}`
    ] ?? "";
  return translateKnown(key, fallback, { count });
}

export function deploymentHeadline(item: UpdateDeployment) {
  if (item.status === "cancelled")
    return translateKnown(
      "settings:updates.headline.cancelled",
      enSettings.updates.headline.cancelled,
    );
  if (item.failedCount) return pluralHeadline("retry", item.failedCount);
  if (item.waitingForUserCount)
    return pluralHeadline("waiting", item.waitingForUserCount);
  if (item.status === "paused")
    return (
      item.pauseReason ??
      translateKnown(
        "settings:updates.headline.pausedFallback",
        enSettings.updates.headline.pausedFallback,
      )
    );
  if (item.succeededCount >= item.targetCount && item.targetCount > 0)
    return translateKnown(
      "settings:updates.headline.complete",
      enSettings.updates.headline.complete,
    );
  return translateKnown(
    "settings:updates.headline.rolling",
    enSettings.updates.headline.rolling,
  );
}
