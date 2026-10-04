import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FeatureCollection, Point } from "geojson";
import {
  GeoJSONSource,
  LngLatBounds,
  type Map as MapLibreMap,
} from "maplibre-gl";
import { ExternalLink, MapPinned } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import type { Screen } from "../api/types";
import { useNativeHost } from "../native-host/NativeHostProvider";
import { validateSystemMap, type SystemMapTone } from "../native-host/protocol";
import { MapLibreSurface } from "./MapLibreSurface";
import { Badge } from "./ui/badge";
import { Button, buttonVariants } from "./ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";

const MAP_SOURCE_ID = "fleet-screens";
const CLUSTER_LAYER_ID = "fleet-screen-clusters";
const CLUSTER_COUNT_LAYER_ID = "fleet-screen-cluster-count";
const SCREEN_LAYER_ID = "fleet-screen-points";
const NATIVE_MAP_ID = "fleet-screens";

const statusLabelKeys = {
  online: "status.online",
  recent: "status.recent",
  stale: "status.stale",
  offline: "status.offline",
  disabled: "status.disabled",
  revoked: "status.revoked",
} as const satisfies Record<Screen["status"], string>;

function nativeTone(status: Screen["status"]): SystemMapTone {
  if (status === "online" || status === "recent") return "positive";
  if (status === "stale") return "warning";
  if (status === "offline") return "critical";
  if (status === "disabled" || status === "revoked") return "muted";
  return "default";
}

type ScreenFeatureProperties = {
  screenId: string;
  status: Screen["status"];
};

function featureCollection(
  screens: Screen[],
): FeatureCollection<Point, ScreenFeatureProperties> {
  return {
    type: "FeatureCollection",
    features: screens.flatMap((screen) => {
      const position = screen.mapPosition;
      if (!position) return [];
      return [
        {
          type: "Feature" as const,
          id: screen.id,
          geometry: {
            type: "Point" as const,
            coordinates: [position.longitude, position.latitude],
          },
          properties: {
            screenId: screen.id,
            status: screen.status,
          },
        },
      ];
    }),
  };
}

function fitScreens(map: MapLibreMap, screens: Screen[]) {
  const positioned = screens.filter((screen) => screen.mapPosition);
  if (positioned.length === 0) return;
  if (positioned.length === 1) {
    const position = positioned[0]?.mapPosition;
    if (!position) return;
    map.easeTo({
      center: [position.longitude, position.latitude],
      zoom: 16,
      duration: 350,
    });
    return;
  }
  const bounds = new LngLatBounds();
  for (const screen of positioned) {
    const position = screen.mapPosition;
    if (position) bounds.extend([position.longitude, position.latitude]);
  }
  map.fitBounds(bounds, { padding: 64, maxZoom: 17, duration: 350 });
}

