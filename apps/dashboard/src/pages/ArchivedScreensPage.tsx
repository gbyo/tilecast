import { useQuery } from "@tanstack/react-query";
import { Archive, MonitorOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { archivedScreens } from "../api/archivedScreens";
import { useFormatLocale } from "../i18n";
import { PageHeader } from "../components/PageHeader";
import { Alert, AlertDescription } from "../components/ui/alert";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

export function ArchivedScreensPage() {
  const { t } = useTranslation("screens");
  const formatLocale = useFormatLocale();
  const archived = useQuery({
    queryKey: ["screens", "archive"],
    queryFn: archivedScreens,
  });

  const screens = archived.data?.items ?? [];
  const formatDate = (value?: string) =>
    value
      ? new Date(value).toLocaleString(formatLocale, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : t("shared.unknown");

  return (
    <div className="screens-page">
      <PageHeader title={t("archive.title")} description={t("archive.body")} />

      {archived.isError && (
        <Alert variant="destructive">
          <AlertDescription>{archived.error.message}</AlertDescription>
        </Alert>
      )}

      {archived.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("archive.loading")}</p>
      ) : screens.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Archive aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("archive.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("archive.emptyBody")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link className={buttonVariants()} to="/screens">
              {t("archive.back")}
            </Link>
          </EmptyContent>
        </Empty>
      ) : (
        <section className="detail-card" aria-label={t("archive.section")}>
          <header>
            <div>
              <h3>{t("archive.revokedTitle")}</h3>
              <p>{t("archive.revokedBody")}</p>
            </div>
            <span>{t("archive.count", { count: screens.length })}</span>
          </header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t("archive.colScreen")}</th>
                  <th>{t("archive.colDevice")}</th>
                  <th>{t("archive.colArchived")}</th>
                  <th>{t("archive.colReason")}</th>
                  <th>{t("archive.colLastContact")}</th>
                </tr>
              </thead>
              <tbody>
                {screens.map((screen) => (
                  <tr key={screen.id}>
                    <td>
                      <span className="screen-name-cell">
                        <MonitorOff size={17} aria-hidden="true" />
                        <strong>{screen.name}</strong>
                      </span>
                    </td>
                    <td>
                      {screen.deviceManufacturer || screen.platform}{" "}
                      {screen.deviceModel}
                    </td>
                    <td>{formatDate(screen.archivedAt)}</td>
                    <td>{screen.archivedReason || t("status.revoked")}</td>
                    <td>{formatDate(screen.lastContactAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
