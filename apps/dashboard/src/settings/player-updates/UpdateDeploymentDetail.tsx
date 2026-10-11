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
  const auth = useAuth();
  const client = useQueryClient();
  const [filter, setFilter] = useState<ScreenFilter>("all");
  const [search, setSearch] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const detail = useQuery({
    queryKey: ["update-deployment", deploymentId],
    queryFn: () => api.updateDeployment(deploymentId),
    refetchInterval: (query) => deploymentPollInterval(query.state.data),
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
  const normalizedSearch = search.trim().toLowerCase();
  const visible = filterDeploymentScreens(all, filter).filter((item) =>
    item.screenName.toLowerCase().includes(normalizedSearch),
  );
  const reachability = new Map(screens.map((item) => [item.id, item.status]));
  const active =
    deployment?.status === "active" || deployment?.status === "paused";
  return {
    deployment,
    all,
    counts,
    visible,
    reachability,
    active,
    manageable,
    filter,
    setFilter,
    search,
    setSearch,
    confirmCancel,
    setConfirmCancel,
    detailPending: detail.isPending,
    detailError: detail.error,
    refetch: () => void detail.refetch(),
    retryError: retry.error,
    retryPending: retry.isPending,
    retryScreenId: retry.variables,
    retryScreen: (screenId: string) => retry.mutate(screenId),
    cancelError: cancel.error,
    cancelPending: cancel.isPending,
    cancel: () => cancel.mutate(),
  };
}

export type UpdateDeploymentState = ReturnType<typeof useUpdateDeployment>;

export function DeploymentBody({ state }: { state: UpdateDeploymentState }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <>
      {state.detailPending && <LoadingRows />}
      {state.detailError && (
        <Alert variant="destructive">
          <AlertTitle>{t("updates.statusesLoadError")}</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(state.detailError)}
            <Button variant="outline" size="sm" onClick={state.refetch}>
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {state.retryError && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(state.retryError)}
          </AlertDescription>
        </Alert>
      )}
      {state.deployment && <DeploymentContent state={state} />}
      <CancelDeploymentDialog state={state} />
    </>
  );
}

function DeploymentContent({ state }: { state: UpdateDeploymentState }) {
  const { deployment } = state;
  if (!deployment) return null;
  return (
    <>
      <DeploymentSummary state={state} />
      <DeploymentMeter {...screenStateCounts(state.all)} />
      <DeploymentFilters state={state} />
      <DeploymentScreenRows state={state} />
    </>
  );
}

function DeploymentSummary({ state }: { state: UpdateDeploymentState }) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const deployment = state.deployment!;
  const timestamp = deployment.completedAt ?? deployment.createdAt;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge
          variant={deployment.status === "paused" ? "destructive" : "outline"}
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
          dateTime={timestamp}
          title={new Date(timestamp).toLocaleString(locale)}
        >
          {relativeTime(timestamp, t)}
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
    </>
  );
}

function DeploymentFilters({ state }: { state: UpdateDeploymentState }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <>
      <ToggleGroup
        aria-label={t("updates.filterLabel")}
        value={[state.filter]}
        onValueChange={(values) =>
          values[0] && state.setFilter(values[0] as ScreenFilter)
        }
        variant="outline"
        size="sm"
        className="flex flex-wrap justify-start"
        spacing={1}
      >
        {(["all", "attention", "progress", "done"] as const).map((value) => (
          <ToggleGroupItem key={value} value={value}>
            {t(`updates.filter.${value}`, {
              count: value === "all" ? state.all.length : state.counts[value],
            })}
          </ToggleGroupItem>
        ))}
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
            value={state.search}
            onChange={(event) => state.setSearch(event.target.value)}
            placeholder={t("updates.searchScreens")}
          />
        </InputGroup>
      </Field>
    </>
  );
}

function DeploymentScreenRows({ state }: { state: UpdateDeploymentState }) {
  const { t } = useTranslation(["settings", "common"]);
  const { t: screenT } = useTranslation("screens");
  const locale = useFormatLocale();
  const deployment = state.deployment!;
  return (
    <>
      <ItemGroup render={<ul />} className="gap-0 divide-y">
        {state.visible.map((item) => {
          const meaning = screenUpdateMeaning(item.state);
          const percent = screenDownloadPercent(
            item,
            deployment.artifactSizeBytes,
          );
          const status = state.reachability.get(item.screenId);
          const detail = screenUpdateDetail(item);
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
                  {item.previousVersionCode ?? "—"} → {item.expectedVersionCode}
                  {status && ` · ${screenT(`status.${status}`)}`} ·{" "}
                  {relativeTime(item.updatedAt, t)}
                </ItemDescription>
                {detail && (
                  <p
                    className={
                      meaning.tone === "danger"
                        ? "text-sm text-destructive"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {detail}
                  </p>
                )}
                {percent !== null && (
                  <div className="mt-1 grid gap-1">
                    <Progress
                      value={percent}
                      aria-label={t("updates.downloadProgress", {
                        percent,
                        size: formatBytes(deployment.artifactSizeBytes, locale),
                      })}
                    />
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t("updates.panel.downloadProgress", {
                        downloaded: formatBytes(item.downloadedBytes, locale),
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
              {state.manageable && item.state === "failed" && (
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state.retryPending}
                    onClick={() => state.retryScreen(item.screenId)}
                  >
                    {state.retryPending &&
                      state.retryScreenId === item.screenId && <Spinner />}
                    {t("common:actions.retry")}
                  </Button>
                </ItemActions>
              )}
            </Item>
          );
        })}
      </ItemGroup>
      {!state.visible.length && (
        <Empty className="py-6">
          <EmptyTitle className="text-sm">
            {state.all.length
              ? t("updates.emptyFilter")
              : t("updates.emptyNone")}
          </EmptyTitle>
        </Empty>
      )}
    </>
  );
}

function CancelDeploymentDialog({ state }: { state: UpdateDeploymentState }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <AlertDialog
      open={state.confirmCancel}
      onOpenChange={state.setConfirmCancel}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("updates.cancel")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("updates.cancelHint")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {state.cancelError && (
          <Alert variant="destructive">
            <AlertDescription>
              {apiErrorMessage(state.cancelError)}
            </AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={state.cancelPending}>
            {t("common:actions.back")}
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={state.cancelPending}
            onClick={state.cancel}
          >
            {state.cancelPending && <Spinner />}
            {t("updates.cancel")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeploymentFooter({ state }: { state: UpdateDeploymentState }) {
  const { t } = useTranslation(["settings", "common"]);
  if (!state.manageable || !state.active) return null;
  return (
    <Button variant="outline" onClick={() => state.setConfirmCancel(true)}>
      {t("updates.cancel")}
    </Button>
  );
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
  const state = useUpdateDeployment({
    deploymentId,
    screens,
    manageable,
  });
  return (
    <UpdateSurface
      open={open}
      onOpenChange={onOpenChange}
      title={state.deployment?.versionName ?? t("updates.deploymentTitle")}
      description={deploymentDescription(state.deployment, t)}
      footer={<DeploymentFooter state={state} />}
    >
      <DeploymentBody state={state} />
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
