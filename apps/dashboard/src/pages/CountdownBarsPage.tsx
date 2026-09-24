import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clock3, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { api } from "../api/client";
import type { CountdownBarInput } from "../api/types";
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
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { apiErrorMessage } from "../i18n";
import {
  RegisterCheckbox,
  TargetFields,
  canManage,
  toLocalInputValue,
  useTargetSource,
  weekdayShortLabel,
} from "../plugins/shared";
import type { PluginsT } from "../plugins/pluginCatalog";

// Schemas are built at render time from `t` so validation messages follow
// the interface language. Callers pass the `t` they already use.
export function makeCountdownSchema(t: PluginsT) {
  return z
    .object({
      name: z.string().trim().min(1).max(180),
      message: z.string().trim().min(1).max(280),
      scheduleType: z.enum(["weekly", "one_time"]),
      targetTime: z.string(),
      daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)),
      oneTimeAt: z.string(),
      timezone: z
        .string({ error: t("countdown.validation.timezone") })
        .trim()
        .min(1, t("countdown.validation.timezone"))
        .max(100, t("countdown.validation.timezone")),
      leadMinutes: z.coerce
        .number({ error: t("countdown.validation.wholeMinutes") })
        .int(t("countdown.validation.wholeMinutes"))
        .min(1, t("countdown.validation.leadRange"))
        .max(43_200, t("countdown.validation.leadRange")),
      completionText: z.string().trim().max(280),
      showConfetti: z.boolean(),
      displayMode: z.enum(["overlay", "push"]),
      progressFill: z.enum(["none", "drain"]),
      heightPx: z.coerce
        .number({ error: t("countdown.validation.heightRange") })
        .int(t("countdown.validation.heightRange"))
        .min(40, t("countdown.validation.heightRange"))
        .max(320, t("countdown.validation.heightRange")),
      contentPadding: z.coerce
        .number({ error: t("countdown.validation.paddingRange") })
        .int(t("countdown.validation.paddingRange"))
        .min(0, t("countdown.validation.paddingRange"))
        .max(40, t("countdown.validation.paddingRange")),
      textScale: z.coerce
        .number({ error: t("countdown.validation.textScaleRange") })
        .int(t("countdown.validation.textScaleRange"))
        .min(25, t("countdown.validation.textScaleRange"))
        .max(500, t("countdown.validation.textScaleRange")),
      urgencyEnabled: z.boolean(),
      startingSoonMinutes: z.coerce
        .number({ error: t("countdown.validation.wholeMinutes") })
        .int(t("countdown.validation.wholeMinutes"))
        .min(1, t("countdown.validation.soonRange"))
        .max(1_440, t("countdown.validation.soonRange")),
      urgentSeconds: z.coerce
        .number({ error: t("countdown.validation.wholeSeconds") })
        .int(t("countdown.validation.wholeSeconds"))
        .min(2, t("countdown.validation.urgentRange"))
        .max(3_600, t("countdown.validation.urgentRange")),
      pulseSeconds: z.coerce
        .number({ error: t("countdown.validation.wholeSeconds") })
        .int(t("countdown.validation.wholeSeconds"))
        .min(1, t("countdown.validation.pulseRange"))
        .max(60, t("countdown.validation.pulseRange")),
      enabled: z.boolean(),
      priority: z.coerce
        .number({ error: t("countdown.validation.priorityRange") })
        .int(t("countdown.validation.priorityRange"))
        .min(-1000, t("countdown.validation.priorityRange"))
        .max(1000, t("countdown.validation.priorityRange")),
      targetScope: z.enum(["all", "screens", "sync_groups", "locations"]),
      targetIds: z.array(z.string()),
    })
    .superRefine((value, context) => {
      if (
        value.scheduleType === "weekly" &&
        (!/^\d{2}:\d{2}$/.test(value.targetTime) ||
          value.daysOfWeek.length === 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["daysOfWeek"],
          message: t("countdown.validation.weeklyRequired"),
        });
      }
      if (value.scheduleType === "one_time" && !value.oneTimeAt) {
        context.addIssue({
          code: "custom",
          path: ["oneTimeAt"],
          message: t("countdown.validation.oneTimeRequired"),
        });
      }
      if (value.targetScope !== "all" && value.targetIds.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["targetIds"],
          message: t("countdown.validation.targetRequired"),
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
          message: t("countdown.validation.stageOrder"),
        });
      }
    });
}

type FormValues = z.infer<ReturnType<typeof makeCountdownSchema>>;
type FormInput = z.input<ReturnType<typeof makeCountdownSchema>>;

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

