import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Stamp, Trash2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { api } from "../api/client";
import type { BrandBug, BrandBugInput } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { FormField } from "../components/FormField";
import { DateTimeInput } from "../components/date-picker";
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
import { apiErrorMessage } from "../i18n";
import {
  RegisterCheckbox,
  TargetFields,
  canManage,
  toLocalInputValue,
  useTargetSource,
} from "../plugins/shared";
import type { PluginsT } from "../plugins/pluginCatalog";

const cornerLabelKeys = {
  top_left: "brandBug.editor.corners.topLeft",
  top_right: "brandBug.editor.corners.topRight",
  bottom_left: "brandBug.editor.corners.bottomLeft",
  bottom_right: "brandBug.editor.corners.bottomRight",
} as const satisfies Record<
  BrandBugInput["corner"],
  `brandBug.editor.corners.${string}`
>;

// Schemas are built at render time from `t` so validation messages follow
// the interface language. Callers pass the `t` they already use.
export function makeBrandBugSchema(t: PluginsT) {
  return z
    .object({
      name: z.string().trim().min(1).max(180),
      corner: z.enum(["top_left", "top_right", "bottom_left", "bottom_right"]),
      imageAssetId: z.string(),
      text: z.string().trim().max(180, t("brandBug.validation.textMax")),
      widthPercent: z.coerce
        .number({ error: t("brandBug.validation.widthRange") })
        .int(t("brandBug.validation.widthRange"))
        .min(2, t("brandBug.validation.widthRange"))
        .max(40, t("brandBug.validation.widthRange")),
      textSizePercent: z.coerce
        .number({ error: t("brandBug.validation.textSizeRange") })
        .int(t("brandBug.validation.textSizeRange"))
        .min(1, t("brandBug.validation.textSizeRange"))
        .max(12, t("brandBug.validation.textSizeRange")),
      opacityPercent: z.coerce
        .number({ error: t("brandBug.validation.opacityRange") })
        .int(t("brandBug.validation.opacityRange"))
        .min(10, t("brandBug.validation.opacityRange"))
        .max(100, t("brandBug.validation.opacityRange")),
      marginPercent: z.coerce
        .number({ error: t("brandBug.validation.marginRange") })
        .int(t("brandBug.validation.marginRange"))
        .min(0, t("brandBug.validation.marginRange"))
        .max(20, t("brandBug.validation.marginRange")),
      textColor: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/, t("brandBug.validation.color")),
      backgroundStyle: z.enum(["none", "scrim"]),
      startsAt: z.string(),
      endsAt: z.string(),
      enabled: z.boolean(),
      priority: z.coerce
        .number({ error: t("brandBug.validation.priorityRange") })
        .int(t("brandBug.validation.priorityRange"))
        .min(-1000, t("brandBug.validation.priorityRange"))
        .max(1000, t("brandBug.validation.priorityRange")),
      targetScope: z.enum(["all", "screens", "sync_groups", "locations"]),
      targetIds: z.array(z.string()),
    })
    .superRefine((value, context) => {
      if (!value.imageAssetId && value.text.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["text"],
          message: t("brandBug.validation.contentRequired"),
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
          message: t("brandBug.validation.windowOrder"),
        });
      }
      if (value.targetScope !== "all" && value.targetIds.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["targetIds"],
          message: t("brandBug.validation.targetRequired"),
        });
      }
    });
}

type BrandBugFormValues = z.infer<ReturnType<typeof makeBrandBugSchema>>;
type BrandBugFormInput = z.input<ReturnType<typeof makeBrandBugSchema>>;

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
function brandBugSummary(instance: BrandBug, t: PluginsT) {
  const parts = [t(cornerLabelKeys[instance.corner])];
  if (instance.imageAssetId) parts.push(t("brandBug.summary.logo"));
  if (instance.text)
    parts.push(t("brandBug.summary.quotedText", { text: instance.text }));
  parts.push(t("brandBug.summary.opacity", { value: instance.opacityPercent }));
  if (instance.startsAt || instance.endsAt)
    parts.push(t("brandBug.summary.scheduledWindow"));
  return parts.join(" · ");
}

