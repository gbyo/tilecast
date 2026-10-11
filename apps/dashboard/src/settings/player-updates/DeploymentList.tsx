import { ChevronRight } from "lucide-react";
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
  familyLabel,
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
    (item) => item.status === "active" || item.status === "paused",
  );
  const activeIds = new Set(active.map((item) => item.id));
  const history = items
    .filter((item) => !activeIds.has(item.id))
    .sort(
      (a, b) =>
        Date.parse(b.completedAt ?? b.createdAt) -
        Date.parse(a.completedAt ?? a.createdAt),
    );

  return (
    <div className="grid gap-8">
      {!!active.length && (
        <section
          className="grid gap-3"
          aria-label={t("updates.console.activeDeployments")}
        >
          <h2 className="text-base font-semibold">
            {t("updates.console.activeDeployments")}
          </h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {active.map((item) => (
              <Card key={item.id}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                    {item.versionName}
                    {item.architecture && (
                      <span className="font-mono text-xs font-normal text-muted-foreground">
                        {item.architecture}
                      </span>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {familyLabel(releaseUpdateTab(item), t)} ·{" "}
                    {modeLabel(item.mode, t)} ·{" "}
                    {relativeTime(item.completedAt ?? item.createdAt, t)}
                  </CardDescription>
                  <CardAction className="flex items-center gap-1">
                    <Badge
                      variant={
                        item.failedCount || item.incompatibleCount
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {deploymentStatus(item.status, t)}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpen(item)}
                    >
                      {t("updates.console.viewRollout")}
                      <ChevronRight aria-hidden="true" />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  <DeploymentMeter
                    {...item}
                    failedCount={
                      item.failedCount + (item.incompatibleCount ?? 0)
                    }
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      {item.incompatibleCount
                        ? t("updates.console.incompatibleTargets", {
                            count: item.incompatibleCount,
                          })
                        : deploymentHeadline(item)}
                    </span>
                    <span className="font-medium tabular-nums">
                      {t("updates.console.targetCount", {
                        count: item.targetCount,
                      })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
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
                  <TableHead className="hidden md:table-cell">
                    {t("updates.panel.modeLabel")}
                  </TableHead>
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
                          {item.architecture ? ` · ${item.architecture}` : ""}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {item.targetCount}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {modeLabel(item.mode, t)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          item.failedCount || item.incompatibleCount
                            ? "destructive"
                            : "outline"
                        }
                      >
                        {deploymentStatus(item.status, t)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {relativeTime(item.completedAt ?? item.createdAt, t)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("updates.console.viewRollout")}
                        onClick={() => onOpen(item)}
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
