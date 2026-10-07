import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CircleAlert, CircleCheck } from "lucide-react";
import type { GitHubInstallReview } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Separator } from "../components/ui/separator";

/**
 * The install review: what the resolved repository supplies, which
 * release it comes from, and the provenance that verified it. Shared by
 * the add-from-GitHub flow, the marketplace install review, and the
 * update check, which all resolve before they act. The update plane
 * differs: custom packages re-resolve their bound repository while
 * marketplace packages re-read the catalog listing.
 */
export function InstallReview({
  review,
  updatePlane = "repository",
}: {
  review: GitHubInstallReview;
  updatePlane?: "repository" | "catalog";
}) {
  const { t } = useTranslation("plugins");
  const verified = review.trust === "verified";
  const capabilities = review.capabilities;
  const hasServerBehavior =
    review.runtime !== undefined ||
    capabilities?.network !== undefined ||
    capabilities?.background !== undefined ||
    capabilities?.storage === true ||
    capabilities?.studioUI !== undefined;
  return (
    <div className="grid gap-4">
      <div className="grid gap-1">
        <p className="font-medium">
          {review.manifest.name}{" "}
          <span className="font-normal text-muted-foreground">
            {t("store.detail.version", { version: review.version })}
          </span>
          {review.installed && (
            <Badge variant="secondary" className="ml-2">
              {t("catalog.installed")}
            </Badge>
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          {review.manifest.publisherName}
          {" · "}
          {review.owner}/{review.repo}
        </p>
        {review.manifest.description && (
          <p className="text-sm text-muted-foreground">
            {review.manifest.description}
          </p>
        )}
      </div>
      {!review.compatible && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            {t("store.detail.incompatiblePackage", {
              range: review.manifest.tilecastRange,
            })}
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid gap-3 text-sm">
        <ReviewRow
          label={t("store.review.release")}
          value={
            review.releaseName
              ? `${review.releaseTag} · ${review.releaseName}`
              : review.releaseTag
          }
        />
        {review.publishedAt && (
          <ReviewRow
            label={t("store.review.published")}
            value={new Date(review.publishedAt).toLocaleDateString()}
          />
        )}
        <div className="grid gap-1">
          <dt className="font-medium">{t("store.detail.digestLabel")}</dt>
          <dd className="font-mono text-xs break-all text-muted-foreground">
            {review.digest}
          </dd>
        </div>
        <ReviewRow
          label={t("store.review.provenance")}
          value={
            verified ? (
              <span className="inline-flex items-center gap-1.5">
                <CircleCheck
                  className="size-4 text-green-700"
                  aria-hidden="true"
                />
                {review.signer
                  ? t("store.review.signedBy", { signer: review.signer })
                  : t("store.review.verified")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <CircleAlert className="size-4" aria-hidden="true" />
                {t("store.review.unsigned")}
              </span>
            )
          }
        />
        <ReviewRow
          label={t("store.review.contributions")}
          value={
            review.contributions.length === 0
              ? t("store.review.noContributions")
              : review.contributions
                  .map(
                    (contribution) =>
                      `${contribution.type} · ${contribution.path}`,
                  )
                  .join(", ")
          }
        />
        {hasServerBehavior && review.runtime && (
          <ReviewRow
            label={t("store.review.runtime")}
            value={
              <span className="font-mono text-xs">{review.runtime.module}</span>
            }
          />
        )}
        {hasServerBehavior && capabilities?.network && (
          <ReviewRow
            label={t("store.review.networkHosts")}
            value={capabilities.network.hosts.join(", ")}
          />
        )}
        {hasServerBehavior && capabilities?.background && (
          <ReviewRow
            label={t("store.review.backgroundJobs")}
            value={capabilities.background.jobs
              .map((job) =>
                t("store.review.jobSchedule", {
                  id: job.id,
                  minutes: job.intervalMinutes,
                }),
              )
              .join(", ")}
          />
        )}
        {hasServerBehavior && capabilities?.storage === true && (
          <ReviewRow
            label={t("store.review.storage")}
            value={t("store.review.storageGranted")}
          />
        )}
        {hasServerBehavior && capabilities?.studioUI && (
          <ReviewRow
            label={t("store.review.studioInterface")}
            value={
              <span className="font-mono text-xs">
                {capabilities.studioUI.entry}
              </span>
            }
          />
        )}
      </dl>
      <Separator />
      <p className="text-sm text-muted-foreground">
        {updatePlane === "catalog"
          ? t("store.review.catalogInstallNote")
          : t("store.review.installNote")}
      </p>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="font-medium">{label}</dt>
      <dd className="text-muted-foreground">{value}</dd>
    </div>
  );
}
