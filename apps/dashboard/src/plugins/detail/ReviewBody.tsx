import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, CircleAlert, CircleCheck } from "lucide-react";
import type { GitHubInstallReview, InstalledPackage } from "../../api/types";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { ItemGroup } from "../../components/ui/item";
import { diffContributions } from "../pluginCatalog";
import { CapabilityItem, ContributionItem } from "./CapabilityItems";
import {
  capabilityRows,
  contributionRows,
  diffCapabilities,
  type CapabilityRow,
} from "./detailView";
import {
  TechnicalDetails,
  technicalRows,
  type TechnicalRow,
} from "./TechnicalDetails";

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

function ReviewSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
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
 * Which hosts or jobs a capability held before the update, as text, for the
 * "was" line of a changed capability.
 */
function previousSummary(
  row: CapabilityRow,
  t: ReturnType<typeof useTranslation<"plugins">>["t"],
) {
  if (row.kind === "network") return row.hosts.join(", ");
  if (row.kind === "background") {
    return t("storeDetail.capabilities.background.body", {
      count: row.jobs.length,
    });
  }
  return "";
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
  const incoming = contributionRows(
    review.contributions.map((contribution) => ({
      kind: contribution.type,
      path: contribution.path,
      id: contribution.id,
    })),
  );
  const capabilities = capabilityRows(review.capabilities);
  const contributionDiff = installed
    ? diffContributions(installed.contributions, review.contributions)
    : undefined;
  const capabilityDiff = installed
    ? diffCapabilities(installed.capabilities, review.capabilities)
    : undefined;

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

      {contributionDiff ? (
        <ReviewSection title={t("storeDetail.review.contributionChanges")}>
          {contributionDiff.added.length === 0 &&
          contributionDiff.removed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("storeDetail.review.noContributionChanges")}
            </p>
          ) : (
            <div className="grid gap-3">
              {contributionDiff.added.length > 0 && (
                <div className="grid gap-2">
                  <p className="text-sm font-medium">
                    {t("packages.addedContributions")}
                  </p>
                  <ItemGroup render={<ul />} className="gap-2">
                    {contributionRows(
                      contributionDiff.added.map(({ kind, path, id }) => ({
                        kind,
                        path,
                        id,
                      })),
                    ).map((row) => (
                      <ContributionItem key={row.key} row={row} tone="added" />
                    ))}
                  </ItemGroup>
                </div>
              )}
              {contributionDiff.removed.length > 0 && (
                <div className="grid gap-2">
                  <p className="text-sm font-medium">
                    {t("packages.removedContributions")}
                  </p>
                  <ItemGroup render={<ul />} className="gap-2">
                    {contributionRows(
                      contributionDiff.removed.map(({ kind, path, id }) => ({
                        kind,
                        path,
                        id,
                      })),
                    ).map((row) => (
                      <ContributionItem
                        key={row.key}
                        row={row}
                        tone="removed"
                      />
                    ))}
                  </ItemGroup>
                  <p className="text-sm text-muted-foreground">
                    {t("packages.removedWarning")}
                  </p>
                </div>
              )}
            </div>
          )}
        </ReviewSection>
      ) : (
        <ReviewSection title={t("storeDetail.adds.title")}>
          {incoming.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("store.review.noContributions")}
            </p>
          ) : (
            <ItemGroup render={<ul />} className="gap-2">
              {incoming.map((row) => (
                <ContributionItem key={row.key} row={row} />
              ))}
            </ItemGroup>
          )}
        </ReviewSection>
      )}

      {capabilityDiff ? (
        <ReviewSection title={t("storeDetail.review.permissionChanges")}>
          {capabilityDiff.added.length === 0 &&
          capabilityDiff.removed.length === 0 &&
          capabilityDiff.changed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("storeDetail.review.noPermissionChanges")}
            </p>
          ) : (
            <div className="grid gap-3">
              {capabilityDiff.added.length > 0 && (
                <div className="grid gap-2">
                  <p className="text-sm font-medium">
                    {t("storeDetail.review.permissionsAdded")}
                  </p>
                  <ItemGroup render={<ul />} className="gap-2">
                    {capabilityDiff.added.map((row) => (
                      <CapabilityItem key={row.kind} row={row} />
                    ))}
                  </ItemGroup>
                </div>
              )}
              {capabilityDiff.changed.length > 0 && (
                <div className="grid gap-2">
                  <p className="text-sm font-medium">
                    {t("storeDetail.review.permissionsChanged")}
                  </p>
                  <div className="grid gap-2">
                    {capabilityDiff.changed.map(({ before, after }) => (
                      <div key={after.kind} className="grid gap-1">
                        <ItemGroup render={<ul />}>
                          <CapabilityItem row={after} />
                        </ItemGroup>
                        <p className="px-1 text-xs text-muted-foreground">
                          {t("storeDetail.review.previously", {
                            value: previousSummary(before, t),
                          })}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {capabilityDiff.removed.length > 0 && (
                <div className="grid gap-2">
                  <p className="text-sm font-medium">
                    {t("storeDetail.review.permissionsRemoved")}
                  </p>
                  <ItemGroup render={<ul />} className="gap-2">
                    {capabilityDiff.removed.map((row) => (
                      <CapabilityItem key={row.kind} row={row} />
                    ))}
                  </ItemGroup>
                </div>
              )}
            </div>
          )}
        </ReviewSection>
      ) : (
        <ReviewSection title={t("storeDetail.permissions.title")}>
          {capabilities.length === 0 ? (
            <div className="grid gap-0.5 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <CircleCheck className="size-4" aria-hidden="true" />
                {t("storeDetail.permissions.noneTitle")}
              </p>
              <p className="text-muted-foreground">
                {t("storeDetail.permissions.noneBody")}
              </p>
            </div>
          ) : (
            <ItemGroup render={<ul />} className="gap-2">
              {capabilities.map((row) => (
                <CapabilityItem key={row.kind} row={row} />
              ))}
            </ItemGroup>
          )}
        </ReviewSection>
      )}

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
