import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import type { PluginStoreMarketplace } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Separator } from "../components/ui/separator";

/**
 * One marketplace listing: what it is, who publishes it, which Tilecast
 * releases it runs on, and where to read more. Everything here comes from
 * the server's cached official catalog. Listing never implies a security
 * audit, so the page states the provenance it knows and nothing more.
 */
export function MarketplaceDetail({
  listing,
}: {
  listing: PluginStoreMarketplace;
}) {
  const { t } = useTranslation("plugins");
  const links = [
    {
      key: "repository",
      label: t("store.detail.repository"),
      href: listing.repository,
    },
    ...(listing.documentation
      ? [
          {
            key: "documentation",
            label: t("store.detail.documentation"),
            href: listing.documentation,
          },
        ]
      : []),
    ...(listing.issues
      ? [
          {
            key: "issues",
            label: t("store.detail.issues"),
            href: listing.issues,
          },
        ]
      : []),
  ];
  return (
    <div className="grid gap-5 pr-2">
      {!listing.compatible && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            {t("store.detail.incompatible", { range: listing.tilecastRange })}
          </AlertDescription>
        </Alert>
      )}
      <Separator />
      <dl className="grid gap-3 text-sm">
        <DetailRow
          label={t("store.detail.publisher")}
          value={listing.publisherName}
        />
        <DetailRow
          label={t("store.detail.versionLabel")}
          value={
            listing.installed && listing.installedVersion
              ? t("store.detail.installedVersion", {
                  version: listing.installedVersion,
                }) +
                " · " +
                t("store.detail.version", { version: listing.version })
              : listing.version
          }
        />
        {listing.license && (
          <DetailRow
            label={t("store.detail.license")}
            value={listing.license}
          />
        )}
        {listing.featured && (
          <DetailRow
            label={t("store.detail.featuredLabel")}
            value={t("store.detail.featured")}
          />
        )}
        {listing.categories && listing.categories.length > 0 && (
          <DetailRow
            label={t("store.detail.categoriesLabel")}
            value={listing.categories.join(", ")}
          />
        )}
        <DetailRow
          label={t("store.detail.requiresLabel")}
          value={listing.tilecastRange}
        />
        <div className="grid gap-1">
          <dt className="font-medium">{t("store.detail.links")}</dt>
          <dd className="flex flex-wrap gap-x-4 gap-y-1">
            {links.map((link) => (
              <a
                key={link.key}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {link.label}
              </a>
            ))}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-muted-foreground">
        {t("store.detail.officialCatalog")}
      </p>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1">
      <dt className="font-medium">{label}</dt>
      <dd className="text-muted-foreground">{value}</dd>
    </div>
  );
}
