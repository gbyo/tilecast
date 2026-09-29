import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useParams } from "react-router";
import { api } from "../api/client";
import type { Asset, LayoutDocument, Playlist } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { DateInput } from "../components/date-picker";
import {
  LayoutPlacementView,
} from "../components/layout-editor/LayoutPlacementView";
import { previewRecordsFromDatasets } from "../components/layout-editor/previewDatasets";
import type { LivePreviewData } from "../components/layout-editor/WidgetLivePreview";
import { Button } from "../components/ui/button";

type LayoutPreviewData = {
  assets: Asset[];
  playlists: Playlist[];
  previewValues: Record<string, Record<string, string>>;
  failures: number;
};

const widgetDataSourceId = (asset?: Asset): string | undefined => {
  const widget = asset?.widget;
  if (!widget) return undefined;
  if (["ticker", "menu", "list", "table", "agenda"].includes(widget.provider))
    return (widget.configuration as { dataSourceId?: string }).dataSourceId;
  return undefined;
};

async function loadLayoutPreviewData(
  document: LayoutDocument,
  date: string,
): Promise<LayoutPreviewData> {
  const playlistIds = Array.from(
    new Set(
      document.placements
        .map((placement) => placement.playlistId)
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const playlistResults = await Promise.allSettled(
    playlistIds.map((playlistId) => api.playlist(playlistId)),
  );
  const playlists = playlistResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

  const assetIds = new Set<string>();
  if (layoutDocument.canvas.backgroundAssetId)
    assetIds.add(layoutDocument.canvas.backgroundAssetId);
  document.placements.forEach((placement) => {
    if (placement.assetId) assetIds.add(placement.assetId);
    if (placement.widgetId) assetIds.add(placement.widgetId);
  });
  playlists.forEach((playlist) =>
    playlist.items.forEach((item) => assetIds.add(item.assetId)),
  );
  const assetResults = await Promise.allSettled(
    Array.from(assetIds).map((assetId) => api.asset(assetId)),
  );
  const assets = assetResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );

  let previewValues: Record<string, Record<string, string>> = {};
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const dataSourceIds = new Set<string>();
  document.placements.forEach((placement) => {
    const bindingId = placement.primitive?.binding?.dataSourceId;
    if (bindingId) dataSourceIds.add(bindingId);
    const widgetSourceId = placement.widgetId
      ? widgetDataSourceId(assetsById.get(placement.widgetId))
      : undefined;
    if (widgetSourceId) dataSourceIds.add(widgetSourceId);
  });
  assets.forEach((asset) => {
    const dataSourceId = widgetDataSourceId(asset);
    if (dataSourceId) dataSourceIds.add(dataSourceId);
  });

  try {
    const resolved = await Promise.all(
      Array.from(dataSourceIds).map(async (dataSourceId) => {
        const preview = await api.previewSavedDataSource(dataSourceId, date);
        if ("records" in preview) {
          return [
            dataSourceId,
            {
              provider: "manual" as const,
              records: preview.records.map((record) => ({
                id: record.id,
                title:
                  record.values.title ??
                  Object.values(record.values).find(Boolean) ??
                  "",
                values: record.values,
              })),
              emptyState: "No items available",
            },
          ] as const;
        }
        if ("datasets" in preview) {
          return [
            dataSourceId,
            {
              provider: "json" as const,
              records: previewRecordsFromDatasets(preview.datasets),
              emptyState: "No items available",
            },
          ] as const;
        }
        if ("configuration" in preview) {
          const { configuration } = preview;
          if ("events" in configuration.data) {
            return [
              dataSourceId,
              {
                provider: "calendar" as const,
                events: configuration.data.events,
                emptyState: configuration.emptyState,
              },
            ] as const;
          }
          return [
            dataSourceId,
            {
              provider: "json" as const,
              records: configuration.data.records,
              emptyState: configuration.emptyState,
            },
          ] as const;
        }
        throw new Error("Unsupported preview shape for " + dataSourceId);
      }),
    );
    const live = Object.fromEntries(resolved) as LivePreviewData;
    const values: Record<string, Record<string, string>> = {};
    Object.entries(live).forEach(([dataSourceId, source]) => {
      const record = source.records?.[0];
      if (!record) return;
      const fields: Record<string, string> = { ...(record.values ?? {}) };
      (["title", "subtitle", "date", "author", "description"] as const).forEach(
        (key) => {
          const value = record[key];
          if (value) fields[key] = value;
        },
      );
      values[dataSourceId] = fields;
    });
    previewValues = values;
  } catch {
    previewValues = {};
  }

  return {
    assets,
    playlists,
    previewValues,
    failures:
      playlistResults.filter((result) => result.status === "rejected").length +
      assetResults.filter((result) => result.status === "rejected").length,
  };
}

function PreviewStatus({ children }: { children: string }) {
  return (
    <main className="fixed inset-0 grid min-h-screen place-items-center bg-[#101418] text-white">
      {children}
    </main>
  );
}

export function LayoutPreviewPage() {
  const { t } = useTranslation("layouts");
  const { id = "" } = useParams();
  const location = useLocation();
  const auth = useAuth();
  const query = useQuery({
    queryKey: ["layouts", id, "popup-preview"],
    queryFn: () => api.layout(id),
    enabled: Boolean(id && auth.status?.authenticated),
  });
  const requestedDate = new URLSearchParams(location.search).get("date");
  const [previewDate, setPreviewDate] = useState(() =>
    requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
      ? requestedDate
      : new Date().toISOString().slice(0, 10),
  );
  const [previewData, setPreviewData] = useState<LayoutPreviewData>({
    assets: [],
    playlists: [],
    previewValues: {},
    failures: 0,
  });
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    const previous = document.title;
    document.title = t("editor.previewTitle", { name: query.data.name });
    return () => {
      document.title = previous;
    };
  }, [query.data, t]);

  useEffect(() => {
    if (!query.data) return;
    let cancelled = false;
    setPreviewLoading(true);
    void loadLayoutPreviewData(query.data.draft, previewDate)
      .then((data) => {
        if (!cancelled) setPreviewData(data);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [previewDate, query.data]);

  const assetsById = useMemo(
    () => new Map(previewData.assets.map((asset) => [asset.id, asset])),
    [previewData.assets],
  );
  const playlistsById = useMemo(
    () =>
      new Map(
        previewData.playlists.map((playlist) => [playlist.id, playlist]),
      ),
    [previewData.playlists],
  );

  if (auth.isLoading)
    return <PreviewStatus>{t("editor.previewLoading")}</PreviewStatus>;
  if (!auth.status?.authenticated) {
    const returnTo = location.pathname + location.search + location.hash;
    return (
      <Navigate
        to={
          auth.status?.setupRequired
            ? "/setup"
            : "/login?returnTo=" + encodeURIComponent(returnTo)
        }
        replace
      />
    );
  }
  if (query.isLoading)
    return <PreviewStatus>{t("editor.previewLoading")}</PreviewStatus>;
  if (query.isError || !query.data)
    return (
      <PreviewStatus>
        {t("editor.previewUnavailable", { count: 1 })}
      </PreviewStatus>
    );

  const layoutDocument = query.data.draft;
  return (
    <main className="layout-preview-page">
      <header className="layout-preview-toolbar">
        <strong>{query.data.name}</strong>
        <span>
          {layoutDocument.canvas.width} × {layoutDocument.canvas.height}
        </span>
        <DateInput
          id="layout-preview-date"
          aria-label={t("editor.previewDateLabel")}
          value={previewDate}
          onChange={setPreviewDate}
        />
        {previewLoading && (
          <span className="layout-preview-status">
            {t("editor.previewLoading")}
          </span>
        )}
        {!previewLoading && previewData.failures > 0 && (
          <span className="layout-preview-status layout-preview-status--warning">
            {t("editor.previewUnavailable", { count: previewData.failures })}
          </span>
        )}
        <Button variant="secondary" onClick={() => window.close()}>
          {t("editor.previewClose")}
        </Button>
      </header>
      <div
        className="layout-preview-frame"
        style={{
          aspectRatio:
            String(layoutDocument.canvas.width) + "/" + String(layoutDocument.canvas.height),
          maxWidth:
            "calc((100dvh - 96px) * " +
            String(layoutDocument.canvas.width / layoutDocument.canvas.height) +
            ")",
          backgroundColor: layoutDocument.canvas.backgroundColor,
        }}
      >
        {layoutDocument.canvas.backgroundAssetId &&
          assetsById.get(layoutDocument.canvas.backgroundAssetId)?.type ===
            "image" && (
            <img
              className="layout-preview-background"
              src={api.assetPreviewUrl(layoutDocument.canvas.backgroundAssetId)}
              alt=""
            />
          )}
        {[...layoutDocument.placements]
          .sort((a, b) => a.layer - b.layer)
          .map((item) => (
            <LayoutPlacementView
              key={item.id}
              item={item}
              canvas={layoutDocument.canvas}
              content={
                item.widgetId
                  ? assetsById.get(item.widgetId)
                  : item.assetId
                    ? assetsById.get(item.assetId)
                    : undefined
              }
              playlist={
                item.playlistId ? playlistsById.get(item.playlistId) : undefined
              }
              assetsById={assetsById}
              previewValues={previewData.previewValues}
              playbackPreview
              previewDate={previewDate}
            />
          ))}
      </div>
    </main>
  );
}
