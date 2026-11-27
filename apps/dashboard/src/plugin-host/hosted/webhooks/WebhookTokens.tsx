import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { toast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { apiErrorMessage, useFormatLocale } from "@/i18n";
import { useStudioSession } from "../../session";
import {
  webhooksClient,
  webhooksKey,
  type CreatedWebhookToken,
  type PluginWebhookToken,
} from "./api";
import { CopyValue } from "./CopyValue";

/** The prefix of a webhook token; the public ID follows it. */
const tokenPrefix = "tch_";

/** Creating and revoking a token needs the core capability. */
const manageCapability = "plugins.manage";

/**
 * The tokens of a token webhook. A new token is shown once and never read
 * back; a revoked token never works again.
 */
export function WebhookTokens({
  pluginId,
  webhookId,
  tokens,
}: {
  pluginId: string;
  webhookId: string;
  tokens: PluginWebhookToken[];
}) {
  const { t } = useTranslation("plugins");
  const session = useStudioSession();
  const canManage = session.can(manageCapability);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedWebhookToken>();
  const create = useMutation({
    mutationFn: () =>
      webhooksClient(pluginId).createToken(
        webhookId,
        name.trim(),
        session.csrfToken,
      ),
    onSuccess: (token) => {
      setCreated(token);
      setName("");
      toast.add({
        title: t("hosted.webhooks.tokens.created"),
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: webhooksKey(pluginId) });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate();
  };
  const active = tokens.filter((token) => !token.revokedAt);
  const inputId = `webhook-token-name-${webhookId}`;
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={`${inputId}-title`}
    >
      <h3 id={`${inputId}-title`} className="text-sm font-medium">
        {t("hosted.webhooks.tokens.title")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t("hosted.webhooks.tokens.description")}
      </p>
      {created && (
        <Alert role="status">
          <AlertDescription className="flex flex-col gap-2">
            <span>{t("hosted.webhooks.tokens.shownOnce")}</span>
            <CopyValue
              label={t("hosted.webhooks.tokens.newToken")}
              value={created.token}
            />
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreated(undefined)}
              >
                {t("hosted.webhooks.tokens.dismiss")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      {canManage && (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={submit}
        >
          <Field className="sm:flex-1">
            <FieldLabel htmlFor={inputId}>
              {t("hosted.webhooks.tokens.name")}
            </FieldLabel>
            <Input
              id={inputId}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            {t("hosted.webhooks.tokens.create")}
          </Button>
        </form>
      )}
      {create.error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{apiErrorMessage(create.error)}</AlertDescription>
        </Alert>
      )}
      {tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("hosted.webhooks.tokens.empty")}
        </p>
      ) : (
        <ItemGroup className="gap-2">
          {tokens.map((token) => (
            <TokenRow
              key={token.id}
              pluginId={pluginId}
              webhookId={webhookId}
              token={token}
              canManage={canManage}
            />
          ))}
        </ItemGroup>
      )}
      {!canManage && active.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t("hosted.webhooks.tokens.manageOnly")}
        </p>
      )}
    </section>
  );
}

function TokenRow({
  pluginId,
  webhookId,
  token,
  canManage,
}: {
  pluginId: string;
  webhookId: string;
  token: PluginWebhookToken;
  canManage: boolean;
}) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const revoke = useMutation({
    mutationFn: () =>
      webhooksClient(pluginId).revokeToken(
        webhookId,
        token.id,
        session.csrfToken,
      ),
    onSuccess: () => {
      toast.add({
        title: t("hosted.webhooks.tokens.revoked"),
        type: "success",
      });
      void queryClient.invalidateQueries({ queryKey: webhooksKey(pluginId) });
    },
  });
  const confirmRevoke = async () => {
    const ok = await confirm({
      title: t("hosted.webhooks.tokens.revokeTitle", { name: token.name }),
      body: t("hosted.webhooks.tokens.revokeBody"),
      action: t("hosted.webhooks.tokens.revoke"),
      destructive: true,
    });
    if (ok) revoke.mutate();
  };
  const date = (value: string) => new Date(value).toLocaleString(locale);
  return (
    <Item variant="outline">
      {dialog}
      <ItemContent>
        <ItemTitle>
          {token.name}
          {token.revokedAt && (
            <Badge variant="outline">
              {t("hosted.webhooks.tokens.revokedBadge")}
            </Badge>
          )}
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          <code className="font-mono text-xs">
            {tokenPrefix + token.publicId}
          </code>{" "}
          ·{" "}
          {token.lastUsedAt
            ? t("hosted.webhooks.tokens.lastUsed", {
                when: date(token.lastUsedAt),
              })
            : t("hosted.webhooks.tokens.neverUsed")}
        </ItemDescription>
        {revoke.error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{apiErrorMessage(revoke.error)}</AlertDescription>
          </Alert>
        )}
      </ItemContent>
      {canManage && !token.revokedAt && (
        <ItemActions>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={revoke.isPending}
            onClick={() => void confirmRevoke()}
          >
            {t("hosted.webhooks.tokens.revoke")}
          </Button>
        </ItemActions>
      )}
    </Item>
  );
}
