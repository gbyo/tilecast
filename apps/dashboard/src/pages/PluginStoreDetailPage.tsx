import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, CircleAlert, Puzzle } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import { cn } from "cn";
import type {
  GitHubInstallReview,
  PluginStoreCustom,
  PluginStoreEntry,
  PluginStoreMarketplace,
  PluginSummary,
} from "../api/types";
import { ApiError } from "../api/client";
import { apiErrorMessage } from "../i18n";
import { useAuth } from "../auth/AuthProvider";
import { useConfirm } from "../components/ConfirmDialog";
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
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import {
  diffContributions,
  hasStudioRoute,
  inUseResources,
  usePackage,
  usePackageLifecycle,
  usePluginLifecycle,
  usePluginStoreEntry,
} from "../plugins/pluginCatalog";
import { CustomDetail } from "../plugins/CustomDetail";
import { InstallReview } from "../plugins/InstallReview";
import { MarketplaceDetail } from "../plugins/MarketplaceDetail";
import { PackageJobs } from "../plugins/PackageJobs";
import { PackageStudioUI } from "../plugins/PackageStudioUI";
import { PluginDetail } from "../plugins/PluginDetail";
import { PluginIcon } from "../plugins/PluginIcon";
import { canManage } from "../plugins/shared";
import { StoreProvenanceBadge } from "../plugins/StoreProvenance";

/**
 * One store entry: what the plugin or package is, what it needs, and the
 * install action. Installing a release-owned plugin navigates to its
 * management page, as the old Add plugin dialog did. Installed external
 * packages manage here: update checks, rollback, and removal.
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
  // The route reuses this page across listings; a review belongs to
  // the listing that requested it. Reset through a ref so settling
  // the mutation does not wipe its own result.
  const reviewMutationRef = useRef(reviewMarketplaceMutation);
  reviewMutationRef.current = reviewMarketplaceMutation;
  useEffect(() => {
    reviewMutationRef.current.reset();
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
    packages.install.mutate({
      packageId: data.packageId,
      repository:
        data.source.kind === "custom" ? data.source.repository : undefined,
    });
  };

  // Marketplace installs review first: resolve the pinned artifact,
  // show the published manifest, and only activate on confirmation.
  const reviewMarketplace = () => {
    packages.install.reset();
    reviewMarketplaceMutation.reset();
    reviewMarketplaceMutation.mutate(data.packageId);
  };

  return (
    <StoreDetailContent
      entry={data}
      csrfToken={csrfToken}
      canInstall={canManage(auth.status?.user?.role)}
      installing={install.isPending}
      installError={
        install.error ??
        packages.install.error ??
        reviewMarketplaceMutation.error
      }
      onInstall={installPlugin}
      onInstallExternal={installExternal}
      externalInstalling={packages.install.isPending}
      marketplaceReview={reviewMarketplaceMutation.data}
      reviewingMarketplace={reviewMarketplaceMutation.isPending}
      onReviewMarketplace={reviewMarketplace}
      onCancelReview={() => reviewMarketplaceMutation.reset()}
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

function StoreDetailContent({
  entry,
  csrfToken,
  canInstall,
  installing,
  installError,
  onInstall,
  onInstallExternal,
  externalInstalling,
  marketplaceReview,
  reviewingMarketplace,
  onReviewMarketplace,
  onCancelReview,
}: {
  entry: PluginStoreEntry;
  csrfToken: string;
  canInstall: boolean;
  installing: boolean;
  installError: unknown;
  onInstall: (plugin: PluginSummary) => void;
  onInstallExternal: () => void;
  externalInstalling: boolean;
  marketplaceReview: GitHubInstallReview | undefined;
  reviewingMarketplace: boolean;
  onReviewMarketplace: () => void;
  onCancelReview: () => void;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const plugin = entry.plugin;
  const listing = entry.marketplace;
  const custom = entry.custom;
  const external = listing ?? custom;
  // A resolve in flight across navigation must never confirm another
  // listing's install.
  const review =
    marketplaceReview?.packageId === entry.packageId
      ? marketplaceReview
      : undefined;
  const title = plugin?.name ?? external?.name ?? entry.packageId;
  const description = plugin?.description ?? external?.description ?? "";

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
            ) : external ? (
              <ExternalPackageAction
                external={external}
                canInstall={canInstall}
                installing={listing ? reviewingMarketplace : externalInstalling}
                onInstall={listing ? onReviewMarketplace : onInstallExternal}
                reviewFirst={Boolean(listing)}
              />
            ) : undefined
          }
        />
      </div>

      {plugin ? (
        <PluginDetail plugin={plugin} />
      ) : listing ? (
        <MarketplaceDetail listing={listing} />
      ) : (
        custom && <CustomDetail custom={custom} source={entry.source} />
      )}

      {installError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{apiErrorMessage(installError)}</AlertDescription>
        </Alert>
      ) : null}

      {listing && !listing.installed && review && (
        <div className="grid gap-3 rounded-xl border p-4">
          <InstallReview review={review} updatePlane="catalog" />
          {canInstall && (
            <div className="flex gap-2">
              <Button
                disabled={externalInstalling || !review.compatible}
                onClick={onInstallExternal}
              >
                {externalInstalling && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {externalInstalling
                  ? t("store.add.installing")
                  : t("store.add.install")}
              </Button>
              <Button variant="outline" onClick={onCancelReview}>
                {t("common:actions.cancel")}
              </Button>
            </div>
          )}
        </div>
      )}

      {external &&
        !external.installed &&
        (!canInstall || !external.compatible) && (
          <p className="text-sm text-muted-foreground">
            {t("catalog.installNote")}
          </p>
        )}
      {plugin && !plugin.installed && (!canInstall || !plugin.installable) && (
        <p className="text-sm text-muted-foreground">
          {t("catalog.installNote")}
        </p>
      )}
      {external?.installed && (
        <>
          <Separator />
          <PackageManagement
            packageId={entry.packageId}
            csrfToken={csrfToken}
            canInstall={canInstall}
          />
        </>
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

function ExternalPackageAction({
  external,
  canInstall,
  installing,
  onInstall,
  reviewFirst = false,
}: {
  external: PluginStoreMarketplace | PluginStoreCustom;
  canInstall: boolean;
  installing: boolean;
  onInstall: () => void;
  reviewFirst?: boolean;
}) {
  const { t } = useTranslation("plugins");

  if (external.installed) {
    return <Button disabled>{t("catalog.installed")}</Button>;
  }
  if (!canInstall || !external.compatible) return null;
  return (
    <Button disabled={installing} onClick={onInstall}>
      {installing && <Spinner data-icon="inline-start" aria-hidden="true" />}
      {reviewFirst ? t("catalog.reviewInstall") : t("catalog.install")}
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

/**
 * The installed package beneath its store entry: contributions, update
 * checks, rollback, and removal. An update check resolves without
 * activating; applying activates the checked digest, and a stale digest
 * answers update_check_expired instead of installing old bytes.
 */
