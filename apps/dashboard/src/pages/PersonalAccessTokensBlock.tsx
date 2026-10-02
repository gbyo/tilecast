import { useDeferredValue, useState } from "react";
import { copyText } from "../lib/clipboard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import type { PersonalAccessTokenCreated } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Spinner } from "../components/ui/spinner";
import { useFormatLocale } from "../i18n";

export const personalAccessTokensKey = ["me", "security", "pats"] as const;

const SCOPES = ["read", "write", "admin"] as const;
const LIFETIMES = [7, 30, 90, 365] as const;

/**
 * Personal access tokens for this account: named, expiring bearer secrets
 * for scripts and CI. Creation returns the secret exactly once on a
 * separate confirmation screen; the list below never reveals it again.
 * Revocation runs through the same grant endpoint as OAuth grants.
 */
export function PersonalAccessTokensBlock() {
  const { t } = useTranslation(["account", "common"]);
  const { status } = useAuth();
  const locale = useFormatLocale();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<("read" | "write" | "admin")[]>([
    "read",
  ]);
  const [lifetime, setLifetime] = useState<7 | 30 | 90 | 365>(30);
  const [created, setCreated] = useState<PersonalAccessTokenCreated | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const tokens = useQuery({
    queryKey: [...personalAccessTokensKey, deferredSearch],
    queryFn: () => api.listPersonalAccessTokens(deferredSearch.trim()),
  });
  const create = useMutation({
    mutationFn: () =>
      api.createPersonalAccessToken(
        { name: name.trim(), scopes, expiresInDays: lifetime },
        status?.csrfToken ?? "",
      ),
    onSuccess: (result) => {
      setCreated(result);
      setCopied(false);
      void queryClient.invalidateQueries({ queryKey: personalAccessTokensKey });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api.revokeOAuthGrant(id, status?.csrfToken ?? ""),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: personalAccessTokensKey });
    },
  });

  const toggleScope = (scope: "read" | "write" | "admin") =>
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((entry) => entry !== scope)
        : [...current, scope],
    );

  const copyToken = async () => {
    if (!created) return;
    const label = t("pat.tokenLabel");
    setCopied(
      await copyText(created.token, {
        success: t("common:clipboard.copied", { label }),
        failure: t("common:clipboard.copyFailed", { label }),
      }),
    );
  };

  if (created) {
    return (
      <section aria-labelledby="pat-created">
        <div className="grid gap-0.5">
          <h3 id="pat-created" className="text-sm font-semibold">
            {t("pat.createdTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("pat.createdWarning")}
          </p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            readOnly
            value={created.token}
            aria-label={t("pat.tokenLabel")}
            className="font-mono"
            onFocus={(event) => event.target.select()}
          />
          <Button variant="secondary" onClick={() => void copyToken()}>
            {copied ? t("pat.copied") : t("pat.copy")}
          </Button>
          <Button
            onClick={() => {
              setCreated(null);
              setName("");
            }}
          >
            {t("pat.done")}
          </Button>
        </div>
      </section>
    );
  }

  const items = tokens.data?.pats ?? [];
  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString(locale);
  const expiryLabel = (expiresAt: string) => {
    const remaining = Math.ceil(
      (new Date(expiresAt).getTime() - Date.now()) / 86_400_000,
    );
    if (remaining < 0) return t("pat.expired");
    return t("pat.expiresIn", {
      date: formatDate(expiresAt),
      count: remaining,
    });
  };

  return (
    <section aria-labelledby="personal-access-tokens">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 id="personal-access-tokens" className="text-sm font-semibold">
            {t("pat.title")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("pat.description")}
          </p>
        </div>
      </header>

      <form
        className="mt-3 grid max-w-xl gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && scopes.length > 0) create.mutate();
        }}
      >
        <Field>
          <FieldLabel htmlFor="pat-name">{t("pat.nameLabel")}</FieldLabel>
          <Input
            id="pat-name"
            value={name}
            maxLength={100}
            placeholder={t("pat.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <fieldset>
          <legend className="text-sm font-medium">
            {t("pat.scopesLabel")}
          </legend>
          <div className="mt-1 flex flex-wrap gap-4">
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={scopes.includes(scope)}
                  onCheckedChange={() => toggleScope(scope)}
                />
                {t(`pat.scope.${scope}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">
            {t("pat.lifetimeLabel")}
          </legend>
          <div className="mt-1 flex flex-wrap gap-2">
            {LIFETIMES.map((days) => (
              <Button
                key={days}
                type="button"
                variant={lifetime === days ? "default" : "secondary"}
                onClick={() => setLifetime(days)}
              >
                {t("pat.lifetimeDays", { count: days })}
              </Button>
            ))}
          </div>
        </fieldset>
        <div>
          <Button
            type="submit"
            disabled={create.isPending || !name.trim() || scopes.length === 0}
          >
            {create.isPending ? t("pat.creating") : t("pat.create")}
          </Button>
        </div>
      </form>
      {create.isError && (
        <Alert variant="destructive" className="mt-3 max-w-xl">
          <AlertDescription role="alert">
            {create.error instanceof ApiError
              ? create.error.message
              : t("pat.createError")}
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-4 max-w-xl">
        <Input
          value={search}
          placeholder={t("pat.searchPlaceholder")}
          aria-label={t("pat.searchPlaceholder")}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {tokens.isLoading ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" /> {t("pat.loading")}
        </p>
      ) : tokens.isError ? (
        <Alert variant="destructive" className="mt-3 max-w-xl">
          <AlertDescription role="alert">{t("pat.error")}</AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t("pat.empty")}</p>
      ) : (
        <ItemGroup className="mt-3 max-w-xl">
          {items.map((pat) => (
            <Item key={pat.id}>
              <ItemContent>
                <ItemTitle>
                  {pat.name}
                  {pat.revokedAt
                    ? ` · ${t("pat.revoked")}`
                    : !pat.revokedAt &&
                        new Date(pat.expiresAt).getTime() < Date.now()
                      ? ` · ${t("pat.expired")}`
                      : ""}
                </ItemTitle>
                <ItemDescription>
                  {pat.scopes.join(" · ")} ·{" "}
                  {t("pat.createdOn", { date: formatDate(pat.createdAt) })} ·{" "}
                  {expiryLabel(pat.expiresAt)}
                  {pat.lastUsedAt
                    ? ` · ${t("pat.lastUsed", { date: formatDate(pat.lastUsedAt) })}`
                    : ""}
                </ItemDescription>
              </ItemContent>
              {!pat.revokedAt && (
                <ItemActions>
                  <Button
                    variant="secondary"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(pat.id)}
                  >
                    {t("pat.revoke")}
                  </Button>
                </ItemActions>
              )}
            </Item>
          ))}
        </ItemGroup>
      )}
      {revoke.isError && (
        <Alert variant="destructive" className="mt-3 max-w-xl">
          <AlertDescription role="alert">
            {revoke.error instanceof ApiError
              ? revoke.error.message
              : t("pat.revokeError")}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}
