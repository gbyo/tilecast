import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  AudioLines,
  ClipboardList,
  Clock3,
  Network,
  Plus,
  Puzzle,
  Siren,
  Stamp,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { useForm, type UseFormRegisterReturn } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { api } from "../api/client";
import type {
  BrandBug,
  BrandBugInput,
  CountdownBarInput,
  NoiseMeter,
  NoiseMeterInput,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
import { FormField } from "../components/FormField";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Panel,
  SectionHeader,
  Select,
  StatusBadge,
  ViewTabs,
} from "../components/ui";
import { scheduleWeekdays } from "../schedules/scheduleBuilderModel";
import "./PluginsPage.css";

const formSchema = z
  .object({
    name: z.string().trim().min(1).max(180),
    message: z.string().trim().min(1).max(280),
    scheduleType: z.enum(["weekly", "one_time"]),
    targetTime: z.string(),
    daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)),
    oneTimeAt: z.string(),
    timezone: z
      .string({ error: "Enter an IANA timezone such as America/Chicago." })
      .trim()
      .min(1, "Enter an IANA timezone such as America/Chicago.")
      .max(100, "Enter an IANA timezone such as America/Chicago."),
    leadMinutes: z.coerce
      .number({ error: "Enter a whole number of minutes." })
      .int("Enter a whole number of minutes.")
      .min(1, "Lead time must be between 1 and 43200 minutes.")
      .max(43_200, "Lead time must be between 1 and 43200 minutes."),
    completionText: z.string().trim().max(280),
    showConfetti: z.boolean(),
    displayMode: z.enum(["overlay", "push"]),
    progressFill: z.enum(["none", "drain"]),
    heightPx: z.coerce
      .number({ error: "Enter a height between 40 and 320 pixels." })
      .int("Enter a height between 40 and 320 pixels.")
      .min(40, "Enter a height between 40 and 320 pixels.")
      .max(320, "Enter a height between 40 and 320 pixels."),
    contentPadding: z.coerce
      .number({ error: "Enter padding between 0 and 40 percent." })
      .int("Enter padding between 0 and 40 percent.")
      .min(0, "Enter padding between 0 and 40 percent.")
      .max(40, "Enter padding between 0 and 40 percent."),
    textScale: z.coerce
      .number({ error: "Enter a text size between 25 and 500 percent." })
      .int("Enter a text size between 25 and 500 percent.")
      .min(25, "Enter a text size between 25 and 500 percent.")
      .max(500, "Enter a text size between 25 and 500 percent."),
    urgencyEnabled: z.boolean(),
    startingSoonMinutes: z.coerce
      .number({ error: "Enter a whole number of minutes." })
      .int("Enter a whole number of minutes.")
      .min(
        1,
        "Starting soon must begin between 1 and 1440 minutes before zero.",
      )
      .max(
        1_440,
        "Starting soon must begin between 1 and 1440 minutes before zero.",
      ),
    urgentSeconds: z.coerce
      .number({ error: "Enter a whole number of seconds." })
      .int("Enter a whole number of seconds.")
      .min(2, "Urgent must begin between 2 and 3600 seconds before zero.")
      .max(3_600, "Urgent must begin between 2 and 3600 seconds before zero."),
    pulseSeconds: z.coerce
      .number({ error: "Enter a whole number of seconds." })
      .int("Enter a whole number of seconds.")
      .min(1, "Pulse must begin between 1 and 60 seconds before zero.")
      .max(60, "Pulse must begin between 1 and 60 seconds before zero."),
    enabled: z.boolean(),
    priority: z.coerce
      .number({ error: "Enter a priority between -1000 and 1000." })
      .int("Enter a priority between -1000 and 1000.")
      .min(-1000, "Enter a priority between -1000 and 1000.")
      .max(1000, "Enter a priority between -1000 and 1000."),
    targetScope: z.enum(["all", "screens", "sync_groups", "locations"]),
    targetIds: z.array(z.string()),
  })
  .superRefine((value, context) => {
    if (
      value.scheduleType === "weekly" &&
      (!/^\d{2}:\d{2}$/.test(value.targetTime) || value.daysOfWeek.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["daysOfWeek"],
        message: "Choose a target time and at least one day.",
      });
    }
    if (value.scheduleType === "one_time" && !value.oneTimeAt) {
      context.addIssue({
        code: "custom",
        path: ["oneTimeAt"],
        message: "Choose the one-time target date and time.",
      });
    }
    if (value.targetScope !== "all" && value.targetIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["targetIds"],
        message: "Choose at least one target.",
      });
    }
    if (
      value.urgencyEnabled &&
      (value.startingSoonMinutes * 60 <= value.urgentSeconds ||
        value.urgentSeconds <= value.pulseSeconds)
    ) {
      context.addIssue({
        code: "custom",
        path: ["startingSoonMinutes"],
        message:
          "Stages must begin in order: starting soon, urgent, then pulse.",
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;
type FormInput = z.input<typeof formSchema>;

function urgencyDefaults(leadMinutes: number) {
  const leadSeconds = Math.max(60, Math.round(leadMinutes * 60));
  const startingSoonMinutes = Math.min(
    1_440,
    Math.max(1, Math.round(leadMinutes / 3)),
  );
  const urgentSeconds = Math.min(
    startingSoonMinutes * 60 - 1,
    3_600,
    Math.max(2, Math.round(leadSeconds / 15)),
  );
  const pulseSeconds = Math.min(
    urgentSeconds - 1,
    60,
    Math.max(1, Math.round(leadSeconds / 90)),
  );
  return { startingSoonMinutes, urgentSeconds, pulseSeconds };
}

const defaultValues: FormValues = {
  name: "",
  message: "Lunch ends in",
  scheduleType: "weekly",
  targetTime: "12:00",
  daysOfWeek: [1, 2, 3, 4, 5],
  oneTimeAt: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  leadMinutes: 15,
  completionText: "",
  showConfetti: false,
  displayMode: "overlay",
  progressFill: "none",
  heightPx: 72,
  contentPadding: 4,
  textScale: 100,
  urgencyEnabled: false,
  startingSoonMinutes: 5,
  urgentSeconds: 60,
  pulseSeconds: 10,
  enabled: true,
  priority: 0,
  targetScope: "all",
  targetIds: [],
};

function canManage(role?: string) {
  return role === "owner" || role === "administrator";
}

/**
 * `datetime-local` inputs carry no zone, and the submit path reads them back
 * with `new Date(value)` — the browser's own zone. Formatting the stored
 * instant the same way keeps the round trip stable instead of shifting the
 * target by the browser's UTC offset on every edit.
 */
function toLocalInputValue(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * Targeting is identical for every plugin, so the scopes, the picker, and its
 * loading, failed, and genuinely-empty wording live here once rather than being
 * copied per editor.
 */
type TargetScope = FormValues["targetScope"];

interface TargetSource {
  query: {
    data?: { items: { id: string; name: string }[] };
    isLoading: boolean;
    isError: boolean;
  };
  noun: string;
  empty: string;
}

function useTargetSource(scope: TargetScope): TargetSource | null {
  const screens = useQuery({
    queryKey: ["screens"],
    queryFn: api.screens,
    enabled: scope === "screens",
  });
  const groups = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
    enabled: scope === "sync_groups",
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
    enabled: scope === "locations",
  });
  return scope === "screens"
    ? { query: screens, noun: "screens", empty: "No screens are enrolled yet." }
    : scope === "sync_groups"
      ? {
          query: groups,
          noun: "Display Groups",
          empty: "No Display Groups exist yet.",
        }
      : scope === "locations"
        ? {
            query: locations,
            noun: "locations",
            empty: "No locations exist yet.",
          }
        : null;
}

function TargetFields({
  idPrefix,
  scope,
  source,
  chosenCount,
  error,
  registerTargetIds,
  onScopeChange,
}: {
  idPrefix: string;
  scope: TargetScope;
  source: TargetSource | null;
  chosenCount: number;
  error?: string;
  registerTargetIds: UseFormRegisterReturn;
  onScopeChange: (value: TargetScope) => void;
}) {
  const targets = (source?.query.data?.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
  }));
  return (
    <>
      <Field label="Target type">
        <Select
          name="targetScope"
          value={scope}
          onChange={(event) => onScopeChange(event.target.value as TargetScope)}
        >
          <option value="all">All screens</option>
          <option value="screens">Individual screens</option>
          <option value="sync_groups">Display Groups</option>
          <option value="locations">Locations</option>
        </Select>
      </Field>
      {source && (
        <div className="plugin-field-group">
          <span className="field__label" id={`${idPrefix}-targets-label`}>
            Choose targets
          </span>
          <div
            className="countdown-targets"
            role="group"
            aria-labelledby={`${idPrefix}-targets-label`}
          >
            <div className="countdown-targets__header">
              <span>Available {source.noun}</span>
              <span>
                {chosenCount} of {targets.length} selected
              </span>
            </div>
            <div className="countdown-targets__list">
              {targets.map((target) => (
                <label className="countdown-target" key={target.id}>
                  <input
                    type="checkbox"
                    value={target.id}
                    {...registerTargetIds}
                  />
                  <span>{target.name}</span>
                </label>
              ))}
              {!targets.length && (
                <p className="countdown-targets__note">
                  {source.query.isLoading
                    ? `Loading ${source.noun}…`
                    : source.query.isError
                      ? `The ${source.noun} could not be loaded.`
                      : source.empty}
                </p>
              )}
            </div>
          </div>
          {error && <span className="field__error">{error}</span>}
        </div>
      )}
    </>
  );
}

