import { useInfiniteQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { ScheduleListParams, AuthStatus } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useNow } from "../components/overview/format";
import { ScheduleResults } from "../components/schedules/ScheduleResults";
import {
  isScheduleListNarrowed,
  scheduleFacets,
  type ScheduleFacetKey,
} from "../components/schedules/scheduleLibraryModel";
import { SchedulesToolbar } from "../components/schedules/SchedulesToolbar";
import { useScheduleDeletion } from "../components/schedules/useScheduleDeletion";
import { buttonVariants } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { defaultScheduleListParams, scheduleQueries } from "../data/schedules";
import { useCompactLayout } from "../hooks/use-compact-layout";
import { hasCapability } from "../auth/capabilities";
import {
  CollectionPage,
  CollectionSurface,
} from "../components/collection/CollectionPage";

const canManage = (status?: AuthStatus) =>
  hasCapability(status, "schedule.edit");

export function SchedulesPage() {
  const auth = useAuth();
  const { t } = useTranslation("schedules");
  const compact = useCompactLayout();
  const now = useNow();
  const manager = canManage(auth.status);
  const { requestDelete, deleting, dialog } = useScheduleDeletion();
  // Search, every facet, and the sort are all server inputs and all restart
  // paging, so they travel together as the query's params.
  const [params, setParams] = useState<ScheduleListParams>(
    defaultScheduleListParams,
  );
  const schedules = useInfiniteQuery(scheduleQueries.pages(params));
  // The server total for this query, not the loaded count: paging may have
  // fetched only part of it.
  const total = schedules.data?.pages.at(-1)?.total;
  const createLabel = t("page.create");

  return (
    <CollectionPage
      title={t("page.title")}
      description={t("page.description")}
      meta={
        typeof total === "number" ? (
          t("page.count", { count: total })
        ) : schedules.isLoading ? (
          <Skeleton className="h-5 w-24" />
        ) : undefined
      }
      actions={
        manager ? (
          <Link
            className={buttonVariants({ variant: "default" })}
            to="/schedules/new"
            aria-label={compact ? createLabel : undefined}
          >
            <Plus aria-hidden="true" />
            {compact ? t("page.createShort") : createLabel}
          </Link>
        ) : undefined
      }
    >
      {dialog}
      <SchedulesToolbar
        search={params.search}
        onSearchChange={(search) =>
          setParams((current) => ({ ...current, search }))
        }
        facets={scheduleFacets(params)}
        onFacetChange={(key: ScheduleFacetKey, value) =>
          setParams((current) => ({ ...current, [key]: value }))
        }
        onClearFacets={() =>
          setParams((current) => ({
            ...current,
            enabled: "",
            type: "",
            presentationType: "",
          }))
        }
        sort={params.sort}
        onSortChange={(sort) => setParams((current) => ({ ...current, sort }))}
      />
      <CollectionSurface>
        <ScheduleResults
        query={schedules}
        now={now}
        narrowed={isScheduleListNarrowed(params)}
        canManage={manager}
        deleting={deleting}
        onDelete={requestDelete}
        // Sort is a presentation preference, not a narrowing condition, so
        // the "nothing matches" reset keeps it.
          onClearSearchAndFilters={() =>
            setParams((current) => ({
              ...defaultScheduleListParams,
              sort: current.sort,
            }))
          }
        />
      </CollectionSurface>
    </CollectionPage>
  );
}

export { ScheduleEditorPage } from "../schedules/ScheduleEditorPage";
