import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { NotificationCategory, NotificationWebhook } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";

const categoryLabels: Record<NotificationCategory, string> = {
  incident: "Screen problems",
  content_health: "Content problems",
  backup: "Backups",
  update: "Player updates",
};
const allCategories = Object.keys(categoryLabels) as NotificationCategory[];

export function NotificationsPanel({ manageable }: { manageable: boolean }) {
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
    onSuccess: (data) => {
      setTestResult(`Test message sent to ${data.sentTo}.`);
      toast.add({ title: "Test notification sent.", type: "success" });
    },
    onError: () => setTestResult(undefined),
  });
  const createWebhook = useMutation({
    mutationFn: (body: {
      name: string;
      url: string;
      categories: NotificationCategory[];
    }) => api.createNotificationWebhook(body, csrf),
    onSuccess: (data) => {
      toast.add({ title: "Notification webhook created.", type: "success" });
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
    onSuccess: () => {
      toast.add({ title: "Notification webhook updated.", type: "success" });
      refresh();
    },
  });
  const testWebhook = useMutation({
    mutationFn: (id: string) => api.testNotificationWebhook(id, csrf),
    onSuccess: () => {
      toast.add({ title: "Webhook test sent.", type: "success" });
      refresh();
    },
  });
  const { confirm, dialog: confirmDialog } = useConfirm();
  const removeWebhook = useMutation({
    mutationFn: async (webhook: NotificationWebhook) => {
      const ok = await confirm({
        title: `Remove the webhook "${webhook.name}"?`,
        body: "Its signing secret cannot be recovered, so the receiver will need a new one.",
        action: "Remove",
        destructive: true,
      });
      if (!ok) throw new CancelledAction();
      return api.deleteNotificationWebhook(webhook.id, csrf);
    },
    onSuccess: () => {
      toast.add({ title: "Notification webhook removed.", type: "success" });
      refresh();
    },
  });

  const emailConfigured = status.data?.emailConfigured ?? false;

  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">Email delivery</h3>
            <p className="text-sm text-muted-foreground">
              Tilecast sends through an SMTP relay configured on the server, not
              through an account in Studio.
            </p>
          </header>
          {status.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              Checking notification delivery…
            </p>
          ) : emailConfigured ? (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="default">Available</Badge> An SMTP relay is
              configured. Each account chooses what it receives under My Account
              → Preferences.
            </p>
          ) : (
            <Alert role="status">
              <AlertDescription>
                <strong>Email is unavailable.</strong>{" "}
                {status.data?.emailUnavailableReason}
                <br />
                Set <code>TILECAST_SMTP_HOST</code> (and{" "}
                <code>TILECAST_SMTP_PORT</code>,{" "}
                <code>TILECAST_SMTP_USERNAME</code>,{" "}
                <code>TILECAST_SMTP_PASSWORD</code> where the relay needs them),
                then restart the server.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">
                A test goes to your own notification address and ignores quiet
                hours and subscriptions.
              </p>
            </div>
            <RheaButton
              variant="secondary"
              disabled={!emailConfigured || sendTest.isPending}
              onClick={() => {
                setTestResult(undefined);
                sendTest.mutate();
              }}
            >
              <Send size={15} aria-hidden="true" />{" "}
              {sendTest.isPending ? "Sending…" : "Send a test to myself"}
            </RheaButton>
          </div>
          {testResult && (
            <p className="text-sm text-muted-foreground">{testResult}</p>
          )}
          {sendTest.error && (
            <Alert variant="destructive">
              <AlertDescription>{sendTest.error.message}</AlertDescription>
            </Alert>
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

            <section className="grid gap-3 rounded-xl border border-border p-4">
              <header className="grid gap-1">
                <h3 className="text-base font-semibold">Recent deliveries</h3>
                <p className="text-sm text-muted-foreground">
                  What Tilecast tried to send, and what happened. A failure here
                  means the message did not arrive.
                </p>
              </header>
              {deliveries.isLoading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  Loading deliveries…
                </p>
              ) : !deliveries.data?.length ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No deliveries</EmptyTitle>
                    <EmptyDescription>
                      Nothing has been sent yet. Deliveries appear here when a
                      condition is reported.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="grid gap-2">
                  {deliveries.data.map((delivery) => (
                    <div
                      key={delivery.id}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-3"
                    >
                      <span className="grid gap-0.5">
                        <strong className="text-sm font-semibold">
                          {delivery.subject || delivery.eventKey}
                        </strong>
                        <small className="text-xs text-muted-foreground">
                          {formatDate(delivery.createdAt)} · {delivery.channel}{" "}
                          · {delivery.target}
                        </small>
                      </span>
                      <span className="text-sm text-muted-foreground">
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
    </>
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
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <header className="grid gap-1">
        <h3 className="text-base font-semibold">Webhooks</h3>
        <p className="text-sm text-muted-foreground">
          Tilecast posts signed JSON to a URL you control. Use a relay to reach
          a chat service; Tilecast has no per-service integrations.
        </p>
      </header>

      {newSecret && (
        <Alert role="status">
          <AlertDescription className="grid gap-2">
            <span>
              <strong>Copy this signing secret now.</strong> Tilecast does not
              show it again, and there is no way to read it back.
            </span>
            <pre className="overflow-x-auto rounded-xl border border-border bg-muted p-3 font-mono text-xs break-all">
              {newSecret}
            </pre>
            <span>
              Verify a request by computing{" "}
              <code>HMAC-SHA256(secret, timestamp + "." + body)</code> and
              comparing it with the <code>X-Tilecast-Signature</code> header.
              Reject a request whose <code>X-Tilecast-Timestamp</code> is not
              recent.
            </span>
            <div>
              <RheaButton variant="ghost" onClick={onDismissSecret}>
                I have copied it
              </RheaButton>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          Loading webhooks…
        </p>
      ) : !webhooks.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No webhooks</EmptyTitle>
            <EmptyDescription>No webhooks are configured.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-2">
          {webhooks.map((webhook) => (
            <article
              className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4"
              key={webhook.id}
            >
              <div className="grid min-w-0 flex-1 gap-1">
                <strong className="text-sm font-semibold">
                  {webhook.name}
                </strong>
                <span className="text-sm text-muted-foreground break-all">
                  {webhook.url}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant={webhook.enabled ? "default" : "secondary"}>
                    {webhook.enabled ? "Enabled" : "Disabled"}
                  </Badge>
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
                  <span className="text-xs text-muted-foreground">
                    Last error: {webhook.lastError}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <RheaButton variant="ghost" onClick={() => onTest(webhook.id)}>
                  <Send size={15} aria-hidden="true" /> Test
                </RheaButton>
                <RheaButton variant="ghost" onClick={() => onToggle(webhook)}>
                  {webhook.enabled ? "Disable" : "Enable"}
                </RheaButton>
                <RheaButton
                  variant="destructive"
                  onClick={() => onRemove(webhook)}
                  aria-label={`Remove ${webhook.name}`}
                >
                  <Trash2 size={15} aria-hidden="true" /> Remove
                </RheaButton>
              </div>
            </article>
          ))}
        </div>
      )}

      {testError && (
        <Alert variant="destructive">
          <AlertDescription>{testError}</AlertDescription>
        </Alert>
      )}
      {actionError && (
        <Alert variant="destructive">
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      <form
        className="grid gap-4 border-t border-border pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({ name: name.trim(), url: url.trim(), categories });
          setName("");
          setUrl("");
          setCategories([]);
        }}
      >
        <Field className="gap-3 sm:grid sm:grid-cols-2 sm:items-start">
          <FieldContent>
            <FieldLabel htmlFor="webhook-name">Name</FieldLabel>
            <FieldDescription>
              How this receiver is identified in the delivery log.
            </FieldDescription>
          </FieldContent>
          <Input
            id="webhook-name"
            value={name}
            required
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field className="gap-3 sm:grid sm:grid-cols-2 sm:items-start">
          <FieldContent>
            <FieldLabel htmlFor="webhook-url">URL</FieldLabel>
            <FieldDescription>
              HTTPS is required unless the receiver is on the local network.
            </FieldDescription>
          </FieldContent>
          <Input
            id="webhook-url"
            type="url"
            value={url}
            required
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
        <FieldSet className="grid gap-2">
          <FieldLegend variant="label" className="mb-0">
            Categories
          </FieldLegend>
          <FieldDescription>
            Select none to receive every category.
          </FieldDescription>
          <div className="grid content-start gap-2">
            {allCategories.map((category) => (
              <Field
                key={category}
                orientation="horizontal"
                className="items-center"
              >
                <RheaCheckbox
                  id={"webhook-category-" + category}
                  checked={categories.includes(category)}
                  onCheckedChange={(checked) =>
                    setCategories(
                      checked === true
                        ? [...categories, category]
                        : categories.filter((item) => item !== category),
                    )
                  }
                />
                <FieldLabel
                  htmlFor={"webhook-category-" + category}
                  className="font-normal"
                >
                  {categoryLabels[category]}
                </FieldLabel>
              </Field>
            ))}
          </div>
        </FieldSet>
        {createError && (
          <Alert variant="destructive">
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <RheaButton variant="default" type="submit" disabled={creating}>
            {creating ? "Adding…" : "Add webhook"}
          </RheaButton>
        </div>
      </form>
    </section>
  );
}

class CancelledAction extends Error {}

function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
