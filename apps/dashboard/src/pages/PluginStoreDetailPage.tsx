import { useTranslation } from "react-i18next";
import { ArrowLeft, CircleAlert, Puzzle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { apiErrorMessage } from "../i18n";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import {
  hasStudioRoute,
  usePluginLifecycle,
  usePluginStoreEntry,
} from "../plugins/pluginCatalog";
import { PluginDetail } from "../plugins/PluginDetail";
import { canManage } from "../plugins/shared";

/**
 * One store entry: what the plugin is, what it needs, and the install
 * action. Installing navigates to the plugin's management page, as the old
 * Add plugin dialog did.
 */
export function PluginStoreDetailPage() {
  const { t } = useTranslation(["plugins", "common"]);
  const auth = useAuth();
  const navigate = useNavigate();
  const { id } = useParams();
  const entry = usePluginStoreEntry(id ?? "");
  const { install } = usePluginLifecycle(auth.status?.csrfToken ?? "");
  const canInstall = canManage(auth.status?.user?.role);

  const plugin = entry.data?.plugin;

  const onInstall = () => {
    if (!plugin) return;
    install.reset();
    install.mutate(plugin.id, {
      onSuccess: () => {
        if (hasStudioRoute(plugin.managementPath)) {
          void navigate(plugin.managementPath);
        } else {
          void navigate("/plugins");
        }
      },
    });
  };

  if (entry.isLoading) {
    return (
      <main className="grid gap-4" aria-label={t("list.loading")}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 rounded-xl" />
      </main>
    );
  }

  if (entry.isError || !plugin || !entry.data) {
    return (
      <main className="grid gap-4">
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Puzzle aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("store.notFoundTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("store.notFoundDescription")}
            </EmptyDescription>
          </EmptyHeader>
          <div className="flex justify-center">
            <Link
              to="/plugins/store"
              className={buttonVariants({ variant: "outline" })}
            >
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              {t("store.backToExplore")}
            </Link>
          </div>
        </Empty>
      </main>
    );
  }

  return (
    <main className="grid max-w-3xl gap-5">
      <PageHeader
        title={plugin.name}
        description={plugin.description}
        actions={
          plugin.installed && hasStudioRoute(plugin.managementPath) ? (
            <Link
              to={plugin.managementPath}
              className={buttonVariants({ variant: "outline" })}
              aria-label={t("list.openLabel", { name: plugin.name })}
            >
              {t("list.openAction")}
            </Link>
          ) : undefined
        }
      />
      <PluginDetail plugin={plugin} source={entry.data.source} />
      <Separator />
      {install.error && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{apiErrorMessage(install.error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/plugins/store"
          className={buttonVariants({ variant: "outline" })}
        >
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />
          {t("store.backToExplore")}
        </Link>
        {plugin.installed ? (
          <Button disabled>{t("catalog.installed")}</Button>
        ) : canInstall && plugin.installable ? (
          <Button disabled={install.isPending} onClick={onInstall}>
            {install.isPending && (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            )}
            {t("catalog.install")}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("catalog.installNote")}
          </p>
        )}
      </div>
    </main>
  );
}
