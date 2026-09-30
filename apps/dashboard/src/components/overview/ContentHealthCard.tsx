import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, CircleAlert, CircleCheck } from "lucide-react";
import type { ContentHealthReport } from "../../api/types";
import { buildActivityLink } from "../../pages/activityLinks";
import { Alert, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { buttonVariants } from "../ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../ui/item";
import { Skeleton } from "../ui/skeleton";

/**
 * A count per kind of content problem, each row opening the Content Health
 * report that lists them. Empty playlists and stale data sources are faults
 * that can put wrong or missing content on a screen. Expiring media and
 * unassigned screens are the report's own "not a fault yet" and "setup"
 * findings, so they read as notices.
 */
export function ContentHealthCard({
  report,
  isLoading,
  isError,
}: {
  report?: ContentHealthReport;
  isLoading: boolean;
  isError: boolean;
}) {
  const { t } = useTranslation("activity");
  const destination = buildActivityLink("content-health");
  const rows = report
    ? [
        {
          key: "emptyPlaylists",
          count: report.emptyPlaylists.length,
          title: t("operations.content.emptyPlaylists"),
          detail: t("operations.content.affecting", {
            screens: t("contentHealth.screens", {
              count: report.emptyPlaylists.reduce(
                (sum, playlist) => sum + playlist.screenCount,
                0,
              ),
            }),
          }),
          variant: "destructive" as const,
        },
        {
          key: "staleSources",
          count: report.staleSources.length,
          title: t("operations.content.staleSources"),
          detail: t("operations.content.staleDetail", {
            hours: t("contentHealth.hoursAfter", {
              count: report.thresholds.staleSourceHours,
            }),
          }),
          variant: "destructive" as const,
        },
        {
          key: "expiringAssets",
          count: report.expiringAssets.length,
          title: t("operations.content.expiringAssets"),
          detail: [
            t("operations.content.expiringDetail", {
              days: t("contentHealth.days", {
                count: report.thresholds.expiringMediaDays,
              }),
            }),
            t("operations.content.expiringInUse", {
              value: report.expiringAssets.filter((asset) => asset.inUse)
                .length,
            }),
          ].join(" · "),
          variant: "secondary" as const,
        },
        {
          key: "unassignedScreens",
          count: report.unassignedScreens.length,
          title: t("operations.content.unassignedScreens"),
          detail: t("operations.content.unassignedDetail"),
          variant: "outline" as const,
        },
      ].filter((row) => row.count > 0)
    : [];
  return (
    <Card size="sm" role="region" aria-labelledby="content-health-heading">
      <CardHeader>
        <CardTitle id="content-health-heading" role="heading" aria-level={2}>
          {t("operations.content.title")}
        </CardTitle>
        <CardAction>
          <Link
            className={buttonVariants({
              variant: "ghost",
              size: "sm",
              className: "max-sm:h-10",
            })}
            to={destination}
          >
            {t("operations.content.details")}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div role="status" aria-label={t("operations.content.loading")}>
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError || !report ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("operations.content.failed")}</AlertTitle>
          </Alert>
        ) : rows.length === 0 ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <CircleCheck
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t("operations.content.healthy")}
          </p>
        ) : (
          <ItemGroup className="gap-0.5">
            {rows.map((row) => (
              <Item
                key={row.key}
                size="sm"
                render={<Link to={destination} />}
                className="min-h-11 px-2"
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="max-w-full">{row.title}</ItemTitle>
                  <ItemDescription className="line-clamp-2">
                    {row.detail}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant={row.variant}>{row.count}</Badge>
                  <ChevronRight
                    className="size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}
