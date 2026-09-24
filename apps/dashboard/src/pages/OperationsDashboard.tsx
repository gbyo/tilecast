import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  CircleAlert,
  MonitorCheck,
  RefreshCw,
} from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { translateKnown } from "../i18n";
import { api } from "../api/client";
import type {
  Schedule,
  Screen,
  ScreenStatus,
  UpdateDeployment,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { FleetUptimePanel } from "../components/FleetUptimePanel";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Skeleton } from "../components/ui/skeleton";

// Status structures hold translation keys, never rendered text. Labels are
// resolved with t() at render so the dashboard follows language changes.
const statusLabelKeys: Record<
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

function statusVariant(status: ScreenStatus) {
  if (status === "offline" || status === "stale") return "destructive" as const;
  if (status === "recent") return "secondary" as const;
  return "outline" as const;
}

export function OperationsDashboard() {
  const { t } = useTranslation("activity");
  const auth = useAuth();
  const screens = useQuery({
    queryKey: ["screens"],
    queryFn: api.screens,
    refetchInterval: 10_000,
  });
  const schedules = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.schedules(),
  });
  const deployments = useQuery({
    queryKey: ["update-deployments"],
    queryFn: api.updateDeployments,
    refetchInterval: 15_000,
  });

  const allScreens = screens.data?.items ?? [];
  const online = allScreens.filter((screen) => screen.status === "online");
  const attention = allScreens.filter(
    (screen) => screen.status !== "online" || Boolean(screen.updateError),
  );
  const playingNow = allScreens.filter((screen) =>
    Boolean(screen.nowPlayingName),
  );
  const activeSchedules = (schedules.data?.items ?? []).filter(
    (schedule) => schedule.enabled,
  );
  const updateActions = (deployments.data?.items ?? []).reduce(
    (total, deployment) =>
      total + deployment.waitingForUserCount + deployment.failedCount,
    0,
  );
  const latestDeployment = deployments.data?.items[0];
  const nextChange = nextScheduleChange(activeSchedules);
  const canPair =
    auth.status?.user?.role === "owner" ||
    auth.status?.user?.role === "administrator";
  const emptyInstallation =
    !screens.isLoading && !screens.isError && allScreens.length === 0;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("operations.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("operations.subtitle")}
        </p>
      </header>

      {screens.isError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("operations.loadFailed")}</AlertTitle>
          <AlertDescription>{t("shared.refreshHint")}</AlertDescription>
        </Alert>
      )}

      {screens.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="rounded-xl border bg-card p-4">
              <Skeleton className="h-7 w-20" />
              <Skeleton className="mt-3 h-4 w-28" />
            </div>
          ))}
        </div>
      ) : !screens.isError && !emptyInstallation ? (
        <section
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          aria-label={t("operations.statusLabel")}
        >
          <Summary
            value={`${online.length}/${allScreens.length}`}
            label={t("operations.summaries.online")}
          />
          <Summary
            value={String(attention.length)}
            label={t("operations.summaries.attention")}
          />
          <Summary
            value={String(playingNow.length)}
            label={t("operations.summaries.playing")}
          />
          <Summary
            value={
              nextChange
                ? formatCompactScheduleTime(nextChange.at)
                : t("operations.noneValue")
            }
            label={t("operations.summaries.next")}
            detail={nextChange?.schedule.name ?? t("operations.noSchedule")}
          />
        </section>
      ) : null}

      {emptyInstallation ? (
        <Empty className="min-h-64 rounded-xl border border-dashed bg-card px-6 py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MonitorCheck aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("operations.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("operations.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {canPair ? (
              <Link
                className={buttonVariants({ variant: "default" })}
                to="/screens/pair"
              >
                {t("operations.pairScreen")}
              </Link>
            ) : (
              <p className="text-muted-foreground">
                {t("operations.pairHint")}
              </p>
            )}
          </EmptyContent>
        </Empty>
      ) : null}

      {!emptyInstallation && (
        <div className="grid items-start gap-x-10 gap-y-8 xl:grid-cols-[minmax(0,1.6fr)_minmax(18rem,0.8fr)]">
          <div className="min-w-0 space-y-8">
            {!screens.isError && <FleetUptimePanel />}
            {!screens.isError && <NeedsAttention screens={attention} />}
          </div>
          <aside className="min-w-0 space-y-8">
            <ComingUp
              schedulesError={schedules.isError}
              nextChange={nextChange}
            />
            <PlayerUpdates
              isError={deployments.isError}
              latest={latestDeployment}
              actionCount={updateActions}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

function Summary({
  value,
  label,
  detail,
}: {
  value: string;
  label: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card px-4 py-3.5">
      <div className="truncate text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </div>
      <div className="mt-1 text-sm font-medium">{label}</div>
      {detail && (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {detail}
        </div>
      )}
    </div>
  );
}

function NeedsAttention({ screens }: { screens: Screen[] }) {
  const { t } = useTranslation("activity");
  return (
    <section className="space-y-3" aria-labelledby="attention-heading">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 id="attention-heading" className="text-base font-semibold">
            {t("operations.attentionTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("operations.attentionDescription")}
          </p>
        </div>
        <Link
          className="shrink-0 text-sm underline underline-offset-4"
          to="/screens"
        >
          {t("operations.allScreens")}
        </Link>
      </div>
      {screens.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          {t("operations.allOnline")}
        </p>
      ) : (
        <ItemGroup className="gap-1">
          {screens.slice(0, 6).map((screen) => (
            <Item
              key={screen.id}
              size="sm"
              render={<Link to={`/screens/${screen.id}`} />}
              className="rounded-xl px-2 py-2.5"
            >
              <ItemContent className="min-w-0 flex-row items-center justify-between gap-3">
                <div className="min-w-0">
                  <ItemTitle className="max-w-full">{screen.name}</ItemTitle>
                  <ItemDescription className="mt-0.5">
                    {t("operations.lastContact", {
                      location: screen.location || t("operations.noLocation"),
                      relative: formatRelative(screen.lastContactAt),
                    })}
                  </ItemDescription>
                </div>
                <ItemActions>
                  <Badge variant={statusVariant(screen.status)}>
                    {t(statusLabelKeys[screen.status])}
                  </Badge>
                </ItemActions>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {screens.length > 6 && (
        <p className="text-xs text-muted-foreground">
          {t("operations.showingMore", { count: screens.length })}
        </p>
      )}
    </section>
  );
}

function ComingUp({
  schedulesError,
  nextChange,
}: {
  schedulesError: boolean;
  nextChange?: { schedule: Schedule; at: Date };
}) {
  const { t } = useTranslation("activity");
  return (
    <section className="space-y-3" aria-labelledby="coming-up-heading">
      <div>
        <h2 id="coming-up-heading" className="text-base font-semibold">
          {t("operations.comingTitle")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("operations.comingDescription")}
        </p>
      </div>
      {schedulesError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("operations.schedulesFailed")}</AlertTitle>
        </Alert>
      ) : nextChange ? (
        <Item
          size="sm"
          variant="muted"
          render={<Link to={`/schedules/${nextChange.schedule.id}`} />}
          className="rounded-xl px-3 py-3"
        >
          <ItemContent>
            <ItemTitle>{nextChange.schedule.name}</ItemTitle>
            <ItemDescription>
              {nextChange.schedule.playlistName} ·{" "}
              {targetLabel(nextChange.schedule, t)}
            </ItemDescription>
            <p className="text-xs font-medium text-foreground">
              {formatScheduleTime(nextChange.at)}
            </p>
          </ItemContent>
          <ItemActions>
            <CalendarClock
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          </ItemActions>
        </Item>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">
          {t("operations.noUpcoming")}
        </p>
      )}
      <Link className="text-sm underline underline-offset-4" to="/schedules">
        {t("operations.viewSchedules")}
      </Link>
    </section>
  );
}

function PlayerUpdates({
  isError,
  latest,
  actionCount,
}: {
  isError: boolean;
  latest?: UpdateDeployment;
  actionCount: number;
}) {
  const { t } = useTranslation("activity");
  return (
    <section className="space-y-3" aria-labelledby="updates-heading">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 id="updates-heading" className="text-base font-semibold">
            {t("operations.updatesTitle")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("operations.updatesDescription")}
          </p>
        </div>
        <Link
          className="shrink-0 text-sm underline underline-offset-4"
          to="/settings/player/updates"
        >
          {t("operations.updateCenter")}
        </Link>
      </div>
      {isError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("operations.updatesFailed")}</AlertTitle>
        </Alert>
      ) : latest ? (
        <Item size="sm" variant="muted" className="rounded-xl px-3 py-3">
          <ItemContent>
            <ItemTitle>{latest.name}</ItemTitle>
            <ItemDescription>
              {t("operations.updateVersion", {
                version: latest.versionName,
                status: humanize(latest.status),
              })}
            </ItemDescription>
            <p className="text-xs text-muted-foreground">
              {t("operations.updateProgress", {
                succeeded: latest.succeededCount,
                target: latest.targetCount,
              })}
            </p>
          </ItemContent>
          <ItemActions>
            {actionCount > 0 ? (
              <Badge variant="destructive">
                {t("operations.needAction", { count: actionCount })}
              </Badge>
            ) : (
              <Badge variant="outline">{t("operations.upToDate")}</Badge>
            )}
          </ItemActions>
        </Item>
      ) : (
        <div className="flex items-start gap-2 py-2 text-sm text-muted-foreground">
          <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>{t("operations.noDeployments")}</p>
        </div>
      )}
    </section>
  );
}

function formatRelative(value?: string) {
  if (!value)
    return translateKnown("activity:operations.relative.never", "Never");
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60)
    return translateKnown("activity:operations.relative.justNow", "just now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return translateKnown(
      "activity:operations.relative.minutesAgo",
      "{{value}}m ago",
      { value: minutes },
    );
  const hours = Math.round(minutes / 60);
  if (hours < 24)
    return translateKnown(
      "activity:operations.relative.hoursAgo",
      "{{value}}h ago",
      {
        value: hours,
      },
    );
  return translateKnown(
    "activity:operations.relative.daysAgo",
    "{{value}}d ago",
    {
      value: Math.round(hours / 24),
    },
  );
}

function nextScheduleChange(schedules: Schedule[]) {
  const now = new Date();
  const candidates: { schedule: Schedule; at: Date }[] = [];
  for (const schedule of schedules) {
    if (schedule.type === "one_time" && schedule.oneTimeStart) {
      const at = new Date(schedule.oneTimeStart);
      if (at > now) candidates.push({ schedule, at });
      continue;
    }
    if (!schedule.dailyStart || schedule.daysOfWeek.length === 0) continue;
    const [hour = 0, minute = 0] = schedule.dailyStart.split(":").map(Number);
    for (let offset = 0; offset < 8; offset += 1) {
      const at = new Date(now);
      at.setDate(now.getDate() + offset);
      at.setHours(hour, minute, 0, 0);
      if (at > now && schedule.daysOfWeek.includes(at.getDay())) {
        candidates.push({ schedule, at });
        break;
      }
    }
  }
  return candidates.sort((a, b) => a.at.getTime() - b.at.getTime())[0];
}

function targetLabel(schedule: Schedule, t: TFunction<"activity">) {
  if (schedule.targets.length === 0)
    return translateKnown("activity:operations.targetsNone", "no targets");
  if (schedule.targets.length === 1)
    return (
      schedule.targets[0]?.name ??
      translateKnown("activity:operations.targetSingle", "1 target")
    );
  return t("operations.targets", { count: schedule.targets.length });
}

function formatCompactScheduleTime(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function formatScheduleTime(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
