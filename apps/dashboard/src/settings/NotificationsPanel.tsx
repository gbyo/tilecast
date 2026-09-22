import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { NotificationCategory, NotificationWebhook } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";

const categoryLabels: Record<NotificationCategory, string> = {
  incident: "Screen problems",
  content_health: "Content problems",
  backup: "Backups",
  update: "Player updates",
};
const allCategories = Object.keys(categoryLabels) as NotificationCategory[];

export function NotificationsPanel({ manageable }: { manageable: boolean }) {
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const client = useQueryClient();
  const csrf = auth.status?.csrfToken ?? "";
  const status = useQuery({
    queryKey: ["notification-status"],
    queryFn: api.notificationStatus,
  });
  const webhooks = useQuery({
    queryKey: ["notification-webhooks"],
    queryFn: api.notificationWebhooks,
    enabled: manageable,
  });
  const deliveries = useQuery({
    queryKey: ["notification-deliveries"],
    queryFn: () => api.notificationDeliveries(25),
    enabled: manageable,
  });

  const [newSecret, setNewSecret] = useState<string>();
  const [testResult, setTestResult] = useState<string>();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["notification-webhooks"] });
    void client.invalidateQueries({ queryKey: ["notification-deliveries"] });
    void client.invalidateQueries({ queryKey: ["notification-status"] });
  };

  const sendTest = useMutation({
    mutationFn: () => api.sendTestNotification(csrf),
    onSuccess: (data) => setTestResult(`Test message sent to ${data.sentTo}.`),
    onError: () => setTestResult(undefined),
  });
  const createWebhook = useMutation({
    mutationFn: (body: {
      name: string;
      url: string;
      categories: NotificationCategory[];
    }) => api.createNotificationWebhook(body, csrf),
    onSuccess: (data) => {
      setNewSecret(data.signingSecret);
      refresh();
    },
  });
  const toggleWebhook = useMutation({
    mutationFn: (webhook: NotificationWebhook) =>
      api.updateNotificationWebhook(
        webhook.id,
        {
          name: webhook.name,
          url: webhook.url,
          enabled: !webhook.enabled,
          categories: webhook.categories,
        },
        csrf,
      ),
    onSuccess: refresh,
  });
  const testWebhook = useMutation({
    mutationFn: (id: string) => api.testNotificationWebhook(id, csrf),
    onSuccess: refresh,
  });
  const removeWebhook = useMutation({
    mutationFn: async (webhook: NotificationWebhook) => {
      if (!(await confirm({
        title: `Remove the “${webhook.name}” webhook?`,
        description:
          "Its signing secret cannot be recovered, so the receiver will need a new one.",
        confirmLabel: "Remove webhook",
        tone: "negative",
      })))
        throw new CancelledAction();
      return api.deleteNotificationWebhook(webhook.id, csrf);
    },
    onSuccess: refresh,
  });

  const emailConfigured = status.data?.emailConfigured ?? false;

  return (
    <div className="settings-sections">
      <section className="settings-subsection">
        <header>
          <h3>Email delivery</h3>
          <p>
            Tilecast sends through an SMTP relay configured on the server, not
            through an account in Studio.
          </p>
        </header>
        {status.isLoading ? (
          <div className="table-loading">Checking notification delivery…</div>
        ) : emailConfigured ? (
          <p className="backup-summary">
            <span className="status-badge status-badge--online">Available</span>{" "}
            An SMTP relay is configured. Each account chooses what it receives
            under My Account → Preferences.
          </p>
        ) : (
          <div className="notice">
            <strong>Email is unavailable.</strong>{" "}
            {status.data?.emailUnavailableReason}
            <br />
            Set <code>TILECAST_SMTP_HOST</code> (and{" "}
            <code>TILECAST_SMTP_PORT</code>, <code>TILECAST_SMTP_USERNAME</code>
            , <code>TILECAST_SMTP_PASSWORD</code> where the relay needs them),
            then restart the server.
          </div>
        )}
        <div className="settings-subsection__action">
          <div>
            <p>
              A test goes to your own notification address and ignores quiet
              hours and subscriptions.
            </p>
          </div>
          <button
            className="button"
            disabled={!emailConfigured || sendTest.isPending}
            onClick={() => {
              setTestResult(undefined);
              sendTest.mutate();
            }}
          >
            <Send size={15} />{" "}
            {sendTest.isPending ? "Sending…" : "Send a test to myself"}
          </button>
        </div>
        {testResult && <p className="backup-summary">{testResult}</p>}
        {sendTest.error && (
          <div className="notice notice--error" role="alert">
            {sendTest.error.message}
          </div>
        )}
      </section>

      {manageable && (
        <>
          <WebhookSection
            webhooks={webhooks.data ?? []}
            loading={webhooks.isLoading}
            newSecret={newSecret}
            onDismissSecret={() => setNewSecret(undefined)}
            createError={createWebhook.error?.message}
            testError={testWebhook.error?.message}
            actionError={
              toggleWebhook.error?.message ??
              (removeWebhook.error instanceof CancelledAction
                ? undefined
                : removeWebhook.error?.message)
            }
            creating={createWebhook.isPending}
            onCreate={(body) => {
              setNewSecret(undefined);
              createWebhook.mutate(body);
            }}
            onToggle={(webhook) => toggleWebhook.mutate(webhook)}
            onTest={(id) => testWebhook.mutate(id)}
            onRemove={(webhook) => removeWebhook.mutate(webhook)}
          />

          <section className="settings-subsection">
            <header>
              <h3>Recent deliveries</h3>
              <p>
                What Tilecast tried to send, and what happened. A failure here
                means the message did not arrive.
              </p>
            </header>
            {deliveries.isLoading ? (
              <div className="table-loading">Loading deliveries…</div>
            ) : !deliveries.data?.length ? (
              <div className="empty-card">
                Nothing has been sent yet. Deliveries appear here when a
                condition is reported.
              </div>
            ) : (
              <div className="backup-job-list">
                {deliveries.data.map((delivery) => (
                  <div key={delivery.id}>
                    <span>
                      <strong>{delivery.subject || delivery.eventKey}</strong>
                      <small>
                        {formatDate(delivery.createdAt)} · {delivery.channel} ·{" "}
                        {delivery.target}
                      </small>
                    </span>
                    <span className="backup-job-status">
                      {delivery.status}
                      {delivery.attempts > 1
                        ? ` after ${delivery.attempts} attempts`
                        : ""}
                      {delivery.lastError ? ` — ${delivery.lastError}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function WebhookSection({
  webhooks,
  loading,
  newSecret,
  onDismissSecret,
  createError,
  testError,
  actionError,
  creating,
  onCreate,
  onToggle,
  onTest,
  onRemove,
}: {
  webhooks: NotificationWebhook[];
  loading: boolean;
  newSecret?: string;
  onDismissSecret: () => void;
  createError?: string;
  testError?: string;
  actionError?: string;
  creating: boolean;
  onCreate: (body: {
    name: string;
    url: string;
    categories: NotificationCategory[];
  }) => void;
  onToggle: (webhook: NotificationWebhook) => void;
  onTest: (id: string) => void;
  onRemove: (webhook: NotificationWebhook) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [categories, setCategories] = useState<NotificationCategory[]>([]);

  return (
    <section className="settings-subsection">
      <header>
        <h3>Webhooks</h3>
        <p>
          Tilecast posts signed JSON to a URL you control. Use a relay to reach
          a chat service; Tilecast has no per-service integrations.
        </p>
      </header>

      {newSecret && (
        <div className="notice" role="status">
          <strong>Copy this signing secret now.</strong> Tilecast does not show
          it again, and there is no way to read it back.
          <pre className="secret-value">{newSecret}</pre>
          Verify a request by computing{" "}
          <code>HMAC-SHA256(secret, timestamp + "." + body)</code> and comparing
          it with the <code>X-Tilecast-Signature</code> header. Reject a request
          whose <code>X-Tilecast-Timestamp</code> is not recent.
          <div>
            <button className="button button--quiet" onClick={onDismissSecret}>
              I have copied it
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="table-loading">Loading webhooks…</div>
      ) : !webhooks.length ? (
        <div className="empty-card">No webhooks are configured.</div>
      ) : (
        <div className="backup-list">
          {webhooks.map((webhook) => (
            <article className="backup-row" key={webhook.id}>
              <div className="backup-row__details">
                <strong>{webhook.name}</strong>
                <span>{webhook.url}</span>
                <span>
                  <span
                    className={`status-badge status-badge--${webhook.enabled ? "online" : "offline"}`}
                  >
                    {webhook.enabled ? "Enabled" : "Disabled"}
                  </span>
                  {" · "}
                  {webhook.categories.length
                    ? webhook.categories
                        .map((category) => categoryLabels[category])
                        .join(", ")
                    : "All categories"}
                  {webhook.lastSuccessAt
                    ? ` · Last delivered ${formatDate(webhook.lastSuccessAt)}`
                    : " · Never delivered"}
                </span>
                {webhook.lastError && (
                  <span className="setting-dependency">
                    Last error: {webhook.lastError}
                  </span>
                )}
              </div>
              <div className="backup-row__actions">
                <button
                  className="button button--quiet"
                  onClick={() => onTest(webhook.id)}
                >
                  <Send size={15} /> Test
                </button>
                <button
                  className="button button--quiet"
                  onClick={() => onToggle(webhook)}
                >
                  {webhook.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  className="button button--danger"
                  onClick={() => onRemove(webhook)}
                  aria-label={`Remove ${webhook.name}`}
                >
                  <Trash2 size={15} /> Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {testError && (
        <div className="notice notice--error" role="alert">
          {testError}
        </div>
      )}
      {actionError && (
        <div className="notice notice--error" role="alert">
          {actionError}
        </div>
      )}

      <form
        className="webhook-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({ name: name.trim(), url: url.trim(), categories });
          setName("");
          setUrl("");
          setCategories([]);
        }}
      >
        <div className="setting-row">
          <div className="setting-copy">
            <label htmlFor="webhook-name">Name</label>
            <p>How this receiver is identified in the delivery log.</p>
          </div>
          <div className="setting-control">
            <input
              id="webhook-name"
              value={name}
              required
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <label htmlFor="webhook-url">URL</label>
            <p>
              HTTPS is required unless the receiver is on the local network.
            </p>
          </div>
          <div className="setting-control">
            <input
              id="webhook-url"
              type="url"
              value={url}
              required
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
        </div>
        <div className="setting-row">
          <div className="setting-copy">
            <label>Categories</label>
            <p>Select none to receive every category.</p>
          </div>
          <div className="setting-control setting-control--checks">
            {allCategories.map((category) => (
              <label key={category} className="check-option">
                <input
                  type="checkbox"
                  checked={categories.includes(category)}
                  onChange={(event) =>
                    setCategories(
                      event.target.checked
                        ? [...categories, category]
                        : categories.filter((item) => item !== category),
                    )
                  }
                />
                {categoryLabels[category]}
              </label>
            ))}
          </div>
        </div>
        {createError && (
          <div className="notice notice--error" role="alert">
            {createError}
          </div>
        )}
        <div className="settings-subsection__action">
          <div />
          <button
            className="button button--primary"
            type="submit"
            disabled={creating}
          >
            {creating ? "Adding…" : "Add webhook"}
          </button>
        </div>
      </form>
    </section>
  );
}

class CancelledAction extends Error {}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
