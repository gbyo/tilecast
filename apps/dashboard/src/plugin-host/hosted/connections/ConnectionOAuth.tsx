import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConfigField } from "@tilecast/config-schema";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { apiErrorMessage, useFormatLocale } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { useStudioSession } from "../../session";
import { HostedSecretField } from "../HostedSecretField";
import type { SecretState } from "../model";
import {
  connectionKey,
  connectionsClient,
  connectionsKey,
  type PluginConnection,
  type PluginConnectionOAuth,
} from "./api";
import {
  oauthClientWrite,
  replacesConnectedClient,
  type OAuthClientDraft,
} from "./model";

const statusKey = {
  not_connected: "hosted.connections.oauth.status.not_connected",
  connected: "hosted.connections.oauth.status.connected",
  reconnect_required: "hosted.connections.oauth.status.reconnect_required",
} as const satisfies Record<PluginConnectionOAuth["status"], string>;

const blockerKey = {
  public_url_https_required:
    "hosted.connections.oauth.unavailable.public_url_https_required",
  client_id_required: "hosted.connections.oauth.unavailable.client_id_required",
  client_secret_required:
    "hosted.connections.oauth.unavailable.client_secret_required",
} as const satisfies Record<
  NonNullable<PluginConnectionOAuth["connectUnavailableReason"]>,
  string
>;

const revocationKey = {
  confirmed: "hosted.connections.oauth.revocation.confirmed",
  failed: "hosted.connections.oauth.revocation.failed",
  not_declared: "hosted.connections.oauth.revocation.not_declared",
} as const satisfies Record<
  NonNullable<PluginConnectionOAuth["revocation"]>,
  string
>;

const refreshErrorKey = {
  invalid_grant: "hosted.connections.oauth.refreshError.invalid_grant",
  token_rejected: "hosted.connections.oauth.refreshError.token_rejected",
  token_endpoint_unavailable:
    "hosted.connections.oauth.refreshError.token_endpoint_unavailable",
  invalid_token_response:
    "hosted.connections.oauth.refreshError.invalid_token_response",
  client_secret_unavailable:
    "hosted.connections.oauth.refreshError.client_secret_unavailable",
} as const;

function refreshErrorText(
  code: string,
  t: ReturnType<typeof useTranslation<"plugins">>["t"],
): string {
  return code in refreshErrorKey
    ? t(refreshErrorKey[code as keyof typeof refreshErrorKey])
    : t("hosted.connections.oauth.refreshError.other");
}

