import { useState } from "react";
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
import { PluginCatalogDialog } from "../plugins/PluginCatalogDialog";
import {
  hasStudioRoute,
  instanceSummary,
  pluginStatus,
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
          <h1 className="text-2xl font-semibold tracking-tight">Plugins</h1>
          <p className="text-sm text-muted-foreground">
            Add optional Tilecast features and integrations to this
            installation.
          </p>
        </div>
        {installed.length > 0 && (
          <Button onClick={openCatalog}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add plugin
          </Button>
        )}
      </header>

      {catalog.isError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>Plugins could not be loaded.</AlertDescription>
        </Alert>
      )}

      {unsupported.length > 0 && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Plugins from a newer Tilecast release</AlertTitle>
          <AlertDescription>
            {unsupported.map((item) => item.pluginId).join(", ")}{" "}
            {unsupported.length === 1 ? "is" : "are"} recorded as installed but
            not part of this release. {unsupported.length === 1 ? "It" : "They"}{" "}
            will not run, and {unsupported.length === 1 ? "its" : "their"} data
            is kept for when the newer release returns.
          </AlertDescription>
        </Alert>
      )}

      {catalog.isLoading ? (
        <ItemGroup className="gap-2" aria-label="Loading plugins">
          {[0, 1].map((key) => (
            <Skeleton key={key} className="h-24 rounded-2xl" />
          ))}
        </ItemGroup>
      ) : installed.length === 0 && !catalog.isError ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Puzzle aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No plugins installed</EmptyTitle>
            <EmptyDescription>
              Add only the optional features this Tilecast installation needs.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={openCatalog}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {canInstall ? "Add plugin" : "Browse plugins"}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ItemGroup className="gap-2" aria-label="Installed plugins">
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
        installError={install.error?.message}
        onInstall={onInstall}
      />
    </main>
  );
}

function InstalledPlugin({ plugin }: { plugin: PluginSummary }) {
  const status = pluginStatus(plugin);
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
            aria-label={`Open ${plugin.name}`}
          >
            Open
          </Link>
        )}
      </ItemActions>
      <ItemFooter className="justify-start gap-2 text-sm text-muted-foreground">
        <span className="tabular-nums">{instanceSummary(plugin)}</span>
        <span aria-hidden="true">·</span>
        <Badge variant={status === "Attention" ? "outline" : "secondary"}>
          {status === "Attention" && <CircleAlert aria-hidden="true" />}
          {status}
        </Badge>
        {plugin.attention[0] && (
          <span className="flex items-center gap-1 text-xs">
            {status !== "Attention" && (
              <CircleAlert className="size-3.5" aria-hidden="true" />
            )}
            {plugin.attention[0].message}
          </span>
        )}
      </ItemFooter>
    </Item>
  );
}
