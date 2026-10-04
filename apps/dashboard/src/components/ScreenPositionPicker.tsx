import { useEffect, useRef } from "react";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapPin, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MapCoordinates } from "../api/types";
import { Button } from "./ui/button";

const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

export function ScreenPositionPicker({
  value,
  locationPosition,
  onChange,
}: {
  value?: MapCoordinates;
  locationPosition?: MapCoordinates;
  onChange: (value?: MapCoordinates) => void;
}) {
  const { t } = useTranslation("screens");
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const valueRef = useRef(value);
  const locationRef = useRef(locationPosition);

  valueRef.current = value;
  locationRef.current = locationPosition;

  const effectivePosition = value ?? locationPosition;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const initial = valueRef.current ?? locationRef.current;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: OPENFREEMAP_STYLE_URL,
      center: initial
        ? [initial.longitude, initial.latitude]
        : [0, 0],
      zoom: initial ? 17 : 1,
      attributionControl: true,
    });
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");

    const placeOverride = (longitude: number, latitude: number) => {
      onChange({ longitude, latitude });
    };

    map.on("click", (event: MapMouseEvent) => {
      placeOverride(event.lngLat.lng, event.lngLat.lat);
    });

    return () => {
      markerRef.current?.remove();
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [onChange]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!effectivePosition) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }

    map.easeTo({
      center: [effectivePosition.longitude, effectivePosition.latitude],
      zoom: Math.max(map.getZoom(), 15),
      duration: 250,
    });

    if (!markerRef.current) {
      const marker = new Marker({ draggable: true })
        .setLngLat([effectivePosition.longitude, effectivePosition.latitude])
        .addTo(map);
      marker.on("dragend", () => {
        const position = marker.getLngLat();
        onChange({ longitude: position.lng, latitude: position.lat });
      });
      markerRef.current = marker;
    } else {
      markerRef.current.setLngLat([
        effectivePosition.longitude,
        effectivePosition.latitude,
      ]);
    }
  }, [effectivePosition, onChange]);

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
      <div className="overflow-hidden rounded-lg border border-border bg-muted">
        <div
          ref={containerRef}
          className="h-56 w-full"
          aria-label={t("detail.mapPositionAriaLabel")}
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
