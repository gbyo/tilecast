import { useTranslation } from "react-i18next";
import { ArrowLeft, CircleAlert, Puzzle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { cn } from "cn";
import type { PluginSummary } from "../api/types";
import { ApiError } from "../api/client";
import { apiErrorMessage } from "../i18n";
import { useAuth } from "../auth/AuthProvider";
import { PageHeader } from "../components/PageHeader";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import {
  hasStudioRoute,
  usePluginLifecycle,
  usePluginStoreEntry,
} from "../plugins/pluginCatalog";
import { PluginDetail } from "../plugins/PluginDetail";
import { PluginIcon } from "../plugins/PluginIcon";
import { canManage } from "../plugins/shared";
import { StoreProvenanceBadge } from "../plugins/StoreProvenance";

/**
 * One store entry: identity and provenance once, then requirements and the
 * lifecycle action. Installing an included plugin keeps the existing Plugin
 * API lifecycle and opens its management page when Studio has one.
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

  if (entry.isLoading) return <StoreDetailLoading />;
  if (isPluginNotFound(entry.error)) return <StoreDetailNotFound />;
  if (entry.isError || !plugin || !entry.data) return <StoreDetailLoadError />;

  const installPlugin = () => {
    install.reset();
    install.mutate(plugin.id, {
      onSuccess: () =>
        void navigate(
          hasStudioRoute(plugin.managementPath)
            ? plugin.managementPath
            : "/plugins",
        ),
    });
  };

  return (
    <main className="grid max-w-3xl gap-5">
      <div className="flex items-start gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted">
          <PluginIcon pluginId={plugin.id} />
        </div>
        <PageHeader
          className="min-w-0 flex-1"
          title={plugin.name}
          description={plugin.description}
          eyebrow={
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline">{plugin.category}</Badge>
              <StoreProvenanceBadge source={entry.data.source} />
            </span>
          }
          actions={
            <StoreDetailAction
              plugin={plugin}
              canInstall={canInstall}
              installing={install.isPending}
              onInstall={installPlugin}
            />
          }
        />
      </div>

      <PluginDetail plugin={plugin} />

      {install.error && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{apiErrorMessage(install.error)}</AlertDescription>
        </Alert>
      )}

      {!plugin.installed && (!canInstall || !plugin.installable) && (
        <p className="text-sm text-muted-foreground">
          {t("catalog.installNote")}
        </p>
      )}

      <StoreBackLink />
    </main>
  );
}

function isPluginNotFound(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.code === "plugin_not_found"
  );
}

function StoreDetailAction({
  plugin,
  canInstall,
  installing,
  onInstall,
}: {
  plugin: PluginSummary;
  canInstall: boolean;
  installing: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation("plugins");

  if (plugin.installed && hasStudioRoute(plugin.managementPath)) {
    return (
      <Link
        to={plugin.managementPath}
        className={buttonVariants({ variant: "default" })}
        aria-label={t("list.openLabel", { name: plugin.name })}
      >
        {t("list.openAction")}
      </Link>
    );
  }
  if (plugin.installed) {
    return <Button disabled>{t("catalog.installed")}</Button>;
  }
  if (!canInstall || !plugin.installable) return null;
  return (
    <Button disabled={installing} onClick={onInstall}>
      {installing && <Spinner data-icon="inline-start" aria-hidden="true" />}
      {t("catalog.install")}
    </Button>
  );
}

function StoreDetailLoading() {
  const { t } = useTranslation("plugins");
  return (
    <main className="grid gap-4" aria-label={t("list.loading")}>
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 rounded-xl" />
    </main>
  );
}

function StoreDetailNotFound() {
  const { t } = useTranslation("plugins");
  return (
    <main className="grid gap-4">
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Puzzle aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{t("store.notFoundTitle")}</EmptyTitle>
          <EmptyDescription>{t("store.notFoundDescription")}</EmptyDescription>
        </EmptyHeader>
        <div className="flex justify-center">
          <StoreBackLink />
        </div>
      </Empty>
    </main>
  );
}

function StoreDetailLoadError() {
  const { t } = useTranslation("plugins");
  return (
    <main className="grid gap-4">
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{t("store.loadError")}</AlertDescription>
      </Alert>
      <StoreBackLink />
    </main>
  );
}

function StoreBackLink() {
  const { t } = useTranslation("plugins");
  return (
    <Link
      to="/plugins/store"
      className={cn(buttonVariants({ variant: "outline" }), "w-fit")}
    >
      <ArrowLeft data-icon="inline-start" aria-hidden="true" />
      {t("store.backToExplore")}
    </Link>
  );
}
