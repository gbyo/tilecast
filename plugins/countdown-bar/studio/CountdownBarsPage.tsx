import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Clock3, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import {
  DateTimeInput,
  FormField,
  PluginPage,
  RegisterCheckbox,
  TargetFields,
  apiErrorMessage,
  pluginsQueryKey,
  scheduleWeekdays,
  toLocalInputValue,
  toast,
  useConfirm,
  useOrganizationRegionalProfile,
  usePluginTranslation,
  useStudioSession,
  useTargetSource,
  weekdayShortLabel,
  type PluginT,
} from "@tilecast/studio";
import { Alert, AlertDescription } from "@tilecast/studio/ui/alert";
import { Badge } from "@tilecast/studio/ui/badge";
import { Button, buttonVariants } from "@tilecast/studio/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@tilecast/studio/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@tilecast/studio/ui/toggle-group";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyContent,
} from "@tilecast/studio/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@tilecast/studio/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tilecast/studio/ui/select";
import {
  countdownBarQueryKey,
  countdownBarsQueryKey,
  countdownApi,
  type CountdownBarInput,
} from "./api";
import en from "./locales/en.json";

export const PLUGIN_ID = "countdown_bar";

type CountdownT = PluginT<typeof en>;

// Schemas are built at render time from `t` so validation messages follow
// the interface language. Callers pass the `t` they already use.
export function makeCountdownSchema(ct: CountdownT) {
  return z
    .object({
      name: z.string().trim().min(1).max(180),
      message: z.string().trim().min(1).max(280),
      scheduleType: z.enum(["weekly", "one_time"]),
      targetTime: z.string(),
      daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)),
      oneTimeAt: z.string(),
      timezone: z
        .string({ error: ct("validation.timezone") })
        .trim()
        .min(1, ct("validation.timezone"))
        .max(100, ct("validation.timezone")),
      leadMinutes: z.coerce
        .number({ error: ct("validation.wholeMinutes") })
        .int(ct("validation.wholeMinutes"))
        .min(1, ct("validation.leadRange"))
        .max(43_200, ct("validation.leadRange")),
      completionText: z.string().trim().max(280),
      showConfetti: z.boolean(),
      displayMode: z.enum(["overlay", "push"]),
      progressFill: z.enum(["none", "drain"]),
      heightPx: z.coerce
        .number({ error: ct("validation.heightRange") })
        .int(ct("validation.heightRange"))
        .min(40, ct("validation.heightRange"))
        .max(320, ct("validation.heightRange")),
      contentPadding: z.coerce
        .number({ error: ct("validation.paddingRange") })
        .int(ct("validation.paddingRange"))
        .min(0, ct("validation.paddingRange"))
        .max(40, ct("validation.paddingRange")),
      textScale: z.coerce
        .number({ error: ct("validation.textScaleRange") })
        .int(ct("validation.textScaleRange"))
        .min(25, ct("validation.textScaleRange"))
        .max(500, ct("validation.textScaleRange")),
      urgencyEnabled: z.boolean(),
      startingSoonMinutes: z.coerce
        .number({ error: ct("validation.wholeMinutes") })
        .int(ct("validation.wholeMinutes"))
        .min(1, ct("validation.soonRange"))
        .max(1_440, ct("validation.soonRange")),
      urgentSeconds: z.coerce
        .number({ error: ct("validation.wholeSeconds") })
        .int(ct("validation.wholeSeconds"))
        .min(2, ct("validation.urgentRange"))
        .max(3_600, ct("validation.urgentRange")),
      pulseSeconds: z.coerce
        .number({ error: ct("validation.wholeSeconds") })
        .int(ct("validation.wholeSeconds"))
        .min(1, ct("validation.pulseRange"))
        .max(60, ct("validation.pulseRange")),
      enabled: z.boolean(),
      priority: z.coerce
        .number({ error: ct("validation.priorityRange") })
        .int(ct("validation.priorityRange"))
        .min(-1000, ct("validation.priorityRange"))
        .max(1000, ct("validation.priorityRange")),
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
          message: ct("validation.weeklyRequired"),
        });
      }
      if (value.scheduleType === "one_time" && !value.oneTimeAt) {
        context.addIssue({
          code: "custom",
          path: ["oneTimeAt"],
          message: ct("validation.oneTimeRequired"),
        });
      }
      if (value.targetScope !== "all" && value.targetIds.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["targetIds"],
          message: ct("validation.targetRequired"),
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
          message: ct("validation.stageOrder"),
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
function makeCountdownDefaults(ct: CountdownT, timezone: string): FormValues {
  return {
    name: "",
    message: ct("editor.defaults.message"),
    scheduleType: "weekly",
    targetTime: "12:00",
    daysOfWeek: [1, 2, 3, 4, 5],
    oneTimeAt: "",
    timezone,
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
  { value: "weekly", labelKey: "editor.scheduleType.weekly" },
  { value: "one_time", labelKey: "editor.scheduleType.oneTime" },
] as const;

const displayModeOptions = [
  { value: "overlay", labelKey: "editor.displayMode.overlay" },
  { value: "push", labelKey: "editor.displayMode.push" },
] as const;

const progressFillOptions = [
  { value: "none", labelKey: "editor.progressFill.none" },
  { value: "drain", labelKey: "editor.progressFill.drain" },
] as const;

export function CountdownBarsPage() {
  const { t } = useTranslation(["plugins", "common"]);
  const { t: ct } = usePluginTranslation(PLUGIN_ID, en);
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const instances = useQuery({
    queryKey: countdownBarsQueryKey,
    queryFn: countdownApi.list,
  });
  const remove = useMutation({
    mutationFn: (id: string) => countdownApi.remove(id, session.csrfToken),
    onSuccess: () => {
      toast.add({ title: ct("removedToast"), type: "success" });
      void queryClient.invalidateQueries({ queryKey: countdownBarsQueryKey });
      void queryClient.invalidateQueries({ queryKey: pluginsQueryKey });
    },
  });
  const manageable = session.canManage;
  // Only a successful, empty list is "nothing configured" — a failed load must
  // not read as an empty fleet.
  const showEmptyState =
    !instances.isError &&
    !instances.isLoading &&
    (instances.data?.items.length ?? 0) === 0;
  return (
    <>
      {confirmDialog}
      <PluginPage
        pluginId={PLUGIN_ID}
        title={ct("title")}
        description={ct("subtitle")}
        actions={
          manageable && (
            <Link
              className={buttonVariants({ size: "lg" })}
              to="/plugins/countdown-bar/new"
            >
              <Plus data-icon="inline-start" aria-hidden="true" />{" "}
              {t("shared.newInstance")}
            </Link>
          )
        }
      >
        {instances.isError && (
          <Alert variant="destructive">
            <AlertDescription>{ct("loadError")}</AlertDescription>
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
              <EmptyTitle>{ct("emptyTitle")}</EmptyTitle>
              <EmptyDescription>{ct("emptyDescription")}</EmptyDescription>
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
                    {ct("itemDescription", {
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
                    <Button
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
                          body: ct("deleteBody"),
                          action: t("common:actions.delete"),
                          destructive: true,
                        }).then((ok) => {
                          if (ok) remove.mutate(instance.id);
                        });
                      }}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </Button>
                  )}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </PluginPage>
    </>
  );
}

export function CountdownBarEditorPage() {
  const { t } = useTranslation(["plugins", "common"]);
  const { t: ct } = usePluginTranslation(PLUGIN_ID, en);
  const { id } = useParams();
  const editing = Boolean(id);
  const session = useStudioSession();
  const regional = useOrganizationRegionalProfile();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const schema = useMemo(() => makeCountdownSchema(ct), [ct]);
  const defaults = useMemo(
    () => makeCountdownDefaults(ct, regional.timezone),
    [ct, regional.timezone],
  );
  const instance = useQuery({
    queryKey: countdownBarQueryKey(id ?? ""),
    queryFn: () => countdownApi.get(id ?? ""),
    enabled: editing,
  });
  const previousLeadMinutes = useRef(defaults.leadMinutes);
  const timezoneTouched = useRef(false);
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
    control,
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
    if (!editing && !timezoneTouched.current)
      setValue("timezone", regional.timezone);
  }, [editing, regional.timezone, setValue]);
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
        ? countdownApi.update(id ?? "", input, session.csrfToken)
        : countdownApi.create(input, session.csrfToken),
    onSuccess: () => {
      toast.add({
        title: editing ? ct("updatedToast") : ct("createdToast"),
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: countdownBarsQueryKey });
      void queryClient.invalidateQueries({ queryKey: pluginsQueryKey });
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
          <ArrowLeft size={15} aria-hidden="true" /> {ct("title")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {editing ? ct("editor.manageTitle") : ct("editor.createTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">{ct("editor.subtitle")}</p>
      </header>
      <form
        className="grid gap-4"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {ct("editor.sections.content")}
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
            label={ct("editor.messageLabel")}
            aria-required="true"
            error={errors.message?.message}
            {...register("message")}
          />
          <FormField
            id="countdown-completion"
            label={ct("editor.completionLabel")}
            placeholder={ct("editor.completionPlaceholder")}
            hint={ct("editor.completionHint")}
            error={errors.completionText?.message}
            {...register("completionText")}
          />
          <RegisterCheckbox
            control={control}
            name="showConfetti"
            label={ct("editor.confettiLabel")}
          />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {ct("editor.sections.timing")}
          </h2>
          <Field>
            <FieldLabel htmlFor="countdown-schedule-type">
              {ct("editor.scheduleLabel")}
            </FieldLabel>
            <Select
              items={scheduleTypeOptions.map((option) => ({
                value: option.value,
                label: ct(option.labelKey),
              }))}
              name="scheduleType"
              value={scheduleType}
              onValueChange={(next) => {
                if (next) setScheduleType(next);
              }}
            >
              <SelectTrigger
                id="countdown-schedule-type"
                aria-label={ct("editor.scheduleLabel")}
              >
                <SelectValue>
                  {ct(
                    scheduleTypeOptions.find(
                      (option) => option.value === scheduleType,
                    )?.labelKey ?? "editor.scheduleType.weekly",
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {scheduleTypeOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {ct(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {scheduleType === "weekly" ? (
            <>
              <FormField
                id="countdown-target-time"
                label={ct("editor.targetTimeLabel")}
                type="time"
                error={errors.targetTime?.message}
                {...register("targetTime")}
              />
              <div className="grid gap-2">
                <span className="text-sm font-medium" id="countdown-days-label">
                  {ct("editor.daysLabel")}
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
            <Controller
              control={control}
              name="oneTimeAt"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="countdown-one-time">
                    {ct("editor.oneTimeLabel")}
                  </FieldLabel>
                  <DateTimeInput
                    id="countdown-one-time"
                    aria-label={ct("editor.oneTimeLabel")}
                    timeLabel={ct("editor.targetTimeLabel")}
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
                    {ct("editor.oneTimeHint")}
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
              label={ct("editor.timezoneLabel")}
              aria-required="true"
              error={errors.timezone?.message}
              {...register("timezone", {
                onChange: () => {
                  timezoneTouched.current = true;
                },
              })}
            />
            <FormField
              id="countdown-lead"
              label={ct("editor.leadLabel")}
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
            {ct("editor.sections.display")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="countdown-display-mode">
                {ct("editor.modeLabel")}
              </FieldLabel>
              <Select
                items={displayModeOptions.map((option) => ({
                  value: option.value,
                  label: ct(option.labelKey),
                }))}
                name="displayMode"
                value={displayMode}
                onValueChange={(next) => {
                  if (next) setDisplayMode(next);
                }}
              >
                <SelectTrigger
                  id="countdown-display-mode"
                  aria-label={ct("editor.modeLabel")}
                >
                  <SelectValue>
                    {ct(
                      displayModeOptions.find(
                        (option) => option.value === displayMode,
                      )?.labelKey ?? "editor.displayMode.overlay",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {displayModeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {ct(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="countdown-progress-fill">
                {ct("editor.progressLabel")}
              </FieldLabel>
              <Select
                items={progressFillOptions.map((option) => ({
                  value: option.value,
                  label: ct(option.labelKey),
                }))}
                name="progressFill"
                value={progressFill}
                onValueChange={(next) => {
                  if (next) setProgressFill(next);
                }}
              >
                <SelectTrigger
                  id="countdown-progress-fill"
                  aria-label={ct("editor.progressLabel")}
                >
                  <SelectValue>
                    {ct(
                      progressFillOptions.find(
                        (option) => option.value === progressFill,
                      )?.labelKey ?? "editor.progressFill.none",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {progressFillOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {ct(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>{ct("editor.progressHint")}</FieldDescription>
            </Field>
            <FormField
              id="countdown-height"
              label={ct("editor.heightLabel")}
              type="number"
              min={40}
              max={320}
              error={errors.heightPx?.message}
              {...register("heightPx", { valueAsNumber: true })}
            />
            <FormField
              id="countdown-padding"
              label={ct("editor.paddingLabel")}
              hint={ct("editor.paddingHint")}
              aria-label={ct("editor.paddingLabel")}
              type="number"
              min={0}
              max={40}
              error={errors.contentPadding?.message}
              {...register("contentPadding", { valueAsNumber: true })}
            />
            <FormField
              id="countdown-text-scale"
              label={ct("editor.textScaleLabel")}
              hint={ct("editor.textScaleHint")}
              aria-label={ct("editor.textScaleLabel")}
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
            control={control}
            name="enabled"
            label={t("shared.enabledLabel")}
          />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h2 className="text-base font-semibold">
              {ct("editor.sections.urgency")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {ct("editor.urgencyDescription")}
            </p>
          </header>
          <RegisterCheckbox
            control={control}
            name="urgencyEnabled"
            label={ct("editor.urgencyEnabledLabel")}
          />
          {urgencyEnabled && (
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                id="countdown-starting-soon"
                label={ct("editor.startingSoonLabel")}
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
                label={ct("editor.urgentLabel")}
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
                label={ct("editor.pulseLabel")}
                hint={ct("editor.pulseHint")}
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
          <Button type="submit" disabled={save.isPending}>
            {save.isPending
              ? t("common:actions.saving")
              : editing
                ? t("common:actions.saveChanges")
                : t("shared.createInstance")}
          </Button>
        </div>
      </form>
    </main>
  );
}
