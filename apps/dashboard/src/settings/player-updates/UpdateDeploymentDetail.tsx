import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import type { TFunction } from "i18next";
import { api } from "../../api/client";
import type { Screen } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { formatBytes } from "../../lib/formatBytes";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Field, FieldLabel } from "../../components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../../components/ui/input-group";
import {
  ItemGroup,
  Item,
  ItemContent,
  ItemTitle,
  ItemDescription,
  ItemActions,
} from "../../components/ui/item";
import { Empty, EmptyTitle } from "../../components/ui/empty";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { Spinner } from "../../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import { toast } from "../../components/ui/toast";
import { UpdateSurface } from "./UpdateSurface";
import {
  artifactIdentity,
  deploymentStatus,
  modeLabel,
  relativeTime,
} from "./model";
import {
  bucketCounts,
  deploymentPollInterval,
  deploymentSegments,
  filterDeploymentScreens,
  screenDownloadPercent,
  screenUpdateDetail,
  screenStateCounts,
  screenUpdateMeaning,
  type ScreenFilter,
} from "../playerUpdateStates";

export function useUpdateDeployment({
  deploymentId,
  screens,
  manageable,
}: {
  deploymentId: string;
  screens: Screen[];
  manageable: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { t: screenT } = useTranslation("screens");
  const locale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const [filter, setFilter] = useState<ScreenFilter>("all");
  const [search, setSearch] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const detail = useQuery({
    queryKey: ["update-deployment", deploymentId],
    queryFn: () => api.updateDeployment(deploymentId),
    refetchInterval: (q) => deploymentPollInterval(q.state.data),
    refetchIntervalInBackground: true,
  });
  const invalidate = () =>
    Promise.all([
      client.invalidateQueries({
        queryKey: ["update-deployment", deploymentId],
      }),
      client.invalidateQueries({ queryKey: ["update-deployments"] }),
    ]);
  const retry = useMutation({
    mutationFn: (screenId: string) =>
      api.retryUpdateScreen(
        deploymentId,
        screenId,
        auth.status?.csrfToken ?? "",
      ),
    onSuccess: () => {
      toast.add({ title: t("updates.retryRequested"), type: "success" });
      return invalidate();
    },
  });
  const cancel = useMutation({
    mutationFn: () =>
      api.cancelUpdateDeployment(deploymentId, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      setConfirmCancel(false);
      toast.add({ title: t("updates.cancelledSuccess"), type: "success" });
      return invalidate();
    },
  });
  const deployment = detail.data;
  const all = deployment?.screens ?? [];
  const counts = bucketCounts(all);
  const visible = filterDeploymentScreens(all, filter).filter((item) =>
    item.screenName.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const reachability = new Map(screens.map((item) => [item.id, item.status]));
  const active =
    deployment?.status === "active" || deployment?.status === "paused";
  const body = (
    <>
      {detail.isPending && <LoadingRows />}
      {detail.error && (
        <Alert variant="destructive">
          <AlertTitle>{t("updates.statusesLoadError")}</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(detail.error)}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void detail.refetch()}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {retry.error && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(retry.error)}</AlertDescription>
        </Alert>
      )}
      {deployment && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge
              variant={
                deployment.status === "paused" ? "destructive" : "outline"
              }
            >
              {deploymentStatus(deployment.status, t)}
            </Badge>
            <span>{modeLabel(deployment.mode, t)}</span>
            <span>
              {deployment.rolloutMode === "canary"
                ? t("updates.console.canarySummary", {
                    count: deployment.canarySize,
                  })
                : t("updates.rolloutAll")}
            </span>
            <time
              dateTime={deployment.completedAt ?? deployment.createdAt}
              title={new Date(
                deployment.completedAt ?? deployment.createdAt,
              ).toLocaleString(locale)}
            >
              {relativeTime(deployment.completedAt ?? deployment.createdAt, t)}
            </time>
          </div>
          {deployment.rolloutMode === "canary" && (
            <p className="text-sm">
              {t("updates.console.canaryPhase", {
                phase:
                  deployment.rolloutPhase === "canary"
                    ? t("updates.console.waitingCanary")
                    : deployment.rolloutPhase === "paused"
                      ? t("updates.console.status.paused")
                      : t("updates.rolloutAll"),
              })}
            </p>
          )}
          {deployment.pauseReason && (
            <Alert>
              <AlertTitle>{t("updates.pausedTitle")}</AlertTitle>
              <AlertDescription>
                {t("updates.pausedDetail", { reason: deployment.pauseReason })}
              </AlertDescription>
            </Alert>
          )}
          <DeploymentMeter {...screenStateCounts(all)} />
          <ToggleGroup
            aria-label={t("updates.filterLabel")}
            value={[filter]}
            onValueChange={(values) =>
              values[0] && setFilter(values[0] as ScreenFilter)
            }
            variant="outline"
            size="sm"
            className="flex flex-wrap justify-start"
            spacing={1}
          >
            {(["all", "attention", "progress", "done"] as const).map(
              (value) => (
                <ToggleGroupItem key={value} value={value}>
                  {t(`updates.filter.${value}`, {
                    count: value === "all" ? all.length : counts[value],
                  })}
                </ToggleGroupItem>
              ),
            )}
          </ToggleGroup>
          <Field className="gap-1">
            <FieldLabel htmlFor="rollout-search" className="sr-only">
              {t("updates.searchScreens")}
            </FieldLabel>
            <InputGroup>
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                id="rollout-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("updates.searchScreens")}
              />
            </InputGroup>
          </Field>
          <ItemGroup render={<ul />} className="gap-0 divide-y">
            {visible.map((item) => {
              const meaning = screenUpdateMeaning(item.state);
              const percent = screenDownloadPercent(
                item,
                deployment.artifactSizeBytes,
              );
              const status = reachability.get(item.screenId);
              return (
                <Item
                  key={item.screenId}
                  render={<li />}
                  size="sm"
                  className="items-start rounded-none px-0"
                >
                  <ItemContent>
                    <ItemTitle className="flex-wrap [display:flex] [-webkit-line-clamp:unset]">
                      {item.screenName}
                      <Badge
                        variant={
                          meaning.tone === "danger" ? "destructive" : "outline"
                        }
                      >
                        {meaning.label}
                      </Badge>
                      {item.isCanary && (
                        <Badge variant="secondary">{t("updates.canary")}</Badge>
                      )}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none text-xs">
                      {item.previousVersionCode ?? "—"} →{" "}
                      {item.expectedVersionCode}
                      {status && ` · ${screenT(`status.${status}`)}`} ·{" "}
                      {relativeTime(item.updatedAt, t)}
                    </ItemDescription>
                    {screenUpdateDetail(item) && (
                      <p
                        className={
                          meaning.tone === "danger"
                            ? "text-sm text-destructive"
                            : "text-sm text-muted-foreground"
                        }
                      >
                        {screenUpdateDetail(item)}
                      </p>
                    )}
                    {percent !== null && (
                      <div className="mt-1 grid gap-1">
                        <Progress
                          value={percent}
                          aria-label={t("updates.downloadProgress", {
                            percent,
                            size: formatBytes(
                              deployment.artifactSizeBytes,
                              locale,
                            ),
                          })}
                        />
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {t("updates.panel.downloadProgress", {
                            downloaded: formatBytes(
                              item.downloadedBytes,
                              locale,
                            ),
                            total: formatBytes(
                              deployment.artifactSizeBytes,
                              locale,
                            ),
                          })}{" "}
                          · {percent}%
                        </span>
                      </div>
                    )}
                  </ItemContent>
                  {manageable && active && item.state === "failed" && (
                    <ItemActions>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(item.screenId)}
                      >
                        {retry.isPending &&
                          retry.variables === item.screenId && <Spinner />}
                        {t("common:actions.retry")}
                      </Button>
                    </ItemActions>
                  )}
                </Item>
              );
            })}
          </ItemGroup>
          {!visible.length && (
            <Empty className="py-6">
              <EmptyTitle className="text-sm">
                {all.length ? t("updates.emptyFilter") : t("updates.emptyNone")}
              </EmptyTitle>
            </Empty>
          )}
        </>
      )}
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("updates.cancel")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("updates.cancelHint")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {cancel.error && (
            <Alert variant="destructive">
              <AlertDescription>
                {apiErrorMessage(cancel.error)}
              </AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancel.isPending}>
              {t("common:actions.back")}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {cancel.isPending && <Spinner />}
              {t("updates.cancel")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
  const footer =
    manageable && active ? (
      <Button variant="outline" onClick={() => setConfirmCancel(true)}>
        {t("updates.cancel")}
      </Button>
    ) : undefined;
  return { deployment, body, footer };
}

export function deploymentDescription(
  deployment:
    | {
        platform: string;
        playerFamily?: string;
        architecture?: string;
        versionName: string;
      }
    | undefined,
  t: TFunction<["settings", "common"]>,
) {
  return deployment
    ? artifactIdentity(deployment, t)
    : t("updates.deploymentFallback");
}
export function UpdateDeploymentDetail({
  deploymentId,
  screens,
  manageable,
  open,
  onOpenChange,
}: {
  deploymentId: string;
  screens: Screen[];
  manageable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { deployment, body, footer } = useUpdateDeployment({
    deploymentId,
    screens,
    manageable,
  });
  return (
    <UpdateSurface
      open={open}
      onOpenChange={onOpenChange}
      title={deployment?.versionName ?? t("updates.deploymentTitle")}
      description={deploymentDescription(deployment, t)}
      footer={footer}
    >
      {body}
    </UpdateSurface>
  );
}
export function LoadingRows() {
  return (
    <div className="grid gap-4" aria-busy="true">
      {[1, 2, 3].map((i) => (
        <div key={i} className="grid gap-2 py-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}
export function DeploymentMeter({
  targetCount,
  succeededCount,
  failedCount,
  waitingForUserCount,
  compact = false,
}: {
  targetCount: number;
  succeededCount: number;
  failedCount: number;
  waitingForUserCount: number;
  compact?: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const segments = deploymentSegments({
    targetCount,
    succeededCount,
    failedCount,
    waitingForUserCount,
  }).filter((s) => s.count > 0);
  const fills = {
    succeeded: "bg-[var(--tc-viz-up)]",
    attention: "bg-[var(--tc-viz-impaired)]",
    failed: "bg-[var(--tc-viz-down)]",
    remaining: "bg-[var(--tc-viz-track)]",
  };
  return (
    <div className="grid gap-1.5">
      <div
        role="img"
        aria-label={
          targetCount
            ? segments.map((s) => `${s.count} ${s.label}`).join(", ")
            : t("updates.noScreens")
        }
        className="flex h-1.5 overflow-hidden rounded-sm bg-muted"
      >
        {segments.map((s) => (
          <span
            key={s.key}
            className={fills[s.key]}
            style={{ width: `${(s.count / Math.max(1, targetCount)) * 100}%` }}
          />
        ))}
      </div>
      <p
        className={
          compact ? "sr-only" : "text-xs tabular-nums text-muted-foreground"
        }
      >
        {segments.map((s) => `${s.count} ${s.label}`).join(" · ")}
      </p>
    </div>
  );
}
