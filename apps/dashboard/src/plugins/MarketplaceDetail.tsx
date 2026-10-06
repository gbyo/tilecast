import { useTranslation } from "react-i18next";
import { CircleAlert, Puzzle } from "lucide-react";
import type { PluginStoreMarketplace, PluginStoreSource } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../components/ui/item";
import { Separator } from "../components/ui/separator";
import { StoreProvenanceBadge } from "./StoreProvenance";

/**
 * One marketplace listing: what it is, who publishes it, which Tilecast
 * releases it runs on, and where to read more. Everything here comes from
 * the server's verified catalog cache. Listing never implies a security
 * audit, so the page states the provenance it knows and nothing more.
 */
export function MarketplaceDetail({
  listing,
  source,
}: {
  listing: PluginStoreMarketplace;
  source: PluginStoreSource;
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
      <Item className="px-0 py-0">
        <ItemMedia variant="image" className="size-12 bg-muted">
          <Puzzle aria-hidden="true" />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="text-base">
            {listing.name}
            {listing.installed && (
              <Badge variant="secondary">{t("catalog.installed")}</Badge>
            )}
            {listing.updateAvailable && (
              <Badge variant="secondary">
                {t("store.detail.updateAvailable")}
              </Badge>
            )}
          </ItemTitle>
          <ItemDescription className="flex flex-wrap items-center gap-1.5">
            <StoreProvenanceBadge source={source} />
            <span>{listing.publisherName}</span>
          </ItemDescription>
        </ItemContent>
      </Item>
      {listing.description && (
        <p className="text-sm text-muted-foreground">{listing.description}</p>
      )}
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
        {t("store.detail.signedCatalog")}
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
