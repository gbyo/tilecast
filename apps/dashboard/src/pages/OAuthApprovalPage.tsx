import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bot,
  Check,
  Eye,
  KeyRound,
  Link2,
  PencilLine,
  ShieldAlert,
  Smartphone,
  SquareTerminal,
  X,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { api, ApiError } from "../api/client";
import type { OAuthDecision } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { apiErrorMessage } from "../i18n";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "../components/ui/card";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";

export const oauthApprovalKey = ["oauth", "approval"] as const;

function OAuthClientIcon({ clientId }: { clientId: string }) {
  const Icon =
    clientId === "tilecast-cli"
      ? SquareTerminal
      : clientId === "tilecast-mcp"
        ? Bot
        : clientId === "tilecast-ios"
          ? Smartphone
          : KeyRound;

  return <Icon className="size-6" aria-hidden="true" />;
}

function OAuthScopeIcon({ scope }: { scope: string }) {
  const Icon =
    scope === "read"
      ? Eye
      : scope === "write"
        ? PencilLine
        : scope === "admin"
          ? ShieldAlert
          : KeyRound;

  return <Icon aria-hidden="true" />;
}

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
      <div className="mx-auto w-full max-w-xl py-4 sm:py-8">
        <Card size="sm">
          <CardContent>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Spinner aria-hidden="true" />
              <p>{t("oauth.loading")}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );

  if (!approval.data)
    return (
      <div className="mx-auto w-full max-w-xl py-4 sm:py-8">
        <Alert variant="destructive">
          <AlertTitle>{t("oauth.invalidTitle")}</AlertTitle>
          <AlertDescription role="alert">
            {approval.error instanceof ApiError
              ? apiErrorMessage(approval.error)
              : t("oauth.invalidDescription")}
          </AlertDescription>
        </Alert>
      </div>
    );

  const data = approval.data;

  return (
    <div className="mx-auto w-full max-w-xl py-4 sm:py-8">
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-start gap-4">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15">
              <OAuthClientIcon clientId={data.client.clientId} />
            </div>
            <div className="grid min-w-0 gap-1">
              <h2
                data-slot="card-title"
                className="font-heading text-xl leading-tight font-medium"
              >
                {t("oauth.title")}
              </h2>
              <CardDescription className="text-pretty">
                {t("oauth.intro", { client: data.client.name })}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="gap-5">
          <ItemGroup className="gap-2">
            {data.scopes.map((scope) => (
              <Item key={scope.scope} variant="outline">
                <ItemMedia
                  variant="icon"
                  className="size-9 rounded-md bg-muted text-muted-foreground"
                >
                  <OAuthScopeIcon scope={scope.scope} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle className="capitalize">{scope.scope}</ItemTitle>
                  <ItemDescription>{scope.description}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>

          <Item variant="muted">
            <ItemMedia
              variant="icon"
              className="size-9 rounded-md bg-background text-muted-foreground ring-1 ring-foreground/10"
            >
              <Link2 aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{t("oauth.redirectTitle")}</ItemTitle>
              <ItemDescription className="line-clamp-none break-all font-mono text-xs">
                {data.redirectUri}
              </ItemDescription>
            </ItemContent>
          </Item>

          {decide.isError && (
            <Alert variant="destructive">
              <AlertDescription role="alert">
                {decide.error instanceof ApiError
                  ? apiErrorMessage(decide.error)
                  : t("oauth.decisionError")}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter className="border-t">
          <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2">
            <Button
              variant="outline"
              onClick={() => decide.mutate(false)}
              disabled={decide.isPending}
            >
              <X aria-hidden="true" />
              {t("oauth.deny")}
            </Button>
            <Button
              onClick={() => decide.mutate(true)}
              disabled={decide.isPending}
            >
              {decide.isPending ? (
                <Spinner aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {t("oauth.approve")}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
