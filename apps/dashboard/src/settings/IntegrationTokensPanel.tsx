import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { IntegrationScope, IntegrationToken } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";
import type { TFunction } from "i18next";
import { useConfirm } from "../components/ConfirmDialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import { Checkbox as RheaCheckbox } from "../components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";

type ScopeTitleKey =
  "integrations.scopes.write.title" | "integrations.scopes.read.title";
type ScopeDescriptionKey =
  | "integrations.scopes.write.description"
  | "integrations.scopes.read.description";

// Scope metadata holds translation keys, never rendered text. Labels are
// resolved with t() at render so the panel follows language changes.
const scopeTitles: Record<IntegrationScope, ScopeTitleKey> = {
  "data_source:write": "integrations.scopes.write.title",
  "activity:read": "integrations.scopes.read.title",
};
const scopeDescriptions: Record<IntegrationScope, ScopeDescriptionKey> = {
  "data_source:write": "integrations.scopes.write.description",
  "activity:read": "integrations.scopes.read.description",
};
const allScopes = Object.keys(scopeTitles) as IntegrationScope[];

// An expiry is a date an operator picks, not an instant. It is read as the end of
// that day in their own time, so a token chosen to expire today still works for
// the rest of today.
// The date input speaks YYYY-MM-DD, built from local calendar parts so the
// earliest choice is today where the operator is, not wherever UTC has got to.
function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function endOfDay(date: string): string | undefined {
  if (!date) return undefined;
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day, 23, 59, 59, 999).toISOString();
}

// Revoked, expired, and active are three different answers, and an operator
// chasing a system that stopped working has to be able to tell which one it is.
// A revoked token reads as revoked even after its expiry passes: that is the
// decision somebody made.
type TokenStatusKey =
  | "integrations.status.revoked"
  | "integrations.status.expired"
  | "integrations.status.active";

function status(token: IntegrationToken): TokenStatusKey {
  if (token.revokedAt) return "integrations.status.revoked";
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now())
    return "integrations.status.expired";
  return "integrations.status.active";
}

function expiryNote(
  token: IntegrationToken,
  t: TFunction<["settings", "common"]>,
  locale: string,
): string | undefined {
  if (!token.expiresAt) return undefined;
  return t("integrations.expiry", {
    date: new Date(token.expiresAt).toLocaleDateString(locale),
  });
}

