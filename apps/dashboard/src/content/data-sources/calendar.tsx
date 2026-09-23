import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
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
import { EditorFrame, optionLabel } from "./shared";

const displayModeOptions = [
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming" },
  { value: "this_week", label: "This week" },
  { value: "agenda", label: "Agenda" },
];

const calendarRefreshOptions = [
  { value: 300, label: "5 minutes" },
  { value: 900, label: "15 minutes" },
  { value: 3600, label: "1 hour" },
  { value: 21600, label: "6 hours" },
  { value: 86400, label: "1 day" },
];

const stalenessOptions = [
  { value: 24, label: "1 day" },
  { value: 72, label: "3 days" },
  { value: 168, label: "7 days" },
  { value: 720, label: "30 days" },
];

const calendarFieldLabels: Record<keyof CalendarConfig["fields"], string> = {
  title: "Title",
  startTime: "Start time",
  endTime: "End time",
  date: "Date",
  location: "Location",
  descriptionExcerpt: "Description excerpt",
};

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
        dataSource ? "Edit Calendar Data Source" : "Create Calendar Data Source"
      }
      description="Tilecast fetches and sanitizes public iCalendar feeds for native playback."
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
              ? "Loading preview…"
              : "Preview real data"}
          </RheaButton>
          {!readOnly && (
            <RheaButton
              type="button"
              disabled={save.isPending || !name.trim()}
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save Data Source"}
            </RheaButton>
          )}
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="calendar-name">Name</FieldLabel>
          <Input
            id="calendar-name"
            disabled={readOnly}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-description">Description</FieldLabel>
          <Input
            id="calendar-description"
            disabled={readOnly}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </div>
      <fieldset className="grid gap-3">
        <legend className="text-sm font-medium">Calendars</legend>
        {configuration.calendars.map((feed, index) => (
          <div className="grid gap-4 sm:grid-cols-2" key={index}>
            <Field>
              <FieldLabel htmlFor={`calendar-feed-name-${index}`}>
                Calendar name
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
                Public ICS URL
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
                    aria-label={`Remove ${feed.name}`}
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
                    name: `Calendar ${current.calendars.length + 1}`,
                    url: "https://",
                  },
                ],
              }))
            }
          >
            <Plus size={16} aria-hidden="true" /> Add calendar
          </RheaButton>
        )}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field>
          <FieldLabel htmlFor="calendar-display">Display</FieldLabel>
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
            <SelectTrigger id="calendar-display" aria-label="Display">
              <SelectValue>
                {optionLabel(displayModeOptions, configuration.displayMode)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {displayModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-max-events">Maximum events</FieldLabel>
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
          <FieldLabel htmlFor="calendar-timezone">Timezone</FieldLabel>
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
        <legend className="text-sm font-medium">Event details</legend>
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
              <span>{calendarFieldLabels[field]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {configuration.calendars.length > 1 && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Calendar filter</legend>
          <p className="text-xs text-muted-foreground">
            No selection includes every configured calendar.
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
          <FieldLabel htmlFor="calendar-keyword">Keyword filter</FieldLabel>
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
          <FieldLabel htmlFor="calendar-empty-state">Empty state</FieldLabel>
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
          <FieldLabel htmlFor="calendar-refresh">Refresh interval</FieldLabel>
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
            <SelectTrigger id="calendar-refresh" aria-label="Refresh interval">
              <SelectValue>
                {optionLabel(
                  calendarRefreshOptions,
                  configuration.refreshIntervalSeconds,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {calendarRefreshOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
        <Field>
          <FieldLabel htmlFor="calendar-staleness">Keep cached data</FieldLabel>
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
              aria-label="Keep cached data"
            >
              <SelectValue>
                {optionLabel(
                  stalenessOptions,
                  configuration.stalenessLimitHours,
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {stalenessOptions.map((option) => (
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
          <strong>Refresh diagnostics</strong>
          <span>
            {diagnostic.parseStatus} ·{" "}
            {diagnostic.httpResultCategory ?? "not attempted"} ·{" "}
            {diagnostic.availableEventCount} events
            {diagnostic.usingCachedData ? " · cached data" : ""}
          </span>
          <small className="text-xs text-muted-foreground">
            Last attempt:{" "}
            {diagnostic.lastAttemptedRefresh
              ? new Date(diagnostic.lastAttemptedRefresh).toLocaleString()
              : "Not yet"}
          </small>
          <small className="text-xs text-muted-foreground">
            Last success:{" "}
            {diagnostic.lastSuccessfulRefresh
              ? new Date(diagnostic.lastSuccessfulRefresh).toLocaleString()
              : "Not yet"}
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
                  {event.title || "Untitled event"}
                </strong>
                <span className="text-sm text-muted-foreground">
                  {event.allDay
                    ? new Date(event.start).toLocaleDateString()
                    : new Date(event.start).toLocaleString()}
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
            {(previewMutation.error ?? save.error)?.message}
          </AlertDescription>
        </Alert>
      )}
    </EditorFrame>
  );
}
