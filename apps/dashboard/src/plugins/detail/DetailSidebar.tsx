import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import type { InstalledPackage } from "../../api/types";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Spinner } from "../../components/ui/spinner";
import type { PluginDetailViewModel } from "./detailView";

function Rows({ children }: { children: ReactNode }) {
  return <dl className="grid gap-2 text-sm">{children}</dl>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-end font-medium break-words">{children}</dd>
    </div>
  );
}

/** What the person can do about updates, owned by the page. */
export type UpdateControls = {
  checking: boolean;
  onCheck: () => void;
  /** The last check found nothing newer. */
  upToDate: boolean;
  /** A check has resolved an update, so reviewing it needs no further lookup. */
  resolved: boolean;
  /** Opens the update review, resolving the update first when needed. */
  onReview: () => void;
};

/**
 * The page's operational summary. It reads in this order: the current state,
 * the one thing to do about it, then the supporting version and
 * compatibility facts. On narrow viewports this card sits directly below the
 * hero and carries the install action; on a wide viewport the hero carries
 * it instead.
 */
export function PackageStatusCard({
  view,
  installedPackage,
  latestVersion,
  primaryAction,
  update,
}: {
  view: PluginDetailViewModel;
  installedPackage?: InstalledPackage;
  /** A newer version, from the listing or from a resolved check. */
  latestVersion?: string;
  /** Rendered full width; omitted where the hero holds the action. */
  primaryAction?: ReactNode;
  /** Present when the person may manage this installed package. */
  update?: UpdateControls;
}) {
  const { t, i18n } = useTranslation("plugins");
  const installedVersion = installedPackage?.version ?? view.installedVersion;
  const updateKnown =
    view.installed &&
    latestVersion !== undefined &&
    installedVersion !== undefined &&
    latestVersion !== installedVersion;
  const current = update?.upToDate === true && !updateKnown;
  const installedOn = installedPackage?.installedAt
    ? new Date(installedPackage.installedAt)
    : undefined;

  return (
    <Card role="region" aria-labelledby="package-status-title">
      <CardHeader>
        <CardTitle id="package-status-title">
          {t("storeDetail.status.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1" aria-live="polite">
          {!view.compatible ? (
            <p className="flex items-center gap-2 text-base font-semibold">
              <CircleAlert
                className="size-5 text-destructive"
                aria-hidden="true"
              />
              {t("storeDetail.status.notCompatible")}
            </p>
          ) : updateKnown ? (
            <>
              <p className="flex items-center gap-2 text-base font-semibold">
                <RefreshCw className="size-5" aria-hidden="true" />
                {t("store.detail.updateAvailable")}
              </p>
              <p className="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
                <span className="sr-only">
                  {t("storeDetail.review.versionChange", {
                    from: installedVersion,
                    to: latestVersion,
                  })}
                </span>
                <span aria-hidden="true">{installedVersion}</span>
                <ArrowRight className="size-3.5" aria-hidden="true" />
                <span
                  aria-hidden="true"
                  className="font-medium text-foreground"
                >
                  {latestVersion}
                </span>
              </p>
            </>
          ) : current ? (
            <p
              role="status"
              className="flex items-center gap-2 text-base font-semibold"
            >
              <CircleCheck className="size-5" aria-hidden="true" />
              {t("storeDetail.status.upToDate", {
                version: installedVersion ?? view.version,
              })}
            </p>
          ) : view.installed ? (
            <>
              <p className="flex items-center gap-2 text-base font-semibold">
                <CircleCheck className="size-5" aria-hidden="true" />
                {t("catalog.installed")}
              </p>
              {view.external && (installedVersion ?? view.version) && (
                <p className="text-sm text-muted-foreground tabular-nums">
                  {t("store.detail.version", {
                    version: installedVersion ?? view.version,
                  })}
                </p>
              )}
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 text-base font-semibold">
                <CircleDashed className="size-5" aria-hidden="true" />
                {t("storeDetail.status.notInstalled")}
              </p>
              {view.version && (
                <p className="text-sm text-muted-foreground tabular-nums">
                  {t("store.detail.version", { version: view.version })}
                </p>
              )}
            </>
          )}
        </div>

        {primaryAction}
        {update && (
          <div className="grid gap-2">
            {updateKnown ? (
              <Button disabled={update.checking} onClick={update.onReview}>
                {update.checking && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {t("storeDetail.update.review")}
              </Button>
            ) : !current ? (
              <Button
                variant="outline"
                disabled={update.checking}
                onClick={update.onCheck}
              >
                {update.checking && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {t("storeDetail.update.check")}
              </Button>
            ) : null}
            {(updateKnown ? update.resolved : current) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={update.checking}
                onClick={update.onCheck}
              >
                {update.checking && (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                )}
                {t("storeDetail.update.checkAgain")}
              </Button>
            )}
          </div>
        )}

        {view.external && (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            {view.compatible ? (
              <CircleCheck
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
            ) : (
              <CircleAlert
                className="mt-0.5 size-4 shrink-0 text-destructive"
                aria-hidden="true"
              />
            )}
            <span>
              {view.compatible
                ? t("storeDetail.status.compatible")
                : t("storeDetail.status.incompatible")}
              <span className="block text-xs">
                {t("store.detail.requires", { range: view.tilecastRange })}
              </span>
            </span>
          </p>
        )}
      </CardContent>
      {installedOn && !Number.isNaN(installedOn.getTime()) && (
        <CardFooter className="text-xs text-muted-foreground">
          {t("storeDetail.status.installedOn", {
            date: installedOn.toLocaleDateString(i18n.language, {
              dateStyle: "medium",
            }),
          })}
        </CardFooter>
      )}
    </Card>
  );
}

function ExternalLinkItem({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 text-sm underline-offset-4 outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <ExternalLink
        className="size-3.5 text-muted-foreground rtl:-scale-x-100"
        aria-hidden="true"
      />
      {label}
    </a>
  );
}

/**
 * Who publishes the package and where it lives. Each source states what it
 * knows and nothing more: a Marketplace listing is a directory entry, a
 * custom package is not curated, and an included plugin downloads nothing.
 */
export function PackageAboutCard({
  view,
  installedPackage,
}: {
  view: PluginDetailViewModel;
  installedPackage?: InstalledPackage;
}) {
  const { t } = useTranslation("plugins");
  const links = [
    view.repository && {
      key: "repository",
      label: t("store.detail.repository"),
      href: view.repository,
    },
    view.documentation && {
      key: "documentation",
      label: t("store.detail.documentation"),
      href: view.documentation,
    },
    view.issues && {
      key: "issues",
      label: t("storeDetail.about.reportIssue"),
      href: view.issues,
    },
  ].filter((link): link is { key: string; label: string; href: string } =>
    Boolean(link),
  );

  return (
    <Card role="region" aria-labelledby="package-about-title">
      <CardHeader>
        <CardTitle id="package-about-title">
          {view.sourceKind === "included"
            ? t("store.sources.included")
            : view.sourceKind === "custom"
              ? t("storeDetail.about.customTitle")
              : t("storeDetail.about.cardTitle")}
        </CardTitle>
        <CardDescription>
          {view.sourceKind === "included"
            ? t("storeDetail.about.noDownload")
            : view.sourceKind === "custom"
              ? t("store.detail.customNote")
              : t("store.detail.officialCatalog")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <Rows>
          {view.publisher && (
            <Row label={t("store.detail.publisher")}>{view.publisher}</Row>
          )}
          {view.license && (
            <Row label={t("store.detail.license")}>{view.license}</Row>
          )}
          {view.sourceKind === "marketplace" && (
            <Row label={t("storeDetail.about.source")}>
              {t("storeDetail.about.marketplaceSource")}
            </Row>
          )}
          {view.sourceKind === "custom" && (
            <>
              <Row label={t("storeDetail.about.source")}>
                {t("storeDetail.about.customSource")}
              </Row>
              <Row label={t("storeDetail.about.provenance")}>
                {installedPackage?.trust === "verified"
                  ? t("storeDetail.about.verified")
                  : t("storeDetail.about.verifiedOnInstall")}
              </Row>
            </>
          )}
        </Rows>
        {view.sourceKind === "custom" && (
          <p className="text-xs text-muted-foreground">
            {t("storeDetail.about.customNotice")}
          </p>
        )}
        {links.length > 0 && (
          <ul aria-label={t("store.detail.links")} className="grid gap-1.5">
            {links.map((link) => (
              <li key={link.key}>
                <ExternalLinkItem href={link.href} label={link.label} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
