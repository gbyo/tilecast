import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  groupAuthoringFields,
  visibleAuthoringFields,
  type ConfigField,
} from "@tilecast/config-schema";
import { normalizeConfigValues } from "@tilecast/config-schema";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ApiError } from "../../api/errors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { WidgetInspectorField } from "@/components/content/widget-editor/fields/WidgetInspectorField";
import { RowIdentityEpoch } from "@/components/content/widget-editor/fields/rowIdentity";
import { apiErrorMessage } from "@/i18n";
import { useOrganizationRegionalProfile } from "../../settings/regionalProfile";
import { PluginPage } from "../PluginPage";
import { useStudioSession } from "../session";
import {
  hostedSettingsKey,
  REVISION_CONFLICT_CODES,
  settingsClient,
  type HostedSettings,
} from "./api";
import { HostedSecretField } from "./HostedSecretField";
import { localizePluginFields } from "./localize";
import { configDefaults, type HostedPluginProps } from "./model";
import { SecretKeyNotice } from "./SecretKeyNotice";

/**
 * The generated organization settings page. Values and secrets go to core,
 * which validates, audits, and stores them; the plugin writes no settings
 * storage. Secrets are write-only here.
 */
export function HostedSettingsPage({ pluginId, manifest }: HostedPluginProps) {
  const { t } = useTranslation(["plugins", "common"]);
  const regional = useOrganizationRegionalProfile();
  const client = settingsClient(manifest.api!.basePaths[0]!);
  const saved = useQuery({
    queryKey: hostedSettingsKey(pluginId),
    queryFn: client.get,
  });
  const backTo = manifest.instances.length
    ? manifest.studio!.route
    : "/plugins";
  return (
    <PluginPage pluginId={pluginId} title={t("hosted.settings")}>
      <SecretKeyNotice />
      {saved.isError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{apiErrorMessage(saved.error)}</AlertDescription>
        </Alert>
      )}
      {saved.data && regional.ready ? (
        <HostedSettingsForm
          key={pluginId}
          pluginId={pluginId}
          manifest={manifest}
          initial={saved.data}
          timezone={regional.timezone}
          backTo={backTo}
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

function HostedSettingsForm({
  pluginId,
  manifest,
  initial,
  timezone,
  backTo,
  client,
  reload,
}: HostedPluginProps & {
  initial: HostedSettings;
  timezone: string;
  backTo: string;
  client: ReturnType<typeof settingsClient>;
  reload: () => Promise<HostedSettings | undefined>;
}) {
  const { t } = useTranslation(["plugins", "common", "content"]);
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const fields = useMemo(
    () => localizePluginFields(pluginId, manifest.settings?.organization ?? []),
    [pluginId, manifest.settings],
  );
  const valuesOf = (document: HostedSettings) => ({
    ...configDefaults(fields, timezone),
    ...document.values,
  });
  // A background refetch updates the cache. The editing baseline changes
  // only when a save succeeds or the user reloads.
  const [baseline, setBaseline] = useState(initial);
  const [values, setValues] = useState(() => valuesOf(initial));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<string[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const reset = (document: HostedSettings) => {
    setBaseline(document);
    setValues(valuesOf(document));
    setSecrets({});
    setCleared([]);
    setRevealed(false);
    setConflict(false);
    setEpoch((value) => value + 1);
  };
  const readOnly = !session.canManage;
  const clearedSecrets = new Set(cleared);
  const normalized = normalizeConfigValues(
    (fields as ConfigField[]).filter((field) => field.control !== "secret"),
    Object.fromEntries(
      Object.entries(values).filter(
        ([, value]) => value !== undefined && value !== "",
      ),
    ),
  );
  const problem = normalized.ok ? undefined : normalized;
  const save = useMutation({
    mutationFn: () =>
      client.put(
        {
          values: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
              key,
              value === "" ? null : value,
            ]),
          ),
          ...(Object.keys(secrets).length
            ? {
                secrets: Object.fromEntries(
                  Object.entries(secrets).filter(([, v]) => v !== ""),
                ),
              }
            : {}),
          ...(cleared.length ? { clearSecrets: cleared } : {}),
          expectedRevision: baseline.revision,
        },
        session.csrfToken,
      ),
    onSuccess: (next) => {
      reset(next);
      queryClient.setQueryData(hostedSettingsKey(pluginId), next);
      toast.add({ title: t("hosted.settingsSaved"), type: "success" });
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        REVISION_CONFLICT_CODES.includes(error.code)
      )
        setConflict(true);
    },
  });
  const sections = groupAuthoringFields(visibleAuthoringFields(fields, values));
  const errorFor = (path: string) =>
    revealed && problem?.path === path ? problem.problem : undefined;
  return (
    <form
      className="grid max-w-3xl gap-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setRevealed(true);
        if (!readOnly && !problem && !save.isPending) save.mutate();
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
                      reset(next);
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
        {sections.map((group) => (
          <section key={group.section} className="grid gap-4">
            <h2 className="text-base font-semibold">
              {t(`content:widgets.editor.sections.${group.section}`)}
            </h2>
            {group.fields.map((field) =>
              field.control === "secret" ? (
                <HostedSecretField
                  key={field.key}
                  field={field}
                  label={field.label}
                  description={field.description}
                  state={baseline.secrets?.[field.key] ?? "not_set"}
                  value={secrets[field.key] ?? ""}
                  cleared={clearedSecrets.has(field.key)}
                  readOnly={readOnly}
                  onValue={(value) =>
                    setSecrets({ ...secrets, [field.key]: value })
                  }
                  onClear={(on) =>
                    setCleared(
                      on
                        ? [...cleared, field.key]
                        : cleared.filter((key) => key !== field.key),
                    )
                  }
                />
              ) : (
                <WidgetInspectorField
                  key={field.key}
                  field={field}
                  path={field.key}
                  value={values[field.key]}
                  values={values}
                  fields={fields}
                  rootValues={values}
                  rootFields={fields}
                  onChange={(next) =>
                    setValues({ ...values, [field.key]: next })
                  }
                  readOnly={readOnly}
                  csrf={session.csrfToken}
                  errorFor={errorFor}
                  focusPath={null}
                  focusNonce={0}
                />
              ),
            )}
          </section>
        ))}
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
  );
}
