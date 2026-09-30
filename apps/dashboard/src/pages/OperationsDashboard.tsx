import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, MonitorCheck } from "lucide-react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import {
  getActivityOverview,
  getPlaybackCompliance,
  listIncidents,
} from "../api/domains/activity";
import { useAuth } from "../auth/AuthProvider";
import { FleetUptimePanel } from "../components/FleetUptimePanel";
import {
  deriveAttention,
  summarizeFleet,
} from "../components/overview/attention";
import { ContentHealthSection } from "../components/overview/ContentHealthSection";
import {
  FleetStatus,
  FleetStatusSkeleton,
  type ConfirmedPlaying,
} from "../components/overview/FleetStatus";
import {
  LastDayCard,
  type QueryStatus,
} from "../components/overview/LastDayCard";
import { NeedsAttention } from "../components/overview/NeedsAttention";
import { OnAirSection } from "../components/overview/OnAirSection";
import { PlayerUpdatesSection } from "../components/overview/PlayerUpdatesSection";
import { UpcomingSection } from "../components/overview/UpcomingSection";
import { upcomingChanges } from "../components/overview/upcoming";
import { summarizeUpdates } from "../components/overview/updates";
import { useNow } from "../components/overview/format";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Card } from "../components/ui/card";
import { buttonVariants } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

function status(query: { isLoading: boolean; isError: boolean }): QueryStatus {
  return query.isLoading ? "loading" : query.isError ? "error" : "ready";
}

function lastDay() {
  const to = new Date();
  return {
    from: new Date(to.getTime() - 24 * 3_600_000).toISOString(),
    to: to.toISOString(),
  };
}

/**
 * The operational home. Live state comes first (is the fleet up, what is
 * wrong, what is on air, what is next), then a short measured summary of the
 * last day, then maintenance, then the uptime chart. Every query stands on
 * its own: a failed or slow one degrades its own card and leaves the rest
 * working.
 */
export function OperationsDashboard() {
  const { t } = useTranslation("activity");
  const auth = useAuth();
  const now = useNow();
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
  const incidents = useQuery({
    queryKey: ["activity", "incidents", "active"],
    queryFn: () => listIncidents({ status: "active" }),
    refetchInterval: 30_000,
  });
  const overview = useQuery({
    queryKey: ["activity", "overview", "home", "24h"],
    queryFn: () => getActivityOverview(lastDay()),
    refetchInterval: 60_000,
  });
  const compliance = useQuery({
    queryKey: ["activity", "compliance", "home", "24h"],
    queryFn: () => getPlaybackCompliance({ ...lastDay(), dimension: "reason" }),
    refetchInterval: 300_000,
  });
  const contentHealth = useQuery({
    queryKey: ["content-health"],
    queryFn: api.contentHealth,
    refetchInterval: 60_000,
  });

  const allScreens = useMemo(() => screens.data?.items ?? [], [screens.data]);
  const attention = useMemo(
    () => deriveAttention(allScreens, incidents.data?.items ?? []),
    [allScreens, incidents.data],
  );
  const summary = useMemo(() => summarizeFleet(allScreens), [allScreens]);
  const upcoming = useMemo(
    () =>
      upcomingChanges(
        (schedules.data?.items ?? []).filter((schedule) => schedule.enabled),
        now,
        schedules.data?.defaultTimezone,
      ),
    [schedules.data, now],
  );
  const updates = useMemo(
    () => summarizeUpdates(deployments.data?.items ?? []),
    [deployments.data],
  );

  const fleet = overview.data?.fleet;
  const confirmed: ConfirmedPlaying = overview.isLoading
    ? { state: "loading" }
    : overview.isError || !fleet
      ? { state: "unavailable" }
      : { state: "ready", playing: fleet.healthy, measured: fleet.measured };

  const canPair =
    auth.status?.user?.role === "owner" ||
    auth.status?.user?.role === "administrator";
  const emptyInstallation =
    !screens.isLoading && !screens.isError && allScreens.length === 0;

  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-4">
      <header className="grid gap-0.5">
        <h1 className="text-xl leading-tight font-semibold tracking-tight sm:text-2xl">
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

      {emptyInstallation ? (
        <Empty className="min-h-0 rounded-xl border border-dashed bg-card px-6 py-8">
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
      ) : (
        <>
          {screens.isLoading && <FleetStatusSkeleton />}
          {!screens.isLoading && !screens.isError && (
            <FleetStatus
              summary={summary}
              attentionCount={attention.length}
              attentionPending={incidents.isLoading}
              confirmed={confirmed}
            />
          )}

          {/* One DOM order at every width. Once the content area (not the
              window) is wide enough, the page is a primary column (attention,
              then uptime beside the last-day figures) and a supporting rail
              that spans both rows. The second row takes any extra height, so
              a tall rail never opens a gap under the attention list, and with
              nothing to attend to the uptime row moves up to the top. */}
          <div className="@container/overview">
            <div className="grid items-start gap-4 @min-[40rem]/overview:grid-cols-[minmax(0,1.55fr)_minmax(19rem,0.75fr)] @min-[40rem]/overview:grid-rows-[auto_1fr]">
              {!screens.isLoading && !screens.isError && (
                <div className="min-w-0 empty:hidden @min-[40rem]/overview:col-start-1">
                  <NeedsAttention
                    items={attention}
                    incidentsFailed={incidents.isError}
                  />
                </div>
              )}
              <Card
                size="sm"
                className="min-w-0 gap-0 py-0 @min-[40rem]/overview:col-start-2 @min-[40rem]/overview:row-span-2 @min-[40rem]/overview:row-start-1"
              >
                {!screens.isError && (
                  <>
                    <OnAirSection
                      screens={allScreens}
                      isLoading={screens.isLoading}
                    />
                    <Separator />
                  </>
                )}
                <UpcomingSection
                  changes={upcoming}
                  defaultTimezone={schedules.data?.defaultTimezone ?? "UTC"}
                  isLoading={schedules.isLoading}
                  isError={schedules.isError}
                  loaded={schedules.data?.items.length ?? 0}
                  total={schedules.data?.total ?? 0}
                />
                <Separator />
                <ContentHealthSection
                  report={contentHealth.data}
                  isLoading={contentHealth.isLoading}
                  isError={contentHealth.isError}
                />
                <Separator />
                <PlayerUpdatesSection
                  summary={updates}
                  isLoading={deployments.isLoading}
                  isError={deployments.isError}
                />
              </Card>
              <div className="@container/lower min-w-0 @min-[40rem]/overview:col-start-1">
                <div className="grid items-start gap-4 @min-[42rem]/lower:grid-cols-[minmax(0,1fr)_15rem]">
                  <div className="min-w-0">
                    <FleetUptimePanel />
                  </div>
                  <LastDayCard
                    overview={overview.data}
                    overviewStatus={status(overview)}
                    compliance={compliance.data}
                    complianceStatus={status(compliance)}
                  />
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
