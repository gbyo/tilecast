import {
  FilterBar,
  useUrlFilters,
  type FilterDefinition,
  type FilterOption,
} from "../components/FilterBar";
import {
  TimeRangePicker,
  resolveTimeRange,
  type TimeRangePreset,
} from "../components/TimeRangePicker";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Download, SlidersHorizontal } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { translateKnown } from "../i18n";
import { OverviewTab } from "./ActivityOverviewPanel";
import { AuditTab, EventsTab, ProofTab } from "./ActivityReportTabs";
import { ContentHealthTab } from "./ContentHealthTab";
import { IncidentsTab } from "./ActivityIncidentsTab";
import { activityParams } from "./ActivityShared";
import {
  advancedProofFilterKeys,
  allActivityFilterKeys,
  auditResultOptions,
  categoryOptions,
  incidentDateBasisOptions,
  incidentStatusOptions,
  incidentTypeOptions,
  proofResultOptions as resultOptions,
  sessionTypeOptions,
  severityOptions,
  terminalReasonOptions,
  type ActivityTabName,
} from "./activityLinks";
import "./ActivityPage.css";

type ActivityTab = ActivityTabName;

function optionsFrom(items: { id: string; name: string }[] | undefined) {
  return (items ?? []).map((item) => ({ value: item.id, label: item.name }));
}

/**
 * Filter options show translated labels for contract values. The values stay
 * English protocol tokens; only the labels are looked up, falling back to the
 * previous capitalized rendering when English has no key for one.
 */
function plainOptions(prefix: string, values: string[]): FilterOption[] {
  return values.map((value) => ({
    value,
    label: translateKnown(
      `activity:page.filters.${prefix}.${value}`,
      value.charAt(0).toUpperCase() + value.slice(1),
    ),
  }));
}

/** Turns snake_case contract values into readable option labels. */
function labelledOptions(prefix: string, values: string[]): FilterOption[] {
  return values.map((value) => {
    const words = value.replaceAll("_", " ");
    return {
      value,
      label: translateKnown(
        `activity:page.filters.${prefix}.${value}`,
        words.charAt(0).toUpperCase() + words.slice(1),
      ),
    };
  });
}

