import { useQuery } from "@tanstack/react-query";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { Plug, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
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
import { PluginPage } from "../../PluginPage";
import { useStudioSession } from "../../session";
import {
  connectionsClient,
  connectionsKey,
  type PluginConnection,
} from "./api";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";

export type HostedConnectionsProps = {
  pluginId: string;
  manifest: PluginManifestV3;
};

/** The Studio route of a plugin's connection pages. */
export function connectionsRoute(manifest: PluginManifestV3) {
  return `${manifest.studio!.route}/connections`;
}

function connectionSummary(
  connection: PluginConnection,
  manifest: PluginManifestV3,
): string {
  const declaration = (manifest.connections ?? []).find(
    (item) => item.id === connection.definition,
  );
  return [declaration?.title, connection.origins.join(", ")]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The generated list of a plugin's connection records. Every plugin with
 * connections gets this page from the host; a plugin writes no connection
 * manager of its own.
 */
export function HostedConnectionsPage({
  pluginId,
  manifest,
}: HostedConnectionsProps) {
  const { t } = useTranslation("plugins");
  const session = useStudioSession();
  const connections = useQuery({
    queryKey: connectionsKey(pluginId),
    queryFn: connectionsClient(pluginId).list,
  });
  const base = connectionsRoute(manifest);
  const items = connections.data?.items ?? [];
  const empty = connections.isSuccess && items.length === 0;
  return (
    <PluginPage
      pluginId={pluginId}
      title={t("hosted.connections.title")}
      description={t("hosted.connections.description")}
      actions={
        session.canManage && (
          <Link className={buttonVariants({ size: "lg" })} to={`${base}/new`}>
            <Plus data-icon="inline-start" aria-hidden="true" />{" "}
            {t("hosted.connections.new")}
          </Link>
        )
      }
    >
      {connections.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {t("hosted.connections.loadError")}
          </AlertDescription>
        </Alert>
      )}
      {empty ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plug size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("hosted.connections.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("hosted.connections.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
          {session.canManage && (
            <EmptyContent>
              <Link className={buttonVariants()} to={`${base}/new`}>
                {t("hosted.connections.new")}
              </Link>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {items.map((connection) => (
            <Item variant="outline" key={connection.id}>
              <ItemContent>
                <ItemTitle>
                  <h2 className="text-sm font-medium">{connection.name}</h2>
                  <ConnectionStatusBadge connection={connection} />
                </ItemTitle>
                <ItemDescription>
                  {connectionSummary(connection, manifest)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={`${base}/${connection.id}`}
                >
                  {t("shared.manage")}
                </Link>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </PluginPage>
  );
}