// New-instance defaults, including the suggested message callers see
// prefilled in the form. Built from `t` like the schema above.
function makeCountdownDefaults(t: PluginsT): FormValues {
  return {
    name: "",
    message: t("countdown.editor.defaults.message"),
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
}

const scheduleTypeOptions = [
  { value: "weekly", labelKey: "countdown.editor.scheduleType.weekly" },
  { value: "one_time", labelKey: "countdown.editor.scheduleType.oneTime" },
] as const;

const displayModeOptions = [
  { value: "overlay", labelKey: "countdown.editor.displayMode.overlay" },
  { value: "push", labelKey: "countdown.editor.displayMode.push" },
] as const;

const progressFillOptions = [
  { value: "none", labelKey: "countdown.editor.progressFill.none" },
  { value: "drain", labelKey: "countdown.editor.progressFill.drain" },
] as const;

export function CountdownBarsPage() {
  const { t } = useTranslation(["plugins", "common"]);
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
              <ArrowLeft size={15} aria-hidden="true" />{" "}
              {t("shared.backToPlugins")}
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("countdown.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("countdown.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manageable && (
              <Link
                className={buttonVariants({ size: "lg" })}
                to="/plugins/countdown-bar/new"
              >
                <Plus data-icon="inline-start" aria-hidden="true" />{" "}
                {t("shared.newInstance")}
              </Link>
            )}
            <PluginActionsMenu pluginId="countdown_bar" />
          </div>
        </header>
        {!manageable && (
          <Alert>
            <AlertDescription>{t("shared.manageNote")}</AlertDescription>
          </Alert>
        )}
        {instances.isError && (
          <Alert variant="destructive">
            <AlertDescription>{t("countdown.loadError")}</AlertDescription>
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
                <Clock3 size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("countdown.emptyTitle")}</EmptyTitle>
              <EmptyDescription>
                {t("countdown.emptyDescription")}
              </EmptyDescription>
            </EmptyHeader>
            {manageable && (
              <EmptyContent>
                <Link
                  className={buttonVariants()}
                  to="/plugins/countdown-bar/new"
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
                    {t("countdown.itemDescription", {
                      message: instance.message,
                      displayMode: instance.displayMode,
                      height: instance.heightPx,
                      priority: instance.priority,
                    })}
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
                          body: t("countdown.deleteBody"),
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

export function CountdownBarEditorPage() {
  const { t } = useTranslation(["plugins", "common"]);
  const { id } = useParams();
  const editing = Boolean(id);
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const schema = useMemo(() => makeCountdownSchema(t), [t]);
  const defaults = useMemo(() => makeCountdownDefaults(t), [t]);
  const instance = useQuery({
    queryKey: ["countdown-bar", id],
    queryFn: () => api.countdownBar(id ?? ""),
    enabled: editing,
  });
  const previousLeadMinutes = useRef(defaults.leadMinutes);
  // Numeric urgency fallbacks are identical in every language; destructuring
  // keeps the reset effect below from re-running on a language change.
  const defaultStartingSoon = defaults.startingSoonMinutes;
  const defaultUrgent = defaults.urgentSeconds;
  const defaultPulse = defaults.pulseSeconds;
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
    resolver: zodResolver(schema),
    defaultValues: defaults,
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
        storedStartingSoon === defaultStartingSoon,
      urgentSeconds:
        storedUrgent === derived.urgentSeconds ||
        storedUrgent === defaultUrgent,
      pulseSeconds:
        storedPulse === derived.pulseSeconds || storedPulse === defaultPulse,
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
  }, [instance.data, reset, defaultStartingSoon, defaultUrgent, defaultPulse]);
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
    <main className="grid gap-4">
      <header className="grid min-w-0 gap-1">
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          to="/plugins/countdown-bar"
        >
          <ArrowLeft size={15} aria-hidden="true" /> {t("countdown.title")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {editing
            ? t("countdown.editor.manageTitle")
            : t("countdown.editor.createTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("countdown.editor.subtitle")}
        </p>
      </header>
      <form
        className="grid gap-4"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("countdown.editor.sections.content")}
          </h2>
          <FormField
            id="countdown-name"
            label={t("shared.nameLabel")}
            aria-required="true"
            error={errors.name?.message}
            {...register("name")}
          />
          <FormField
            id="countdown-message"
            label={t("countdown.editor.messageLabel")}
            aria-required="true"
            error={errors.message?.message}
            {...register("message")}
          />
          <FormField
            id="countdown-completion"
            label={t("countdown.editor.completionLabel")}
            placeholder={t("countdown.editor.completionPlaceholder")}
            hint={t("countdown.editor.completionHint")}
            error={errors.completionText?.message}
            {...register("completionText")}
          />
          <RegisterCheckbox
            label={t("countdown.editor.confettiLabel")}
            {...register("showConfetti")}
          />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("countdown.editor.sections.timing")}
          </h2>
          <Field>
            <FieldLabel htmlFor="countdown-schedule-type">
              {t("countdown.editor.scheduleLabel")}
            </FieldLabel>
            <RheaSelect
              items={scheduleTypeOptions}
              name="scheduleType"
              value={scheduleType}
              onValueChange={(next) => {
                if (next) setScheduleType(next);
              }}
            >
              <SelectTrigger
                id="countdown-schedule-type"
                aria-label={t("countdown.editor.scheduleLabel")}
              >
                <SelectValue>
                  {t(
                    scheduleTypeOptions.find(
                      (option) => option.value === scheduleType,
                    )?.labelKey ?? "countdown.editor.scheduleType.weekly",
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {scheduleTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
          </Field>
          {scheduleType === "weekly" ? (
            <>
              <FormField
                id="countdown-target-time"
                label={t("countdown.editor.targetTimeLabel")}
                type="time"
                error={errors.targetTime?.message}
                {...register("targetTime")}
              />
              <div className="grid gap-2">
                <span className="text-sm font-medium" id="countdown-days-label">
                  {t("countdown.editor.daysLabel")}
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
                      {weekdayShortLabel(day.value, t)}
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
            <FormField
              id="countdown-one-time"
              label={t("countdown.editor.oneTimeLabel")}
              type="datetime-local"
              hint={t("countdown.editor.oneTimeHint")}
              error={errors.oneTimeAt?.message}
              {...register("oneTimeAt")}
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="countdown-timezone"
              label={t("countdown.editor.timezoneLabel")}
              aria-required="true"
              error={errors.timezone?.message}
              {...register("timezone")}
            />
            <FormField
              id="countdown-lead"
              label={t("countdown.editor.leadLabel")}
              type="number"
              min={1}
              max={43_200}
              error={errors.leadMinutes?.message}
              {...register("leadMinutes", { valueAsNumber: true })}
            />
          </div>
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("countdown.editor.sections.display")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="countdown-display-mode">
                {t("countdown.editor.modeLabel")}
              </FieldLabel>
              <RheaSelect
                items={displayModeOptions}
                name="displayMode"
                value={displayMode}
                onValueChange={(next) => {
                  if (next) setDisplayMode(next);
                }}
              >
                <SelectTrigger
                  id="countdown-display-mode"
                  aria-label={t("countdown.editor.modeLabel")}
                >
                  <SelectValue>
                    {t(
                      displayModeOptions.find(
                        (option) => option.value === displayMode,
                      )?.labelKey ?? "countdown.editor.displayMode.overlay",
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
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="countdown-progress-fill">
                {t("countdown.editor.progressLabel")}
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
                  aria-label={t("countdown.editor.progressLabel")}
                >
                  <SelectValue>
                    {t(
                      progressFillOptions.find(
                        (option) => option.value === progressFill,
                      )?.labelKey ?? "countdown.editor.progressFill.none",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {progressFillOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
              <FieldDescription>
                {t("countdown.editor.progressHint")}
              </FieldDescription>
            </Field>
            <FormField
              id="countdown-height"
              label={t("countdown.editor.heightLabel")}
              type="number"
              min={40}
              max={320}
              error={errors.heightPx?.message}
              {...register("heightPx", { valueAsNumber: true })}
            />
            <FormField
              id="countdown-padding"
              label={t("countdown.editor.paddingLabel")}
              hint={t("countdown.editor.paddingHint")}
              aria-label={t("countdown.editor.paddingLabel")}
              type="number"
              min={0}
              max={40}
              error={errors.contentPadding?.message}
              {...register("contentPadding", { valueAsNumber: true })}
            />
            <FormField
              id="countdown-text-scale"
              label={t("countdown.editor.textScaleLabel")}
              hint={t("countdown.editor.textScaleHint")}
              aria-label={t("countdown.editor.textScaleLabel")}
              type="number"
              min={25}
              max={500}
              error={errors.textScale?.message}
              {...register("textScale", { valueAsNumber: true })}
            />
            <FormField
              id="countdown-priority"
              label={t("shared.priorityLabel")}
              type="number"
              min={-1000}
              max={1000}
              error={errors.priority?.message}
              {...register("priority", { valueAsNumber: true })}
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
              {t("countdown.editor.sections.urgency")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("countdown.editor.urgencyDescription")}
            </p>
          </header>
          <RegisterCheckbox
            label={t("countdown.editor.urgencyEnabledLabel")}
            {...register("urgencyEnabled")}
          />
          {urgencyEnabled && (
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                id="countdown-starting-soon"
                label={t("countdown.editor.startingSoonLabel")}
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
                label={t("countdown.editor.urgentLabel")}
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
                label={t("countdown.editor.pulseLabel")}
                hint={t("countdown.editor.pulseHint")}
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
          <h2 className="text-base font-semibold">
            {t("shared.targetsSection")}
          </h2>
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
        </section>

        {save.isError && (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            className={buttonVariants({ variant: "outline", size: "lg" })}
            to="/plugins/countdown-bar"
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
