import type { TFunction } from "i18next";
import type { PlayerRelease, UpdateDeployment } from "../../api/types";
import { releaseUpdateTab, type UpdateFamilyTab } from "../../playerPlatform";

type ReleaseReadiness = {
  tone: "success" | "info" | "warning" | "danger" | "neutral";
  label: string;
  detail: string;
  cacheable: boolean;
};

// One column replaces the former Verification and Cache pair. A release is only
// deployable once its manifest signature is verified and the artifact is cached,
// so the leading status reports that combined truth and the detail line keeps
// both underlying values visible.
export function releaseReadiness(
  release: PlayerRelease,
  t: TFunction<["settings", "common"]>,
): ReleaseReadiness {
  if (release.verificationStatus === "failed")
    return {
      tone: "danger",
      label: t("updates.panel.readinessVerificationFailed"),
      detail:
        release.verificationError ?? t("updates.panel.readinessVerifyAgain"),
      cacheable: true,
    };
  if (release.cacheStatus === "failed")
    return {
      tone: "danger",
      label: t("updates.panel.readinessDownloadFailed"),
      detail: t("updates.panel.readinessCacheDetail"),
      cacheable: true,
    };
  if (release.cacheStatus === "downloading")
    return {
      tone: "info",
      label: t("updates.panel.readinessDownloading"),
      detail: t("updates.panel.readinessDownloadingDetail"),
      cacheable: false,
    };
  if (release.cacheStatus !== "cached")
    return {
      tone: "warning",
      label: t("updates.panel.readinessNotCached"),
      detail:
        release.source === "upload"
          ? t("updates.panel.directHint")
          : release.verificationStatus === "verified_manifest"
            ? t("updates.panel.readinessManifestDetail")
            : t("updates.panel.readinessDeployableDetail"),
      cacheable: release.source === "github",
    };
  if (release.verificationStatus !== "verified")
    return {
      tone: "info",
      label: t("updates.panel.readinessVerifying"),
      detail: t("updates.panel.readinessVerifyingDetail"),
      cacheable: true,
    };
  // "Ready to deploy" already states both underlying facts, so no detail line is
  // added and healthy rows stay one line tall.
  return {
    tone: "success",
    label: t("updates.panel.readinessReady"),
    detail: "",
    cacheable: false,
  };
}

export const families = ["android", "linux", "edge", "windows"] as const;
export function familyLabel(
  family: UpdateFamilyTab,
  t: TFunction<["settings", "common"]>,
) {
  return t(`updates.console.families.${family}`);
}
export function modeLabel(mode: string, t: TFunction<["settings", "common"]>) {
  return mode === "install_now"
    ? t("updates.panel.modeNameInstallNow")
    : mode === "maintenance_window"
      ? t("updates.panel.modeNameMaintenanceWindow")
      : t("updates.panel.modeNameDownloadOnly");
}
export function deploymentStatus(
  status: string,
  t: TFunction<["settings", "common"]>,
) {
  return t(
    `updates.console.status.${status === "paused" || status === "completed" || status === "cancelled" ? status : "active"}`,
  );
}
export function artifactIdentity(
  release: { platform: string; playerFamily?: string; architecture?: string },
  t: TFunction<["settings", "common"]>,
) {
  const family = releaseUpdateTab(release);
  return [
    familyLabel(family, t),
    (family === "edge" || family === "windows") && release.architecture,
  ]
    .filter(Boolean)
    .join(" · ");
}
export function deployable(release: PlayerRelease) {
  return (
    release.verificationStatus === "verified" &&
    release.cacheStatus === "cached"
  );
}
export function purgeAction(release: PlayerRelease) {
  if (
    release.activeDeploymentCount > 0 ||
    release.cacheStatus === "downloading"
  )
    return undefined;
  if (release.deploymentCount === 0) return "delete";
  return release.cacheStatus === "missing" ? undefined : "free";
}
// A tag is provider identity. Matching version strings on uploads are not.
export function groupReleases(releases: PlayerRelease[]) {
  const groups = new Map<string, PlayerRelease[]>();
  for (const release of releases) {
    const key =
      release.source === "github" && release.tag
        ? [
            release.playerFamily,
            release.tag,
            release.versionCode,
            release.versionName,
            release.channel,
          ].join(":")
        : release.id;
    groups.set(key, [...(groups.get(key) ?? []), release]);
  }
  return [...groups.values()].sort(
    (a, b) => Date.parse(b[0]!.publishedAt) - Date.parse(a[0]!.publishedAt),
  );
}
export function deploymentNeedsAttention(item: UpdateDeployment) {
  return (
    item.status === "paused" ||
    item.failedCount > 0 ||
    (item.incompatibleCount ?? 0) > 0 ||
    item.waitingForUserCount > 0
  );
}
export function sortDeployments(items: UpdateDeployment[]) {
  return [...items].sort(
    (a, b) =>
      Number(deploymentNeedsAttention(b)) -
        Number(deploymentNeedsAttention(a)) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}
export function relativeTime(
  value: string,
  t: TFunction<["settings", "common"]>,
) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(value)) / 1000),
  );
  if (seconds < 60) return t("updates.relativeNow");
  if (seconds < 3600)
    return t("updates.relativeMinutes", { count: Math.round(seconds / 60) });
  if (seconds < 86400)
    return t("updates.relativeHours", { count: Math.round(seconds / 3600) });
  return t("updates.relativeDays", { count: Math.round(seconds / 86400) });
}
