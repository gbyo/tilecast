import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, Stamp, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router";
import { z } from "zod";
import { api } from "../api/client";
import type { BrandBug, BrandBugInput } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { FormField } from "../components/FormField";
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
import {
  RegisterCheckbox,
  TargetFields,
  canManage,
  toLocalInputValue,
  useTargetSource,
} from "../plugins/shared";

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
              <ArrowLeft size={15} aria-hidden="true" /> Plugins
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">
              Brand Bug / Watermark
            </h1>
            <p className="text-sm text-muted-foreground">
              Corner marks stay on screen over playlists, Layouts, websites, and
              Widgets without changing what is playing.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manageable && (
              <Link
                className={buttonVariants({ size: "lg" })}
                to="/plugins/brand-bug/new"
              >
                <Plus data-icon="inline-start" aria-hidden="true" /> New
                instance
              </Link>
            )}
            <PluginActionsMenu pluginId="brand_bug" />
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
            <AlertDescription>Brand bugs could not be loaded.</AlertDescription>
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
                <Stamp size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>No brand bugs configured</EmptyTitle>
              <EmptyDescription>
                Create an instance to hold a logo, notice, or badge in a corner
                of selected screens.
              </EmptyDescription>
            </EmptyHeader>
            {manageable && (
              <EmptyContent>
                <Link className={buttonVariants()} to="/plugins/brand-bug/new">
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
                  <ItemDescription>{brandBugSummary(instance)}</ItemDescription>
                </ItemContent>
                <ItemActions className="flex-wrap">
                  <Link
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    to={`/plugins/brand-bug/${instance.id}`}
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
                          body: "The mark will be removed from targeted Players.",
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
  const backingOptions = [
    { value: "scrim", label: "Shaded plate behind the mark" },
    { value: "none", label: "Nothing behind the mark" },
  ];
  return (
    <main className="grid gap-4">
      <header className="grid min-w-0 gap-1">
        <Link
          className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          to="/plugins/brand-bug"
        >
          <ArrowLeft size={15} aria-hidden="true" /> Brand Bug / Watermark
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {editing ? "Manage brand bug" : "New brand bug"}
        </h1>
        <p className="text-sm text-muted-foreground">
          One mark shows per corner. Priority decides which instance wins when
          two want the same corner.
        </p>
      </header>
      <form
        className="grid gap-4"
        onSubmit={(event) => void handleSubmit(submit)(event)}
      >
        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Mark</h2>
          <FormField
            id="brand-bug-name"
            label="Name"
            aria-required="true"
            error={errors.name?.message}
            {...register("name")}
          />
          <Field>
            <FieldLabel htmlFor="brand-bug-image">Logo image</FieldLabel>
            <RheaSelect
              name="imageAssetId"
              value={imageAssetId || "none"}
              onValueChange={(next) =>
                setValue("imageAssetId", !next || next === "none" ? "" : next, {
                  shouldDirty: true,
                })
              }
            >
              <SelectTrigger id="brand-bug-image" aria-label="Logo image">
                <SelectValue>
                  {imageAssetId
                    ? ((images.data?.items ?? []).find(
                        (item) => item.id === imageAssetId,
                      )?.name ?? imageAssetId)
                    : "No image"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No image</SelectItem>
                {(images.data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
            <FieldDescription>
              Uploaded, processed images only.
            </FieldDescription>
          </Field>
          <FormField
            id="brand-bug-text"
            label="Text"
            placeholder="Presented by Example"
            hint="Shown beneath the logo, or on its own for a notice or location label."
            error={errors.text?.message}
            {...register("text")}
          />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Placement</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="brand-bug-corner">Corner</FieldLabel>
              <RheaSelect
                name="corner"
                value={corner}
                onValueChange={(next) => {
                  if (next)
                    setValue("corner", next, {
                      shouldDirty: true,
                    });
                }}
              >
                <SelectTrigger id="brand-bug-corner" aria-label="Corner">
                  <SelectValue>{cornerLabels[corner]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(cornerLabels) as BrandBugInput["corner"][]).map(
                    (value) => (
                      <SelectItem key={value} value={value}>
                        {cornerLabels[value]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </RheaSelect>
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
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Appearance</h2>
          <div className="grid gap-4 sm:grid-cols-3">
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
            <Field>
              <FieldLabel htmlFor="brand-bug-backing">Backing</FieldLabel>
              <RheaSelect
                name="backgroundStyle"
                value={backgroundStyle}
                onValueChange={(next) => {
                  if (next)
                    setValue("backgroundStyle", next, { shouldDirty: true });
                }}
              >
                <SelectTrigger id="brand-bug-backing" aria-label="Backing">
                  <SelectValue>
                    {backingOptions.find(
                      (option) => option.value === backgroundStyle,
                    )?.label ?? backgroundStyle}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {backingOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
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
          <RegisterCheckbox label="Enabled" {...register("enabled")} />
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Optional window</h2>
          <div className="grid gap-4 sm:grid-cols-2">
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
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <h2 className="text-base font-semibold">Targets</h2>
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
        </section>

        {save.isError && (
          <Alert variant="destructive">
            <AlertDescription>{save.error.message}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            className={buttonVariants({ variant: "outline", size: "lg" })}
            to="/plugins/brand-bug"
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
