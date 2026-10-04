import { useCallback, useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { createTilecastMap, mapLibreErrorMessage } from "../lib/maplibre";
import { Button } from "./ui/button";

const STARTUP_TIMEOUT_MS = 12_000;

type MapPhase = "loading" | "ready" | "degraded" | "error";

export function MapLibreSurface({
  className,
  ariaLabel,
  ariaHidden = false,
  initialCenter,
  initialZoom,
  onMapChange,
  onStyleReady,
  loadingLabel,
  errorTitle,
  errorBody,
  retryLabel,
}: {
  className: string;
  ariaLabel?: string;
  ariaHidden?: boolean;
  initialCenter: [number, number];
  initialZoom: number;
  onMapChange?: (map: MapLibreMap | null) => void;
  onStyleReady?: (map: MapLibreMap) => void;
  loadingLabel: string;
  errorTitle: string;
  errorBody: string;
  retryLabel: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef(initialCenter);
  const zoomRef = useRef(initialZoom);
  const onMapChangeRef = useRef(onMapChange);
  const onStyleReadyRef = useRef(onStyleReady);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<MapPhase>("loading");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  centerRef.current = initialCenter;
  zoomRef.current = initialZoom;
  onMapChangeRef.current = onMapChange;
  onStyleReadyRef.current = onStyleReady;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let lastError: string | null = null;
    let idle = false;
    let fatal = false;
    let map: MapLibreMap;

    setPhase("loading");
    setErrorDetail(null);

    try {
      map = createTilecastMap({
        container,
        center: centerRef.current,
        zoom: zoomRef.current,
      });
    } catch (error) {
      if (!disposed) {
        setPhase("error");
        setErrorDetail(mapLibreErrorMessage(error));
      }
      return;
    }

    onMapChangeRef.current?.(map);

    const handleError = (event: { error?: unknown }) => {
      const detail = mapLibreErrorMessage(event.error);
      if (detail) {
        lastError = detail;
        setErrorDetail(detail);
        if (idle && !fatal) setPhase("degraded");
      }
      // MapLibre stops its default error logging once an error listener is
      // registered, so keep the concrete renderer/source failure in DevTools.
      console.error("Tilecast map error", event.error ?? event);
    };

    const handleStyleLoad = () => {
      if (disposed) return;
      try {
        onStyleReadyRef.current?.(map);
        map.resize();
      } catch (error) {
        const detail = mapLibreErrorMessage(error);
        lastError = detail;
        fatal = true;
        setPhase("error");
        setErrorDetail(detail);
      }
    };

    const handleIdle = () => {
      if (disposed) return;
      idle = true;
      if (fatal) return;
      setPhase(lastError ? "degraded" : "ready");
    };

    map.on("error", handleError);
    map.on("style.load", handleStyleLoad);
    map.on("idle", handleIdle);

    const timeout = window.setTimeout(() => {
      if (disposed || idle) return;
      // If the map never becomes idle, the usual causes are a worker, tile,
      // glyph, sprite, or GPU failure. Surface the last concrete MapLibre
      // error instead of leaving a permanent grey canvas.
      setPhase("error");
      setErrorDetail(lastError);
    }, STARTUP_TIMEOUT_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timeout);
      onMapChangeRef.current?.(null);
      map.remove();
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return (
    <div
      className={`relative ${className}`}
      data-map-state={phase}
      aria-busy={phase === "loading" ? true : undefined}
    >
      <div
        ref={containerRef}
        className="absolute inset-0"
        aria-label={ariaLabel}
        aria-hidden={ariaHidden || undefined}
      />
      {phase === "loading" && (
        <div
          className="absolute inset-0 z-10 grid place-items-center bg-background/80"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            {loadingLabel}
          </div>
        </div>
      )}
      {phase === "degraded" && (
        <div
          className="absolute left-3 top-3 z-20 flex max-w-[min(28rem,calc(100%-1.5rem))] items-start gap-2 rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur"
          role="status"
        >
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-amber-600"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="text-sm font-medium">{errorTitle}</div>
            {errorDetail && (
              <code className="mt-1 block break-words text-xs text-muted-foreground">
                {errorDetail}
              </code>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="mt-1 -ml-2"
              onClick={retry}
            >
              <RefreshCw aria-hidden="true" />
              {retryLabel}
            </Button>
          </div>
        </div>
      )}
      {phase === "error" && (
        <div
          className="absolute inset-0 z-20 grid place-items-center bg-background/95 p-4"
          role="alert"
        >
          <div className="grid max-w-lg justify-items-center gap-3 text-center">
            <span className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <CircleAlert className="size-5" aria-hidden="true" />
            </span>
            <div>
              <div className="font-medium">{errorTitle}</div>
              <p className="mt-1 text-sm text-muted-foreground">{errorBody}</p>
            </div>
            {errorDetail && (
              <code className="max-w-full break-words rounded-md bg-muted px-2 py-1 text-left text-xs text-muted-foreground">
                {errorDetail}
              </code>
            )}
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              <RefreshCw aria-hidden="true" />
              {retryLabel}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
