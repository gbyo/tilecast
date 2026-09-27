import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { api, ApiError } from "../api/client";
import type { OAuthDecision } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";

export const oauthApprovalKey = ["oauth", "approval"] as const;

/**
 * Loopback authorization approval. The CLI opens this page with the same
 * parameters it will redeem, Studio shows exactly what access is asked
 * for, and approval returns the browser to the loopback redirect carrying
 * the single-use code. Denial returns access_denied instead.
 */
export function OAuthApprovalPage() {
  const { t } = useTranslation(["account", "common"]);
  const { status } = useAuth();
  const [params] = useSearchParams();
  const query = useMemo(() => params.toString(), [params]);
  const approval = useQuery({
    queryKey: [...oauthApprovalKey, query],
    queryFn: () => api.describeOAuthApproval(params),
  });
  const decide = useMutation({
    mutationFn: async (allow: boolean) => {
      const decision: OAuthDecision = {
        client: params.get("client_id") ?? "",
        redirectUri: params.get("redirect_uri") ?? "",
        scope: params.get("scope") ?? "",
        state: params.get("state") ?? "",
        challenge: params.get("code_challenge") ?? "",
        method: params.get("code_challenge_method") ?? "S256",
      };
      const csrfToken = status?.csrfToken ?? "";
      const result = allow
        ? await api.approveOAuth(decision, csrfToken)
        : await api.denyOAuth(decision, csrfToken);
      window.location.href = result.redirectUri;
    },
  });

  if (approval.isLoading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" /> {t("oauth.loading")}
      </p>
    );
  if (!approval.data)
    return (
      <Alert variant="destructive">
        <AlertTitle>{t("oauth.invalidTitle")}</AlertTitle>
        <AlertDescription role="alert">
          {approval.error instanceof ApiError
            ? approval.error.message
            : t("oauth.invalidDescription")}
        </AlertDescription>
      </Alert>
    );
  const data = approval.data;
  return (
    <div className="grid max-w-2xl gap-6">
      <header className="grid gap-1">
        <h2 className="text-lg font-semibold">{t("oauth.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("oauth.intro", { client: data.client.name })}
        </p>
      </header>
      <ItemGroup>
        {data.scopes.map((scope) => (
          <Item key={scope.scope}>
            <ItemContent>
              <ItemTitle>{scope.scope}</ItemTitle>
              <ItemDescription>{scope.description}</ItemDescription>
            </ItemContent>
          </Item>
        ))}
        <Item>
          <ItemContent>
            <ItemTitle>{t("oauth.redirectTitle")}</ItemTitle>
            <ItemDescription>{data.redirectUri}</ItemDescription>
          </ItemContent>
        </Item>
      </ItemGroup>
      {decide.isError && (
        <Alert variant="destructive">
          <AlertDescription role="alert">
            {decide.error instanceof ApiError
              ? decide.error.message
              : t("oauth.decisionError")}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex gap-3">
        <Button onClick={() => decide.mutate(true)} disabled={decide.isPending}>
          {decide.isPending ? <Spinner aria-hidden="true" /> : null}
          {t("oauth.approve")}
        </Button>
        <Button
          variant="secondary"
          onClick={() => decide.mutate(false)}
          disabled={decide.isPending}
        >
          {t("oauth.deny")}
        </Button>
      </div>
    </div>
  );
}
