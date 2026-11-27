import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError } from "../../api/errors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { RowIdentityEpoch } from "@/components/content/widget-editor/fields/rowIdentity";
import { apiErrorMessage } from "@/i18n";
import { pluginsQueryKey } from "../../plugins/pluginCatalog";
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
import {
  HostedInstanceConfig,
  HostedInstanceGeneral,
  HostedInstanceSchedule,
  HostedInstanceTargets,
} from "./HostedInstanceSections";
import { localizePluginFields } from "./localize";
import {
  formProblems,
  formStateOf,
  kindRoute,
  newFormState,
  requestBody,
  type HostedDocument,
  type HostedFormState,
  type HostedKind,
  type HostedPluginProps,
} from "./model";
import { SecretKeyNotice } from "./SecretKeyNotice";

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
  const { t } = useTranslation(["plugins", "common"]);
  const { id } = useParams();
  const kinds = manifest.instances;
  const kind = kinds.find((item) => item.path === kindPath) ?? kinds[0]!;
  const editing = Boolean(id);
  const regional = useOrganizationRegionalProfile();
  const client = hostedClient(manifest.api!.basePaths[0]!, kind.path);
  const saved = useQuery({
    queryKey: hostedInstanceKey(pluginId, kind.kind, id ?? ""),
    queryFn: () => client.get(id!),
    enabled: editing,
  });
  const title = t(editing ? "hosted.manageTitle" : "hosted.createTitle", {
    noun: kind.noun.singular,
  });
  return (
    <PluginPage pluginId={pluginId} title={title}>
      <SecretKeyNotice />
      {saved.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{apiErrorMessage(saved.error)}</AlertDescription>
        </Alert>
      )}
      {regional.ready && (!editing || saved.data) ? (
        <HostedInstanceForm
          key={JSON.stringify([pluginId, kind.kind, id])}
          pluginId={pluginId}
          manifest={manifest}
          kind={kind}
          initial={saved.data}
          timezone={regional.timezone}
          backTo={kindRoute(manifest, kind)}
          client={client}
          reload={async () => {
            const next = await saved.refetch();
            return next.isSuccess ? next.data : undefined;
          }}
        />
      ) : (
        !saved.isError && <p role="status">{t("common:status.loading")}</p>
      )}
    </PluginPage>
  );
}

function HostedInstanceForm({
  pluginId,
  manifest,
  kind,
  initial,
  timezone,
  backTo,
  client,
  reload,
}: {
  pluginId: string;
  manifest: HostedPluginProps["manifest"];
  kind: HostedKind;
  initial?: HostedDocument;
  timezone: string;
  backTo: string;
  client: ReturnType<typeof hostedClient>;
  reload: () => Promise<HostedDocument | undefined>;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const session = useStudioSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const readOnly = !session.canManage;
  const fields = useMemo(
    () => localizePluginFields(pluginId, kind.fields),
    [pluginId, kind.fields],
  );
  const form = useForm<HostedFormState>({
    defaultValues: initial
      ? formStateOf(kind, initial, timezone)
      : newFormState(kind, timezone),
  });
  const { reset, watch, handleSubmit } = form;
  const state = watch();
  const [baseline, setBaseline] = useState(initial);
  const [revealed, setRevealed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const departing = useRef(false);

  const resetDraft = (document: HostedDocument) => {
    reset(formStateOf(kind, document, timezone));
    setBaseline(document);
    setConflict(false);
    setRevealed(false);
    setEpoch((value) => value + 1);
  };
  const problems = formProblems(kind, state, baseline?.secrets, {
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
      baseline
        ? client.update(
            baseline.id,
            requestBody(kind, value, baseline.revision),
            session.csrfToken,
          )
        : client.create(requestBody(kind, value), session.csrfToken),
    onSuccess: (document) => {
      toast.add({
        title: t(baseline ? "hosted.updatedToast" : "hosted.createdToast", {
          noun: kind.noun.singular,
        }),
        type: "success",
      });
      void queryClient.invalidateQueries({
        queryKey: hostedInstancesKey(pluginId, kind.kind),
      });
      void queryClient.invalidateQueries({ queryKey: pluginsQueryKey });
      if (baseline) {
        queryClient.setQueryData(
          hostedInstanceKey(pluginId, kind.kind, document.id),
          document,
        );
        resetDraft(document);
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

  return (
    <>
      {navigationDialog}
      <form
        className="grid max-w-3xl gap-6"
        noValidate
        onSubmit={(event) => {
          void handleSubmit((value) => {
            setRevealed(true);
            if (readOnly || save.isPending || problems.length > 0) return;
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
                onClick={() => {
                  void reload().then((next) => {
                    if (next) {
                      resetDraft(next);
                      save.reset();
                    }
                  });
                }}
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
        <RowIdentityEpoch value={epoch}>
          <HostedInstanceGeneral
            kind={kind}
            form={form}
            readOnly={readOnly}
            nameError={problemFor("name")}
          />
          <HostedInstanceConfig
            pluginId={pluginId}
            manifest={manifest}
            fields={fields}
            form={form}
            state={state}
            secretStates={baseline?.secrets}
            readOnly={readOnly}
            csrf={session.csrfToken}
            problemFor={problemFor}
          />
          <HostedInstanceSchedule
            kind={kind}
            form={form}
            values={state.schedule}
            readOnly={readOnly}
            csrf={session.csrfToken}
            problemFor={problemFor}
          />
          {kind.targeting === "screens" && (
            <HostedInstanceTargets
              form={form}
              scope={state.targetScope}
              readOnly={readOnly}
              error={problemFor("targets")}
            />
          )}
        </RowIdentityEpoch>
        <div className="flex flex-wrap gap-2">
          {!readOnly && (
            <Button type="submit" size="lg" disabled={save.isPending}>
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
    </>
  );
}
