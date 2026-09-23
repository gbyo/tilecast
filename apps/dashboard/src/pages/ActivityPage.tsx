import {
  FilterBar,
  TimeRangePicker,
  ViewTabs,
  resolveTimeRange,
  useUrlFilters,
  type FilterDefinition,
  type FilterOption,
  type TimeRangePreset,
} from "../components/legacy-ui";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Popover as RheaPopover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Download, SlidersHorizontal } from "lucide-react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
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

/** Exact-identifier filters, kept behind a disclosure but still chipped. */
const advancedProofFilters: FilterDefinition[] = advancedProofFilterKeys.map(
  (key) => {
    const label = key.charAt(0).toUpperCase() + key.slice(1);
    return {
      key,
      kind: "text",
      label,
      placeholder: `${label} ID`,
      hidden: true,
    };
  },
);

function optionsFrom(items: { id: string; name: string }[] | undefined) {
  return (items ?? []).map((item) => ({ value: item.id, label: item.name }));
}

function plainOptions(values: string[]): FilterOption[] {
  return values.map((value) => ({
    value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
  }));
}

/** Turns snake_case contract values into readable option labels. */
function labelledOptions(values: string[]): FilterOption[] {
  return values.map((value) => {
    const words = value.replaceAll("_", " ");
    return { value, label: words.charAt(0).toUpperCase() + words.slice(1) };
  });
}

