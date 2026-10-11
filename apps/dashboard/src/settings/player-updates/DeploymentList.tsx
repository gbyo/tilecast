import { useTranslation } from "react-i18next";
import type { UpdateDeployment } from "../../api/types";
import { releaseUpdateTab } from "../../playerPlatform";
import {
  ItemGroup,
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../../components/ui/item";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";
import { DeploymentMeter } from "./UpdateDeploymentDetail";
import { deploymentHeadline } from "../playerUpdateStates";
import {
  familyLabel,
  deploymentNeedsAttention,
  deploymentStatus,
  modeLabel,
  relativeTime,
  sortDeployments,
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
    (item) =>
      item.status === "active" ||
      item.status === "paused" ||
      deploymentNeedsAttention(item),
  );
  const history = sorted.filter((item) => !active.includes(item));
  function rows(entries: UpdateDeployment[]) {
    return (
      <ItemGroup render={<ul />} className="gap-0 divide-y">
        {entries.map((item) => (
          <Item key={item.id} render={<li />} className="rounded-none px-0">
            <ItemContent>
              <ItemTitle className="flex-wrap [display:flex] [-webkit-line-clamp:unset]">
                {item.versionName}
                {item.architecture && (
                  <span className="font-mono text-xs">{item.architecture}</span>
                )}
                <Badge variant={item.failedCount ? "destructive" : "outline"}>
                  {deploymentStatus(item.status, t)}
                </Badge>
              </ItemTitle>
              <ItemDescription className="line-clamp-none text-xs">
                {familyLabel(releaseUpdateTab(item), t)} ·{" "}
                {modeLabel(item.mode, t)} ·{" "}
                {relativeTime(item.completedAt ?? item.createdAt, t)} ·{" "}
                {t("updates.console.targetCount", { count: item.targetCount })}
              </ItemDescription>
              <div className="mt-2 max-w-xl">
                <DeploymentMeter {...item} compact />
              </div>
              <p className="text-xs text-muted-foreground">
                {deploymentHeadline(item)}
              </p>
            </ItemContent>
            <ItemActions>
              <Button variant="outline" size="sm" onClick={() => onOpen(item)}>
                {t("updates.console.viewRollout")}
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    );
  }
  return (
    <div className="grid gap-6">
      {!!active.length && (
        <section aria-label={t("updates.console.activeDeployments")}>
          <h2 className="mb-2 text-sm font-semibold">
            {t("updates.console.activeDeployments")}
          </h2>
          {rows(active)}
        </section>
      )}
      <section aria-label={t("updates.console.recentDeployments")}>
        <h2 className="mb-2 text-sm font-semibold">
          {t("updates.console.recentDeployments")}
        </h2>
        {history.length ? (
          rows(history)
        ) : (
          <Empty className="gap-2 py-8">
            <EmptyHeader>
              <EmptyTitle className="text-sm">
                {t("updates.console.noHistory")}
              </EmptyTitle>
              <EmptyDescription>
                {t("updates.console.noHistoryHint")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </section>
    </div>
  );
}
