import { useTranslation } from "react-i18next";
import { ArrowLeft, CircleAlert, Puzzle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { cn } from "cn";
import type {
  PluginStoreEntry,
  PluginStoreMarketplace,
  PluginSummary,
} from "../api/types";
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
import { MarketplaceDetail } from "../plugins/MarketplaceDetail";
import { PluginDetail } from "../plugins/PluginDetail";
import { PluginIcon } from "../plugins/PluginIcon";
import { canManage } from "../plugins/shared";
import { StoreProvenanceBadge } from "../plugins/StoreProvenance";

export function PluginStoreDetailPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { id } = useParams();
  const entry = usePluginStoreEntry(id ?? "");
  const { install } = usePluginLifecycle(auth.status?.csrfToken ?? "");

  if (entry.isLoading) return <StoreDetailLoading />;
  if (isPluginNotFound(entry.error)) return <StoreDetailNotFound />;
  if (entry.isError || !entry.data || !hasStoreDetail(entry.data)) {
    return <StoreDetailLoadError />;
  }

  const installPlugin = (plugin: PluginSummary) => {
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
    <StoreDetailContent
      entry={entry.data}
      canInstall={canManage(auth.status?.user?.role)}
      installing={install.isPending}
      installError={install.error}
      onInstall={installPlugin}
    />
  );
}

function hasStoreDetail(entry: PluginStoreEntry) {
  return Boolean(entry.plugin || entry.marketplace);
}

function isPluginNotFound(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.code === "plugin_not_found"
  );
}

function StoreDetailContent({
  entry,
  canInstall,
  installing,
  installError,
  onInstall,
}: {
  entry: PluginStoreEntry;
  canInstall: boolean;
  installing: boolean;
  installError: unknown;
  onInstall: (plugin: PluginSummary) => void;
}) {
  const { t } = useTranslation("plugins");
  const plugin = entry.plugin;
  const listing = entry.marketplace;
  const title = plugin?.name ?? listing?.name ?? entry.packageId;
  const description = plugin?.description ?? listing?.description ?? "";

  return (
    <main className="grid max-w-3xl gap-5">
      <div className="flex items-start gap-3">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted">
          {plugin ? (
            <PluginIcon pluginId={plugin.id} />
          ) : (
            <Puzzle aria-hidden="true" />
          )}
        </div>
        <PageHeader
          className="min-w-0 flex-1"
          title={title}
          description={description}
          eyebrow={
            <span className="flex flex-wrap items-center gap-1.5">
              {plugin && <Badge variant="outline">{plugin.category}</Badge>}
              <StoreProvenanceBadge source={entry.source} />
            </span>
          }
          actions={
            plugin ? (
              <IncludedPluginAction
                plugin={plugin}
                canInstall={canInstall}
                installing={installing}
                onInstall={() => onInstall(plugin)}
              />
            ) : undefined
          }
        />
      </div>

      {plugin ? (
        <PluginDetail plugin={plugin} />
      ) : (
        <MarketplaceDetail listing={listing as PluginStoreMarketplace} />
      )}

      {installError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{apiErrorMessage(installError)}</AlertDescription>
        </Alert>
      )}

      {listing && (
        <p className="text-sm text-muted-foreground">
          {t("store.detail.installUnavailable")}
        </p>
      )}
      {plugin && !plugin.installed && (!canInstall || !plugin.installable) && (
        <p className="text-sm text-muted-foreground">
          {t("catalog.installNote")}
        </p>
      )}

      <StoreBackLink />
    </main>
  );
}

function IncludedPluginAction({
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
