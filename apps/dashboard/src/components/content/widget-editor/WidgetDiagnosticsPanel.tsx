/**
 * Runtime diagnostics some Widgets can report. This is a narrow capability:
 * it answers "what do screens report about this Widget?" for the providers
 * that have such data, and never owns any part of editing.
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import { contentKeys } from "@/data/content";
import type { Asset } from "@/api/types";
import { useFormatLocale } from "@/i18n";
import { EditorSidePanel } from "./EditorSidePanel";
import type { WidgetDiagnosticsKind } from "./widgetDiagnostics";

export function WidgetDiagnosticsPanel({
  kind,
  asset,
  open,
  onOpenChange,
}: {
  kind: WidgetDiagnosticsKind;
  asset: Asset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("content");
  return (
    <EditorSidePanel
      open={open}
      onOpenChange={onOpenChange}
      title={t("widgets.editor.diagnostics.title")}
      description={
        kind === "website"
          ? t("widgets.editor.diagnostics.websiteDescription")
          : t("widgets.editor.diagnostics.sourceDescription")
      }
    >
      {open &&
        (kind === "website" ? (
          <WebsiteDiagnostics assetId={asset.id} />
        ) : (
          <ManagedSourceDiagnostics
            sourceId={asset.widget?.managedDataSourceId ?? ""}
          />
        ))}
    </EditorSidePanel>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid gap-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WebsiteDiagnostics({ assetId }: { assetId: string }) {
  const { t } = useTranslation("content");
  const locale = useFormatLocale();
  const diagnostics = useQuery({
    queryKey: contentKeys.websiteDiagnostics(assetId),
    queryFn: () => api.websiteDiagnostics(assetId),
  });
  if (diagnostics.isLoading)
    return (
      <p className="text-sm text-muted-foreground">
        {t("widgets.editor.diagnostics.loading")}
      </p>
    );
  if (!diagnostics.data)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("widgets.editor.diagnostics.failed")}
      </p>
    );
  const data = diagnostics.data;
  const none = t("widgets.editor.diagnostics.notReported");
  return (
    <Facts
      rows={[
        [
          t("widgets.editor.diagnostics.allowedHosts"),
          data.allowedHosts.join(", ") || none,
        ],
        [
          t("widgets.editor.diagnostics.lastLoad"),
          data.lastSuccessfulLoad
            ? new Date(data.lastSuccessfulLoad).toLocaleString(locale)
            : none,
        ],
        [
          t("widgets.editor.diagnostics.lastFailure"),
          data.lastFailureCategory ?? none,
        ],
        [
          t("widgets.editor.diagnostics.screens"),
          data.reportingScreens
            .map((screen) => `${screen.name} (${screen.state})`)
            .join(", ") || none,
        ],
      ]}
    />
  );
}

function ManagedSourceDiagnostics({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation("content");
  const locale = useFormatLocale();
  const diagnostics = useQuery({
    queryKey: ["data-source-diagnostics", sourceId],
    queryFn: () => api.dataSourceDiagnostics(sourceId),
    enabled: Boolean(sourceId),
    retry: false,
  });
  if (diagnostics.isLoading)
    return (
      <p className="text-sm text-muted-foreground">
        {t("widgets.editor.diagnostics.loading")}
      </p>
    );
  if (!diagnostics.data)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("widgets.editor.diagnostics.failed")}
      </p>
    );
  const data = diagnostics.data;
  return (
    <Facts
      rows={[
        [
          t("widgets.editor.diagnostics.sourceStatus"),
          data.parseStatus || t("widgets.editor.diagnostics.pending"),
        ],
        [
          t("widgets.editor.diagnostics.items"),
          data.usingCachedData
            ? t("widgets.editor.diagnostics.itemsCached", {
                count: data.availableItemCount,
              })
            : t("widgets.editor.diagnostics.itemsCount", {
                count: data.availableItemCount,
              }),
        ],
        [
          t("widgets.editor.diagnostics.lastUpdate"),
          data.lastSuccessfulRefresh
            ? new Date(data.lastSuccessfulRefresh).toLocaleString(locale)
            : t("widgets.editor.diagnostics.notYet"),
        ],
      ]}
    />
  );
}
