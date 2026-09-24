import {
  useMutation,
  useQuery,
  useQueries,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { CalendarDays, Clock3, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import type {
  Playlist,
  LayoutSummary,
  ScheduleInput,
  SchedulePreview,
  ScheduleTarget,
  DisplayControlAction,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  isTimezoneIdentifier,
  normalizeTimezone,
  timezoneLabel,
  timezoneOptions,
} from "../settings/settingValues";
import { PlaylistPicker } from "../components/content-picker";
import { useConfirm } from "../components/ConfirmDialog";
import { DateInput, DateTimeInput } from "../components/date-picker";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Combobox,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxChip,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "../components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { toast } from "../components/ui/toast";
import {
  conflictWinnerReason,
  countTargetScreens,
  describeScheduleTiming,
  oneTimeDuration,
  priorityLabel,
  priorityPreset,
  scheduleIsDirty,
  schedulePreviewTimestamp,
  scheduleWeekdayLabels,
  scheduleWeekdays,
  validateScheduleInput,
  type PriorityPreset,
  type SchedulesT,
} from "./scheduleBuilderModel";

const initialSchedule = (): ScheduleInput => ({
  name: "",
  description: "",
  playlistId: "",
  layoutId: undefined,
  type: "weekly",
  // Filled from the organization default returned by the schedules API.
  timezone: "",
  priority: 0,
  enabled: true,
  dailyStart: "09:00",
  dailyEnd: "17:00",
  daysOfWeek: [1, 2, 3, 4, 5],
  targets: [],
});

function scheduleToInput(
  schedule: Awaited<ReturnType<typeof api.schedule>>,
): ScheduleInput {
  return {
    name: schedule.name,
    description: schedule.description,
    playlistId: schedule.displayAction ? undefined : schedule.playlistId,
    layoutId: schedule.displayAction ? undefined : schedule.layoutId,
    displayAction: schedule.displayAction,
    type: schedule.type,
    timezone: schedule.timezone,
    priority: schedule.priority,
    enabled: schedule.enabled,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    oneTimeStart: schedule.oneTimeStart,
    oneTimeEnd: schedule.oneTimeEnd,
    dailyStart: schedule.dailyStart,
    dailyEnd: schedule.dailyEnd,
    daysOfWeek: schedule.daysOfWeek,
    targets: schedule.targets,
  };
}

export function ScheduleEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const auth = useAuth();
  const client = useQueryClient();
  const { t } = useTranslation(["schedules", "common"]);
  const formatLocale = useFormatLocale();
  const csrf = auth.status?.csrfToken ?? "";
  const { confirm, dialog: confirmDialog } = useConfirm();
  const existing = useQuery({
    queryKey: ["schedules", id],
    queryFn: () => api.schedule(id!),
    enabled: Boolean(id),
  });
  const playlists = useQuery({
    queryKey: ["playlists", "schedule"],
    queryFn: () => api.playlists(),
  });
  const layouts = useQuery({
    queryKey: ["layouts", "schedule"],
    queryFn: () => api.layouts(""),
  });
  const screens = useQuery({ queryKey: ["screens"], queryFn: api.screens });
  const groups = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
  });
  const defaults = useQuery({
    queryKey: ["schedules", "defaults"],
    queryFn: () => api.schedules(),
  });
  const [input, setInput] = useState<ScheduleInput>(initialSchedule);
  const [baseline, setBaseline] = useState<ScheduleInput>(initialSchedule);
  const [attempted, setAttempted] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [targetTab, setTargetTab] = useState<"screens" | "groups">("screens");
  const [targetSearch, setTargetSearch] = useState("");
  const [showDateRange, setShowDateRange] = useState(false);
  const [defaultTimezoneApplied, setDefaultTimezoneApplied] = useState(false);

  useEffect(() => {
    if (!existing.data) return;
    const next = scheduleToInput(existing.data);
    setInput(next);
    setBaseline(next);
    setShowDateRange(Boolean(next.startDate || next.endDate));
  }, [existing.data]);
  useEffect(() => {
    if (id || defaultTimezoneApplied || !defaults.data?.defaultTimezone) return;
    setInput((current) => {
      if (scheduleIsDirty(current, baseline)) return current;
      const next = { ...current, timezone: defaults.data.defaultTimezone };
      setBaseline(next);
      return next;
    });
    setDefaultTimezoneApplied(true);
  }, [baseline, defaultTimezoneApplied, defaults.data?.defaultTimezone, id]);

  const dirty = scheduleIsDirty(input, baseline);
  const errors = useMemo(() => validateScheduleInput(input, t), [input, t]);
  const valid = Object.keys(errors).length === 0;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const selectedPlaylist = playlists.data?.items?.find(
    (playlist) => playlist.id === input.playlistId,
  );
  const selectedLayout = layouts.data?.items?.find(
    (layout) => layout.id === input.layoutId,
  );
  const playlistDetails = useQuery({
    queryKey: ["playlists", input.playlistId, "schedule-card"],
    queryFn: () => api.playlist(input.playlistId!),
    enabled: Boolean(input.playlistId),
  });
  const selectedPlaylistData = playlistDetails.data ?? selectedPlaylist;
  const selectedGroupIds = input.targets
    .filter((target) => target.type === "group")
    .map((target) => target.id);
  const selectedGroups = useQueries({
    queries: selectedGroupIds.map((groupId) => ({
      queryKey: ["screen-groups", groupId, "schedule-target"],
      queryFn: () => api.screenGroup(groupId),
    })),
  });
  const resolvedGroups = selectedGroups
    .map((query) => query.data)
    .filter((group) => group !== undefined);
  const previewScreenId =
    input.targets.find((target) => target.type === "screen")?.id ??
    resolvedGroups[0]?.screens[0]?.id ??
    "";
  const preview = useQuery({
    queryKey: ["schedule-preview", input, previewScreenId],
    queryFn: () =>
      api.previewSchedule(
        previewScreenId,
        schedulePreviewTimestamp(input),
        input,
      ),
    enabled: Boolean(
      previewScreenId &&
      (input.playlistId || input.layoutId || input.displayAction) &&
      valid,
    ),
  });
  const targetCount = countTargetScreens(
    input.targets,
    screens.data?.items ?? [],
    resolvedGroups,
  );

  const set = <K extends keyof ScheduleInput>(
    key: K,
    value: ScheduleInput[K],
  ) => setInput((current) => ({ ...current, [key]: value }));
  const save = useMutation({
    mutationFn: () =>
      id
        ? api.updateSchedule(id, input, csrf)
        : api.createSchedule(input, csrf),
    onSuccess: (schedule) => {
      toast.add({
        title: id ? t("notifications.updated") : t("notifications.created"),
        type: "success",
      });
      const next = scheduleToInput(schedule);
      setBaseline(next);
      setInput(next);
      void client.invalidateQueries({ queryKey: ["schedules"] });
      void navigate(`/schedules/${schedule.id}`, { replace: true });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteSchedule(id!, csrf),
    onSuccess: () => {
      toast.add({ title: t("notifications.deleted"), type: "success" });
      void navigate("/schedules");
    },
  });

  if (id && existing.isLoading)
    return (
      <div className="grid gap-2" aria-label={t("editor.loading")}>
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  return (
    <>
      {confirmDialog}
      <section className="schedule-builder-page">
        <header className="schedule-builder-heading">
          <h1 className="text-2xl font-semibold tracking-tight">
            {id ? t("editor.editTitle") : t("editor.createTitle")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("editor.subtitle")}
          </p>
        </header>
        <form
          className="schedule-builder"
          onSubmit={(event) => {
            event.preventDefault();
            setAttempted(true);
            if (valid) save.mutate();
          }}
        >
          <main className="schedule-builder__main">
            <BuilderSection
              number="1"
              title={t("editor.content")}
              description={t("editor.sections.content.description")}
            >
              <Field>
                <FieldLabel htmlFor="schedule-name">
                  {t("editor.nameLabel")} <span aria-hidden="true">*</span>
                </FieldLabel>
                <Input
                  id="schedule-name"
                  value={input.name}
                  maxLength={180}
                  onChange={(event) => set("name", event.target.value)}
                  placeholder={t("editor.namePlaceholder")}
                  aria-invalid={attempted && errors.name ? true : undefined}
                />
                {attempted && errors.name && (
                  <FieldError>{errors.name}</FieldError>
                )}
              </Field>
              <ToggleGroup
                variant="outline"
                spacing={0}
                className="max-sm:w-full max-sm:*:flex-1"
                aria-label={t("editor.contentTypeLabel")}
                multiple={false}
                value={[input.displayAction ? "display" : "content"]}
                onValueChange={(next) => {
                  if (next[0] === "content") set("displayAction", undefined);
                  else if (next[0] === "display") {
                    set("playlistId", undefined);
                    set("layoutId", undefined);
                    set(
                      "displayAction",
                      input.displayAction ?? { type: "display_power_on" },
                    );
                  }
                }}
              >
                <ToggleGroupItem value="content">
                  {t("editor.content")}
                </ToggleGroupItem>
                <ToggleGroupItem value="display">
                  {t("editor.displayControl")}
                </ToggleGroupItem>
              </ToggleGroup>
              {input.displayAction ? (
                <DisplayControlSelection
                  action={input.displayAction}
                  onChange={(displayAction) =>
                    set("displayAction", displayAction)
                  }
                  error={attempted ? errors.playlistId : undefined}
                />
              ) : (
                <PlaylistSelection
                  playlist={selectedPlaylistData}
                  layout={selectedLayout}
                  onChoose={() => setPlaylistOpen(true)}
                  error={attempted ? errors.playlistId : undefined}
                />
              )}
            </BuilderSection>

            <BuilderSection
              number="2"
              title={t("editor.sections.timing.title")}
              description={t("editor.sections.timing.description")}
            >
              <ToggleGroup
                variant="outline"
                spacing={0}
                className="max-sm:w-full max-sm:*:flex-1"
                aria-label={t("editor.scheduleTypeLabel")}
                multiple={false}
                value={[input.type]}
                onValueChange={(next) => {
                  if (next[0] === "weekly") set("type", "weekly");
                  else if (next[0] === "one_time") {
                    if (!input.oneTimeStart) {
                      const start = new Date();
                      start.setMinutes(
                        Math.ceil(start.getMinutes() / 15) * 15,
                        0,
                        0,
                      );
                      const end = new Date(start.getTime() + 60 * 60 * 1000);
                      setInput((current) => ({
                        ...current,
                        type: "one_time",
                        oneTimeStart: start.toISOString(),
                        oneTimeEnd: end.toISOString(),
                      }));
                    } else set("type", "one_time");
                  }
                }}
              >
                <ToggleGroupItem value="weekly">
                  {t("editor.typeWeekly")}
                </ToggleGroupItem>
                <ToggleGroupItem value="one_time">
                  {t("editor.typeOneTime")}
                </ToggleGroupItem>
              </ToggleGroup>
              {input.type === "weekly" ? (
                <WeeklyTiming
                  input={input}
                  set={set}
                  showDateRange={showDateRange}
                  setShowDateRange={setShowDateRange}
                  errors={attempted ? errors : {}}
                />
              ) : (
                <OneTimeTiming
                  input={input}
                  set={set}
                  error={attempted ? errors.oneTime : undefined}
                />
              )}
              <TimezonePicker
                value={input.timezone}
                onChange={(value) => set("timezone", value)}
                error={attempted ? errors.timezone : undefined}
              />
              <div className="schedule-human-summary">
                <CalendarDays size={18} />
                <span>{describeScheduleTiming(input, t, formatLocale)}</span>
              </div>
            </BuilderSection>

            <BuilderSection
              number="3"
              title={t("editor.sections.targets.title")}
              description={t("editor.sections.targets.description")}
            >
              <TargetPicker
                targets={input.targets}
                screens={screens.data?.items ?? []}
                groups={groups.data?.items ?? []}
                tab={targetTab}
                setTab={setTargetTab}
                search={targetSearch}
                setSearch={setTargetSearch}
                onChange={(targets) => set("targets", targets)}
                error={attempted ? errors.targets : undefined}
              />
            </BuilderSection>

            <BuilderSection
              number="4"
              title={t("editor.sections.advanced.title")}
              description={t("editor.sections.advanced.description")}
              compact
            >
              {/* The wrapping label names the switch; no extra aria-label. */}
              <label className="flex items-start gap-2 text-sm">
                <Switch
                  checked={input.enabled}
                  onCheckedChange={(checked) =>
                    set("enabled", checked === true)
                  }
                  className="mt-0.5"
                />
                <span className="grid gap-0.5">
                  <strong className="font-medium">
                    {t("editor.enabledLabel")}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {t("editor.enabledHint")}
                  </small>
                </span>
              </label>
              <PriorityControl
                value={input.priority}
                onChange={(value) => set("priority", value)}
                error={attempted ? errors.priority : undefined}
              />
              <Field>
                <FieldLabel htmlFor="schedule-description">
                  {t("editor.descriptionLabel")}
                </FieldLabel>
                <Textarea
                  id="schedule-description"
                  value={input.description}
                  maxLength={2000}
                  rows={3}
                  onChange={(event) => set("description", event.target.value)}
                />
                <FieldDescription>
                  {t("editor.descriptionHint")}
                </FieldDescription>
              </Field>
            </BuilderSection>
          </main>

          <ScheduleSummary
            input={input}
            playlist={selectedPlaylistData}
            layout={selectedLayout}
            targetCount={targetCount}
            preview={preview}
          />

          <footer className="schedule-builder__actions">
            <span>
              {dirty
                ? t("editor.status.unsaved")
                : id
                  ? t("editor.status.saved")
                  : t("editor.status.incomplete")}
            </span>
            {id && (
              <Button
                type="button"
                variant="destructive"
                disabled={remove.isPending}
                onClick={() =>
                  void confirm({
                    title: t("editor.deleteTitle", { name: input.name }),
                    action: t("common:actions.delete"),
                    destructive: true,
                  }).then((ok) => {
                    if (ok) remove.mutate();
                  })
                }
              >
                {t("common:actions.delete")}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (!dirty) {
                  void navigate("/schedules");
                  return;
                }
                void confirm({
                  title: t("editor.discardTitle"),
                  action: t("editor.discardAction"),
                  destructive: true,
                }).then((ok) => {
                  if (ok) void navigate("/schedules");
                });
              }}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || !dirty || save.isPending}>
              {save.isPending ? t("common:actions.saving") : t("editor.save")}
            </Button>
            {save.error && (
              <span className="text-sm text-destructive" role="alert">
                {apiErrorMessage(save.error)}
              </span>
            )}
          </footer>
        </form>
        {playlistOpen && (
          <PlaylistPicker
            open
            includeLayouts
            confirmLabel={t("editor.useSelected")}
            selectedId={input.layoutId ?? input.playlistId ?? ""}
            onClose={() => setPlaylistOpen(false)}
            onConfirm={(choice) => {
              // A schedule targets one or the other, so choosing clears the other field.
              set(
                "playlistId",
                choice.kind === "playlist" ? choice.playlist.id : undefined,
              );
              set(
                "layoutId",
                choice.kind === "layout" ? choice.layout.id : undefined,
              );
              setPlaylistOpen(false);
            }}
          />
        )}
      </section>
    </>
  );
}

