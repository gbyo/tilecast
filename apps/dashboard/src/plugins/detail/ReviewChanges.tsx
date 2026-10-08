import { useTranslation } from "react-i18next";
import { CircleCheck } from "lucide-react";
import type { GitHubInstallReview, InstalledPackage } from "../../api/types";
import { ItemGroup } from "../../components/ui/item";
import { diffContributions } from "../pluginCatalog";
import { CapabilityItem, ContributionItem } from "./CapabilityItems";
import {
  capabilityRowKey,
  capabilityRows,
  contributionRows,
  diffCapabilities,
  type CapabilityRow,
} from "./detailView";
import { ReviewSection } from "./ReviewSection";

type Review = {
  review: GitHubInstallReview;
  /** Present for an update review: the package being replaced. */
  installed?: InstalledPackage;
};

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
  if (row.kind === "service") return row.grant.description;
  return "";
}

/**
 * What the package adds, or for an update what it adds and drops. Rows keep
 * the contained, muted look: inside the review each one stands apart.
 */
export function ContributionReview({ review, installed }: Review) {
  const { t } = useTranslation("plugins");
  const incoming = contributionRows(
    review.contributions.map((contribution) => ({
      kind: contribution.type,
      path: contribution.path,
      id: contribution.id,
    })),
  );
  const contributionDiff = installed
    ? diffContributions(installed.contributions, review.contributions)
    : undefined;
  return contributionDiff ? (
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
                  <ContributionItem
                    key={row.key}
                    row={row}
                    variant="muted"
                    tone="added"
                  />
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
                    variant="muted"
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
            <ContributionItem key={row.key} row={row} variant="muted" />
          ))}
        </ItemGroup>
      )}
    </ReviewSection>
  );
}

/** What the package may do, or for an update how that changes. */
export function CapabilityReview({ review, installed }: Review) {
  const { t } = useTranslation("plugins");
  const capabilities = capabilityRows(review.capabilities);
  const capabilityDiff = installed
    ? diffCapabilities(installed.capabilities, review.capabilities)
    : undefined;
  return capabilityDiff ? (
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
                  <CapabilityItem
                    key={capabilityRowKey(row)}
                    row={row}
                    variant="muted"
                  />
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
                  <div key={capabilityRowKey(after)} className="grid gap-1">
                    <ItemGroup render={<ul />}>
                      <CapabilityItem row={after} variant="muted" />
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
                  <CapabilityItem
                    key={capabilityRowKey(row)}
                    row={row}
                    variant="muted"
                  />
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
            <CapabilityItem
              key={capabilityRowKey(row)}
              row={row}
              variant="muted"
            />
          ))}
        </ItemGroup>
      )}
    </ReviewSection>
  );
}
