import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import { toast } from "../../components/ui/toast";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import {
  Select,
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
import { EditorFrame, optionLabel } from "./shared";

// Option arrays hold label keys and translate at render so the editor follows
// language changes. Values sent to the API stay untranslated.
const displayModeOptions = [
  { value: "today", labelKey: "dataSources.options.today" },
  { value: "upcoming", labelKey: "dataSources.calendar.displayUpcoming" },
  { value: "this_week", labelKey: "dataSources.calendar.displayThisWeek" },
  { value: "agenda", labelKey: "dataSources.options.agenda" },
] as const;

const calendarRefreshOptions = [
  { value: 300, labelKey: "dataSources.durations.minutes5" },
  { value: 900, labelKey: "dataSources.durations.minutes15" },
  { value: 3600, labelKey: "dataSources.durations.hour1" },
  { value: 21600, labelKey: "dataSources.durations.hours6" },
  { value: 86400, labelKey: "dataSources.durations.day1" },
] as const;

const stalenessOptions = [
  { value: 24, labelKey: "dataSources.durations.day1" },
  { value: 72, labelKey: "dataSources.durations.days3" },
  { value: 168, labelKey: "dataSources.durations.days7" },
  { value: 720, labelKey: "dataSources.durations.days30" },
] as const;

const calendarFieldKeys = {
  title: "dataSources.calendar.fields.title",
  startTime: "dataSources.calendar.fields.startTime",
  endTime: "dataSources.calendar.fields.endTime",
  date: "dataSources.calendar.fields.date",
  location: "dataSources.calendar.fields.location",
  descriptionExcerpt: "dataSources.calendar.fields.descriptionExcerpt",
} as const satisfies Record<keyof CalendarConfig["fields"], string>;

const defaultCalendar: CalendarConfig = {
  calendars: [{ name: "Calendar", url: "https://" }],
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
  // i18n-ignore: default stored content the author edits, rendered on screens
  emptyState: "No events scheduled",
};

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
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const queryClient = useQueryClient();
  const configured = dataSource?.configuration as CalendarConfig | undefined;
  const [name, setName] = useState(dataSource?.name ?? "");
  const [description, setDescription] = useState(dataSource?.description ?? "");
  const [configuration, setConfiguration] = useState<CalendarConfig>(
    configured ?? defaultCalendar,
  );
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
      toast.add({
        title: dataSource ? "Data Source updated." : "Data Source created.",
        type: "success",
      });
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
      title={
        dataSource
          ? t("dataSources.calendar.titleEdit")
          : t("dataSources.calendar.titleCreate")
      }
      description={t("dataSources.calendar.description")}
      page={page}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending
              ? t("dataSources.preview.loading")
              : t("dataSources.preview.realData")}
          </RheaButton>
          {!readOnly && (
            <Button
              type="button"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("dataSources.editor.save")}
            </RheaButton>
          )}
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="calendar-name">
            {t("dataSources.editor.name")}
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
            {t("dataSources.editor.description")}
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
          {t("dataSources.calendar.calendarsLegend")}
        </legend>
        {configuration.calendars.map((feed, index) => (
          <div className="grid gap-4 sm:grid-cols-2" key={index}>
            <Field>
              <FieldLabel htmlFor={`calendar-feed-name-${index}`}>
                {t("dataSources.calendar.feedName")}
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
                {t("dataSources.calendar.feedUrl")}
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("dataSources.calendar.removeFeed", {
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
                  </Button>
                )}
              </div>
            </Field>
          </div>
        ))}
        {!readOnly && configuration.calendars.length < 8 && (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setConfiguration((current) => ({
                ...current,
                calendars: [
                  ...current.calendars,
                  {
                    name: `Calendar ${current.calendars.length + 1}`,
                    url: "https://",
                  },
                ],
              }))
            }
          >
            <Plus size={16} aria-hidden="true" />{" "}
            {t("dataSources.calendar.addCalendar")}
          </RheaButton>
        )}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="calendar-display">
            {t("dataSources.calendar.display")}
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
            items={displayModeOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          >
            <SelectTrigger
              id="calendar-display"
              aria-label={t("dataSources.calendar.display")}
            >
              <SelectValue>
                {optionLabel(
                  displayModeOptions.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  })),
                  configuration.displayMode,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {displayModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-max-events">
            {t("dataSources.calendar.maxEvents")}
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
            {t("dataSources.editor.timezone")}
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
          {t("dataSources.calendar.eventDetails")}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {(
            Object.keys(
              configuration.fields,
            ) as (keyof CalendarConfig["fields"])[]
          ).map((field) => (
            // The wrapping label names the checkbox; no extra aria-label.
            <label key={field} className="flex items-center gap-2 text-sm">
              <Checkbox
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
              <span>{t(calendarFieldKeys[field])}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {configuration.calendars.length > 1 && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">
            {t("dataSources.calendar.filterLegend")}
          </legend>
          <p className="text-xs text-muted-foreground">
            {t("dataSources.calendar.filterHint")}
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
                  <Checkbox
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
            {t("dataSources.editor.keywordFilter")}
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
            {t("dataSources.editor.emptyState")}
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
            {t("dataSources.editor.refreshInterval")}
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
            items={calendarRefreshOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          >
            <SelectTrigger
              id="calendar-refresh"
              aria-label={t("dataSources.editor.refreshInterval")}
            >
              <SelectValue>
                {optionLabel(
                  calendarRefreshOptions.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  })),
                  configuration.refreshIntervalSeconds,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {calendarRefreshOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-staleness">
            {t("dataSources.calendar.keepCached")}
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
            items={stalenessOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          >
            <SelectTrigger
              id="calendar-staleness"
              aria-label={t("dataSources.calendar.keepCached")}
            >
              <SelectValue>
                {optionLabel(
                  stalenessOptions.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey),
                  })),
                  configuration.stalenessLimitHours,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {stalenessOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {diagnostic && (
        <div className="grid gap-1 rounded-lg border p-3 text-sm">
          <strong>{t("dataSources.diagnostics.title")}</strong>
          <span>
            {diagnostic.parseStatus} ·{" "}
            {diagnostic.httpResultCategory ??
              t("dataSources.diagnostics.notAttempted")}{" "}
            ·{" "}
            {t("dataSources.diagnostics.events", {
              count: diagnostic.availableEventCount,
            })}
            {diagnostic.usingCachedData
              ? t("dataSources.diagnostics.cachedSuffix")
              : ""}
          </span>
          <small className="text-xs text-muted-foreground">
            {t("dataSources.diagnostics.lastAttempt", {
              value: diagnostic.lastAttemptedRefresh
                ? new Date(diagnostic.lastAttemptedRefresh).toLocaleString(
                    locale,
                  )
                : t("dataSources.diagnostics.notYet"),
            })}
          </small>
          <small className="text-xs text-muted-foreground">
            {t("dataSources.diagnostics.lastSuccess", {
              value: diagnostic.lastSuccessfulRefresh
                ? new Date(diagnostic.lastSuccessfulRefresh).toLocaleString(
                    locale,
                  )
                : t("dataSources.diagnostics.notYet"),
            })}
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
                  {event.title || t("dataSources.calendar.untitledEvent")}
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
