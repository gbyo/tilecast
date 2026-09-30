import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { CircleAlert, RefreshCw } from "lucide-react";
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
  ItemTitle,
} from "../ui/item";
import { Skeleton } from "../ui/skeleton";
import { updateDeploymentStatusKey, type UpdateSummary } from "./updates";

/**
 * Loud only when a person has something to do. A finished deployment, or none
 * at all, is one quiet line.
 */
export function PlayerUpdatesCard({
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
    <Card
      size="sm"
      role="region"
      aria-labelledby="updates-heading"
      className={needsAction ? "ring-destructive/30" : undefined}
    >
      <CardHeader>
        <CardTitle id="updates-heading" role="heading" aria-level={2}>
          {t("operations.updatesTitle")}
        </CardTitle>
        <CardAction>
          <Link
            className={buttonVariants({
              variant: "ghost",
              size: "sm",
              className: "max-sm:h-10",
            })}
            to="/settings/player/updates"
          >
            {t("operations.updateCenter")}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div role="status" aria-label={t("operations.updatesLoading")}>
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("operations.updatesFailed")}</AlertTitle>
          </Alert>
        ) : !summary || !deployment ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <RefreshCw className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {t("operations.noDeployments")}
          </p>
        ) : (
          <Item
            size="sm"
            variant={needsAction ? "default" : "muted"}
            render={<Link to="/settings/player/updates" />}
            className="min-h-11 px-2"
          >
            <ItemContent className="min-w-0">
              <ItemTitle className="max-w-full">{deployment.name}</ItemTitle>
              <ItemDescription className="line-clamp-2">
                {t("operations.updateVersion", {
                  version: deployment.versionName,
                  status: t(updateDeploymentStatusKey(deployment.status)),
                })}
              </ItemDescription>
              <p className="text-xs text-muted-foreground">
                {[
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
              </p>
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
      </CardContent>
    </Card>
  );
}
