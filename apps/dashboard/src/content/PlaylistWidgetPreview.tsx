/**
 * The playlist preview surface for Widget items
 * (Widget Preview Parity Fixes, Bug 1).
 *
 * A migrated V2 Widget renders its real Web Component through the shared
 * Studio preview surface (V2ZonePreview over the one WidgetPreviewHost
 * adapter), exactly as the Widget editor, Layout zones, and thumbnails do.
 * Widgets without a migrated component keep the legacy server-compiled
 * declarative preview, including Website/YouTube remote-web behavior.
 *
 * Widget ready/empty/error lifecycle drives preview readiness: a failed
 * required Data Source reports an item error instead of going ready once
 * its query settles (issue #619), on both the V2 and the legacy paths.
 */
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { PlaylistItem } from "../api/types";
import type { OrganizationRegionalProfile } from "../settings/regionalProfile";
import { V2ZonePreview } from "../components/layout-editor/V2ZonePreview";
import { DeclarativePresentationPreview } from "./SourceEditors";
import { studioPreviewComponent } from "./studioWidgets";

/**
 * Intrinsic fullscreen proxy for playlist Widget items. The popup stage
 * fills the window; the surface scales to it while the Widget keeps this
 * 16:9 geometry for its container queries.
 */
export const PLAYLIST_WIDGET_FRAME = { width: 960, height: 540 } as const;

export function PlaylistWidgetPreview({
  item,
  active,
  csrfToken,
  regional,
  className,
  onReady,
  onError,
}: {
  item: PlaylistItem;
  active: boolean;
  csrfToken: string;
  regional: OrganizationRegionalProfile;
  className: string;
  onReady: () => void;
  onError: () => void;
}) {
  const { t } = useTranslation("playlists");
  const widgetQuery = useQuery({
    queryKey: ["assets", item.assetId, "playlist-preview"],
    queryFn: () => api.asset(item.assetId),
    retry: false,
  });
  const savedWidget = widgetQuery.data?.widget;
  const definitionsQuery = useQuery({
    queryKey: ["content-definitions"],
    queryFn: () => api.contentDefinitions(),
    retry: false,
  });
  // The component-presence routing rule: a migrated component renders the
  // real element; anything else keeps the legacy compiled preview.
  const v2 =
    savedWidget && definitionsQuery.data
      ? studioPreviewComponent(definitionsQuery.data, savedWidget.provider)
      : undefined;
  const presentationQuery = useQuery({
    queryKey: [
      "compiled-widget-preview",
      savedWidget?.provider,
      savedWidget?.configuration,
    ],
    queryFn: () =>
      api.compileWidgetPreview(
        savedWidget!.provider,
        savedWidget!.configuration,
        csrfToken,
      ),
    enabled: Boolean(savedWidget) && v2 === null,
    retry: false,
  });
  const dataSourceId =
    savedWidget?.configuration &&
    "dataSourceId" in savedWidget.configuration &&
    typeof savedWidget.configuration.dataSourceId === "string"
      ? savedWidget.configuration.dataSourceId
      : "";
  const imageAssetId =
    savedWidget?.configuration &&
    "imageAssetId" in savedWidget.configuration &&
    typeof savedWidget.configuration.imageAssetId === "string"
      ? savedWidget.configuration.imageAssetId
      : "";
  const sourceQuery = useQuery({
    queryKey: ["widget-data-source-preview", dataSourceId],
    queryFn: () => api.previewSavedDataSource(dataSourceId),
    enabled: Boolean(dataSourceId) && v2 === null,
    retry: false,
  });

  // Legacy readiness only. V2 Widgets report through onState below, where a
  // failed required source is an error rather than a settled query (#619).
  useEffect(() => {
    if (v2) return;
    if (
      presentationQuery.data?.kind === "native" &&
      (!dataSourceId || !sourceQuery.isLoading) &&
      !sourceQuery.isError
    )
      onReady();
    else if (
      (widgetQuery.isError ||
        definitionsQuery.isError ||
        presentationQuery.isError ||
        (Boolean(dataSourceId) && sourceQuery.isError)) &&
      active
    )
      onError();
  }, [
    active,
    dataSourceId,
    v2,
    definitionsQuery.isError,
    onError,
    onReady,
    presentationQuery.data,
    presentationQuery.isError,
    sourceQuery.isError,
    sourceQuery.isLoading,
    widgetQuery.data,
    widgetQuery.isError,
  ]);

  if (v2 && savedWidget)
    return (
      <div className={`${className} grid place-items-stretch overflow-hidden`}>
        <V2ZonePreview
          provider={savedWidget.provider}
          asset={widgetQuery.data}
          width={PLAYLIST_WIDGET_FRAME.width}
          height={PLAYLIST_WIDGET_FRAME.height}
          fit="fill"
          onState={(state) => {
            // Ready and intentional-empty both display; only an explicit
            // failure is an item error. Skipping empties is playback-engine
            // behavior Studio must not reimplement here.
            if (state.state === "ready" || state.state === "empty") onReady();
            else if (state.state === "error" && active) onError();
          }}
        />
      </div>
    );

  return (
    <div
      className={`${className} grid place-items-stretch overflow-hidden declarative-widget-preview`}
    >
      {v2 === null && presentationQuery.data ? (
        <DeclarativePresentationPreview
          presentation={presentationQuery.data}
          source={sourceQuery.data}
          regional={regional}
          assetImageUrl={
            imageAssetId ? api.assetPreviewUrl(imageAssetId) : undefined
          }
          onWebReady={onReady}
        />
      ) : (
        <span>{t("preview.preparingWidget")}</span>
      )}
    </div>
  );
}