function BuilderSection({
  number,
  title,
  description,
  compact,
  children,
}: {
  number: string;
  title: string;
  description: string;
  compact?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      className={`schedule-builder-section${compact ? " schedule-builder-section--compact" : ""}`}
    >
      <header>
        <span>{number}</span>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      <div className="schedule-builder-section__content">{children}</div>
    </section>
  );
}

function PlaylistSelection({
  playlist,
  layout,
  onChoose,
  error,
}: {
  playlist?: Playlist;
  layout?: LayoutSummary;
  onChoose: () => void;
  error?: string;
}) {
  const { t } = useTranslation("schedules");
  const duration = playlist ? playlistDuration(playlist, t) : "";
  const thumbnail = playlist?.items?.[0]?.thumbnailUrl;
  return (
    <div className="schedule-playlist-field">
      <span className="text-sm font-medium">
        {t("editor.presentationLabel")} <span aria-hidden="true">*</span>
      </span>
      {playlist || layout ? (
        <div className="schedule-playlist-card">
          <div className="schedule-playlist-card__thumb">
            {thumbnail ? (
              <img src={thumbnail} alt="" />
            ) : (
              <span>
                {layout
                  ? t("editor.presentationLayoutFallback")
                  : t("editor.presentationPlaylistFallback")}
              </span>
            )}
          </div>
          <div>
            <strong>{layout?.name ?? playlist?.name}</strong>
            <span>
              {layout
                ? t("editor.presentationLayoutMeta", {
                    width: layout.canvasWidth,
                    height: layout.canvasHeight,
                    revision: layout.publishedRevision,
                  })
                : t("editor.presentationPlaylistMeta", {
                    count: playlist!.itemCount,
                    duration,
                  })}
            </span>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onChoose}>
            {t("editor.change")}
          </Button>
        </div>
      ) : (
        <Button type="button" variant="secondary" onClick={onChoose}>
          {t("editor.choosePresentation")}
        </Button>
      )}
      {error && (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function DisplayControlSelection({
  action,
  onChange,
  error,
}: {
  action: DisplayControlAction;
  onChange: (action: DisplayControlAction) => void;
  error?: string;
}) {
  const { t } = useTranslation("schedules");
  const setType = (type: DisplayControlAction["type"]) => {
    onChange({ type });
  };
  return (
    <div className="schedule-playlist-field">
      <span className="text-sm font-medium">
        {t("displayAction.label")} <span aria-hidden="true">*</span>
      </span>
      <div className="schedule-control-action">
        <Field>
          <FieldLabel htmlFor="schedule-display-action">
            {t("displayAction.actionLabel")}
          </FieldLabel>
          <Select
            items={displayActionOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            value={action.type}
            onValueChange={(next) => {
              if (next) setType(next);
            }}
          >
            <SelectTrigger
              id="schedule-display-action"
              aria-label={t("displayAction.actionLabel")}
            >
              <SelectValue>
                {displayActionOptionLabel(action.type, t)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {displayActionOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {action.type === "display_set_input" && (
          <Field>
            <FieldLabel htmlFor="schedule-display-input">
              {t("displayAction.inputLabel")}
            </FieldLabel>
            <Input
              id="schedule-display-input"
              value={action.input ?? ""}
              maxLength={32}
              onChange={(event) =>
                onChange({ ...action, input: event.target.value })
              }
            />
            <FieldDescription>{t("displayAction.inputHint")}</FieldDescription>
          </Field>
        )}
        {(action.type === "display_set_volume" ||
          action.type === "display_set_brightness") && (
          <Field>
            <FieldLabel htmlFor="schedule-display-level">
              {action.type === "display_set_volume"
                ? t("displayAction.volumeLabel")
                : t("displayAction.brightnessLabel")}
            </FieldLabel>
            <Input
              id="schedule-display-level"
              type="number"
              min={0}
              max={100}
              value={
                action.type === "display_set_volume"
                  ? (action.volume ?? "")
                  : (action.brightness ?? "")
              }
              onChange={(event) => {
                const value =
                  event.target.value === ""
                    ? undefined
                    : Number(event.target.value);
                onChange(
                  action.type === "display_set_volume"
                    ? { type: action.type, volume: value }
                    : { type: action.type, brightness: value },
                );
              }}
            />
          </Field>
        )}
      </div>
      <Alert>
        <AlertDescription>{t("displayAction.note")}</AlertDescription>
      </Alert>
      {error && (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function WeeklyTiming({
  input,
  set,
  showDateRange,
  setShowDateRange,
  errors,
}: {
  input: ScheduleInput;
  set: <K extends keyof ScheduleInput>(key: K, value: ScheduleInput[K]) => void;
  showDateRange: boolean;
  setShowDateRange: (value: boolean) => void;
  errors: Record<string, string>;
}) {
  const { t } = useTranslation("schedules");
  const overnight = (input.dailyEnd ?? "") <= (input.dailyStart ?? "");
  return (
    <div className="schedule-timing-fields">
      <ToggleGroup
        className="grid w-full grid-cols-7 gap-2 max-sm:grid-cols-4"
        variant="outline"
        aria-label={t("timing.weekdaysLabel")}
        multiple
        value={input.daysOfWeek.map(String)}
        onValueChange={(next) => {
          const days = next.map(Number).sort((a, b) => a - b);
          if (days.length > 0) set("daysOfWeek", days);
        }}
      >
        {scheduleWeekdays.map((day) => {
          const labels = scheduleWeekdayLabels(day.value, t);
          return (
            <ToggleGroupItem
              key={day.value}
              value={String(day.value)}
              aria-label={labels.long}
              className="h-11 w-full"
            >
              {labels.short}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {errors.daysOfWeek && (
        <span className="text-sm text-destructive" role="alert">
          {errors.daysOfWeek}
        </span>
      )}
      <div className="schedule-time-pair">
        <Field>
          <FieldLabel htmlFor="schedule-daily-start">
            {t("timing.starts")}
          </FieldLabel>
          <Input
            id="schedule-daily-start"
            type="time"
            value={input.dailyStart ?? ""}
            onChange={(event) => set("dailyStart", event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="schedule-daily-end">
            {t("timing.ends")}
          </FieldLabel>
          <Input
            id="schedule-daily-end"
            type="time"
            value={input.dailyEnd ?? ""}
            onChange={(event) => set("dailyEnd", event.target.value)}
          />
        </Field>
      </div>
      {errors.time && (
        <span className="text-sm text-destructive" role="alert">
          {errors.time}
        </span>
      )}
      {overnight && (
        <Alert>
          <AlertTitle>
            {input.dailyEnd === input.dailyStart
              ? t("timing.overnight24h")
              : t("timing.overnightTitle")}
          </AlertTitle>
          <AlertDescription>{t("timing.overnightHint")}</AlertDescription>
        </Alert>
      )}
      {!showDateRange ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowDateRange(true)}
        >
          {t("timing.addDateRange")}
        </Button>
      ) : (
        <div className="schedule-date-range">
          <Field>
            <FieldLabel htmlFor="schedule-start-date">
              {t("timing.firstDate")}
            </FieldLabel>
            <DateInput
              id="schedule-start-date"
              value={input.startDate ?? ""}
              max={input.endDate}
              onChange={(value) => set("startDate", value || undefined)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-end-date">
              {t("timing.lastDate")}
            </FieldLabel>
            <DateInput
              id="schedule-end-date"
              value={input.endDate ?? ""}
              min={input.startDate}
              onChange={(value) => set("endDate", value || undefined)}
            />
          </Field>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              set("startDate", undefined);
              set("endDate", undefined);
              setShowDateRange(false);
            }}
          >
            {t("timing.removeDateRange")}
          </Button>
          {errors.dateRange && (
            <span className="text-sm text-destructive" role="alert">
              {errors.dateRange}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function OneTimeTiming({
  input,
  set,
  error,
}: {
  input: ScheduleInput;
  set: <K extends keyof ScheduleInput>(key: K, value: ScheduleInput[K]) => void;
  error?: string;
}) {
  const { t } = useTranslation("schedules");
  return (
    <div className="schedule-timing-fields">
      <div className="schedule-datetime-pair">
        <Field>
          <FieldLabel htmlFor="schedule-onetime-start">
            {t("timing.starts")}
          </FieldLabel>
          <DateTimeInput
            id="schedule-onetime-start"
            aria-label={t("timing.starts")}
            timeLabel={t("timing.startsTimeLabel")}
            value={localDateTime(input.oneTimeStart)}
            onChange={(value) => set("oneTimeStart", toISOString(value))}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="schedule-onetime-end">
            {t("timing.ends")}
          </FieldLabel>
          <DateTimeInput
            id="schedule-onetime-end"
            aria-label={t("timing.ends")}
            timeLabel={t("timing.endsTimeLabel")}
            value={localDateTime(input.oneTimeEnd)}
            min={localDateTime(input.oneTimeStart)}
            onChange={(value) => set("oneTimeEnd", toISOString(value))}
          />
        </Field>
      </div>
      <div className="schedule-duration">
        <Clock3 size={17} aria-hidden="true" />
        <span>{oneTimeDuration(input, t)}</span>
      </div>
      {error && (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function TimezonePicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const { t } = useTranslation("schedules");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => timezoneOptions(value), [value]);
  const candidate = normalizeTimezone(search);
  const options = useMemo(
    () =>
      isTimezoneIdentifier(candidate) && !zones.includes(candidate)
        ? [...zones, candidate]
        : zones,
    [candidate, zones],
  );
  const filtered = options
    .filter((zone) =>
      timezoneLabel(zone).toLowerCase().includes(search.toLowerCase()),
    )
    .slice(0, 80);
  return (
    <div className="schedule-timezone">
      <Field>
        <FieldLabel htmlFor="schedule-timezone">
          {t("timing.timezoneLabel")} <span aria-hidden="true">*</span>
        </FieldLabel>
        <Combobox
          items={options}
          filteredItems={filtered}
          value={value}
          open={open}
          inputValue={open ? search : timezoneLabel(value)}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) setSearch("");
          }}
          onValueChange={(next) => {
            if (typeof next === "string" && isTimezoneIdentifier(next))
              onChange(next);
          }}
          itemToStringLabel={timezoneLabel}
          onInputValueChange={setSearch}
        >
          <ComboboxInput
            id="schedule-timezone"
            placeholder={t("timing.timezoneSearch")}
          />
          <ComboboxContent>
            <ComboboxEmpty>{t("timing.timezoneEmpty")}</ComboboxEmpty>
            <ComboboxList>
              {(zone: string) => (
                <ComboboxItem key={zone} value={zone}>
                  {timezoneLabel(zone)}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </Field>
      {error && (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function TargetPicker({
  targets,
  screens,
  groups,
  tab,
  setTab,
  search,
  setSearch,
  onChange,
  error,
}: {
  targets: ScheduleTarget[];
  screens: Awaited<ReturnType<typeof api.screens>>["items"];
  groups: Awaited<ReturnType<typeof api.screenGroups>>["items"];
  tab: "screens" | "groups";
  setTab: (tab: "screens" | "groups") => void;
  search: string;
  setSearch: (value: string) => void;
  onChange: (targets: ScheduleTarget[]) => void;
  error?: string;
}) {
  const { t } = useTranslation("schedules");
  const screenGroups = new Map(
    groups.flatMap((group) =>
      group.screens.map((screen) => [screen.id, group] as const),
    ),
  );
  const anchor = useComboboxAnchor();
  // Grouped screens schedule as their Display Group. Dedupe so a group with
  // several matching screens still offers one row.
  const screenOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: TargetOption[] = [];
    for (const screen of screens) {
      const group = screenGroups.get(screen.id);
      const option: TargetOption = group
        ? {
            key: `group:${group.id}`,
            type: "group",
            id: group.id,
            name: group.name,
            detail: t("targets.groupDetail", { name: group.name }),
          }
        : {
            key: `screen:${screen.id}`,
            type: "screen",
            id: screen.id,
            name: screen.name,
            detail: screen.location || t("targets.noLocation"),
          };
      if (!seen.has(option.key)) {
        seen.add(option.key);
        options.push(option);
      }
    }
    return options;
    // screenGroups derives from screens and groups, so it stays out of deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screens, groups, t]);
  const groupOptions: TargetOption[] = groups.map((group) => ({
    key: `group:${group.id}`,
    type: "group",
    id: group.id,
    name: group.name,
    detail: t("targets.groupCount", { count: group.membershipCount }),
  }));
  const known = useMemo(
    () =>
      new Map(
        [...screenOptions, ...groupOptions].map((option) => [
          option.key,
          option,
        ]),
      ),
    [screenOptions, groupOptions],
  );
  const query = search.toLowerCase();
  const tabOptions = tab === "screens" ? screenOptions : groupOptions;
  // An option survives when a screen behind it matches, exactly as the
  // previous list did; group rows are deduped to one per group.
  const matchingKeys = new Set(
    screens
      .filter((screen) =>
        `${screen.name} ${screen.location}`.toLowerCase().includes(query),
      )
      .map((screen) => {
        const group = screenGroups.get(screen.id);
        return group ? `group:${group.id}` : `screen:${screen.id}`;
      }),
  );
  const results = tabOptions.filter((option) =>
    tab === "screens"
      ? matchingKeys.has(option.key)
      : option.name.toLowerCase().includes(query),
  );
  const selectedKeys = new Set(
    targets.map((target) => `${target.type}:${target.id}`),
  );
  const selected = targets.map(
    (target) =>
      known.get(`${target.type}:${target.id}`) ?? {
        key: `${target.type}:${target.id}`,
        type: target.type,
        id: target.id,
        name: target.name ?? t("targets.unknownTarget"),
        detail: "",
      },
  );
  const searchLabel =
    tab === "groups" ? t("targets.searchGroups") : t("targets.searchScreens");
  return (
    <div className="schedule-target-picker">
      <ToggleGroup
        variant="outline"
        spacing={0}
        className="max-sm:w-full max-sm:*:flex-1"
        aria-label={t("targets.tabLabel")}
        multiple={false}
        value={[tab]}
        onValueChange={(next) => {
          if (next[0] === "screens" || next[0] === "groups") setTab(next[0]);
        }}
      >
        <ToggleGroupItem value="screens">
          {t("targets.screensTab")}
        </ToggleGroupItem>
        <ToggleGroupItem value="groups">
          {t("targets.groupsTab")}
        </ToggleGroupItem>
      </ToggleGroup>
      <div ref={anchor}>
        <Combobox
          multiple
          items={tabOptions}
          filteredItems={results}
          value={selected}
          onValueChange={(next) =>
            onChange(
              next.map((option) => ({
                type: option.type,
                id: option.id,
                name: option.name,
              })),
            )
          }
          isItemEqualToValue={(a, b) => a.key === b.key}
          onInputValueChange={setSearch}
        >
          <ComboboxValue>
            {(value: TargetOption[]) => (
              <ComboboxChips aria-label={t("targets.selectedLabel")}>
                {value.map((option) => (
                  <ComboboxChip
                    key={option.key}
                    showRemove={false}
                    aria-label={option.name}
                  >
                    {option.name}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="-ml-0.5 size-4.5 opacity-50 hover:opacity-100"
                      aria-label={t("targets.removeOption", {
                        name: option.name,
                      })}
                      onClick={() =>
                        onChange(
                          targets.filter(
                            (target) =>
                              `${target.type}:${target.id}` !== option.key,
                          ),
                        )
                      }
                    >
                      <X size={14} aria-hidden="true" />
                    </Button>
                  </ComboboxChip>
                ))}
                <ComboboxChipsInput
                  placeholder={searchLabel}
                  aria-label={searchLabel}
                />
              </ComboboxChips>
            )}
          </ComboboxValue>
          <ComboboxContent anchor={anchor}>
            <ComboboxEmpty>
              {tab === "groups"
                ? t("targets.emptyGroups")
                : t("targets.emptyScreens")}
            </ComboboxEmpty>
            <ComboboxList>
              {(option: TargetOption) => (
                <ComboboxItem
                  key={option.key}
                  value={option}
                  disabled={selectedKeys.has(option.key)}
                >
                  <span className="grid min-w-0 flex-1 gap-0.5 text-left">
                    <strong className="truncate font-medium">
                      {option.name}
                    </strong>
                    <small className="truncate text-xs text-muted-foreground">
                      {option.detail}
                    </small>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {selectedKeys.has(option.key)
                      ? t("targets.selectedMark")
                      : t("targets.addMark")}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      {error && (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

type TargetOption = {
  key: string;
  type: ScheduleTarget["type"];
  id: string;
  name: string;
  detail: string;
};

function PriorityControl({
  value,
  onChange,
  error,
}: {
  value: number;
  onChange: (value: number) => void;
  error?: string;
}) {
  const { t } = useTranslation("schedules");
  const preset = priorityPreset(value);
  const choose = (next: PriorityPreset) => {
    if (next === "normal") onChange(0);
    else if (next === "important") onChange(100);
    else if (next === "special") onChange(500);
    else if (preset !== "custom") onChange(1);
  };
  const presetLabels: Record<PriorityPreset, string> = {
    normal: t("priority.presets.normal"),
    important: t("priority.presets.important"),
    special: t("priority.presets.special"),
    custom: t("priority.presets.custom"),
  };
  return (
    <div className="schedule-priority">
      <span className="text-sm font-medium">{t("priority.label")}</span>
      <span className="text-sm text-muted-foreground">
        {t("priority.hint")}
      </span>
      <ToggleGroup
        variant="outline"
        spacing={0}
        className="max-sm:w-full max-sm:*:flex-1"
        aria-label={t("priority.controlLabel")}
        multiple={false}
        value={[preset]}
        onValueChange={(next) => {
          const option = next[0] as PriorityPreset | undefined;
          if (option) choose(option);
        }}
      >
        {(["normal", "important", "special", "custom"] as PriorityPreset[]).map(
          (option) => (
            <ToggleGroupItem key={option} value={option}>
              {presetLabels[option]}
            </ToggleGroupItem>
          ),
        )}
      </ToggleGroup>
      {preset === "custom" && (
        <Field>
          <FieldLabel htmlFor="schedule-custom-priority">
            {t("priority.customLabel")}
          </FieldLabel>
          <Input
            id="schedule-custom-priority"
            type="number"
            min="-999"
            max="999"
            value={value}
            onChange={(event) => onChange(Number(event.target.value))}
          />
        </Field>
      )}
      {error && (
        <span className="text-sm text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function ScheduleSummary({
  input,
  playlist,
  layout,
  targetCount,
  preview,
}: {
  input: ScheduleInput;
  playlist?: Playlist;
  layout?: LayoutSummary;
  targetCount: number;
  preview: UseQueryResult<SchedulePreview, Error>;
}) {
  const { t } = useTranslation("schedules");
  const formatLocale = useFormatLocale();
  const conflicts = preview.data?.conflicts ?? [];
  const applicable = preview.data?.applicableSchedules ?? [];
  const winner = preview.data?.winningSchedule;
  const overlapCount = Math.max(conflicts.length, applicable.length - 1);
  return (
    <aside className="schedule-builder-summary" aria-label={t("summary.title")}>
      <h3>{t("summary.title")}</h3>
      <dl>
        <div>
          <dt>{t("summary.when")}</dt>
          <dd>{describeScheduleTiming(input, t, formatLocale)}</dd>
        </div>
        <div>
          <dt>{t("editor.content")}</dt>
          <dd>
            {input.displayAction
              ? displayActionLabel(input.displayAction, t)
              : layout
                ? t("summary.showsLayout", { name: layout.name })
                : playlist
                  ? t("summary.playsPlaylist", { name: playlist.name })
                  : t("editor.noSelection")}
          </dd>
        </div>
        <div>
          <dt>{t("editor.sections.targets.title")}</dt>
          <dd>
            {targetCount
              ? t("summary.targetCount", { count: targetCount })
              : t("summary.noTargets")}
          </dd>
        </div>
        <div>
          <dt>{t("priority.label")}</dt>
          <dd>{priorityLabel(input.priority, t)}</dd>
        </div>
      </dl>
      <div className="schedule-conflicts">
        <h4>{t("summary.conflictTitle")}</h4>
        {!input.targets.length ||
        (!input.playlistId && !input.layoutId && !input.displayAction) ? (
          <Alert>
            <AlertDescription>{t("summary.conflictHint")}</AlertDescription>
          </Alert>
        ) : preview.isLoading ? (
          <Alert>
            <AlertDescription>{t("summary.checking")}</AlertDescription>
          </Alert>
        ) : preview.isError ? (
          <Alert variant="destructive">
            <AlertTitle>{t("summary.unavailable")}</AlertTitle>
            <AlertDescription>
              {apiErrorMessage(preview.error)}
            </AlertDescription>
          </Alert>
        ) : conflicts.length === 0 && applicable.length <= 1 ? (
          <Alert>
            <AlertTitle>{t("summary.noConflicts")}</AlertTitle>
            <AlertDescription>{t("summary.noOverlap")}</AlertDescription>
          </Alert>
        ) : (
          <>
            <Alert>
              <AlertTitle>
                {t("summary.overlapCount", { count: overlapCount })}
              </AlertTitle>
              <AlertDescription>
                {winner
                  ? t("summary.winner", {
                      name: winner.name,
                      reason: conflictWinnerReason(winner, input.priority, t),
                    })
                  : t("summary.fallbackNote")}
              </AlertDescription>
            </Alert>
            <ul>
              {applicable.map((schedule) => (
                <li key={schedule.id}>
                  <strong>{schedule.name}</strong>
                  <span>
                    {priorityLabel(schedule.priority, t)} ·{" "}
                    {schedule.specificity > 0
                      ? t("summary.directTarget")
                      : t("summary.groupTarget")}
                  </span>
                </li>
              ))}
            </ul>
            {conflicts.map((conflict) => (
              <p key={conflict}>{humanizeConflict(conflict)}</p>
            ))}
          </>
        )}
      </div>
      <p className="schedule-summary-note">{t("summary.note")}</p>
    </aside>
  );
}

const displayActionOptions: {
  value: DisplayControlAction["type"];
  labelKey:
    | "displayAction.options.powerOn"
    | "displayAction.options.powerOff"
    | "displayAction.options.setInput"
    | "displayAction.options.setVolume"
    | "displayAction.options.mute"
    | "displayAction.options.unmute"
    | "displayAction.options.setBrightness";
}[] = [
  { value: "display_power_on", labelKey: "displayAction.options.powerOn" },
  { value: "display_power_off", labelKey: "displayAction.options.powerOff" },
  { value: "display_set_input", labelKey: "displayAction.options.setInput" },
  { value: "display_set_volume", labelKey: "displayAction.options.setVolume" },
  { value: "display_mute", labelKey: "displayAction.options.mute" },
  { value: "display_unmute", labelKey: "displayAction.options.unmute" },
  {
    value: "display_set_brightness",
    labelKey: "displayAction.options.setBrightness",
  },
];

function displayActionOptionLabel(
  value: DisplayControlAction["type"],
  t: SchedulesT,
) {
  const option = displayActionOptions.find(
    (candidate) => candidate.value === value,
  );
  return option ? t(option.labelKey) : value;
}

function displayActionLabel(action: DisplayControlAction, t: SchedulesT) {
  const unset = t("displayAction.notSet");
  switch (action.type) {
    case "display_power_on":
      return t("displayAction.summary.powerOn");
    case "display_power_off":
      return t("displayAction.summary.powerOff");
    case "display_set_input":
      return t("displayAction.summary.setInput", {
        value: action.input ?? unset,
      });
    case "display_set_volume":
      return t("displayAction.summary.setVolume", {
        value: action.volume ?? unset,
      });
    case "display_mute":
      return t("displayAction.summary.mute");
    case "display_unmute":
      return t("displayAction.summary.unmute");
    case "display_set_brightness":
      return t("displayAction.summary.setBrightness", {
        value: action.brightness ?? unset,
      });
  }
}

function playlistDuration(playlist: Playlist, t: SchedulesT) {
  if (!playlist.items?.length)
    return playlist.itemCount
      ? t("editor.durationVaries")
      : t("editor.emptyPlaylist");
  const seconds = playlist.items.reduce(
    (total, item) =>
      total +
      (item.durationMs
        ? item.durationMs / 1000
        : (item.assetDurationSeconds ?? 0)),
    0,
  );
  if (!seconds) return t("editor.durationVaries");
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return minutes
    ? `${t("duration.minutes", { count: minutes })}${remainder ? ` ${t("duration.seconds", { count: remainder })}` : ""}`
    : t("duration.seconds", { count: remainder });
}

function localDateTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
function toISOString(value: string) {
  return value ? new Date(value).toISOString() : undefined;
}
function humanizeConflict(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
