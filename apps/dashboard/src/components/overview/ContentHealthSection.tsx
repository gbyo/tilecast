import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, CircleAlert, CircleCheck } from "lucide-react";
import type { ContentHealthReport } from "../../api/types";
import { buildActivityLink } from "../../pages/activityLinks";
import { Alert, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../ui/item";
import { Skeleton } from "../ui/skeleton";
import { listBleed, rowBleed } from "./layout";
import { LoadReveal } from "./LoadReveal";
import { RailSection } from "./RailSection";

/**
 * A count per kind of content problem, each row opening the Content Health
 * report that lists them. Empty playlists and stale data sources are faults
 * that can put wrong or missing content on a screen. Expiring media and
 * unassigned screens are the report's own "not a fault yet" and "setup"
 * findings, so they read as notices.
 */
export function ContentHealthSection({
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
    <RailSection
      id="content-health-heading"
      title={t("operations.content.title")}
      action={{ label: t("operations.content.details"), to: destination }}
    >
      <LoadReveal
        loading={isLoading}
        skeleton={
          <div role="status" aria-label={t("operations.content.loading")}>
            <Skeleton className="h-[45px] w-full" />
          </div>
        }
      >
        {isError || !report ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("operations.content.failed")}</AlertTitle>
          </Alert>
        ) : rows.length === 0 ? (
          <p className="flex items-start gap-2 py-1 text-sm text-muted-foreground">
            <CircleCheck
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {t("operations.content.healthy")}
          </p>
        ) : (
          <ItemGroup className={listBleed}>
            {rows.map((row) => (
              <Item
                key={row.key}
                size="xs"
                render={<Link to={destination} />}
                className={rowBleed}
              >
                <ItemContent className="min-w-0 gap-0">
                  <ItemTitle className="max-w-full">{row.title}</ItemTitle>
                  <ItemDescription className="line-clamp-1">
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
      </LoadReveal>
    </RailSection>
  );
}
