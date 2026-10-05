import { useTranslation } from "react-i18next";
import type { components } from "@tilecast/api-schema/generated/openapi";
import { buildActivityLink } from "../../pages/activityLinks";
import { MetricTile } from "../MetricTile";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { HeaderLink } from "./HeaderLink";
import { LoadReveal } from "./LoadReveal";
import { tallTitleRow } from "./layout";

type ActivityOverview = components["schemas"]["ActivityOverview"];
type ComplianceReport = components["schemas"]["ComplianceReport"];

export type QueryStatus = "loading" | "error" | "ready";

const RANGE = { range: "24h" } as const;

/**
 * Playback counts come from sessions Players confirmed. When no screen
 * confirmed any playback in the window, a count of zero would claim nothing
 * failed when the truth is that nothing was measured, so the figure is
 * reported as absent instead.
 */
export function playbackMeasured(cards: ActivityOverview["cards"]) {
  return (
    cards.confirmedScreenPlaybackMs > 0 ||
    cards.playbackFailures > 0 ||
    cards.interruptedPlays > 0
  );
}

function NoValue({ label }: { label: string }) {
  return (
    <span className="text-base font-medium text-muted-foreground">{label}</span>
  );
}

/**
 * Three figures measured over the last 24 hours, each stating that window and
 * linking to the exact records it counted. Live status stays above; this is
 * the short answer to "did playback go as expected while I was not looking".
 */
export function LastDayCard({
  overview,
  overviewStatus,
  compliance,
  complianceStatus,
}: {
  overview?: ActivityOverview;
  overviewStatus: QueryStatus;
  compliance?: ComplianceReport;
  complianceStatus: QueryStatus;
}) {
  const { t } = useTranslation("activity");
  const noData = t("shared.noData");
  const unavailable = t("operations.lastDay.unavailable");

  function tile(
    key: string,
    label: string,
    status: QueryStatus,
    value: string | number | undefined,
    hint: string,
    to: string,
    absentHint?: string,
  ) {
    const absent = status === "error" || value === undefined;
    return (
      <li key={key}>
        <LoadReveal
          loading={status === "loading"}
          skeleton={
            <div className="grid content-start gap-0.5">
              <span role="status" aria-label={t("operations.lastDay.loading")}>
                <Skeleton className="h-7 w-16" />
              </span>
              <span className="text-sm font-medium">{label}</span>
              <Skeleton className="h-4 w-28 max-w-full" />
            </div>
          }
        >
          <MetricTile
            variant="plain"
            label={label}
            value={
              absent ? (
                <NoValue label={status === "error" ? unavailable : noData} />
              ) : (
                value
              )
            }
            hint={
              status === "error"
                ? t("operations.lastDay.failed")
                : absent
                  ? (absentHint ?? hint)
                  : hint
            }
            to={absent ? undefined : to}
          />
        </LoadReveal>
      </li>
    );
  }

  const measured = overview ? playbackMeasured(overview.cards) : false;
  const percent = compliance?.compliancePercent;
  const nothingMeasured =
    overviewStatus === "ready" &&
    complianceStatus === "ready" &&
    !measured &&
    percent == null;
  return (
    <Card
      size="sm"
      role="region"
      aria-labelledby="last-day-heading"
      className="@container/lastday"
    >
      <CardHeader className="gap-0">
        <CardTitle
          id="last-day-heading"
          role="heading"
          aria-level={2}
          className={tallTitleRow}
        >
          {t("operations.lastDay.title")}
        </CardTitle>
        <CardDescription className="@max-xs/lastday:sr-only">
          {t("operations.lastDay.description")}
        </CardDescription>
        <CardAction className="self-center">
          <HeaderLink
            to={buildActivityLink("overview", {}, RANGE)}
            label={t("operations.lastDay.openActivity")}
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        {nothingMeasured ? (
          <p className="text-sm text-muted-foreground">
            {t("operations.lastDay.nothingMeasured")}
          </p>
        ) : (
          <ul className="grid gap-x-3 gap-y-4 @md/lastday:grid-cols-3">
            {tile(
              "compliance",
              t("compliance.tiles.compliance"),
              complianceStatus,
              percent == null ? undefined : `${percent.toFixed(1)}%`,
              t("compliance.tiles.complianceHint"),
              buildActivityLink("overview", {}, RANGE),
              t("operations.lastDay.complianceNone"),
            )}
            {tile(
              "failures",
              t("overview.metrics.playbackFailures"),
              overviewStatus,
              overview && measured
                ? overview.cards.playbackFailures
                : undefined,
              t("operations.lastDay.failuresHint"),
              buildActivityLink("proof", { result: "failed" }, RANGE),
              t("operations.lastDay.noPlayback"),
            )}
            {tile(
              "interruptions",
              t("overview.metrics.interruptedPlays"),
              overviewStatus,
              overview && measured
                ? overview.cards.interruptedPlays
                : undefined,
              t("overview.metrics.interruptedPlaysHint"),
              buildActivityLink(
                "proof",
                { terminalReason: "unexpected" },
                RANGE,
              ),
              t("operations.lastDay.noPlayback"),
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
