import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button as RheaButton } from "../../components/ui/button";
import { Checkbox as RheaCheckbox } from "../../components/ui/checkbox";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import type {
  CalendarConfig,
  CalendarPreview,
  DataSourceDetail,
} from "../../api/types";
import type { ContentT } from "../dataSourceProviderMeta";
import { EditorFrame, optionLabel } from "./shared";

const displayModeOptions = [
  { value: "today", labelKey: "sources.calendar.displayToday" },
  { value: "upcoming", labelKey: "sources.calendar.displayUpcoming" },
  { value: "this_week", labelKey: "sources.calendar.displayThisWeek" },
  { value: "agenda", labelKey: "sources.calendar.displayAgenda" },
] as const;

const calendarRefreshOptions = [
  { value: 300, labelKey: "sources.calendar.refresh5" },
  { value: 900, labelKey: "sources.calendar.refresh15" },
  { value: 3600, labelKey: "sources.calendar.refreshHour" },
  { value: 21600, labelKey: "sources.calendar.refresh6h" },
  { value: 86400, labelKey: "sources.calendar.refreshDay" },
] as const;

const stalenessOptions = [
  { value: 24, labelKey: "sources.calendar.stale1d" },
  { value: 72, labelKey: "sources.calendar.stale3d" },
  { value: 168, labelKey: "sources.calendar.stale7d" },
  { value: 720, labelKey: "sources.calendar.stale30d" },
] as const;

const calendarFieldLabelKeys: Record<
  keyof CalendarConfig["fields"],
  | "sources.calendar.fieldTitle"
  | "sources.calendar.fieldStartTime"
  | "sources.calendar.fieldEndTime"
  | "sources.calendar.fieldDate"
  | "sources.calendar.fieldLocation"
  | "sources.calendar.fieldExcerpt"
> = {
  title: "sources.calendar.fieldTitle",
  startTime: "sources.calendar.fieldStartTime",
  endTime: "sources.calendar.fieldEndTime",
  date: "sources.calendar.fieldDate",
  location: "sources.calendar.fieldLocation",
  descriptionExcerpt: "sources.calendar.fieldExcerpt",
};

