import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UpdateDeployment } from "../../api/types";
import { releaseUpdateTab } from "../../playerPlatform";
import { Badge } from "../../components/ui/badge";
import {
  Empty, EmptyHeader, EmptyTitle, EmptyDescription,
} from "../../components/ui/empty";
import { DeploymentMeter } from "./UpdateDeploymentDetail";
import { deploymentHeadline } from "../playerUpdateStates";
import {
  familyLabel, deploymentNeedsAttention, deploymentStatus,
  modeLabel, relativeTime, sortDeployments,
} from "./model";

export function DeploymentList({
  items,
  onOpen,
}: {
  items: UpdateDeployment[];
  onOpen: (item: UpdateDeployment) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const sorted = sortDeployments(items);
  const active = sorted.filter(
    (item) => item.status === "active" || item.status === "paused" || deploymentNeedsAttention(item),
  );
  const history = sorted.filter((item) => !active.some((a) => a.id === item.id));

  return (
    <div className="grid gap-8">
      {active.length > 0 && (
        <section className="grid gap-3" aria-label={t("updates.console.activeDeployments")}>
          <h2 className="text-base font-semibold">{t("updates.console.activeDeployments")}</h2>
          <div className="grid gap-3">
            {active.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item)}
                className="group w-full rounded-xl border bg-card p-5 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold tracking-tight">{item.versionName}</h3>
                      <Badge variant={item.failedCount || item.incompatibleCount ? "destructive" : "secondary"}>
                        {deploymentStatus(item.status, t)}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {familyLabel(releaseUpdateTab(item), t)}
                      {item.architecture ? ` · ${item.architecture}` : ""}
                      {" · "}{modeLabel(item.mode, t)}
                    </p>
                  </div>
                  <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1" />
                </div>
                <div className="mt-5 grid gap-2">
                  <DeploymentMeter
                    {...item}
                    failedCount={item.failedCount + (item.incompatibleCount ?? 0)}
                    compact
                  />
                  <p className="text-sm text-muted-foreground">
                    {item.incompatibleCount
                      ? t("updates.console.incompatibleTargets", { count: item.incompatibleCount })
                      : deploymentHeadline(item)}
                  </p>
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  {t("updates.console.targetCount", { count: item.targetCount })}
                  {" · "}{relativeTime(item.completedAt ?? item.createdAt, t)}
                </p>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="grid gap-3" aria-label={t("updates.console.recentDeployments")}>
        <h2 className="text-base font-semibold">{t("updates.console.recentDeployments")}</h2>
        {history.length > 0 ? (
          <div className="overflow-hidden rounded-xl border">
            <ul className="divide-y">
              {history.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(item)}
                    className="group flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <div className="grid min-w-0 gap-1">
                      <span className="font-medium">{item.versionName}</span>
                      <span className="text-sm text-muted-foreground">
                        {familyLabel(releaseUpdateTab(item), t)}
                        {" · "}{t("updates.console.targetCount", { count: item.targetCount })}
                        {" · "}{relativeTime(item.completedAt ?? item.createdAt, t)}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Badge variant={item.failedCount || item.incompatibleCount ? "destructive" : "outline"}>
                        {deploymentStatus(item.status, t)}
                      </Badge>
                      <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-hover:translate-x-1" />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Empty className="gap-2 py-8">
            <EmptyHeader>
              <EmptyTitle className="text-sm">{t("updates.console.noHistory")}</EmptyTitle>
              <EmptyDescription>{t("updates.console.noHistoryHint")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </div>
  );
}
