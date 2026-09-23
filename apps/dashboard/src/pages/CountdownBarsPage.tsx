import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clock3, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { api } from "../api/client";
import type { CountdownBarInput } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { DateTimeInput } from "../components/date-picker";
import { FormField } from "../components/FormField";
import { scheduleWeekdays } from "../schedules/scheduleBuilderModel";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton, buttonVariants } from "../components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { PluginActionsMenu } from "../plugins/PluginActionsMenu";
import { toast } from "../components/ui/toast";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
} from "../components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../components/ui/field";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  RegisterCheckbox,
  TargetFields,
  canManage,
  toLocalInputValue,
  useTargetSource,
} from "../plugins/shared";

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

const scheduleTypeOptions = [
  { value: "weekly", label: "Days of the week" },
  { value: "one_time", label: "One-time date" },
];

const displayModeOptions = [
  { value: "overlay", label: "Overlay current content" },
  { value: "push", label: "Push and shrink current content" },
];

const progressFillOptions = [
  { value: "none", label: "Plain background" },
  { value: "drain", label: "Drain right to left" },
];

export function CountdownBarsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const instances = useQuery({
    queryKey: ["countdown-bars"],
    queryFn: api.countdownBars,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.deleteCountdownBar(id, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      toast.add({ title: "Countdown Bar removed.", type: "success" });
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
    <>
      {confirmDialog}
      <main className="grid gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <Link
              className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
              to="/plugins"
            >
              <ArrowLeft size={15} aria-hidden="true" /> Plugins
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              Countdown Bar
            </h1>
            <p className="text-sm text-muted-foreground">
              Timed bars run independently of the playlist and keep evaluating
              from the Player&apos;s cached manifest.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manageable && (
              <Link
                className={buttonVariants({ size: "lg" })}
                to="/plugins/countdown-bar/new"
              >
                <Plus data-icon="inline-start" aria-hidden="true" /> New
                instance
              </Link>
            )}
            <PluginActionsMenu pluginId="countdown_bar" />
          </div>
        </header>
        {!manageable && (
          <Alert>
            <AlertDescription>
              Owner or Administrator access is required to make changes.
            </AlertDescription>
          </Alert>
        )}
        {instances.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              Countdown bars could not be loaded.
            </AlertDescription>
          </Alert>
        )}
        {remove.isError && (
          <Alert variant="destructive">
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        {showEmptyState ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3 size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No countdown bars configured</EmptyTitle>
              <EmptyDescription>
                Create an instance to show a locally-timed bar on selected
                screens.
              </EmptyDescription>
            </EmptyHeader>
            {manageable && (
              <EmptyContent>
                <Link
                  className={buttonVariants()}
                  to="/plugins/countdown-bar/new"
                >
                  Create instance
                </Link>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {(instances.data?.items ?? []).map((instance) => (
              <Item variant="outline" key={instance.id}>
                <ItemContent>
                  <ItemTitle>
                    <h2 className="text-sm font-medium">{instance.name}</h2>
                    <Badge variant={instance.enabled ? "default" : "secondary"}>
                      {instance.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </ItemTitle>
                  <ItemDescription>
                    {instance.message} · {instance.displayMode} ·{" "}
                    {instance.heightPx}px · priority {instance.priority}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="flex-wrap">
                  <Link
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    to={`/plugins/countdown-bar/${instance.id}`}
                  >
                    Manage
                  </Link>
                  {manageable && (
                    <RheaButton
                      type="button"
                      size="icon"
                      variant="destructive"
                      aria-label={`Delete ${instance.name}`}
                      onClick={() => {
                        void confirm({
                          title: `Delete “${instance.name}”?`,
                          body: "The bar will be removed from targeted Players.",
                          action: "Delete",
                          destructive: true,
                        }).then((ok) => {
                          if (ok) remove.mutate(instance.id);
                        });
                      }}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </RheaButton>
                  )}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </main>
    </>
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
    control,
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
      toast.add({
        title: editing ? "Countdown Bar updated." : "Countdown Bar created.",
        type: "success",
      });
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
    <main className="grid gap-4">
      <header className="grid min-w-0 gap-1">
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          to="/plugins/countdown-bar"
        >
          <ArrowLeft size={15} aria-hidden="true" /> Countdown Bar
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {editing ? "Manage countdown bar" : "New countdown bar"}
        </h1>
        <p className="text-sm text-muted-foreground">
          The Player evaluates this schedule locally. Priority decides which bar
          wins when instances overlap.
        </p>
      </header>
      <form
        className="grid gap-4"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Content</h2>
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
          <RegisterCheckbox
            control={control}
            name="showConfetti"
            label="Show confetti when the countdown reaches zero"
          />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Timing</h2>
          <Field>
            <FieldLabel htmlFor="countdown-schedule-type">Schedule</FieldLabel>
            <RheaSelect
              items={scheduleTypeOptions}
              name="scheduleType"
              value={scheduleType}
              onValueChange={(next) => {
                if (next) setScheduleType(next);
              }}
            >
              <SelectTrigger id="countdown-schedule-type" aria-label="Schedule">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {scheduleTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
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
              <div className="grid gap-2">
                <span className="text-sm font-medium" id="countdown-days-label">
                  Days of the week
                </span>
                <ToggleGroup
                  multiple
                  variant="outline"
                  size="sm"
                  spacing={1}
                  className="flex-wrap"
                  aria-labelledby="countdown-days-label"
                  value={selectedDays.map(String)}
                  onValueChange={(values) => {
                    const next = values.map(Number);
                    const changed = [
                      ...next.filter((day) => !selectedDays.includes(day)),
                      ...selectedDays.filter((day) => !next.includes(day)),
                    ];
                    changed.forEach(toggleDay);
                  }}
                >
                  {scheduleWeekdays.map((day) => (
                    <ToggleGroupItem
                      key={day.value}
                      value={String(day.value)}
                      className="min-w-10 aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                    >
                      {day.short}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {errors.daysOfWeek && (
                  <span className="text-sm text-destructive" role="alert">
                    {errors.daysOfWeek.message}
                  </span>
                )}
              </div>
            </>
          ) : (
            <Controller
              control={control}
              name="oneTimeAt"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="countdown-one-time">
                    Target date and time
                  </FieldLabel>
                  <DateTimeInput
                    id="countdown-one-time"
                    aria-label="Target date and time"
                    timeLabel="Target time"
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={fieldState.invalid}
                    aria-describedby={
                      fieldState.error
                        ? "countdown-one-time-hint countdown-one-time-error"
                        : "countdown-one-time-hint"
                    }
                  />
                  <FieldDescription id="countdown-one-time-hint">
                    Entered in this browser&apos;s local time; the Player counts
                    down to the same instant.
                  </FieldDescription>
                  <FieldError
                    id="countdown-one-time-error"
                    errors={[fieldState.error]}
                  />
                </Field>
              )}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
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
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Display</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="countdown-display-mode">Mode</FieldLabel>
              <RheaSelect
                items={displayModeOptions}
                name="displayMode"
                value={displayMode}
                onValueChange={(next) => {
                  if (next) setDisplayMode(next);
                }}
              >
                <SelectTrigger id="countdown-display-mode" aria-label="Mode">
                  <SelectValue />
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
              <FieldLabel htmlFor="countdown-progress-fill">
                Background countdown
              </FieldLabel>
              <RheaSelect
                items={progressFillOptions}
                name="progressFill"
                value={progressFill}
                onValueChange={(next) => {
                  if (next) setProgressFill(next);
                }}
              >
                <SelectTrigger
                  id="countdown-progress-fill"
                  aria-label="Background countdown"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {progressFillOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
              <FieldDescription>
                Drain empties the bar from right to left as the target
                approaches.
              </FieldDescription>
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
          <RegisterCheckbox control={control} name="enabled" label="Enabled" />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h2 className="text-base font-semibold">Urgency stages</h2>
            <p className="text-sm text-muted-foreground">
              Change the bar automatically as the target approaches. Untouched
              stage times follow the total lead time; custom values stay fixed.
              Completed messages return to the normal size.
            </p>
          </header>
          <RegisterCheckbox
            control={control}
            name="urgencyEnabled"
            label="Enable countdown urgency stages"
          />
          {urgencyEnabled && (
            <div className="grid gap-4 sm:grid-cols-3">
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
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Targets</h2>
          <TargetFields
            idPrefix="countdown"
            scope={targetScope}
            source={targetSource}
            error={errors.targetIds?.message}
            control={control}
            onScopeChange={(value) => {
              // Ids from the previous scope would otherwise stay registered and
              // be submitted alongside the new scope's picks.
              setValue("targetIds", []);
              setValue("targetScope", value, { shouldDirty: true });
            }}
          />
        </section>

        {save.isError && (
          <Alert variant="destructive">
            <AlertDescription>{save.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            className={buttonVariants({ variant: "outline", size: "lg" })}
            to="/plugins/countdown-bar"
          >
            Cancel
          </Link>
          <RheaButton type="submit" disabled={save.isPending}>
            {save.isPending
              ? "Saving…"
              : editing
                ? "Save changes"
                : "Create instance"}
          </RheaButton>
        </div>
      </form>
    </main>
  );
}