export function BrandBugsPage() {
  const { t } = useTranslation(["plugins", "common"]);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const instances = useQuery({
    queryKey: ["brand-bugs"],
    queryFn: api.brandBugs,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.deleteBrandBug(id, auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      toast.add({ title: "Brand Bug removed.", type: "success" });
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
              {t("brandBug.title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("brandBug.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manageable && (
              <Link
                className={buttonVariants({ size: "lg" })}
                to="/plugins/brand-bug/new"
              >
                <Plus data-icon="inline-start" aria-hidden="true" />{" "}
                {t("shared.newInstance")}
              </Link>
            )}
            <PluginActionsMenu pluginId="brand_bug" />
          </div>
        </header>
        {!manageable && (
          <Alert>
            <AlertDescription>{t("shared.manageNote")}</AlertDescription>
          </Alert>
        )}
        {instances.isError && (
          <Alert variant="destructive">
            <AlertDescription>{t("brandBug.loadError")}</AlertDescription>
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
                <Stamp size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{t("brandBug.emptyTitle")}</EmptyTitle>
              <EmptyDescription>
                {t("brandBug.emptyDescription")}
              </EmptyDescription>
            </EmptyHeader>
            {manageable && (
              <EmptyContent>
                <Link className={buttonVariants()} to="/plugins/brand-bug/new">
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
                    {brandBugSummary(instance, t)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="flex-wrap">
                  <Link
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    to={`/plugins/brand-bug/${instance.id}`}
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
                          body: t("brandBug.deleteBody"),
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

export function BrandBugEditorPage() {
  const { t } = useTranslation(["plugins", "common"]);
  const { id } = useParams();
  const editing = Boolean(id);
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const schema = useMemo(() => makeBrandBugSchema(t), [t]);
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
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<BrandBugFormInput, unknown, BrandBugFormValues>({
    resolver: zodResolver(schema),
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
      toast.add({ title: "Brand Bug saved.", type: "success" });
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
  const backingOptions = [
    { value: "scrim", labelKey: "brandBug.editor.backing.scrim" },
    { value: "none", labelKey: "brandBug.editor.backing.none" },
  ] as const;
  return (
    <main className="grid gap-4">
      <header className="grid min-w-0 gap-1">
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          to="/plugins/brand-bug"
        >
          <ArrowLeft size={15} aria-hidden="true" /> {t("brandBug.title")}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {editing
            ? t("brandBug.editor.manageTitle")
            : t("brandBug.editor.createTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("brandBug.editor.subtitle")}
        </p>
      </header>
      <form
        className="grid gap-4"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("brandBug.editor.sections.mark")}
          </h2>
          <FormField
            id="brand-bug-name"
            label={t("shared.nameLabel")}
            aria-required="true"
            error={errors.name?.message}
            {...register("name")}
          />
          <Field>
            <FieldLabel htmlFor="brand-bug-image">
              {t("brandBug.editor.logoLabel")}
            </FieldLabel>
            <RheaSelect
              items={[
                { value: "none", label: "No image" },
                ...(images.data?.items ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ]}
              name="imageAssetId"
              value={imageAssetId || "none"}
              onValueChange={(next) =>
                setValue("imageAssetId", !next || next === "none" ? "" : next, {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger
                id="brand-bug-image"
                aria-label={t("brandBug.editor.logoLabel")}
              >
                <SelectValue>
                  {imageAssetId
                    ? ((images.data?.items ?? []).find(
                        (item) => item.id === imageAssetId,
                      )?.name ?? imageAssetId)
                    : t("brandBug.editor.noImage")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {t("brandBug.editor.noImage")}
                </SelectItem>
                {(images.data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
            <FieldDescription>{t("brandBug.editor.logoHint")}</FieldDescription>
          </Field>
          <FormField
            id="brand-bug-text"
            label={t("brandBug.editor.textLabel")}
            placeholder={t("brandBug.editor.textPlaceholder")}
            hint={t("brandBug.editor.textHint")}
            error={errors.text?.message}
            {...register("text")}
          />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("brandBug.editor.sections.placement")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="brand-bug-corner">
                {t("brandBug.editor.cornerLabel")}
              </FieldLabel>
              <RheaSelect
                items={(
                  Object.keys(cornerLabels) as BrandBugInput["corner"][]
                ).map((value) => ({ value, label: cornerLabels[value] }))}
                name="corner"
                value={corner}
                onValueChange={(next) => {
                  if (next)
                    setValue("corner", next, {
                      shouldDirty: true,
                    });
                }}
              >
                <SelectTrigger
                  id="brand-bug-corner"
                  aria-label={t("brandBug.editor.cornerLabel")}
                >
                  <SelectValue>{t(cornerLabelKeys[corner])}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(
                    Object.keys(cornerLabelKeys) as BrandBugInput["corner"][]
                  ).map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(cornerLabelKeys[value])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <FormField
              id="brand-bug-width"
              label={t("brandBug.editor.widthLabel")}
              type="number"
              min={2}
              max={40}
              error={errors.widthPercent?.message}
              {...register("widthPercent", { valueAsNumber: true })}
            />
            <FormField
              id="brand-bug-margin"
              label={t("brandBug.editor.marginLabel")}
              type="number"
              min={0}
              max={20}
              error={errors.marginPercent?.message}
              {...register("marginPercent", { valueAsNumber: true })}
            />
          </div>
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("brandBug.editor.sections.appearance")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              id="brand-bug-text-size"
              label={t("brandBug.editor.textSizeLabel")}
              type="number"
              min={1}
              max={12}
              error={errors.textSizePercent?.message}
              {...register("textSizePercent", { valueAsNumber: true })}
            />
            <FormField
              id="brand-bug-color"
              label={t("brandBug.editor.colorLabel")}
              type="color"
              error={errors.textColor?.message}
              {...register("textColor")}
            />
            <Field>
              <FieldLabel htmlFor="brand-bug-backing">
                {t("brandBug.editor.backingLabel")}
              </FieldLabel>
              <RheaSelect
                items={backingOptions}
                name="backgroundStyle"
                value={backgroundStyle}
                onValueChange={(next) => {
                  if (next)
                    setValue("backgroundStyle", next, { shouldDirty: true });
                }}
              >
                <SelectTrigger
                  id="brand-bug-backing"
                  aria-label={t("brandBug.editor.backingLabel")}
                >
                  <SelectValue>
                    {t(
                      backingOptions.find(
                        (option) => option.value === backgroundStyle,
                      )?.labelKey ?? "brandBug.editor.backing.scrim",
                    )}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {backingOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="brand-bug-opacity"
              label={t("brandBug.editor.opacityLabel")}
              type="number"
              min={10}
              max={100}
              error={errors.opacityPercent?.message}
              {...register("opacityPercent", { valueAsNumber: true })}
            />
            <FormField
              id="brand-bug-priority"
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
          <h2 className="text-base font-semibold">
            {t("brandBug.editor.sections.window")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={control}
              name="startsAt"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="brand-bug-starts-date">
                    {t("brandBug.editor.windowFrom")}
                  </FieldLabel>
                  <DateTimeInput
                    id="brand-bug-starts"
                    aria-label={t("brandBug.editor.windowFrom")}
                    timeLabel={t("brandBug.editor.windowFromTime")}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={fieldState.invalid}
                    aria-describedby={
                      fieldState.error
                        ? "brand-bug-starts-hint brand-bug-starts-error"
                        : "brand-bug-starts-hint"
                    }
                  />
                  <FieldDescription id="brand-bug-starts-hint">
                    {t("brandBug.editor.windowFromHint")}
                  </FieldDescription>
                  <FieldError
                    id="brand-bug-starts-error"
                    errors={[fieldState.error]}
                  />
                </Field>
              )}
            />
            <Controller
              control={control}
              name="endsAt"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="brand-bug-ends-date">
                    {t("brandBug.editor.windowUntil")}
                  </FieldLabel>
                  <DateTimeInput
                    id="brand-bug-ends"
                    aria-label={t("brandBug.editor.windowUntil")}
                    timeLabel={t("brandBug.editor.windowUntilTime")}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    aria-invalid={fieldState.invalid}
                    aria-describedby={
                      fieldState.error
                        ? "brand-bug-ends-hint brand-bug-ends-error"
                        : "brand-bug-ends-hint"
                    }
                  />
                  <FieldDescription id="brand-bug-ends-hint">
                    {t("brandBug.editor.windowUntilHint")}
                  </FieldDescription>
                  <FieldError
                    id="brand-bug-ends-error"
                    errors={[fieldState.error]}
                  />
                </Field>
              )}
            />
          </div>
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">
            {t("shared.targetsSection")}
          </h2>
          <TargetFields
            idPrefix="brand-bug"
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
            <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            className={buttonVariants({ variant: "outline", size: "lg" })}
            to="/plugins/brand-bug"
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
