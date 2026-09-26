import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { apiErrorMessage } from "../i18n";
import { usePluginCatalog, usePluginLifecycle } from "./pluginCatalog";
import { PluginIcon } from "./PluginIcon";
import { canManage } from "./shared";

/**
 * Guards a plugin's management routes. Routes stay statically registered;
 * installation is a domain check, so a bookmark to an uninstalled plugin shows
 * how to add it instead of a page whose every save would be refused. Opening a
 * link never installs anything by itself.
 */
export function PluginRouteGate({
  pluginId,
  children,
}: {
  pluginId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("plugins");
  const auth = useAuth();
  const catalog = usePluginCatalog();
  const { install } = usePluginLifecycle(auth.status?.csrfToken ?? "");
  const plugin = catalog.data?.items.find((item) => item.id === pluginId);

  if (catalog.isLoading)
    return (
      <div className="grid gap-4" aria-busy="true">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  // The server enforces installation on every mutation, so an unreadable
  // catalog falls back to the page rather than hiding it.
  if (!plugin || plugin.installed) return <>{children}</>;
  const canInstall = canManage(auth.status?.user?.role) && plugin.installable;
  return (
    <main className="grid gap-4">
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PluginIcon pluginId={plugin.id} />
          </EmptyMedia>
          <EmptyTitle>
            {t("gate.notInstalled", { name: plugin.name })}
          </EmptyTitle>
          <EmptyDescription>
            {canInstall
              ? t("gate.installDescription", {
                  name: plugin.name,
                  description: plugin.description,
                })
              : t("gate.lockedDescription", {
                  description: plugin.description,
                })}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {install.error && (
            <Alert variant="destructive">
              <AlertDescription>
                {apiErrorMessage(install.error)}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            {canInstall && (
              <Button
                disabled={install.isPending}
                onClick={() => install.mutate(plugin.id)}
              >
                {install.isPending && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {t("gate.installAction", { name: plugin.name })}
              </Button>
            )}
            <Link
              to="/plugins"
              className={buttonVariants({ variant: "outline" })}
            >
              {t("gate.backToPlugins")}
            </Link>
          </div>
        </EmptyContent>
      </Empty>
    </main>
  );
}
