import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { apiErrorMessage, useFormatLocale } from "@/i18n";
import { useStudioSession } from "../../session";
import {
  connectionKey,
  connectionsClient,
  connectionsKey,
  type PluginConnection,
} from "./api";
import {
  CONSENT_ORDER,
  consentDraft,
  consentEnabled,
  consentWrite,
  grantedConsents,
  offersConsents,
  sameConsents,
  toggleConsent,
  type ConsentKey,
} from "./model";

const requirementKey = {
  privateNetwork: undefined,
  plainHttp: "hosted.connections.consents.requiresPrivateNetwork",
  plaintextSecret: "hosted.connections.consents.requiresPlainHttp",
} as const satisfies Record<ConsentKey, string | undefined>;

/**
 * The three network permissions of one connection. Each is its own control
 * with its own explanation, and they save through their own request, never
 * as part of the connection's general save. Giving a permission asks for
 * confirmation; removing one does not.
 */
export function ConnectionConsents({
  pluginId,
  connection,
}: {
  pluginId: string;
  connection: PluginConnection;
}) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const saved = consentDraft(connection);
  const [draft, setDraft] = useState(saved);
  const [base, setBase] = useState(connection.revision);
  if (base !== connection.revision) {
    // A newer record arrived (a save here or elsewhere): start from it.
    setBase(connection.revision);
    setDraft(saved);
  }
  const save = useMutation({
    mutationFn: () =>
      connectionsClient(pluginId).consents(
        connection.id,
        consentWrite(draft, connection.revision),
        session.csrfToken,
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(connectionKey(pluginId, connection.id), next);
      void queryClient.invalidateQueries({
        queryKey: connectionsKey(pluginId),
      });
      toast.add({
        title: t("hosted.connections.consentsSavedToast"),
        type: "success",
      });
    },
  });
  if (!offersConsents(connection)) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("hosted.connections.consents.none")}
      </p>
    );
  }
  const readOnly = !session.canManage || save.isPending;
  const submit = async () => {
    const granted = grantedConsents(saved, draft);
    if (granted.length > 0) {
      const ok = await confirm({
        title: t("hosted.connections.consents.confirmTitle"),
        body: t("hosted.connections.consents.confirmBody", {
          list: granted
            .map((key) => t(`hosted.connections.consents.${key}.label`))
            .join("; "),
        }),
        action: t("hosted.connections.consents.confirm"),
      });
      if (!ok) return;
    }
    save.mutate();
  };
  return (
    <>
      {dialog}
      <FieldSet className="grid gap-4">
        <FieldLegend>{t("hosted.connections.consents.title")}</FieldLegend>
        <FieldDescription>
          {t("hosted.connections.consents.description")}
        </FieldDescription>
        {CONSENT_ORDER.filter((key) => connection.consents[key].available).map(
          (key) => {
            const id = `consent-${key}`;
            const enabled = consentEnabled(draft, key);
            const requirement = requirementKey[key];
            const givenAt = connection.consents[key].givenAt;
            return (
              <Field orientation="horizontal" key={key}>
                <Checkbox
                  id={id}
                  checked={draft[key]}
                  disabled={readOnly || (!enabled && !draft[key])}
                  aria-describedby={`${id}-description`}
                  onCheckedChange={(on) =>
                    setDraft(toggleConsent(draft, key, on === true))
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor={id}>
                    {t(`hosted.connections.consents.${key}.label`)}
                  </FieldLabel>
                  <FieldDescription id={`${id}-description`}>
                    {t(`hosted.connections.consents.${key}.description`)}
                    {!enabled && requirement ? ` ${t(requirement)}` : ""}
                    {saved[key] && givenAt
                      ? ` ${t("hosted.connections.consents.givenAt", {
                          date: new Date(givenAt).toLocaleString(locale),
                        })}`
                      : ""}
                  </FieldDescription>
                </FieldContent>
              </Field>
            );
          },
        )}
        {save.isError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{apiErrorMessage(save.error)}</AlertDescription>
          </Alert>
        )}
        {session.canManage && (
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={readOnly || sameConsents(saved, draft)}
              onClick={() => void submit()}
            >
              {t("hosted.connections.consents.save")}
            </Button>
          </div>
        )}
      </FieldSet>
    </>
  );
}
