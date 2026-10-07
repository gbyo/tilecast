import { useTranslation } from "react-i18next";
import { CircleAlert, Plus, Puzzle } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router";
import type { PluginStoreEntry, PluginSummary } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Skeleton } from "../components/ui/skeleton";
import {
  hasStudioRoute,
  instanceSummary,
  pluginStatusKey,
  usePluginStore,
} from "../plugins/pluginCatalog";
import { PluginIcon } from "../plugins/PluginIcon";
import { StoreProvenanceBadge } from "../plugins/StoreProvenance";
import { canManage } from "../plugins/shared";

/**
 * Installed plugins: what this installation has chosen to add. Everything
 * else lives on the Explore route. `?add=<package id>` redirects there, so
 * bookmarks and older global-search results keep working.
 */
export function PluginsPage() {
  const { t } = useTranslation(["plugins", "common"]);
  const auth = useAuth();
  const [searchParams] = useSearchParams();
  const store = usePluginStore();
  const canInstall = canManage(auth.status?.user?.role);
  const addParam = searchParams.get("add");

  if (addParam !== null) {
    return (
      <Navigate
        to={
          addParam && addParam !== "1"
            ? `/plugins/store/${encodeURIComponent(addParam)}`
            : "/plugins/store"
        }
        replace
      />
    );
  }

  const entries = store.data?.items ?? [];
  const installed = entries.filter((entry) => entry.plugin.installed);
  // A failed load with no usable data owns the content area: the alert is
  // the state, not a companion to an empty list. Stale data still renders
  // alongside the alert.
  const loadFailed = store.isError && !store.data;
  const unsupported = (store.data?.unsupportedInstallations ?? []).filter(
    (item) => !item.retired,
  );
  const retired = (store.data?.unsupportedInstallations ?? []).filter(
    (item) => item.retired,
  );

  return (
    <main className="grid gap-4">
      <PageHeader
        title={t("list.title")}
        description={t("list.subtitle")}
        actions={
          installed.length > 0 ? (
            <Link
              to="/plugins/store"
              className={buttonVariants({ variant: "default" })}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              {canInstall ? t("list.addAction") : t("list.browseAction")}
            </Link>
          ) : undefined
        }
      />

      {store.isError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{t("list.loadError")}</AlertDescription>
        </Alert>
      )}

      {unsupported.length > 0 && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("list.unsupportedTitle")}</AlertTitle>
          <AlertDescription>
            {t("list.unsupportedBody", {
              count: unsupported.length,
              ids: unsupported.map((item) => item.pluginId).join(", "),
            })}
          </AlertDescription>
        </Alert>
      )}

      {retired.length > 0 && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("list.retiredTitle")}</AlertTitle>
          <AlertDescription>
            {t("list.retiredBody", {
              count: retired.length,
              ids: retired.map((item) => item.pluginId).join(", "),
            })}
          </AlertDescription>
        </Alert>
      )}

      {store.isLoading ? (
        <ItemGroup className="gap-2" aria-label={t("list.loading")}>
          {[0, 1].map((key) => (
            <Skeleton key={key} className="h-24 rounded-xl" />
          ))}
        </ItemGroup>
      ) : installed.length === 0 && !store.isError ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Puzzle aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("list.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("list.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link
              to="/plugins/store"
              className={buttonVariants({ variant: "default" })}
            >
              <Plus data-icon="inline-start" aria-hidden="true" />
              {canInstall ? t("list.addAction") : t("list.browseAction")}
            </Link>
          </EmptyContent>
        </Empty>
      ) : loadFailed ? null : (
        <ItemGroup className="gap-2" aria-label={t("list.installedLabel")}>
          {installed.map((entry) => (
            <InstalledPlugin key={entry.packageId} entry={entry} />
          ))}
        </ItemGroup>
      )}
    </main>
  );
}

function InstalledPlugin({ entry }: { entry: PluginStoreEntry }) {
  const { t } = useTranslation("plugins");
  const plugin: PluginSummary = entry.plugin;
  const statusKey = pluginStatusKey(plugin);
  return (
    <Item variant="outline">
      <ItemMedia variant="image" className="bg-muted">
        <PluginIcon pluginId={plugin.id} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{plugin.name}</ItemTitle>
        <ItemDescription>{plugin.description}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {hasStudioRoute(plugin.managementPath) && (
          <Link
            to={plugin.managementPath}
            className={buttonVariants({ variant: "outline", size: "sm" })}
            aria-label={t("list.openLabel", { name: plugin.name })}
          >
            {t("list.openAction")}
          </Link>
        )}
      </ItemActions>
      <ItemFooter className="justify-start gap-2 text-sm text-muted-foreground">
        <StoreProvenanceBadge source={entry.source} />
        <span className="tabular-nums">{instanceSummary(plugin)}</span>
        <span aria-hidden="true">·</span>
        <Badge
          variant={statusKey === "status.attention" ? "outline" : "secondary"}
        >
          {statusKey === "status.attention" && (
            <CircleAlert aria-hidden="true" />
          )}
          {t(statusKey)}
        </Badge>
        {plugin.attention[0] && (
          <span className="flex items-center gap-1 text-xs">
            {statusKey !== "status.attention" && (
              <CircleAlert className="size-3.5" aria-hidden="true" />
            )}
            {plugin.attention[0].message}
          </span>
        )}
      </ItemFooter>
    </Item>
  );
}