export function ScreenFleetMap({ screens }: { screens: Screen[] }) {
  const { t } = useTranslation(["screens", "common"]);
  const navigate = useNavigate();
  const nativeHost = useNativeHost();
  const mapRef = useRef<MapLibreMap | null>(null);
  const dataRef = useRef(featureCollection(screens));
  const screensRef = useRef(screens);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nativeMapDismissed, setNativeMapDismissed] = useState(false);
  const [nativePresentFailed, setNativePresentFailed] = useState(false);

  const mapped = useMemo(
    () => screens.filter((screen) => screen.mapPosition),
    [screens],
  );
  const unmappedCount = screens.length - mapped.length;
  const data = useMemo(() => featureCollection(screens), [screens]);
  const fitKey = useMemo(
    () =>
      mapped
        .map(
          (screen) =>
            `${screen.id}:${screen.mapPosition?.latitude}:${screen.mapPosition?.longitude}`,
        )
        .join("|"),
    [mapped],
  );
  const selected = screens.find((screen) => screen.id === selectedId);
  const nativeMapAvailable =
    nativeHost.status === "ready" &&
    nativeHost.context === "main" &&
    nativeHost.capabilities.systemMap;
  const nativePayload = useMemo(
    () =>
      validateSystemMap({
        mapId: NATIVE_MAP_ID,
        title: t("page.title"),
        points: mapped.flatMap((screen) => {
          const position = screen.mapPosition;
          if (!position) return [];
          return [
            {
              id: screen.id,
              title: screen.name,
              subtitle:
                [screen.location, screen.roomName, screen.roomNumber]
                  .filter(Boolean)
                  .join(" · ")
                  .slice(0, 200) || undefined,
              latitude: position.latitude,
              longitude: position.longitude,
              tone: nativeTone(screen.status),
              actionId: screen.id,
            },
          ];
        }),
      }),
    [mapped, t],
  );

  // A host that refuses or fails to present falls back to the browser map, so
  // the page never shows only a placeholder for a map that will not open.
  const nativeMapUsable =
    nativeMapAvailable && nativePayload !== null && !nativePresentFailed;

  useEffect(() => {
    if (!nativeMapAvailable) setNativePresentFailed(false);
  }, [nativeMapAvailable]);

  const presentNativeMap = useCallback(async () => {
    if (!nativeMapUsable || !nativePayload) return false;
    try {
      const reply = await nativeHost.send("system/map-present", nativePayload);
      if (reply?.ok === true) {
        setNativeMapDismissed(false);
        return true;
      }
    } catch {
      // A rejected send is handled like a failed reply.
    }
    setNativePresentFailed(true);
    return false;
  }, [nativeHost, nativeMapUsable, nativePayload]);

  dataRef.current = data;
  screensRef.current = screens;

  const handleMapChange = useCallback((map: MapLibreMap | null) => {
    mapRef.current = map;
  }, []);

  const handleStyleReady = useCallback((map: MapLibreMap) => {
    map.addSource(MAP_SOURCE_ID, {
      type: "geojson",
      data: dataRef.current,
      cluster: true,
      clusterMaxZoom: 15,
      clusterRadius: 44,
    });
    map.addLayer({
      id: CLUSTER_LAYER_ID,
      type: "circle",
      source: MAP_SOURCE_ID,
      filter: ["has", "point_count"],
      paint: {
        "circle-color": "#2563eb",
        "circle-radius": ["step", ["get", "point_count"], 18, 10, 22, 50, 28],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });
    map.addLayer({
      id: CLUSTER_COUNT_LAYER_ID,
      type: "symbol",
      source: MAP_SOURCE_ID,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-size": 12,
      },
      paint: { "text-color": "#ffffff" },
    });
    map.addLayer({
      id: SCREEN_LAYER_ID,
      type: "circle",
      source: MAP_SOURCE_ID,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-color": [
          "match",
          ["get", "status"],
          "online",
          "#16a34a",
          "recent",
          "#65a30d",
          "stale",
          "#d97706",
          "offline",
          "#dc2626",
          "disabled",
          "#64748b",
          "revoked",
          "#64748b",
          "#64748b",
        ],
        "circle-radius": 8,
        "circle-stroke-width": 2,
        "circle-stroke-color": "#ffffff",
      },
    });

    map.on("click", CLUSTER_LAYER_ID, (event) => {
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const clusterId = Number(feature.properties?.cluster_id);
      const source = map.getSource(MAP_SOURCE_ID);
      if (!(source instanceof GeoJSONSource) || !Number.isFinite(clusterId))
        return;
      const coordinates = feature.geometry.coordinates as [number, number];
      void source
        .getClusterExpansionZoom(clusterId)
        .then((zoom) => map.easeTo({ center: coordinates, zoom }));
    });
    map.on("click", SCREEN_LAYER_ID, (event) => {
      const screenId: unknown = event.features?.[0]?.properties?.screenId;
      if (typeof screenId === "string") setSelectedId(screenId);
    });
    for (const layer of [CLUSTER_LAYER_ID, SCREEN_LAYER_ID]) {
      map.on("mouseenter", layer, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
      });
    }
    fitScreens(map, screensRef.current);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const source = map.getSource(MAP_SOURCE_ID);
    if (source instanceof GeoJSONSource) void source.setData(data);
  }, [data]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.isStyleLoaded()) fitScreens(map, screensRef.current);
  }, [fitKey]);

  useEffect(() => {
    if (selectedId && !screens.some((screen) => screen.id === selectedId)) {
      setSelectedId(null);
    }
  }, [screens, selectedId]);

  useEffect(() => {
    if (!nativeMapUsable) return;
    const unsubscribeAction = nativeHost.subscribe(
      "system/map-action",
      ({ mapId, actionId }) => {
        if (mapId !== NATIVE_MAP_ID) return false;
        if (screensRef.current.some((screen) => screen.id === actionId)) {
          void navigate(`/screens/${actionId}`);
        }
        return true;
      },
    );
    const unsubscribeDismissed = nativeHost.subscribe(
      "system/map-dismissed",
      ({ mapId }) => {
        if (mapId !== NATIVE_MAP_ID) return false;
        setNativeMapDismissed(true);
        return true;
      },
    );
    return () => {
      unsubscribeAction();
      unsubscribeDismissed();
      void nativeHost.send("system/map-dismiss", { mapId: NATIVE_MAP_ID });
    };
  }, [nativeHost, nativeMapUsable, navigate]);

  useEffect(() => {
    if (!nativeMapDismissed) void presentNativeMap();
  }, [nativeMapDismissed, presentNativeMap]);

  if (mapped.length === 0) {
    return (
      <Empty className="min-h-72 border-y border-dashed px-5 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MapPinned aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{t("list.mapEmptyTitle")}</EmptyTitle>
          <EmptyDescription>{t("list.mapEmptyBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (nativeMapUsable) {
    return (
      <div className="grid min-h-72 place-items-center rounded-xl border border-border bg-muted/30 px-5 py-8 text-center">
        <div className="grid max-w-md justify-items-center gap-3">
          <span className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
            <MapPinned aria-hidden="true" />
          </span>
          <div>
            <div className="font-medium">{t("list.mapNativeTitle")}</div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("list.mapNativeBody")}
            </p>
          </div>
          <Button type="button" onClick={() => void presentNativeMap()}>
            {t("list.mapOpenNative")}
          </Button>
          {unmappedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("list.mapUnmapped", { count: unmappedCount })}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {unmappedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            {t("list.mapUnmapped", { count: unmappedCount })}
          </span>
        </div>
      )}
      <div className="relative overflow-hidden rounded-xl border border-border bg-muted">
        <MapLibreSurface
          className="h-[min(68vh,42rem)] min-h-96 w-full"
          ariaHidden
          initialCenter={[0, 0]}
          initialZoom={1}
          onMapChange={handleMapChange}
          onStyleReady={handleStyleReady}
          loadingLabel={t("shared.mapLoading")}
          errorTitle={t("shared.mapLoadErrorTitle")}
          errorBody={t("shared.mapLoadErrorBody")}
          retryLabel={t("common:actions.retry")}
        />
        <div className="sr-only">
          <h2>{t("list.mapAriaLabel")}</h2>
          <ul>
            {mapped.map((screen) => (
              <li key={screen.id}>
                <Link to={`/screens/${screen.id}`}>
                  {screen.name} · {t(statusLabelKeys[screen.status])}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        {selected && (
          <div className="absolute bottom-3 left-3 right-3 z-10 max-w-sm rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur sm:right-auto">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{selected.name}</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[selected.location, selected.roomName, selected.roomNumber]
                    .filter(Boolean)
                    .join(" · ") || t("table.noDetails")}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setSelectedId(null)}
              >
                {t("common:actions.close")}
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {t(statusLabelKeys[selected.status])}
              </Badge>
              {selected.mapPosition?.source === "location" && (
                <Badge variant="secondary">{t("list.mapInherited")}</Badge>
              )}
              <Link
                to={`/screens/${selected.id}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {t("list.mapOpenScreen")} <ExternalLink aria-hidden="true" />
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