/**
 * How Studio presents each plugin the server reports. The server owns the
 * catalog; this is only the icon and the page that manages it. A plugin Studio
 * does not recognise still gets a card — a newer server must not silently drop
 * a feature from the list — it just carries the generic icon and no link.
 */
const pluginPresentation: Record<
  string,
  { icon: LucideIcon; path: string; instanceNoun: [string, string] }
> = {
  countdown_bar: {
    icon: Clock3,
    path: "/plugins/countdown-bar",
    instanceNoun: ["instance", "instances"],
  },
  emergency_alerts: {
    icon: Siren,
    path: "/plugins/emergency-alerts",
    instanceNoun: ["alert rule", "alert rules"],
  },
  forms: {
    icon: ClipboardList,
    path: "/plugins/forms",
    instanceNoun: ["form", "forms"],
  },
  brand_bug: {
    icon: Stamp,
    path: "/plugins/brand-bug",
    instanceNoun: ["mark", "marks"],
  },
  noise_meter: {
    icon: AudioLines,
    path: "/plugins/noise-meter",
    instanceNoun: ["meter", "meters"],
  },
  dependency_graph: {
    icon: Network,
    path: "/plugins/dependency-graph",
    instanceNoun: ["map", "maps"],
  },
};

export function PluginsPage() {
  const plugins = useQuery({ queryKey: ["plugins"], queryFn: api.plugins });
  return (
    <main className="page plugins-page">
      <PageHeader
        title="Plugins"
        description="Built-in Tilecast features that can affect Player behavior outside playlists and Layout zones."
      />
      {plugins.isError && (
        <Notice variant="danger">Plugins could not be loaded.</Notice>
      )}
      <div className="plugin-card-grid">
        {(plugins.data?.items ?? []).map((plugin) => {
          const presentation = pluginPresentation[plugin.id];
          const Icon = presentation?.icon ?? Puzzle;
          const [one, many] = presentation?.instanceNoun ?? [
            "instance",
            "instances",
          ];
          return (
            <article className="plugin-card" key={plugin.id}>
              <div className="plugin-card__icon" aria-hidden="true">
                <Icon size={24} />
              </div>
              <div className="plugin-card__copy">
                <div className="plugin-card__heading">
                  <h2>{plugin.name}</h2>
                  <StatusBadge
                    label={plugin.enabled ? "Enabled" : "Disabled"}
                    tone={plugin.enabled ? "success" : "neutral"}
                  />
                </div>
                <p>{plugin.description}</p>
                <span className="plugin-card__instances">
                  {plugin.instanceCount} configured{" "}
                  {plugin.instanceCount === 1 ? one : many}
                </span>
              </div>
              {presentation && (
                <Link
                  className="button button--secondary"
                  to={presentation.path}
                >
                  Manage plugin
                </Link>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}

export function CountdownBarsPage() {
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const instances = useQuery({
    queryKey: ["countdown-bars"],
    queryFn: api.countdownBars,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.deleteCountdownBar(id, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["countdown-bars"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
  const manageable = canManage(auth.status?.user?.role);
  // Only a successful, empty list is "nothing configured" — a failed load must
  // not read as an empty fleet.
  const showEmptyState =
    !instances.isError &&
    !instances.isLoading &&
    (instances.data?.items.length ?? 0) === 0;
  return (
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins">
            <ArrowLeft size={15} /> Plugins
          </Link>
        }
        title="Countdown Bar"
        description="Timed bars run independently of the playlist and keep evaluating from the Player's cached manifest."
        actions={
          manageable ? (
            <Link
              className="button button--primary"
              to="/plugins/countdown-bar/new"
            >
              <Plus size={16} /> New instance
            </Link>
          ) : undefined
        }
      />
      {!manageable && (
        <Notice>
          Owner or Administrator access is required to make changes.
        </Notice>
      )}
      {instances.isError && (
        <Notice variant="danger">Countdown bars could not be loaded.</Notice>
      )}
      {remove.isError && (
        <Notice variant="danger">{remove.error.message}</Notice>
      )}
      {showEmptyState ? (
        <EmptyState
          icon={<Clock3 />}
          title="No countdown bars configured"
          message="Create an instance to show a locally-timed bar on selected screens."
          action={
            manageable ? (
              <Link
                className="button button--primary"
                to="/plugins/countdown-bar/new"
              >
                Create instance
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="plugin-instance-list">
          {(instances.data?.items ?? []).map((instance) => (
            <article className="plugin-instance" key={instance.id}>
              <div>
                <div className="plugin-instance__heading">
                  <h2>{instance.name}</h2>
                  <StatusBadge
                    label={instance.enabled ? "Enabled" : "Disabled"}
                    tone={instance.enabled ? "success" : "neutral"}
                  />
                </div>
                <p>
                  {instance.message} · {instance.displayMode} ·{" "}
                  {instance.heightPx}px · priority {instance.priority}
                </p>
              </div>
              <div className="plugin-instance__actions">
                <Link
                  className="button button--secondary"
                  to={`/plugins/countdown-bar/${instance.id}`}
                >
                  Manage
                </Link>
                {manageable && (
                  <Button
                    compact
                    variant="danger"
                    aria-label={`Delete ${instance.name}`}
                    onClick={async () => {
                      if (await confirm({
                        title: `Delete “${instance.name}”?`,
                        description:
                          "The bar will be removed from targeted Players.",
                        confirmLabel: "Delete countdown bar",
                        tone: "negative",
                      }))
                        remove.mutate(instance.id);
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

export function CountdownBarEditorPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const instance = useQuery({
    queryKey: ["countdown-bar", id],
    queryFn: () => api.countdownBar(id ?? ""),
    enabled: editing,
  });
  const previousLeadMinutes = useRef(defaultValues.leadMinutes);
  const linkedUrgencyDefaults = useRef({
    startingSoonMinutes: true,
    urgentSeconds: true,
    pulseSeconds: true,
  });
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues,
  });
  useEffect(() => {
    if (!instance.data) return;
    const value = instance.data;
    const leadMinutes = value.leadTimeSeconds / 60;
    const derived = urgencyDefaults(leadMinutes);
    const storedStartingSoon = (value.startingSoonSeconds ?? 300) / 60;
    const storedUrgent = value.urgentSeconds ?? 60;
    const storedPulse = value.pulseSeconds ?? 10;
    previousLeadMinutes.current = leadMinutes;
    linkedUrgencyDefaults.current = {
      startingSoonMinutes:
        storedStartingSoon === derived.startingSoonMinutes ||
        storedStartingSoon === defaultValues.startingSoonMinutes,
      urgentSeconds:
        storedUrgent === derived.urgentSeconds ||
        storedUrgent === defaultValues.urgentSeconds,
      pulseSeconds:
        storedPulse === derived.pulseSeconds ||
        storedPulse === defaultValues.pulseSeconds,
    };
    reset({
      name: value.name,
      message: value.message,
      scheduleType: value.scheduleType,
      targetTime: value.targetTime ?? "",
      daysOfWeek: value.daysOfWeek,
      oneTimeAt: value.oneTimeAt ? toLocalInputValue(value.oneTimeAt) : "",
      timezone: value.timezone,
      leadMinutes,
      completionText: value.completionText,
      showConfetti: value.showConfetti ?? false,
      displayMode: value.displayMode,
      progressFill: value.progressFill ?? "none",
      heightPx: value.heightPx,
      contentPadding: value.contentPadding ?? 4,
      textScale: value.textScale ?? 100,
      urgencyEnabled: value.urgencyEnabled ?? false,
      startingSoonMinutes: storedStartingSoon,
      urgentSeconds: storedUrgent,
      pulseSeconds: storedPulse,
      enabled: value.enabled,
      priority: value.priority,
      targetScope: value.targetScope,
      targetIds: value.targetIds,
    });
  }, [instance.data, reset]);
  const save = useMutation({
    mutationFn: (input: CountdownBarInput) =>
      editing
        ? api.updateCountdownBar(id ?? "", input, auth.status?.csrfToken ?? "")
        : api.createCountdownBar(input, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["countdown-bars"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void navigate("/plugins/countdown-bar");
    },
  });
  const scheduleType = watch("scheduleType");
  const targetScope = watch("targetScope");
  const displayMode = watch("displayMode");
  const progressFill = watch("progressFill");
  const urgencyEnabled = watch("urgencyEnabled");
  const leadMinutes = Number(watch("leadMinutes"));
  useEffect(() => {
    if (
      !Number.isFinite(leadMinutes) ||
      leadMinutes < 1 ||
      leadMinutes === previousLeadMinutes.current
    ) {
      return;
    }
    previousLeadMinutes.current = leadMinutes;
    const derived = urgencyDefaults(leadMinutes);
    for (const field of [
      "startingSoonMinutes",
      "urgentSeconds",
      "pulseSeconds",
    ] as const) {
      if (linkedUrgencyDefaults.current[field]) {
        setValue(field, derived[field], {
          shouldDirty: false,
          shouldValidate: false,
        });
      }
    }
  }, [leadMinutes, setValue]);
  // Signal Select owns the ref on its hidden native select, so register()'s ref
  // never lands and react-hook-form drops the field on the next render. The
  // three selects are held explicitly instead.
  const setScheduleType = (value: string) =>
    setValue("scheduleType", value as FormValues["scheduleType"], {
      shouldDirty: true,
    });
  const setDisplayMode = (value: string) =>
    setValue("displayMode", value as FormValues["displayMode"], {
      shouldDirty: true,
    });
  const setProgressFill = (value: string) =>
    setValue("progressFill", value as FormValues["progressFill"], {
      shouldDirty: true,
    });
  // Days are held as numbers, so a checkbox group cannot express them: react-hook-form
  // compares an input's string `value` against the stored array, and a number never
  // matches. The Signal weekday toggles used by Schedules keep the numeric form.
  const daysOfWeek = watch("daysOfWeek");
  const selectedDays = (daysOfWeek ?? []).map(Number);
  const toggleDay = (day: number) => {
    const next = selectedDays.includes(day)
      ? selectedDays.filter((value) => value !== day)
      : [...selectedDays, day];
    setValue("daysOfWeek", next, {
      shouldDirty: true,
      shouldValidate: Boolean(errors.daysOfWeek),
    });
  };
  const targetSource = useTargetSource(targetScope);
  const chosenTargets = watch("targetIds") ?? [];
  const submit = (values: FormValues) => {
    save.mutate({
      name: values.name,
      message: values.message,
      scheduleType: values.scheduleType,
      targetTime:
        values.scheduleType === "weekly" ? values.targetTime : undefined,
      daysOfWeek: values.scheduleType === "weekly" ? values.daysOfWeek : [],
      oneTimeAt:
        values.scheduleType === "one_time"
          ? new Date(values.oneTimeAt).toISOString()
          : undefined,
      timezone: values.timezone,
      leadTimeSeconds: values.leadMinutes * 60,
      completionText: values.completionText,
      showConfetti: values.showConfetti,
      displayMode: values.displayMode,
      progressFill: values.progressFill,
      heightPx: values.heightPx,
      contentPadding: values.contentPadding,
      textScale: values.textScale,
      urgencyEnabled: values.urgencyEnabled,
      startingSoonSeconds: values.startingSoonMinutes * 60,
      urgentSeconds: values.urgentSeconds,
      pulseSeconds: values.pulseSeconds,
      enabled: values.enabled,
      priority: values.priority,
      targetScope: values.targetScope,
      targetIds: values.targetScope === "all" ? [] : values.targetIds,
    });
  };
  return (
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins/countdown-bar">
            <ArrowLeft size={15} /> Countdown Bar
          </Link>
        }
        title={editing ? "Manage countdown bar" : "New countdown bar"}
        description="The Player evaluates this schedule locally. Priority decides which bar wins when instances overlap."
      />
      <form
        className="plugin-form"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <Panel className="plugin-form__section">
          <SectionHeader title="Content" />
          <FormField
            id="countdown-name"
            label="Name"
            aria-required="true"
            error={errors.name?.message}
            {...register("name")}
          />
          <FormField
            id="countdown-message"
            label="Message"
            aria-required="true"
            error={errors.message?.message}
            {...register("message")}
          />
          <FormField
            id="countdown-completion"
            label="Optional completion text"
            placeholder="Lunch is over"
            hint="Shown for one minute after the target; leave blank to hide at zero."
            error={errors.completionText?.message}
            {...register("completionText")}
          />
          <Checkbox
            label="Show confetti when the countdown reaches zero"
            {...register("showConfetti")}
          />
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Timing" />
          <Field label="Schedule">
            <Select
              name="scheduleType"
              value={scheduleType}
              onChange={(event) => setScheduleType(event.target.value)}
            >
              <option value="weekly">Days of the week</option>
              <option value="one_time">One-time date</option>
            </Select>
          </Field>
          {scheduleType === "weekly" ? (
            <>
              <FormField
                id="countdown-target-time"
                label="Target time"
                type="time"
                error={errors.targetTime?.message}
                {...register("targetTime")}
              />
              <div className="plugin-field-group">
                <span className="field__label" id="countdown-days-label">
                  Days of the week
                </span>
                <div
                  className="countdown-weekdays"
                  role="group"
                  aria-labelledby="countdown-days-label"
                >
                  {scheduleWeekdays.map((day) => (
                    <button
                      type="button"
                      key={day.value}
                      aria-pressed={selectedDays.includes(day.value)}
                      onClick={() => toggleDay(day.value)}
                    >
                      {day.short}
                    </button>
                  ))}
                </div>
                {errors.daysOfWeek && (
                  <span className="field__error">
                    {errors.daysOfWeek.message}
                  </span>
                )}
              </div>
            </>
          ) : (
            <FormField
              id="countdown-one-time"
              label="Target date and time"
              type="datetime-local"
              hint="Entered in this browser's local time; the Player counts down to the same instant."
              error={errors.oneTimeAt?.message}
              {...register("oneTimeAt")}
            />
          )}
          <div className="plugin-form__row">
            <FormField
              id="countdown-timezone"
              label="Timezone"
              aria-required="true"
              error={errors.timezone?.message}
              {...register("timezone")}
            />
            <FormField
              id="countdown-lead"
              label="Appear this many minutes before"
              type="number"
              min={1}
              max={43_200}
              error={errors.leadMinutes?.message}
              {...register("leadMinutes", { valueAsNumber: true })}
            />
          </div>
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Display" />
          <div className="plugin-form__row">
            <Field label="Mode">
              <Select
                name="displayMode"
                value={displayMode}
                onChange={(event) => setDisplayMode(event.target.value)}
              >
                <option value="overlay">Overlay current content</option>
                <option value="push">Push and shrink current content</option>
              </Select>
            </Field>
            <Field
              label="Background countdown"
              description="Drain empties the bar from right to left as the target approaches."
            >
              <Select
                name="progressFill"
                // The Field description joins the wrapping label's text, so the
                // control names itself rather than inheriting label + hint.
                aria-label="Background countdown"
                value={progressFill}
                onChange={(event) => setProgressFill(event.target.value)}
              >
                <option value="none">Plain background</option>
                <option value="drain">Drain right to left</option>
              </Select>
            </Field>
            <FormField
              id="countdown-height"
              label="Bottom-bar height (px)"
              type="number"
              min={40}
              max={320}
              error={errors.heightPx?.message}
              {...register("heightPx", { valueAsNumber: true })}
            />
            <FormField
              id="countdown-padding"
              label="Horizontal padding (%)"
              hint="Lower padding gives the message and countdown more room."
              aria-label="Horizontal padding (%)"
              type="number"
              min={0}
              max={40}
              error={errors.contentPadding?.message}
              {...register("contentPadding", { valueAsNumber: true })}
            />
            <FormField
              id="countdown-text-scale"
              label="Text size (%)"
              hint="Increase the type size without changing the bar height."
              aria-label="Text size (%)"
              type="number"
              min={25}
              max={500}
              error={errors.textScale?.message}
              {...register("textScale", { valueAsNumber: true })}
            />
            <FormField
              id="countdown-priority"
              label="Priority"
              type="number"
              min={-1000}
              max={1000}
              error={errors.priority?.message}
              {...register("priority", { valueAsNumber: true })}
            />
          </div>
          <Checkbox label="Enabled" {...register("enabled")} />
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader
            title="Urgency stages"
            description="Change the bar automatically as the target approaches. Untouched stage times follow the total lead time; custom values stay fixed. Completed messages return to the normal size."
          />
          <Checkbox
            label="Enable countdown urgency stages"
            {...register("urgencyEnabled")}
          />
          {urgencyEnabled && (
            <div className="plugin-form__row">
              <FormField
                id="countdown-starting-soon"
                label="Starting soon (orange), minutes before"
                type="number"
                min={1}
                max={1_440}
                error={errors.startingSoonMinutes?.message}
                {...register("startingSoonMinutes", {
                  valueAsNumber: true,
                  onChange: () => {
                    linkedUrgencyDefaults.current.startingSoonMinutes = false;
                  },
                })}
              />
              <FormField
                id="countdown-urgent"
                label="Urgent (red), seconds before"
                type="number"
                min={2}
                max={3_600}
                error={errors.urgentSeconds?.message}
                {...register("urgentSeconds", {
                  valueAsNumber: true,
                  onChange: () => {
                    linkedUrgencyDefaults.current.urgentSeconds = false;
                  },
                })}
              />
              <FormField
                id="countdown-pulse"
                label="Pulse and enlarge, final seconds"
                hint="The bar and text grow by 25% during this final stage."
                type="number"
                min={1}
                max={60}
                error={errors.pulseSeconds?.message}
                {...register("pulseSeconds", {
                  valueAsNumber: true,
                  onChange: () => {
                    linkedUrgencyDefaults.current.pulseSeconds = false;
                  },
                })}
              />
            </div>
          )}
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Targets" />
          <TargetFields
            idPrefix="countdown"
            scope={targetScope}
            source={targetSource}
            chosenCount={chosenTargets.length}
            error={errors.targetIds?.message}
            registerTargetIds={register("targetIds")}
            onScopeChange={(value) => {
              // Ids from the previous scope would otherwise stay registered and
              // be submitted alongside the new scope's picks.
              setValue("targetIds", []);
              setValue("targetScope", value, { shouldDirty: true });
            }}
          />
        </Panel>

        {save.isError && <Notice variant="danger">{save.error.message}</Notice>}
        <div className="plugin-form__actions">
          <Link
            className="button button--secondary"
            to="/plugins/countdown-bar"
          >
            Cancel
          </Link>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {editing ? "Save changes" : "Create instance"}
          </Button>
        </div>
      </form>
    </main>
  );
}

// ------------------------------------------------------ Brand Bug / Watermark

const cornerLabels: Record<BrandBugInput["corner"], string> = {
  top_left: "Top left",
  top_right: "Top right",
  bottom_left: "Bottom left",
  bottom_right: "Bottom right",
};

const brandBugSchema = z
  .object({
    name: z.string().trim().min(1).max(180),
    corner: z.enum(["top_left", "top_right", "bottom_left", "bottom_right"]),
    imageAssetId: z.string(),
    text: z.string().trim().max(180, "Text is limited to 180 characters."),
    widthPercent: z.coerce
      .number({ error: "Enter a width between 2 and 40 percent." })
      .int("Enter a width between 2 and 40 percent.")
      .min(2, "Enter a width between 2 and 40 percent.")
      .max(40, "Enter a width between 2 and 40 percent."),
    textSizePercent: z.coerce
      .number({ error: "Enter a text size between 1 and 12 percent." })
      .int("Enter a text size between 1 and 12 percent.")
      .min(1, "Enter a text size between 1 and 12 percent.")
      .max(12, "Enter a text size between 1 and 12 percent."),
    opacityPercent: z.coerce
      .number({ error: "Enter an opacity between 10 and 100 percent." })
      .int("Enter an opacity between 10 and 100 percent.")
      .min(10, "Enter an opacity between 10 and 100 percent.")
      .max(100, "Enter an opacity between 10 and 100 percent."),
    marginPercent: z.coerce
      .number({ error: "Enter a margin between 0 and 20 percent." })
      .int("Enter a margin between 0 and 20 percent.")
      .min(0, "Enter a margin between 0 and 20 percent.")
      .max(20, "Enter a margin between 0 and 20 percent."),
    textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a color."),
    backgroundStyle: z.enum(["none", "scrim"]),
    startsAt: z.string(),
    endsAt: z.string(),
    enabled: z.boolean(),
    priority: z.coerce
      .number({ error: "Enter a priority between -1000 and 1000." })
      .int("Enter a priority between -1000 and 1000.")
      .min(-1000, "Enter a priority between -1000 and 1000.")
      .max(1000, "Enter a priority between -1000 and 1000."),
    targetScope: z.enum(["all", "screens", "sync_groups", "locations"]),
    targetIds: z.array(z.string()),
  })
  .superRefine((value, context) => {
    if (!value.imageAssetId && value.text.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "Choose a logo image, enter text, or both.",
      });
    }
    if (
      value.startsAt &&
      value.endsAt &&
      new Date(value.endsAt) <= new Date(value.startsAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "The end must be after the start.",
      });
    }
    if (value.targetScope !== "all" && value.targetIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["targetIds"],
        message: "Choose at least one target.",
      });
    }
  });

type BrandBugFormValues = z.infer<typeof brandBugSchema>;
type BrandBugFormInput = z.input<typeof brandBugSchema>;

const brandBugDefaults: BrandBugFormValues = {
  name: "",
  corner: "top_right",
  imageAssetId: "",
  text: "",
  widthPercent: 12,
  textSizePercent: 3,
  opacityPercent: 90,
  marginPercent: 3,
  textColor: "#ffffff",
  backgroundStyle: "scrim",
  startsAt: "",
  endsAt: "",
  enabled: true,
  priority: 0,
  targetScope: "all",
  targetIds: [],
};

/** One line describing what a configured mark actually puts on screen. */
function brandBugSummary(instance: BrandBug) {
  const parts = [cornerLabels[instance.corner]];
  if (instance.imageAssetId) parts.push("logo");
  if (instance.text) parts.push(`“${instance.text}”`);
  parts.push(`${instance.opacityPercent}% opacity`);
  if (instance.startsAt || instance.endsAt) parts.push("scheduled window");
  return parts.join(" · ");
}

export function BrandBugsPage() {
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const instances = useQuery({
    queryKey: ["brand-bugs"],
    queryFn: api.brandBugs,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.deleteBrandBug(id, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["brand-bugs"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
  const manageable = canManage(auth.status?.user?.role);
  // Only a successful, empty list is "nothing configured" — a failed load must
  // not read as an empty fleet.
  const showEmptyState =
    !instances.isError &&
    !instances.isLoading &&
    (instances.data?.items.length ?? 0) === 0;
  return (
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins">
            <ArrowLeft size={15} /> Plugins
          </Link>
        }
        title="Brand Bug / Watermark"
        description="Corner marks stay on screen over playlists, Layouts, websites, and Widgets without changing what is playing."
        actions={
          manageable ? (
            <Link
              className="button button--primary"
              to="/plugins/brand-bug/new"
            >
              <Plus size={16} /> New instance
            </Link>
          ) : undefined
        }
      />
      {!manageable && (
        <Notice>
          Owner or Administrator access is required to make changes.
        </Notice>
      )}
      {instances.isError && (
        <Notice variant="danger">Brand bugs could not be loaded.</Notice>
      )}
      {remove.isError && (
        <Notice variant="danger">{remove.error.message}</Notice>
      )}
      {showEmptyState ? (
        <EmptyState
          icon={<Stamp />}
          title="No brand bugs configured"
          message="Create an instance to hold a logo, notice, or badge in a corner of selected screens."
          action={
            manageable ? (
              <Link
                className="button button--primary"
                to="/plugins/brand-bug/new"
              >
                Create instance
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="plugin-instance-list">
          {(instances.data?.items ?? []).map((instance) => (
            <article className="plugin-instance" key={instance.id}>
              <div>
                <div className="plugin-instance__heading">
                  <h2>{instance.name}</h2>
                  <StatusBadge
                    label={instance.enabled ? "Enabled" : "Disabled"}
                    tone={instance.enabled ? "success" : "neutral"}
                  />
                </div>
                <p>{brandBugSummary(instance)}</p>
              </div>
              <div className="plugin-instance__actions">
                <Link
                  className="button button--secondary"
                  to={`/plugins/brand-bug/${instance.id}`}
                >
                  Manage
                </Link>
                {manageable && (
                  <Button
                    compact
                    variant="danger"
                    aria-label={`Delete ${instance.name}`}
                    onClick={async () => {
                      if (await confirm({
                        title: `Delete “${instance.name}”?`,
                        description:
                          "The mark will be removed from targeted Players.",
                        confirmLabel: "Delete Brand Bug",
                        tone: "negative",
                      }))
                        remove.mutate(instance.id);
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

export function BrandBugEditorPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const instance = useQuery({
    queryKey: ["brand-bug", id],
    queryFn: () => api.brandBug(id ?? ""),
    enabled: editing,
  });
  // Only a ready image can be projected into a manifest, so only ready images
  // are offered here.
  const images = useQuery({
    queryKey: ["brand-bug-image-assets"],
    queryFn: () =>
      api.assets(
        new URLSearchParams({
          page: "1",
          pageSize: "100",
          type: "image",
          status: "ready",
          sort: "name",
        }),
      ),
  });
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<BrandBugFormInput, unknown, BrandBugFormValues>({
    resolver: zodResolver(brandBugSchema),
    defaultValues: brandBugDefaults,
  });
  useEffect(() => {
    if (!instance.data) return;
    const value = instance.data;
    reset({
      name: value.name,
      corner: value.corner,
      imageAssetId: value.imageAssetId ?? "",
      text: value.text,
      widthPercent: value.widthPercent,
      textSizePercent: value.textSizePercent,
      opacityPercent: value.opacityPercent,
      marginPercent: value.marginPercent,
      textColor: value.textColor,
      backgroundStyle: value.backgroundStyle,
      startsAt: value.startsAt ? toLocalInputValue(value.startsAt) : "",
      endsAt: value.endsAt ? toLocalInputValue(value.endsAt) : "",
      enabled: value.enabled,
      priority: value.priority,
      targetScope: value.targetScope,
      targetIds: value.targetIds,
    });
  }, [instance.data, reset]);
  const save = useMutation({
    mutationFn: (input: BrandBugInput) =>
      editing
        ? api.updateBrandBug(id ?? "", input, auth.status?.csrfToken ?? "")
        : api.createBrandBug(input, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["brand-bugs"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void navigate("/plugins/brand-bug");
    },
  });
  // Signal Select owns the ref on its hidden native select, so register()'s ref
  // never lands and react-hook-form drops the field on the next render. Every
  // select here is held with watch/setValue instead.
  const corner = watch("corner");
  const backgroundStyle = watch("backgroundStyle");
  const imageAssetId = watch("imageAssetId");
  const targetScope = watch("targetScope");
  const targetSource = useTargetSource(targetScope);
  const chosenTargets = watch("targetIds") ?? [];
  const submit = (values: BrandBugFormValues) => {
    save.mutate({
      name: values.name,
      corner: values.corner,
      imageAssetId: values.imageAssetId || null,
      text: values.text,
      widthPercent: values.widthPercent,
      textSizePercent: values.textSizePercent,
      opacityPercent: values.opacityPercent,
      marginPercent: values.marginPercent,
      textColor: values.textColor,
      backgroundStyle: values.backgroundStyle,
      startsAt: values.startsAt
        ? new Date(values.startsAt).toISOString()
        : null,
      endsAt: values.endsAt ? new Date(values.endsAt).toISOString() : null,
      enabled: values.enabled,
      priority: values.priority,
      targetScope: values.targetScope,
      targetIds: values.targetScope === "all" ? [] : values.targetIds,
    });
  };
  return (
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins/brand-bug">
            <ArrowLeft size={15} /> Brand Bug / Watermark
          </Link>
        }
        title={editing ? "Manage brand bug" : "New brand bug"}
        description="One mark shows per corner. Priority decides which instance wins when two want the same corner."
      />
      <form
        className="plugin-form"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <Panel className="plugin-form__section">
          <SectionHeader title="Mark" />
          <FormField
            id="brand-bug-name"
            label="Name"
            aria-required="true"
            error={errors.name?.message}
            {...register("name")}
          />
          <Field
            label="Logo image"
            description="Uploaded, processed images only."
          >
            <Select
              name="imageAssetId"
              value={imageAssetId}
              onChange={(event) =>
                setValue("imageAssetId", event.target.value, {
                  shouldDirty: true,
                })
              }
            >
              <option value="">No image</option>
              {(images.data?.items ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </Field>
          <FormField
            id="brand-bug-text"
            label="Text"
            placeholder="Presented by Example"
            hint="Shown beneath the logo, or on its own for a notice or location label."
            error={errors.text?.message}
            {...register("text")}
          />
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Placement" />
          <div className="plugin-form__row">
            <Field label="Corner">
              <Select
                name="corner"
                value={corner}
                onChange={(event) =>
                  setValue(
                    "corner",
                    event.target.value as BrandBugFormValues["corner"],
                    { shouldDirty: true },
                  )
                }
              >
                {(Object.keys(cornerLabels) as BrandBugInput["corner"][]).map(
                  (value) => (
                    <option key={value} value={value}>
                      {cornerLabels[value]}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <FormField
              id="brand-bug-width"
              label="Logo width (% of screen width)"
              type="number"
              min={2}
              max={40}
              error={errors.widthPercent?.message}
              {...register("widthPercent", { valueAsNumber: true })}
            />
            <FormField
              id="brand-bug-margin"
              label="Margin (% of short edge)"
              type="number"
              min={0}
              max={20}
              error={errors.marginPercent?.message}
              {...register("marginPercent", { valueAsNumber: true })}
            />
          </div>
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Appearance" />
          <div className="plugin-form__row">
            <FormField
              id="brand-bug-text-size"
              label="Text size (% of screen height)"
              type="number"
              min={1}
              max={12}
              error={errors.textSizePercent?.message}
              {...register("textSizePercent", { valueAsNumber: true })}
            />
            <FormField
              id="brand-bug-color"
              label="Text color"
              type="color"
              error={errors.textColor?.message}
              {...register("textColor")}
            />
            <Field label="Backing">
              <Select
                name="backgroundStyle"
                value={backgroundStyle}
                onChange={(event) =>
                  setValue(
                    "backgroundStyle",
                    event.target.value as BrandBugFormValues["backgroundStyle"],
                    { shouldDirty: true },
                  )
                }
              >
                <option value="scrim">Shaded plate behind the mark</option>
                <option value="none">Nothing behind the mark</option>
              </Select>
            </Field>
          </div>
          <div className="plugin-form__row">
            <FormField
              id="brand-bug-opacity"
              label="Opacity (%)"
              type="number"
              min={10}
              max={100}
              error={errors.opacityPercent?.message}
              {...register("opacityPercent", { valueAsNumber: true })}
            />
            <FormField
              id="brand-bug-priority"
              label="Priority"
              type="number"
              min={-1000}
              max={1000}
              error={errors.priority?.message}
              {...register("priority", { valueAsNumber: true })}
            />
          </div>
          <Checkbox label="Enabled" {...register("enabled")} />
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Optional window" />
          <div className="plugin-form__row">
            <FormField
              id="brand-bug-starts"
              label="Show from"
              type="datetime-local"
              hint="Leave blank to show as soon as it is enabled."
              error={errors.startsAt?.message}
              {...register("startsAt")}
            />
            <FormField
              id="brand-bug-ends"
              label="Show until"
              type="datetime-local"
              hint="Leave blank to show indefinitely."
              error={errors.endsAt?.message}
              {...register("endsAt")}
            />
          </div>
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Targets" />
          <TargetFields
            idPrefix="brand-bug"
            scope={targetScope}
            source={targetSource}
            chosenCount={chosenTargets.length}
            error={errors.targetIds?.message}
            registerTargetIds={register("targetIds")}
            onScopeChange={(value) => {
              setValue("targetIds", []);
              setValue("targetScope", value, { shouldDirty: true });
            }}
          />
        </Panel>

        {save.isError && <Notice variant="danger">{save.error.message}</Notice>}
        <div className="plugin-form__actions">
          <Link className="button button--secondary" to="/plugins/brand-bug">
            Cancel
          </Link>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {editing ? "Save changes" : "Create instance"}
          </Button>
        </div>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------- Noise Meter

/**
 * Studio talks in seconds and in a 0-100 scale; the wire talks in milliseconds.
 * Nothing here exposes dBFS, gain, or a microphone device: the level is
 * relative to whatever microphone is plugged into the player, and presenting it
 * as a calibrated measurement would be a claim Tilecast cannot make.
 */
const noiseMeterSchema = z
  .object({
    name: z.string().trim().min(1).max(180),
    message: z
      .string()
      .trim()
      .max(120, "Message is limited to 120 characters."),
    warningLevel: z.coerce
      .number({ error: "Enter a level between 1 and 99." })
      .int("Enter a level between 1 and 99.")
      .min(1, "Enter a level between 1 and 99.")
      .max(99, "Enter a level between 1 and 99."),
    loudLevel: z.coerce
      .number({ error: "Enter a level between 2 and 100." })
      .int("Enter a level between 2 and 100.")
      .min(2, "Enter a level between 2 and 100.")
      .max(100, "Enter a level between 2 and 100."),
    sensitivity: z.coerce
      .number({ error: "Enter a sensitivity between 25 and 300 percent." })
      .int("Enter a sensitivity between 25 and 300 percent.")
      .min(25, "Enter a sensitivity between 25 and 300 percent.")
      .max(300, "Enter a sensitivity between 25 and 300 percent."),
    showAfterSeconds: z.coerce
      .number({ error: "Enter between 0.1 and 10 seconds." })
      .min(0.1, "Enter between 0.1 and 10 seconds.")
      .max(10, "Enter between 0.1 and 10 seconds."),
    hideAfterSeconds: z.coerce
      .number({ error: "Enter between 0.5 and 30 seconds." })
      .min(0.5, "Enter between 0.5 and 30 seconds.")
      .max(30, "Enter between 0.5 and 30 seconds."),
    displayMode: z.enum(["overlay", "push"]),
    heightPx: z.coerce
      .number({ error: "Enter a height between 40 and 320 pixels." })
      .int("Enter a height between 40 and 320 pixels.")
      .min(40, "Enter a height between 40 and 320 pixels.")
      .max(320, "Enter a height between 40 and 320 pixels."),
    historyEnabled: z.boolean(),
    // A closed set, because the Player prunes its own queue with the same
    // window and a free number would let the two disagree.
    historyRetentionDays: z.coerce
      .number()
      .refine(
        (value) => [1, 3, 7, 14, 30].includes(value),
        "Choose 1, 3, 7, 14, or 30 days.",
      ),
    historyActiveHoursOnly: z.boolean(),
    scheduleEnabled: z.boolean(),
    scheduleDaysOfWeek: z.array(z.coerce.number().int().min(0).max(6)),
    scheduleStartTime: z.string(),
    scheduleEndTime: z.string(),
    scheduleTimezone: z
      .string({ error: "Enter an IANA timezone such as America/Chicago." })
      .trim()
      .min(1, "Enter an IANA timezone such as America/Chicago.")
      .max(100, "Enter an IANA timezone such as America/Chicago."),
    enabled: z.boolean(),
    targetScope: z.enum(["all", "screens", "sync_groups", "locations"]),
    targetIds: z.array(z.string()),
  })
  .superRefine((value, context) => {
    if (value.scheduleEnabled) {
      // A window that can never open would hide the bar permanently, which is
      // never what setting one meant.
      if (!/^\d{2}:\d{2}$/.test(value.scheduleStartTime)) {
        context.addIssue({
          code: "custom",
          path: ["scheduleStartTime"],
          message: "Choose a start time.",
        });
      }
      if (!/^\d{2}:\d{2}$/.test(value.scheduleEndTime)) {
        context.addIssue({
          code: "custom",
          path: ["scheduleEndTime"],
          message: "Choose an end time.",
        });
      }
      if (
        value.scheduleStartTime &&
        value.scheduleStartTime === value.scheduleEndTime
      ) {
        context.addIssue({
          code: "custom",
          path: ["scheduleEndTime"],
          message: "The window must start and end at different times.",
        });
      }
      if (value.scheduleDaysOfWeek.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["scheduleDaysOfWeek"],
          message: "Choose at least one day.",
        });
      }
    }
    if (value.warningLevel >= value.loudLevel) {
      context.addIssue({
        code: "custom",
        path: ["warningLevel"],
        message: "The warning level must be below the too loud level.",
      });
    }
    if (value.targetScope !== "all" && value.targetIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["targetIds"],
        message: "Choose at least one target.",
      });
    }
  });

type NoiseMeterFormValues = z.infer<typeof noiseMeterSchema>;
type NoiseMeterFormInput = z.input<typeof noiseMeterSchema>;

const noiseMeterDefaults: NoiseMeterFormValues = {
  name: "Noise Meter",
  message: "Please lower the volume",
  warningLevel: 60,
  loudLevel: 80,
  sensitivity: 100,
  showAfterSeconds: 1,
  hideAfterSeconds: 3,
  displayMode: "overlay",
  heightPx: 96,
  historyEnabled: true,
  historyRetentionDays: 7,
  historyActiveHoursOnly: true,
  // No window by default: the bar shows whenever the room is too loud.
  scheduleEnabled: false,
  scheduleDaysOfWeek: [1, 2, 3, 4, 5],
  scheduleStartTime: "08:00",
  scheduleEndTime: "15:30",
  scheduleTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  enabled: true,
  targetScope: "all",
  targetIds: [],
};

const noiseMeterScaleHint =
  "Noise levels are relative to this player's microphone and are not calibrated decibel measurements.";

/** One line describing what a configured meter actually does. */
function noiseMeterSummary(instance: NoiseMeter) {
  return [
    `Shows above ${instance.loudLevel}`,
    `hides below ${instance.warningLevel}`,
    `after ${instance.clearHoldMs / 1000}s`,
    instance.displayMode === "push" ? "push" : "overlay",
    ...(instance.scheduleEnabled && instance.scheduleStartTime
      ? [`${instance.scheduleStartTime}–${instance.scheduleEndTime}`]
      : []),
  ].join(" · ");
}

/** Linux Player measures the room; other platforms ignore the plugin. */
function NoiseMeterPlatformNotice() {
  return (
    <Notice>
      Noise Meter runs on Linux Player only, using that player's default
      microphone. Audio is measured on the device and never sent to Tilecast,
      and nothing is recorded. Android Players ignore it.
    </Notice>
  );
}

export function NoiseMetersPage() {
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const instances = useQuery({
    queryKey: ["noise-meters"],
    queryFn: api.noiseMeters,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.deleteNoiseMeter(id, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["noise-meters"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
    },
  });
  const manageable = canManage(auth.status?.user?.role);
  // Only a successful, empty list is "nothing configured" — a failed load must
  // not read as an empty fleet.
  const showEmptyState =
    !instances.isError &&
    !instances.isLoading &&
    (instances.data?.items.length ?? 0) === 0;
  return (
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins">
            <ArrowLeft size={15} /> Plugins
          </Link>
        }
        title="Noise Meter"
        description="A bottom bar that appears only while the room stays too loud, and hides itself when it settles."
        actions={
          manageable ? (
            <Link
              className="button button--primary"
              to="/plugins/noise-meter/new"
            >
              <Plus size={16} /> New instance
            </Link>
          ) : undefined
        }
      />
      <NoiseMeterPlatformNotice />
      {!manageable && (
        <Notice>
          Owner or Administrator access is required to make changes.
        </Notice>
      )}
      {instances.isError && (
        <Notice variant="danger">Noise meters could not be loaded.</Notice>
      )}
      {remove.isError && (
        <Notice variant="danger">{remove.error.message}</Notice>
      )}
      {showEmptyState ? (
        <EmptyState
          icon={<AudioLines />}
          title="No noise meters configured"
          message="Create an instance to watch room noise on selected Linux players."
          action={
            manageable ? (
              <Link
                className="button button--primary"
                to="/plugins/noise-meter/new"
              >
                Create instance
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="plugin-instance-list">
          {(instances.data?.items ?? []).map((instance) => (
            <article className="plugin-instance" key={instance.id}>
              <div>
                <div className="plugin-instance__heading">
                  <h2>{instance.name}</h2>
                  <StatusBadge
                    label={instance.enabled ? "Enabled" : "Disabled"}
                    tone={instance.enabled ? "success" : "neutral"}
                  />
                </div>
                <p>{noiseMeterSummary(instance)}</p>
              </div>
              <div className="plugin-instance__actions">
                <Link
                  className="button button--secondary"
                  to={`/plugins/noise-meter/${instance.id}/history`}
                >
                  History
                </Link>
                <Link
                  className="button button--secondary"
                  to={`/plugins/noise-meter/${instance.id}`}
                >
                  Manage
                </Link>
                {manageable && (
                  <Button
                    compact
                    variant="danger"
                    aria-label={`Delete ${instance.name}`}
                    onClick={async () => {
                      if (await confirm({
                        title: `Delete “${instance.name}”?`,
                        description:
                          "Targeted Players will stop measuring room noise.",
                        confirmLabel: "Delete Noise Meter",
                        tone: "negative",
                      }))
                        remove.mutate(instance.id);
                    }}
                  >
                    <Trash2 size={16} />
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}

export function NoiseMeterEditorPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const instance = useQuery({
    queryKey: ["noise-meter", id],
    queryFn: () => api.noiseMeter(id ?? ""),
    enabled: editing,
  });
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<NoiseMeterFormInput, unknown, NoiseMeterFormValues>({
    resolver: zodResolver(noiseMeterSchema),
    defaultValues: noiseMeterDefaults,
  });
  useEffect(() => {
    if (!instance.data) return;
    const value = instance.data;
    reset({
      name: value.name,
      message: value.message,
      warningLevel: value.warningLevel,
      loudLevel: value.loudLevel,
      sensitivity: value.sensitivity,
      showAfterSeconds: value.triggerHoldMs / 1000,
      hideAfterSeconds: value.clearHoldMs / 1000,
      displayMode: value.displayMode,
      heightPx: value.heightPx,
      historyEnabled: value.historyEnabled,
      historyRetentionDays: value.historyRetentionDays,
      historyActiveHoursOnly: value.historyActiveHoursOnly,
      scheduleEnabled: value.scheduleEnabled,
      scheduleDaysOfWeek: value.scheduleDaysOfWeek ?? [],
      scheduleStartTime: value.scheduleStartTime ?? "08:00",
      scheduleEndTime: value.scheduleEndTime ?? "15:30",
      scheduleTimezone: value.scheduleTimezone,
      enabled: value.enabled,
      targetScope: value.targetScope,
      targetIds: value.targetIds,
    });
  }, [instance.data, reset]);
  const save = useMutation({
    mutationFn: (input: NoiseMeterInput) =>
      editing
        ? api.updateNoiseMeter(id ?? "", input, auth.status?.csrfToken ?? "")
        : api.createNoiseMeter(input, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["noise-meters"] });
      void queryClient.invalidateQueries({ queryKey: ["plugins"] });
      void navigate("/plugins/noise-meter");
    },
  });
  // Signal Select owns the ref on its hidden native select, so register()'s ref
  // never lands and react-hook-form drops the field on the next render. Every
  // select here is held with watch/setValue instead.
  const displayMode = watch("displayMode");
  const historyRetentionDays = watch("historyRetentionDays");
  const scheduleEnabled = watch("scheduleEnabled");
  const windowDays = (watch("scheduleDaysOfWeek") ?? []).map(Number);
  const toggleWindowDay = (day: number) => {
    const next = windowDays.includes(day)
      ? windowDays.filter((value) => value !== day)
      : [...windowDays, day];
    setValue("scheduleDaysOfWeek", next, {
      shouldDirty: true,
      shouldValidate: Boolean(errors.scheduleDaysOfWeek),
    });
  };
  const targetScope = watch("targetScope");
  const targetSource = useTargetSource(targetScope);
  const chosenTargets = watch("targetIds") ?? [];
  const submit = (values: NoiseMeterFormValues) => {
    save.mutate({
      name: values.name,
      message: values.message,
      warningLevel: values.warningLevel,
      loudLevel: values.loudLevel,
      sensitivity: values.sensitivity,
      triggerHoldMs: Math.round(values.showAfterSeconds * 1000),
      clearHoldMs: Math.round(values.hideAfterSeconds * 1000),
      displayMode: values.displayMode,
      heightPx: values.heightPx,
      historyEnabled: values.historyEnabled,
      historyRetentionDays: values.historyRetentionDays,
      historyActiveHoursOnly: values.historyActiveHoursOnly,
      scheduleEnabled: values.scheduleEnabled,
      // Bounds travel only with a window that is switched on, so switching it
      // off leaves nothing half-configured behind.
      scheduleDaysOfWeek: values.scheduleEnabled
        ? values.scheduleDaysOfWeek
        : [],
      scheduleStartTime: values.scheduleEnabled
        ? values.scheduleStartTime
        : null,
      scheduleEndTime: values.scheduleEnabled ? values.scheduleEndTime : null,
      scheduleTimezone: values.scheduleTimezone,
      enabled: values.enabled,
      targetScope: values.targetScope,
      targetIds: values.targetScope === "all" ? [] : values.targetIds,
    });
  };
  return (
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins/noise-meter">
            <ArrowLeft size={15} /> Noise Meter
          </Link>
        }
        title={editing ? "Manage noise meter" : "New noise meter"}
        description="The bar appears only after the room stays loud, and an emergency alert always replaces it."
      />
      {editing && (
        <ViewTabs
          label="Noise Meter"
          value="settings"
          items={[
            { value: "settings", label: "Settings" },
            { value: "history", label: "History" },
          ]}
          onValueChange={(value) => {
            if (value === "history")
              void navigate(`/plugins/noise-meter/${id}/history`);
          }}
        />
      )}
      <NoiseMeterPlatformNotice />
      <form
        className="plugin-form"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <Panel className="plugin-form__section">
          <SectionHeader title="Meter" />
          <FormField
            id="noise-meter-name"
            label="Name"
            aria-required="true"
            error={errors.name?.message}
            {...register("name")}
          />
          <FormField
            id="noise-meter-message"
            label="Message"
            placeholder="Please lower the volume"
            hint="Shown on the right of the bar. Leave blank to show “Too loud”."
            error={errors.message?.message}
            {...register("message")}
          />
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Levels" description={noiseMeterScaleHint} />
          <div className="plugin-form__row">
            <FormField
              id="noise-meter-warning"
              label="Warning level"
              type="number"
              min={1}
              max={99}
              hint="Where the yellow zone begins. The bar also hides below this level."
              error={errors.warningLevel?.message}
              {...register("warningLevel", { valueAsNumber: true })}
            />
            <FormField
              id="noise-meter-loud"
              label="Too loud level"
              type="number"
              min={2}
              max={100}
              hint="Where the red zone begins and the bar can appear."
              error={errors.loudLevel?.message}
              {...register("loudLevel", { valueAsNumber: true })}
            />
            <FormField
              id="noise-meter-sensitivity"
              label="Sensitivity (%)"
              type="number"
              min={25}
              max={300}
              hint="Raise it for a quiet microphone, lower it for a hot one."
              error={errors.sensitivity?.message}
              {...register("sensitivity", { valueAsNumber: true })}
            />
          </div>
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader
            title="Timing"
            description="Separate delays keep a single shout from raising the bar and a brief pause from dropping it."
          />
          <div className="plugin-form__row">
            <FormField
              id="noise-meter-show-after"
              label="Show after (seconds)"
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              hint="How long the room must stay too loud before the bar appears."
              error={errors.showAfterSeconds?.message}
              {...register("showAfterSeconds", { valueAsNumber: true })}
            />
            <FormField
              id="noise-meter-hide-after"
              label="Hide after normal for (seconds)"
              type="number"
              min={0.5}
              max={30}
              step={0.5}
              hint="How long the room must stay below the warning level before the bar hides."
              error={errors.hideAfterSeconds?.message}
              {...register("hideAfterSeconds", { valueAsNumber: true })}
            />
          </div>
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Appearance" />
          <div className="plugin-form__row">
            <Field label="Display mode">
              <Select
                name="displayMode"
                value={displayMode}
                onChange={(event) =>
                  setValue(
                    "displayMode",
                    event.target.value as NoiseMeterFormValues["displayMode"],
                    { shouldDirty: true },
                  )
                }
              >
                <option value="overlay">Overlay the content</option>
                <option value="push">Push the content up</option>
              </Select>
            </Field>
            <FormField
              id="noise-meter-height"
              label="Bar height (px)"
              type="number"
              min={40}
              max={320}
              error={errors.heightPx?.message}
              {...register("heightPx", { valueAsNumber: true })}
            />
          </div>
          <Checkbox label="Enabled" {...register("enabled")} />
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader
            title="When the bar can show"
            description="The room is measured either way. This decides only when a too-loud room may put the bar on screen."
          />
          <Checkbox
            label="Only show during a set time window"
            {...register("scheduleEnabled")}
          />
          {scheduleEnabled && (
            <>
              <div className="plugin-form__row">
                <FormField
                  id="noise-meter-window-start"
                  label="From"
                  type="time"
                  error={errors.scheduleStartTime?.message}
                  {...register("scheduleStartTime")}
                />
                <FormField
                  id="noise-meter-window-end"
                  label="Until"
                  type="time"
                  hint="An end before the start runs the window overnight."
                  error={errors.scheduleEndTime?.message}
                  {...register("scheduleEndTime")}
                />
                <FormField
                  id="noise-meter-window-timezone"
                  label="Timezone"
                  placeholder="America/Chicago"
                  error={errors.scheduleTimezone?.message}
                  {...register("scheduleTimezone")}
                />
              </div>
              <div className="plugin-field-group">
                <span className="field__label" id="noise-meter-days-label">
                  Days of the week
                </span>
                <div
                  className="countdown-weekdays"
                  role="group"
                  aria-labelledby="noise-meter-days-label"
                >
                  {scheduleWeekdays.map((day) => (
                    <button
                      type="button"
                      key={day.value}
                      aria-pressed={windowDays.includes(day.value)}
                      onClick={() => toggleWindowDay(day.value)}
                    >
                      {day.short}
                    </button>
                  ))}
                </div>
                {errors.scheduleDaysOfWeek && (
                  <span className="field__error">
                    {errors.scheduleDaysOfWeek.message}
                  </span>
                )}
              </div>
              <p className="plugin-form__note">
                Outside the window the player keeps measuring and the bar stays
                down. An emergency alert is never affected by this window.
              </p>
            </>
          )}
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader
            title="History"
            description="Saves only relative noise-level measurements. Microphone audio is never recorded or uploaded."
          />
          <Checkbox
            label="Save noise history"
            {...register("historyEnabled")}
          />
          <div className="plugin-form__row">
            <Field
              label="Retention"
              description="How long measurements are kept before they are removed automatically."
            >
              <Select
                name="historyRetentionDays"
                value={String(historyRetentionDays)}
                onChange={(event) =>
                  setValue("historyRetentionDays", Number(event.target.value), {
                    shouldDirty: true,
                  })
                }
              >
                <option value="1">1 day</option>
                <option value="3">3 days</option>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
              </Select>
            </Field>
          </div>
          <Checkbox
            label="Collect only during active hours"
            {...register("historyActiveHoursOnly")}
          />
          <p className="plugin-form__note">
            Outside active hours the player stops listening entirely rather than
            measuring and discarding: the microphone is released until the next
            active window.
          </p>
        </Panel>

        <Panel className="plugin-form__section">
          <SectionHeader title="Targets" />
          <TargetFields
            idPrefix="noise-meter"
            scope={targetScope}
            source={targetSource}
            chosenCount={chosenTargets.length}
            error={errors.targetIds?.message}
            registerTargetIds={register("targetIds")}
            onScopeChange={(value) => {
              setValue("targetIds", []);
              setValue("targetScope", value, { shouldDirty: true });
            }}
          />
        </Panel>

        {save.isError && <Notice variant="danger">{save.error.message}</Notice>}
        <div className="plugin-form__actions">
          <Link className="button button--secondary" to="/plugins/noise-meter">
            Cancel
          </Link>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {editing ? "Save changes" : "Create instance"}
          </Button>
        </div>
      </form>
    </main>
  );
}
