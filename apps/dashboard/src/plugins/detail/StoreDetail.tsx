import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import type {
  GitHubInstallReview,
  InstalledPackage,
  PluginStoreEntry,
  PluginSummary,
} from "../../api/types";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { buttonVariants } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { useWideLayout } from "../../hooks/use-wide-layout";
import { PackageJobs } from "../PackageJobs";
import { PackageStudioUI } from "../PackageStudioUI";
import { usePackage, type usePackageLifecycle } from "../pluginCatalog";
import {
  AboutSection,
  CapabilitiesSection,
  ContributionsSection,
  RequirementsSection,
} from "./DetailSections";
import { PackageAboutCard, PackageStatusCard } from "./DetailSidebar";
import {
  buildDetailView,
  contributionRows,
  primaryAction,
  type PluginDetailViewModel,
} from "./detailView";
import { OperationError } from "./OperationError";
import { PackageDangerZone, PackageManagement } from "./PackageManagement";
import { PackageReviewDialog } from "./PackageReviewDialog";
import { PluginDetailHero } from "./PluginDetailHero";
import { PluginScreenshotCarousel } from "./PluginScreenshotCarousel";
import { PrimaryActionControl } from "./PrimaryActionControl";
import { IncompatibleAlert } from "./ReviewBody";
import { TechnicalDetails } from "./TechnicalDetails";
import { technicalRows } from "./technicalDetailsModel";

const incompatibleId = "detail-incompatible";

export function StoreBackLink() {
  const { t } = useTranslation("plugins");
  return (
    <Link
      to="/plugins/store"
      className={buttonVariants({
        variant: "ghost",
        size: "sm",
        className: "-ml-2 w-fit",
      })}
    >
      <ArrowLeft data-icon="inline-start" aria-hidden="true" />
      {t("store.backToExplore")}
    </Link>
  );
}

/**
 * Everything that went wrong or blocks the action, in one place above the
 * content. Renders nothing, not an empty row, when there is nothing to say.
 */
