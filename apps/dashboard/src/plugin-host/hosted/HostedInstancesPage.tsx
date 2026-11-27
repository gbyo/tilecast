import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Plus, Settings2, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/components/ui/toast";
import { apiErrorMessage } from "@/i18n";
import { pluginsQueryKey } from "../../plugins/pluginCatalog";
import { PluginPage } from "../PluginPage";
import { useStudioSession } from "../session";
import { hostedClient, hostedInstancesKey } from "./api";
import { kindRoute, summaryOf, type HostedPluginProps } from "./model";
import { SecretKeyNotice } from "./SecretKeyNotice";

/**
 * The generated list page of a plugin's instance kinds. One kind shows a
 * list; more than one shows a tab for each. Everything here comes from the
 * manifest, so a plugin writes no list page of its own.
 */
export function HostedInstancesPage({
  pluginId,
  manifest,
  kindPath,
}: HostedPluginProps) {
  const { t } = useTranslation(["plugins", "common"]);
  const kinds = manifest.instances;
  const kind = kinds.find((item) => item.path === kindPath) ?? kinds[0]!;
  const session = useStudioSession();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const client = hostedClient(manifest.api!.basePaths[0]!, kind.path);
  const instances = useQuery({
    queryKey: hostedInstancesKey(pluginId, kind.kind),
    queryFn: client.list,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.remove(id, session.csrfToken),
    onSuccess: () => {
      toast.add({
        title: t("hosted.removedToast", { noun: kind.noun.singular }),
        type: "success",
      });
      void queryClient.invalidateQueries({
        queryKey: hostedInstancesKey(pluginId, kind.kind),
      });
      void queryClient.invalidateQueries({ queryKey: pluginsQueryKey });
    },
  });
  const manageable = session.canManage;
  const base = kindRoute(manifest, kind);
  const items = instances.data?.items ?? [];
  // Only a successful, empty list is "nothing configured": a failed load must
  // not read as an empty fleet.
  const showEmptyState =
    !instances.isError && !instances.isLoading && items.length === 0;
  return (
    <>
      {dialog}
      <PluginPage
        pluginId={pluginId}
        actions={
          <>
            {(manifest.connections ?? []).length > 0 && (
              <Link
                className={buttonVariants({ variant: "outline", size: "lg" })}
                to={`${manifest.studio!.route}/connections`}
              >
                <Plug data-icon="inline-start" aria-hidden="true" />{" "}
                {t("hosted.connections.open")}
              </Link>
            )}
            {manifest.settings?.organization?.length ? (
              <Link
                className={buttonVariants({ variant: "outline", size: "lg" })}
                to={`${manifest.studio!.route}/settings`}
              >
                <Settings2 data-icon="inline-start" aria-hidden="true" />{" "}
                {t("hosted.settings")}
              </Link>
            ) : null}
            {manageable && (
              <Link
                className={buttonVariants({ size: "lg" })}
                to={`${base}/new`}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />{" "}
                {t("hosted.new", { noun: kind.noun.singular })}
              </Link>
            )}
          </>
        }
      >
        <SecretKeyNotice />
        {kinds.length > 1 && (
          <Tabs value={kind.path}>
            <TabsList>
              {kinds.map((item) => (
                <TabsTrigger
                  key={item.path}
                  value={item.path}
                  render={<Link to={kindRoute(manifest, item)} />}
                >
                  {item.noun.plural}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        {instances.isError && (
          <Alert variant="destructive">
            <AlertDescription>
              {t("hosted.loadError", { noun: kind.noun.plural })}
            </AlertDescription>
          </Alert>
        )}
        {remove.isError && (
          <Alert variant="destructive">
            <AlertDescription>{apiErrorMessage(remove.error)}</AlertDescription>
          </Alert>
        )}
        {showEmptyState ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Plus size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                {t("hosted.emptyTitle", { noun: kind.noun.plural })}
              </EmptyTitle>
              <EmptyDescription>
                {t("hosted.emptyDescription", { noun: kind.noun.singular })}
              </EmptyDescription>
            </EmptyHeader>
            {manageable && (
              <EmptyContent>
                <Link className={buttonVariants()} to={`${base}/new`}>
                  {t("hosted.new", { noun: kind.noun.singular })}
                </Link>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <ItemGroup className="gap-2">
            {items.map((instance) => {
              const summary = summaryOf(kind, instance);
              return (
                <Item variant="outline" key={instance.id}>
                  <ItemContent>
                    <ItemTitle>
                      <h2 className="text-sm font-medium">{instance.name}</h2>
                      <Badge
                        variant={instance.enabled ? "default" : "secondary"}
                      >
                        {instance.enabled
                          ? t("shared.enabledBadge")
                          : t("shared.disabledBadge")}
                      </Badge>
                    </ItemTitle>
                    {(summary || instance.priority !== undefined) && (
                      <ItemDescription>
                        {[
                          summary,
                          instance.priority !== undefined
                            ? t("hosted.priorityValue", {
                                priority: instance.priority,
                              })
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </ItemDescription>
                    )}
                  </ItemContent>
                  <ItemActions className="flex-wrap">
                    <Link
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                      to={`${base}/${instance.id}`}
                    >
                      {t("shared.manage")}
                    </Link>
                    {manageable && (
                      <Button
                        type="button"
                        size="icon"
                        variant="destructive"
                        aria-label={t("shared.deleteAction", {
                          name: instance.name,
                        })}
                        onClick={() => {
                          void confirm({
                            title: t("shared.deleteTitle", {
                              name: instance.name,
                            }),
                            body: t("hosted.deleteBody", {
                              noun: kind.noun.singular,
                            }),
                            action: t("common:actions.delete"),
                            destructive: true,
                          }).then((ok) => {
                            if (ok) remove.mutate(instance.id);
                          });
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </Button>
                    )}
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
      </PluginPage>
    </>
  );
}
