import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConfigField } from "@tilecast/config-schema";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useFormatLocale } from "@/i18n";
import { copyText } from "@/lib/clipboard";
import { HostedSecretField } from "../HostedSecretField";
import type { SecretState } from "../model";
import type { PluginConnectionOAuth } from "./api";
import type { OAuthClientDraft } from "./model";

// The presentational parts of the OAuth section of a connection page.

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

/** The connection's OAuth status, last refresh failure, and last revocation. */
export function OAuthStatus({ oauth }: { oauth: PluginConnectionOAuth }) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const date = (value: string) => new Date(value).toLocaleString(locale);
  const connected = oauth.status === "connected";
  return (
    <>
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
    </>
  );
}

/** The requested scopes and the exact redirect URI to register. */
export function OAuthCallbackField({
  oauth,
}: {
  oauth: PluginConnectionOAuth;
}) {
  const { t } = useTranslation("plugins");
  return (
    <>
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
    </>
  );
}

/** The client ID and the write-only client secret. */
export function OAuthClientFields({
  oauth,
  draft,
  disabled,
  onDraft,
}: {
  oauth: PluginConnectionOAuth;
  draft: OAuthClientDraft;
  disabled: boolean;
  onDraft: (draft: OAuthClientDraft) => void;
}) {
  const { t } = useTranslation("plugins");
  const secretState: SecretState =
    oauth.clientSecret === "not_required" ? "not_set" : oauth.clientSecret;
  return (
    <>
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
          disabled={disabled}
          aria-describedby="oauth-client-id-description"
          onChange={(event) =>
            onDraft({ ...draft, clientId: event.target.value })
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
          readOnly={disabled}
          onValue={(value) =>
            onDraft({
              ...draft,
              clientSecret: value,
              clearClientSecret: false,
            })
          }
          onClear={(cleared) =>
            onDraft({
              ...draft,
              clientSecret: "",
              clearClientSecret: cleared,
            })
          }
        />
      )}
    </>
  );
}

/** Why Connect is not available, when it is not. */
export function OAuthUnavailable({ oauth }: { oauth: PluginConnectionOAuth }) {
  const { t } = useTranslation("plugins");
  if (oauth.connectAvailable || !oauth.connectUnavailableReason) return null;
  return (
    <p className="text-sm text-muted-foreground" role="status">
      {t(blockerKey[oauth.connectUnavailableReason])}
    </p>
  );
}

/** Save client, Connect or Reconnect, and Disconnect. */
export function OAuthActions({
  oauth,
  busy,
  clientChanged,
  connecting,
  onSaveClient,
  onConnect,
  onDisconnect,
}: {
  oauth: PluginConnectionOAuth;
  busy: boolean;
  clientChanged: boolean;
  connecting: boolean;
  onSaveClient: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useTranslation("plugins");
  const connectLabel = connecting
    ? t("hosted.connections.oauth.connecting")
    : oauth.status === "not_connected"
      ? t("hosted.connections.oauth.connect")
      : t("hosted.connections.oauth.reconnect");
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={busy || !clientChanged}
        onClick={onSaveClient}
      >
        {t("hosted.connections.oauth.saveClient")}
      </Button>
      <Button
        type="button"
        disabled={busy || clientChanged || !oauth.connectAvailable}
        onClick={onConnect}
      >
        {connectLabel}
      </Button>
      {oauth.status !== "not_connected" && (
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={onDisconnect}
        >
          {t("hosted.connections.oauth.disconnect")}
        </Button>
      )}
    </div>
  );
}