export function ActivityPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const role = auth.status?.user?.role ?? "";
  const privileged = ["owner", "administrator"].includes(role);
  const tab = normalizeTab(searchParams.get("tab"), role);

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
      label: "Search activity",
      placeholder:
        tab === "proof"
          ? "Search proof of play…"
          : tab === "events"
            ? "Search screen events…"
            : "Search audit log…",
    };
    const byScreen: FilterDefinition[] = [
      {
        key: "screen",
        kind: "select",
        label: "Screen",
        allLabel: "All screens",
        options: optionsFrom(screens.data?.items),
      },
      {
        key: "group",
        kind: "select",
        label: "Group",
        allLabel: "All groups",
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
          label: "Result",
          allLabel: "All results",
          options: plainOptions(resultOptions),
        },
        {
          key: "sessionType",
          kind: "select",
          label: "Session type",
          allLabel: "All session types",
          options: labelledOptions(sessionTypeOptions),
        },
        {
          key: "terminalReason",
          kind: "select",
          label: "Ended because",
          allLabel: "Any reason",
          options: [
            { value: "unexpected", label: "Ended unexpectedly" },
            ...labelledOptions(
              terminalReasonOptions.filter((value) => value !== "unexpected"),
            ),
          ],
        },
        ...advancedProofFilters,
      ];
    if (tab === "incidents")
      return [
        {
          ...search,
          label: "Search incidents",
          placeholder: "Search incidents…",
        },
        {
          key: "status",
          kind: "select",
          label: "Status",
          allLabel: "Active",
          options: labelledOptions(incidentStatusOptions),
        },
        {
          key: "severity",
          kind: "select",
          label: "Severity",
          allLabel: "All severities",
          options: plainOptions(severityOptions),
        },
        {
          key: "type",
          kind: "select",
          label: "Category",
          allLabel: "All categories",
          options: labelledOptions(incidentTypeOptions),
        },
        ...byScreen,
        {
          key: "location",
          kind: "select",
          label: "Location",
          allLabel: "All locations",
          options: optionsFrom(locations.data?.items),
        },
        {
          key: "assignee",
          kind: "select",
          label: "Assigned to",
          allLabel: "Anyone",
          options: optionsFrom(users.data?.items),
        },
        {
          key: "failureCode",
          kind: "text",
          label: "Failure code",
          placeholder: "Failure code",
        },
        {
          // Which timestamp the date range applies to. Without this the range
          // is not applied at all, rather than being guessed.
          key: "dateBasis",
          kind: "select",
          label: "Date basis",
          allLabel: "Ignore date range",
          options: labelledOptions(incidentDateBasisOptions),
        },
      ];
    if (tab === "events")
      return [
        search,
        ...byScreen,
        {
          key: "category",
          kind: "select",
          label: "Category",
          allLabel: "All categories",
          options: plainOptions(categoryOptions),
        },
        {
          key: "severity",
          kind: "select",
          label: "Severity",
          allLabel: "All severities",
          options: plainOptions(severityOptions),
        },
        {
          key: "result",
          kind: "select",
          label: "Result",
          allLabel: "All results",
          options: plainOptions(resultOptions),
        },
      ];
    return [
      search,
      ...(users.data
        ? [
            {
              key: "actor",
              kind: "select" as const,
              label: "Actor",
              allLabel: "All actors",
              options: optionsFrom(users.data.items),
            },
          ]
        : []),
      { key: "action", kind: "text", label: "Action", placeholder: "Action" },
      {
        key: "resourceType",
        kind: "text",
        label: "Resource type",
        placeholder: "Resource type",
      },
      {
        key: "result",
        kind: "select",
        label: "Result",
        allLabel: "All results",
        options: plainOptions(auditResultOptions),
      },
    ];
  }, [groups.data, locations.data, screens.data, tab, users.data]);

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
    { value: "overview" as const, label: "Overview" },
    { value: "proof" as const, label: "Proof of Play" },
    // Incidents is the grouped operational view; Screen Events stays the raw
    // diagnostic stream behind it, with its existing privileged access.
    { value: "incidents" as const, label: "Incidents" },
    // Content health sits beside Incidents because it answers the same
    // question from the other side: the screen is fine, the content is not.
    { value: "content-health" as const, label: "Content Health" },
    ...(privileged
      ? [
          { value: "events" as const, label: "Screen Events" },
          { value: "audit" as const, label: "Audit Log" },
        ]
      : role === "editor"
        ? [{ value: "audit" as const, label: "Audit Log" }]
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
          <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational reporting, Player-confirmed proof of play, technical
            screen events, and administrator history.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
              className="inline-flex h-9 items-center justify-center gap-2 rounded-2xl border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
              href={exportHref}
              title="Export the current date range and filters"
            >
              <Download size={15} aria-hidden="true" /> Export CSV
            </a>
          )}
        </div>
      </header>

      <ViewTabs
        label="Activity reports"
        value={tab}
        items={activityTabs}
        onValueChange={selectTab}
      />

      {tab !== "overview" && tab !== "content-health" && (
        <FilterBar
          definitions={definitions}
          values={values}
          onChange={set}
          onClear={clear}
          label={`${activityTabs.find((item) => item.value === tab)?.label} filters`}
        >
          {tab === "proof" && (
            <RheaPopover>
              <PopoverTrigger
                render={<RheaButton variant="outline" size="sm" />}
                aria-label={`Advanced filters${activeAdvanced.length ? `, ${activeAdvanced.length} active` : ""}`}
              >
                <SlidersHorizontal size={15} aria-hidden="true" />
                <span>More filters</span>
                {activeAdvanced.length > 0 && (
                  <Badge variant="secondary">{activeAdvanced.length}</Badge>
                )}
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="grid w-80 gap-3 p-3"
                aria-label="Advanced filters"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="grid gap-0.5">
                    <strong className="text-sm">Advanced filters</strong>
                    <small className="text-xs text-muted-foreground">
                      Filter by an exact resource ID.
                    </small>
                  </div>
                  {activeAdvanced.length > 0 && (
                    <RheaButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        for (const filter of advancedProofFilters)
                          set(filter.key, "");
                      }}
                    >
                      Clear
                    </RheaButton>
                  )}
                </div>
                <div className="grid gap-2">
                  {advancedProofFilters.map((filter) => (
                    <label
                      key={filter.key}
                      className="grid gap-1 text-xs font-medium"
                    >
                      <span>{filter.label} ID</span>
                      <Input
                        value={values[filter.key] ?? ""}
                        onChange={(event) =>
                          set(filter.key, event.target.value)
                        }
                        placeholder={`${filter.label} ID`}
                      />
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </RheaPopover>
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
