import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiError } from "@/api/client";
import { useStudioSession } from "../../session";
import { connectionKey, connectionsClient, connectionsKey } from "./api";
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
 * fragment. The page reads it once, takes it out of the address so a
 * reload or a copied link cannot send it again, posts it once with the
 * session's CSRF token (the query key is the single-use state), and shows
 * the result.
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
  const queryClient = useQueryClient();
  const [callback] = useState(() => parseOAuthFragment(location.hash));
  const complete = useQuery({
    queryKey: [
      "plugin-connection-oauth-complete",
      pluginId,
      connectionId,
      callback?.state,
    ],
    enabled: callback !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      // The state is single use: remove it from the address first.
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
      const next = await connectionsClient(pluginId).completeOAuth(
        connectionId,
        callback!,
        session.csrfToken,
      );
      queryClient.setQueryData(connectionKey(pluginId, next.id), next);
      void queryClient.invalidateQueries({
        queryKey: connectionsKey(pluginId),
      });
      return next;
    },
  });
  if (callback === null) return null;
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
