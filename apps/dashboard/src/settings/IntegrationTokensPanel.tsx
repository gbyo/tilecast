import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { IntegrationScope, IntegrationToken } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
import { DateInput } from "../components/date-picker";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLegend,
  FieldLabel,
  FieldSet,
} from "../components/ui/field";
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
import { toast } from "../components/ui/toast";

const scopeLabels: Record<IntegrationScope, string> = {
  "data_source:write": "Write Manual Table rows",
  "activity:read": "Read fleet health",
};
const scopeDescriptions: Record<IntegrationScope, string> = {
  "data_source:write": "Replace rows in selected Manual Table Data Sources.",
  "activity:read":
    "Read counts of screens by reporting state, unresolved incidents, and content problems, as JSON or Prometheus metrics.",
};
const allScopes = Object.keys(scopeLabels) as IntegrationScope[];

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
function status(token: IntegrationToken): "Revoked" | "Expired" | "Active" {
  if (token.revokedAt) return "Revoked";
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now())
    return "Expired";
  return "Active";
}

function expiryNote(token: IntegrationToken): string | undefined {
  if (!token.expiresAt) return undefined;
  return `Expiry ${new Date(token.expiresAt).toLocaleDateString()}`;
}

export function IntegrationTokensPanel({ owner }: { owner: boolean }) {
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
        title: `Revoke "${token.name}"?`,
        body: "Anything using it stops working immediately, and a revoked token cannot be re-enabled.",
        action: "Revoke",
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
        <AlertDescription>
          Only the Owner may manage integration tokens.
        </AlertDescription>
      </Alert>
    );

  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">Integration tokens</h3>
            <p className="text-sm text-muted-foreground">
              Grant selected integrations without sharing a Studio password.
            </p>
          </header>

          {secret && (
            <Alert role="status">
              <AlertDescription className="grid gap-2">
                <span>
                  <strong>Copy this token now.</strong> Shown once.
                </span>
                <pre className="overflow-x-auto rounded-xl border border-border bg-muted p-3 font-mono text-xs break-all">
                  {secret}
                </pre>
                {notice}
                <div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setSecret(undefined);
                      setNotice(undefined);
                    }}
                  >
                    I have copied it
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {tokens.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              Loading tokens…
            </p>
          ) : !tokens.data?.length ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No tokens</EmptyTitle>
                <EmptyDescription>
                  No integration tokens exist.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup className="gap-2">
              {tokens.data.map((token) => (
                <Item key={token.id} variant="outline">
                  <ItemContent>
                    <ItemTitle>{token.name}</ItemTitle>
                    <ItemDescription>
                      {token.scopes
                        .map((scope) => scopeLabels[scope])
                        .join(" · ")}
                    </ItemDescription>
                    <ItemDescription className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          status(token) === "Active" ? "default" : "secondary"
                        }
                      >
                        {status(token)}
                      </Badge>
                      {" · "}
                      {token.lastUsedAt
                        ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                        : "Never used"}
                      {expiryNote(token) ? ` · ${expiryNote(token)}` : ""}
                      {token.dataSourceIds.length > 0
                        ? ` · Limited to ${token.dataSourceIds.length} Data Source${token.dataSourceIds.length === 1 ? "" : "s"}`
                        : ""}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {!token.revokedAt && (
                      <Button
                        variant="destructive"
                        onClick={() => revoke.mutate(token)}
                        aria-label={`Revoke ${token.name}`}
                      >
                        <Trash2 size={15} aria-hidden="true" /> Revoke
                      </Button>
                    )}
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
          {revoke.error && !(revoke.error instanceof CancelledAction) && (
            <Alert variant="destructive">
              <AlertDescription>{revoke.error.message}</AlertDescription>
            </Alert>
          )}
        </section>

        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">Create a token</h3>
          </header>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              setSecret(undefined);
              create.mutate();
            }}
          >
            <Field className="gap-3 sm:grid sm:grid-cols-2 sm:items-start">
              <FieldContent>
                <FieldLabel htmlFor="token-name">Name</FieldLabel>
                <FieldDescription>
                  Name the system that will use it, so the delivery record and
                  the audit log say who did what.
                </FieldDescription>
              </FieldContent>
              <Input
                id="token-name"
                value={name}
                required
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>

            <FieldSet className="grid gap-2">
              <FieldLegend variant="label" className="mb-0">
                Capabilities
              </FieldLegend>
              <div className="grid content-start gap-2">
                {allScopes.map((scope) => (
                  <Field
                    key={scope}
                    orientation="horizontal"
                    className="items-start"
                  >
                    <Checkbox
                      id={"token-scope-" + scope}
                      checked={scopes.includes(scope)}
                      onCheckedChange={(checked) =>
                        setScopes(
                          checked === true
                            ? [...scopes, scope]
                            : scopes.filter((item) => item !== scope),
                        )
                      }
                    />
                    <FieldLabel
                      htmlFor={"token-scope-" + scope}
                      className="grid gap-0.5 font-normal"
                    >
                      {scopeLabels[scope]}
                      <span className="text-xs text-muted-foreground">
                        {scopeDescriptions[scope]}
                      </span>
                    </FieldLabel>
                  </Field>
                ))}
              </div>
            </FieldSet>

            <Field className="gap-3 sm:grid sm:grid-cols-2 sm:items-start">
              <FieldContent>
                <FieldLabel htmlFor="token-expires">Expires on</FieldLabel>
                <FieldDescription>
                  The token stops working at the end of this day. Leave it empty
                  for a token that never expires, and revoke it when the system
                  using it is retired.
                </FieldDescription>
              </FieldContent>
              <DateInput
                id="token-expires"
                value={expiresOn}
                // Today is the earliest useful choice: it expires tonight. The
                // server refuses anything already past regardless.
                min={localDate(new Date())}
                onChange={setExpiresOn}
              />
            </Field>

            {scopes.includes("data_source:write") && (
              <FieldSet className="grid gap-2">
                <FieldLegend variant="label" className="mb-0">
                  Limit to Data Sources
                </FieldLegend>
                <FieldDescription>
                  Select none to allow every Manual Table Data Source. Naming
                  them is the safer default.
                </FieldDescription>
                <div className="grid content-start gap-2">
                  {sources.isLoading ? (
                    <span className="text-xs text-muted-foreground">
                      Loading Data Sources…
                    </span>
                  ) : !sources.data?.items?.length ? (
                    <span className="text-xs text-muted-foreground">
                      No Manual Table Data Sources exist yet.
                    </span>
                  ) : (
                    sources.data.items.map((source) => (
                      <Field
                        key={source.id}
                        orientation="horizontal"
                        className="items-center"
                      >
                        <Checkbox
                          id={"token-source-" + source.id}
                          checked={sourceIds.includes(source.id)}
                          onCheckedChange={(checked) =>
                            setSourceIds(
                              checked === true
                                ? [...sourceIds, source.id]
                                : sourceIds.filter((id) => id !== source.id),
                            )
                          }
                        />
                        <FieldLabel
                          htmlFor={"token-source-" + source.id}
                          className="font-normal"
                        >
                          {source.name}
                        </FieldLabel>
                      </Field>
                    ))
                  )}
                </div>
              </FieldSet>
            )}

            {create.error && (
              <Alert variant="destructive">
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="default"
                type="submit"
                disabled={create.isPending || scopes.length === 0}
              >
                {create.isPending ? "Creating…" : "Create token"}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </>
  );
}

class CancelledAction extends Error {}
