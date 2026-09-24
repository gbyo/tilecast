import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AudioLines, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
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
import { apiErrorMessage } from "../i18n";
import {
  RegisterCheckbox,
  TargetFields,
  canManage,
  useTargetSource,
  weekdayShortLabel,
} from "../plugins/shared";
import type { PluginsT } from "../plugins/pluginCatalog";

/**
 * Studio talks in seconds and in a 0-100 scale; the wire talks in milliseconds.
 * Nothing here exposes dBFS, gain, or a microphone device: the level is
 * relative to whatever microphone is plugged into the player, and presenting it
 * as a calibrated measurement would be a claim Tilecast cannot make.
 */
// Schemas are built at render time from `t` so validation messages follow
// the interface language. Callers pass the `t` they already use.
export function makeNoiseMeterSchema(t: PluginsT) {
  return z
    .object({
      name: z.string().trim().min(1).max(180),
      message: z
        .string()
        .trim()
        .max(120, t("noiseMeter.validation.messageMax")),
      warningLevel: z.coerce
        .number({ error: t("noiseMeter.validation.warningRange") })
        .int(t("noiseMeter.validation.warningRange"))
        .min(1, t("noiseMeter.validation.warningRange"))
        .max(99, t("noiseMeter.validation.warningRange")),
      loudLevel: z.coerce
        .number({ error: t("noiseMeter.validation.loudRange") })
        .int(t("noiseMeter.validation.loudRange"))
        .min(2, t("noiseMeter.validation.loudRange"))
        .max(100, t("noiseMeter.validation.loudRange")),
      sensitivity: z.coerce
        .number({ error: t("noiseMeter.validation.sensitivityRange") })
        .int(t("noiseMeter.validation.sensitivityRange"))
        .min(25, t("noiseMeter.validation.sensitivityRange"))
        .max(300, t("noiseMeter.validation.sensitivityRange")),
      showAfterSeconds: z.coerce
        .number({ error: t("noiseMeter.validation.showRange") })
        .min(0.1, t("noiseMeter.validation.showRange"))
        .max(10, t("noiseMeter.validation.showRange")),
      hideAfterSeconds: z.coerce
        .number({ error: t("noiseMeter.validation.hideRange") })
        .min(0.5, t("noiseMeter.validation.hideRange"))
        .max(30, t("noiseMeter.validation.hideRange")),
      displayMode: z.enum(["overlay", "push"]),
      heightPx: z.coerce
        .number({ error: t("noiseMeter.validation.heightRange") })
        .int(t("noiseMeter.validation.heightRange"))
        .min(40, t("noiseMeter.validation.heightRange"))
        .max(320, t("noiseMeter.validation.heightRange")),
      historyEnabled: z.boolean(),
      // A closed set, because the Player prunes its own queue with the same
      // window and a free number would let the two disagree.
      historyRetentionDays: z.coerce
        .number()
        .refine(
          (value) => [1, 3, 7, 14, 30].includes(value),
          t("noiseMeter.validation.retentionOptions"),
        ),
      historyActiveHoursOnly: z.boolean(),
      scheduleEnabled: z.boolean(),
      scheduleDaysOfWeek: z.array(z.coerce.number().int().min(0).max(6)),
      scheduleStartTime: z.string(),
      scheduleEndTime: z.string(),
      scheduleTimezone: z
        .string({ error: t("noiseMeter.validation.timezone") })
        .trim()
        .min(1, t("noiseMeter.validation.timezone"))
        .max(100, t("noiseMeter.validation.timezone")),
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
            message: t("noiseMeter.validation.windowStart"),
          });
        }
        if (!/^\d{2}:\d{2}$/.test(value.scheduleEndTime)) {
          context.addIssue({
            code: "custom",
            path: ["scheduleEndTime"],
            message: t("noiseMeter.validation.windowEnd"),
          });
        }
        if (
          value.scheduleStartTime &&
          value.scheduleStartTime === value.scheduleEndTime
        ) {
          context.addIssue({
            code: "custom",
            path: ["scheduleEndTime"],
            message: t("noiseMeter.validation.windowDifferent"),
          });
        }
        if (value.scheduleDaysOfWeek.length === 0) {
          context.addIssue({
            code: "custom",
            path: ["scheduleDaysOfWeek"],
            message: t("noiseMeter.validation.daysRequired"),
          });
        }
      }
      if (value.warningLevel >= value.loudLevel) {
        context.addIssue({
          code: "custom",
          path: ["warningLevel"],
          message: t("noiseMeter.validation.levelOrder"),
        });
      }
      if (value.targetScope !== "all" && value.targetIds.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["targetIds"],
          message: t("noiseMeter.validation.targetRequired"),
        });
      }
    });
}