function DetailAlerts({
  view,
  installError,
  operationError,
  updateError,
  packageLoadFailed,
}: {
  view: PluginDetailViewModel;
  installError: unknown;
  operationError: unknown;
  updateError: unknown;
  packageLoadFailed: boolean;
}) {
  const { t } = useTranslation("plugins");
  const any =
    !view.compatible ||
    Boolean(installError) ||
    Boolean(operationError) ||
    Boolean(updateError) ||
    packageLoadFailed;
  if (!any) return null;
  return (
    <div className="order-2 grid gap-3 xl:order-none xl:-order-1 xl:col-span-2">
      {!view.compatible && (
        <IncompatibleAlert id={incompatibleId} range={view.tilecastRange} />
      )}
      <OperationError error={installError} />
      <OperationError error={operationError} />
      <OperationError error={updateError} />
      {packageLoadFailed && (
        <Alert variant="destructive">
          <AlertDescription>{t("packages.loadError")}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/**
 * The management column of an installed package: settings, jobs, rollback,
 * and removal, in that order. Rollback and removal clear each other's error
 * so only the latest operation speaks.
 */
function PackageManageBlock({
  view,
  installedPackage,
  csrfToken,
  showSettings,
  showJobs,
  packages,
  onRemoved,
}: {
  view: PluginDetailViewModel;
  installedPackage: InstalledPackage;
  csrfToken: string;
  showSettings: boolean;
  showJobs: boolean;
  packages: ReturnType<typeof usePackageLifecycle>;
  onRemoved: () => void;
}) {
  const { rollback, remove } = packages;
  return (
    <div className="order-7 grid content-start gap-8 xl:order-none xl:col-start-1">
      {showSettings && (
        <PackageStudioUI packageId={view.packageId} csrfToken={csrfToken} />
      )}
      {showJobs && <PackageJobs packageId={view.packageId} />}
      {installedPackage.hasRollback && (
        <PackageManagement
          name={view.name}
          pending={rollback.isPending}
          error={rollback.error}
          onRollback={() => {
            rollback.reset();
            remove.reset();
            rollback.mutate(view.packageId);
          }}
        />
      )}
      <PackageDangerZone
        packageId={view.packageId}
        pending={remove.isPending}
        error={remove.error}
        onRemove={() => {
          rollback.reset();
          remove.reset();
          remove.mutate(view.packageId, { onSuccess: onRemoved });
        }}
      />
    </div>
  );
}

/**
 * One store entry as a product page: hero, optional screenshots, main
 * content, and a sticky sidebar on wide viewports; one column on narrow
 * ones, with the primary action and status directly below the hero. Every
 * source shares this shell; the view model carries what differs.
 *
 * The grid's source order is the narrow-viewport reading order, set with
 * `order`. At the wide breakpoint every `order` resets and explicit
 * columns take over, so the DOM order stays the tab order on both.
 */
export function StoreDetail({
  entry,
  csrfToken,
  canInstall,
  installingPlugin,
  onInstallPlugin,
  installingExternal,
  onInstallExternal,
  review,
  resolvingReview,
  onReviewMarketplace,
  onCancelReview,
  installError,
  packages,
  onRemoved,
}: {
  entry: PluginStoreEntry;
  csrfToken: string;
  canInstall: boolean;
  installingPlugin: boolean;
  onInstallPlugin: (plugin: PluginSummary) => void;
  installingExternal: boolean;
  onInstallExternal: () => void;
  /** The marketplace review for this entry, once resolved. */
  review: GitHubInstallReview | undefined;
  resolvingReview: boolean;
  onReviewMarketplace: () => void;
  onCancelReview: () => void;
  installError: unknown;
  packages: ReturnType<typeof usePackageLifecycle>;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("plugins");
  const wide = useWideLayout();
  const view = buildDetailView(entry);
  const managed = Boolean(view?.external && view.installed);
  const installedQuery = usePackage(entry.packageId, managed);
  const [updateOpen, setUpdateOpen] = useState(false);
  if (!view) return null;

  const installedPackage = managed ? installedQuery.data : undefined;
  const { checkUpdate, applyUpdate } = packages;
  const check =
    checkUpdate.data?.installed.packageId === view.packageId
      ? checkUpdate.data
      : undefined;
  const latest = check?.available ? check.latest : undefined;
  const updateAvailable = latest !== undefined || view.updateAvailable;
  const action = primaryAction(view, canInstall);
  const marketplaceReview = view.installed ? undefined : review;
  const externalError = packages.install.error;

  const runPrimary = () => {
    if (view.plugin) onInstallPlugin(view.plugin);
    else if (view.sourceKind === "marketplace") onReviewMarketplace();
    else onInstallExternal();
  };
  const pending = view.plugin
    ? installingPlugin
    : view.sourceKind === "marketplace"
      ? resolvingReview
      : installingExternal;

  const actionControl = (className?: string) => (
    <PrimaryActionControl
      action={action}
      name={view.name}
      pending={pending}
      onRun={runPrimary}
      describedBy={incompatibleId}
      className={className}
    />
  );
  // Where the wide-viewport hero carries the action, the card keeps only the
  // reason there is none.
  const needsNote = action.kind === "none" && !view.installed;
  const note = needsNote ? (
    <p className="text-sm text-muted-foreground">{t("catalog.installNote")}</p>
  ) : null;

  const contributions =
    installedPackage === undefined
      ? null
      : contributionRows(installedPackage.contributions);
  const capabilities =
    installedPackage === undefined ? null : installedPackage.capabilities;
  const loadingPackage = managed && installedQuery.isLoading;

  const technical = view.external
    ? technicalRows(
        {
          packageId: view.packageId,
          digest: installedPackage?.digest ?? view.digest,
          registry: installedPackage?.registryReference,
          signer: installedPackage?.signerIdentity,
          source: installedPackage?.sourceReference,
          runtimeModule: installedPackage?.runtime?.module,
          jobIds: installedPackage?.capabilities?.background?.jobs.map(
            (job) => job.id,
          ),
          contributions: installedPackage?.contributions,
        },
        t,
      )
    : [];

  const manageable = canInstall && managed;
  const settings = manageable && installedPackage?.capabilities?.studioUI;
  const jobs = manageable && installedPackage?.capabilities?.background;
  const hasManageBlock = manageable && installedPackage !== undefined;

  return (
    <main className="mx-auto grid w-full max-w-6xl gap-6">
      <StoreBackLink />
      <PluginDetailHero
        view={view}
        updateAvailable={updateAvailable}
        action={wide ? actionControl("min-w-36") : undefined}
      />

      <div className="grid gap-x-10 gap-y-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:gap-y-8">
        <DetailAlerts
          view={view}
          installError={installError}
          operationError={marketplaceReview ? undefined : externalError}
          updateError={checkUpdate.error}
          packageLoadFailed={managed && installedQuery.isError}
        />

        {view.screenshots.length > 0 && (
          <div className="order-3 xl:order-none xl:col-span-2">
            <PluginScreenshotCarousel screenshots={view.screenshots} />
          </div>
        )}

        <div className="order-4 grid content-start gap-8 xl:order-none xl:col-start-1">
          <AboutSection view={view} />
          <ContributionsSection
            view={view}
            contributions={contributions}
            loading={loadingPackage}
          />
          <CapabilitiesSection
            view={view}
            capabilities={capabilities}
            loading={loadingPackage}
          />
          <RequirementsSection view={view} />
        </div>

        <div
          className={
            "contents xl:sticky xl:top-6 xl:col-start-2 xl:grid xl:content-start xl:gap-4 xl:self-start" +
            (hasManageBlock ? " xl:row-span-2" : "")
          }
        >
          <div className="order-1 xl:order-none">
            <PackageStatusCard
              view={view}
              installedPackage={installedPackage}
              latestVersion={
                latest?.version ??
                (view.updateAvailable ? view.version : undefined)
              }
              primaryAction={
                needsNote ? note : wide ? null : actionControl("w-full")
              }
              update={
                manageable
                  ? {
                      checking: checkUpdate.isPending,
                      onCheck: () => {
                        applyUpdate.reset();
                        checkUpdate.mutate(view.packageId);
                      },
                      upToDate: Boolean(check && !check.available),
                      resolved: Boolean(latest && installedPackage),
                      // A listing can already know there is an update. Review
                      // then resolves it first and opens the surface as soon
                      // as the resolved review is in hand.
                      onReview: () => {
                        if (latest && installedPackage) {
                          setUpdateOpen(true);
                          return;
                        }
                        applyUpdate.reset();
                        checkUpdate.mutate(view.packageId, {
                          onSuccess: (result) => {
                            if (result.available) setUpdateOpen(true);
                          },
                        });
                      },
                    }
                  : undefined
              }
            />
          </div>
          <div className="order-5 xl:order-none">
            <PackageAboutCard view={view} installedPackage={installedPackage} />
          </div>
          {technical.length > 0 && (
            <div className="order-6 xl:order-none">
              <TechnicalDetails rows={technical} />
            </div>
          )}
        </div>

        {hasManageBlock && installedPackage && (
          <PackageManageBlock
            view={view}
            installedPackage={installedPackage}
            csrfToken={csrfToken}
            showSettings={Boolean(settings)}
            showJobs={Boolean(jobs)}
            packages={packages}
            onRemoved={onRemoved}
          />
        )}
      </div>

      {managed && installedQuery.isLoading && (
        <Skeleton className="h-24 rounded-xl" />
      )}

      {marketplaceReview && (
        <PackageReviewDialog
          open
          onOpenChange={(open) => {
            if (!open) onCancelReview();
          }}
          review={marketplaceReview}
          updatePlane="catalog"
          canConfirm={canInstall}
          confirming={installingExternal}
          onConfirm={onInstallExternal}
          error={packages.install.error}
        />
      )}
      {latest && installedPackage && (
        <PackageReviewDialog
          open={updateOpen}
          onOpenChange={setUpdateOpen}
          review={latest}
          installed={installedPackage}
          canConfirm={canInstall}
          confirming={applyUpdate.isPending}
          error={applyUpdate.error}
          onConfirm={() =>
            applyUpdate.mutate(
              { packageId: view.packageId, digest: latest.digest },
              {
                onSuccess: () => {
                  setUpdateOpen(false);
                  checkUpdate.reset();
                },
              },
            )
          }
        />
      )}
    </main>
  );
}
