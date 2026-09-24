import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Plus, Puzzle } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router";
import type { PluginSummary } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
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
import { apiErrorMessage } from "../i18n";
import { PluginCatalogDialog } from "../plugins/PluginCatalogDialog";
import {
  hasStudioRoute,
  instanceSummary,
  pluginStatusKey,
  usePluginCatalog,
  usePluginLifecycle,
} from "../plugins/pluginCatalog";
import { PluginIcon } from "../plugins/PluginIcon";
import { canManage } from "../plugins/shared";

/**
 * Plugins lists what this installation has chosen to add. Everything else the
 * release offers lives behind Add plugin. `?add=<plugin id>` opens the catalog
 * on that plugin, which is how global search reaches an uninstalled one.
 */
export function PluginsPage() {
  const { t } = useTranslation(["plugins", "common"]);
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const catalog = usePluginCatalog();
  const { install } = usePluginLifecycle(auth.status?.csrfToken ?? "");
  const canInstall = canManage(auth.status?.user?.role);
  const addParam = searchParams.get("add");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialogOpen = addParam !== null;
  const focusedId =
    selectedId ?? (addParam && addParam !== "1" ? addParam : null);

  const plugins = catalog.data?.items ?? [];
  const installed = plugins.filter((plugin) => plugin.installed);
  const unsupported = catalog.data?.unsupportedInstallations ?? [];

  const openCatalog = () => {
    install.reset();
    setSearchParams({ add: "1" });
  };
  const closeCatalog = () => {
    setSelectedId(null);
    install.reset();
    setSearchParams({});
  };
  const onInstall = (plugin: PluginSummary) => {
    install.mutate(plugin.id, {
      onSuccess: () => {
        setSelectedId(null);
        if (hasStudioRoute(plugin.managementPath)) {
          void navigate(plugin.managementPath);
        } else {
          setSearchParams({});
        }
      },
    });
  };

  return (
    <main className="grid gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("list.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("list.subtitle")}</p>
        </div>
        {installed.length > 0 && (
          <Button onClick={openCatalog}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            {t("list.addAction")}
          </Button>
        )}
      </header>

      {catalog.isError && (
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

      {catalog.isLoading ? (
        <ItemGroup className="gap-2" aria-label={t("list.loading")}>
          {[0, 1].map((key) => (
            <Skeleton key={key} className="h-24 rounded-xl" />
          ))}
        </ItemGroup>
      ) : installed.length === 0 && !catalog.isError ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Puzzle aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("list.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("list.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openCatalog}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {canInstall ? t("list.addAction") : t("list.browseAction")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ItemGroup className="gap-2" aria-label={t("list.installedLabel")}>
          {installed.map((plugin) => (
            <InstalledPlugin key={plugin.id} plugin={plugin} />
          ))}
        </ItemGroup>
      )}

      <PluginCatalogDialog
        open={dialogOpen}
        onOpenChange={(open) => (open ? openCatalog() : closeCatalog())}
        plugins={plugins}
        selectedId={focusedId}
        onSelect={(id) => {
          install.reset();
          setSelectedId(id);
          if (!id) setSearchParams({ add: "1" });
        }}
        canInstall={canInstall}
        installing={install.isPending}
        installError={
          install.error ? apiErrorMessage(install.error) : undefined
        }
        onInstall={onInstall}
      />
    </main>
  );
}

function InstalledPlugin({ plugin }: { plugin: PluginSummary }) {
  const { t } = useTranslation("plugins");
  const statusKey = pluginStatusKey(plugin);
  return (
    <Item variant="outline">
      <ItemMedia variant="image" className="bg-muted">
        <PluginIcon icon={plugin.icon} />
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
