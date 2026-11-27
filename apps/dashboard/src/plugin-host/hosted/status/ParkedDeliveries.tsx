import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { statusClient, statusKey, type PluginParkedDelivery } from "./api";
import { useDeliveryLabels } from "./labels";
import { deliveriesCapability } from "./model";

/**
 * Work that failed eight times and waits for an Owner. A retry runs the
 * plugin again with the same delivery ID; a discard loses the work. Other
 * accounts see the list without the actions.
 */
export function ParkedDeliveries({
  pluginId,
  items,
  total,
}: {
  pluginId: string;
  items: PluginParkedDelivery[];
  total: number;
}) {
  const { t } = useTranslation("plugins");
  const session = useStudioSession();
  const canAct = session.can(deliveriesCapability);
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="parked-title">
      <h2 id="parked-title" className="text-sm font-medium">
        {t("hosted.status.parked.title", { count: total })}
      </h2>
      <p className="text-sm text-muted-foreground">
        {canAct
          ? t("hosted.status.parked.description")
          : t("hosted.status.parked.ownerOnly")}
      </p>
      <ItemGroup className="gap-2">
        {items.map((item) => (
          <ParkedDelivery
            key={item.id}
            pluginId={pluginId}
            item={item}
            canAct={canAct}
          />
        ))}
      </ItemGroup>
    </section>
  );
}

function ParkedDelivery({
  pluginId,
  item,
  canAct,
}: {
  pluginId: string;
  item: PluginParkedDelivery;
  canAct: boolean;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const locale = useFormatLocale();
  const labels = useDeliveryLabels();
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const client = statusClient(pluginId);
  const done = (message: string) => {
    void queryClient.invalidateQueries({ queryKey: statusKey(pluginId) });
    toast.add({ title: message, type: "success" });
  };
  const retry = useMutation({
    mutationFn: () => client.retry(item.id, session.csrfToken),
    onSuccess: () => done(t("hosted.status.parked.retriedToast")),
  });
  const discard = useMutation({
    mutationFn: () => client.discard(item.id, session.csrfToken),
    onSuccess: () => done(t("hosted.status.parked.discardedToast")),
  });
  const confirmDiscard = async () => {
    const ok = await confirm({
      title: t("hosted.status.parked.discardTitle"),
      body: t("hosted.status.parked.discardBody"),
      action: t("hosted.status.parked.discard"),
      destructive: true,
    });
    if (ok) discard.mutate();
  };
  const failed = retry.error ?? discard.error;
  const busy = retry.isPending || discard.isPending;
  return (
    <Item variant="outline">
      {dialog}
      <ItemContent>
        <ItemTitle>
          {labels.kind(item.kind)}: {item.source}
        </ItemTitle>
        <ItemDescription>
          {t("hosted.status.parked.meta", {
            reason: labels.failure(item.lastError),
            attempts: item.attempts,
            parked: new Date(item.parkedAt).toLocaleString(locale),
            expires: new Date(item.expiresAt).toLocaleString(locale),
          })}
        </ItemDescription>
        {failed && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{apiErrorMessage(failed)}</AlertDescription>
          </Alert>
        )}
      </ItemContent>
      {canAct && (
        <ItemActions>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => retry.mutate()}
          >
            {t("hosted.status.parked.retry")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => void confirmDiscard()}
          >
            {t("hosted.status.parked.discard")}
          </Button>
        </ItemActions>
      )}
    </Item>
  );
}
