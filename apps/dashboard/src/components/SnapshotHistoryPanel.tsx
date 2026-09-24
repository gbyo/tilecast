import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useFormatLocale } from "../i18n";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { buttonVariants } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "./ui/empty";
import { Skeleton } from "./ui/skeleton";

export function SnapshotHistoryPanel({ screenId }: { screenId: string }) {
  const { t } = useTranslation("screens");
  const formatLocale = useFormatLocale();
  const history = useQuery({
    queryKey: ["screen-snapshots", screenId],
    queryFn: () => api.screenSnapshots(screenId),
  });
  const [openId, setOpenId] = useState<string>();

  if (history.isLoading)
    return (
      <div className="space-y-2" aria-label={t("snapshots.label")}>
        <Skeleton className="aspect-video w-full max-w-sm" />
        <p className="text-sm text-muted-foreground">
          {t("snapshots.loading")}
        </p>
      </div>
    );
  if (history.error)
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("snapshots.loadError")}</AlertTitle>
        <AlertDescription>{history.error.message}</AlertDescription>
      </Alert>
    );

  const data = history.data;
  if (!data?.enabled)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("snapshots.disabledTitle")}</EmptyTitle>
          <EmptyDescription>
            <Trans
              i18nKey="snapshots.disabledBody"
              ns="screens"
              components={{
                settingsLink: <Link to="/settings/snapshots" />,
              }}
            />
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  if (!data.items.length)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("snapshots.emptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("snapshots.emptyBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div className="space-y-3" aria-label={t("snapshots.label")}>
      <p className="text-sm text-muted-foreground">
        {t("snapshots.retention", {
          max: data.maxPerScreen,
          days: data.retentionDays,
        })}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {data.items.map((snapshot) => {
          const captured = new Date(snapshot.capturedAt).toLocaleString(
            formatLocale,
          );
          return (
            <figure key={snapshot.id} className="min-w-0 space-y-1">
              <button
                type="button"
                className="block w-full overflow-hidden rounded-xl border border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("snapshots.viewSnapshot", { date: captured })}
                aria-expanded={openId === snapshot.id}
                onClick={() =>
                  setOpenId(openId === snapshot.id ? undefined : snapshot.id)
                }
              >
                <img
                  src={`/api/v1/screens/${screenId}/snapshots/${snapshot.id}/image`}
                  alt={t("snapshots.snapshotAlt", { date: captured })}
                  loading="lazy"
                  className="aspect-video w-full object-cover"
                />
              </button>
              <figcaption className="text-xs text-muted-foreground">
                {captured}
                {snapshot.trigger === "manual"
                  ? t("snapshots.manualSuffix")
                  : ""}
              </figcaption>
              {openId === snapshot.id && (
                <EmptyContent className="items-start">
                  <a
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    href={`/api/v1/screens/${screenId}/snapshots/${snapshot.id}/image`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("snapshots.openFull")}
                  </a>
                </EmptyContent>
              )}
            </figure>
          );
        })}
      </div>
    </div>
  );
}
