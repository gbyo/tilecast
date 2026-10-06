import { scheduleQueries } from "../data/schedules";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";

const canManage = (role?: string) =>
  role === "owner" || role === "administrator";

export function SchedulesPage() {
  const auth = useAuth();
  const { t } = useTranslation("schedules");
  const formatLocale = useFormatLocale();
  const q = useInfiniteQuery(scheduleQueries.pages());
  const schedules = q.data?.pages.flatMap((page) => page.items) ?? [];
  const enabledCount = schedules.filter((schedule) => schedule.enabled).length;
  const totalSchedules = q.data?.pages[0]?.total ?? 0;
  return (
    <section className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("page.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("page.subtitle")}
          </p>
        </div>
        {canManage(auth.status?.user?.role) && (
          <div className="flex flex-wrap items-center gap-2">
            <Link to="/schedules/new" className={buttonVariants()}>
              {t("page.create")}
            </Link>
          </div>
        )}
      </header>
      <section className="grid gap-1 rounded-xl border border-border p-4">
        <h2 className="text-base font-semibold">{t("page.timelineTitle")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("page.timelineSummary", {
            count: enabledCount,
            loaded: schedules.length,
            total: totalSchedules,
          })}
        </p>
      </section>
      {q.isLoading && (
        <div className="grid gap-2" aria-label={t("page.loading")}>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {q.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("page.loadError")}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-2">
        {schedules.map((schedule) => (
          <Link
            className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-border p-3 hover:bg-muted ${schedule.enabled ? "" : "opacity-60"}`}
            to={`/schedules/${schedule.id}`}
            key={schedule.id}
          >
            <span className="grid min-w-0 gap-0.5">
              <strong className="truncate text-sm">{schedule.name}</strong>
              <small className="truncate text-xs text-muted-foreground">
                {schedule.enabled ? t("page.enabled") : t("page.disabled")}
              </small>
            </span>
            <span className="text-sm">{schedule.playlistName}</span>
            <span className="text-sm text-muted-foreground">
              {schedule.targets.map((target) => target.name).join(", ")}
            </span>
            <span className="text-sm text-muted-foreground">
              {schedule.type === "weekly"
                ? `${schedule.dailyStart}–${schedule.dailyEnd} · ${schedule.timezone}`
                : `${new Date(schedule.oneTimeStart!).toLocaleString(formatLocale)}–${new Date(schedule.oneTimeEnd!).toLocaleString(formatLocale)}`}
            </span>
            <Badge variant="secondary">
              {t("page.priorityBadge", { priority: schedule.priority })}
            </Badge>
          </Link>
        ))}
        {schedules.length === 0 && !q.isLoading && (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{t("page.emptyTitle")}</EmptyTitle>
              <EmptyDescription>{t("page.emptyDescription")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
      {q.hasNextPage && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            {q.isFetchingNextPage ? t("page.loading") : t("page.loadMore")}
          </Button>
        </div>
      )}
    </section>
  );
}

export { ScheduleEditorPage } from "../schedules/ScheduleBuilder";
