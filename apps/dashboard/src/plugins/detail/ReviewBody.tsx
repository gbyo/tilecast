import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, CircleAlert, CircleCheck } from "lucide-react";
import type { GitHubInstallReview, InstalledPackage } from "../../api/types";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { CapabilityReview, ContributionReview } from "./ReviewChanges";
import { ReviewSection } from "./ReviewSection";
import { TechnicalDetails } from "./TechnicalDetails";
import { technicalRows, type TechnicalRow } from "./technicalDetailsModel";

/** Wording shared by every place that explains an incompatible package. */
export function IncompatibleAlert({
  range,
  id,
}: {
  range: string | undefined;
  id?: string;
}) {
  const { t } = useTranslation("plugins");
  return (
    <Alert id={id}>
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{t("storeDetail.incompatible.title")}</AlertTitle>
      <AlertDescription>
        {t("storeDetail.incompatible.body", { range })}
      </AlertDescription>
    </Alert>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

/**
 * What a resolved package would do, in words a person can weigh. Shared by
 * the install review, the update review, and the add-from-GitHub dialog.
 * An update passes the installed package and the body shows what changes
 * instead of everything the package is.
 */
export function ReviewBody({
  review,
  installed,
  updatePlane = "repository",
}: {
  review: GitHubInstallReview;
  /** Present for an update review: the package being replaced. */
  installed?: InstalledPackage;
  updatePlane?: "repository" | "catalog";
}) {
  const { t, i18n } = useTranslation("plugins");
  const updating = installed !== undefined;
  const verified = review.trust === "verified";

  const technical: TechnicalRow[] = technicalRows(
    {
      packageId: review.packageId,
      digest: review.digest,
      registry: review.registry,
      signer: review.signer,
      releaseTag: review.releaseTag,
      runtimeModule: review.runtime?.module,
      contributions: review.contributions.map((contribution) => ({
        kind: contribution.type,
        path: contribution.path,
        id: contribution.id,
      })),
    },
    t,
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <p className="flex flex-wrap items-center gap-x-2 font-medium">
          {review.manifest.name}
          {updating ? (
            <span className="inline-flex items-center gap-1.5 font-normal text-muted-foreground">
              <span className="sr-only">
                {t("storeDetail.review.versionChange", {
                  from: installed.version,
                  to: review.version,
                })}
              </span>
              <span aria-hidden="true">{installed.version}</span>
              <ArrowRight className="size-3.5" aria-hidden="true" />
              <span aria-hidden="true">{review.version}</span>
            </span>
          ) : (
            <span className="font-normal text-muted-foreground">
              {t("store.detail.version", { version: review.version })}
            </span>
          )}
          {review.installed && !updating && (
            <Badge variant="secondary">{t("catalog.installed")}</Badge>
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
        <IncompatibleAlert range={review.manifest.tilecastRange} />
      )}

      <ReviewSection title={t("store.review.provenance")}>
        <dl className="grid gap-1.5 text-sm">
          <Line label={t("storeDetail.review.verification")}>
            {verified ? (
              <span className="inline-flex items-center gap-1.5">
                <CircleCheck className="size-4" aria-hidden="true" />
                {review.signer
                  ? t("store.review.signedBy", { signer: review.signer })
                  : t("store.review.verified")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <CircleAlert className="size-4" aria-hidden="true" />
                {t("store.review.unsigned")}
              </span>
            )}
          </Line>
          <Line label={t("store.review.release")}>
            {review.releaseName
              ? `${review.releaseTag} · ${review.releaseName}`
              : review.releaseTag}
          </Line>
          {review.publishedAt && (
            <Line label={t("store.review.published")}>
              {new Date(review.publishedAt).toLocaleDateString(i18n.language)}
            </Line>
          )}
        </dl>
      </ReviewSection>

      <ContributionReview review={review} installed={installed} />
      <CapabilityReview review={review} installed={installed} />

      <TechnicalDetails rows={technical} />

      {!updating && (
        <p className="text-sm text-muted-foreground">
          {updatePlane === "catalog"
            ? t("store.review.catalogInstallNote")
            : t("store.review.installNote")}
        </p>
      )}
    </div>
  );
}
