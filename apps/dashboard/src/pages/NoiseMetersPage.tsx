import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AudioLines, Plus, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { api } from "../api/client";
import type { NoiseMeter, NoiseMeterInput } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
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
import { toast } from "../components/ui/toast";
import { PluginActionsMenu } from "../plugins/PluginActionsMenu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
} from "../components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ResourceTabs } from "../components/ResourceTabs";
import {
  RegisterCheckbox,
  TargetFields,
  canManage,
  useTargetSource,
} from "../plugins/shared";

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

const noiseDisplayModeOptions = [
  { value: "overlay", label: "Overlay the content" },
  { value: "push", label: "Push the content up" },
];

const retentionOptions = [1, 3, 7, 14, 30].map((days) => ({
  value: String(days),
  label: `${days} day${days === 1 ? "" : "s"}`,
}));

/** Linux Player measures the room; other platforms ignore the plugin. */
function NoiseMeterPlatformNotice() {
  return (
    <Alert>
      <AlertDescription>
        Noise Meter runs on Linux Player only, using that player&apos;s default
        microphone. Audio is measured on the device and never sent to Tilecast,
        and nothing is recorded. Android Players ignore it.
      </AlertDescription>
    </Alert>
  );
}

export function NoiseMetersPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const instances = useQuery({
    queryKey: ["noise-meters"],
    queryFn: api.noiseMeters,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.deleteNoiseMeter(id, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      toast.add({ title: "Noise Meter removed.", type: "success" });
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
              Noise Meter
            </h1>
            <p className="text-sm text-muted-foreground">
              A bottom bar that appears only while the room stays too loud, and
              hides itself when it settles.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manageable && (
              <Link
                className={buttonVariants({ size: "lg" })}
                to="/plugins/noise-meter/new"
              >
                <Plus data-icon="inline-start" aria-hidden="true" /> New
                instance
              </Link>
            )}
            <PluginActionsMenu pluginId="noise_meter" />
          </div>
        </header>
        <NoiseMeterPlatformNotice />
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
              Noise meters could not be loaded.
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
                <AudioLines size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No noise meters configured</EmptyTitle>
              <EmptyDescription>
                Create an instance to watch room noise on selected Linux
                players.
              </EmptyDescription>
            </EmptyHeader>
            {manageable && (
              <EmptyContent>
                <Link
                  className={buttonVariants()}
                  to="/plugins/noise-meter/new"
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
                    {noiseMeterSummary(instance)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="flex-wrap">
                  <Link
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    to={`/plugins/noise-meter/${instance.id}/history`}
                  >
                    History
                  </Link>
                  <Link
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    to={`/plugins/noise-meter/${instance.id}`}
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
                          body: "Targeted players will stop measuring room noise.",
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
    control,
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
      toast.add({
        title: editing ? "Noise Meter updated." : "Noise Meter created.",
        type: "success",
      });
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
    <main className="grid gap-4">
      <header className="grid min-w-0 gap-1">
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          to="/plugins/noise-meter"
        >
          <ArrowLeft size={15} aria-hidden="true" /> Noise Meter
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {editing ? "Manage noise meter" : "New noise meter"}
        </h1>
        <p className="text-sm text-muted-foreground">
          The bar appears only after the room stays loud, and an emergency alert
          always replaces it.
        </p>
      </header>
      {editing && (
        <ResourceTabs
          label="Noise Meter"
          tabs={[
            { label: "Settings", to: `/plugins/noise-meter/${id}` },
            { label: "History", to: `/plugins/noise-meter/${id}/history` },
          ]}
        />
      )}
      <NoiseMeterPlatformNotice />
      <form
        className="grid gap-4"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Meter</h2>
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
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Levels</h2>
          <p className="text-sm text-muted-foreground">{noiseMeterScaleHint}</p>
          <div className="grid gap-4 sm:grid-cols-3">
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
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h2 className="text-base font-semibold">Timing</h2>
            <p className="text-sm text-muted-foreground">
              Separate delays keep a single shout from raising the bar and a
              brief pause from dropping it.
            </p>
          </header>
          <div className="grid gap-4 sm:grid-cols-2">
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
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Appearance</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="noise-meter-display-mode">
                Display mode
              </FieldLabel>
              <RheaSelect
                items={noiseDisplayModeOptions}
                name="displayMode"
                value={displayMode}
                onValueChange={(next) => {
                  if (next)
                    setValue("displayMode", next, { shouldDirty: true });
                }}
              >
                <SelectTrigger
                  id="noise-meter-display-mode"
                  aria-label="Display mode"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {noiseDisplayModeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
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
          <RegisterCheckbox control={control} name="enabled" label="Enabled" />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h2 className="text-base font-semibold">When the bar can show</h2>
            <p className="text-sm text-muted-foreground">
              The room is measured either way. This decides only when a too-loud
              room may put the bar on screen.
            </p>
          </header>
          <RegisterCheckbox
            control={control}
            name="scheduleEnabled"
            label="Only show during a set time window"
          />
          {scheduleEnabled && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
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
              <div className="grid gap-2">
                <span
                  className="text-sm font-medium"
                  id="noise-meter-days-label"
                >
                  Days of the week
                </span>
                <ToggleGroup
                  multiple
                  variant="outline"
                  size="sm"
                  spacing={1}
                  className="flex-wrap"
                  aria-labelledby="noise-meter-days-label"
                  value={windowDays.map(String)}
                  onValueChange={(values) => {
                    const next = values.map(Number);
                    const changed = [
                      ...next.filter((day) => !windowDays.includes(day)),
                      ...windowDays.filter((day) => !next.includes(day)),
                    ];
                    changed.forEach(toggleWindowDay);
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
                {errors.scheduleDaysOfWeek && (
                  <span className="text-sm text-destructive" role="alert">
                    {errors.scheduleDaysOfWeek.message}
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Outside the window the player keeps measuring and the bar stays
                down. An emergency alert is never affected by this window.
              </p>
            </>
          )}
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h2 className="text-base font-semibold">History</h2>
            <p className="text-sm text-muted-foreground">
              Saves only relative noise-level measurements. Microphone audio is
              never recorded or uploaded.
            </p>
          </header>
          <RegisterCheckbox
            control={control}
            name="historyEnabled"
            label="Save noise history"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="noise-meter-retention">Retention</FieldLabel>
              <RheaSelect
                items={retentionOptions}
                name="historyRetentionDays"
                value={String(historyRetentionDays)}
                onValueChange={(next) => {
                  if (next)
                    setValue("historyRetentionDays", Number(next), {
                      shouldDirty: true,
                    });
                }}
              >
                <SelectTrigger
                  id="noise-meter-retention"
                  aria-label="Retention"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {retentionOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
              <FieldDescription>
                How long measurements are kept before they are removed
                automatically.
              </FieldDescription>
            </Field>
          </div>
          <RegisterCheckbox
            control={control}
            name="historyActiveHoursOnly"
            label="Collect only during active hours"
          />
          <p className="text-sm text-muted-foreground">
            Outside active hours the player stops listening entirely rather than
            measuring and discarding: the microphone is released until the next
            active window.
          </p>
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Targets</h2>
          <TargetFields
            idPrefix="noise-meter"
            scope={targetScope}
            source={targetSource}
            error={errors.targetIds?.message}
            control={control}
            onScopeChange={(value) => {
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
            to="/plugins/noise-meter"
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
