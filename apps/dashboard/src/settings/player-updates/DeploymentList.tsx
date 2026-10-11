import { CheckCircle2, ChevronRight, CircleAlert } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { UpdateDeployment } from "../../api/types";
import { releaseUpdateTab } from "../../playerPlatform";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "../../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { DeploymentMeter } from "./UpdateDeploymentDetail";
import { deploymentHeadline } from "../playerUpdateStates";
import {
  architectureLabel,
  deploymentNeedsAttention,
  familyLabel,
  deploymentStatus,
  modeLabel,
  relativeTime,
  sortDeployments,
} from "./model";

export type DeploymentOpenFocus = "all" | "attention";

function attentionScreenCount(item: UpdateDeployment) {
  return (
    item.failedCount +
    item.waitingForUserCount +
    (item.incompatibleCount ?? 0)
  );
}

function historyStatus(
  item: UpdateDeployment,
  t: TFunction<["settings", "common"]>,
) {
  if (
    item.status === "completed" &&
    (item.failedCount > 0 || (item.incompatibleCount ?? 0) > 0)
  ) {
    return t("updates.console.status.completedWithIssues");
  }
  return deploymentStatus(item.status, t);
}

function unfinishedScreenCount(item: UpdateDeployment) {
  return Math.max(
    0,
    item.targetCount -
      item.succeededCount -
      item.failedCount -
      item.waitingForUserCount -
      (item.incompatibleCount ?? 0),
  );
}

function deploymentIdentity(
  item: UpdateDeployment,
  t: TFunction<["settings", "common"]>,
) {
  return [
    familyLabel(releaseUpdateTab(item), t),
    item.architecture ? architectureLabel(item.architecture, t) : undefined,
    modeLabel(item.mode, t),
    relativeTime(item.completedAt ?? item.createdAt, t),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function DeploymentList({
  items,
  onOpen,
}: {
  items: UpdateDeployment[];
  onOpen: (item: UpdateDeployment, focus?: DeploymentOpenFocus) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const sorted = sortDeployments(items);
  const operational = sorted.filter(
    (item) => item.status === "active" || item.status === "paused",
  );
  const attention = operational.filter(deploymentNeedsAttention);
  const moving = operational.filter((item) => !deploymentNeedsAttention(item));
  const operationalIds = new Set(operational.map((item) => item.id));
  const history = items
    .filter((item) => !operationalIds.has(item.id))
    .sort(
      (a, b) =>
        Date.parse(b.completedAt ?? b.createdAt) -
        Date.parse(a.completedAt ?? a.createdAt),
    );
  const attentionScreens = attention.reduce(
    (sum, item) => sum + Math.max(1, attentionScreenCount(item)),
    0,
  );
  const movingScreens = moving.reduce(
    (sum, item) => sum + Math.max(1, unfinishedScreenCount(item)),
    0,
  );

  return (
    <div className="grid gap-8">
      {!!attention.length && (
        <section
          className="grid gap-3"
          aria-label={t("updates.console.needsAttention")}
        >
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">
              {t("updates.console.needsAttention")}
            </h2>
            <Badge variant="destructive">
              {t("updates.console.targetCount", { count: attentionScreens })}
            </Badge>
          </div>
          <ItemGroup
            render={<ul />}
            className="gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-2"
          >
            {attention.map((item) => (
              <Item
                key={item.id}
                render={<li />}
                variant="default"
                className="bg-background/80"
              >
                <ItemMedia variant="icon" className="text-destructive">
                  <CircleAlert aria-hidden="true" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="flex-wrap">
                    {item.versionName}
                    <Badge
                      variant={
                        item.status === "paused" ? "destructive" : "outline"
                      }
                    >
                      {deploymentStatus(item.status, t)}
                    </Badge>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    <span className="font-medium text-foreground">
                      {item.incompatibleCount
                        ? t("updates.console.incompatibleTargets", {
                            count: item.incompatibleCount,
                          })
                        : deploymentHeadline(item)}
                    </span>
                    <span className="block">{deploymentIdentity(item, t)}</span>
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOpen(item, "attention")}
                  >
                    {t("updates.console.viewRollout")}
                    <ChevronRight aria-hidden="true" />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </section>
      )}

      {!!moving.length && (
        <section
          className="grid gap-3"
          aria-label={t("updates.console.inProgress")}
        >
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">
              {t("updates.console.inProgress")}
            </h2>
            <Badge variant="secondary">
              {t("updates.console.targetCount", { count: movingScreens })}
            </Badge>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {moving.map((item) => (
              <Card key={item.id}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                    {item.versionName}
                    {item.architecture && (
                      <span className="text-xs font-normal text-muted-foreground">
                        {architectureLabel(item.architecture, t)}
                        <span className="ml-1 font-mono">
                          ({item.architecture})
                        </span>
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {familyLabel(releaseUpdateTab(item), t)} ·{" "}
                    {modeLabel(item.mode, t)} ·{" "}
                    {relativeTime(item.createdAt, t)}
                  </CardDescription>
                  <CardAction>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpen(item, "all")}
                    >
                      {t("updates.console.viewRollout")}
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <DeploymentMeter {...item} />
                  <p className="text-sm text-muted-foreground">
                    {deploymentHeadline(item)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {!operational.length && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
          {t("updates.console.noActiveDeployments")}
        </div>
      )}

      <section
        className="grid gap-3"
        aria-label={t("updates.console.recentDeployments")}
      >
        <h2 className="text-base font-semibold">
          {t("updates.console.recentDeployments")}
        </h2>
        {history.length ? (
          <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("updates.panel.version")}</TableHead>
                  <TableHead>{t("updates.console.screens")}</TableHead>
                  <TableHead>{t("updates.panel.status")}</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    {t("updates.console.status.completed")}
                  </TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">
                      {t("updates.console.viewRollout")}
                    </span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="grid gap-0.5">
                        <span className="font-medium">{item.versionName}</span>
                        <span className="text-xs text-muted-foreground">
                          {familyLabel(releaseUpdateTab(item), t)}
                          {item.architecture
                            ? ` · ${architectureLabel(item.architecture, t)} (${item.architecture})`
                            : ""}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {item.targetCount}
                    </TableCell>
                    <TableCell>
                      <div className="grid gap-1">
                        <Badge
                          variant={
                            item.failedCount || item.incompatibleCount
                              ? "destructive"
                              : "outline"
                          }
                        >
                          {historyStatus(item, t)}
                        </Badge>
                        {(item.failedCount > 0 ||
                          (item.incompatibleCount ?? 0) > 0) && (
                          <span className="text-xs text-muted-foreground">
                            {item.incompatibleCount
                              ? t("updates.console.incompatibleTargets", {
                                  count: item.incompatibleCount,
                                })
                              : deploymentHeadline(item)}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {relativeTime(item.completedAt ?? item.createdAt, t)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("updates.console.viewRollout")}
                        onClick={() => onOpen(item, "all")}
                      >
                        <ChevronRight aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
