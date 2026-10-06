/**
 * The one Studio preview for component Widgets
 * (docs/widget-authoring.md).
 *
 * React owns this chrome; the Widget owns everything inside the frame.
 * The real Web Component renders through the shared WidgetMount from the
 * Studio registry — the same element the Player mounts. There are no
 * Studio-only Widget renderers on this path.
 */
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  WidgetMount,
  type WidgetComponentRef,
  type WidgetMountState,
} from "@tilecast/widget-sdk/mount";
import type { WidgetContext, WidgetResources } from "@tilecast/widget-sdk";
import { studioWidgetDiscovery } from "./studioWidgets";

export interface PreviewFrame {
  readonly width: number;
  readonly height: number;
}

export type PreviewFit = "shrink" | "fill";

export function WidgetPreviewHost({
  component,
  resources,
  context,
  frame,
  label,
  onState,
  fit = "shrink",
  scale,
}: {
  /** Compiled component config; form edits update it in place. */
  component: WidgetComponentRef;
  resources: WidgetResources;
  context: WidgetContext;
  /** Preview container dimensions. Sizes the frame, never the Widget. */
  frame: PreviewFrame;
  label: string;
  onState?: (state: WidgetMountState) => void;
  /**
   * Shrink-only (the standalone authoring editor: a 960px Widget scales
   * down into a narrow column but never up) or fill (a Layout zone: the
   * surface scales both below and above 1 to match the displayed zone
   * while the Widget keeps its logical intrinsic geometry).
   */
  fit?: PreviewFit;
  /**
   * An exact scale chosen by the host (the Widget editor's Fit and zoom
   * controls). The surface is sized to the scaled frame; `fit` is ignored.
   */
  scale?: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<WidgetMount | null>(null);
  const [previewScale, setPreviewScale] = useState(1);
  // The mount outlives renders, so it reports through an Effect Event that
  // always reaches the latest callback.
  const reportState = useEffectEvent((state: WidgetMountState) =>
    onState?.(state),
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const mount = new WidgetMount({
      registry: studioWidgetDiscovery.registry,
      container,
      component,
      resources,
      context,
      onState: (state) => reportState(state),
    });
    mountRef.current = mount;
    return () => {
      mountRef.current = null;
      mount.dispose();
    };
    // Mount once per placement: type/version changes below remount through
    // update(), and anything else updates the element in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Ordinary form edits compile locally and update the element in place,
    // so the preview never remounts (and never calls the Server) per keystroke.
    mountRef.current?.update({ component, resources, context });
  }, [component, resources, context]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || scale !== undefined) return;

    const fitToWidth = (availableWidth: number) => {
      if (availableWidth <= 0) return;
      const ratio = availableWidth / frame.width;
      const nextScale = fit === "fill" ? ratio : Math.min(1, ratio);
      setPreviewScale((current) =>
        Math.abs(current - nextScale) < 0.001 ? current : nextScale,
      );
    };

    fitToWidth(viewport.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Modern ResizeObserver reports the actual content box directly. Keep
      // contentRect as the compatibility fallback for engines that do not.
      const contentBoxSize = entry.contentBoxSize;
      const firstContentBox = Array.isArray(contentBoxSize)
        ? (contentBoxSize as readonly ResizeObserverSize[])[0]
        : (contentBoxSize as unknown as ResizeObserverSize | undefined);
      fitToWidth(firstContentBox?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [frame.width, fit, scale]);

  // Keep the Widget at the selected intrinsic frame size so its container
  // queries match playback, then scale that whole surface down when the Studio
  // column is narrower. Shrinking only the outer box would crop a 960px Widget
  // inside a ~600px editor column. Fill mode instead stretches the outer box
  // to the displayed zone and scales both ways, so a Layout shown above 100%
  // zoom still fills its placement.
  const appliedScale = scale ?? previewScale;
  return (
    <div
      ref={viewportRef}
      role="img"
      aria-label={label}
      style={
        scale !== undefined
          ? {
              width: `${frame.width * scale}px`,
              height: `${frame.height * scale}px`,
              overflow: "hidden",
              position: "relative",
              background: "#000",
            }
          : fit === "fill"
            ? {
                width: "100%",
                aspectRatio: `${frame.width} / ${frame.height}`,
                overflow: "hidden",
                position: "relative",
                background: "#000",
              }
            : {
                width: `${frame.width}px`,
                maxWidth: "100%",
                aspectRatio: `${frame.width} / ${frame.height}`,
                overflow: "hidden",
                position: "relative",
                background: "#000",
              }
      }
    >
      <div
        style={{
          width: `${frame.width}px`,
          height: `${frame.height}px`,
          transform: `scale(${appliedScale})`,
          transformOrigin: "top left",
        }}
      >
        <div
          ref={containerRef}
          style={{ width: `${frame.width}px`, height: `${frame.height}px` }}
        />
      </div>
    </div>
  );
}
