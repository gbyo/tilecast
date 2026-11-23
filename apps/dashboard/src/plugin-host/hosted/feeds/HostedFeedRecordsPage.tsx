import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFormatLocale } from "@/i18n";
import { PluginPage } from "../../PluginPage";
import { feedRecordsKey, feedsClient, type PluginFeedRecord } from "./api";
import { FeedRecordDialog } from "./FeedRecordDialog";
import type { HostedFeedsProps } from "./HostedFeedsPage";
import { cellText, hasOverride } from "./model";

/**
 * The records of one dataset as Players show them, with the overrides an
 * operator set. The plugin owns the upstream values; this page never
 * changes them.
 */
export function HostedFeedRecordsPage({ pluginId }: HostedFeedsProps) {
  const { datasetId = "" } = useParams();
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const [open, setOpen] = useState<PluginFeedRecord | null>(null);
  const records = useQuery({
    queryKey: feedRecordsKey(pluginId, datasetId),
    queryFn: () => feedsClient(pluginId).records(datasetId, 0, 200),
  });
  const data = records.data;
  const fields = data?.fields ?? [];
  const current = open
    ? (data?.items.find((item) => item.id === open.id) ?? open)
    : null;
  return (
    <PluginPage
      pluginId={pluginId}
      title={data?.dataset.name ?? t("hosted.feeds.title")}
      description={t("hosted.feeds.recordsDescription")}
    >
      {records.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("hosted.feeds.loadError")}</AlertDescription>
        </Alert>
      )}
      {data && (
        <p className="text-sm text-muted-foreground">
          {[
            t("hosted.feeds.revision", { revision: data.dataset.revision }),
            data.dataset.publishedAt
              ? t("hosted.feeds.publishedAt", {
                  date: new Date(data.dataset.publishedAt).toLocaleString(
                    locale,
                  ),
                })
              : t("hosted.feeds.neverPublished"),
            t("hosted.feeds.records", { count: data.total }),
          ].join(" · ")}
        </p>
      )}
      {data && data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("hosted.feeds.noRecords")}
        </p>
      )}
      {data && data.items.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("hosted.feeds.recordId")}</TableHead>
                {fields.map((field) => (
                  <TableHead key={field.key}>{field.label}</TableHead>
                ))}
                <TableHead>
                  <span className="sr-only">{t("hosted.feeds.actions")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="font-mono text-xs">
                    {record.id}
                  </TableCell>
                  {fields.map((field) => (
                    <TableCell key={field.key}>
                      <span className="flex items-center gap-1">
                        {cellText(record, field)}
                        {hasOverride(record, field.key) && (
                          <Badge variant="outline">
                            {t("hosted.feeds.overridden")}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                  ))}
                  <TableCell>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t("hosted.feeds.openRecord", {
                        id: record.id,
                      })}
                      onClick={() => setOpen(record)}
                    >
                      {t("hosted.feeds.view")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {current && (
        <FeedRecordDialog
          pluginId={pluginId}
          datasetId={datasetId}
          fields={fields}
          record={current}
          onClose={() => setOpen(null)}
        />
      )}
    </PluginPage>
  );
}
