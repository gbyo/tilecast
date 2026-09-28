import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { Asset, WidgetDefinition } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useOrganizationRegionalProfile } from "../settings/regionalProfile";
import {
  previewDatasetCurrencies,
  previewDatasetMaps,
  type PreviewDatasetCurrencies,
  type PreviewDatasets,
} from "./previewRecords";
import { V2ZonePreview } from "../components/layout-editor/V2ZonePreview";
import { DeclarativePresentationPreview } from "./SourceEditors";
import { studioWidgetComponent } from "./studioWidgets";
import { captureWidgetPreview } from "./widgetPreviewCapture";
import {
  widgetPreviewConfiguration,
  widgetPreviewDataSourceIds,
} from "./widgetPreviewSources";

// A Widget's library preview is a JPEG captured from a rendered Widget, and only a browser can
// produce one. The editor uploads a capture whenever someone saves, which leaves every Widget that
// nobody has saved since — anything created before stored previews existed, or imported, or restored
// from a backup — with nothing to show. This renders those Widgets off-screen, captures them with
// exactly the machinery the editor uses, and stores the result, so the library fills itself in
// instead of asking people to reopen and re-save every Widget they own.
//
// Deliberately excluded: `website` and `youtube` Widgets. They present a cross-origin iframe that
// cannot be read back into a canvas, so a capture would store a blank rectangle. Those keep the
// honest "Preview unavailable" state, which is the same thing their editors do on save.
const uncapturableProviders = new Set<string>(["website", "youtube"]);

function needsSnapshot(asset: Asset) {
  return (
    asset.type === "widget" &&
    !asset.thumbnailUrl &&
    Boolean(asset.widget) &&
    !uncapturableProviders.has(asset.widget!.provider)
  );
}

export function WidgetSnapshotBackfill({
  assets,
  enabled = true,
}: {
  assets: Asset[];
  enabled?: boolean;
}) {
  // Widgets already attempted this session, successful or not. A Widget whose capture fails must not
  // be retried in a loop: it would re-render and re-upload forever behind an unchanging list.
  const attempted = useRef(new Set<string>());
  const [target, setTarget] = useState<Asset>();

  const candidates = enabled ? assets.filter(needsSnapshot) : [];
  const next = candidates.find((asset) => !attempted.current.has(asset.id));

  useEffect(() => {
    if (!target && next) {
      attempted.current.add(next.id);
      setTarget(next);
    }
  }, [next, target]);

  if (!target) return null;
  return (
    <WidgetSnapshotCapture
      key={target.id}
      asset={target}
      onSettled={() => setTarget(undefined)}
    />
  );
}

const SNAPSHOT_FRAME = { width: 960, height: 540 } as const;

/**
 * Store a capture of a rendered Widget once `ready` says it has painted.
 * Shared by the V2 and the compatibility capture paths.
 */
function useSnapshotUpload(
  asset: Asset,
  ready: boolean,
  failed: boolean,
  previewRef: React.RefObject<HTMLDivElement | null>,
  onSettled: () => void,
) {
  const { t } = useTranslation(["content"]);
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const queryClient = useQueryClient();
  const uploaded = useRef(false);
  // The capture effect must not restart when the language changes: cleanup
  // would cancel an in-progress capture that is never retried. The ref always
  // carries the latest translator for subsequent messages.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (failed) {
      onSettled();
      return;
    }
    if (!ready || uploaded.current) return;
    uploaded.current = true;
    let cancelled = false;
    // Two frames, so the browser has laid out and painted the preview that was just mounted.
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        void (async () => {
          try {
            const element = previewRef.current;
            if (cancelled || !element) return;
            const image = await captureWidgetPreview(element, tRef.current);
            if (cancelled) return;
            await api.uploadWidgetPreview(asset.id, image, csrf);
            if (!cancelled)
              await queryClient.invalidateQueries({ queryKey: ["assets"] });
          } catch {
            // A Widget that cannot be captured keeps its honest unavailable state. The list is not
            // blocked on it and it is not retried, so one bad Widget cannot stall the rest.
          } finally {
            if (!cancelled) onSettled();
          }
        })();
      }),
    );
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [ready, failed, asset.id, csrf, onSettled, queryClient, previewRef]);
}

function WidgetSnapshotCapture({
  asset,
  onSettled,
}: {
  asset: Asset;
  onSettled: () => void;
}) {
  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  if (definitions.isLoading) return null;
  const provider = asset.widget!.provider;
  // A Widgets V2 Widget is captured from its real element, the same one the
  // editor previews and the Player mounts.
  return studioWidgetComponent(definitions.data, provider) ? (
    <V2SnapshotCapture asset={asset} onSettled={onSettled} />
  ) : (
    <CompatibilitySnapshotCapture asset={asset} onSettled={onSettled} />
  );
}

