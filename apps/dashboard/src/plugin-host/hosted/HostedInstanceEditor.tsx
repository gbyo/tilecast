import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  groupAuthoringFields,
  visibleAuthoringFields,
} from "@tilecast/config-schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError } from "../../api/errors";
import type { ContentDefinitionField } from "../../api/types";
import { FormField } from "@/components/FormField";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { WidgetInspectorField } from "@/components/content/widget-editor/fields/WidgetInspectorField";
import { RowIdentityEpoch } from "@/components/content/widget-editor/fields/rowIdentity";
import { apiErrorMessage } from "@/i18n";
import { pluginsQueryKey } from "../../plugins/pluginCatalog";
import { TargetFields, useTargetSource } from "../../plugins/shared";
import { useOrganizationRegionalProfile } from "../../settings/regionalProfile";
import { useNavigationWarning } from "../../settings/useNavigationWarning";
import { PluginPage } from "../PluginPage";
import { useStudioSession } from "../session";
import {
  hostedClient,
  hostedInstanceKey,
  hostedInstancesKey,
  REVISION_CONFLICT_CODES,
} from "./api";
import { HostedSecretField } from "./HostedSecretField";
import { kindRoute, type HostedPluginProps } from "./HostedInstancesPage";
import { localizePluginFields } from "./localize";
import {
  formProblems,
  formStateOf,
  newFormState,
  requestBody,
  scheduleFields,
  type HostedDocument,
  type HostedFormState,
} from "./model";
import { SecretKeyNotice } from "./SecretKeyNotice";

const NO_FOCUS = null;

/**
 * The generated create and edit page of an instance kind. The host members
 * (name, enabled, priority, targets, schedule) and the kind's fields render
 * with the same controls the Widget inspector uses; nothing here is specific
 * to one plugin. An update names the revision it read, and a newer saved
 * version is reported instead of being overwritten.
 */