export function ActivityPage() {
  const { t, i18n } = useTranslation("activity");
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const role = auth.status?.user?.role ?? "";
  const privileged = ["owner", "administrator"].includes(role);
  const tab = normalizeTab(searchParams.get("tab"), role);

  /** Exact-identifier filters, kept behind a disclosure but still chipped. */
  const advancedProofFilters: FilterDefinition[] = advancedProofFilterKeys.map(
    (key) => {
      const label = translateKnown(
        `activity:page.filters.advanced.${key}`,
        key.charAt(0).toUpperCase() + key.slice(1),
      );
      return {
        key,
        kind: "text",
        label,
        placeholder: t("page.resourceId", { label }),
        hidden: true,
      };
    },
  );

  const preset = normalizePreset(searchParams.get("range"));
  const customFrom = searchParams.get("from") ?? "";
  const customTo = searchParams.get("to") ?? "";
  const range = useMemo(
    () => resolveTimeRange(preset, customFrom, customTo),
    [customFrom, customTo, preset],
  );
  const [summaryDimension, setSummaryDimension] = useState("screen");

  const screens = useQuery({
    queryKey: ["activity", "screens"],
    queryFn: api.screens,
  });
  const groups = useQuery({
    queryKey: ["activity", "groups"],
    queryFn: () => api.screenGroups(),
  });
  const users = useQuery({
    queryKey: ["activity", "users"],
    queryFn: api.users,
    enabled: privileged,
  });
  const locations = useQuery({
    queryKey: ["activity", "locations"],
    queryFn: api.locations,
    enabled: tab === "incidents",
  });

  const definitions = useMemo<FilterDefinition[]>(() => {
    // Content Health is a rollup of current state and takes no filters, so it
    // must not inherit the Audit Log set.
    if (tab === "overview" || tab === "content-health") return [];
    const search: FilterDefinition = {
      key: "search",
      kind: "search",
      label: t("page.filters.searchActivity"),
      placeholder:
        tab === "proof"
          ? t("page.filters.searchProof")
          : tab === "events"
            ? t("page.filters.searchEvents")
            : t("page.filters.searchAudit"),
    };
    const byScreen: FilterDefinition[] = [
      {
        key: "screen",
        kind: "select",
        label: t("page.filters.screen"),
        allLabel: t("page.filters.allScreens"),
        options: optionsFrom(screens.data?.items),
      },
      {
        key: "group",
        kind: "select",
        label: t("page.filters.group"),
        allLabel: t("page.filters.allGroups"),
        options: optionsFrom(groups.data?.items),
      },
    ];
    if (tab === "proof")
      return [
        search,
        ...byScreen,
        {
          key: "result",
          kind: "select",
          label: t("page.filters.result"),
          allLabel: t("page.filters.allResults"),
          options: plainOptions("results", resultOptions),
        },
        {
          key: "sessionType",
          kind: "select",
          label: t("page.filters.sessionType"),
          allLabel: t("page.filters.allSessionTypes"),
          options: labelledOptions("sessionTypes", sessionTypeOptions),
        },
        {
          key: "terminalReason",
          kind: "select",
          label: t("page.filters.endedBecause"),
          allLabel: t("page.filters.anyReason"),
          options: labelledOptions("terminalReasons", terminalReasonOptions),
        },
        ...advancedProofFilters,
      ];
    if (tab === "incidents")
      return [
        {
          ...search,
          label: t("page.filters.searchIncidents"),
          placeholder: t("page.filters.searchIncidentsPlaceholder"),
        },
        {
          key: "status",
          kind: "select",
          label: t("page.filters.status"),
          allLabel: t("page.filters.activeStatus"),
          options: labelledOptions("incidentStatuses", incidentStatusOptions),
        },
        {
          key: "severity",
          kind: "select",
          label: t("page.filters.severity"),
          allLabel: t("page.filters.allSeverities"),
          options: plainOptions("severities", severityOptions),
        },
        {
          key: "type",
          kind: "select",
          label: t("page.filters.category"),
          allLabel: t("page.filters.allCategories"),
          options: labelledOptions("incidentTypes", incidentTypeOptions),
        },
        ...byScreen,
        {
          key: "location",
          kind: "select",
          label: t("page.filters.location"),
          allLabel: t("page.filters.allLocations"),
          options: optionsFrom(locations.data?.items),
        },
        {
          key: "assignee",
          kind: "select",
          label: t("page.filters.assignedTo"),
          allLabel: t("page.filters.anyone"),
          options: optionsFrom(users.data?.items),
        },
        {
          key: "failureCode",
          kind: "text",
          label: t("page.filters.failureCode"),
          placeholder: t("page.filters.failureCode"),
        },
        {
          // Which timestamp the date range applies to. Without this the range
          // is not applied at all, rather than being guessed.
          key: "dateBasis",
          kind: "select",
          label: t("page.filters.dateBasis"),
          allLabel: t("page.filters.ignoreRange"),
          options: labelledOptions("dateBases", incidentDateBasisOptions),
        },
      ];
    if (tab === "events")
      return [
        search,
        ...byScreen,
        {
          key: "category",
          kind: "select",
          label: t("page.filters.category"),
          allLabel: t("page.filters.allCategories"),
          options: plainOptions("categories", categoryOptions),
        },
        {
          key: "severity",
          kind: "select",
          label: t("page.filters.severity"),
          allLabel: t("page.filters.allSeverities"),
          options: plainOptions("severities", severityOptions),
        },
        {
          key: "result",
          kind: "select",
          label: t("page.filters.result"),
          allLabel: t("page.filters.allResults"),
          options: plainOptions("results", resultOptions),
        },
      ];
    return [
      search,
      ...(users.data
        ? [
            {
              key: "actor",
              kind: "select" as const,
              label: t("page.filters.actor"),
              allLabel: t("page.filters.allActors"),
              options: optionsFrom(users.data.items),
            },
          ]
        : []),
      {
        key: "action",
        kind: "text",
        label: t("page.filters.action"),
        placeholder: t("page.filters.action"),
      },
      {
        key: "resourceType",
        kind: "text",
        label: t("page.filters.resourceType"),
        placeholder: t("page.filters.resourceType"),
      },
      {
        key: "result",
        kind: "select",
        label: t("page.filters.result"),
        allLabel: t("page.filters.allResults"),
        options: plainOptions("auditResults", auditResultOptions),
      },
    ];
    // The translated labels depend on the interface language, which the linter
    // cannot see; rebuilding when it changes keeps every label translated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    groups.data,
    i18n.language,
    locations.data,
    screens.data,
    tab,
    users.data,
  ]);

  const { values, set, clear } = useUrlFilters(definitions);
  const activeAdvanced = advancedProofFilters.filter(
    (filter) => values[filter.key],
  );
  const hasActiveFilters = Object.values(values).some(Boolean);

  const exportHref =
    privileged && tab === "proof"
      ? `/api/v1/activity/proof-of-play/export.csv?${activityParams(range, values)}`
      : privileged && tab === "audit"
        ? `/api/v1/activity/audit/export.csv?${activityParams(range, values)}`
        : undefined;

  const activityTabs = [
    { value: "overview" as const, label: t("page.tabs.overview") },
    { value: "proof" as const, label: t("page.tabs.proof") },
    // Incidents is the grouped operational view; Screen Events stays the raw
    // diagnostic stream behind it, with its existing privileged access.
    { value: "incidents" as const, label: t("page.tabs.incidents") },
    // Content health sits beside Incidents because it answers the same
    // question from the other side: the screen is fine, the content is not.
    { value: "content-health" as const, label: t("page.tabs.contentHealth") },
    ...(privileged
      ? [
          { value: "events" as const, label: t("page.tabs.events") },
          { value: "audit" as const, label: t("page.tabs.audit") },
        ]
      : role === "editor"
        ? [{ value: "audit" as const, label: t("page.tabs.audit") }]
        : []),
  ];

  function selectTab(value: ActivityTab) {
    const next = new URLSearchParams(searchParams);
    if (value === "overview") next.delete("tab");
    else next.set("tab", value);
    // Filters are per tab; carrying one across would narrow the next report
    // with a control the reader can no longer see.
    for (const key of allActivityFilterKeys) next.delete(key);
    setSearchParams(next);
  }

  function setRange(key: "range" | "from" | "to", value: string) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === "range" && value !== "custom") {
      next.delete("from");
      next.delete("to");
    }
    setSearchParams(next, { replace: true });
  }

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
        <div className="flex flex-wrap items-end gap-2">
          <TimeRangePicker
            preset={preset}
            onPresetChange={(value) => setRange("range", value)}
            customFrom={customFrom}
            customTo={customTo}
            onCustomFromChange={(value) => setRange("from", value)}
            onCustomToChange={(value) => setRange("to", value)}
          />
          {exportHref && (
            <a
              className={buttonVariants({ variant: "outline" })}
              href={exportHref}
              title={t("page.exportTitle")}
            >
              <Download aria-hidden="true" /> {t("page.exportCsv")}
            </a>
          )}
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => selectTab(value as ActivityTab)}
        className="grid gap-4"
      >
        <TabsList variant="line" aria-label={t("page.tabsLabel")}>
          {activityTabs.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab} className="grid gap-4">
          {tab !== "overview" && tab !== "content-health" && (
            <FilterBar
              definitions={definitions}
              values={values}
              onChange={set}
              onClear={clear}
              label={t("page.filtersForTab", {
                tab:
                  activityTabs.find((item) => item.value === tab)?.label ?? tab,
              })}
            >
              {tab === "proof" && (
                <Popover>
                  <PopoverTrigger
                    render={<Button variant="outline" />}
                    aria-label={
                      activeAdvanced.length
                        ? t("page.advancedFiltersActive", {
                            active: activeAdvanced.length,
                          })
                        : t("page.advancedFilters")
                    }
                  >
                    <SlidersHorizontal aria-hidden="true" />
                    <span>{t("page.moreFilters")}</span>
                    {activeAdvanced.length > 0 && (
                      <Badge variant="secondary">{activeAdvanced.length}</Badge>
                    )}
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="grid w-80 gap-3 p-3"
                    aria-label={t("page.advancedFilters")}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="grid gap-0.5">
                        <strong className="text-sm">
                          {t("page.advancedFilters")}
                        </strong>
                        <small className="text-xs text-muted-foreground">
                          {t("page.advancedHint")}
                        </small>
                      </div>
                      {activeAdvanced.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            for (const filter of advancedProofFilters)
                              set(filter.key, "");
                          }}
                        >
                          {t("page.clear")}
                        </Button>
                      )}
                    </div>
                    <div className="grid gap-2">
                      {advancedProofFilters.map((filter) => (
                        <Field key={filter.key} className="gap-1">
                          <FieldLabel
                            htmlFor={`proof-filter-${filter.key}`}
                            className="text-xs font-medium"
                          >
                            {t("page.resourceId", { label: filter.label })}
                          </FieldLabel>
                          <Input
                            id={`proof-filter-${filter.key}`}
                            value={values[filter.key] ?? ""}
                            onChange={(event) =>
                              set(filter.key, event.target.value)
                            }
                            placeholder={t("page.resourceId", {
                              label: filter.label,
                            })}
                          />
                        </Field>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </FilterBar>
          )}

          {tab === "overview" && (
            <OverviewTab
              range={range}
              canViewScreenEvents={privileged}
              canViewAudit={privileged || role === "editor"}
            />
          )}
          {tab === "proof" && (
            <ProofTab
              range={range}
              filters={values}
              dimension={summaryDimension}
              setDimension={setSummaryDimension}
              hasActiveFilters={hasActiveFilters}
              canExtendRange={preset === "24h"}
              onClearFilters={clear}
              onExtendRange={() => setRange("range", "7d")}
              onViewScreenEvents={
                privileged ? () => selectTab("events") : undefined
              }
            />
          )}
          {tab === "incidents" && (
            <IncidentsTab
              range={range}
              filters={values}
              hasActiveFilters={hasActiveFilters}
              onClearFilters={clear}
            />
          )}
          {tab === "content-health" && <ContentHealthTab />}
          {tab === "events" && <EventsTab range={range} filters={values} />}
          {tab === "audit" && <AuditTab range={range} filters={values} />}
        </TabsContent>
      </Tabs>
    </section>
  );
}

function normalizeTab(value: string | null, role: string): ActivityTab {
  if (value === "proof" || value === "incidents" || value === "content-health")
    return value;
  if (value === "events" && ["owner", "administrator"].includes(role)) {
    return value;
  }
  if (
    value === "audit" &&
    ["owner", "administrator", "editor"].includes(role)
  ) {
    return value;
  }
  return "overview";
}

function normalizePreset(value: string | null): TimeRangePreset {
  return value === "7d" || value === "30d" || value === "custom"
    ? value
    : "24h";
}
