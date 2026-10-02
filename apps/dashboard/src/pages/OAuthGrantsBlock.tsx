import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import { apiErrorMessage, useFormatLocale } from "../i18n";

export const oauthGrantsKey = ["me", "security", "grants"] as const;

/**
 * Authorization grants for this account: which loopback operators may act
 * as the user, with what scopes, and since when. Revocation takes effect
 * immediately because authorization always intersects the live grant state.
 */
export function OAuthGrantsBlock() {
  const { t } = useTranslation(["account", "common"]);
  const { status } = useAuth();
  const locale = useFormatLocale();
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: oauthGrantsKey,
    queryFn: api.listOAuthGrants,
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api.revokeOAuthGrant(id, status?.csrfToken ?? ""),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: oauthGrantsKey }),
  });

  if (grants.isLoading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" /> {t("oauth.grantsLoading")}
      </p>
    );
  const items = grants.data?.grants ?? [];
  // A failed load with no usable data owns the content area: the alert is
  // the state, not a companion to an empty list. Stale data still renders
  // alongside the alert.
  const loadFailed = grants.isError && !grants.data;
  return (
    <section aria-labelledby="oauth-grants">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 id="oauth-grants" className="text-sm font-semibold">
            {t("oauth.grantsTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("oauth.grantsDescription")}
          </p>
        </div>
      </header>
      {grants.isError && (
        <Alert variant="destructive">
          <AlertDescription role="alert">
            {t("oauth.grantsError")}
          </AlertDescription>
        </Alert>
      )}
      {items.length === 0 && !grants.isLoading && !grants.isError ? (
        <p className="text-sm text-muted-foreground">
          {t("oauth.grantsEmpty")}
        </p>
      ) : loadFailed ? null : (
        <ItemGroup>
          {items.map((grant) => (
            <Item key={grant.id}>
              <ItemContent>
                <ItemTitle>
                  {grant.client}
                  {grant.revokedAt ? ` · ${t("oauth.revoked")}` : ""}
                </ItemTitle>
                <ItemDescription>
                  {grant.scopes.join(" · ")} ·{" "}
                  {t("oauth.grantedOn", {
                    date: new Date(grant.createdAt).toLocaleDateString(locale),
                  })}
                  {grant.lastUsedAt
                    ? ` · ${t("oauth.lastUsed", { date: new Date(grant.lastUsedAt).toLocaleDateString(locale) })}`
                    : ""}
                </ItemDescription>
              </ItemContent>
              {!grant.revokedAt && (
                <ItemActions>
                  <Button
                    variant="secondary"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(grant.id)}
                  >
                    {t("oauth.revoke")}
                  </Button>
                </ItemActions>
              )}
            </Item>
          ))}
        </ItemGroup>
      )}
      {revoke.isError && (
        <Alert variant="destructive">
          <AlertDescription role="alert">
            {revoke.error instanceof ApiError
              ? apiErrorMessage(revoke.error)
              : t("oauth.revokeError")}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