export function HostedInstanceEditor({
  pluginId,
  manifest,
  kindPath,
}: HostedPluginProps) {
  const { t } = useTranslation(["plugins", "common", "content"]);
  const params = useParams();
  const kinds = manifest.instances;
  const kind = kinds.find((item) => item.path === kindPath) ?? kinds[0]!;
  const id = params["id"];
  const editing = Boolean(id);
  const session = useStudioSession();
  const regional = useOrganizationRegionalProfile();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const client = hostedClient(manifest.api!.basePaths[0]!, kind.path);
  const backTo = kindRoute(manifest, kind);
  const readOnly = !session.canManage;
  const fields = useMemo(
    () => localizePluginFields(pluginId, kind.fields ?? []),
    [pluginId, kind.fields],
  );
  const saved = useQuery({
    queryKey: hostedInstanceKey(pluginId, kind.kind, id ?? ""),
    queryFn: () => client.get(id!),
    enabled: editing,
  });
  const form = useForm<HostedFormState>({
    defaultValues: newFormState(kind, regional.timezone),
  });
  const { control, register, reset, setValue, watch, handleSubmit } = form;
  const state = watch();
  const [revision, setRevision] = useState<number | undefined>(undefined);
  const [secretStates, setSecretStates] = useState<HostedDocument["secrets"]>();
  const [revealed, setRevealed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const departing = useRef(false);

  // The saved instance fills the form once. Edits made before it loads would
  // be overwritten, so the form stays disabled until then.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    const document = saved.data;
    if (!document) return;
    const key = `${document.id}:${document.revision}`;
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    reset(formStateOf(kind, document, regional.timezone));
    setRevision(document.revision);
    setSecretStates(document.secrets);
    setEpoch((value) => value + 1);
  }, [saved.data, kind, regional.timezone, reset]);
  useEffect(() => {
    // A new instance starts in the organization's own zone.
    if (!editing)
      setValue("config", newFormState(kind, regional.timezone).config);
  }, [editing, kind, regional.timezone, setValue]);

  const awaitingSaved = editing && !saved.isSuccess;
  const targetSource = useTargetSource(state.targetScope);
  const scheduleFieldList = useMemo(
    () =>
      scheduleFields(kind, (key) => {
        switch (key) {
          case "startsAt":
            return t("hosted.schedule.startsAt");
          case "endsAt":
            return t("hosted.schedule.endsAt");
          case "timezone":
            return t("hosted.schedule.timezone");
          case "days":
            return t("hosted.schedule.days");
          case "startTime":
            return t("hosted.schedule.startTime");
          default:
            return t("hosted.schedule.endTime");
        }
      }),
    [kind, t],
  );
  const problems = formProblems(kind, state, secretStates, {
    name: t("hosted.nameRequired"),
    targets: t("hosted.targetRequired"),
    secretRequired: (label) => t("hosted.secretRequired", { label }),
  });
  const problemFor = (path: string) =>
    revealed
      ? problems.find((problem) => problem.path === path)?.message
      : undefined;

  const navigationDialog = useNavigationWarning({
    dirty: form.formState.isDirty,
    title: t("hosted.leaveTitle"),
    body: t("hosted.leaveBody"),
    shouldBlock: () => {
      if (departing.current) {
        departing.current = false;
        return false;
      }
      return true;
    },
  });

  const save = useMutation({
    mutationFn: (value: HostedFormState) =>
      editing
        ? client.update(
            id!,
            requestBody(kind, value, revision),
            session.csrfToken,
          )
        : client.create(requestBody(kind, value), session.csrfToken),
    onSuccess: (document) => {
      setConflict(false);
      toast.add({
        title: t(editing ? "hosted.updatedToast" : "hosted.createdToast", {
          noun: kind.noun.singular,
        }),
        type: "success",
      });
      void queryClient.invalidateQueries({
        queryKey: hostedInstancesKey(pluginId, kind.kind),
      });
      void queryClient.invalidateQueries({ queryKey: pluginsQueryKey });
      if (editing) {
        queryClient.setQueryData(
          hostedInstanceKey(pluginId, kind.kind, document.id),
          document,
        );
        loadedFor.current = null;
        return;
      }
      departing.current = true;
      void navigate(backTo);
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        REVISION_CONFLICT_CODES.includes(error.code)
      )
        setConflict(true);
    },
  });

  const reload = () => {
    setConflict(false);
    save.reset();
    loadedFor.current = null;
    void saved.refetch();
  };

  const visible = visibleAuthoringFields(fields, state.config);
  const sections = groupAuthoringFields(visible);
  const title = editing
    ? t("hosted.manageTitle", { noun: kind.noun.singular })
    : t("hosted.createTitle", { noun: kind.noun.singular });
  const fieldProps = (
    field: ContentDefinitionField,
    values: Record<string, unknown>,
    onChange: (next: Record<string, unknown>) => void,
  ) => ({
    field,
    path: field.key,
    value: values[field.key],
    values,
    fields,
    rootValues: values,
    rootFields: fields,
    onChange: (next: unknown) => onChange({ ...values, [field.key]: next }),
    readOnly: readOnly || awaitingSaved,
    csrf: session.csrfToken,
    errorFor: problemFor,
    focusPath: NO_FOCUS,
    focusNonce: 0,
  });
  const setConfig = (next: Record<string, unknown>) =>
    setValue("config", next, { shouldDirty: true });
  const setSchedule = (next: Record<string, unknown>) =>
    setValue("schedule", next, { shouldDirty: true });

  return (
    <>
      {navigationDialog}
      <PluginPage pluginId={pluginId} title={title}>
        <SecretKeyNotice />
        <form
          className="grid max-w-3xl gap-6"
          noValidate
          onSubmit={(event) => {
            void handleSubmit((value) => {
              setRevealed(true);
              if (problems.length > 0) return;
              save.mutate(value);
            })(event);
          }}
        >
          {conflict && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{t("hosted.conflictTitle")}</AlertTitle>
              <AlertDescription>
                <p>{t("hosted.conflictBody")}</p>
                <Button
                  type="button"
                  size="sm"
                  className="mt-3"
                  onClick={reload}
                >
                  {t("hosted.conflictReload")}
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {save.isError && !conflict && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
            </Alert>
          )}
          {saved.isError && (
            <Alert variant="destructive">
              <AlertDescription>
                {apiErrorMessage(saved.error)}
              </AlertDescription>
            </Alert>
          )}
          <RowIdentityEpoch value={epoch}>
            <section className="grid gap-4" aria-labelledby="hosted-general">
              <h2 id="hosted-general" className="text-base font-semibold">
                {t("hosted.general")}
              </h2>
              <FormField
                id="hosted-name"
                label={t("hosted.name")}
                maxLength={180}
                disabled={readOnly || awaitingSaved}
                error={problemFor("name")}
                {...register("name")}
              />
              <Controller
                control={control}
                name="enabled"
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <div className="grid gap-1">
                      <FieldLabel htmlFor="hosted-enabled">
                        {t("hosted.enabled")}
                      </FieldLabel>
                      <FieldDescription>
                        {t("hosted.enabledHint")}
                      </FieldDescription>
                    </div>
                    <Switch
                      id="hosted-enabled"
                      checked={field.value}
                      disabled={readOnly || awaitingSaved}
                      onCheckedChange={(checked) =>
                        field.onChange(checked === true)
                      }
                    />
                  </Field>
                )}
              />
              {kind.priority && (
                <FormField
                  id="hosted-priority"
                  label={t("hosted.priority")}
                  hint={t("hosted.priorityHint", {
                    min: kind.priority.minimum,
                    max: kind.priority.maximum,
                  })}
                  type="number"
                  min={kind.priority.minimum}
                  max={kind.priority.maximum}
                  disabled={readOnly || awaitingSaved}
                  {...register("priority", { valueAsNumber: true })}
                />
              )}
            </section>
            {sections.map((group) => (
              <section
                key={group.section}
                className="grid gap-4"
                aria-labelledby={`hosted-section-${group.section}`}
              >
                <h2
                  id={`hosted-section-${group.section}`}
                  className="text-base font-semibold"
                >
                  {t(`content:widgets.editor.sections.${group.section}`)}
                </h2>
                {group.fields.map((field) =>
                  field.control === "secret" ? (
                    <HostedSecretField
                      key={field.key}
                      field={field}
                      label={field.label}
                      description={field.description}
                      state={secretStates?.[field.key] ?? "not_set"}
                      value={state.secrets[field.key] ?? ""}
                      cleared={state.clearSecrets.includes(field.key)}
                      readOnly={readOnly || awaitingSaved}
                      error={problemFor(field.key)}
                      onValue={(value) =>
                        setValue(
                          "secrets",
                          { ...state.secrets, [field.key]: value },
                          { shouldDirty: true },
                        )
                      }
                      onClear={(cleared) =>
                        setValue(
                          "clearSecrets",
                          cleared
                            ? [...state.clearSecrets, field.key]
                            : state.clearSecrets.filter(
                                (key) => key !== field.key,
                              ),
                          { shouldDirty: true },
                        )
                      }
                    />
                  ) : (
                    <WidgetInspectorField
                      key={field.key}
                      {...fieldProps(field, state.config, setConfig)}
                    />
                  ),
                )}
              </section>
            ))}
            {kind.schedule !== "none" && (
              <section className="grid gap-4" aria-labelledby="hosted-schedule">
                <h2 id="hosted-schedule" className="text-base font-semibold">
                  {t("hosted.scheduleHeading")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t(
                    kind.schedule === "window"
                      ? "hosted.windowHint"
                      : "hosted.weeklyHint",
                  )}
                </p>
                {scheduleFieldList.map((field) => (
                  <WidgetInspectorField
                    key={field.key}
                    {...fieldProps(
                      field,
                      state.schedule as Record<string, unknown>,
                      setSchedule,
                    )}
                    errorFor={(path) => problemFor(`schedule.${path}`)}
                  />
                ))}
              </section>
            )}
            {kind.targeting === "screens" && (
              <section className="grid gap-4" aria-labelledby="hosted-targets">
                <h2 id="hosted-targets" className="text-base font-semibold">
                  {t("hosted.targets")}
                </h2>
                <TargetFields
                  idPrefix="hosted"
                  scope={state.targetScope}
                  source={targetSource}
                  error={problemFor("targets")}
                  control={control}
                  onScopeChange={(scope) => {
                    setValue("targetScope", scope, { shouldDirty: true });
                    setValue("targetIds", [], { shouldDirty: true });
                  }}
                />
              </section>
            )}
          </RowIdentityEpoch>
          <div className="flex flex-wrap gap-2">
            {!readOnly && (
              <Button
                type="submit"
                size="lg"
                disabled={save.isPending || awaitingSaved}
              >
                {t("common:actions.save")}
              </Button>
            )}
            <Link
              className={buttonVariants({ variant: "outline", size: "lg" })}
              to={backTo}
            >
              {t("common:actions.cancel")}
            </Link>
          </div>
        </form>
      </PluginPage>
    </>
  );
}
