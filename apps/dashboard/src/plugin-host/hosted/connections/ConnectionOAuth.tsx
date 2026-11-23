import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldDescription, FieldLegend, FieldSet } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { apiErrorMessage } from "@/i18n";
import { useStudioSession } from "../../session";
import {
  connectionKey,
  connectionsClient,
  connectionsKey,
  type PluginConnection,
} from "./api";
import {
  OAuthActions,
  OAuthCallbackField,
  OAuthClientFields,
  OAuthStatus,
  OAuthUnavailable,
} from "./ConnectionOAuthParts";
import {
  oauthClientWrite,
  replacesConnectedClient,
  type OAuthClientDraft,
} from "./model";

/**
 * The provider side of an OAuth connection: the OAuth client the operator
 * registered, the exact redirect URI to register, and the Connect,
 * Reconnect, and Disconnect controls. Studio never receives a token or the
 * client secret.
 */
export function ConnectionOAuth({
  pluginId,
  connection,
}: {
  pluginId: string;
  connection: PluginConnection;
}) {
  const oauth = connection.oauth;
  const { t } = useTranslation("plugins");
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const client = connectionsClient(pluginId);
  const emptyDraft = (): OAuthClientDraft => ({
    clientId: oauth?.clientId ?? "",
    clientSecret: "",
    clearClientSecret: false,
  });
  const [draft, setDraft] = useState(emptyDraft);
  const [base, setBase] = useState(connection.revision);
  if (base !== connection.revision) {
    // A newer record arrived: start the client draft from it.
    setBase(connection.revision);
    setDraft(emptyDraft());
  }
  const refresh = (next: PluginConnection) => {
    queryClient.setQueryData(connectionKey(pluginId, next.id), next);
    void queryClient.invalidateQueries({ queryKey: connectionsKey(pluginId) });
  };
  const saveClient = useMutation({
    mutationFn: () =>
      client.update(
        connection.id,
        oauthClientWrite(connection, draft),
        session.csrfToken,
      ),
    onSuccess: (next) => {
      refresh(next);
      toast.add({
        title: t("hosted.connections.oauth.clientSavedToast"),
        type: "success",
      });
    },
  });
  const start = useMutation({
    mutationFn: () => client.startOAuth(connection.id, session.csrfToken),
    onSuccess: ({ authorizationUrl }) => {
      window.location.assign(authorizationUrl);
    },
  });
  const disconnect = useMutation({
    mutationFn: () => client.disconnectOAuth(connection.id, session.csrfToken),
    onSuccess: (next) => {
      refresh(next);
      toast.add({
        title: t("hosted.connections.oauth.disconnectedToast"),
        type: "success",
      });
    },
  });
  if (!oauth) return null;
  const readOnly = !session.canManage;
  const busy = saveClient.isPending || start.isPending || disconnect.isPending;
  const clientChanged =
    draft.clientId.trim() !== (oauth.clientId ?? "") ||
    draft.clientSecret !== "" ||
    draft.clearClientSecret;
  const submitClient = async () => {
    if (replacesConnectedClient(connection, draft)) {
      const ok = await confirm({
        title: t("hosted.connections.oauth.changeClientTitle"),
        body: t("hosted.connections.oauth.changeClientBody"),
        action: t("hosted.connections.oauth.changeClientConfirm"),
        destructive: true,
      });
      if (!ok) return;
    }
    saveClient.mutate();
  };
  const submitDisconnect = async () => {
    const ok = await confirm({
      title: t("hosted.connections.oauth.disconnectTitle", {
        name: connection.name,
      }),
      body: t("hosted.connections.oauth.disconnectBody"),
      action: t("hosted.connections.oauth.disconnect"),
      destructive: true,
    });
    if (ok) disconnect.mutate();
  };
  const error = saveClient.error ?? start.error ?? disconnect.error;
  return (
    <>
      {dialog}
      <FieldSet className="grid gap-4">
        <FieldLegend>{t("hosted.connections.oauth.title")}</FieldLegend>
        <FieldDescription>
          {t("hosted.connections.oauth.description")}
        </FieldDescription>
        <OAuthStatus oauth={oauth} />
        <OAuthCallbackField oauth={oauth} />
        <OAuthClientFields
          oauth={oauth}
          draft={draft}
          disabled={readOnly || busy}
          onDraft={setDraft}
        />
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{apiErrorMessage(error)}</AlertDescription>
          </Alert>
        )}
        <OAuthUnavailable oauth={oauth} />
        {!readOnly && (
          <OAuthActions
            oauth={oauth}
            busy={busy}
            clientChanged={clientChanged}
            connecting={start.isPending}
            onSaveClient={() => void submitClient()}
            onConnect={() => start.mutate()}
            onDisconnect={() => void submitDisconnect()}
          />
        )}
      </FieldSet>
    </>
  );
}
