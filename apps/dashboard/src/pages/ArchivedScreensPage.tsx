import { useQuery } from "@tanstack/react-query";
import { formatDateTime } from "../lib/dateTime";
import { Archive, MonitorOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { archivedScreens, type ArchivedScreen } from "../api/archivedScreens";
import { ApiError } from "../api/client";
import { apiErrorMessage, useFormatLocale } from "../i18n";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

export function ArchivedScreensPage() {
  const { t } = useTranslation("screens");
  const formatLocale = useFormatLocale();
  const archived = useQuery({
    queryKey: ["screens", "archive"],
    queryFn: archivedScreens,
  });

  const screens = archived.data?.items ?? [];
  const formatDate = (value?: string) =>
    formatDateTime(value, formatLocale, t("shared.unknown"));

  return (
    <div className="screens-page w-full min-w-0 space-y-4">
      <PageHeader title={t("archive.title")} description={t("archive.body")} />
      {archived.isError && (
        <Alert variant="destructive">
          <AlertDescription>
            {archived.error instanceof ApiError
              ? apiErrorMessage(archived.error)
              : t("archive.loadError")}
          </AlertDescription>
        </Alert>
      )}

      {archived.isError && !archived.data ? null : archived.isLoading ? (
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
        <section
          className="detail-card min-w-0"
          aria-label={t("archive.section")}
        >
          <header className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">
                {t("archive.revokedTitle")}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("archive.revokedBody")}
              </p>
            </div>
            <span className="text-sm text-muted-foreground">
              {t("archive.count", { count: screens.length })}
            </span>
          </header>
          <div className="grid gap-2 lg:hidden">
            {screens.map((screen) => (
              <ArchivedScreenMobileCard
                key={screen.id}
                screen={screen}
                formatDate={formatDate}
              />
            ))}
          </div>
          <div className="hidden overflow-x-auto rounded-xl border border-border lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("archive.colScreen")}</TableHead>
                  <TableHead>{t("archive.colDevice")}</TableHead>
                  <TableHead>{t("archive.colArchived")}</TableHead>
                  <TableHead>{t("archive.colReason")}</TableHead>
                  <TableHead>{t("archive.colLastContact")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {screens.map((screen) => (
                  <TableRow key={screen.id}>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-2">
                        <MonitorOff
                          className="size-4 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {screen.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      {screen.deviceManufacturer || screen.platform}{" "}
                      {screen.deviceModel}
                    </TableCell>
                    <TableCell>{formatDate(screen.archivedAt)}</TableCell>
                    <TableCell>
                      {screen.archivedReason || t("status.revoked")}
                    </TableCell>
                    <TableCell>{formatDate(screen.lastContactAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}

function ArchivedScreenMobileCard({
  screen,
  formatDate,
}: {
  screen: ArchivedScreen;
  formatDate: (value?: string) => string;
}) {
  const { t } = useTranslation("screens");
  return (
    <article className="grid gap-2 rounded-xl border border-border p-3">
      <div className="flex min-w-0 items-center gap-2">
        <MonitorOff
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <strong className="truncate text-sm font-medium">{screen.name}</strong>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("archive.colReason")}: {screen.archivedReason || t("status.revoked")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("archive.colArchived")}: {formatDate(screen.archivedAt)}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("archive.colLastContact")}: {formatDate(screen.lastContactAt)}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("archive.colDevice")}: {screen.deviceManufacturer || screen.platform}{" "}
        {screen.deviceModel}
      </p>
    </article>
  );
}