function V2SnapshotCapture({
  asset,
  onSettled,
}: {
  asset: Asset;
  onSettled: () => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"pending" | "settled" | "failed">(
    "pending",
  );
  useSnapshotUpload(
    asset,
    state === "settled",
    state === "failed",
    previewRef,
    onSettled,
  );
  return (
    <div className="widget-snapshot-backfill" aria-hidden="true">
      <div ref={previewRef}>
        <V2ZonePreview
          provider={asset.widget!.provider}
          asset={asset}
          width={SNAPSHOT_FRAME.width}
          height={SNAPSHOT_FRAME.height}
          onState={(next) => {
            if (next.state === "ready" || next.state === "empty")
              setState("settled");
            else if (next.state === "error") setState("failed");
          }}
        />
      </div>
    </div>
  );
}

// Renders one Widget that has no V2 component off-screen at snapshot width, through its
// compatibility presentation, and stores the capture. Laid out rather than hidden, because a
// capture needs real geometry: `display: none` or a zero-size box produces nothing.
function CompatibilitySnapshotCapture({
  asset,
  onSettled,
}: {
  asset: Asset;
  onSettled: () => void;
}) {
  const regional = useOrganizationRegionalProfile();
  const auth = useAuth();
  const csrf = auth.status?.csrfToken ?? "";
  const previewRef = useRef<HTMLDivElement>(null);
  const provider = asset.widget!.provider;
  const authorConfiguration = (asset.widget!.authorConfiguration ??
    asset.widget!.configuration) as Record<string, unknown>;
  const managedDataSourceId = asset.widget!.managedDataSourceId;
  const configuration = widgetPreviewConfiguration(
    authorConfiguration,
    managedDataSourceId,
  );

  const definitions = useQuery({
    queryKey: ["content-definitions"],
    queryFn: api.contentDefinitions,
  });
  const definition: WidgetDefinition | undefined =
    definitions.data?.widgets?.find((candidate) => candidate.id === provider);
  const compiled = useQuery({
    queryKey: ["compiled-widget-preview", provider, configuration],
    // A capture is only stored for a Widget the server can still compile, so a Widget whose
    // configuration the current release rejects is left alone rather than given a broken image.
    queryFn: () =>
      api.compileWidgetPreview(provider, configuration as never, csrf),
    retry: false,
  });

  // Follow every author-declared data_source and the hidden managed App source. If a definition is
  // temporarily unavailable, keep enough legacy fallback behavior to capture stored Widgets while
  // still honoring managedDataSourceId directly from the asset.
  const declaredSources = definition
    ? widgetPreviewDataSourceIds(
        definition.configurationSchema.fields,
        authorConfiguration,
        managedDataSourceId,
      )
    : [
        ...(managedDataSourceId ? [managedDataSourceId] : []),
        ...(typeof authorConfiguration.dataSourceId === "string" &&
        authorConfiguration.dataSourceId
          ? [authorConfiguration.dataSourceId]
          : []),
      ].filter((id, index, ids) => ids.indexOf(id) === index);
  const sourcePreviews = useQueries({
    queries: declaredSources.map((id) => ({
      queryKey: ["widget-data-source-preview", id],
      queryFn: () => api.previewSavedDataSource(id),
      retry: false,
    })),
  });
  const sourcesSettled = sourcePreviews.every((preview) => !preview.isLoading);
  const previewDatasets = declaredSources.reduce<PreviewDatasets>(
    (all, id, index) => ({
      ...all,
      ...previewDatasetMaps(id, sourcePreviews[index]?.data),
    }),
    {},
  );
  const previewCurrencies = declaredSources.reduce<PreviewDatasetCurrencies>(
    (all, id, index) => ({
      ...all,
      ...previewDatasetCurrencies(id, sourcePreviews[index]?.data),
    }),
    {},
  );
  const ready = Boolean(compiled.data) && sourcesSettled;
  const failed = compiled.isError || (definitions.isError && !definition);

  useSnapshotUpload(asset, ready, failed, previewRef, onSettled);

  return (
    <div className="widget-snapshot-backfill" aria-hidden="true">
      <div
        ref={previewRef}
        className="native-app-preview declarative-widget-preview"
      >
        {compiled.data && (
          <DeclarativePresentationPreview
            presentation={compiled.data}
            source={sourcePreviews[0]?.data}
            datasets={previewDatasets}
            datasetCurrencies={previewCurrencies}
            regional={regional}
            assetImageUrl={
              typeof authorConfiguration.imageAssetId === "string" &&
              authorConfiguration.imageAssetId
                ? api.assetPreviewUrl(authorConfiguration.imageAssetId)
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
