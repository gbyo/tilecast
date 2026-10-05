import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Alert, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "../ui/item";
import { Skeleton } from "../ui/skeleton";
import { rowBleed } from "./layout";
import { LoadReveal } from "./LoadReveal";
import { RailSection } from "./RailSection";
import { updateDeploymentStatusKey, type UpdateSummary } from "./updates";

/**
 * Loud only when a person has something to do. A finished deployment, or none
 * at all, is one quiet line.
 */
export function PlayerUpdatesSection({
  summary,
  isLoading,
  isError,
}: {
  summary?: UpdateSummary;
  isLoading: boolean;
  isError: boolean;
}) {
  const { t } = useTranslation("activity");
  const needsAction = !isLoading && !isError && (summary?.needsAction ?? 0) > 0;
  const deployment = summary?.deployment;
  return (
    <RailSection
      id="updates-heading"
      title={t("operations.updatesTitle")}
      action={{
        label: t("operations.updateCenter"),
        to: "/settings/player/updates",
      }}
    >
      <LoadReveal
        loading={isLoading}
        skeleton={
          <div role="status" aria-label={t("operations.updatesLoading")}>
            <Skeleton className="h-11 w-full" />
          </div>
        }
      >
        {isError ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("operations.updatesFailed")}</AlertTitle>
          </Alert>
        ) : !summary || !deployment ? (
          <p className="flex items-start gap-2 py-1 text-sm text-muted-foreground">
            <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("operations.noDeployments")}
          </p>
        ) : (
          <Item
            size="xs"
            render={<Link to="/settings/player/updates" />}
            className={`${rowBleed} -mx-(--card-spacing) w-auto`}
          >
            <ItemContent className="min-w-0 gap-0">
              <ItemTitle className="max-w-full">{deployment.name}</ItemTitle>
              <ItemDescription className="line-clamp-1">
                {[
                  t("operations.updateVersion", {
                    version: deployment.versionName,
                    status: t(updateDeploymentStatusKey(deployment.status)),
                  }),
                  t("operations.updateProgress", {
                    succeeded: deployment.succeededCount,
                    target: deployment.targetCount,
                  }),
                  summary.failed > 0
                    ? t("operations.updateFailedCount", {
                        value: summary.failed,
                      })
                    : undefined,
                  summary.waiting > 0
                    ? t("operations.updateWaitingCount", {
                        value: summary.waiting,
                      })
                    : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              {needsAction ? (
                <Badge variant="destructive">
                  {t("operations.needAction", { count: summary.needsAction })}
                </Badge>
              ) : deployment.status === "completed" ? (
                <Badge variant="outline">{t("operations.upToDate")}</Badge>
              ) : null}
            </ItemActions>
          </Item>
        )}
      </LoadReveal>
    </RailSection>
  );
}
