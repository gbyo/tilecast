import { useInfiniteQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import { PlaybackAgenda } from "../components/schedules/PlaybackAgenda";
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
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { defaultScheduleListParams, scheduleQueries } from "../data/schedules";
import { useCompactLayout } from "../hooks/use-compact-layout";
import { hasCapability } from "../auth/capabilities";

const canManage = (status?: AuthStatus) =>
  hasCapability(status, "schedule.edit");

export function SchedulesPage() {
  const { t } = useTranslation("schedules");
  const { status } = useAuth();
  const [params, setParams] = useSearchParams();
  if (!hasCapability(status, "screen.read")) return <ScheduleList />;
  return (
    <Tabs
      value={params.get("view") === "agenda" ? "agenda" : "list"}
      onValueChange={(value) =>
        setParams((previous) => {
          const next = new URLSearchParams(previous);
          if (value === "agenda") next.set("view", "agenda");
          else next.delete("view");
          return next;
        })
      }
      className="w-full min-w-0 gap-5"
    >
      <TabsList aria-label={t("page.title")}>
        <TabsTrigger value="list" className="px-2.5">
          {t("agenda.listTab")}
        </TabsTrigger>
        <TabsTrigger value="agenda" className="px-2.5">
          {t("agenda.title")}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="list">
        <ScheduleList />
      </TabsContent>
      <TabsContent value="agenda">
        <PlaybackAgenda />
      </TabsContent>
    </Tabs>
  );
}

function ScheduleList() {
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
    <section className="w-full min-w-0 space-y-5">
      <h1 className="sr-only">{t("page.title")}</h1>
      {dialog}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {typeof total === "number" ? (
            <p className="text-sm text-muted-foreground tabular-nums">
              {t("page.count", { count: total })}
            </p>
          ) : schedules.isLoading ? (
            <Skeleton className="h-5 w-24" />
          ) : null}
          {manager && (
            <Link
              className={buttonVariants({
                variant: "default",
                className: "ml-auto",
              })}
              to="/schedules/new"
              aria-label={compact ? createLabel : undefined}
            >
              <Plus aria-hidden="true" />
              {compact ? t("page.createShort") : createLabel}
            </Link>
          )}
        </div>
        <Separator />
      </div>
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
    </section>
  );
}

export { ScheduleEditorPage } from "../schedules/ScheduleEditorPage";
