import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { RefreshCw, Search, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import { Field, FieldLabel } from "../components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../components/ui/input-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
import { StatusDot } from "../components/StatusDot";
import { ViewTabs } from "../components/ViewTabs";
import { api } from "../api/client";
import type { Screen, UpdateDeploymentScreen } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";
import type { TFunction } from "i18next";
import {
  bucketCounts,
  deploymentPollInterval,
  deploymentSegments,
  filterDeploymentScreens,
  screenDownloadPercent,
  screenUpdateDetail,
  screenStateCounts,
  screenUpdateMeaning,
  screenUpdateStages,
  type ScreenFilter,
  type ScreenUpdateTone,
} from "./playerUpdateStates";

export function UpdateDeploymentDrawer({
  deploymentId,
  screens,
  manageable,
  open,
  onOpenChange,
  onOpenChangeComplete,
}: {
  deploymentId: string;
  /** The fleet list the panel already holds, for live reachability per target. */
  screens: Screen[];
  manageable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const [filter, setFilter] = useState<ScreenFilter>("all");
  const [search, setSearch] = useState("");
  const [actionError, setActionError] = useState("");
  const detail = useQuery({
    queryKey: ["update-deployment", deploymentId],
    queryFn: () => api.updateDeployment(deploymentId),
    refetchInterval: (query) => deploymentPollInterval(query.state.data),
    // Ten seconds of an unchanged panel reads as a panel that is not working, so
    // the drawer keeps polling while it is open even if the tab loses focus.
    refetchIntervalInBackground: true,
  });
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({
        queryKey: ["update-deployment", deploymentId],
      }),
      client.invalidateQueries({ queryKey: ["update-deployments"] }),
    ]);
  };
  const retry = useMutation({
    mutationFn: (screenId: string) =>
      api.retryUpdateScreen(
        deploymentId,
        screenId,
        auth.status?.csrfToken ?? "",
      ),
    onMutate: () => setActionError(""),
    onSuccess: () => {
      toast.add({ title: t("updates.retryRequested"), type: "success" });
      return invalidate();
    },
    onError: (error: unknown) =>
      setActionError(
        error instanceof Error ? error.message : t("updates.requestFailed"),
      ),
  });
  const cancel = useMutation({
    mutationFn: () =>
      api.cancelUpdateDeployment(deploymentId, auth.status?.csrfToken ?? ""),
    onMutate: () => setActionError(""),
    onSuccess: () => {
      toast.add({
        title: t("updates.cancelledSuccess"),
        type: "success",
      });
      return invalidate();
    },
    onError: (error: unknown) =>
      setActionError(
        error instanceof Error ? error.message : t("updates.requestFailed"),
      ),
  });

  const deployment = detail.data;
  const allScreens = deployment?.screens ?? [];
  const counts = bucketCounts(allScreens);
  const query = search.trim().toLowerCase();
  const visible = filterDeploymentScreens(allScreens, filter).filter((item) =>
    item.screenName.toLowerCase().includes(query),
  );
  const reachability = new Map(screens.map((item) => [item.id, item.status]));
  const active =
    deployment?.status === "active" || deployment?.status === "paused";
  const desktop = useDesktopLayout();
  const header = desktop ? (
    <SheetHeader>
      <SheetDescription>
        {deployment
          ? `${deployment.platform === "linux" ? "Linux" : "Android"} · ${deployment.versionName} (${deployment.versionCode})`
          : t("updates.deploymentFallback")}
      </SheetDescription>
      <SheetTitle>
        {deployment?.name ?? t("updates.deploymentTitle")}
      </SheetTitle>
    </SheetHeader>
  ) : (
    <DrawerHeader>
      <DrawerDescription>
        {deployment
          ? `${deployment.platform === "linux" ? "Linux" : "Android"} · ${deployment.versionName} (${deployment.versionCode})`
          : t("updates.deploymentFallback")}
      </DrawerDescription>
      <DrawerTitle>
        {deployment?.name ?? t("updates.deploymentTitle")}
      </DrawerTitle>
    </DrawerHeader>
  );

  const content = (
    <div
      className={
        desktop
          ? "grid gap-4 px-6 pb-6"
          : "min-h-0 flex-1 overflow-y-auto px-4 pb-6 grid gap-4"
      }
    >
      {detail.isLoading && (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {t("updates.loading")}
        </span>
      )}
      {detail.error && (
        <Alert variant="destructive">
          <AlertTitle>{t("updates.statusesLoadError")}</AlertTitle>
          <AlertDescription>
            {detail.error instanceof Error
              ? detail.error.message
              : t("updates.requestFailed")}
          </AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}
      {deployment && (
        <>
          <dl className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2">
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">
                {t("updates.detail.status")}
              </dt>
              <dd>
                <Badge
                  {...statusBadgeAppearance(
                    deployment.status === "completed"
                      ? "success"
                      : deployment.status === "cancelled"
                        ? "neutral"
                        : deployment.status === "paused"
                          ? "warning"
                          : "info",
                  )}
                >
                  {humanize(deployment.status)}
                </Badge>
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">
                {t("updates.detail.mode")}
              </dt>
              <dd className="text-sm font-medium">
                {humanize(deployment.mode)}
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">
                {t("updates.detail.rollout")}
              </dt>
              <dd className="text-sm font-medium">
                {deployment.rolloutMode === "canary"
                  ? t("updates.rolloutCanary", {
                      size: deployment.canarySize,
                      phase: humanize(deployment.rolloutPhase),
                    })
                  : t("updates.rolloutAll")}
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">
                {t("updates.detail.started")}
              </dt>
              <dd className="text-sm font-medium">
                {new Date(deployment.createdAt).toLocaleString(locale)}
              </dd>
            </div>
          </dl>
          {deployment.pauseReason && (
            <Alert role="status">
              <AlertTitle>{t("updates.pausedTitle")}</AlertTitle>
              <AlertDescription>
                {t("updates.pausedDetail", {
                  reason: deployment.pauseReason,
                })}
              </AlertDescription>
            </Alert>
          )}
          <DeploymentMeter {...screenStateCounts(allScreens)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ViewTabs
              label={t("updates.filterLabel")}
              value={filter}
              items={[
                {
                  value: "all",
                  label: t("updates.filter.all", { count: allScreens.length }),
                },
                {
                  value: "attention",
                  label: t("updates.filter.attention", {
                    count: counts.attention,
                  }),
                },
                {
                  value: "progress",
                  label: t("updates.filter.progress", {
                    count: counts.progress,
                  }),
                },
                {
                  value: "done",
                  label: t("updates.filter.done", { count: counts.done }),
                },
              ]}
              onValueChange={(value) => setFilter(value)}
            />
            <Field className="w-52 gap-1">
              <FieldLabel
                htmlFor="deployment-screen-search"
                className="sr-only"
              >
                {t("updates.searchScreens")}
              </FieldLabel>
              <InputGroup>
                <InputGroupAddon>
                  <Search aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id="deployment-screen-search"
                  type="search"
                  value={search}
                  placeholder={t("updates.searchScreens")}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </InputGroup>
            </Field>
          </div>
          <ul className="grid gap-0 divide-y divide-border rounded-xl border border-border">
            {visible.map((item) => (
              <DeploymentScreenRow
                key={item.screenId}
                screen={item}
                artifactSizeBytes={deployment.artifactSizeBytes}
                reachability={reachability.get(item.screenId)}
                manageable={manageable}
                retrying={retry.isPending && retry.variables === item.screenId}
                onRetry={() => retry.mutate(item.screenId)}
              />
            ))}
          </ul>
          {!visible.length && (
            <p className="rounded-xl border border-border bg-muted p-5 text-center text-sm text-muted-foreground">
              {allScreens.length
                ? t("updates.emptyFilter")
                : t("updates.emptyNone")}
            </p>
          )}
        </>
      )}
    </div>
  );
  const footer = manageable && active && (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="flex-1 basis-60 text-sm text-muted-foreground">
        {t("updates.cancelHint")}
      </span>
      <Button
        variant="destructive"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate()}
      >
        {cancel.isPending ? (
          <Spinner />
        ) : (
          <XCircle size={16} aria-hidden="true" />
        )}
        {t("updates.cancel")}
      </Button>
    </div>
  );
  return desktop ? (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        {header}
        {content}
        {footer && (
          <SheetFooter className="border-t border-border">{footer}</SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  ) : (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      showSwipeHandle
    >
      <DrawerContent className="max-h-[calc(100dvh-2rem)]">
        {header}
        {content}
        {footer && (
          <DrawerFooter className="border-t border-border">
            {footer}
          </DrawerFooter>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function DeploymentScreenRow({
  screen,
  artifactSizeBytes,
  reachability,
  manageable,
  retrying,
  onRetry,
}: {
  screen: UpdateDeploymentScreen;
  artifactSizeBytes: number;
  reachability?: string;
  manageable: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const meaning = screenUpdateMeaning(screen.state);
  const detail = screenUpdateDetail(screen);
  const percent = screenDownloadPercent(screen, artifactSizeBytes);
  const attentionClassName =
    meaning.bucket !== "attention"
      ? ""
      : meaning.tone === "danger"
        ? "shadow-[inset_3px_0_0_var(--tc-status-danger)]"
        : "shadow-[inset_3px_0_0_var(--tc-status-warning)]";
  return (
    <li
      className={`grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] ${attentionClassName}`}
    >
      <div className="deployment-screen__identity grid gap-0.5">
        <strong className="text-sm font-semibold">{screen.screenName}</strong>
        <small className="text-xs text-muted-foreground">
          {screen.previousVersionCode
            ? `${screen.previousVersionCode} → ${screen.expectedVersionCode}`
            : t("updates.firstInstall", {
                version: screen.expectedVersionCode,
              })}
          {reachability && ` · ${humanize(reachability)}`}
        </small>
      </div>
      <div className="deployment-screen__status grid justify-items-start gap-1">
        <StatusDot tone={meaning.tone} label={meaning.label} />
        {screen.isCanary && (
          <Badge variant="secondary">{t("updates.canary")}</Badge>
        )}
        {detail && (
          <small className="text-xs text-muted-foreground">{detail}</small>
        )}
        {percent !== null && (
          <span className="grid w-full gap-0.5">
            <progress value={percent} max={100} className="w-full" />
            <small className="text-xs text-muted-foreground">
              {t("updates.downloadProgress", {
                percent,
                size: formatBytes(artifactSizeBytes),
              })}
            </small>
          </span>
        )}
        {/* A finished screen needs no trail: every step is behind it, and drawing
            four dots under "Updated" only adds noise to the healthy rows. */}
        {meaning.stage >= 0 && meaning.bucket !== "done" && (
          <StageTrail stage={meaning.stage} />
        )}
      </div>
      <div className="flex flex-col items-end gap-1.5 max-sm:flex-row max-sm:items-center max-sm:justify-between">
        <time
          dateTime={screen.updatedAt}
          title={new Date(screen.updatedAt).toLocaleString(locale)}
          className="text-xs text-muted-foreground"
        >
          {formatRelative(screen.updatedAt, t)}
        </time>
        {manageable && screen.state === "failed" && (
          <Button
            variant="secondary"
            size="sm"
            disabled={retrying}
            onClick={onRetry}
          >
            {retrying ? (
              <Spinner />
            ) : (
              <RefreshCw size={14} aria-hidden="true" />
            )}{" "}
            {t("common:actions.retry")}
          </Button>
        )}
      </div>
    </li>
  );
}

// The trail names the step rather than drawing a bar, because only the download
// step knows a real percentage.
function StageTrail({ stage }: { stage: number }) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <ol className="flex flex-wrap gap-2" aria-label={t("updates.stageTrail")}>
      {screenUpdateStages.map((stageKey, index) => (
        <li
          key={stageKey}
          className={
            index < stage
              ? "is-complete text-xs font-medium"
              : index === stage
                ? "is-current text-xs font-medium text-primary"
                : "is-pending text-xs text-muted-foreground"
          }
          aria-current={index === stage ? "step" : undefined}
        >
          <span aria-hidden="true" />
          {t(stageKey)}
        </li>
      ))}
    </ol>
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
  }).filter((segment) => segment.count > 0);
  const total = Math.max(1, targetCount);
  return (
    <div className="grid gap-1.5">
      <div
        className={
          compact
            ? "flex h-1.5 overflow-hidden rounded-full border border-border bg-muted"
            : "flex h-2 overflow-hidden rounded-full border border-border bg-muted"
        }
        role="img"
        aria-label={
          targetCount
            ? segments
                .map((segment) => `${segment.count} ${segment.label}`)
                .join(", ")
            : t("updates.noScreens")
        }
      >
        {segments.map((segment) => (
          <span
            key={segment.key}
            className={segmentFillClass(segment.tone)}
            style={{ width: `${(segment.count / total) * 100}%` }}
          />
        ))}
      </div>
      {!compact && (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
          {segments.map((segment) => (
            <li key={segment.key} className="inline-flex items-center">
              <Badge {...statusBadgeAppearance(segment.tone)}>
                {segment.count} {segment.label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function statusBadgeAppearance(tone: ScreenUpdateTone) {
  const variants = {
    success: "secondary",
    info: "outline",
    warning: "outline",
    danger: "destructive",
    neutral: "outline",
  } as const;
  const colors = {
    success: "text-[var(--tc-status-success)]",
    info: "text-[var(--tc-status-info)]",
    warning: "text-[var(--tc-status-warning)]",
    danger: "",
    neutral: "text-[var(--tc-status-neutral)]",
  } as const;
  return { variant: variants[tone], className: colors[tone] };
}

function segmentFillClass(tone: string) {
  switch (tone) {
    case "success":
      return "bg-[var(--tc-status-success)]";
    case "warning":
      return "bg-[var(--tc-status-warning)]";
    case "danger":
      return "bg-[var(--tc-status-danger)]";
    default:
      return "bg-[var(--tc-status-neutral)]";
  }
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function formatBytes(value: number) {
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatRelative(value: string, t: TFunction<["settings", "common"]>) {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return t("updates.relativeNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("updates.relativeMinutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("updates.relativeHours", { count: hours });
  return t("updates.relativeDays", { count: Math.round(hours / 24) });
}
