import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiError } from "@/api/client";
import { useStudioSession } from "../../session";
import {
  connectionKey,
  connectionsClient,
  connectionsKey,
  type OAuthCallback,
} from "./api";
import { parseOAuthFragment } from "./model";

const reasonKey = {
  invalid_state: "hosted.connections.oauth.result.reasons.invalid_state",
  provider_denied: "hosted.connections.oauth.result.reasons.provider_denied",
  invalid_response: "hosted.connections.oauth.result.reasons.invalid_response",
  connection_changed:
    "hosted.connections.oauth.result.reasons.connection_changed",
  invalid_grant: "hosted.connections.oauth.result.reasons.invalid_grant",
  token_rejected: "hosted.connections.oauth.result.reasons.token_rejected",
  token_endpoint_unavailable:
    "hosted.connections.oauth.result.reasons.token_endpoint_unavailable",
  invalid_token_response:
    "hosted.connections.oauth.result.reasons.invalid_token_response",
  client_secret_unavailable:
    "hosted.connections.oauth.result.reasons.client_secret_unavailable",
} as const;

function failureReason(error: unknown): keyof typeof reasonKey | undefined {
  if (!(error instanceof ApiError) || error.code !== "plugin_oauth_failed")
    return undefined;
  const reason = error.details?.reason;
  return typeof reason === "string" && reason in reasonKey
    ? (reason as keyof typeof reasonKey)
    : undefined;
}

/**
 * Finishes an OAuth sign-in when the provider sends the operator back. The
 * callback route returns this page with the provider's answer in the URL
 * fragment; this component posts it once with the session's CSRF token,
 * removes the fragment from the address, and shows the result.
 */
export function ConnectionOAuthReturn({
  pluginId,
  connectionId,
}: {
  pluginId: string;
  connectionId: string;
}) {
  const { t } = useTranslation("plugins");
  const session = useStudioSession();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const handled = useRef<string | null>(null);
  const complete = useMutation({
    mutationFn: (callback: OAuthCallback) =>
      connectionsClient(pluginId).completeOAuth(
        connectionId,
        callback,
        session.csrfToken,
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(connectionKey(pluginId, next.id), next);
      void queryClient.invalidateQueries({
        queryKey: connectionsKey(pluginId),
      });
    },
  });
  const { mutate } = complete;
  useEffect(() => {
    const callback = parseOAuthFragment(location.hash);
    if (!callback || handled.current === callback.state) return;
    // The state is single use: post it once, and take it out of the
    // address so a reload or a copied link cannot send it again.
    handled.current = callback.state;
    void navigate(
      { pathname: location.pathname, search: location.search },
      { replace: true },
    );
    mutate(callback);
  }, [location.hash, location.pathname, location.search, mutate, navigate]);
  if (complete.isIdle) return null;
  if (complete.isPending) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t("hosted.connections.oauth.completing")}
      </p>
    );
  }
  if (complete.isSuccess) {
    return (
      <Alert role="status">
        <AlertDescription>
          {t("hosted.connections.oauth.result.connected")}
        </AlertDescription>
      </Alert>
    );
  }
  const reason = failureReason(complete.error);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{t("hosted.connections.oauth.result.error")}</AlertTitle>
      <AlertDescription>
        {reason
          ? t(reasonKey[reason])
          : t("hosted.connections.oauth.result.reasons.unavailable")}
      </AlertDescription>
    </Alert>
  );
}
