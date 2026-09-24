import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { BackupJob, ScreenStatus, User } from "../api/types";

// Notifications are derived on the fly from the live domain data the Studio already
// polls; there is no stored notification model. Priority orders how urgently a person
// should look: critical means something failed and needs action now, warning means it
// needs attention, info is routine or FYI.
export type NotificationPriority = "critical" | "warning" | "info";

export type NotificationItem = {
  id: string;
  priority: NotificationPriority;
  title: string;
  detail: string;
  to: string;
};

export type NotificationFeed = {
  items: NotificationItem[];
  count: number;
  topPriority: NotificationPriority | null;
};

const priorityRank: Record<NotificationPriority, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

// Status structures hold translation keys, never rendered text. Labels are
// resolved with t() at call time so notifications follow language changes.
const screenStatusLabelKeys: Record<
  ScreenStatus,
  | "statusLabels.online"
  | "statusLabels.recent"
  | "statusLabels.stale"
  | "statusLabels.offline"
  | "statusLabels.disabled"
  | "statusLabels.revoked"
> = {
  online: "statusLabels.online",
  recent: "statusLabels.recent",
  stale: "statusLabels.stale",
  offline: "statusLabels.offline",
  disabled: "statusLabels.disabled",
  revoked: "statusLabels.revoked",
};

const screenStatusPriority: Record<ScreenStatus, NotificationPriority> = {
  online: "info", // never surfaced; online screens are not an alert
  recent: "info",
  stale: "warning",
  offline: "warning",
  disabled: "info",
  revoked: "warning",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function useNotifications(user?: User): NotificationFeed {
  const { t, i18n } = useTranslation("activity");
  const canManageSystem =
    user?.role === "owner" || user?.role === "administrator";
  const canOperate = user?.role !== "viewer";

  const screens = useQuery({
    queryKey: ["screens"],
    queryFn: api.screens,
    refetchInterval: 10_000,
  });
  const deployments = useQuery({
    queryKey: ["update-deployments"],
    queryFn: api.updateDeployments,
    refetchInterval: 15_000,
  });
  const pairings = useQuery({
    queryKey: ["pending-pairings"],
    queryFn: api.pendingPairings,
    refetchInterval: 30_000,
    enabled: canManageSystem,
  });
  const backups = useQuery({
    queryKey: ["backups"],
    queryFn: api.backups,
    refetchInterval: 60_000,
    enabled: canManageSystem,
  });
  const takeovers = useQuery({
    queryKey: ["takeovers"],
    queryFn: api.takeovers,
    refetchInterval: 30_000,
    enabled: canOperate,
  });
  const failedAssets = useQuery({
    queryKey: ["assets", "failed"],
    queryFn: () =>
      api.assets(
        new URLSearchParams({ status: "failed", page: "1", pageSize: "50" }),
      ),
    refetchInterval: 60_000,
  });

  const items = useMemo<NotificationItem[]>(() => {
    const collected: NotificationItem[] = [];
    const now = Date.now();

    for (const screen of screens.data?.items ?? []) {
      if (screen.status === "online") continue;
      collected.push({
        id: `screen:${screen.id}`,
        priority: screenStatusPriority[screen.status],
        title: screen.name,
        detail: t(screenStatusLabelKeys[screen.status]),
        to: `/screens/${screen.id}`,
      });
    }

    for (const deployment of deployments.data?.items ?? []) {
      if (deployment.failedCount > 0) {
        collected.push({
          id: `deployment-failed:${deployment.id}`,
          priority: "critical",
          title: deployment.name,
          detail: t("notifications.failedUpdates", {
            count: deployment.failedCount,
          }),
          to: "/settings/player/updates",
        });
      }
      if (deployment.waitingForUserCount > 0) {
        collected.push({
          id: `deployment-waiting:${deployment.id}`,
          priority: "warning",
          title: deployment.name,
          detail: t("notifications.playersWaiting", {
            count: deployment.waitingForUserCount,
          }),
          to: "/settings/player/updates",
        });
      }
    }

    // Only surface backup failures from the last day so resolved history does not
    // linger in the bell (there is no acknowledge/dismiss state to clear).
    const backupJobs = [
      backups.data?.currentJob,
      ...(backups.data?.recentJobs ?? []),
    ].filter((job): job is BackupJob => Boolean(job));
    for (const job of backupJobs) {
      if (job.status !== "failed") continue;
      const finishedAt = job.completedAt ?? job.createdAt;
      if (finishedAt && now - new Date(finishedAt).getTime() > DAY_MS) continue;
      collected.push({
        id: `backup:${job.id}`,
        priority: job.kind === "restore" ? "critical" : "warning",
        title:
          job.kind === "restore"
            ? t("notifications.backupRestoreFailed")
            : job.kind === "verify"
              ? t("notifications.backupVerifyFailed")
              : t("notifications.backupFailed"),
        detail: job.errorMessage || t("notifications.backupReview"),
        to: "/settings/operations/backups",
      });
    }

    for (const takeover of takeovers.data?.items ?? []) {
      const active =
        !takeover.cancelledAt && new Date(takeover.expiresAt).getTime() > now;
      if (!active) continue;
      if (takeover.failedCount > 0) {
        collected.push({
          id: `takeover-failed:${takeover.id}`,
          priority: "critical",
          title: takeover.name,
          detail: t("notifications.takeoverFailed", {
            count: takeover.failedCount,
          }),
          // Screens is where a live takeover is seen and cancelled. Settings
          // only carries its defaults now, which is no help mid-emergency.
          to: "/screens",
        });
      } else {
        collected.push({
          id: `takeover:${takeover.id}`,
          priority: "warning",
          title: takeover.name,
          detail: t("notifications.takeoverActive", {
            count: takeover.affectedCount,
          }),
          to: "/screens",
        });
      }
    }

    const failedAssetCount =
      failedAssets.data?.total ?? failedAssets.data?.items.length ?? 0;
    if (failedAssetCount > 0) {
      collected.push({
        id: "assets-failed",
        priority: "warning",
        title: t("notifications.mediaFailedTitle"),
        detail: t("notifications.mediaFailed", {
          count: failedAssetCount,
        }),
        to: "/assets",
      });
    }

    const pending = pairings.data?.items ?? [];
    if (pending.length > 0) {
      collected.push({
        id: "pending-pairings",
        priority: "info",
        title: t("notifications.pairTitle"),
        detail: t("notifications.pairDetail", {
          count: pending.length,
        }),
        to: "/screens/pair",
      });
    }

    // Array.prototype.sort is stable, so items keep their insertion order within
    // a priority band while the bands themselves sort critical -> warning -> info.
    return collected.sort(
      (left, right) =>
        priorityRank[left.priority] - priorityRank[right.priority],
    );
    // The translated details depend on the interface language, which the
    // linter cannot see; rebuilding when it changes keeps them translated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    screens.data,
    deployments.data,
    backups.data,
    takeovers.data,
    failedAssets.data,
    pairings.data,
    i18n.language,
  ]);

  return {
    items,
    count: items.length,
    topPriority: items[0]?.priority ?? null,
  };
}