type NoiseMeterFormValues = z.infer<ReturnType<typeof makeNoiseMeterSchema>>;
type NoiseMeterFormInput = z.input<ReturnType<typeof makeNoiseMeterSchema>>;

// New-instance defaults, including the suggested message callers see
// prefilled in the form. Built from `t` like the schema above.
function makeNoiseMeterDefaults(t: PluginsT): NoiseMeterFormValues {
  return {
    name: "Noise Meter",
    message: t("noiseMeter.editor.messagePlaceholder"),
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
}

/** One line describing what a configured meter actually does. */
function noiseMeterSummary(instance: NoiseMeter, t: PluginsT) {
  return [
    t("noiseMeter.summary.showsAbove", { level: instance.loudLevel }),
    t("noiseMeter.summary.hidesBelow", { level: instance.warningLevel }),
    t("noiseMeter.summary.afterSeconds", {
      seconds: instance.clearHoldMs / 1000,
    }),
    instance.displayMode === "push" ? "push" : "overlay",
    ...(instance.scheduleEnabled && instance.scheduleStartTime
      ? [
          t("noiseMeter.summary.window", {
            start: instance.scheduleStartTime,
            end: instance.scheduleEndTime,
          }),
        ]
      : []),
  ].join(" · ");
}

const noiseDisplayModeOptions = [
  { value: "overlay", labelKey: "noiseMeter.editor.displayMode.overlay" },
  { value: "push", labelKey: "noiseMeter.editor.displayMode.push" },
] as const;

const retentionDays = [1, 3, 7, 14, 30] as const;

/** Linux Player measures the room; other platforms ignore the plugin. */
function NoiseMeterPlatformNotice() {
  const { t } = useTranslation("plugins");
  return (
    <Alert>
      <AlertDescription>{t("noiseMeter.platformNotice")}</AlertDescription>
    </Alert>
  );
}

export function NoiseMetersPage() {
  const { t } = useTranslation(["plugins", "common"]);
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
              <ArrowLeft size={15} aria-hidden="true" />{" "}
              {t("shared.backToPlugins")}
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("noiseMeter.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("noiseMeter.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manageable && (
              <Link
                className={buttonVariants({ size: "lg" })}
                to="/plugins/noise-meter/new"
              >
                <Plus data-icon="inline-start" aria-hidden="true" />{" "}
                {t("shared.newInstance")}
              </Link>
            )}
            <PluginActionsMenu pluginId="noise_meter" />
          </div>
        </header>
        <NoiseMeterPlatformNotice />
        {!manageable && (
          <Alert>
            <AlertDescription>{t("shared.manageNote")}</AlertDescription>
          </Alert>
        )}
        {instances.isError && (
          <Alert variant="destructive">
            <AlertDescription>{t("noiseMeter.loadError")}</AlertDescription>
          </Alert>
        )}
        {remove.isError && (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(remove.error)}</AlertDescription>
          </Alert>
        )}
        {showEmptyState ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AudioLines size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("noiseMeter.emptyTitle")}</EmptyTitle>
              <EmptyDescription>
                {t("noiseMeter.emptyDescription")}
              </EmptyDescription>
            </EmptyHeader>
            {manageable && (
              <EmptyContent>
                <Link
                  className={buttonVariants()}
                  to="/plugins/noise-meter/new"
                >
                  {t("shared.createInstance")}
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
                      {instance.enabled
                        ? t("shared.enabledBadge")
                        : t("shared.disabledBadge")}
                    </Badge>
                  </ItemTitle>
                  <ItemDescription>
                    {noiseMeterSummary(instance, t)}
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
                    {t("noiseMeter.list.history")}
                  </Link>
                  <Link
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    to={`/plugins/noise-meter/${instance.id}`}
                  >
                    {t("shared.manage")}
                  </Link>
                  {manageable && (
                    <RheaButton
                      type="button"
                      size="icon"
                      variant="destructive"
                      aria-label={t("shared.deleteAction", {
                        name: instance.name,
                      })}
                      onClick={() => {
                        void confirm({
                          title: t("shared.deleteTitle", {
                            name: instance.name,
                          }),
                          body: t("noiseMeter.deleteBody"),
                          action: t("common:actions.delete"),
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
  const { t } = useTranslation(["plugins", "common"]);
  const { id } = useParams();
  const editing = Boolean(id);
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const schema = useMemo(() => makeNoiseMeterSchema(t), [t]);
  const defaults = useMemo(() => makeNoiseMeterDefaults(t), [t]);
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
    resolver: zodResolver(schema),
    defaultValues: defaults,
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
    <main className="grid gap-4">
      <header className="grid min-w-0 gap-1">
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          to="/plugins/noise-meter"
        >
          <ArrowLeft size={15} aria-hidden="true" /> {t("noiseMeter.title")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {editing
            ? t("noiseMeter.editor.manageTitle")
            : t("noiseMeter.editor.createTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("noiseMeter.editor.subtitle")}
        </p>
      </header>
      {editing && (
        <ResourceTabs
          label={t("noiseMeter.tabs.label")}
          tabs={[
            {
              label: t("noiseMeter.tabs.settings"),
              to: `/plugins/noise-meter/${id}`,
            },
            {
              label: t("noiseMeter.tabs.history"),
              to: `/plugins/noise-meter/${id}/history`,
            },
          ]}
        />
      )}
      <NoiseMeterPlatformNotice />
      <form
        className="grid gap-4"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("noiseMeter.editor.sections.meter")}
          </h2>
          <FormField
            id="noise-meter-name"
            label={t("shared.nameLabel")}
            aria-required="true"
            error={errors.name?.message}
            {...register("name")}
          />
          <FormField
            id="noise-meter-message"
            label={t("noiseMeter.editor.messageLabel")}
            placeholder={t("noiseMeter.editor.messagePlaceholder")}
            hint={t("noiseMeter.editor.messageHint")}
            error={errors.message?.message}
            {...register("message")}
          />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("noiseMeter.editor.sections.levels")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("noiseMeter.editor.scaleHint")}
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              id="noise-meter-warning"
              label={t("noiseMeter.editor.warningLabel")}
              type="number"
              min={1}
              max={99}
              hint={t("noiseMeter.editor.warningHint")}
              error={errors.warningLevel?.message}
              {...register("warningLevel", { valueAsNumber: true })}
            />
            <FormField
              id="noise-meter-loud"
              label={t("noiseMeter.editor.loudLabel")}
              type="number"
              min={2}
              max={100}
              hint={t("noiseMeter.editor.loudHint")}
              error={errors.loudLevel?.message}
              {...register("loudLevel", { valueAsNumber: true })}
            />
            <FormField
              id="noise-meter-sensitivity"
              label={t("noiseMeter.editor.sensitivityLabel")}
              type="number"
              min={25}
              max={300}
              hint={t("noiseMeter.editor.sensitivityHint")}
              error={errors.sensitivity?.message}
              {...register("sensitivity", { valueAsNumber: true })}
            />
          </div>
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h2 className="text-base font-semibold">
              {t("noiseMeter.editor.sections.timing")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("noiseMeter.editor.timingDescription")}
            </p>
          </header>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="noise-meter-show-after"
              label={t("noiseMeter.editor.showAfterLabel")}
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              hint={t("noiseMeter.editor.showAfterHint")}
              error={errors.showAfterSeconds?.message}
              {...register("showAfterSeconds", { valueAsNumber: true })}
            />
            <FormField
              id="noise-meter-hide-after"
              label={t("noiseMeter.editor.hideAfterLabel")}
              type="number"
              min={0.5}
              max={30}
              step={0.5}
              hint={t("noiseMeter.editor.hideAfterHint")}
              error={errors.hideAfterSeconds?.message}
              {...register("hideAfterSeconds", { valueAsNumber: true })}
            />
          </div>
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("noiseMeter.editor.sections.appearance")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="noise-meter-display-mode">
                {t("noiseMeter.editor.displayLabel")}
              </FieldLabel>
              <RheaSelect
                items={noiseDisplayModeOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                name="displayMode"
                value={displayMode}
                onValueChange={(next) => {
                  if (next)
                    setValue("displayMode", next, { shouldDirty: true });
                }}
              >
                <SelectTrigger
                  id="noise-meter-display-mode"
                  aria-label={t("noiseMeter.editor.displayLabel")}
                >
                  <SelectValue>
                    {t(
                      noiseDisplayModeOptions.find(
                        (option) => option.value === displayMode,
                      )?.labelKey ?? "noiseMeter.editor.displayMode.overlay",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {noiseDisplayModeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <FormField
              id="noise-meter-height"
              label={t("noiseMeter.editor.heightLabel")}
              type="number"
              min={40}
              max={320}
              error={errors.heightPx?.message}
              {...register("heightPx", { valueAsNumber: true })}
            />
          </div>
          <RegisterCheckbox
            label={t("shared.enabledLabel")}
            {...register("enabled")}
          />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h2 className="text-base font-semibold">
              {t("noiseMeter.editor.sections.window")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("noiseMeter.editor.windowDescription")}
            </p>
          </header>
          <RegisterCheckbox
            label={t("noiseMeter.editor.windowEnabledLabel")}
            {...register("scheduleEnabled")}
          />
          {scheduleEnabled && (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField
                  id="noise-meter-window-start"
                  label={t("noiseMeter.editor.fromLabel")}
                  type="time"
                  error={errors.scheduleStartTime?.message}
                  {...register("scheduleStartTime")}
                />
                <FormField
                  id="noise-meter-window-end"
                  label={t("noiseMeter.editor.untilLabel")}
                  type="time"
                  hint={t("noiseMeter.editor.untilHint")}
                  error={errors.scheduleEndTime?.message}
                  {...register("scheduleEndTime")}
                />
                <FormField
                  id="noise-meter-window-timezone"
                  label={t("noiseMeter.editor.timezoneLabel")}
                  // i18n-ignore: IANA timezone example, not translatable text
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
                  {t("noiseMeter.editor.daysLabel")}
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
                      {weekdayShortLabel(day.value, t)}
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
                {t("noiseMeter.editor.windowNote")}
              </p>
            </>
          )}
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h2 className="text-base font-semibold">
              {t("noiseMeter.editor.sections.history")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("noiseMeter.editor.historyDescription")}
            </p>
          </header>
          <RegisterCheckbox
            label={t("noiseMeter.editor.historyEnabledLabel")}
            {...register("historyEnabled")}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="noise-meter-retention">
                {t("noiseMeter.editor.retentionLabel")}
              </FieldLabel>
              <RheaSelect
                items={retentionDays.map((days) => ({
                  value: String(days),
                  label: t("noiseMeter.editor.retention", { count: days }),
                }))}
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
                  aria-label={t("noiseMeter.editor.retentionLabel")}
                >
                  <SelectValue>
                    {t("noiseMeter.editor.retention", {
                      count: historyRetentionDays,
                    })}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {retentionDays.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {t("noiseMeter.editor.retention", { count: days })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
              <FieldDescription>
                {t("noiseMeter.editor.retentionHint")}
              </FieldDescription>
            </Field>
          </div>
          <RegisterCheckbox
            label={t("noiseMeter.editor.activeHoursLabel")}
            {...register("historyActiveHoursOnly")}
          />
          <p className="text-sm text-muted-foreground">
            {t("noiseMeter.editor.activeHoursNote")}
          </p>
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("shared.targetsSection")}
          </h2>
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
        </section>

        {save.isError && (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            className={buttonVariants({ variant: "outline", size: "lg" })}
            to="/plugins/noise-meter"
          >
            {t("common:actions.cancel")}
          </Link>
          <RheaButton type="submit" disabled={save.isPending}>
            {save.isPending
              ? t("common:actions.saving")
              : editing
                ? t("common:actions.saveChanges")
                : t("shared.createInstance")}
          </RheaButton>
        </div>
      </form>
    </main>
  );
}