function defaultCalendarConfig(t: ContentT): CalendarConfig {
  return {
    calendars: [
      { name: t("sources.calendar.defaultFeedName"), url: "https://" },
    ],
    displayMode: "upcoming",
    maxEvents: 10,
    fields: {
      title: true,
      startTime: true,
      endTime: false,
      date: true,
      location: true,
      descriptionExcerpt: false,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    refreshIntervalSeconds: 900,
    stalenessLimitHours: 168,
    emptyState: t("sources.calendar.defaultEmptyState"),
  };
}

export function CalendarDataSourceEditor({
  dataSource,
  csrf,
  readOnly = false,
  onClose,
  onSaved,
  page = false,
}: {
  dataSource?: DataSourceDetail;
  csrf: string;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: (dataSource: DataSourceDetail) => void;
  page?: boolean;
}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const configured = dataSource?.configuration as CalendarConfig | undefined;
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const [configuration, setConfiguration] = useState<CalendarConfig>(
    () => configured ?? defaultCalendarConfig(t),
  );
  const displayOptions = displayModeOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const refreshIntervals = calendarRefreshOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const stalenessLimits = stalenessOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const [preview, setPreview] = useState<CalendarPreview>();
  const diagnostics = useQuery({
    queryKey: ["data-source-diagnostics", dataSource?.id],
    queryFn: () => api.dataSourceDiagnostics(dataSource!.id),
    enabled: Boolean(dataSource),
  });
  const save = useMutation({
    mutationFn: () => {
      const input = {
        provider: "calendar" as const,
        name,
        description,
        configuration,
      };
      return dataSource
        ? api.updateDataSource(dataSource.id, input, csrf)
        : api.createDataSource(input, csrf);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ["data-sources"] });
      onSaved(saved);
    },
  });
  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewDataSource(
        "calendar",
        configuration,
        csrf,
      ) as Promise<CalendarPreview>,
    onSuccess: setPreview,
  });
  const updateFeed = (index: number, key: "name" | "url", value: string) =>
    setConfiguration((current) => {
      const previousName = current.calendars[index]?.name;
      return {
        ...current,
        calendars: current.calendars.map((feed, position) =>
          position === index ? { ...feed, [key]: value } : feed,
        ),
        filterCalendars:
          key === "name"
            ? current.filterCalendars?.map((name) =>
                name === previousName ? value : name,
              )
            : current.filterCalendars,
      };
    });
  const diagnostic = diagnostics.data;
  return (
    <EditorFrame
      title={t(
        dataSource
          ? "sources.calendar.editTitle"
          : "sources.calendar.createTitle",
      )}
      description={t("sources.calendar.frameDescription")}
      page={page}
      onClose={onClose}
      footer={
        <>
          <RheaButton
            type="button"
            variant="outline"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending
              ? t("sources.shared.loadingPreview")
              : t("sources.shared.previewRealData")}
          </RheaButton>
          {!readOnly && (
            <RheaButton
              type="button"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("sources.shared.saveDataSource")}
            </RheaButton>
          )}
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="calendar-name">
            {t("sources.shared.name")}
          </FieldLabel>
          <Input
            id="calendar-name"
            disabled={readOnly}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-description">
            {t("sources.shared.description")}
          </FieldLabel>
          <Input
            id="calendar-description"
            disabled={readOnly}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">
          {t("sources.calendar.calendarsLegend")}
        </legend>
        {configuration.calendars.map((feed, index) => (
          <div className="grid gap-4 sm:grid-cols-2" key={index}>
            <Field>
              <FieldLabel htmlFor={`calendar-feed-name-${index}`}>
                {t("sources.calendar.feedName")}
              </FieldLabel>
              <Input
                id={`calendar-feed-name-${index}`}
                disabled={readOnly}
                value={feed.name}
                onChange={(event) =>
                  updateFeed(index, "name", event.target.value)
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`calendar-feed-url-${index}`}>
                {t("sources.calendar.feedUrl")}
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id={`calendar-feed-url-${index}`}
                  className="min-w-0 flex-1"
                  disabled={readOnly}
                  type="url"
                  value={feed.url}
                  onChange={(event) =>
                    updateFeed(index, "url", event.target.value)
                  }
                />
                {!readOnly && configuration.calendars.length > 1 && (
                  <RheaButton
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("sources.calendar.removeFeed", {
                      name: feed.name,
                    })}
                    onClick={() =>
                      setConfiguration((current) => ({
                        ...current,
                        calendars: current.calendars.filter(
                          (_, position) => position !== index,
                        ),
                      }))
                    }
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </RheaButton>
                )}
              </div>
            </Field>
          </div>
        ))}
        {!readOnly && configuration.calendars.length < 8 && (
          <RheaButton
            type="button"
            variant="outline"
            onClick={() =>
              setConfiguration((current) => ({
                ...current,
                calendars: [
                  ...current.calendars,
                  {
                    name: t("sources.calendar.newFeedName", {
                      index: current.calendars.length + 1,
                    }),
                    url: "https://",
                  },
                ],
              }))
            }
          >
            <Plus size={16} aria-hidden="true" />{" "}
            {t("sources.calendar.addCalendar")}
          </RheaButton>
        )}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="calendar-display">
            {t("sources.calendar.display")}
          </FieldLabel>
          <RheaSelect
            disabled={readOnly}
            value={configuration.displayMode}
            onValueChange={(next) =>
              setConfiguration({
                ...configuration,
                displayMode: next as CalendarConfig["displayMode"],
              })
            }
          >
            <SelectTrigger
              id="calendar-display"
              aria-label={t("sources.calendar.display")}
            >
              <SelectValue>
                {optionLabel(displayOptions, configuration.displayMode)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {displayOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-max-events">
            {t("sources.calendar.maxEvents")}
          </FieldLabel>
          <Input
            id="calendar-max-events"
            disabled={readOnly}
            type="number"
            min={1}
            max={100}
            value={configuration.maxEvents}
            onChange={(event) =>
              setConfiguration({
                ...configuration,
                maxEvents: Number(event.target.value),
              })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-timezone">
            {t("sources.calendar.timezone")}
          </FieldLabel>
          <Input
            id="calendar-timezone"
            disabled={readOnly}
            value={configuration.timezone}
            onChange={(event) =>
              setConfiguration({
                ...configuration,
                timezone: event.target.value,
              })
            }
          />
        </Field>
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">
          {t("sources.calendar.eventDetails")}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {(
            Object.keys(
              configuration.fields,
            ) as (keyof CalendarConfig["fields"])[]
          ).map((field) => (
            // The wrapping label names the checkbox; no extra aria-label.
            <label key={field} className="flex items-center gap-2 text-sm">
              <RheaCheckbox
                disabled={readOnly}
                checked={configuration.fields[field]}
                onCheckedChange={(checked) =>
                  setConfiguration({
                    ...configuration,
                    fields: {
                      ...configuration.fields,
                      [field]: checked === true,
                    },
                  })
                }
              />
              <span>{t(calendarFieldLabelKeys[field])}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {configuration.calendars.length > 1 && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">
            {t("sources.calendar.filterLegend")}
          </legend>
          <p className="text-xs text-muted-foreground">
            {t("sources.calendar.filterHint")}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {configuration.calendars.map((feed) => {
              const selected =
                configuration.filterCalendars?.includes(feed.name) ?? false;
              return (
                <label
                  key={feed.name}
                  className="flex items-center gap-2 text-sm"
                >
                  <RheaCheckbox
                    disabled={readOnly}
                    checked={selected}
                    onCheckedChange={(checked) =>
                      setConfiguration((current) => ({
                        ...current,
                        filterCalendars:
                          checked === true
                            ? [...(current.filterCalendars ?? []), feed.name]
                            : (current.filterCalendars ?? []).filter(
                                (name) => name !== feed.name,
                              ),
                      }))
                    }
                  />
                  <span>{feed.name}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="calendar-keyword">
            {t("sources.calendar.keywordFilter")}
          </FieldLabel>
          <Input
            id="calendar-keyword"
            disabled={readOnly}
            value={configuration.filterKeyword ?? ""}
            onChange={(event) =>
              setConfiguration({
                ...configuration,
                filterKeyword: event.target.value,
              })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-empty-state">
            {t("sources.calendar.emptyStateLabel")}
          </FieldLabel>
          <Input
            id="calendar-empty-state"
            disabled={readOnly}
            value={configuration.emptyState}
            onChange={(event) =>
              setConfiguration({
                ...configuration,
                emptyState: event.target.value,
              })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-refresh">
            {t("sources.calendar.refreshInterval")}
          </FieldLabel>
          <RheaSelect
            disabled={readOnly}
            value={configuration.refreshIntervalSeconds}
            onValueChange={(next) =>
              setConfiguration({
                ...configuration,
                refreshIntervalSeconds: Number(next),
              })
            }
          >
            <SelectTrigger
              id="calendar-refresh"
              aria-label={t("sources.calendar.refreshInterval")}
            >
              <SelectValue>
                {optionLabel(
                  refreshIntervals,
                  configuration.refreshIntervalSeconds,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {refreshIntervals.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-staleness">
            {t("sources.calendar.keepCached")}
          </FieldLabel>
          <RheaSelect
            disabled={readOnly}
            value={configuration.stalenessLimitHours}
            onValueChange={(next) =>
              setConfiguration({
                ...configuration,
                stalenessLimitHours: Number(next),
              })
            }
          >
            <SelectTrigger
              id="calendar-staleness"
              aria-label={t("sources.calendar.keepCached")}
            >
              <SelectValue>
                {optionLabel(
                  stalenessLimits,
                  configuration.stalenessLimitHours,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {stalenessLimits.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
      </div>
      {diagnostic && (
        <div className="grid gap-1 rounded-lg border p-3 text-sm">
          <strong>{t("sources.calendar.diagnostics")}</strong>
          <span>
            {diagnostic.parseStatus} ·{" "}
            {diagnostic.httpResultCategory ?? t("sources.calendar.diagUnknown")}{" "}
            ·{" "}
            {t("sources.calendar.diagEvents", {
              count: diagnostic.availableEventCount,
            })}
            {diagnostic.usingCachedData
              ? ` ${t("sources.calendar.diagCached")}`
              : ""}
          </span>
          <small className="text-xs text-muted-foreground">
            {t("sources.calendar.lastAttempt")}{" "}
            {diagnostic.lastAttemptedRefresh
              ? new Date(diagnostic.lastAttemptedRefresh).toLocaleString(locale)
              : t("sources.calendar.notYet")}
          </small>
          <small className="text-xs text-muted-foreground">
            {t("sources.calendar.lastSuccess")}{" "}
            {diagnostic.lastSuccessfulRefresh
              ? new Date(diagnostic.lastSuccessfulRefresh).toLocaleString(
                  locale,
                )
              : t("sources.calendar.notYet")}
          </small>
        </div>
      )}
      {preview && (
        <div className="grid gap-2">
          {preview.configuration.data.events
            .slice(0, configuration.maxEvents)
            .map((event) => (
              <article
                key={event.id}
                className="grid gap-0.5 rounded-lg border p-3"
              >
                <strong className="text-sm">
                  {event.title || t("sources.calendar.untitledEvent")}
                </strong>
                <span className="text-sm text-muted-foreground">
                  {event.allDay
                    ? new Date(event.start).toLocaleDateString(locale)
                    : new Date(event.start).toLocaleString(locale)}
                </span>
                {event.location && (
                  <small className="text-xs text-muted-foreground">
                    {event.location}
                  </small>
                )}
              </article>
            ))}
          {!preview.configuration.data.events.length && (
            <p className="text-sm text-muted-foreground">
              {configuration.emptyState}
            </p>
          )}
        </div>
      )}
      {(previewMutation.error || save.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(previewMutation.error ?? save.error)}
          </AlertDescription>
        </Alert>
      )}
    </EditorFrame>
  );
}