export function IntegrationTokensPanel({ owner }: { owner: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";

  const tokens = useQuery({
    queryKey: ["integration-tokens"],
    queryFn: api.integrationTokens,
    enabled: owner,
  });
  const sources = useQuery({
    queryKey: ["data-sources", "manual"],
    queryFn: () =>
      api.listDataSources(
        new URLSearchParams({
          provider: "manual",
          page: "1",
          pageSize: "100",
        }),
      ),
    enabled: owner,
  });

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<IntegrationScope[]>([
    "data_source:write",
  ]);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [expiresOn, setExpiresOn] = useState("");
  const [secret, setSecret] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const refresh = () =>
    client.invalidateQueries({ queryKey: ["integration-tokens"] });

  const create = useMutation({
    mutationFn: () =>
      api.createIntegrationToken(
        {
          name: name.trim(),
          scopes,
          dataSourceIds: scopes.includes("data_source:write")
            ? sourceIds
            : undefined,
          expiresAt: endOfDay(expiresOn),
        },
        csrf,
      ),
    onSuccess: (data) => {
      toast.add({ title: "Integration token created.", type: "success" });
      setSecret(data.secret);
      setNotice(data.notice);
      setName("");
      setSourceIds([]);
      setExpiresOn("");
      void refresh();
    },
  });
  const { confirm, dialog: confirmDialog } = useConfirm();
  const revoke = useMutation({
    mutationFn: async (token: IntegrationToken) => {
      const ok = await confirm({
        title: t("integrations.revokeTitle", { name: token.name }),
        body: t("integrations.revokeBody"),
        action: t("integrations.revokeAction"),
        destructive: true,
      });
      if (!ok) throw new CancelledAction();
      return api.revokeIntegrationToken(token.id, csrf);
    },
    onSuccess: () => {
      toast.add({ title: "Integration token revoked.", type: "success" });
      return refresh();
    },
  });

  if (!owner)
    return (
      <Alert role="status">
        <AlertDescription>{t("integrations.ownerOnly")}</AlertDescription>
      </Alert>
    );

  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("integrations.title")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("integrations.description")}
            </p>
          </header>

          {secret && (
            <Alert role="status">
              <AlertDescription className="grid gap-2">
                <span>
                  <Trans
                    i18nKey="integrations.secretNotice"
                    ns="settings"
                    components={{ strong: <strong /> }}
                  />
                </span>
                <pre className="overflow-x-auto rounded-xl border border-border bg-muted p-3 font-mono text-xs break-all">
                  {secret}
                </pre>
                {notice}
                <div>
                  <RheaButton
                    variant="ghost"
                    onClick={() => {
                      setSecret(undefined);
                      setNotice(undefined);
                    }}
                  >
                    {t("integrations.copied")}
                  </RheaButton>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {tokens.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              {t("integrations.loading")}
            </p>
          ) : !tokens.data?.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("integrations.empty")}</EmptyTitle>
                <EmptyDescription>
                  {t("integrations.emptyHint")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {tokens.data.map((token) => (
                <article
                  className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4"
                  key={token.id}
                >
                  <div className="grid min-w-0 flex-1 gap-1">
                    <strong className="text-sm font-semibold">
                      {token.name}
                    </strong>
                    <span className="text-sm text-muted-foreground">
                      {token.scopes
                        .map((scope) => t(scopeTitles[scope]))
                        .join(" · ")}
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <Badge
                        variant={
                          status(token) === "integrations.status.active"
                            ? "default"
                            : "secondary"
                        }
                      >
                        {t(status(token))}
                      </Badge>
                      {" · "}
                      {token.lastUsedAt
                        ? t("integrations.lastUsed", {
                            date: new Date(token.lastUsedAt).toLocaleString(
                              locale,
                            ),
                          })
                        : t("integrations.neverUsed")}
                      {expiryNote(token, t, locale)
                        ? ` · ${expiryNote(token, t, locale)}`
                        : ""}
                      {token.dataSourceIds.length > 0
                        ? ` · ${t("integrations.limited", { count: token.dataSourceIds.length })}`
                        : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!token.revokedAt && (
                      <RheaButton
                        variant="destructive"
                        onClick={() => revoke.mutate(token)}
                        aria-label={t("integrations.revokeToken", {
                          name: token.name,
                        })}
                      >
                        <Trash2 size={15} aria-hidden="true" />{" "}
                        {t("integrations.revoke")}
                      </RheaButton>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {revoke.error && !(revoke.error instanceof CancelledAction) && (
            <Alert variant="destructive">
              <AlertDescription>{revoke.error.message}</AlertDescription>
            </Alert>
          )}
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("integrations.createTitle")}
            </h3>
          </header>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setSecret(undefined);
              create.mutate();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid content-start gap-1">
                <label htmlFor="token-name" className="text-sm font-medium">
                  {t("integrations.nameLabel")}
                </label>
                <p className="text-sm text-muted-foreground">
                  {t("integrations.nameHint")}
                </p>
              </div>
              <div className="grid content-start gap-2">
                <Input
                  id="token-name"
                  value={name}
                  required
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid content-start gap-1">
                <label className="text-sm font-medium">
                  {t("integrations.capabilities")}
                </label>
              </div>
              <div className="grid content-start gap-2">
                {allScopes.map((scope) => (
                  <label
                    key={scope}
                    className="flex cursor-pointer items-start gap-2 text-sm"
                  >
                    <RheaCheckbox
                      checked={scopes.includes(scope)}
                      onCheckedChange={(checked) =>
                        setScopes(
                          checked === true
                            ? [...scopes, scope]
                            : scopes.filter((item) => item !== scope),
                        )
                      }
                    />
                    <span className="grid gap-0.5">
                      {t(scopeTitles[scope])}
                      <small className="text-xs text-muted-foreground">
                        {t(scopeDescriptions[scope])}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid content-start gap-1">
                <label htmlFor="token-expires" className="text-sm font-medium">
                  {t("integrations.expiresLabel")}
                </label>
                <p className="text-sm text-muted-foreground">
                  {t("integrations.expiresHint")}
                </p>
              </div>
              <div className="grid content-start gap-2">
                <Input
                  id="token-expires"
                  type="date"
                  value={expiresOn}
                  // Today is the earliest useful choice: it expires tonight. The
                  // server refuses anything already past regardless.
                  min={localDate(new Date())}
                  onChange={(event) => setExpiresOn(event.target.value)}
                />
              </div>
            </div>

            {scopes.includes("data_source:write") && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid content-start gap-1">
                  <label className="text-sm font-medium">
                    {t("integrations.limitLabel")}
                  </label>
                  <p className="text-sm text-muted-foreground">
                    {t("integrations.limitHint")}
                  </p>
                </div>
                <div className="grid content-start gap-2">
                  {sources.isLoading ? (
                    <span className="text-xs text-muted-foreground">
                      {t("integrations.loadingSources")}
                    </span>
                  ) : !sources.data?.items?.length ? (
                    <span className="text-xs text-muted-foreground">
                      {t("integrations.noSources")}
                    </span>
                  ) : (
                    sources.data.items.map((source) => (
                      <label
                        key={source.id}
                        className="flex cursor-pointer items-center gap-2 text-sm"
                      >
                        <RheaCheckbox
                          checked={sourceIds.includes(source.id)}
                          onCheckedChange={(checked) =>
                            setSourceIds(
                              checked === true
                                ? [...sourceIds, source.id]
                                : sourceIds.filter((id) => id !== source.id),
                            )
                          }
                        />
                        <span>{source.name}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            )}

            {create.error && (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <RheaButton
                variant="default"
                type="submit"
                disabled={create.isPending || scopes.length === 0}
              >
                {create.isPending
                  ? t("integrations.creating")
                  : t("integrations.createAction")}
              </RheaButton>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}

class CancelledAction extends Error {}