function PackageManagement({
  packageId,
  csrfToken,
  canInstall,
}: {
  packageId: string;
  csrfToken: string;
  canInstall: boolean;
}) {
  const { t } = useTranslation(["plugins", "common"]);
  const navigate = useNavigate();
  const pkg = usePackage(packageId);
  const { checkUpdate, applyUpdate, rollback, remove } =
    usePackageLifecycle(csrfToken);
  const { confirm, dialog: confirmDialog } = useConfirm();
  const check = checkUpdate.data;
  const latest = check?.available ? check.latest : undefined;
  // A blocked operation names its remaining content; anything else
  // renders as a plain error.
  const operationErrors = [
    checkUpdate.error,
    applyUpdate.error,
    rollback.error,
    remove.error,
  ];
  const blockerError = operationErrors.find(
    (error) => inUseResources(error) !== null,
  );
  const blockers =
    blockerError === undefined ? null : inUseResources(blockerError);
  const plainError = operationErrors.find(
    (error) => error !== undefined && inUseResources(error) === null,
  );

  const onRemove = async () => {
    const confirmed = await confirm({
      title: t("packages.removeConfirmTitle"),
      body: t("packages.removeConfirmBody", { packageId }),
      action: t("packages.remove"),
      cancel: t("common:actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    remove.mutate(packageId, {
      onSuccess: () => void navigate("/plugins/store"),
    });
  };

  if (pkg.isLoading) {
    return <Skeleton className="h-32 rounded-xl" />;
  }
  if (pkg.isError || !pkg.data) {
    return (
      <Alert variant="destructive">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{t("packages.loadError")}</AlertDescription>
      </Alert>
    );
  }
  const installed = pkg.data;
  return (
    <section aria-label={t("packages.manageTitle")} className="grid gap-4">
      {confirmDialog}
      <h2 className="text-base font-semibold">{t("packages.manageTitle")}</h2>
      {plainError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{apiErrorMessage(plainError)}</AlertDescription>
        </Alert>
      )}
      {blockerError && blockers && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertDescription className="grid gap-2">
            <p>{apiErrorMessage(blockerError)}</p>
            <ul className="list-disc pl-5">
              {blockers.map((blocker) => (
                <li key={blocker.kind}>
                  {t("packages.blockedResource", {
                    count: blocker.count,
                    label: blocker.label,
                  })}
                </li>
              ))}
            </ul>
            <p>{t("packages.blockedInstruction")}</p>
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid gap-3 text-sm">
        <div className="grid gap-1">
          <dt className="font-medium">{t("store.detail.digestLabel")}</dt>
          <dd className="font-mono text-xs break-all text-muted-foreground">
            {installed.digest}
          </dd>
        </div>
        <div className="grid gap-1">
          <dt className="font-medium">{t("packages.contributions")}</dt>
          <dd className="text-muted-foreground">
            {installed.contributions.length === 0
              ? t("store.review.noContributions")
              : installed.contributions
                  .map(
                    (contribution) =>
                      `${contribution.kind} · ${contribution.id}`,
                  )
                  .join(", ")}
          </dd>
        </div>
      </dl>
      {canInstall && installed.capabilities?.studioUI && (
        <PackageStudioUI packageId={packageId} csrfToken={csrfToken} />
      )}
      {installed.capabilities?.background && (
        <PackageJobs packageId={packageId} />
      )}
      {latest && (
        <div className="grid gap-3 rounded-xl border p-4">
          <InstallReview review={latest} />
          <ContributionChanges
            current={installed.contributions}
            next={latest.contributions}
          />
          {canInstall && (
            <div>
              <Button
                disabled={applyUpdate.isPending || !latest.compatible}
                onClick={() =>
                  applyUpdate.mutate({
                    packageId,
                    digest: latest.digest,
                  })
                }
              >
                {applyUpdate.isPending && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {t("packages.updateTo", { version: latest.version })}
              </Button>
            </div>
          )}
        </div>
      )}
      {check && !check.available && (
        <p className="text-sm text-muted-foreground">
          {t("packages.upToDate")}
        </p>
      )}
      {canInstall && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={checkUpdate.isPending}
            onClick={() => {
              applyUpdate.reset();
              checkUpdate.mutate(packageId);
            }}
          >
            {checkUpdate.isPending && (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            )}
            {t("packages.checkUpdate")}
          </Button>
          {installed.hasRollback && (
            <Button
              variant="outline"
              disabled={rollback.isPending}
              onClick={() => rollback.mutate(packageId)}
            >
              {rollback.isPending && (
                <Spinner data-icon="inline-start" aria-hidden="true" />
              )}
              {t("packages.rollback")}
            </Button>
          )}
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={() => void onRemove()}
          >
            {t("packages.remove")}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * What an update changes about contributions. Removals name what would
 * strand: updating deletes nothing, and an update that drops a
 * contribution persisted content still uses waits until the operator
 * deletes it.
 */
function ContributionChanges({
  current,
  next,
}: {
  current: { kind: string; path: string; id?: string }[];
  next: { type: string; path: string; id?: string }[];
}) {
  const { t } = useTranslation("plugins");
  const { added, removed } = diffContributions(current, next);
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div className="grid gap-2 text-sm">
      {added.length > 0 && (
        <div className="grid gap-1">
          <p className="font-medium">{t("packages.addedContributions")}</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {added.map((change) => (
              <li key={`${change.kind} ${change.path} ${change.id ?? ""}`}>
                {change.kind} · {change.path}
                {change.id && (
                  <span className="block font-mono text-xs">{change.id}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {removed.length > 0 && (
        <div className="grid gap-1">
          <p className="font-medium">{t("packages.removedContributions")}</p>
          <ul className="list-disc pl-5 text-muted-foreground">
            {removed.map((change) => (
              <li key={`${change.kind} ${change.path} ${change.id ?? ""}`}>
                {change.kind} · {change.path}
                {change.id && (
                  <span className="block font-mono text-xs">{change.id}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            {t("packages.removedWarning")}
          </p>
        </div>
      )}
    </div>
  );
}
