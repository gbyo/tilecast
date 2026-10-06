import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import { CalendarClock, SearchX } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ApiError } from "../../api/client";
import type { Schedule, ScheduleList } from "../../api/types";
import { apiErrorMessage } from "../../i18n";
import { Alert, AlertDescription } from "../ui/alert";
import { Button, buttonVariants } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Spinner } from "../ui/spinner";
import { ScheduleLibrary, ScheduleLibrarySkeleton } from "./ScheduleLibrary";

/**
 * Everything below the toolbar: the load error, then exactly one of the
 * loading preview, the rows with Load more, a filtered-empty answer, or the
 * true-empty library. A failed first load shows no empty state at all, and a
 * failed refetch keeps the rows it already has.
 */
export function ScheduleResults({
  query,
  now,
  narrowed,
  canManage,
  deleting,
  onDelete,
  onClearSearchAndFilters,
}: {
  query: UseInfiniteQueryResult<InfiniteData<ScheduleList>>;
  now: Date;
  /** Search or a facet is active; sort alone does not narrow. */
  narrowed: boolean;
  canManage: boolean;
  deleting: boolean;
  onDelete: (schedule: Schedule) => void;
  onClearSearchAndFilters: () => void;
}) {
  const { t } = useTranslation(["schedules", "common"]);
  const items = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  return (
    <>
      {query.isError && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {query.error instanceof ApiError
                ? apiErrorMessage(query.error)
                : t("page.loadError")}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {query.isLoading ? (
        <ScheduleLibrarySkeleton />
      ) : items.length > 0 ? (
        <>
          <ScheduleLibrary
            items={items}
            now={now}
            canManage={canManage}
            deleting={deleting}
            onDelete={onDelete}
          />
          {query.hasNextPage && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage && <Spinner aria-hidden="true" />}
                {t("common:actions.loadMore")}
              </Button>
            </div>
          )}
        </>
      ) : query.isError ? null : narrowed ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchX aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("page.filteredEmptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("page.filteredEmptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              onClick={onClearSearchAndFilters}
            >
              {t("page.clearSearchAndFilters")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarClock aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("page.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("page.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
          {canManage && (
            <EmptyContent>
              <Link
                className={buttonVariants({ variant: "default" })}
                to="/schedules/new"
              >
                {t("page.create")}
              </Link>
            </EmptyContent>
          )}
        </Empty>
      )}
    </>
  );
}
