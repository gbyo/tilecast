import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";
import { Send, Trash2 } from "lucide-react";
import { api } from "../api/client";
import type { NotificationCategory, NotificationWebhook } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";
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

type CategoryLabelKey =
  | "notifications.categories.incident"
  | "notifications.categories.content_health"
  | "notifications.categories.backup"
  | "notifications.categories.update";

// Category names hold translation keys, never rendered text. Labels resolve
// with t() at render so the panel follows language changes.
const categoryLabelKeys: Record<NotificationCategory, CategoryLabelKey> = {
  incident: "notifications.categories.incident",
  content_health: "notifications.categories.content_health",
  backup: "notifications.categories.backup",
  update: "notifications.categories.update",
};
const allCategories = Object.keys(categoryLabelKeys) as NotificationCategory[];

export function NotificationsPanel({ manageable }: { manageable: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
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
      const message = t("notifications.testSent", { sentTo: data.sentTo });
      setTestResult(message);
      toast.add({ title: message, type: "success" });
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
      toast.add({
        title: t("notifications.toasts.webhookCreated"),
        type: "success",
      });
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
      toast.add({
        title: t("notifications.toasts.webhookUpdated"),
        type: "success",
      });
      refresh();
    },
  });
  const testWebhook = useMutation({
    mutationFn: (id: string) => api.testNotificationWebhook(id, csrf),
    onSuccess: () => {
      toast.add({
        title: t("notifications.toasts.webhookTestSent"),
        type: "success",
      });
      refresh();
    },
  });
  const { confirm, dialog: confirmDialog } = useConfirm();
  const removeWebhook = useMutation({
    mutationFn: async (webhook: NotificationWebhook) => {
      const ok = await confirm({
        title: t("notifications.removeTitle", { name: webhook.name }),
        body: t("notifications.removeBody"),
        action: t("notifications.remove"),
        destructive: true,
      });
      if (!ok) throw new CancelledAction();
      return api.deleteNotificationWebhook(webhook.id, csrf);
    },
    onSuccess: () => {
      toast.add({
        title: t("notifications.toasts.webhookRemoved"),
        type: "success",
      });
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
            <h3 className="text-base font-semibold">
              {t("notifications.email.title")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("notifications.email.description")}
            </p>
          </header>
          {status.isLoading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              {t("notifications.checking")}
            </p>
          ) : emailConfigured ? (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="default">{t("notifications.available")}</Badge>{" "}
              {t("notifications.configured")}
            </p>
          ) : (
            <Alert role="status">
              <AlertDescription>
                <strong>{t("notifications.emailUnavailable")}</strong>{" "}
                {status.data?.emailUnavailableReason}
                <br />
                <Trans
                  i18nKey="notifications.smtpSetup"
                  ns="settings"
                  // i18n-ignore: environment variable names are constants, not language text
                  components={{
                    smtpHost: <code>TILECAST_SMTP_HOST</code>, // i18n-ignore
                    smtpPort: <code>TILECAST_SMTP_PORT</code>, // i18n-ignore
                    smtpUsername: <code>TILECAST_SMTP_USERNAME</code>, // i18n-ignore
                    smtpPassword: <code>TILECAST_SMTP_PASSWORD</code>, // i18n-ignore
                  }}
                />
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">
                {t("notifications.testHint")}
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
              {sendTest.isPending
                ? t("notifications.sending")
                : t("notifications.sendTest")}
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
                <h3 className="text-base font-semibold">
                  {t("notifications.deliveries.title")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("notifications.deliveries.description")}
                </p>
              </header>
              {deliveries.isLoading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner aria-hidden="true" />
                  {t("notifications.loadingDeliveries")}
                </p>
              ) : !deliveries.data?.length ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>
                      {t("notifications.deliveriesEmpty")}
                    </EmptyTitle>
                    <EmptyDescription>
                      {t("notifications.deliveriesEmptyHint")}
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
                          {formatDate(delivery.createdAt, locale)} ·{" "}
                          {delivery.channel} · {delivery.target}
                        </small>
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {delivery.status}
                        {delivery.attempts > 1
                          ? t("notifications.afterAttempts", {
                              count: delivery.attempts,
                            })
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
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [categories, setCategories] = useState<NotificationCategory[]>([]);

  return (
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <header className="grid gap-1">
        <h3 className="text-base font-semibold">
          {t("notifications.webhooks.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("notifications.webhooks.description")}
        </p>
      </header>

      {newSecret && (
        <Alert role="status">
          <AlertDescription className="grid gap-2">
            <span>
              <Trans
                i18nKey="notifications.secretNotice"
                ns="settings"
                components={{ strong: <strong /> }}
              />
            </span>
            <pre className="overflow-x-auto rounded-xl border border-border bg-muted p-3 font-mono text-xs break-all">
              {newSecret}
            </pre>
            <span>
              <Trans
                i18nKey="notifications.verifyHint"
                ns="settings"
                components={{
                  // i18n-ignore: signature formula and header names are constants, not language text
                  hmac: (
                    <code>
                      {/* i18n-ignore */}
                      HMAC-SHA256(secret, timestamp + &quot;.&quot; + body)
                    </code>
                  ),
                  sigHeader: <code>X-Tilecast-Signature</code>, // i18n-ignore
                  tsHeader: <code>X-Tilecast-Timestamp</code>, // i18n-ignore
                }}
              />
            </span>
            <div>
              <RheaButton variant="ghost" onClick={onDismissSecret}>
                {t("integrations.copied")}
              </RheaButton>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          {t("notifications.loadingWebhooks")}
        </p>
      ) : !webhooks.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("notifications.webhooksEmpty")}</EmptyTitle>
            <EmptyDescription>
              {t("notifications.webhooksEmptyHint")}
            </EmptyDescription>
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
                    {webhook.enabled
                      ? t("enumValues.enabled")
                      : t("enumValues.disabled")}
                  </Badge>
                  {" · "}
                  {webhook.categories.length
                    ? webhook.categories
                        .map((category) => t(categoryLabelKeys[category]))
                        .join(", ")
                    : t("notifications.allCategories")}
                  {webhook.lastSuccessAt
                    ? t("notifications.lastDelivered", {
                        date: formatDate(webhook.lastSuccessAt, locale),
                      })
                    : t("notifications.neverDelivered")}
                </span>
                {webhook.lastError && (
                  <span className="text-xs text-muted-foreground">
                    {t("notifications.lastError", {
                      error: webhook.lastError,
                    })}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <RheaButton variant="ghost" onClick={() => onTest(webhook.id)}>
                  <Send size={15} aria-hidden="true" />{" "}
                  {t("notifications.test")}
                </RheaButton>
                <RheaButton variant="ghost" onClick={() => onToggle(webhook)}>
                  {webhook.enabled
                    ? t("notifications.disable")
                    : t("notifications.enable")}
                </RheaButton>
                <RheaButton
                  variant="destructive"
                  onClick={() => onRemove(webhook)}
                  aria-label={t("notifications.removeWebhook", {
                    name: webhook.name,
                  })}
                >
                  <Trash2 size={15} aria-hidden="true" />{" "}
                  {t("notifications.remove")}
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
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid content-start gap-1">
            <label htmlFor="webhook-name" className="text-sm font-medium">
              {t("notifications.form.name")}
            </label>
            <p className="text-sm text-muted-foreground">
              {t("notifications.form.nameHint")}
            </p>
          </div>
          <div className="grid content-start gap-2">
            <Input
              id="webhook-name"
              value={name}
              required
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid content-start gap-1">
            <label htmlFor="webhook-url" className="text-sm font-medium">
              {t("notifications.form.url")}
            </label>
            <p className="text-sm text-muted-foreground">
              {t("notifications.form.urlHint")}
            </p>
          </div>
          <div className="grid content-start gap-2">
            <Input
              id="webhook-url"
              type="url"
              value={url}
              required
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid content-start gap-1">
            <label className="text-sm font-medium">
              {t("notifications.form.categories")}
            </label>
            <p className="text-sm text-muted-foreground">
              {t("notifications.form.categoriesHint")}
            </p>
          </div>
          <div className="grid content-start gap-2">
            {allCategories.map((category) => (
              <label
                key={category}
                className="flex cursor-pointer items-center gap-2 text-sm"
              >
                <RheaCheckbox
                  checked={categories.includes(category)}
                  onCheckedChange={(checked) =>
                    setCategories(
                      checked === true
                        ? [...categories, category]
                        : categories.filter((item) => item !== category),
                    )
                  }
                />
                <span>{t(categoryLabelKeys[category])}</span>
              </label>
            ))}
          </div>
        </div>
        {createError && (
          <Alert variant="destructive">
            <AlertDescription>{createError}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <RheaButton variant="default" type="submit" disabled={creating}>
            {creating
              ? t("notifications.form.adding")
              : t("notifications.form.add")}
          </RheaButton>
        </div>
      </form>
    </section>
  );
}

class CancelledAction extends Error {}

function formatDate(value: string, locale: string) {
  return new Date(value).toLocaleString(locale);
}
