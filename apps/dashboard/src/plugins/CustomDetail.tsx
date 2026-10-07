import { useTranslation } from "react-i18next";
import { CircleAlert } from "lucide-react";
import type { PluginStoreCustom, PluginStoreSource } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Separator } from "../components/ui/separator";

/**
 * One custom-repository package: what it is, which repository it comes
 * from, and the last verified digest. The repository is operator-chosen,
 * not curated, so the page states the provenance it knows and nothing
 * more.
 */
export function CustomDetail({
  custom,
  source,
}: {
  custom: PluginStoreCustom;
  source: PluginStoreSource;
}) {
  const { t } = useTranslation("plugins");
  return (
    <div className="grid gap-5 pr-2">
      {custom.description && (
        <p className="text-sm text-muted-foreground">{custom.description}</p>
      )}
      {!custom.compatible && (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertDescription>
            {t("store.detail.incompatiblePackage", {
              range: custom.tilecastRange,
            })}
          </AlertDescription>
        </Alert>
      )}
      <Separator />
      <dl className="grid gap-3 text-sm">
        <DetailRow
          label={t("store.detail.publisher")}
          value={custom.publisherName}
        />
        <DetailRow
          label={t("store.detail.versionLabel")}
          value={
            custom.installed && custom.installedVersion
              ? t("store.detail.installedVersion", {
                  version: custom.installedVersion,
                }) +
                " · " +
                t("store.detail.version", { version: custom.version })
              : custom.version
          }
        />
        {custom.license && (
          <DetailRow label={t("store.detail.license")} value={custom.license} />
        )}
        <DetailRow
          label={t("store.detail.requiresLabel")}
          value={custom.tilecastRange}
        />
        <div className="grid gap-1">
          <dt className="font-medium">{t("store.detail.digestLabel")}</dt>
          <dd className="font-mono text-xs break-all text-muted-foreground">
            {custom.digest}
          </dd>
        </div>
        {source.repository && (
          <div className="grid gap-1">
            <dt className="font-medium">{t("store.detail.links")}</dt>
            <dd>
              <a
                href={source.repository}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {t("store.detail.repository")}
              </a>
            </dd>
          </div>
        )}
      </dl>
      <p className="text-sm text-muted-foreground">
        {t("store.detail.customNote")}
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