const secretField: ConfigField = {
  key: "oauthClientSecret",
  label: "",
  control: "secret",
  maxLength: 4096,
};

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
  const locale = useFormatLocale();
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
  const date = (value: string) => new Date(value).toLocaleString(locale);
  const secretState: SecretState =
    oauth.clientSecret === "not_required" ? "not_set" : oauth.clientSecret;
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
  const connected = oauth.status === "connected";
  const error = saveClient.error ?? start.error ?? disconnect.error;
  return (
    <>
      {dialog}
      <FieldSet className="grid gap-4">
        <FieldLegend>{t("hosted.connections.oauth.title")}</FieldLegend>
        <FieldDescription>
          {t("hosted.connections.oauth.description")}
        </FieldDescription>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={connected ? "default" : "secondary"}>
            {t(statusKey[oauth.status])}
          </Badge>
          {connected && oauth.connectedAt && (
            <span className="text-sm text-muted-foreground">
              {t("hosted.connections.oauth.connectedAt", {
                date: date(oauth.connectedAt),
              })}
            </span>
          )}
          {connected && oauth.refreshedAt && (
            <span className="text-sm text-muted-foreground">
              {t("hosted.connections.oauth.refreshedAt", {
                date: date(oauth.refreshedAt),
              })}
            </span>
          )}
        </div>
        {oauth.lastError && oauth.lastErrorAt && (
          <Alert
            variant={
              oauth.status === "reconnect_required" ? "destructive" : "default"
            }
          >
            <AlertDescription>
              {t("hosted.connections.oauth.lastError", {
                date: date(oauth.lastErrorAt),
              })}{" "}
              {refreshErrorText(oauth.lastError, t)}
            </AlertDescription>
          </Alert>
        )}
        {oauth.revocation && !connected && (
          <Alert
            variant={oauth.revocation === "failed" ? "destructive" : "default"}
          >
            <AlertDescription>
              {t(revocationKey[oauth.revocation])}
            </AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="oauth-scopes">
            {t("hosted.connections.oauth.scopes")}
          </FieldLabel>
          <p id="oauth-scopes" className="font-mono text-sm break-all">
            {oauth.scopes.join(" ")}
          </p>
        </Field>
        <Field>
          <FieldLabel htmlFor="oauth-callback">
            {t("hosted.connections.oauth.callbackUrl")}
          </FieldLabel>
          <FieldDescription id="oauth-callback-description">
            {oauth.callbackUrl
              ? t("hosted.connections.oauth.callbackUrlHint")
              : t(blockerKey.public_url_https_required)}
          </FieldDescription>
          {oauth.callbackUrl && (
            <div className="flex gap-2">
              <Input
                id="oauth-callback"
                readOnly
                value={oauth.callbackUrl}
                className="font-mono"
                aria-describedby="oauth-callback-description"
              />
              <Button
                type="button"
                variant="outline"
                aria-label={t("hosted.connections.oauth.copy")}
                onClick={() =>
                  void copyText(oauth.callbackUrl!, {
                    success: t("hosted.connections.oauth.copied"),
                    failure: t("hosted.connections.oauth.copyFailed"),
                  })
                }
              >
                <Copy aria-hidden="true" />
              </Button>
            </div>
          )}
        </Field>
        <Field>
          <FieldLabel htmlFor="oauth-client-id">
            {t("hosted.connections.oauth.clientId")}
          </FieldLabel>
          <FieldDescription id="oauth-client-id-description">
            {t("hosted.connections.oauth.clientIdHint")}
          </FieldDescription>
          <Input
            id="oauth-client-id"
            value={draft.clientId}
            maxLength={256}
            spellCheck={false}
            autoComplete="off"
            disabled={readOnly || busy}
            aria-describedby="oauth-client-id-description"
            onChange={(event) =>
              setDraft({ ...draft, clientId: event.target.value })
            }
          />
        </Field>
        {oauth.clientSecretRequired && (
          <HostedSecretField
            field={secretField}
            label={t("hosted.connections.oauth.clientSecret")}
            description={t("hosted.connections.oauth.clientSecretHint")}
            state={secretState}
            value={draft.clientSecret}
            cleared={draft.clearClientSecret}
            readOnly={readOnly || busy}
            onValue={(value) =>
              setDraft({
                ...draft,
                clientSecret: value,
                clearClientSecret: false,
              })
            }
            onClear={(cleared) =>
              setDraft({
                ...draft,
                clientSecret: "",
                clearClientSecret: cleared,
              })
            }
          />
        )}
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{apiErrorMessage(error)}</AlertDescription>
          </Alert>
        )}
        {!oauth.connectAvailable && oauth.connectUnavailableReason && (
          <p className="text-sm text-muted-foreground" role="status">
            {t(blockerKey[oauth.connectUnavailableReason])}
          </p>
        )}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy || !clientChanged}
              onClick={() => void submitClient()}
            >
              {t("hosted.connections.oauth.saveClient")}
            </Button>
            <Button
              type="button"
              disabled={busy || clientChanged || !oauth.connectAvailable}
              onClick={() => start.mutate()}
            >
              {start.isPending
                ? t("hosted.connections.oauth.connecting")
                : oauth.status === "not_connected"
                  ? t("hosted.connections.oauth.connect")
                  : t("hosted.connections.oauth.reconnect")}
            </Button>
            {oauth.status !== "not_connected" && (
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => void submitDisconnect()}
              >
                {t("hosted.connections.oauth.disconnect")}
              </Button>
            )}
          </div>
        )}
      </FieldSet>
    </>
  );
}
