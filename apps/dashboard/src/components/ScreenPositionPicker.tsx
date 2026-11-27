import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useLayoutEffect,
} from "react";
import {
  Marker,
  type Map as MapLibreMap,
  type MapMouseEvent,
} from "maplibre-gl";
import { Crosshair, MapPin, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MapCoordinates } from "../api/types";
import { MapLibreSurface } from "./MapLibreSurface";
import { Button } from "./ui/button";

export function ScreenPositionPicker({
  value,
  locationPosition,
  onChange,
}: {
  value?: MapCoordinates;
  locationPosition?: MapCoordinates;
  onChange: (value?: MapCoordinates) => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const dragEndRef = useRef<(() => void) | null>(null);
  const clickRef = useRef<((event: MapMouseEvent) => void) | null>(null);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const easedRef = useRef<{
    map: MapLibreMap;
    latitude: number;
    longitude: number;
  } | null>(null);
  const [mapGeneration, setMapGeneration] = useState(0);

  const effectivePosition = value ?? locationPosition;
  // Depend on the coordinates, not the object: the parent may build a new
  // locationPosition object on every render, and each one would recenter the
  // map under a user who is panning to choose a position.
  const latitude = effectivePosition?.latitude;
  const longitude = effectivePosition?.longitude;

  const placeAtMapCenter = () => {
    const center = mapRef.current?.getCenter().wrap();
    if (center)
      onChangeRef.current({ longitude: center.lng, latitude: center.lat });
  };

  const removeMarker = useCallback(() => {
    const marker = markerRef.current;
    if (marker && dragEndRef.current) marker.off("dragend", dragEndRef.current);
    marker?.remove();
    markerRef.current = null;
    dragEndRef.current = null;
  }, []);

  const handleMapChange = useCallback(
    (map: MapLibreMap | null) => {
      removeMarker();
      // The map that is going away stops reporting clicks.
      if (mapRef.current && clickRef.current)
        mapRef.current.off("click", clickRef.current);
      clickRef.current = null;
      mapRef.current = map;
      if (!map) return;

      const handleClick = (event: MapMouseEvent) => {
        onChangeRef.current({
          longitude: event.lngLat.lng,
          latitude: event.lngLat.lat,
        });
      };
      clickRef.current = handleClick;
      map.on("click", handleClick);
      setMapGeneration((value) => value + 1);
    },
    [onChangeRef, removeMarker],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (latitude === undefined || longitude === undefined) {
      removeMarker();
      return;
    }

    // The map reports itself after mount, which re-runs this effect with the
    // same coordinates; only ease when the map or the position changed.
    const eased = easedRef.current;
    if (
      !eased ||
      eased.map !== map ||
      eased.latitude !== latitude ||
      eased.longitude !== longitude
    ) {
      easedRef.current = { map, latitude, longitude };
      map.easeTo({
        center: [longitude, latitude],
        zoom: Math.max(map.getZoom(), 15),
        duration: 250,
      });
    }

    if (!markerRef.current) {
      const marker = new Marker({ draggable: true })
        .setLngLat([longitude, latitude])
        .addTo(map);
      const handleDragEnd = () => {
        const position = marker.getLngLat();
        onChangeRef.current({
          longitude: position.lng,
          latitude: position.lat,
        });
      };
      marker.on("dragend", handleDragEnd);
      dragEndRef.current = handleDragEnd;
      markerRef.current = marker;
    } else {
      markerRef.current.setLngLat([longitude, latitude]);
    }
  }, [latitude, longitude, mapGeneration, onChangeRef, removeMarker]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium">
            <MapPin className="size-4" aria-hidden="true" />
            {t("detail.mapPosition")}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {value
              ? t("detail.mapPositionCustom")
              : locationPosition
                ? t("detail.mapPositionInherited")
                : t("detail.mapPositionNone")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={placeAtMapCenter}
          >
            <Crosshair aria-hidden="true" />
            {t("detail.mapPositionPlaceCenter")}
          </Button>
          {value && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(undefined)}
            >
              <RotateCcw aria-hidden="true" />
              {locationPosition
                ? t("detail.mapPositionUseLocation")
                : t("detail.mapPositionClear")}
            </Button>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-muted">
        <MapLibreSurface
          className="h-56 w-full"
          ariaLabel={t("detail.mapPositionAriaLabel")}
          initialCenter={
            effectivePosition
              ? [effectivePosition.longitude, effectivePosition.latitude]
              : [0, 0]
          }
          initialZoom={effectivePosition ? 17 : 1}
          onMapChange={handleMapChange}
          loadingLabel={t("shared.mapLoading")}
          errorTitle={t("shared.mapLoadErrorTitle")}
          errorBody={t("shared.mapLoadErrorBody")}
          retryLabel={t("common:actions.retry")}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        {t("detail.mapPositionHint")}
      </p>
      {effectivePosition && (
        <p className="font-mono text-xs text-muted-foreground">
          {effectivePosition.latitude.toFixed(6)},{" "}
          {effectivePosition.longitude.toFixed(6)}
        </p>
      )}
    </div>
  );
}
