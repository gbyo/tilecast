import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { IntegrationScope, IntegrationToken } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";

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
  const { confirm } = useSpectrumDialogs();
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
      setSecret(data.secret);
      setNotice(data.notice);
      setName("");
      setSourceIds([]);
      setExpiresOn("");
      void refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: async (token: IntegrationToken) => {
      if (!(await confirm({
        title: `Revoke “${token.name}”?`,
        description:
          "Anything using this token stops working immediately. A revoked token cannot be re-enabled.",
        confirmLabel: "Revoke token",
        tone: "negative",
      })))
        throw new CancelledAction();
      return api.revokeIntegrationToken(token.id, csrf);
    },
    onSuccess: refresh,
  });

  if (!owner)
    return (
      <div className="notice">
        Only the Owner may manage integration tokens.
      </div>
    );

  return (
    <div className="settings-sections">
      <section className="settings-subsection">
        <header>
          <h3>Integration tokens</h3>
          <p>Grant selected integrations without sharing a Studio password.</p>
        </header>

        {secret && (
          <div className="notice" role="status">
            <strong>Copy this token now.</strong> Shown once.
            <pre className="secret-value">{secret}</pre>
            {notice}
            <div>
              <button
                className="button button--quiet"
                onClick={() => {
                  setSecret(undefined);
                  setNotice(undefined);
                }}
              >
                I have copied it
              </button>
            </div>
          </div>
        )}

        {tokens.isLoading ? (
          <div className="table-loading">Loading tokens…</div>
        ) : !tokens.data?.length ? (
          <div className="empty-card">No integration tokens exist.</div>
        ) : (
          <div className="backup-list">
            {tokens.data.map((token) => (
              <article className="backup-row" key={token.id}>
                <div className="backup-row__details">
                  <strong>{token.name}</strong>
                  <span>
                    {token.scopes
                      .map((scope) => scopeLabels[scope])
                      .join(" · ")}
                  </span>
                  <span>
                    <span
                      className={`status-badge status-badge--${status(token) === "Active" ? "online" : "offline"}`}
                    >
                      {status(token)}
                    </span>
                    {" · "}
                    {token.lastUsedAt
                      ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                      : "Never used"}
                    {expiryNote(token) ? ` · ${expiryNote(token)}` : ""}
                    {token.dataSourceIds.length > 0
                      ? ` · Limited to ${token.dataSourceIds.length} Data Source${token.dataSourceIds.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </div>
                <div className="backup-row__actions">
                  {!token.revokedAt && (
                    <button
                      className="button button--danger"
                      onClick={() => revoke.mutate(token)}
                      aria-label={`Revoke ${token.name}`}
                    >
                      <Trash2 size={15} /> Revoke
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        {revoke.error && !(revoke.error instanceof CancelledAction) && (
          <div className="notice notice--error" role="alert">
            {revoke.error.message}
          </div>
        )}
      </section>

      <section className="settings-subsection">
        <header>
          <h3>Create a token</h3>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSecret(undefined);
            create.mutate();
          }}
        >
          <div className="setting-row">
            <div className="setting-copy">
              <label htmlFor="token-name">Name</label>
              <p>
                Name the system that will use it, so the delivery record and the
                audit log say who did what.
              </p>
            </div>
            <div className="setting-control">
              <input
                id="token-name"
                value={name}
                required
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-copy">
              <label>Capabilities</label>
            </div>
            <div className="setting-control setting-control--checks">
              {allScopes.map((scope) => (
                <label key={scope} className="check-option">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={(event) =>
                      setScopes(
                        event.target.checked
                          ? [...scopes, scope]
                          : scopes.filter((item) => item !== scope),
                      )
                    }
                  />
                  <span>
                    {scopeLabels[scope]}
                    <small>{scopeDescriptions[scope]}</small>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-copy">
              <label htmlFor="token-expires">Expires on</label>
              <p>
                The token stops working at the end of this day. Leave it empty
                for a token that never expires, and revoke it when the system
                using it is retired.
              </p>
            </div>
            <div className="setting-control">
              <input
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
            <div className="setting-row">
              <div className="setting-copy">
                <label>Limit to Data Sources</label>
                <p>
                  Select none to allow every Manual Table Data Source. Naming
                  them is the safer default.
                </p>
              </div>
              <div className="setting-control setting-control--checks">
                {sources.isLoading ? (
                  <span className="setting-dependency">
                    Loading Data Sources…
                  </span>
                ) : !sources.data?.items?.length ? (
                  <span className="setting-dependency">
                    No Manual Table Data Sources exist yet.
                  </span>
                ) : (
                  sources.data.items.map((source) => (
                    <label key={source.id} className="check-option">
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(source.id)}
                        onChange={(event) =>
                          setSourceIds(
                            event.target.checked
                              ? [...sourceIds, source.id]
                              : sourceIds.filter((id) => id !== source.id),
                          )
                        }
                      />
                      {source.name}
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          {create.error && (
            <div className="notice notice--error" role="alert">
              {create.error.message}
            </div>
          )}

          <div className="settings-subsection__action">
            <div />
            <button
              className="button button--primary"
              type="submit"
              disabled={create.isPending || scopes.length === 0}
            >
              {create.isPending ? "Creating…" : "Create token"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

class CancelledAction extends Error {}
