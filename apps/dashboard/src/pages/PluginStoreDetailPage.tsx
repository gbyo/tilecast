import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, Puzzle } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import type { PluginStoreEntry, PluginSummary } from "../api/types";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import {
  hasStudioRoute,
  usePackageLifecycle,
  usePluginLifecycle,
  usePluginStoreEntry,
} from "../plugins/pluginCatalog";
import { StoreBackLink, StoreDetail } from "../plugins/detail/StoreDetail";
import { canManage } from "../plugins/shared";

/**
 * One store entry: what the plugin or package is, what it can do, and the
 * install action. Installing a release-owned plugin navigates to its
 * management page, as the old Add plugin dialog did. Installed external
 * packages manage here: update checks, rollback, and removal. The page owns
 * the data and the mutations; `StoreDetail` owns the layout.
 */
export function PluginStoreDetailPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { id } = useParams();
  const entry = usePluginStoreEntry(id ?? "");
  const csrfToken = auth.status?.csrfToken ?? "";
  const { install } = usePluginLifecycle(csrfToken);
  const packages = usePackageLifecycle(csrfToken);
  const reviewMarketplaceMutation = packages.resolveMarketplace;
  // The route reuses this page across listings; a review or an update
  // check belongs to the listing that requested it. Reset through a ref so
  // settling a mutation does not wipe its own result.
  const packagesRef = useRef(packages);
  packagesRef.current = packages;
  useEffect(() => {
    const current = packagesRef.current;
    current.resolveMarketplace.reset();
    current.checkUpdate.reset();
    current.applyUpdate.reset();
    current.rollback.reset();
    current.remove.reset();
  }, [id]);

  if (entry.isLoading) return <StoreDetailLoading />;
  if (isPluginNotFound(entry.error)) return <StoreDetailNotFound />;
  if (entry.isError || !entry.data || !hasStoreDetail(entry.data)) {
    return <StoreDetailLoadError />;
  }
  const data = entry.data;

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

  const installExternal = () => {
    packages.install.reset();
    packages.install.mutate(
      {
        packageId: data.packageId,
        repository:
          data.source.kind === "custom" ? data.source.repository : undefined,
      },
      { onSuccess: () => reviewMarketplaceMutation.reset() },
    );
  };

  // Marketplace installs review first: resolve the pinned artifact,
  // show the published manifest, and only activate on confirmation.
  const reviewMarketplace = () => {
    packages.install.reset();
    reviewMarketplaceMutation.reset();
    reviewMarketplaceMutation.mutate(data.packageId);
  };

  const review =
    reviewMarketplaceMutation.data?.packageId === data.packageId
      ? reviewMarketplaceMutation.data
      : undefined;

  return (
    <StoreDetail
      entry={data}
      csrfToken={csrfToken}
      canInstall={canManage(auth.status?.user?.role)}
      installingPlugin={install.isPending}
      onInstallPlugin={installPlugin}
      installingExternal={packages.install.isPending}
      onInstallExternal={installExternal}
      review={review}
      resolvingReview={reviewMarketplaceMutation.isPending}
      onReviewMarketplace={reviewMarketplace}
      onCancelReview={() => reviewMarketplaceMutation.reset()}
      installError={install.error ?? reviewMarketplaceMutation.error}
      packages={packages}
      onRemoved={() => void navigate("/plugins/store")}
    />
  );
}

function hasStoreDetail(entry: PluginStoreEntry) {
  return Boolean(entry.plugin || entry.marketplace || entry.custom);
}

function isPluginNotFound(error: unknown) {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.code === "plugin_not_found"
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
